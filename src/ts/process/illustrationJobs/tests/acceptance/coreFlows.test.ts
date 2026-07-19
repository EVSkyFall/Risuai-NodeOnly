import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Chat } from '../../../../storage/database.svelte'
import { installImagePromptMeasurementTestService } from '../imagePromptTestHarness'
import { InMemoryLockManager } from '../inMemoryLockManager'
import {
    PRODUCTION_JOB_ID_RE,
    PRODUCTION_REQUEST_MARKER,
    PRODUCTION_REQUEST_NONCE_RE,
    PRODUCTION_SLOT_TOKEN_RE,
    PRODUCTION_SLOT_NODE,
} from './sharedFixtures'

const harness = vi.hoisted(() => ({
    storageMap: new Map<string, Uint8Array>(),
    database: null as any,
    provider: vi.fn(),
    writeInlay: vi.fn(),
    inspectInlay: vi.fn(),
    repairInlay: vi.fn(),
    strictSave: vi.fn(),
    strictSaveHook: null as (() => void | Promise<void>) | null,
    requestLlm: vi.fn(),
    integrity: new Set<string>(),
    finalCoordinatorReleaseWrites: 0,
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
            harness.storageMap.set(key, new Uint8Array(value))
            if (key === 'illustration:v1:coordinator') {
                const record = JSON.parse(new TextDecoder().decode(value))
                if (record.leaseId === null && record.draining === true) {
                    harness.finalCoordinatorReleaseWrites += 1
                }
            }
        },
        async removeItem(key: string) {
            harness.storageMap.delete(key)
        },
    },
}))

vi.mock('src/ts/parser/parser.svelte', () => ({
    hasher: vi.fn(async () => new Uint8Array(32)),
    // Satisfies the jsonSchema converter's import binding (pulled in transitively via
    // v3BridgeHost's host-boundary schema validation). Only the interface-form schema
    // branch invokes it, which these tests never exercise (all schemas are raw JSON).
    risuChatParser: (input: string) => input,
}))

vi.mock('src/ts/storage/database.svelte', () => ({
    // The host-boundary schema validator transitively loads util.ts -> stores.svelte,
    // whose module-update $effect reads the database and current chat/character at
    // import time (before beforeEach installs the real fixture). Fall back to a minimal
    // shape so that eager effect is a harmless no-op; installed fixtures win afterward.
    getDatabase: () => harness.database ?? ({ enabledModules: [] } as any),
    getCurrentChat: () => undefined,
    getCurrentCharacter: () => undefined,
}))

