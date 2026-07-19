import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Chat } from '../../../storage/database.svelte'
import { installImagePromptMeasurementTestService } from './imagePromptTestHarness'
import { InMemoryLockManager } from './inMemoryLockManager'
import type { IllustrationPromptEnvelopeV2 } from '../promptEnvelopeV2'

// ---------------------------------------------------------------------------
// Slice F: provider-neutral Prompt Target V2 supply + executor dispatch (§D1-D5).
// Red-first coverage: V1-untouched structural regression, exact-wire-body V2 dispatch
// through the broker + serializer, dispatch-time fingerprint drift, receipt-rebind and
// live-checkpoint-probe failures (all provider-call-0), cross-mode supply rejection,
// dispatch-eligibility, D4 all-null transport_only rejection, and D5 recovery identity.
// ---------------------------------------------------------------------------

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
const lockModule = await import('../locks')
const operationLockModule = await import('../operationLock')
const storeModule = await import('../store')
const brokerModule = await import('../transportBroker')
const promptContextModule = await import('../promptContextV2')

const {
    preparePromptContext,
    registerTrustedTurn,
    setTransportConfig,
    submitPlanLedger,
    supplyPromptEnvelope,
    supplyPromptLedger,
} = coordinatorModule
const { claimCoordinator } = coordinatorRecordModule
const {
    ILLUSTRATION_BLOCKED_LIVE_PROBE_MIN_INTERVAL_MS,
    pokeExecutor,
    resetIllustrationBlockedProbeBackoffForTests,
    resetIllustrationV2TransportFetchersForTests,
    resetIllustrationWorkerLockManagerAccessorForTests,
    setIllustrationV2TransportFetchersForTests,
    setIllustrationWorkerLockManagerAccessorForTests,
    startIllustrationExecutor,
    stopIllustrationExecutor,
} = executorModule
const { setIllustrationFeatureEnabled } = featureModule
const { resetIllustrationLockManagerAccessorForTests, setIllustrationLockManagerAccessorForTests } = lockModule
const {
    resetIllustrationOperationLockManagerAccessorForTests,
    setIllustrationOperationLockManagerAccessorForTests,
} = operationLockModule
const { illustrationJobKey, illustrationJobStore } = storeModule
const { illustrationTransportBroker } = brokerModule
const {
    deriveWebuiCheckpointFingerprint,
    parseTransportConfig,
    resetWebuiCheckpointProbeForTests,
    setWebuiCheckpointProbeForTests,
} = promptContextModule

const BASE_TIME = Date.UTC(2026, 0, 3)
let lockManager: InMemoryLockManager
let coordinatorProof: { coordinatorLeaseId: string; coordinatorFence: number }
let restoreImagePromptMeasurement = () => {}

const REFS = {
    tagProfile: { id: 'sdxl-illustrious', revision: '1' },
    profileConfigRevision: 'cfg-1',
    assetCatalogDigest: 'cat-1',
}

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

function installDatabase(provider: 'novelai' | 'webui', source = 'V2 source') {
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
            newGenData: { negative: 'char-negative' },
            chats: [chat],
            chatPage: 0,
        }],
        sdProvider: provider,
        // NAI fields (novelai-native + fingerprint capture).
        NAIImgUrl: 'https://image.novelai.net/ai/generate-image',
        NAIImgModel: 'nai-diffusion-4-5-full',
        NAIApiKey: 'nai-key',
        NAII2I: false,
        NAIImgConfig: {},
        // WebUI fields.
        webUiUrl: 'http://127.0.0.1:7860/',
        sdSteps: 28,
        sdCFG: 5,
        sdConfig: {
            width: 832,
            height: 1216,
            sampler_name: 'Euler a',
            enable_hr: false,
            denoising_strength: 0.5,
            hr_scale: 2,
            hr_upscaler: 'Latent',
        },
        comfyUiUrl: 'http://127.0.0.1:8188',
        comfyConfig: { workflow: '{}', timeout: 30 },
        inlayImageLossless: true,
    }
    return { chat, message, source }
}

