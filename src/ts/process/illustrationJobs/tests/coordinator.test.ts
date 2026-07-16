import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Chat, Message } from '../../../storage/database.svelte'
import {
    createImagePromptMeasurementService,
    createImagePromptTokenizerLoader,
    setImagePromptMeasurementServiceForTests,
} from '../imagePromptMeasurement'
import { installImagePromptMeasurementTestService } from './imagePromptTestHarness'
import { InMemoryLockManager } from './inMemoryLockManager'

const harness = vi.hoisted(() => ({
    storageMap: new Map<string, Uint8Array>(),
    storageEvents: [] as string[],
    database: null as any,
    strictFailure: null as Error | null,
    storageHook: null as ((key: string) => void) | null,
    mutationHook: null as (() => void) | null,
    strictSave: vi.fn(),
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: {
        async Init() {},
        async keys(prefix = '') {
            return [...harness.storageMap.keys()].filter((key) => key.startsWith(prefix))
        },
        async getItem(key: string) {
            return harness.storageMap.get(key) ?? null
        },
        async setItem(key: string, value: Uint8Array) {
            harness.storageEvents.push(`storage:${key}`)
            harness.storageHook?.(key)
            harness.storageMap.set(key, new Uint8Array(value))
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
    ensureChatHydrated: vi.fn(async (chats: Chat[], index: number) => chats[index] ?? null),
    saveChatToServerStrict: harness.strictSave,
}))

const coordinatorModule = await import('../coordinator')
const coordinatorRecordModule = await import('../coordinatorRecord')
const featureModule = await import('../featureFlag')
const illustrationEventsModule = await import('../illustrationEvents')
const lockModule = await import('../locks')
const operationLockModule = await import('../operationLock')
const storeModule = await import('../store')

const {
    cancelLedger,
    cancelTurnLedger,
    registerTrustedTurn,
    submitPlanLedger,
    supplyPromptLedger,
} = coordinatorModule
const { claimCoordinator } = coordinatorRecordModule
const { IllustrationFeatureDisabledError, setIllustrationFeatureEnabled } = featureModule
const { subscribeIllustrationWakeHints } = illustrationEventsModule
const { resetIllustrationLockManagerAccessorForTests, setIllustrationLockManagerAccessorForTests } = lockModule
const {
    resetIllustrationOperationLockManagerAccessorForTests,
    setIllustrationOperationLockManagerAccessorForTests,
} = operationLockModule
const {
    illustrationJobStore,
    illustrationJobKey,
    illustrationManifestKey,
    illustrationTurnKey,
} = storeModule

const BASE_TIME = Date.UTC(2026, 0, 2)
let mutationEvents: string[]
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

function makeMessage(source: string): Message {
    let data = source
    const message = {
        role: 'char',
        chatId: 'message-1',
    } as Message
    Object.defineProperty(message, 'data', {
        enumerable: true,
        configurable: true,
        get: () => data,
        set: (value: string) => {
            mutationEvents.push('marker')
            harness.mutationHook?.()
            data = value
        },
    })
    return message
}

function installDatabase(source = 'A quiet scene.'): Chat {
    const chat: Chat = {
        id: 'conversation-1',
        name: 'chat',
        note: '',
        localLore: [],
        fmIndex: -1,
        message: [makeMessage(source)],
    }
    harness.database = {
        characters: [{ chaId: 'character-1', chats: [chat], chatPage: 0 }],
        sdProvider: 'novelai',
        NAIImgUrl: 'https://image.novelai.net/ai/generate-image',
        NAIImgModel: 'nai-diffusion-4-5-full',
        NAII2I: false,
        NAIImgConfig: {},
    }
    return chat
}

function registerInput(sourceVariantText = 'A quiet scene.') {
    return {
        chaId: 'character-1',
        conversationId: 'conversation-1',
        expectedMessageId: 'message-1',
        rootTurnId: 'root-turn-1',
        sourceVariantText,
    }
}

function decodeStored<T>(key: string): T | null {
    const value = harness.storageMap.get(key)
    return value ? JSON.parse(new TextDecoder().decode(value)) as T : null
}

async function registerAndClaim(source = 'A quiet scene.') {
    installDatabase(source)
    const registered = await registerTrustedTurn(registerInput(source))
    const claimed = await illustrationJobStore.claimTurn({
        ...coordinatorProof,
        turnId: registered.turnId,
        expectedVersion: registered.version,
        leaseId: 'planner-lease',
    })
    return { registered, claimed }
}

function submitInput(
    claimed: Awaited<ReturnType<typeof illustrationJobStore.claimTurn>>,
    offsets: number[],
) {
    return {
        ...coordinatorProof,
        turnId: claimed.turnId,
        expectedVersion: claimed.version,
        leaseId: 'planner-lease',
        fence: claimed.fence,
        idempotencyKey: `plan:${claimed.turnId}`,
        sourceRevisionHash: claimed.sourceRevisionHash!,
        slots: offsets.map((insertAfterUtf16, index) => ({
            sceneId: `scene-${index}`,
            insertAfterUtf16,
            scenePayload: { schemaVersion: 1, data: { description: `scene ${index}` } },
        })),
    }
}

beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    harness.storageMap.clear()
    harness.storageEvents.length = 0
    harness.strictFailure = null
    harness.storageHook = null
    harness.mutationHook = null
    harness.strictSave.mockReset()
    mutationEvents = []
    installDatabase()
    restoreImagePromptMeasurement = installImagePromptMeasurementTestService(() => harness.database)
    lockManager = new InMemoryLockManager()
    setIllustrationLockManagerAccessorForTests(() => lockManager)
    setIllustrationOperationLockManagerAccessorForTests(() => lockManager)
    await setIllustrationFeatureEnabled(true)
    await refreshCoordinatorProof()
    harness.storageEvents.length = 0
    harness.strictSave.mockImplementation(async () => {
        mutationEvents.push('strict')
        harness.storageEvents.push('strict')
        if (harness.strictFailure) throw harness.strictFailure
        return { success: true, durable: true }
    })
})

