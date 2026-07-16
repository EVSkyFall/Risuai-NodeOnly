import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Chat } from '../../../storage/database.svelte'
import { IllustrationImagePromptContractError } from '../errors'
import { setImagePromptMeasurementServiceForTests } from '../imagePromptMeasurement'
import type { IllustrationPromptV1 } from '../types'
import { installImagePromptMeasurementTestService } from './imagePromptTestHarness'
import { InMemoryLockManager } from './inMemoryLockManager'

const harness = vi.hoisted(() => ({
    storageMap: new Map<string, Uint8Array>(),
    events: [] as string[],
    database: null as any,
    integrity: new Map<string, 'complete' | 'repairable' | 'missing'>(),
    provider: vi.fn(),
    writeInlay: vi.fn(),
    inspectInlay: vi.fn(),
    repairInlay: vi.fn(),
    strictSave: vi.fn(),
    jobWriteHook: null as ((record: any) => void) | null,
    hydrateHook: null as ((chats: Chat[], index: number) => Chat | null | Promise<Chat | null>) | null,
    getItemHook: null as ((key: string) => Promise<void>) | null,
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: {
        async Init() {},
        async keys(prefix = '') {
            return [...harness.storageMap.keys()].filter((key) => key.startsWith(prefix))
        },
        async getItem(key: string) {
            if (harness.getItemHook) await harness.getItemHook(key)
            return harness.storageMap.get(key) ?? null
        },
        async setItem(key: string, value: Uint8Array) {
            harness.storageMap.set(key, new Uint8Array(value))
            if (key.startsWith('illustration:v1:job:')) {
                const record = JSON.parse(new TextDecoder().decode(value))
                harness.events.push(`job:${record.state}`)
                harness.jobWriteHook?.(record)
            }
        },
        async removeItem(key: string) {
            harness.storageMap.delete(key)
        },
    },
}))

vi.mock('src/ts/parser/parser.svelte', () => ({
    hasher: vi.fn(async () => new Uint8Array(32)),
}))

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => harness.database,
}))

vi.mock('src/ts/storage/chatStorage', () => ({
    ensureChatHydrated: vi.fn(async (chats: Chat[], index: number) => (
        harness.hydrateHook ? await harness.hydrateHook(chats, index) : (chats[index] ?? null)
    )),
    saveChatToServerStrict: harness.strictSave,
}))

vi.mock('src/ts/process/stableDiff', () => ({
    generateAIImageTyped: harness.provider,
}))

vi.mock('src/ts/process/files/inlays', () => ({
    writeInlayImage: harness.writeInlay,
    inspectInlayAssetIntegrity: harness.inspectInlay,
    repairInlayAssetRecords: harness.repairInlay,
}))

const coordinatorModule = await import('../coordinator')
const coordinatorRecordModule = await import('../coordinatorRecord')
const executorModule = await import('../executor')
const featureModule = await import('../featureFlag')
const illustrationEventsModule = await import('../illustrationEvents')
const lockModule = await import('../locks')
const operationLockModule = await import('../operationLock')
const storeModule = await import('../store')

const {
    cancelLedger,
    registerTrustedTurn,
    retryUncertainLedger,
    submitPlanLedger,
    supplyPromptLedger,
} = coordinatorModule
const { claimCoordinator } = coordinatorRecordModule
const {
    commitIllustrationAssetReadyJob,
    deriveIllustrationAssetId,
    pokeExecutor,
    resetIllustrationWorkerLockManagerAccessorForTests,
    setIllustrationWorkerLockManagerAccessorForTests,
    startIllustrationExecutor,
    stopIllustrationExecutor,
} = executorModule
const { IllustrationFeatureDisabledError, setIllustrationFeatureEnabled } = featureModule
const { subscribeIllustrationWakeHints } = illustrationEventsModule
const { resetIllustrationLockManagerAccessorForTests, setIllustrationLockManagerAccessorForTests } = lockModule
const {
    resetIllustrationOperationLockManagerAccessorForTests,
    setIllustrationOperationLockManagerAccessorForTests,
} = operationLockModule
const { illustrationJobKey, illustrationJobStore } = storeModule

const BASE_TIME = Date.UTC(2026, 0, 3)
let lockManager: InMemoryLockManager
let coordinatorProof: { coordinatorLeaseId: string; coordinatorFence: number }
let restoreImagePromptMeasurement = () => {}

async function refreshCoordinatorProof(): Promise<void> {
    const snapshot = await claimCoordinator({
        protocolVersion: 1,
        leaseId: 'test-coordinator',
        holderRuntimeId: 'test-runtime',
    })
    coordinatorProof = {
        coordinatorLeaseId: 'test-coordinator',
        coordinatorFence: snapshot.fence,
    }
}

function installDatabase(source = 'Executor source', swipes = false) {
    const message = swipes
        ? { role: 'char', chatId: 'message-1', data: source, swipes: [source, 'Other swipe'], swipeId: 0 }
        : { role: 'char', chatId: 'message-1', data: source }
    const chat = {
        id: 'conversation-1',
        name: 'chat',
        note: '',
        localLore: [],
        fmIndex: -1,
        message: [message],
    }
    harness.database = {
        characters: [{
            chaId: 'character-1',
            name: 'Character',
            image: '',
            newGenData: { negative: 'character-current-negative-sentinel' },
            chats: [chat],
            chatPage: 0,
        }],
        sdProvider: 'novelai',
        NAIImgUrl: 'https://image.novelai.net/ai/generate-image',
        NAIImgModel: 'nai-diffusion-4-5-full',
        NAII2I: false,
        NAIImgConfig: {},
        inlayImageLossless: true,
    }
    return { chat, message }
}

async function createQueuedJob(
    source = 'Executor source',
    swipes = false,
    positive = 'positive prompt',
    negative = '',
    prompt?: IllustrationPromptV1,
) {
    const target = installDatabase(source, swipes)
    const turn = await registerTrustedTurn({
        chaId: 'character-1',
        conversationId: 'conversation-1',
        expectedMessageId: 'message-1',
        rootTurnId: 'root-1',
        sourceVariantText: source,
    })
    const claimedTurn = await illustrationJobStore.claimTurn({
        ...coordinatorProof,
        turnId: turn.turnId,
        expectedVersion: turn.version,
        leaseId: 'planner',
    })
    const [projected] = await submitPlanLedger({
        ...coordinatorProof,
        turnId: turn.turnId,
        expectedVersion: claimedTurn.version,
        leaseId: 'planner',
        fence: claimedTurn.fence,
        idempotencyKey: `plan:${turn.turnId}`,
        sourceRevisionHash: turn.sourceRevisionHash!,
        slots: [{
            sceneId: 'scene-1',
            insertAfterUtf16: source.length,
            scenePayload: { schemaVersion: 1, data: { description: 'scene' } },
        }],
    })
    const claimedJob = await illustrationJobStore.claimJob({
        ...coordinatorProof,
        jobId: projected.jobId,
        expectedVersion: projected.version,
        leaseId: 'tagger',
    })
    const queued = await supplyPromptLedger({
        ...coordinatorProof,
        jobId: projected.jobId,
        expectedVersion: claimedJob.version,
        leaseId: 'tagger',
        fence: claimedJob.fence,
        idempotencyKey: `prompt:${projected.jobId}`,
        ...(prompt ? { prompt } : { positive, negative }),
    })
    harness.events.length = 0
    harness.strictSave.mockClear()
    harness.provider.mockClear()
    harness.writeInlay.mockClear()
    harness.inspectInlay.mockClear()
    return { ...target, queued }
}