const webuiRequestPinnedElection = {
    transportId: 'webui-flat' as const,
    binding: { mode: 'request-pinned' as const, checkpoint: 'sdxl_illustrious_v01.safetensors' },
    measurement: {
        mode: 'transport_only' as const,
        unit: 'utf8_byte' as const,
        positive: 10_000,
        negative: 10_000,
        combined: null,
        allowTransportOnly: true as const,
    },
    maxConcurrency: 2,
    priorityPolicy: 'interactive-first' as const,
}

function webuiEnvelope(overrides: Partial<IllustrationPromptEnvelopeV2> = {}): IllustrationPromptEnvelopeV2 {
    return {
        schemaVersion: 2,
        tagProfileId: REFS.tagProfile.id,
        tagProfileRevision: REFS.tagProfile.revision,
        profileConfigRevision: REFS.profileConfigRevision,
        assetCatalogDigest: REFS.assetCatalogDigest,
        layout: 'flat',
        basePositive: 'masterpiece, best quality, 1girl, silver hair',
        subjectPositives: [],
        baseNegative: 'lowres, bad anatomy',
        subjectNegatives: [],
        ...overrides,
    }
}

// Drive one background pass of the executor without keeping a live poller running.
async function runExecutorOnce(): Promise<void> {
    await startIllustrationExecutor()
    await pokeExecutor()
    await stopIllustrationExecutor()
}

async function registerAndPlan(source: string): Promise<{ turnId: string; jobId: string; jobVersion: number }> {
    // The captured variant must match the live chat message data.
    harness.database.characters[0].chats[0].message[0].data = source
    const turn = await registerTrustedTurn({
        chaId: 'character-1',
        conversationId: 'conversation-1',
        expectedMessageId: 'message-1',
        rootTurnId: `root-${source}`,
        sourceVariantText: source,
    })
    const claimedTurn = await illustrationJobStore.claimTurn({
        ...coordinatorProof,
        turnId: turn!.turnId,
        expectedVersion: turn!.version,
        leaseId: 'planner',
    })
    const [projected] = await submitPlanLedger({
        ...coordinatorProof,
        turnId: turn!.turnId,
        expectedVersion: claimedTurn.version,
        leaseId: 'planner',
        fence: claimedTurn.fence,
        idempotencyKey: `plan:${turn!.turnId}`,
        sourceRevisionHash: turn!.sourceRevisionHash!,
        slots: [{
            sceneId: 'scene-1',
            insertAfterUtf16: source.length,
            scenePayload: { schemaVersion: 1, data: { description: 'scene' } },
        }],
    })
    return { turnId: turn!.turnId, jobId: projected.jobId, jobVersion: projected.version }
}

async function prepareAndSupplyV2(
    election: unknown,
    envelope: IllustrationPromptEnvelopeV2,
    source = 'V2 webui source',
): Promise<{ turnId: string; jobId: string }> {
    await setTransportConfig({ schemaVersion: 1, election })
    const { turnId, jobId, jobVersion } = await registerAndPlan(source)
    const turnNow = await illustrationJobStore.getTurn(turnId)
    await preparePromptContext({ turnId, expectedVersion: turnNow!.version, ...REFS })
    const claimedJob = await illustrationJobStore.claimJob({
        ...coordinatorProof,
        jobId,
        expectedVersion: jobVersion,
        leaseId: 'tagger',
    })
    await supplyPromptEnvelope({
        ...coordinatorProof,
        jobId,
        expectedVersion: claimedJob.version,
        leaseId: 'tagger',
        fence: claimedJob.fence,
        idempotencyKey: `env:${jobId}`,
        envelope,
    })
    return { turnId, jobId }
}

async function supplyV1Prompt(source: string): Promise<{ jobId: string }> {
    const { jobId, jobVersion } = await registerAndPlan(source)
    const claimedJob = await illustrationJobStore.claimJob({
        ...coordinatorProof,
        jobId,
        expectedVersion: jobVersion,
        leaseId: 'tagger',
    })
    await supplyPromptLedger({
        ...coordinatorProof,
        jobId,
        expectedVersion: claimedJob.version,
        leaseId: 'tagger',
        fence: claimedJob.fence,
        idempotencyKey: `prompt:${jobId}`,
        positive: 'v1 positive prompt',
        negative: '',
    })
    return { jobId }
}