describe('submitPlanLedger', () => {
    // §20 Manifest/API + §7.3: prepared manifest -> records -> records_complete -> projection ACK.
    test('materializes all slots in one transform and advances records only after strict ACK', async () => {
        const { claimed } = await registerAndClaim('ABCD')
        harness.storageEvents.length = 0
        harness.strictSave.mockImplementation(async () => {
            harness.storageEvents.push('strict')
            const manifest = decodeStored<any>(illustrationManifestKey(claimed.turnId))
            expect(manifest.phase).toBe('records_complete')
            for (const entry of manifest.jobs) {
                expect(decodeStored<any>(illustrationJobKey(entry.jobId)).state).toBe('prepared')
            }
            return { success: true, durable: true }
        })

        const jobs = await submitPlanLedger(submitInput(claimed, [1, 3]))
        const manifest = await illustrationJobStore.getManifest(claimed.turnId)
        const turn = await illustrationJobStore.getTurn(claimed.turnId)
        const text = harness.database.characters[0].chats[0].message[0].data as string

        expect(jobs).toHaveLength(2)
        expect(jobs.every((job: any) => job.state === 'awaiting_prompt')).toBe(true)
        expect(manifest?.phase).toBe('projection_durable')
        expect(turn?.state).toBe('awaiting_prompt')
        expect(text).not.toContain('risu-illustration-request')
        expect(text.match(/<risu-illustration-slot /g)).toHaveLength(2)
        expect(text.startsWith('A<risu-illustration-slot')).toBe(true)
        expect(text.endsWith('</risu-illustration-slot>D')).toBe(true)

        const strictIndex = harness.storageEvents.indexOf('strict')
        const manifestWrites = harness.storageEvents
            .map((event, index) => event === `storage:${illustrationManifestKey(claimed.turnId)}` ? index : -1)
            .filter((index) => index >= 0)
        expect(manifestWrites).toHaveLength(3)
        expect(manifestWrites[1]).toBeLessThan(strictIndex)
        expect(strictIndex).toBeLessThan(manifestWrites[2])
    })

    // §20 Maximum jobs and placement validation happen before chat mutation/flush.
    test('rejects a sixteenth slot and invalid UTF-16 offsets before any chat write', async () => {
        const { claimed } = await registerAndClaim('A😀B')
        const markerText = harness.database.characters[0].chats[0].message[0].data
        harness.strictSave.mockClear()

        await expect(submitPlanLedger(submitInput(claimed, Array.from({ length: 16 }, (_, i) => i))))
            .rejects.toThrow('at most 15')
        await expect(submitPlanLedger(submitInput(claimed, [2])))
            .rejects.toThrow('surrogate_split')

        expect(harness.strictSave).not.toHaveBeenCalled()
        expect(harness.database.characters[0].chats[0].message[0].data).toBe(markerText)
        expect(await illustrationJobStore.getManifest(claimed.turnId)).toBeNull()
    })

    // §20 Target/edit: a changed normalized source becomes stale without chat write.
    test('marks a changed source stale before manifest or chat write', async () => {
        const { claimed } = await registerAndClaim('Original')
        const message = harness.database.characters[0].chats[0].message[0]
        message.data = `Edited${message.data.slice('Original'.length)}`
        harness.strictSave.mockClear()

        await expect(submitPlanLedger(submitInput(claimed, [1]))).rejects.toThrow('stale')

        expect((await illustrationJobStore.getTurn(claimed.turnId))?.state).toBe('stale')
        expect(await illustrationJobStore.getManifest(claimed.turnId)).toBeNull()
        expect(harness.strictSave).not.toHaveBeenCalled()
    })

    // §20 zero-scene Planner result removes the request marker durably and ends the turn.
    test('durably removes the marker and closes a zero-scene turn', async () => {
        const { claimed } = await registerAndClaim('No image needed.')
        harness.strictSave.mockClear()

        const jobs = await submitPlanLedger(submitInput(claimed, []))

        expect(jobs).toEqual([])
        expect(harness.strictSave).toHaveBeenCalledTimes(1)
        expect(harness.database.characters[0].chats[0].message[0].data).toBe('No image needed.')
        expect((await illustrationJobStore.getManifest(claimed.turnId))?.phase).toBe('projection_durable')
        expect((await illustrationJobStore.getTurn(claimed.turnId))?.state).toBe('no_scenes')
    })

    // §20 Manifest/API: a lost submitPlan response replays the durable projection.
    test('returns the existing jobs for an identical submitPlan replay', async () => {
        const { claimed } = await registerAndClaim('Replay plan')
        const input = submitInput(claimed, [6])
        const first = await submitPlanLedger(input)
        harness.strictSave.mockClear()

        const replay = await submitPlanLedger(input)

        expect(replay).toEqual(first)
        expect(await illustrationJobStore.listJobs({ turnId: claimed.turnId })).toHaveLength(1)
        expect(harness.strictSave).not.toHaveBeenCalled()
    })

    test('reconciles an identical replay after strict ACK but before projection_durable', async () => {
        const { claimed } = await registerAndClaim('Phase replay')
        const input = submitInput(claimed, [5])
        let manifestWrites = 0
        harness.storageHook = (key) => {
            if (key === illustrationManifestKey(claimed.turnId) && ++manifestWrites === 3) {
                throw new Error('crash before projection phase')
            }
        }
        await expect(submitPlanLedger(input)).rejects.toThrow('crash before projection phase')
        harness.storageHook = null

        const replay = await submitPlanLedger(input)

        expect(replay).toHaveLength(1)
        expect(replay[0].state).toBe('awaiting_prompt')
        expect((await illustrationJobStore.getManifest(claimed.turnId))?.phase)
            .toBe('projection_durable')
        expect((await illustrationJobStore.getTurn(claimed.turnId))?.state).toBe('awaiting_prompt')
    })

    test('serializes concurrent identical submitPlan calls into one projection flush', async () => {
        const { claimed } = await registerAndClaim('Concurrent plan')
        const input = submitInput(claimed, [5])
        harness.strictSave.mockClear()

        const [first, second] = await Promise.all([
            submitPlanLedger(input),
            submitPlanLedger(input),
        ])

        expect(second).toEqual(first)
        expect(harness.strictSave).toHaveBeenCalledTimes(1)
        expect(await illustrationJobStore.listJobs({ turnId: claimed.turnId })).toHaveLength(1)
    })

    // §8.3 materialization CAS: an edit during ledger writes is never overwritten.
    test('rechecks the source immediately before projection and preserves an intervening edit', async () => {
        const { claimed } = await registerAndClaim('Race source')
        const message = harness.database.characters[0].chats[0].message[0]
        let edited = false
        harness.storageHook = (key) => {
            if (!edited && key.startsWith('illustration:v1:job:')) {
                edited = true
                message.data = message.data.replace('Race source', 'User edit')
            }
        }
        harness.strictSave.mockClear()

        await expect(submitPlanLedger(submitInput(claimed, [4]))).rejects.toThrow('stale')

        expect(message.data).toContain('User edit')
        expect(message.data).not.toContain('risu-illustration-slot')
        expect(harness.strictSave).not.toHaveBeenCalled()
        expect((await illustrationJobStore.getTurn(claimed.turnId))?.state).toBe('stale')
        expect((await illustrationJobStore.listJobs({ turnId: claimed.turnId }))[0]?.state).toBe('stale')
    })
})