async function createQueuedJobs(
    count = 2,
    source = 'Queued executor scenes with enough distinct placement positions',
) {
    const target = installDatabase(source)
    const turn = await registerTrustedTurn({
        chaId: 'character-1',
        conversationId: 'conversation-1',
        expectedMessageId: 'message-1',
        rootTurnId: `root-${count}-queued`,
        sourceVariantText: source,
    })
    const claimedTurn = await illustrationJobStore.claimTurn({
        ...coordinatorProof,
        turnId: turn.turnId,
        expectedVersion: turn.version,
        leaseId: 'planner-two-queued',
    })
    const projected = await submitPlanLedger({
        ...coordinatorProof,
        turnId: turn.turnId,
        expectedVersion: claimedTurn.version,
        leaseId: 'planner-two-queued',
        fence: claimedTurn.fence,
        idempotencyKey: `plan:${turn.turnId}`,
        sourceRevisionHash: turn.sourceRevisionHash!,
        slots: Array.from({ length: count }, (_, index) => ({
            sceneId: `scene-${index + 1}`,
            insertAfterUtf16: Math.floor(((index + 1) * source.length) / count),
            scenePayload: {
                schemaVersion: 1,
                data: { description: `scene ${index + 1}` },
            },
        })),
    })
    const queued = []
    for (const [index, job] of projected.entries()) {
        const leaseId = `tagger-two-queued-${index}`
        const claimed = await illustrationJobStore.claimJob({
            ...coordinatorProof,
            jobId: job.jobId,
            expectedVersion: job.version,
            leaseId,
        })
        queued.push(await supplyPromptLedger({
            ...coordinatorProof,
            jobId: job.jobId,
            expectedVersion: claimed.version,
            leaseId,
            fence: claimed.fence,
            idempotencyKey: `prompt:${job.jobId}`,
            positive: `positive prompt ${index}`,
            negative: '',
        }))
    }
    harness.events.length = 0
    harness.strictSave.mockClear()
    harness.provider.mockClear()
    harness.writeInlay.mockClear()
    harness.inspectInlay.mockClear()
    return { ...target, turn, queued }
}

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => {
        resolve = done
    })
    return { promise, resolve }
}

beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    harness.storageMap.clear()
    harness.events.length = 0
    harness.integrity.clear()
    harness.provider.mockReset()
    harness.writeInlay.mockReset()
    harness.inspectInlay.mockReset()
    harness.repairInlay.mockReset()
    harness.strictSave.mockReset()
    harness.jobWriteHook = null
    harness.hydrateHook = null
    harness.getItemHook = null
    installDatabase()
    restoreImagePromptMeasurement = installImagePromptMeasurementTestService(() => harness.database)
    lockManager = new InMemoryLockManager()
    setIllustrationLockManagerAccessorForTests(() => lockManager)
    setIllustrationOperationLockManagerAccessorForTests(() => lockManager)
    setIllustrationWorkerLockManagerAccessorForTests(() => lockManager)
    await setIllustrationFeatureEnabled(true)
    await refreshCoordinatorProof()
    harness.provider.mockImplementation(async () => {
        harness.events.push('provider')
        return {
            result: { ok: true, bytesOrDataUrl: 'data:image/png;base64,AA==', providerStatus: 200 },
            compatibilityValue: 'data:image/png;base64,AA==',
        }
    })
    harness.writeInlay.mockImplementation(async (_image: unknown, options: { id: string }) => {
        harness.events.push('asset-write')
        harness.integrity.set(options.id, 'complete')
        return options.id
    })
    harness.inspectInlay.mockImplementation(async (id: string) => {
        harness.events.push('asset-inspect')
        const status = harness.integrity.get(id) ?? 'missing'
        return {
            status,
            hasAsset: status !== 'missing',
            hasInfo: status === 'complete',
            hasMeta: status === 'complete',
        }
    })
    harness.repairInlay.mockImplementation(async (id: string) => {
        harness.events.push('asset-repair')
        harness.integrity.set(id, 'complete')
    })
    harness.strictSave.mockImplementation(async () => {
        harness.events.push('strict')
        return { success: true, durable: true }
    })
})

afterEach(async () => {
    restoreImagePromptMeasurement()
    await stopIllustrationExecutor()
    resetIllustrationWorkerLockManagerAccessorForTests()
    resetIllustrationLockManagerAccessorForTests()
    resetIllustrationOperationLockManagerAccessorForTests()
    vi.useRealTimers()
})