function decodeJob(jobId: string): any {
    const value = harness.storageMap.get(illustrationJobKey(jobId))
    return value ? JSON.parse(new TextDecoder().decode(value)) : null
}

function makeCapturingWebuiFetch() {
    const calls: Array<{ url: string; body: any }> = []
    const fetchImpl = vi.fn(async (url: string, arg: any) => {
        calls.push({ url, body: arg.body })
        return { ok: true, data: { images: ['QQ=='] }, headers: {}, status: 200 }
    })
    return {
        calls,
        fetchers: {
            fetchImpl: fetchImpl as any,
            rawFetchImpl: (async () => { throw new Error('rawFetch unused') }) as any,
            nativeFetchImpl: (async () => { throw new Error('nativeFetch unused') }) as any,
        },
    }
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
    installDatabase('novelai')
    restoreImagePromptMeasurement = installImagePromptMeasurementTestService(() => harness.database)
    lockManager = new InMemoryLockManager()
    setIllustrationLockManagerAccessorForTests(() => lockManager)
    setIllustrationOperationLockManagerAccessorForTests(() => lockManager)
    setIllustrationWorkerLockManagerAccessorForTests(() => lockManager)
    resetIllustrationV2TransportFetchersForTests()
    resetWebuiCheckpointProbeForTests()
    resetIllustrationBlockedProbeBackoffForTests()
    await setIllustrationFeatureEnabled(true)
    await refreshCoordinatorProof()
    harness.provider.mockImplementation(async () => ({
        result: { ok: true, bytesOrDataUrl: 'data:image/png;base64,AA==', providerStatus: 200 },
        compatibilityValue: 'data:image/png;base64,AA==',
    }))
    harness.writeInlay.mockImplementation(async (_image: unknown, options: { id: string }) => {
        harness.integrity.set(options.id, 'complete')
        return options.id
    })
    harness.inspectInlay.mockImplementation(async (id: string) => {
        const status = harness.integrity.get(id) ?? 'missing'
        return { status, hasAsset: status !== 'missing', hasInfo: status === 'complete', hasMeta: status === 'complete' }
    })
    harness.repairInlay.mockImplementation(async (id: string) => { harness.integrity.set(id, 'complete') })
    harness.strictSave.mockImplementation(async () => ({ success: true, durable: true }))
})

afterEach(async () => {
    restoreImagePromptMeasurement()
    await stopIllustrationExecutor()
    resetIllustrationV2TransportFetchersForTests()
    resetWebuiCheckpointProbeForTests()
    resetIllustrationBlockedProbeBackoffForTests()
    resetIllustrationWorkerLockManagerAccessorForTests()
    resetIllustrationLockManagerAccessorForTests()
    resetIllustrationOperationLockManagerAccessorForTests()
    // The durable transport election lives in storageMap, which beforeEach clears; no
    // separate cleanup is needed (and the lock accessors are already reset here).
    vi.useRealTimers()
})

describe('executor V1-untouched structural regression (request §D2)', () => {
    test('a V1 job never touches the provider-wide transport broker', async () => {
        const acquireSpy = vi.spyOn(illustrationTransportBroker, 'acquire')
        const { jobId } = await supplyV1Prompt('V1 structural source')

        await runExecutorOnce()

        expect((await illustrationJobStore.getJob(jobId))?.state).toBe('committed')
        // The byte-identical V1 (NAI genesis) path went through generateAIImageTyped and
        // NEVER acquired a V2 broker slot / touched the V2 serializer.
        expect(harness.provider).toHaveBeenCalledTimes(1)
        expect(acquireSpy).not.toHaveBeenCalled()
        acquireSpy.mockRestore()
    })
})