vi.mock('src/ts/storage/chatStorage', () => ({
    ensureChatHydrated: vi.fn(async (chats: Chat[], index: number) => chats[index] ?? null),
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

vi.mock('src/ts/process/request/request', () => ({
    requestChatDataMain: harness.requestLlm,
}))

const coordinatorModule = await import('../../coordinator')
const coordinatorRecordModule = await import('../../coordinatorRecord')
const capturePolicyModule = await import('../../capturePolicy')
const executorModule = await import('../../executor')
const featureModule = await import('../../featureFlag')
const lockModule = await import('../../locks')
const operationLockModule = await import('../../operationLock')
const storeModule = await import('../../store')
const terminalCaptureModule = await import('../../terminalCapture')
const v3BridgeModule = await import('../../v3Bridge')
const v3BridgeHostModule = await import('../../v3BridgeHost')

const { registerTrustedTurn } = coordinatorModule
const { getCoordinatorRecord } = coordinatorRecordModule
const { writeDurableCaptureMode } = capturePolicyModule
const {
    deriveIllustrationAssetId,
    pokeExecutor,
    resetIllustrationWorkerLockManagerAccessorForTests,
    setIllustrationWorkerLockManagerAccessorForTests,
    startIllustrationExecutor,
    stopIllustrationExecutor,
} = executorModule
const { setIllustrationFeatureEnabled } = featureModule
const {
    resetIllustrationLockManagerAccessorForTests,
    setIllustrationLockManagerAccessorForTests,
} = lockModule
const {
    resetIllustrationOperationLockManagerAccessorForTests,
    setIllustrationOperationLockManagerAccessorForTests,
} = operationLockModule
const { illustrationJobStore } = storeModule
const { finalizeIllustrationRootTurn } = terminalCaptureModule
const {
    ILLUSTRATION_V3_PROTECTED_PLUGIN_NAME,
    PINNED_ILLUSTRATION_PLUGIN_DIGESTS,
} = v3BridgeModule
const { createAuthorizedIllustrationV3HostBridge } = v3BridgeHostModule

type Bridge = ReturnType<typeof createAuthorizedIllustrationV3HostBridge>
type CoordinatorClaim = {
    protocolVersion: 1
    version: number
    fence: number
    expiresAt: number
    ownedByCaller: boolean
}
type JobSnapshot = {
    protocolVersion: 1
    turnId: string
    jobId: string
    slotOrdinal: number
    version: number
    state: string
    lease?: { expiresAt: number; fence: number; ownedByCaller: boolean }
    scenePayload?: unknown
    attemptId?: string
    assetId?: string
}

const AUTH = Object.freeze({
    pluginName: ILLUSTRATION_V3_PROTECTED_PLUGIN_NAME,
    scriptDigest: PINNED_ILLUSTRATION_PLUGIN_DIGESTS[0],
    apiVersion: '3.0' as const,
})

let lockManager: InMemoryLockManager
let runtimeSequence = 0
let bridges: Bridge[] = []
let restoreImagePromptMeasurement = () => {}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

function installDatabase(source: string) {
    const message = { role: 'char', chatId: 'message-1', data: source }
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
            newGenData: { negative: 'character-negative-sentinel' },
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

function createBridge(label: string): Bridge {
    const bridge = createAuthorizedIllustrationV3HostBridge(
        AUTH,
        `acceptance-${label}-${++runtimeSequence}`,
    )
    bridges.push(bridge)
    return bridge
}

async function claimCoordinator(bridge: Bridge, leaseId: string): Promise<CoordinatorClaim> {
    return await bridge.rootMethods._ijClaimCoordinator({
        protocolVersion: 1,
        leaseId,
    }) as CoordinatorClaim
}

function coordinatorProof(coordinator: CoordinatorClaim, leaseId: string) {
    return {
        protocolVersion: 1 as const,
        coordinatorLeaseId: leaseId,
        coordinatorFence: coordinator.fence,
    }
}

async function createPlannedTurn(input: {
    bridge: Bridge
    coordinator: CoordinatorClaim
    coordinatorLeaseId: string
    count: number
    source: string
    rootTurnId: string
}) {
    const target = installDatabase(input.source)
    const turn = await registerTrustedTurn({
        chaId: 'character-1',
        conversationId: 'conversation-1',
        expectedMessageId: 'message-1',
        rootTurnId: input.rootTurnId,
        sourceVariantText: input.source,
    })
    const pending = await input.bridge.rootMethods._ijListPendingTurns() as Array<{
        turnId: string
        version: number
        state: string
        sourceRevisionHash: string
    }>
    const pendingTurn = pending.find((candidate) => candidate.turnId === turn.turnId)
    if (!pendingTurn) throw new Error('registered turn was not visible through the bridge')
    const plannerLeaseId = `planner-${input.rootTurnId}`
    const claimed = await input.bridge.rootMethods._ijClaimTurn({
        ...coordinatorProof(input.coordinator, input.coordinatorLeaseId),
        turnId: turn.turnId,
        expectedVersion: pendingTurn.version,
        leaseId: plannerLeaseId,
    }) as {
        version: number
        lease: { fence: number; ownedByCaller: boolean }
    }
    const jobs = await input.bridge.rootMethods._ijSubmitPlan({
        ...coordinatorProof(input.coordinator, input.coordinatorLeaseId),
        turnId: turn.turnId,
        expectedVersion: claimed.version,
        leaseId: plannerLeaseId,
        fence: claimed.lease.fence,
        idempotencyKey: `plan:${turn.turnId}`,
        sourceRevisionHash: pendingTurn.sourceRevisionHash,
        slots: Array.from({ length: input.count }, (_, index) => ({
            sceneId: `scene-${index + 1}`,
            insertAfterUtf16: Math.floor(((index + 1) * input.source.length) / input.count),
            scenePayload: {
                schemaVersion: 1,
                data: { description: `scene ${index + 1}` },
            },
        })),
    }) as JobSnapshot[]
    return { ...target, turn, jobs }
}

async function claimJob(input: {
    bridge: Bridge
    coordinator: CoordinatorClaim
    coordinatorLeaseId: string
    job: JobSnapshot
    leaseId: string
}): Promise<JobSnapshot> {
    return await input.bridge.rootMethods._ijClaimJob({
        ...coordinatorProof(input.coordinator, input.coordinatorLeaseId),
        jobId: input.job.jobId,
        expectedVersion: input.job.version,
        leaseId: input.leaseId,
    }) as JobSnapshot
}

async function supplyPrompt(input: {
    bridge: Bridge
    coordinator: CoordinatorClaim
    coordinatorLeaseId: string
    claimed: JobSnapshot
    leaseId: string
    positive: string
    negative: string
}): Promise<JobSnapshot> {
    return await input.bridge.rootMethods._ijSupplyPrompt({
        ...coordinatorProof(input.coordinator, input.coordinatorLeaseId),
        jobId: input.claimed.jobId,
        expectedVersion: input.claimed.version,
        leaseId: input.leaseId,
        fence: input.claimed.lease!.fence,
        idempotencyKey: `prompt:${input.claimed.jobId}`,
        positive: input.positive,
        negative: input.negative,
    }) as JobSnapshot
}

async function queueAll(input: {
    bridge: Bridge
    coordinator: CoordinatorClaim
    coordinatorLeaseId: string
    jobs: JobSnapshot[]
}): Promise<JobSnapshot[]> {
    const queued: JobSnapshot[] = []
    for (const job of input.jobs) {
        const leaseId = `tagger-${job.slotOrdinal}`
        const claimed = await claimJob({ ...input, job, leaseId })
        queued.push(await supplyPrompt({
            ...input,
            claimed,
            leaseId,
            positive: `positive prompt ${job.slotOrdinal}`,
            negative: `negative prompt ${job.slotOrdinal}`,
        }))
    }
    return queued
}

beforeEach(async () => {
    harness.storageMap.clear()
    harness.integrity.clear()
    harness.provider.mockReset()
    harness.writeInlay.mockReset()
    harness.inspectInlay.mockReset()
    harness.repairInlay.mockReset()
    harness.strictSave.mockReset()
    harness.requestLlm.mockReset()
    harness.strictSaveHook = null
    harness.finalCoordinatorReleaseWrites = 0
    bridges = []
    installDatabase('Acceptance default source')
    restoreImagePromptMeasurement = installImagePromptMeasurementTestService(() => harness.database)
    lockManager = new InMemoryLockManager()
    setIllustrationLockManagerAccessorForTests(() => lockManager)
    setIllustrationOperationLockManagerAccessorForTests(() => lockManager)
    setIllustrationWorkerLockManagerAccessorForTests(() => lockManager)
    await setIllustrationFeatureEnabled(true)
    // The one finalizeIllustrationRootTurn (automatic-seam) flow in this suite needs
    // the durable policy on 'automatic'; the registerTrustedTurn-direct flows do not
    // enforce the mode, so this is a no-op for them.
    await writeDurableCaptureMode('automatic')
    harness.provider.mockResolvedValue({
        result: {
            ok: true,
            bytesOrDataUrl: 'data:image/png;base64,AA==',
            providerStatus: 200,
        },
        compatibilityValue: 'data:image/png;base64,AA==',
    })
    harness.writeInlay.mockImplementation(async (_image: unknown, options: { id: string }) => {
        harness.integrity.add(options.id)
        return options.id
    })
    harness.inspectInlay.mockImplementation(async (id: string) => ({
        status: harness.integrity.has(id) ? 'complete' : 'missing',
        hasAsset: harness.integrity.has(id),
        hasInfo: harness.integrity.has(id),
        hasMeta: harness.integrity.has(id),
    }))
    harness.repairInlay.mockResolvedValue(undefined)
    harness.strictSave.mockImplementation(async () => {
        await harness.strictSaveHook?.()
        return { success: true, durable: true }
    })
    harness.requestLlm.mockResolvedValue({ result: 'fake llm result' })
})

afterEach(async () => {
    restoreImagePromptMeasurement()
    await stopIllustrationExecutor()
    for (const bridge of bridges.reverse()) {
        await bridge.unload().catch(() => undefined)
    }
    resetIllustrationWorkerLockManagerAccessorForTests()
    resetIllustrationLockManagerAccessorForTests()
    resetIllustrationOperationLockManagerAccessorForTests()
})

describe('Gate 4d Core-side joint acceptance', () => {
    // §5 shared fixture / §20 oversized prompt: exact UTF-8 boundaries through _ijSupplyPrompt.
    test('accepts 16384 UTF-8 bytes and rejects 16385 for both prompt fields through the bridge', async () => {
        const bridge = createBridge('prompt-boundary')
        const coordinatorLeaseId = 'coordinator-prompt-boundary'
        const coordinator = await claimCoordinator(bridge, coordinatorLeaseId)
        const planned = await createPlannedTurn({
            bridge,
            coordinator,
            coordinatorLeaseId,
            count: 4,
            source: 'Prompt boundary source with four distinct scene locations',
            rootTurnId: 'root-prompt-boundary',
        })
        const claimed: JobSnapshot[] = []
        for (const job of planned.jobs) {
            claimed.push(await claimJob({
                bridge,
                coordinator,
                coordinatorLeaseId,
                job,
                leaseId: `boundary-${job.slotOrdinal}`,
            }))
        }
        const ascii16384 = 'a'.repeat(16_384)
        const utf8_16384 = 'é'.repeat(8_192)
        const ascii16385 = `${ascii16384}a`
        const utf8_16385 = `${utf8_16384}a`
        expect(new TextEncoder().encode(ascii16384)).toHaveLength(16_384)
        expect(new TextEncoder().encode(utf8_16384)).toHaveLength(16_384)
        expect(new TextEncoder().encode(ascii16385)).toHaveLength(16_385)
        expect(new TextEncoder().encode(utf8_16385)).toHaveLength(16_385)

        await expect(supplyPrompt({
            bridge,
            coordinator,
            coordinatorLeaseId,
            claimed: claimed[0],
            leaseId: 'boundary-0',
            positive: ascii16384,
            negative: '',
        })).resolves.toMatchObject({ state: 'queued' })
        await expect(supplyPrompt({
            bridge,
            coordinator,
            coordinatorLeaseId,
            claimed: claimed[1],
            leaseId: 'boundary-1',
            positive: 'p',
            negative: utf8_16384,
        })).resolves.toMatchObject({ state: 'queued' })
        await expect(supplyPrompt({
            bridge,
            coordinator,
            coordinatorLeaseId,
            claimed: claimed[2],
            leaseId: 'boundary-2',
            positive: ascii16385,
            negative: '',
        })).rejects.toThrow('[IJ:validation]')
        await expect(supplyPrompt({
            bridge,
            coordinator,
            coordinatorLeaseId,
            claimed: claimed[3],
            leaseId: 'boundary-3',
            positive: 'p',
            negative: utf8_16385,
        })).rejects.toThrow('[IJ:validation]')
        expect(harness.provider).not.toHaveBeenCalled()
    })

    // §5-4 / §20 crash-free drain: real bridge handoff, executor, inlay, strict commit.
    test('drains 15 bridge-created jobs exactly once and finalizes the parent live', async () => {
        const bridge = createBridge('happy-15')
        const coordinatorLeaseId = 'coordinator-happy-15'
        const coordinator = await claimCoordinator(bridge, coordinatorLeaseId)
        const source = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(4)
        const planned = await createPlannedTurn({
            bridge,
            coordinator,
            coordinatorLeaseId,
            count: 15,
            source,
            rootTurnId: 'root-happy-15',
        })
        expect(planned.turn.target?.requestNonce).toMatch(PRODUCTION_REQUEST_NONCE_RE)
        expect(planned.jobs).toHaveLength(15)
        expect(planned.jobs.map((job) => job.slotOrdinal)).toEqual(
            Array.from({ length: 15 }, (_, index) => index),
        )
        expect(planned.jobs.every((job) => PRODUCTION_JOB_ID_RE.test(job.jobId))).toBe(true)
        const rawProjected = await illustrationJobStore.listJobRecords({ turnId: planned.turn.turnId })
        expect(rawProjected.every((job) => PRODUCTION_SLOT_TOKEN_RE.test(job.slotToken))).toBe(true)

        await queueAll({ bridge, coordinator, coordinatorLeaseId, jobs: planned.jobs })
        harness.strictSave.mockClear()
        harness.provider.mockClear()
        harness.writeInlay.mockClear()
        let active = 0
        let maxActive = 0
        harness.provider.mockImplementation(async () => {
            active += 1
            maxActive = Math.max(maxActive, active)
            await Promise.resolve()
            active -= 1
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
        await pokeExecutor()

        const jobs = await illustrationJobStore.listJobRecords({ turnId: planned.turn.turnId })
        const bridgeJobs = await bridge.rootMethods._ijListJobs({
            turnId: planned.turn.turnId,
        }) as JobSnapshot[]
        expect(jobs).toHaveLength(15)
        expect(jobs.every((job) => job.state === 'committed')).toBe(true)
        expect(bridgeJobs).toHaveLength(15)
        expect(bridgeJobs.every((job) => job.state === 'committed')).toBe(true)
        expect((await illustrationJobStore.getTurn(planned.turn.turnId))?.state).toBe('completed')
        expect(harness.provider).toHaveBeenCalledTimes(15)
        expect(maxActive).toBe(1)
        expect(harness.writeInlay).toHaveBeenCalledTimes(15)
        expect(harness.strictSave).toHaveBeenCalledTimes(15)
        expect(planned.message.data.match(/\{\{inlay::asset:[^}]+\}\}/g)).toHaveLength(15)
        expect(planned.message.data).not.toContain('<!--risu-illustration-request:')
        expect(planned.message.data).not.toContain('<risu-illustration-slot')
    })

    // §5-1 / §20 Finalization: recursive exits do nothing; the final normal exit records once.
    test('records exactly one terminal root turn and records none for abort', async () => {
        const source = 'Terminal capture acceptance source'
        const { chat, message } = installDatabase(source)
        finalizeIllustrationRootTurn({ outcome: 'aborted', rootTurnId: 'root-terminal-abort' })
        finalizeIllustrationRootTurn({ outcome: 'continuing', rootTurnId: 'root-terminal-live' })
        finalizeIllustrationRootTurn({ outcome: 'continuing', rootTurnId: 'root-terminal-live' })
        await Promise.resolve()
        expect(await illustrationJobStore.listTurns()).toHaveLength(0)

        const normal = {
            outcome: 'normal' as const,
            chaId: 'character-1',
            chat: chat as Chat,
            message: message as any,
            rootTurnId: 'root-terminal-live',
        }
        finalizeIllustrationRootTurn(normal)
        finalizeIllustrationRootTurn(normal)
        await vi.waitFor(async () => {
            expect(await illustrationJobStore.listTurns()).toHaveLength(1)
        })
        finalizeIllustrationRootTurn(normal)
        await Promise.resolve()
        const turns = await illustrationJobStore.listTurns()
        expect(turns).toHaveLength(1)
        expect(turns[0].target?.rootTurnId).toBe('root-terminal-live')
        expect(harness.strictSave).toHaveBeenCalledTimes(1)
    })

    // §20 Manifest/API hygiene: copied production controls cannot forge a turn or job.
    test('strips copied production control nodes without creating forged jobs', async () => {
        const source = `before${PRODUCTION_REQUEST_MARKER}middle${PRODUCTION_SLOT_NODE}after`
        const { message } = installDatabase(source)

        const turn = await registerTrustedTurn({
            chaId: 'character-1',
            conversationId: 'conversation-1',
            expectedMessageId: 'message-1',
            rootTurnId: 'root-copied-controls',
            sourceVariantText: source,
        })

        expect(turn.sourceTextUtf16).toBe('beforemiddleafter')
        expect(await illustrationJobStore.listTurns()).toHaveLength(1)
        expect(await illustrationJobStore.listJobRecords({ turnId: turn.turnId })).toEqual([])
        expect(message.data).toContain(PRODUCTION_REQUEST_MARKER)
        expect(message.data).toContain(PRODUCTION_SLOT_NODE)
        expect(message.data.match(/<!--risu-illustration-request:v1:/g)).toHaveLength(2)
        expect(turn.target?.requestNonce).not.toBe('0123456789abcdef0123456789abcdef')
    })

    // §5-5 / §20 reload reconciliation: durable scenePayload resumes Tagger without Planning.
    test('reconciles durable jobs after actor reload without re-planning or duplication', async () => {
        let plannerInvocations = 0
        const first = createBridge('reload-first')
        const firstCoordinatorLease = 'coordinator-reload-first'
        const firstCoordinator = await claimCoordinator(first, firstCoordinatorLease)
        plannerInvocations += 1
        const planned = await createPlannedTurn({
            bridge: first,
            coordinator: firstCoordinator,
            coordinatorLeaseId: firstCoordinatorLease,
            count: 3,
            source: 'Reload reconciliation source with three durable scene payloads',
            rootTurnId: 'root-reload',
        })
        await first.unload()

        const second = createBridge('reload-second')
        const secondCoordinatorLease = 'coordinator-reload-second'
        const secondCoordinator = await claimCoordinator(second, secondCoordinatorLease)
        expect(await second.rootMethods._ijListPendingTurns()).toEqual([])
        const reloadedJobs = await second.rootMethods._ijListJobs({
            turnId: planned.turn.turnId,
        }) as JobSnapshot[]
        expect(reloadedJobs).toHaveLength(3)
        expect(reloadedJobs.every((job) => job.state === 'awaiting_prompt')).toBe(true)
        expect(reloadedJobs.every((job) => job.scenePayload !== undefined)).toBe(true)
        await queueAll({
            bridge: second,
            coordinator: secondCoordinator,
            coordinatorLeaseId: secondCoordinatorLease,
            jobs: reloadedJobs,
        })

        expect(plannerInvocations).toBe(1)
        expect(await illustrationJobStore.listJobRecords({ turnId: planned.turn.turnId }))
            .toHaveLength(3)
        expect((await illustrationJobStore.getTurn(planned.turn.turnId))?.state)
            .toBe('awaiting_prompt')
        expect(harness.provider).not.toHaveBeenCalled()
    })

    // §5-7/8 / §20 feature OFF: in-flight host LLM detaches, new cost work rejects,
    // and stale coordinator ACKs remain proof-gated after final release.
    test('converges feature OFF against an in-flight host LLM and releases once', async () => {
        const bridge = createBridge('feature-drain')
        const coordinatorLeaseId = 'coordinator-feature-drain'
        const coordinator = await claimCoordinator(bridge, coordinatorLeaseId)
        const planned = await createPlannedTurn({
            bridge,
            coordinator,
            coordinatorLeaseId,
            count: 1,
            source: 'Feature drain source with a pending Tagger job',
            rootTurnId: 'root-feature-drain',
        })
        const taggerLeaseId = 'tagger-feature-drain'
        const claimed = await claimJob({
            bridge,
            coordinator,
            coordinatorLeaseId,
            job: planned.jobs[0],
            leaseId: taggerLeaseId,
        })
        const provider = deferred<unknown>()
        const providerStarted = deferred<void>()
        harness.requestLlm.mockImplementationOnce(async () => {
            providerStarted.resolve()
            return await provider.promise
        })
        const running = bridge.runLLMModel({ mode: 'model', messages: [] })
        await providerStarted.promise
        expect(harness.requestLlm).toHaveBeenCalledWith(
            expect.objectContaining({
                formated: [],
                bias: {},
                blockPlugins: true,
                useStreaming: false,
                noMultiGen: true,
                hostOmitCallerGenerationCap: true,
            }),
            'model',
            expect.any(AbortSignal),
        )
        harness.finalCoordinatorReleaseWrites = 0

        await expect(bridge.rootMethods._ijSetFeatureEnabled({
            protocolVersion: 1,
            enabled: false,
        })).resolves.toEqual({ featureEnabled: false })
        expect(await getCoordinatorRecord()).toMatchObject({ draining: true })
        await expect(running).rejects.toThrow('[IJ:unavailable]')
        expect(await getCoordinatorRecord()).toMatchObject({ leaseId: null, draining: true })
        expect(harness.finalCoordinatorReleaseWrites).toBe(1)
        await expect(bridge.rootMethods._ijClaimCoordinator({
            protocolVersion: 1,
            leaseId: 'late-claim',
        })).rejects.toThrow('[IJ:feature_disabled]')
        await expect(bridge.runLLMModel({ mode: 'model', messages: [] }))
            .rejects.toThrow('[IJ:feature_disabled]')
        await expect(bridge.rootMethods._ijReportAgentFailure({
            ...coordinatorProof(coordinator, coordinatorLeaseId),
            kind: 'job',
            id: claimed.jobId,
            expectedVersion: claimed.version,
            leaseId: taggerLeaseId,
            fence: claimed.lease!.fence,
            idempotencyKey: 'failure:feature-drain',
            code: 'tagger_failed_after_off',
            retryable: true,
        })).rejects.toThrow('[IJ:coordinator_required]')

        provider.resolve({ result: 'late fake completion' })
        await Promise.resolve()
        expect(await getCoordinatorRecord()).toMatchObject({ leaseId: null, draining: true })
        expect(harness.finalCoordinatorReleaseWrites).toBe(1)
        expect(harness.requestLlm).toHaveBeenCalledTimes(1)
    })

    // §5-10 / §20 source edit: one committed job is the provider-call high-water mark.
    test('stales every remaining sibling after a mid-batch body edit with no further provider calls', async () => {
        const bridge = createBridge('mid-edit')
        const coordinatorLeaseId = 'coordinator-mid-edit'
        const coordinator = await claimCoordinator(bridge, coordinatorLeaseId)
        const planned = await createPlannedTurn({
            bridge,
            coordinator,
            coordinatorLeaseId,
            count: 3,
            source: 'Editable prefix and enough remaining text for three scene anchors',
            rootTurnId: 'root-mid-edit',
        })
        await queueAll({ bridge, coordinator, coordinatorLeaseId, jobs: planned.jobs })
        harness.provider.mockClear()
        harness.strictSave.mockClear()
        let commitFlushes = 0
        harness.strictSaveHook = () => {
            commitFlushes += 1
            if (commitFlushes === 1) {
                planned.message.data = planned.message.data.replace('Editable', 'Modified')
            }
        }

        await startIllustrationExecutor()
        await pokeExecutor()

        const jobs = await illustrationJobStore.listJobRecords({ turnId: planned.turn.turnId })
        expect(jobs.filter((job) => job.state === 'committed')).toHaveLength(1)
        expect(jobs.filter((job) => job.state === 'stale')).toHaveLength(2)
        expect(harness.provider).toHaveBeenCalledTimes(1)
        expect((await illustrationJobStore.getTurn(planned.turn.turnId))?.state).toBe('completed')
    })

    // §5-10 / §20 slot deletion: pre-dispatch deletion makes provider calls exactly zero.
    test('stales a deleted slot before dispatch with zero provider calls', async () => {
        const bridge = createBridge('slot-delete')
        const coordinatorLeaseId = 'coordinator-slot-delete'
        const coordinator = await claimCoordinator(bridge, coordinatorLeaseId)
        const planned = await createPlannedTurn({
            bridge,
            coordinator,
            coordinatorLeaseId,
            count: 1,
            source: 'Slot deletion acceptance source',
            rootTurnId: 'root-slot-delete',
        })
        await queueAll({ bridge, coordinator, coordinatorLeaseId, jobs: planned.jobs })
        harness.provider.mockClear()
        planned.message.data = planned.message.data.replace(
            /<risu-illustration-slot[\s\S]*?<\/risu-illustration-slot>/,
            '',
        )

        await startIllustrationExecutor()
        await pokeExecutor()

        expect(harness.provider).not.toHaveBeenCalled()
        expect((await illustrationJobStore.getJob(planned.jobs[0].jobId))?.state).toBe('stale')
        expect((await illustrationJobStore.getTurn(planned.turn.turnId))?.state).toBe('stale')
    })

    // §5-11 / §20 uncertain retry: socket reset never auto-retries and confirmation buys once.
    test('holds a socket reset uncertain until one confirmed retry with a fresh deterministic asset', async () => {
        const bridge = createBridge('uncertain-retry')
        const coordinatorLeaseId = 'coordinator-uncertain-retry'
        const coordinator = await claimCoordinator(bridge, coordinatorLeaseId)
        const planned = await createPlannedTurn({
            bridge,
            coordinator,
            coordinatorLeaseId,
            count: 1,
            source: 'Uncertain transport acceptance source',
            rootTurnId: 'root-uncertain-retry',
        })
        await queueAll({ bridge, coordinator, coordinatorLeaseId, jobs: planned.jobs })
        harness.provider.mockClear()
        harness.provider.mockResolvedValueOnce({
            result: {
                ok: false,
                certainty: 'uncertain',
                reason: 'socket_reset',
            },
            compatibilityValue: false,
        })

        await startIllustrationExecutor()
        await pokeExecutor()
        await pokeExecutor()
        const uncertain = (await illustrationJobStore.getJob(planned.jobs[0].jobId))!
        expect(uncertain.state).toBe('uncertain')
        expect(harness.provider).toHaveBeenCalledTimes(1)
        await stopIllustrationExecutor()

        const retried = await bridge.rootMethods._ijRetryUncertain({
            protocolVersion: 1,
            jobId: uncertain.jobId,
            expectedVersion: uncertain.version,
            confirmNewCharge: true,
        }) as JobSnapshot
        expect(retried.attemptId).not.toBe(uncertain.attemptId)
        expect(retried.assetId).not.toBe(uncertain.assetId)
        const placeholderAssetId = retried.assetId
        await startIllustrationExecutor()
        await pokeExecutor()

        const committed = (await illustrationJobStore.getJob(uncertain.jobId))!
        expect(committed.state).toBe('committed')
        expect(committed.attemptId).toBe(retried.attemptId)
        expect(committed.assetId).toBe(
            await deriveIllustrationAssetId(committed.jobId, committed.attemptId!),
        )
        expect(committed.assetId).not.toBe(placeholderAssetId)
        expect(harness.provider).toHaveBeenCalledTimes(2)
    })
})

describe('authorized illustration host LLM single generation and structured output', () => {
    async function readyBridge(label: string): Promise<Bridge> {
        const bridge = createBridge(label)
        await claimCoordinator(bridge, `coordinator-${label}`)
        return bridge
    }

    // §5-1 / §4.1 + §4.2: the host forces noMultiGen and forwards a validated schema
    // string verbatim into requestChatDataMain, and returns the single success shape.
    test('forwards noMultiGen:true and the validated schema into requestChatDataMain', async () => {
        const bridge = await readyBridge('llm-passthrough')
        let capturedArg: Record<string, unknown> | undefined
        harness.requestLlm.mockImplementationOnce(async (arg: Record<string, unknown>) => {
            capturedArg = arg
            return { type: 'success', result: '{"foo":"bar"}' }
        })
        const schema = '{"type":"object","properties":{"foo":{"type":"string"}},"required":["foo"]}'
        await expect(bridge.runLLMModel({ mode: 'model', messages: [], schema }))
            .resolves.toEqual({ type: 'success', result: '{"foo":"bar"}' })
        expect(capturedArg?.noMultiGen).toBe(true)
        expect(capturedArg?.schema).toBe(schema)
        expect(harness.requestLlm).toHaveBeenCalledTimes(1)
    })

    // E-1 (Sol #19): the host must pin extractJson to '' so a user's global
    // db.extractJson never post-processes (and can destroy) the structured-output
    // response text. '' is non-nullish (wins request.ts's `?? db.extractJson`) yet
    // falsy at the provider extract guards → no extraction.
    test('pins extractJson to empty so db.extractJson cannot post-process the response', async () => {
        const bridge = await readyBridge('llm-extractjson-pin')
        harness.database.extractJson = 'foo.bar'
        let capturedArg: Record<string, unknown> | undefined
        harness.requestLlm.mockImplementationOnce(async (arg: Record<string, unknown>) => {
            capturedArg = arg
            return { type: 'success', result: '{"foo":"bar"}' }
        })
        await expect(bridge.runLLMModel({ mode: 'model', messages: [] }))
            .resolves.toEqual({ type: 'success', result: '{"foo":"bar"}' })
        expect(capturedArg?.extractJson).toBe('')
    })

    // §5-3: a real multi-generation tuple fails closed with a stable validation code;
    // the ['char', ...] role strings and scene payloads never leak into the outcome.
    test('fails closed on a real multiline tuple without leaking role strings', async () => {
        const bridge = await readyBridge('llm-multiline')
        harness.requestLlm.mockResolvedValueOnce({
            type: 'multiline',
            result: [['char', '{"scene":1}'], ['char', '{"scene":2}']],
        })
        const call = bridge.runLLMModel({ mode: 'model', messages: [] })
        await expect(call).rejects.toThrow('[IJ:validation]')
        const leak = await call.then(() => '', (error) => `${String(error)} ${String((error as { message?: unknown }).message ?? '')}`)
        expect(leak).not.toContain('char')
        expect(leak).not.toContain('scene')
    })

    // §5-4: a malformed multiline tuple is also fail-closed with the same stable code.
    test('fails closed on a malformed multiline tuple', async () => {
        const bridge = await readyBridge('llm-multiline-malformed')
        harness.requestLlm.mockResolvedValueOnce({
            type: 'multiline',
            result: [['char']],
        })
        await expect(bridge.runLLMModel({ mode: 'model', messages: [] }))
            .rejects.toThrow('[IJ:validation]')
    })

    // §5-8: malformed, oversized, and non-string schemas are rejected at the host
    // boundary before any provider call — requestChatDataMain is never reached, so the
    // core never fabricates a follow-up LLM request.
    test('rejects a malformed schema before dispatching to the provider', async () => {
        const bridge = await readyBridge('llm-bad-schema')
        await expect(bridge.runLLMModel({ mode: 'model', messages: [], schema: '{ not valid json' }))
            .rejects.toThrow('[IJ:validation]')
        expect(harness.requestLlm).not.toHaveBeenCalled()
    })

    test('rejects an oversized schema before dispatching to the provider', async () => {
        const bridge = await readyBridge('llm-big-schema')
        const oversized = `{"type":"object","x":"${'a'.repeat(32 * 1024)}"}`
        await expect(bridge.runLLMModel({ mode: 'model', messages: [], schema: oversized }))
            .rejects.toThrow('[IJ:validation]')
        expect(harness.requestLlm).not.toHaveBeenCalled()
    })

    test('rejects a non-string schema before dispatching to the provider', async () => {
        const bridge = await readyBridge('llm-nonstring-schema')
        await expect(bridge.runLLMModel({ mode: 'model', messages: [], schema: { type: 'object' } }))
            .rejects.toThrow('[IJ:validation]')
        expect(harness.requestLlm).not.toHaveBeenCalled()
    })

    // §5-8 regression: a primitive/null-valued schema string is JSON-parseable, so the
    // bare convertInterfaceToSchema accepts it without throwing — but the Gemini/Vertex
    // builder (getGeneralJSONSchema) walks the parsed value with Object.keys, and
    // Object.keys(null) throws a TypeError. Since the resolved provider is not known at
    // the host boundary, acceptance must exercise the same full converter so these
    // payloads fail closed with the stable [IJ:validation] code before any provider
    // dispatch, instead of leaking an unmapped TypeError from inside the request builder.
    test.each([
        ['a top-level null schema', 'null'],
        ['a nested-null schema', '{"foo":null}'],
    ] as const)('rejects %s that breaks the Gemini converter before dispatching', async (_label, schema) => {
        const bridge = await readyBridge(`llm-primitive-schema-${schema.length}`)
        await expect(bridge.runLLMModel({ mode: 'model', messages: [], schema }))
            .rejects.toThrow('[IJ:validation]')
        expect(harness.requestLlm).not.toHaveBeenCalled()
    })

    // E-2 (Sol #20): a schema string whose root parses to a primitive or an array
    // does NOT throw in getGeneralJSONSchema ("42" → 42, "[]" → []), so it slips the
    // pre-fix "doesn't throw" gate and reaches the provider as a structured-output
    // request the provider cannot honor. Structured output requires an object root;
    // reject non-object roots at the host boundary before any provider call.
    test.each([
        ['a numeric-primitive root', '42'],
        ['an array root', '[]'],
        ['a string-primitive root', '"hello"'],
    ] as const)('rejects %s schema before dispatching to the provider', async (_label, schema) => {
        const bridge = await readyBridge(`llm-nonobject-schema-${schema.length}-${schema.charCodeAt(0)}`)
        await expect(bridge.runLLMModel({ mode: 'model', messages: [], schema }))
            .rejects.toThrow('[IJ:validation]')
        expect(harness.requestLlm).not.toHaveBeenCalled()
    })
})