describe('illustration executor', () => {
    // §5-4 / §20 Crash-free live drain: recovery is not invoked by this test.
    test('finalizes a 15-job crash-free live drain with every job committed', async () => {
        const { turn, queued } = await createQueuedJobs(15)

        await startIllustrationExecutor()
        await pokeExecutor()

        const jobs = await illustrationJobStore.listJobRecords({ turnId: turn.turnId })
        expect(jobs).toHaveLength(15)
        expect(jobs.every((job) => job.state === 'committed')).toBe(true)
        expect(harness.provider).toHaveBeenCalledTimes(15)
        expect((await illustrationJobStore.getTurn(turn.turnId))?.state).toBe('completed')
        expect(queued).toHaveLength(15)
    })

    // §20 Finalization: a coordinator cancellation can be the final live settlement.
    test('finalizes mixed committed and cancelled siblings from the last coordinator closure', async () => {
        const { turn, queued } = await createQueuedJobs(3)
        const secondProviderStarted = deferred<void>()
        const secondProviderResult = deferred<any>()
        let dispatches = 0
        harness.provider.mockImplementation(async () => {
            harness.events.push('provider')
            dispatches += 1
            if (dispatches === 2) {
                secondProviderStarted.resolve()
                return await secondProviderResult.promise
            }
            return {
                result: {
                    ok: true,
                    bytesOrDataUrl: 'data:image/png;base64,AA==',
                    providerStatus: 200,
                },
                compatibilityValue: 'data:image/png;base64,AA==',
            }
        })

        await startIllustrationExecutor()
        await secondProviderStarted.promise
        const stopping = stopIllustrationExecutor()
        secondProviderResult.resolve({
            result: {
                ok: true,
                bytesOrDataUrl: 'data:image/png;base64,AA==',
                providerStatus: 200,
            },
            compatibilityValue: 'data:image/png;base64,AA==',
        })
        await stopping

        expect((await illustrationJobStore.getJob(queued[0].jobId))?.state).toBe('committed')
        expect((await illustrationJobStore.getJob(queued[1].jobId))?.state).toBe('committed')
        const last = (await illustrationJobStore.getJob(queued[2].jobId))!
        expect(last.state).toBe('queued')
        await cancelLedger({ jobId: last.jobId, expectedVersion: last.version })

        expect((await illustrationJobStore.getJob(last.jobId))?.state).toBe('cancelled')
        expect((await illustrationJobStore.getTurn(turn.turnId))?.state).toBe('completed')
        expect(harness.provider).toHaveBeenCalledTimes(2)
    })

    // §20 Finalization + source edit: a pure live failure set maps to stale.
    test('finalizes an all-stale live batch without provider dispatch', async () => {
        const source = 'All sibling slots become stale after this source is edited'
        const { message, turn } = await createQueuedJobs(3, source)
        message.data = message.data.replace('All sibling', 'Edited sibling')

        await startIllustrationExecutor()
        await pokeExecutor()

        const jobs = await illustrationJobStore.listJobRecords({ turnId: turn.turnId })
        expect(jobs).toHaveLength(3)
        expect(jobs.map((job) => job.state)).toEqual(['stale', 'stale', 'stale'])
        expect(harness.provider).not.toHaveBeenCalled()
        expect((await illustrationJobStore.getTurn(turn.turnId))?.state).toBe('stale')
    })

    // §20 Crash/storage + §12.2/§13 exact durable ordering.
    test('persists attempt, asset, integrity, and strict commit in the required order', async () => {
        const positive = 'persisted (positive) prompt'
        const negative = 'persisted negative prompt'
        const { queued } = await createQueuedJob('Executor source', false, positive, negative)
        const hints: Array<{ kind: string; jobId?: string }> = []
        const unsubscribe = subscribeIllustrationWakeHints((hint) => hints.push(hint))

        await startIllustrationExecutor()
        await pokeExecutor()
        await Promise.resolve()
        unsubscribe()

        const committed = await illustrationJobStore.getJob(queued.jobId)
        expect(committed?.state).toBe('committed')
        expect(committed?.assetId).toBe(await deriveIllustrationAssetId(queued.jobId, committed!.attemptId!))
        expect(harness.events).toEqual([
            'job:generating',
            'provider',
            'job:asset_writing',
            'asset-write',
            'asset-inspect',
            'job:asset_ready',
            'job:committing',
            'asset-inspect',
            'strict',
            'job:committed',
        ])
        expect(harness.writeInlay.mock.calls[0][1]).toMatchObject({
            id: committed?.assetId,
            target: { charId: 'character-1', chatId: 'conversation-1' },
        })
        expect(harness.provider).toHaveBeenCalledWith(
            positive,
            harness.database.characters[0],
            negative,
            'inlay',
            'background',
            {
                preservePromptText: true,
                illustrationPrompt: {
                    schemaVersion: 1,
                    layout: 'flat',
                    basePositive: positive,
                    characterPositives: [],
                    baseNegative: negative,
                    characterNegatives: [],
                },
            },
        )
        expect(hints.length).toBeGreaterThan(0)
        expect(hints.every((hint) => hint.kind === 'job_changed' && hint.jobId === queued.jobId)).toBe(true)
    })

    test('passes an exact structured character prompt through the executor dispatch wiring', async () => {
        const prompt: IllustrationPromptV1 = {
            schemaVersion: 1,
            layout: 'nai-v4-characters',
            basePositive: 'base positive\r\nkept byte-exact',
            characterPositives: [
                'source#1  first character',
                'target#2\tsecond character',
            ],
            baseNegative: 'base negative\nkept byte-exact',
            characterNegatives: [
                'source#1 negative  one',
                'target#2 negative\ttwo',
            ],
        }
        const { queued } = await createQueuedJob(
            'Executor source',
            false,
            'unused positive',
            'unused negative',
            prompt,
        )

        await startIllustrationExecutor()
        await pokeExecutor()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('committed')
        expect(harness.provider).toHaveBeenCalledTimes(1)
        expect(harness.provider).toHaveBeenCalledWith(
            prompt.basePositive,
            harness.database.characters[0],
            prompt.baseNegative,
            'inlay',
            'background',
            { preservePromptText: true, illustrationPrompt: prompt },
        )
    })

    // §20 explicit reject is failed; uncertain is never auto-redispatched.
    test('maps definite and uncertain results without blind retry', async () => {
        const definite = await createQueuedJob('Definite source')
        harness.provider.mockResolvedValueOnce({
            result: { ok: false, certainty: 'definite', reason: 'rejected', providerStatus: 400 },
            compatibilityValue: false,
        })
        await startIllustrationExecutor()
        await pokeExecutor()
        expect((await illustrationJobStore.getJob(definite.queued.jobId))?.state).toBe('failed')
        await stopIllustrationExecutor()

        harness.storageMap.clear()
        await setIllustrationFeatureEnabled(true)
        await refreshCoordinatorProof()
        const uncertain = await createQueuedJob('Uncertain source')
        harness.provider.mockResolvedValueOnce({
            result: { ok: false, certainty: 'uncertain', reason: 'disconnect' },
            compatibilityValue: false,
        })
        await startIllustrationExecutor()
        await pokeExecutor()
        await pokeExecutor()
        expect((await illustrationJobStore.getJob(uncertain.queued.jobId))?.state).toBe('uncertain')
        expect(harness.provider).toHaveBeenCalledTimes(1)
    })

    // Original spec §10.2: structured jobs share the resumable configuration block.
    test('blocks a structured job on drift and remeasures before dispatch after restore', async () => {
        const { queued } = await createQueuedJob()
        let measurements = 0
        restoreImagePromptMeasurement()
        restoreImagePromptMeasurement = setImagePromptMeasurementServiceForTests({
            resolveSettings: async () => ({
                provider: 'novelai',
                model: 'nai-diffusion-4-5-full',
            }),
            measure: async () => {
                measurements += 1
                return {
                    model: 'nai-diffusion-4-5-full',
                    tokenizer: 't5-spiece-v1',
                    positiveTokens: 1,
                    negativeTokens: 0,
                    maxPositiveTokens: 512,
                    maxNegativeTokens: 512,
                }
            },
        })
        harness.database.NAIImgConfig.steps = 99

        await startIllustrationExecutor()
        await pokeExecutor()
        expect(await illustrationJobStore.getJob(queued.jobId)).toMatchObject({
            state: 'blocked_config',
            error: { code: 'settings_fingerprint_mismatch' },
        })
        expect(measurements).toBe(0)
        expect(harness.provider).not.toHaveBeenCalled()

        delete harness.database.NAIImgConfig.steps
        await pokeExecutor()
        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('committed')
        expect(measurements).toBe(2)
        expect(harness.provider).toHaveBeenCalledTimes(1)
    })

    test('fails a resumed structured job when restored-settings remeasurement is over limit', async () => {
        const { queued } = await createQueuedJob()
        let measurements = 0
        restoreImagePromptMeasurement()
        restoreImagePromptMeasurement = setImagePromptMeasurementServiceForTests({
            resolveSettings: async () => ({
                provider: 'novelai',
                model: 'nai-diffusion-4-5-full',
            }),
            measure: async () => {
                measurements += 1
                return {
                    model: 'nai-diffusion-4-5-full',
                    tokenizer: 't5-spiece-v1',
                    positiveTokens: 513,
                    negativeTokens: 0,
                    maxPositiveTokens: 512,
                    maxNegativeTokens: 512,
                }
            },
        })
        harness.database.NAIImgConfig.steps = 99

        await startIllustrationExecutor()
        await pokeExecutor()
        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('blocked_config')
        expect(measurements).toBe(0)
        expect(harness.provider).not.toHaveBeenCalled()

        delete harness.database.NAIImgConfig.steps
        await pokeExecutor()
        expect(await illustrationJobStore.getJob(queued.jobId)).toMatchObject({
            state: 'failed',
            error: { code: 'image_prompt_over_limit', retryable: false },
        })
        expect(measurements).toBe(1)
        expect(harness.provider).not.toHaveBeenCalled()
    })

    // Request §4 rows 1-2: executor remeasurement independently catches a now-over-limit final.
    test('fails an over-limit queued prompt before provider dispatch with measured payload', async () => {
        const { queued } = await createQueuedJob()
        restoreImagePromptMeasurement()
        restoreImagePromptMeasurement = installImagePromptMeasurementTestService(
            () => harness.database,
            (text) => text === 'positive prompt' ? 513 : 0,
        )

        await startIllustrationExecutor()
        await pokeExecutor()
        expect(await illustrationJobStore.getJob(queued.jobId)).toMatchObject({
            state: 'failed',
            error: {
                code: 'image_prompt_over_limit',
                retryable: false,
                payload: {
                    positiveTokens: 513,
                    negativeTokens: 0,
                    maxPositiveTokens: 512,
                    maxNegativeTokens: 512,
                    model: 'nai-diffusion-4-5-full',
                },
            },
        })
        expect(harness.provider).not.toHaveBeenCalled()
    })

    test('fails tokenizer-unavailable pre-dispatch without a provider or heuristic fallback', async () => {
        const { queued } = await createQueuedJob()
        restoreImagePromptMeasurement()
        restoreImagePromptMeasurement = setImagePromptMeasurementServiceForTests({
            resolveSettings: async () => ({
                provider: 'novelai',
                model: 'nai-diffusion-4-5-full',
            }),
            measure: async () => {
                throw new IllustrationImagePromptContractError(
                    'image_tokenizer_unavailable',
                    'test tokenizer outage',
                )
            },
        })

        await startIllustrationExecutor()
        await pokeExecutor()
        expect(await illustrationJobStore.getJob(queued.jobId)).toMatchObject({
            state: 'failed',
            error: { code: 'image_tokenizer_unavailable', retryable: false },
        })
        expect(harness.provider).not.toHaveBeenCalled()
    })

    test('lets cancellation win during the final measurement and never dispatches', async () => {
        const { queued } = await createQueuedJob()
        const finalEntered = deferred<void>()
        const releaseFinal = deferred<void>()
        let measurements = 0
        restoreImagePromptMeasurement()
        restoreImagePromptMeasurement = setImagePromptMeasurementServiceForTests({
            resolveSettings: async () => ({
                provider: 'novelai',
                model: 'nai-diffusion-4-5-full',
            }),
            measure: async () => {
                measurements += 1
                if (measurements === 2) {
                    finalEntered.resolve()
                    await releaseFinal.promise
                }
                return {
                    model: 'nai-diffusion-4-5-full',
                    tokenizer: 't5-spiece-v1',
                    positiveTokens: 1,
                    negativeTokens: 0,
                    maxPositiveTokens: 512,
                    maxNegativeTokens: 512,
                }
            },
        })

        await startIllustrationExecutor()
        await finalEntered.promise
        const generating = (await illustrationJobStore.getJob(queued.jobId))!
        expect(generating.state).toBe('generating')
        await cancelLedger({ jobId: generating.jobId, expectedVersion: generating.version })
        releaseFinal.resolve()
        await pokeExecutor()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('cancelled')
        expect(harness.provider).not.toHaveBeenCalled()
    })

    test('lets cancellation win during the post-measurement context re-read', async () => {
        const { queued } = await createQueuedJob()
        const contextEntered = deferred<void>()
        const releaseContext = deferred<void>()
        let measurements = 0
        let blockedContext = false
        restoreImagePromptMeasurement()
        restoreImagePromptMeasurement = setImagePromptMeasurementServiceForTests({
            resolveSettings: async () => ({
                provider: 'novelai',
                model: 'nai-diffusion-4-5-full',
            }),
            measure: async () => {
                measurements += 1
                return {
                    model: 'nai-diffusion-4-5-full',
                    tokenizer: 't5-spiece-v1',
                    positiveTokens: 1,
                    negativeTokens: 0,
                    maxPositiveTokens: 512,
                    maxNegativeTokens: 512,
                }
            },
        })
        harness.hydrateHook = async (chats, index) => {
            if (measurements === 2 && !blockedContext) {
                blockedContext = true
                contextEntered.resolve()
                await releaseContext.promise
            }
            return chats[index] ?? null
        }

        await startIllustrationExecutor()
        await contextEntered.promise
        const generating = (await illustrationJobStore.getJob(queued.jobId))!
        expect(generating.state).toBe('generating')
        await cancelLedger({ jobId: generating.jobId, expectedVersion: generating.version })
        releaseContext.resolve()
        await pokeExecutor()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('cancelled')
        expect(harness.provider).not.toHaveBeenCalled()
    })

    test('stales a byte-identical message-fence edit during the final durable job read', async () => {
        const { queued, message } = await createQueuedJob()
        let measurements = 0
        let postMeasurementJobReads = 0
        restoreImagePromptMeasurement()
        restoreImagePromptMeasurement = setImagePromptMeasurementServiceForTests({
            resolveSettings: async () => ({
                provider: 'novelai',
                model: 'nai-diffusion-4-5-full',
            }),
            measure: async () => {
                measurements += 1
                return {
                    model: 'nai-diffusion-4-5-full',
                    tokenizer: 't5-spiece-v1',
                    positiveTokens: 1,
                    negativeTokens: 0,
                    maxPositiveTokens: 512,
                    maxNegativeTokens: 512,
                }
            },
        })
        harness.getItemHook = async (key) => {
            if (measurements !== 2 || !key.startsWith('illustration:v1:job:')) return
            postMeasurementJobReads += 1
            if (postMeasurementJobReads === 2) message.chatId = 'replacement-message'
        }

        await startIllustrationExecutor()
        await pokeExecutor()

        expect(postMeasurementJobReads).toBeGreaterThanOrEqual(2)
        expect(await illustrationJobStore.getJob(queued.jobId)).toMatchObject({
            state: 'stale',
            error: { code: 'pre_provider_context_changed' },
        })
        expect(harness.provider).not.toHaveBeenCalled()
    })

    test('blocks when settings drift during the post-measurement durable re-read', async () => {
        const { queued } = await createQueuedJob()
        let measurements = 0
        let injectedDrift = false
        restoreImagePromptMeasurement()
        restoreImagePromptMeasurement = setImagePromptMeasurementServiceForTests({
            resolveSettings: async () => ({
                provider: 'novelai',
                model: 'nai-diffusion-4-5-full',
            }),
            measure: async () => {
                measurements += 1
                return {
                    model: 'nai-diffusion-4-5-full',
                    tokenizer: 't5-spiece-v1',
                    positiveTokens: 1,
                    negativeTokens: 0,
                    maxPositiveTokens: 512,
                    maxNegativeTokens: 512,
                }
            },
        })
        harness.getItemHook = async () => {
            if (measurements !== 2 || injectedDrift) return
            injectedDrift = true
            harness.database.NAIImgConfig.steps = 99
        }

        await startIllustrationExecutor()
        await pokeExecutor()

        expect(measurements).toBe(2)
        expect(injectedDrift).toBe(true)
        expect(await illustrationJobStore.getJob(queued.jobId)).toMatchObject({
            state: 'blocked_config',
            error: { code: 'settings_fingerprint_mismatch' },
        })
        expect(harness.provider).not.toHaveBeenCalled()
    })

    test('lets cancellation win the generating-to-blocked configuration CAS', async () => {
        const { queued } = await createQueuedJob()
        let measurements = 0
        restoreImagePromptMeasurement()
        restoreImagePromptMeasurement = setImagePromptMeasurementServiceForTests({
            resolveSettings: async () => ({
                provider: 'novelai',
                model: 'nai-diffusion-4-5-full',
            }),
            measure: async () => {
                measurements += 1
                if (measurements === 2) harness.database.NAIImgConfig.steps = 99
                return {
                    model: 'nai-diffusion-4-5-full',
                    tokenizer: 't5-spiece-v1',
                    positiveTokens: 1,
                    negativeTokens: 0,
                    maxPositiveTokens: 512,
                    maxNegativeTokens: 512,
                }
            },
        })
        const originalTransition = illustrationJobStore.transitionJob.bind(illustrationJobStore)
        let injectedCancellation = false
        const transitionSpy = vi.spyOn(illustrationJobStore, 'transitionJob').mockImplementation(async (input) => {
            if (!injectedCancellation && input.to === 'blocked_config') {
                const snapshot = await illustrationJobStore.getJob(input.jobId)
                if (snapshot?.state === 'generating') {
                    injectedCancellation = true
                    await illustrationJobStore.requestCancel({
                        jobId: snapshot.jobId,
                        expectedVersion: snapshot.version,
                    })
                }
            }
            return await originalTransition(input)
        })

        try {
            await startIllustrationExecutor()
            await pokeExecutor()
        } finally {
            transitionSpy.mockRestore()
        }

        expect(measurements).toBe(2)
        expect(injectedCancellation).toBe(true)
        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('cancelled')
        expect(harness.provider).not.toHaveBeenCalled()
    })

    // Row 8: physical pre-contract records retain Gate 3/4 block-and-resume behavior.
    test('keeps a physical legacy flat record resumable across fingerprint drift', async () => {
        const { queued } = await createQueuedJob()
        let measurements = 0
        restoreImagePromptMeasurement()
        restoreImagePromptMeasurement = setImagePromptMeasurementServiceForTests({
            resolveSettings: async () => ({
                provider: 'novelai',
                model: 'nai-diffusion-4-5-full',
            }),
            measure: async () => {
                measurements += 1
                throw new Error('A physical legacy job must not require prompt measurement')
            },
        })
        const key = illustrationJobKey(queued.jobId)
        const legacy = JSON.parse(new TextDecoder().decode(harness.storageMap.get(key)!))
        legacy.prompt = { positive: 'positive prompt', negative: 'negative prompt' }
        harness.storageMap.set(key, new TextEncoder().encode(JSON.stringify(legacy)))
        harness.database.NAIImgConfig.steps = 99

        await startIllustrationExecutor()
        await pokeExecutor()
        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('blocked_config')
        expect(harness.provider).not.toHaveBeenCalled()

        delete harness.database.NAIImgConfig.steps
        await pokeExecutor()
        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('committed')
        expect(measurements).toBe(0)
        expect(harness.provider).toHaveBeenCalledTimes(1)
    })

    test('continues to the next queued job when cancel wins a pre-dispatch version race', async () => {
        const { queued } = await createQueuedJobs()
        const hydrationEntered = deferred<void>()
        const releaseHydration = deferred<void>()
        let shouldBlock = true
        harness.hydrateHook = async (chats, index) => {
            if (!shouldBlock) return chats[index] ?? null
            shouldBlock = false
            hydrationEntered.resolve()
            await releaseHydration.promise
            return chats[index] ?? null
        }

        await startIllustrationExecutor()
        await hydrationEntered.promise
        const first = (await illustrationJobStore.getJob(queued[0].jobId))!
        await cancelLedger({ jobId: first.jobId, expectedVersion: first.version })
        releaseHydration.resolve()
        await pokeExecutor()

        expect((await illustrationJobStore.getJob(queued[0].jobId))?.state).toBe('cancelled')
        expect((await illustrationJobStore.getJob(queued[1].jobId))?.state).toBe('committed')
        expect(harness.provider).toHaveBeenCalledTimes(1)
    })

    // §20 Target/edit: pre-dispatch edit or missing slot makes zero provider calls.
    test('stales an edited source before dispatch with zero provider calls', async () => {
        const { queued, message } = await createQueuedJob()
        message.data = message.data.replace('Executor source', 'Edited source')

        await startIllustrationExecutor()
        await pokeExecutor()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('stale')
        expect(harness.provider).not.toHaveBeenCalled()
    })

    test('makes a deleted slot stale with zero provider calls', async () => {
        const { queued, message } = await createQueuedJob()
        message.data = message.data.replace(/<risu-illustration-slot[\s\S]*?<\/risu-illustration-slot>/, '')

        await startIllustrationExecutor()
        await pokeExecutor()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('stale')
        expect(harness.provider).not.toHaveBeenCalled()
    })

    test('rechecks the slot after durable generating and before provider dispatch', async () => {
        const { queued, message } = await createQueuedJob()
        harness.jobWriteHook = (record) => {
            if (record.state === 'generating') {
                message.data = message.data.replace(
                    /<risu-illustration-slot[\s\S]*?<\/risu-illustration-slot>/,
                    '',
                )
            }
        }

        await startIllustrationExecutor()
        await pokeExecutor()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('stale')
        expect(harness.provider).not.toHaveBeenCalled()
    })

    test('rechecks after provider success and does not write an asset for a new edit', async () => {
        const { queued, message } = await createQueuedJob()
        harness.provider.mockImplementationOnce(async () => {
            harness.events.push('provider')
            message.data = message.data.replace('Executor source', 'Edited source')
            return {
                result: { ok: true, bytesOrDataUrl: 'data:image/png;base64,AA==', providerStatus: 200 },
                compatibilityValue: 'data:image/png;base64,AA==',
            }
        })

        await startIllustrationExecutor()
        await pokeExecutor()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('stale')
        expect(harness.provider).toHaveBeenCalledTimes(1)
        expect(harness.writeInlay).not.toHaveBeenCalled()
    })

    test('fails closed without an asset write when a slot is duplicated after provider success', async () => {
        const { queued, message } = await createQueuedJob()
        harness.provider.mockImplementationOnce(async () => {
            harness.events.push('provider')
            const slot = message.data.match(/<risu-illustration-slot[\s\S]*?<\/risu-illustration-slot>/)![0]
            message.data += slot
            return {
                result: { ok: true, bytesOrDataUrl: 'data:image/png;base64,AA==', providerStatus: 200 },
                compatibilityValue: 'data:image/png;base64,AA==',
            }
        })

        await startIllustrationExecutor()
        await pokeExecutor()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('stale')
        expect(harness.provider).toHaveBeenCalledTimes(1)
        expect(harness.writeInlay).not.toHaveBeenCalled()
    })

    // §20 swipe: switching away makes the captured swipe inactive; only it is patched.
    test('commits an inactive swipe without changing the active data mirror', async () => {
        const { queued, message } = await createQueuedJob('Swipe source', true)
        message.swipeId = 1
        message.data = message.swipes![1]
        const activeText = message.data

        await startIllustrationExecutor()
        await pokeExecutor()

        expect(message.data).toBe(activeText)
        expect(message.swipes![1]).toBe(activeText)
        expect(message.swipes![0]).toContain('{{inlay::asset:')
        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('committed')
    })

    test('patches both mirrors when the captured swipe remains active', async () => {
        const { queued, message } = await createQueuedJob('Active swipe source', true)

        await startIllustrationExecutor()
        await pokeExecutor()

        expect(message.data).toBe(message.swipes![0])
        expect(message.data).toContain('{{inlay::asset:')
        expect(message.swipes![1]).toBe('Other swipe')
        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('committed')
    })

    test('re-finds the exact Chat.id after hydration moves its array index', async () => {
        const { queued, chat } = await createQueuedJob()
        let moved = false
        harness.hydrateHook = (chats, index) => {
            const target = chats[index]
            if (!moved) {
                moved = true
                chats.unshift({
                    id: 'other-conversation',
                    name: 'other',
                    note: '',
                    localLore: [],
                    fmIndex: -1,
                    message: [],
                })
            }
            return target
        }

        await startIllustrationExecutor()
        await pokeExecutor()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('committed')
        expect(harness.strictSave).toHaveBeenCalledWith(
            'character-1',
            1,
            'conversation-1',
            chat,
        )
    })

    test('leaves a queued job recoverable on a transient hydration failure', async () => {
        const { queued } = await createQueuedJob()
        const hydrationAttempted = deferred<void>()
        let failed = false
        harness.hydrateHook = (chats, index) => {
            if (!failed) {
                failed = true
                hydrationAttempted.resolve()
                throw new Error('transient hydration failure')
            }
            return chats[index]
        }

        await startIllustrationExecutor()
        await hydrationAttempted.promise
        await Promise.resolve()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('queued')
        expect(harness.provider).not.toHaveBeenCalled()
    })

    // §13 strict flush failure must never produce committed.
    test('leaves a patched job committing when strict flush fails', async () => {
        const { queued } = await createQueuedJob()
        harness.strictSave.mockRejectedValueOnce(new Error('strict flush failed'))

        await startIllustrationExecutor()
        await pokeExecutor()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('committing')
        expect(harness.strictSave).toHaveBeenCalledTimes(1)
    })

    // §20 uncertain retry: new attempt is retained and only deterministic assetId is authoritative.
    test('reuses the retry attemptId and replaces its assetId deterministically before dispatch', async () => {
        const { queued } = await createQueuedJob()
        harness.provider.mockResolvedValueOnce({
            result: { ok: false, certainty: 'uncertain', reason: 'disconnect' },
            compatibilityValue: false,
        })
        await startIllustrationExecutor()
        await pokeExecutor()
        const uncertain = await illustrationJobStore.getJob(queued.jobId)
        expect(uncertain?.state).toBe('uncertain')
        await stopIllustrationExecutor()

        const retried = await retryUncertainLedger({
            jobId: queued.jobId,
            expectedVersion: uncertain!.version,
            confirmNewCharge: true,
        })
        const placeholderAssetId = retried.assetId
        await startIllustrationExecutor()
        await pokeExecutor()

        const committed = await illustrationJobStore.getJob(queued.jobId)
        expect(committed?.attemptId).toBe(retried.attemptId)
        expect(committed?.assetId).toBe(await deriveIllustrationAssetId(queued.jobId, retried.attemptId!))
        expect(committed?.assetId).not.toBe(placeholderAssetId)
        expect(harness.provider).toHaveBeenCalledTimes(2)
    })

    test('starts idempotently with one epoch, one provider call, and a releasable lock', async () => {
        const { queued } = await createQueuedJob()

        const firstStart = startIllustrationExecutor()
        const secondStart = startIllustrationExecutor()
        expect(secondStart).toBe(firstStart)
        await firstStart
        await pokeExecutor()
        await stopIllustrationExecutor()

        const epochBytes = harness.storageMap.get('illustration:v1:workerEpoch')!
        expect(JSON.parse(new TextDecoder().decode(epochBytes)).value).toBe(1)
        expect(harness.provider).toHaveBeenCalledTimes(1)
        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('committed')
    })

    test('stop lets the in-flight job settle without dispatching another queued job', async () => {
        const { queued } = await createQueuedJobs()
        const providerResult = deferred<any>()
        const providerStarted = deferred<void>()
        harness.provider.mockImplementationOnce(async () => {
            harness.events.push('provider')
            providerStarted.resolve()
            return await providerResult.promise
        })

        await startIllustrationExecutor()
        await providerStarted.promise
        const stopping = stopIllustrationExecutor()
        providerResult.resolve({
            result: { ok: true, bytesOrDataUrl: 'data:image/png;base64,AA==', providerStatus: 200 },
            compatibilityValue: 'data:image/png;base64,AA==',
        })
        await stopping

        expect(harness.provider).toHaveBeenCalledTimes(1)
        expect((await illustrationJobStore.getJob(queued[0].jobId))?.state).toBe('committed')
        expect((await illustrationJobStore.getJob(queued[1].jobId))?.state).toBe('queued')
    })

    test('an old stop never waits on fresh leadership started while its pump settles', async () => {
        await createQueuedJobs()
        const providerResult = deferred<any>()
        const providerStarted = deferred<void>()
        harness.provider.mockImplementationOnce(async () => {
            harness.events.push('provider')
            providerStarted.resolve()
            return await providerResult.promise
        })

        await startIllustrationExecutor()
        await providerStarted.promise
        const stopping = stopIllustrationExecutor()
        let stopSettled = false
        void stopping.then(() => {
            stopSettled = true
        })
        const restarting = startIllustrationExecutor()
        providerResult.resolve({
            result: { ok: true, bytesOrDataUrl: 'data:image/png;base64,AA==', providerStatus: 200 },
            compatibilityValue: 'data:image/png;base64,AA==',
        })

        await restarting
        await Promise.resolve()

        expect(stopSettled).toBe(true)
        await stopping
    })

    test('waits for a non-awaited stop to settle before starting fresh leadership', async () => {
        const firstStart = startIllustrationExecutor()
        await firstStart
        const stopping = stopIllustrationExecutor()

        const restarting = startIllustrationExecutor()
        expect(restarting).not.toBe(firstStart)
        await restarting
        await stopping

        const { queued } = await createQueuedJob('Restarted executor source')
        await pokeExecutor()

        const epochBytes = harness.storageMap.get('illustration:v1:workerEpoch')!
        expect(JSON.parse(new TextDecoder().decode(epochBytes)).value).toBe(2)
        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('committed')
        expect(harness.provider).toHaveBeenCalledTimes(1)
    })

    test('a later stop invalidates a restart that is waiting for teardown', async () => {
        await startIllustrationExecutor()
        const firstStop = stopIllustrationExecutor()
        const pendingRestart = startIllustrationExecutor()
        const restartOutcome = pendingRestart.then(
            () => 'resolved',
            () => 'rejected',
        )

        const finalStop = stopIllustrationExecutor()
        await Promise.all([firstStop, finalStop])

        expect(await restartOutcome).toBe('rejected')
        const epochBytes = harness.storageMap.get('illustration:v1:workerEpoch')!
        expect(JSON.parse(new TextDecoder().decode(epochBytes)).value).toBe(1)
    })

    test('refuses to start while the feature flag is off', async () => {
        const { queued } = await createQueuedJob()
        await setIllustrationFeatureEnabled(false)

        await expect(startIllustrationExecutor()).rejects.toBeInstanceOf(IllustrationFeatureDisabledError)

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('queued')
        expect(harness.provider).not.toHaveBeenCalled()
    })

    test('rechecks the feature flag after a queued worker lock is acquired', async () => {
        const queuedLock = deferred<void>()
        let grant!: () => void
        setIllustrationWorkerLockManagerAccessorForTests(() => ({
            async request(_name, callback, signal) {
                queuedLock.resolve()
                return await new Promise((resolve, reject) => {
                    grant = () => {
                        void Promise.resolve(callback()).then(resolve, reject)
                    }
                    signal?.addEventListener('abort', () => reject(new Error('lock aborted')), { once: true })
                })
            },
        }))
        const starting = startIllustrationExecutor()
        await queuedLock.promise
        await setIllustrationFeatureEnabled(false)

        grant()
        await expect(starting).rejects.toBeInstanceOf(IllustrationFeatureDisabledError)

        expect(harness.storageMap.has('illustration:v1:workerEpoch')).toBe(false)
        expect(harness.provider).not.toHaveBeenCalled()
    })

    test('aborts a queued worker-lock request when stopped', async () => {
        const queuedLock = deferred<void>()
        setIllustrationWorkerLockManagerAccessorForTests(() => ({
            async request(_name, _callback, signal) {
                queuedLock.resolve()
                return await new Promise((_resolve, reject) => {
                    signal?.addEventListener('abort', () => reject(new Error('lock aborted')), { once: true })
                })
            },
        }))
        const starting = startIllustrationExecutor()
        const rejectedStart = expect(starting).rejects.toThrow('lock aborted')
        await queuedLock.promise

        await stopIllustrationExecutor()
        await rejectedStart

        expect(harness.storageMap.has('illustration:v1:workerEpoch')).toBe(false)
    })

    test('wakes from a durable prompt handoff without an explicit poke', async () => {
        const source = 'Wake source'
        installDatabase(source)
        const turn = await registerTrustedTurn({
            chaId: 'character-1',
            conversationId: 'conversation-1',
            expectedMessageId: 'message-1',
            rootTurnId: 'root-wake',
            sourceVariantText: source,
        })
        const claimedTurn = await illustrationJobStore.claimTurn({
            ...coordinatorProof,
            turnId: turn.turnId,
            expectedVersion: turn.version,
            leaseId: 'planner-wake',
        })
        const [projected] = await submitPlanLedger({
            ...coordinatorProof,
            turnId: turn.turnId,
            expectedVersion: claimedTurn.version,
            leaseId: 'planner-wake',
            fence: claimedTurn.fence,
            idempotencyKey: `plan:${turn.turnId}`,
            sourceRevisionHash: turn.sourceRevisionHash!,
            slots: [{
                sceneId: 'scene-wake',
                insertAfterUtf16: source.length,
                scenePayload: { schemaVersion: 1, data: {} },
            }],
        })
        const claimedJob = await illustrationJobStore.claimJob({
            ...coordinatorProof,
            jobId: projected.jobId,
            expectedVersion: projected.version,
            leaseId: 'tagger-wake',
        })
        await startIllustrationExecutor()

        await supplyPromptLedger({
            ...coordinatorProof,
            jobId: projected.jobId,
            expectedVersion: claimedJob.version,
            leaseId: 'tagger-wake',
            fence: claimedJob.fence,
            idempotencyKey: `prompt:${projected.jobId}`,
            positive: 'wake prompt',
            negative: '',
        })
        await vi.waitFor(async () => {
            expect((await illustrationJobStore.getJob(projected.jobId))?.state).toBe('committed')
        })

        expect(harness.provider).toHaveBeenCalledTimes(1)
    })

    test('consumes a poke that arrives after the pump loop exits without advancing the poll timer', async () => {
        const dyingGap = deferred<void>()
        const releaseGap = deferred<void>()
        let featureReads = 0
        harness.getItemHook = async (key) => {
            if (key !== 'illustration:v1:featureEnabled') return
            featureReads += 1
            if (featureReads === 4) {
                dyingGap.resolve()
                await releaseGap.promise
            }
        }

        await startIllustrationExecutor()
        await dyingGap.promise
        const { queued } = await createQueuedJob('Dying gap source')
        const waking = pokeExecutor()
        releaseGap.resolve()
        await waking

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('committed')
        expect(harness.provider).toHaveBeenCalledTimes(1)
    })

    test('keeps successful bytes when cancel wins the generating-to-writing version race', async () => {
        const { queued } = await createQueuedJob()
        let providerReturned = false
        harness.provider.mockImplementationOnce(async () => {
            harness.events.push('provider')
            providerReturned = true
            return {
                result: { ok: true, bytesOrDataUrl: 'data:image/png;base64,AA==', providerStatus: 200 },
                compatibilityValue: 'data:image/png;base64,AA==',
            }
        })
        const originalGetJob = illustrationJobStore.getJob.bind(illustrationJobStore)
        let injected = false
        const getJobSpy = vi.spyOn(illustrationJobStore, 'getJob').mockImplementation(async (jobId) => {
            const snapshot = await originalGetJob(jobId)
            if (!injected && providerReturned && snapshot?.state === 'generating') {
                injected = true
                await illustrationJobStore.requestCancel({ jobId, expectedVersion: snapshot.version })
            }
            return snapshot
        })

        await startIllustrationExecutor()
        await pokeExecutor()
        getJobSpy.mockRestore()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('cancelled')
        expect(harness.writeInlay).toHaveBeenCalledTimes(1)
        expect(harness.strictSave).not.toHaveBeenCalled()
    })

    test('preserves a definite provider result when cancel wins its version race', async () => {
        const { queued } = await createQueuedJob()
        let providerReturned = false
        harness.provider.mockImplementationOnce(async () => {
            harness.events.push('provider')
            providerReturned = true
            return {
                result: { ok: false, certainty: 'definite', reason: 'rejected', providerStatus: 400 },
                compatibilityValue: false,
            }
        })
        const originalGetJob = illustrationJobStore.getJob.bind(illustrationJobStore)
        let injected = false
        const getJobSpy = vi.spyOn(illustrationJobStore, 'getJob').mockImplementation(async (jobId) => {
            const snapshot = await originalGetJob(jobId)
            if (!injected && providerReturned && snapshot?.state === 'generating') {
                injected = true
                await illustrationJobStore.requestCancel({ jobId, expectedVersion: snapshot.version })
            }
            return snapshot
        })

        await startIllustrationExecutor()
        await pokeExecutor()
        getJobSpy.mockRestore()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('failed')
        expect(harness.writeInlay).not.toHaveBeenCalled()
    })

    test('keeps successful bytes when cancel wins the writing-to-ready version race', async () => {
        const { queued } = await createQueuedJob()
        const originalGetJob = illustrationJobStore.getJob.bind(illustrationJobStore)
        let injected = false
        const getJobSpy = vi.spyOn(illustrationJobStore, 'getJob').mockImplementation(async (jobId) => {
            const snapshot = await originalGetJob(jobId)
            if (!injected && snapshot?.state === 'asset_writing' && harness.writeInlay.mock.calls.length > 0) {
                injected = true
                await illustrationJobStore.requestCancel({ jobId, expectedVersion: snapshot.version })
            }
            return snapshot
        })

        await startIllustrationExecutor()
        await pokeExecutor()
        getJobSpy.mockRestore()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('cancelled')
        expect(harness.writeInlay).toHaveBeenCalledTimes(1)
        expect(harness.strictSave).not.toHaveBeenCalled()
    })

    test('preserves asset-write uncertainty when cancel wins its version race', async () => {
        const { queued } = await createQueuedJob()
        harness.writeInlay.mockRejectedValueOnce(new Error('decode failed after possible write'))
        const originalGetJob = illustrationJobStore.getJob.bind(illustrationJobStore)
        let injected = false
        const getJobSpy = vi.spyOn(illustrationJobStore, 'getJob').mockImplementation(async (jobId) => {
            const snapshot = await originalGetJob(jobId)
            if (!injected && snapshot?.state === 'asset_writing') {
                injected = true
                await illustrationJobStore.requestCancel({ jobId, expectedVersion: snapshot.version })
            }
            return snapshot
        })

        await startIllustrationExecutor()
        await pokeExecutor()
        getJobSpy.mockRestore()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('uncertain')
        expect(harness.strictSave).not.toHaveBeenCalled()
    })

    test('allows exactly one winner in the asset_ready cancel-versus-commit CAS', async () => {
        const { queued } = await createQueuedJob()
        let job = await illustrationJobStore.transitionJob({
            jobId: queued.jobId,
            expectedVersion: queued.version,
            to: 'generating',
            patch: {
                idempotencyKey: 'race:generating',
                workerEpoch: 7,
                attemptId: 'attempt:race',
                assetId: 'asset:race',
            },
        })
        job = await illustrationJobStore.transitionJob({
            jobId: job.jobId,
            expectedVersion: job.version,
            to: 'asset_writing',
            patch: { idempotencyKey: 'race:writing', workerEpoch: 7 },
        })
        job = await illustrationJobStore.transitionJob({
            jobId: job.jobId,
            expectedVersion: job.version,
            to: 'asset_ready',
            patch: { idempotencyKey: 'race:ready', workerEpoch: 7 },
        })
        harness.integrity.set(job.assetId!, 'complete')
        harness.events.length = 0

        await Promise.allSettled([
            cancelLedger({ jobId: job.jobId, expectedVersion: job.version }),
            commitIllustrationAssetReadyJob(job.jobId, 7),
        ])

        const final = await illustrationJobStore.getJob(job.jobId)
        expect(['cancelled', 'committed']).toContain(final?.state)
        const winnerEvents = harness.events.filter(
            (event) => event === 'job:cancelled' || event === 'job:committed',
        )
        expect(winnerEvents).toHaveLength(1)
        expect(harness.strictSave).toHaveBeenCalledTimes(final?.state === 'committed' ? 1 : 0)
    })

    // §20 cancel: successful bytes after generating cancel finish integrity, never chat commit.
    test('retains a successful asset after generating cancel and skips chat commit', async () => {
        const { queued } = await createQueuedJob()
        const providerResult = deferred<any>()
        const providerStarted = deferred<void>()
        harness.provider.mockImplementationOnce(async () => {
            harness.events.push('provider')
            providerStarted.resolve()
            return await providerResult.promise
        })

        await startIllustrationExecutor()
        const pumping = pokeExecutor()
        await providerStarted.promise
        const generating = await illustrationJobStore.getJob(queued.jobId)
        expect(generating?.state).toBe('generating')
        const cancelledRequest = await cancelLedger({
            jobId: queued.jobId,
            expectedVersion: generating!.version,
        })
        expect(cancelledRequest.state).toBe('cancel_requested')

        providerResult.resolve({
            result: { ok: true, bytesOrDataUrl: 'data:image/png;base64,AA==', providerStatus: 200 },
            compatibilityValue: 'data:image/png;base64,AA==',
        })
        await pumping

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('cancelled')
        expect(harness.writeInlay).toHaveBeenCalledTimes(1)
        expect(harness.strictSave).not.toHaveBeenCalled()
    })

    test.each([
        ['definite', 'failed'],
        ['uncertain', 'uncertain'],
    ] as const)(
        'keeps a %s provider result authoritative after generating cancel',
        async (certainty, expectedState) => {
            const { queued } = await createQueuedJob()
            const providerResult = deferred<any>()
            const providerStarted = deferred<void>()
            harness.provider.mockImplementationOnce(async () => {
                harness.events.push('provider')
                providerStarted.resolve()
                return await providerResult.promise
            })

            await startIllustrationExecutor()
            const pumping = pokeExecutor()
            await providerStarted.promise
            const generating = await illustrationJobStore.getJob(queued.jobId)
            await cancelLedger({ jobId: queued.jobId, expectedVersion: generating!.version })
            providerResult.resolve({
                result: certainty === 'definite'
                    ? { ok: false, certainty, reason: 'rejected', providerStatus: 400 }
                    : { ok: false, certainty, reason: 'disconnect' },
                compatibilityValue: false,
            })
            await pumping

            expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe(expectedState)
            expect(harness.writeInlay).not.toHaveBeenCalled()
            expect(harness.strictSave).not.toHaveBeenCalled()
        },
    )
})