describe('webui-flat V2 dispatch through broker + serializer (request §D2/§7.3/§8)', () => {
    test('dispatches the EXACT serialized wire body and commits', async () => {
        installDatabase('webui')
        const acquireSpy = vi.spyOn(illustrationTransportBroker, 'acquire')
        const capture = makeCapturingWebuiFetch()
        setIllustrationV2TransportFetchersForTests(capture.fetchers)

        const { jobId } = await prepareAndSupplyV2(webuiRequestPinnedElection, webuiEnvelope())

        await runExecutorOnce()

        expect((await illustrationJobStore.getJob(jobId))?.state).toBe('committed')
        expect(harness.provider).not.toHaveBeenCalled() // NAI native path unused for webui
        expect(acquireSpy).toHaveBeenCalledTimes(1)
        expect(acquireSpy.mock.calls[0][0]).toBe('webui-flat:http://127.0.0.1:7860/')
        expect(capture.calls).toHaveLength(1)
        expect(capture.calls[0].url).toBe('http://127.0.0.1:7860/sdapi/v1/txt2img')
        // EXACT opaque text, code-unit-for-code-unit, no NAI bracket remap / trim.
        expect(capture.calls[0].body.prompt).toBe('masterpiece, best quality, 1girl, silver hair')
        expect(capture.calls[0].body.negative_prompt).toBe('lowres, bad anatomy')
        // request-pinned checkpoint is pinned via override_settings.
        expect(capture.calls[0].body.override_settings.sd_model_checkpoint)
            .toBe('sdxl_illustrious_v01.safetensors')
        acquireSpy.mockRestore()
    })

    test('a captured pipe/subject envelope is rejected against a flat webui target before any dispatch', async () => {
        installDatabase('webui')
        await setTransportConfig({ schemaVersion: 1, election: webuiRequestPinnedElection })
        const { turnId, jobId, jobVersion } = await registerAndPlan('webui reject source')
        const turnNow = await illustrationJobStore.getTurn(turnId)
        await preparePromptContext({ turnId, expectedVersion: turnNow!.version, ...REFS })
        const claimedJob = await illustrationJobStore.claimJob({
            ...coordinatorProof,
            jobId,
            expectedVersion: jobVersion,
            leaseId: 'tagger',
        })
        // A flat webui target accepts at most 0 subjects; a subject-bearing envelope must
        // be rejected at supply (no queue, no LLM, no provider).
        await expect(supplyPromptEnvelope({
            ...coordinatorProof,
            jobId,
            expectedVersion: claimedJob.version,
            leaseId: 'tagger',
            fence: claimedJob.fence,
            idempotencyKey: `env:${jobId}`,
            envelope: webuiEnvelope({ subjectPositives: ['extra'], subjectNegatives: [''] }),
        })).rejects.toBeTruthy()
        expect(decodeJob(jobId)?.state).toBe('awaiting_prompt')
    })
})