describe('prompt handoff and cancellation', () => {
    async function createClaimedPromptJob(source = 'Prompt source') {
        const { claimed } = await registerAndClaim(source)
        const [projected] = await submitPlanLedger(submitInput(claimed, [source.length]))
        const job = await illustrationJobStore.claimJob({
            ...coordinatorProof,
            jobId: projected.jobId,
            expectedVersion: projected.version,
            leaseId: 'tagger-lease',
        })
        return job
    }

    function promptInput(job: Awaited<ReturnType<typeof illustrationJobStore.claimJob>>) {
        return {
            ...coordinatorProof,
            jobId: job.jobId,
            expectedVersion: job.version,
            leaseId: 'tagger-lease',
            fence: job.fence,
            idempotencyKey: `prompt:${job.jobId}`,
            positive: 'cinematic scene',
            negative: '',
        }
    }

    test('persists turn cancellation before best-effort strict marker removal', async () => {
        const { claimed } = await registerAndClaim('Cancelled source')
        const order: string[] = []
        harness.storageHook = (key) => {
            if (key === illustrationTurnKey(claimed.turnId)) order.push('ledger')
        }
        harness.mutationHook = () => order.push('marker')
        harness.strictSave.mockImplementation(async () => {
            order.push('strict')
            return { success: true, durable: true }
        })

        const cancelled = await cancelTurnLedger({
            turnId: claimed.turnId,
            expectedVersion: claimed.version,
        })
        expect(cancelled).toMatchObject({ state: 'cancelled' })
        expect(order).toEqual(['ledger', 'marker', 'strict'])
        expect((await illustrationJobStore.getTurn(claimed.turnId))?.leaseId).toBeNull()
        expect(harness.database.characters[0].chats[0].message[0].data)
            .not.toContain('risu-illustration-request')
    })

    test('does not roll back cancelled when strict marker removal fails', async () => {
        const { claimed } = await registerAndClaim('Cancelled flush failure')
        harness.strictSave.mockClear()
        harness.strictFailure = new Error('strict removal failed')
        const cancelled = await cancelTurnLedger({
            turnId: claimed.turnId,
            expectedVersion: claimed.version,
        })
        expect(cancelled.state).toBe('cancelled')
        expect((await illustrationJobStore.getTurn(claimed.turnId))?.state).toBe('cancelled')
        expect(harness.strictSave).toHaveBeenCalledTimes(1)
    })

    // §10.1 / §14: final prompts are validated and durable before queued.
    test('queues a durable positive prompt while allowing an empty negative prompt', async () => {
        const job = await createClaimedPromptJob()

        const queued = await supplyPromptLedger(promptInput(job))

        expect(queued).toMatchObject({
            state: 'queued',
            prompt: {
                schemaVersion: 1,
                layout: 'flat',
                basePositive: 'cinematic scene',
                characterPositives: [],
                baseNegative: '',
                characterNegatives: [],
            },
        })
    })

    // §20 Manifest/API: a lost supplyPrompt response replays the same queued write.
    test('returns the queued job for an identical supplyPrompt replay', async () => {
        const job = await createClaimedPromptJob()
        const input = promptInput(job)
        const first = await supplyPromptLedger(input)

        const replay = await supplyPromptLedger(input)

        expect(replay).toEqual(first)
        expect((await illustrationJobStore.getJob(job.jobId))?.version).toBe(first.version)
    })

    // Request §4 row 8: a pre-contract physical flat ACK replays without migration/measurement.
    test('replays a physical legacy string handoff byte-exactly across the upgrade boundary', async () => {
        const job = await createClaimedPromptJob()
        const input = promptInput(job)
        const accepted = await supplyPromptLedger(input)
        const key = illustrationJobKey(job.jobId)
        const physicalLegacy = decodeStored<any>(key)
        physicalLegacy.prompt = { positive: input.positive, negative: input.negative }
        harness.storageMap.set(key, new TextEncoder().encode(JSON.stringify(physicalLegacy)))

        restoreImagePromptMeasurement()
        restoreImagePromptMeasurement = setImagePromptMeasurementServiceForTests({
            resolveSettings: async () => { throw new Error('legacy replay must not measure') },
            measure: async () => { throw new Error('legacy replay must not measure') },
        })

        await expect(supplyPromptLedger(input)).resolves.toMatchObject({
            version: accepted.version,
            prompt: { positive: input.positive, negative: input.negative },
        })
        await expect(supplyPromptLedger({ ...input, positive: `${input.positive}!` }))
            .rejects.toThrow('conflicting patch data')
    })

    // Request §4 row 5: durable structure/order is the lost-ACK provenance identity.
    test('persists structured parts and rejects reordered replay as conflicting identity', async () => {
        const job = await createClaimedPromptJob()
        const { positive: _positive, negative: _negative, ...base } = promptInput(job)
        const prompt = {
            schemaVersion: 1 as const,
            layout: 'nai-v4-characters' as const,
            basePositive: 'base positive',
            characterPositives: ['source#1 Alice', 'target#2 Bob'],
            baseNegative: 'base negative',
            characterNegatives: ['negative Alice', 'negative Bob'],
        }
        const input = { ...base, prompt }
        const queued = await supplyPromptLedger(input)

        expect(decodeStored<any>(illustrationJobKey(job.jobId)).prompt).toEqual(prompt)
        await expect(supplyPromptLedger(input)).resolves.toEqual(queued)
        await expect(supplyPromptLedger({
            ...input,
            prompt: {
                ...prompt,
                characterPositives: [...prompt.characterPositives].reverse(),
            },
        })).rejects.toThrow('conflicting patch data')
        expect((await illustrationJobStore.getJob(job.jobId))?.prompt).toEqual(prompt)
    })

    // Request §4 rows 1-2: final combined over-limit rejects before the durable handoff.
    test('rejects an over-limit final V4 prompt with measured payload and no state change', async () => {
        const job = await createClaimedPromptJob()
        const before = await illustrationJobStore.getJob(job.jobId)
        restoreImagePromptMeasurement()
        restoreImagePromptMeasurement = installImagePromptMeasurementTestService(
            () => harness.database,
            (text) => text === 'cinematic scene' ? 513 : 0,
        )

        await expect(supplyPromptLedger(promptInput(job))).rejects.toMatchObject({
            code: 'image_prompt_over_limit',
            payload: {
                positiveTokens: 513,
                negativeTokens: 0,
                maxPositiveTokens: 512,
                maxNegativeTokens: 512,
                model: 'nai-diffusion-4-5-full',
            },
        })
        expect(await illustrationJobStore.getJob(job.jobId)).toEqual(before)
    })

    // Request §4 row 7: transient tokenizer failure is fail-closed but does not poison retry.
    test('keeps awaiting_prompt on tokenizer failure and accepts a later retry', async () => {
        const job = await createClaimedPromptJob()
        const loadModel = vi.fn()
            .mockRejectedValueOnce(new Error('asset temporarily unavailable'))
            .mockResolvedValue(new ArrayBuffer(0))
        restoreImagePromptMeasurement()
        restoreImagePromptMeasurement = setImagePromptMeasurementServiceForTests(
            createImagePromptMeasurementService({
                getDatabase: () => harness.database,
                tokenizerLoader: createImagePromptTokenizerLoader({
                    loadModel,
                    createTokenizer: async () => ({ encode: () => ({ length: 1 }) }),
                }),
            }),
        )

        await expect(supplyPromptLedger(promptInput(job)))
            .rejects.toMatchObject({ code: 'image_tokenizer_unavailable' })
        const unchanged = await illustrationJobStore.getJob(job.jobId)
        expect(unchanged?.state).toBe('awaiting_prompt')
        expect(unchanged?.prompt).toBeUndefined()
        await expect(supplyPromptLedger(promptInput(job))).resolves.toMatchObject({ state: 'queued' })
        expect(loadModel).toHaveBeenCalledTimes(2)
    })

    test('rejects blank or over-16-KiB UTF-8 prompts before any job write', async () => {
        const job = await createClaimedPromptJob()
        const before = await illustrationJobStore.getJob(job.jobId)

        await expect(supplyPromptLedger({ ...promptInput(job), positive: '   ' }))
            .rejects.toThrow('positive prompt')
        await expect(supplyPromptLedger({ ...promptInput(job), positive: '가'.repeat(5_462) }))
            .rejects.toThrow('16 KiB')
        await expect(supplyPromptLedger({ ...promptInput(job), negative: '가'.repeat(5_462) }))
            .rejects.toThrow('16 KiB')

        expect(await illustrationJobStore.getJob(job.jobId)).toEqual(before)
    })

    // §5-8 / §8.3: edit discovered at Tagger handoff stales before prompt persistence.
    test('stales an awaiting_prompt job when the source changed before handoff', async () => {
        const job = await createClaimedPromptJob('Editable source')
        const message = harness.database.characters[0].chats[0].message[0]
        message.data = message.data.replace('Editable source', 'Edited source')

        await expect(supplyPromptLedger(promptInput(job))).rejects.toThrow('stale')

        const stale = await illustrationJobStore.getJob(job.jobId)
        expect(stale?.state).toBe('stale')
        expect(stale?.prompt).toBeUndefined()
    })

    test('preserves cumulative Agent attempts when a retried prompt handoff closes stale', async () => {
        const job = await createClaimedPromptJob('Retry then edit source')
        const blocked = await illustrationJobStore.reportAgentFailure({
            protocolVersion: 1,
            kind: 'job',
            id: job.jobId,
            expectedVersion: job.version,
            leaseId: 'tagger-lease',
            fence: job.fence,
            ...coordinatorProof,
            idempotencyKey: 'failure:retry-then-edit',
            code: 'tagger_failed',
            retryable: true,
        })
        const retried = await illustrationJobStore.retryAgentFailure({
            protocolVersion: 1,
            kind: 'job',
            id: job.jobId,
            expectedVersion: blocked.version,
            confirmNewLlmCharge: true,
            ...coordinatorProof,
        })
        const reclaimed = await illustrationJobStore.claimJob({
            ...coordinatorProof,
            jobId: job.jobId,
            expectedVersion: retried.version,
            leaseId: 'tagger-lease',
        })
        const message = harness.database.characters[0].chats[0].message[0]
        message.data = message.data.replace('Retry then edit source', 'Edited after retry')

        await expect(supplyPromptLedger(promptInput(reclaimed))).rejects.toThrow('stale')
        expect(await illustrationJobStore.getJob(job.jobId)).toMatchObject({
            state: 'stale',
            agentAttemptCount: 1,
        })
    })

    // §10.3 queued cancel is immediate and needs no provider participation.
    test('cancels a queued job immediately', async () => {
        const claimed = await createClaimedPromptJob()
        const queued = await supplyPromptLedger(promptInput(claimed))

        const cancelled = await cancelLedger({
            jobId: queued.jobId,
            expectedVersion: queued.version,
        })

        expect(cancelled).toMatchObject({ state: 'cancelled', cancelRequestedAt: BASE_TIME })
    })
})

afterEach(() => {
    restoreImagePromptMeasurement()
    resetIllustrationLockManagerAccessorForTests()
    resetIllustrationOperationLockManagerAccessorForTests()
    vi.useRealTimers()
})

describe('registerTrustedTurn', () => {
    // §20 Crash/storage/cancel + §6.2: ledger first, marker, strict ACK, awaiting_plan.
    test('persists the prepared ledger before marker mutation and advances only after strict ACK', async () => {
        const hints: Array<{ kind: string; turnId: string }> = []
        const unsubscribe = subscribeIllustrationWakeHints((hint) => hints.push(hint))
        const turn = await registerTrustedTurn(registerInput())
        await Promise.resolve()
        unsubscribe()

        expect(harness.storageEvents[0]).toBe(`storage:${illustrationTurnKey(turn.turnId)}`)
        expect(mutationEvents).toEqual(['marker', 'strict'])
        expect(harness.strictSave).toHaveBeenCalledTimes(1)
        expect(turn).toMatchObject({ state: 'awaiting_plan', sourceTextUtf16: 'A quiet scene.' })
        expect(harness.database.characters[0].chats[0].message[0].data)
            .toMatch(/^A quiet scene\.<!--risu-illustration-request:v1:[A-Za-z0-9_-]+-->$/)
        expect(hints).toContainEqual(expect.objectContaining({
            kind: 'turn_changed',
            turnId: turn.turnId,
        }))
    })

    test('leaves blocked_capture after strict failure without retrying the marker', async () => {
        harness.strictFailure = new Error('durable write rejected')

        await expect(registerTrustedTurn(registerInput())).rejects.toThrow('durable write rejected')

        const [turn] = await illustrationJobStore.listTurns()
        expect(turn.state).toBe('blocked_capture')
        expect(harness.strictSave).toHaveBeenCalledTimes(1)
        expect(mutationEvents).toEqual(['marker', 'strict'])
        expect((harness.database.characters[0].chats[0].message[0].data.match(/risu-illustration-request/g) ?? []))
            .toHaveLength(1)

        harness.strictFailure = null
        harness.strictSave.mockClear()
        const replay = await registerTrustedTurn(registerInput())

        expect(replay.state).toBe('blocked_capture')
        expect(harness.strictSave).not.toHaveBeenCalled()
        expect((harness.database.characters[0].chats[0].message[0].data.match(/risu-illustration-request/g) ?? []))
            .toHaveLength(1)
    })

    test('blocks capture without mutating any swipe when the active variant changes during ledger creation', async () => {
        const message = {
            role: 'char',
            chatId: 'message-1',
            data: 'Swipe A',
            swipes: ['Swipe A', 'Swipe B', 'Swipe C'],
            swipeId: 0,
        } as Message
        harness.database.characters[0].chats[0].message = [message]
        const originalSwipes = [...message.swipes!]
        let changed = false
        harness.storageHook = (key) => {
            if (!changed && key.startsWith('illustration:v1:turn:')) {
                changed = true
                message.swipeId = 1
                message.data = message.swipes![1]
            }
        }

        await expect(registerTrustedTurn(registerInput('Swipe A')))
            .rejects.toThrow('changed before capture')

        const [turn] = await illustrationJobStore.listTurns()
        expect(turn).toMatchObject({
            state: 'blocked_capture',
            error: { code: 'capture_variant_raced' },
        })
        expect(message.data).toBe('Swipe B')
        expect(message.swipes).toEqual(originalSwipes)
        expect([message.data, ...message.swipes!].join('\n')).not.toContain('risu-illustration-request')
        expect(harness.strictSave).not.toHaveBeenCalled()
    })

    test('uses requestKey idempotency under concurrent registration', async () => {
        const [first, second] = await Promise.all([
            registerTrustedTurn(registerInput()),
            registerTrustedTurn(registerInput()),
        ])

        expect(second).toEqual(first)
        expect(await illustrationJobStore.listTurns()).toHaveLength(1)
        expect(harness.strictSave).toHaveBeenCalledTimes(1)
        expect((harness.database.characters[0].chats[0].message[0].data.match(/risu-illustration-request/g) ?? []))
            .toHaveLength(1)
    })

    test('returns the existing turn on a sequential registration replay', async () => {
        const first = await registerTrustedTurn(registerInput())
        harness.strictSave.mockClear()

        const replay = await registerTrustedTurn(registerInput())

        expect(replay).toEqual(first)
        expect(harness.strictSave).not.toHaveBeenCalled()
        expect((harness.database.characters[0].chats[0].message[0].data.match(/risu-illustration-request/g) ?? []))
            .toHaveLength(1)
    })

    // §20 feature flag OFF means capture is refused before any ledger/chat write.
    test('refuses registration while the feature is off', async () => {
        await setIllustrationFeatureEnabled(false)
        harness.storageEvents.length = 0

        await expect(registerTrustedTurn(registerInput()))
            .rejects.toBeInstanceOf(IllustrationFeatureDisabledError)
        expect(harness.storageEvents).toHaveLength(0)
        expect(harness.strictSave).not.toHaveBeenCalled()
        expect(mutationEvents).toHaveLength(0)
    })
})