describe('dispatch-time drift + rebind + probe are provider-call-0 (request §D2/§D3)', () => {
    test('fingerprint drift at dispatch blocks config without dispatching', async () => {
        installDatabase('webui')
        const capture = makeCapturingWebuiFetch()
        setIllustrationV2TransportFetchersForTests(capture.fetchers)
        const { jobId } = await prepareAndSupplyV2(webuiRequestPinnedElection, webuiEnvelope())

        // The user changes the webui endpoint after capture -> the re-resolved target
        // fingerprint no longer matches.
        harness.database.webUiUrl = 'http://127.0.0.1:9999/'

        await runExecutorOnce()

        const job = await illustrationJobStore.getJob(jobId)
        expect(job?.state).toBe('blocked_config')
        expect(job?.error?.code).toBe('prompt_target_fingerprint_mismatch')
        expect(capture.calls).toHaveLength(0)
    })

    test('a job blocked on target drift re-queues + dispatches once the target is restored', async () => {
        installDatabase('webui')
        const capture = makeCapturingWebuiFetch()
        setIllustrationV2TransportFetchersForTests(capture.fetchers)
        const { jobId } = await prepareAndSupplyV2(webuiRequestPinnedElection, webuiEnvelope())

        // Drift -> blocked_config, provider-call-0.
        harness.database.webUiUrl = 'http://127.0.0.1:9999/'
        await runExecutorOnce()
        expect((await illustrationJobStore.getJob(jobId))?.state).toBe('blocked_config')
        expect(capture.calls).toHaveLength(0)

        // Restore the captured endpoint -> the blocked job re-queues and dispatches.
        harness.database.webUiUrl = 'http://127.0.0.1:7860/'
        await runExecutorOnce()
        expect((await illustrationJobStore.getJob(jobId))?.state).toBe('committed')
        expect(capture.calls).toHaveLength(1)
        expect(capture.calls[0].body.prompt).toBe('masterpiece, best quality, 1girl, silver hair')
    })

    test('a receipt whose binding no longer matches at dispatch fails without dispatching', async () => {
        installDatabase('webui')
        const capture = makeCapturingWebuiFetch()
        setIllustrationV2TransportFetchersForTests(capture.fetchers)
        const { jobId } = await prepareAndSupplyV2(webuiRequestPinnedElection, webuiEnvelope())

        // Tamper the durable receipt so its envelope binding is stale (defense-in-depth
        // check the executor re-runs before any provider call).
        const record = decodeJob(jobId)
        record.promptReceipt.envelopeHash = 'tampered-envelope-hash'
        harness.storageMap.set(illustrationJobKey(jobId), new TextEncoder().encode(JSON.stringify(record)))

        await runExecutorOnce()

        const job = await illustrationJobStore.getJob(jobId)
        expect(job?.state).toBe('failed')
        expect(job?.error?.code).toBe('prompt_receipt_binding_mismatch')
        expect(capture.calls).toHaveLength(0)
    })

    test('a live webui checkpoint probe mismatch at dispatch blocks config without dispatching', async () => {
        installDatabase('webui')
        const fpA = await deriveWebuiCheckpointFingerprint('ckptA')
        const probeElection = {
            ...webuiRequestPinnedElection,
            binding: { mode: 'probe-and-revalidate' as const, checkpointFingerprint: fpA },
        }
        // At CAPTURE the live checkpoint matches; the prepared context binds fpA.
        setWebuiCheckpointProbeForTests(async () => 'ckptA')
        const capture = makeCapturingWebuiFetch()
        setIllustrationV2TransportFetchersForTests(capture.fetchers)
        const { jobId } = await prepareAndSupplyV2(probeElection, webuiEnvelope())

        // The backend swaps its loaded checkpoint before dispatch -> live identity drifts.
        setWebuiCheckpointProbeForTests(async () => 'ckptB')

        await runExecutorOnce()

        const job = await illustrationJobStore.getJob(jobId)
        expect(job?.state).toBe('blocked_config')
        expect(job?.error?.code).toBe('prompt_target_fingerprint_mismatch')
        expect(capture.calls).toHaveLength(0)
    })

    test('a blocked probe-and-revalidate job throttles its live checkpoint probe across polls', async () => {
        installDatabase('webui')
        const fpA = await deriveWebuiCheckpointFingerprint('ckptA')
        const probeElection = {
            ...webuiRequestPinnedElection,
            binding: { mode: 'probe-and-revalidate' as const, checkpointFingerprint: fpA },
        }
        let liveCheckpoint = 'ckptA'
        let probeCalls = 0
        setWebuiCheckpointProbeForTests(async () => {
            probeCalls++
            return liveCheckpoint
        })
        const capture = makeCapturingWebuiFetch()
        setIllustrationV2TransportFetchersForTests(capture.fetchers)
        const { jobId } = await prepareAndSupplyV2(probeElection, webuiEnvelope())

        // Backend swaps its loaded checkpoint before dispatch -> drift -> blocked_config.
        liveCheckpoint = 'ckptB'
        await runExecutorOnce()
        expect((await illustrationJobStore.getJob(jobId))?.state).toBe('blocked_config')
        expect(capture.calls).toHaveLength(0)

        // While still drifted the job stays blocked. The block pass itself already spent the
        // one allowed resume-probe (its pump drains queued -> blocked -> a resume attempt),
        // so re-running many resume passes at the SAME wall clock must NOT re-fire the live
        // backend GET at all — they are throttled inside the backoff window. Without the
        // throttle each of these five polls would fire its own probe.
        probeCalls = 0
        for (let i = 0; i < 5; i++) await runExecutorOnce()
        expect(probeCalls).toBe(0)
        expect((await illustrationJobStore.getJob(jobId))?.state).toBe('blocked_config')

        // Past the backoff window exactly one fresh probe is allowed; still drifted -> blocked.
        vi.setSystemTime(BASE_TIME + ILLUSTRATION_BLOCKED_LIVE_PROBE_MIN_INTERVAL_MS + 1_000)
        await runExecutorOnce()
        expect(probeCalls).toBe(1)
        expect((await illustrationJobStore.getJob(jobId))?.state).toBe('blocked_config')

        // Checkpoint restored + past another window -> the blocked job re-queues + dispatches.
        liveCheckpoint = 'ckptA'
        vi.setSystemTime(BASE_TIME + 2 * ILLUSTRATION_BLOCKED_LIVE_PROBE_MIN_INTERVAL_MS + 2_000)
        await runExecutorOnce()
        expect((await illustrationJobStore.getJob(jobId))?.state).toBe('committed')
        expect(capture.calls).toHaveLength(1)
        expect(capture.calls[0].body.prompt).toBe('masterpiece, best quality, 1girl, silver hair')
    })

    test('a probe failure at CAPTURE fails closed before any durable context (request §7.3)', async () => {
        installDatabase('webui')
        const fpA = await deriveWebuiCheckpointFingerprint('ckptA')
        const probeElection = {
            ...webuiRequestPinnedElection,
            binding: { mode: 'probe-and-revalidate' as const, checkpointFingerprint: fpA },
        }
        setWebuiCheckpointProbeForTests(async () => null) // unreachable backend
        await setTransportConfig({ schemaVersion: 1, election: probeElection })
        const { turnId } = await registerAndPlan('probe-fail source')
        const turnNow = await illustrationJobStore.getTurn(turnId)
        await expect(preparePromptContext({ turnId, expectedVersion: turnNow!.version, ...REFS }))
            .rejects.toMatchObject({ code: 'prompt_target_unavailable', transportId: 'webui-flat' })
        expect((await illustrationJobStore.getTurn(turnId))?.promptContext).toBeUndefined()
    })
})

describe('supply cross-mode + dispatch-eligibility (request §D1/§6)', () => {
    test('a V2-prepared turn rejects a V1 supplyPrompt', async () => {
        installDatabase('webui')
        await setTransportConfig({ schemaVersion: 1, election: webuiRequestPinnedElection })
        const { turnId, jobId, jobVersion } = await registerAndPlan('cross-mode v1-on-v2')
        const turnNow = await illustrationJobStore.getTurn(turnId)
        await preparePromptContext({ turnId, expectedVersion: turnNow!.version, ...REFS })
        const claimedJob = await illustrationJobStore.claimJob({
            ...coordinatorProof,
            jobId,
            expectedVersion: jobVersion,
            leaseId: 'tagger',
        })
        await expect(supplyPromptLedger({
            ...coordinatorProof,
            jobId,
            expectedVersion: claimedJob.version,
            leaseId: 'tagger',
            fence: claimedJob.fence,
            idempotencyKey: `prompt:${jobId}`,
            positive: 'wrong-mode positive',
            negative: '',
        })).rejects.toMatchObject({ code: 'prompt_supply_mode_mismatch' })
    })

    test('an unprepared (V1) turn rejects supplyPromptEnvelope', async () => {
        installDatabase('webui')
        const { jobId, jobVersion } = await registerAndPlan('cross-mode v2-on-v1')
        const claimedJob = await illustrationJobStore.claimJob({
            ...coordinatorProof,
            jobId,
            expectedVersion: jobVersion,
            leaseId: 'tagger',
        })
        await expect(supplyPromptEnvelope({
            ...coordinatorProof,
            jobId,
            expectedVersion: claimedJob.version,
            leaseId: 'tagger',
            fence: claimedJob.fence,
            idempotencyKey: `env:${jobId}`,
            envelope: webuiEnvelope(),
        })).rejects.toMatchObject({ code: 'prompt_supply_mode_mismatch' })
    })

    test('an over-limit transport_only envelope is ineligible and never queues', async () => {
        installDatabase('webui')
        const tightElection = {
            ...webuiRequestPinnedElection,
            measurement: {
                mode: 'transport_only' as const,
                unit: 'utf8_byte' as const,
                positive: 4, // far below the envelope's positive length
                negative: null,
                combined: null,
                allowTransportOnly: true as const,
            },
        }
        await setTransportConfig({ schemaVersion: 1, election: tightElection })
        const { turnId, jobId, jobVersion } = await registerAndPlan('over-limit source')
        const turnNow = await illustrationJobStore.getTurn(turnId)
        await preparePromptContext({ turnId, expectedVersion: turnNow!.version, ...REFS })
        const claimedJob = await illustrationJobStore.claimJob({
            ...coordinatorProof,
            jobId,
            expectedVersion: jobVersion,
            leaseId: 'tagger',
        })
        await expect(supplyPromptEnvelope({
            ...coordinatorProof,
            jobId,
            expectedVersion: claimedJob.version,
            leaseId: 'tagger',
            fence: claimedJob.fence,
            idempotencyKey: `env:${jobId}`,
            envelope: webuiEnvelope(),
        })).rejects.toMatchObject({ code: 'prompt_dispatch_ineligible' })
        expect(decodeJob(jobId)?.state).toBe('awaiting_prompt')
    })
})

describe('D4: transport_only with all-null limits is rejected at parse', () => {
    test('a transport_only election needs at least one non-null documented limit', () => {
        expect(() => parseTransportConfig({
            schemaVersion: 1,
            election: {
                transportId: 'webui-flat',
                binding: { mode: 'request-pinned', checkpoint: 'x' },
                measurement: {
                    mode: 'transport_only',
                    unit: 'utf8_byte',
                    positive: null,
                    negative: null,
                    combined: null,
                    allowTransportOnly: true,
                },
                maxConcurrency: 1,
                priorityPolicy: 'fifo',
            },
        })).toThrowError(/at least one non-null/)
    })
})

describe('D5: reload preserves V2 envelope/receipt/context identity', () => {
    test('the queued V2 job round-trips its durable envelope + receipt and still dispatches', async () => {
        installDatabase('webui')
        const capture = makeCapturingWebuiFetch()
        setIllustrationV2TransportFetchersForTests(capture.fetchers)
        const { turnId, jobId } = await prepareAndSupplyV2(webuiRequestPinnedElection, webuiEnvelope())

        // Simulate a reload: read the durable records straight from storage.
        const persisted = decodeJob(jobId)
        expect(persisted.promptEnvelope).toMatchObject({
            schemaVersion: 2,
            layout: 'flat',
            basePositive: 'masterpiece, best quality, 1girl, silver hair',
        })
        expect(persisted.promptReceipt).toMatchObject({
            schemaVersion: 2,
            measurementMode: 'transport_only',
            dispatchEligible: true,
        })
        const reloadedTurn = await illustrationJobStore.getTurn(turnId)
        expect(reloadedTurn?.promptContext?.target.transportId).toBe('webui-flat')
        expect(reloadedTurn?.promptContext?.tagProfile).toEqual(REFS.tagProfile)

        // A fresh executor pass (no state carried in memory) still dispatches the exact
        // captured envelope through the transport.
        await runExecutorOnce()
        expect((await illustrationJobStore.getJob(jobId))?.state).toBe('committed')
        expect(capture.calls[0].body.prompt).toBe('masterpiece, best quality, 1girl, silver hair')
    })
})
