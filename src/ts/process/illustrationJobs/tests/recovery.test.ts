import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Chat } from '../../../storage/database.svelte'
import { InMemoryLockManager } from './inMemoryLockManager'

const harness = vi.hoisted(() => ({
    storageMap: new Map<string, Uint8Array>(),
    database: null as any,
    integrity: new Map<string, 'complete' | 'repairable' | 'missing'>(),
    provider: vi.fn(),
    inspectInlay: vi.fn(),
    repairInlay: vi.fn(),
    strictSave: vi.fn(),
    strictFailure: null as Error | null,
    storageWriteHook: null as ((key: string) => void) | null,
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
            harness.storageWriteHook?.(key)
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
    writeInlayImage: vi.fn(),
    inspectInlayAssetIntegrity: harness.inspectInlay,
    repairInlayAssetRecords: harness.repairInlay,
}))

const coordinatorModule = await import('../coordinator')
const coordinatorRecordModule = await import('../coordinatorRecord')
const executorModule = await import('../executor')
const featureModule = await import('../featureFlag')
const lockModule = await import('../locks')
const operationLockModule = await import('../operationLock')
const recoveryModule = await import('../recovery')
const storeModule = await import('../store')

const { registerTrustedTurn, submitPlanLedger, supplyPromptLedger } = coordinatorModule
const { claimCoordinator } = coordinatorRecordModule
const {
    resetIllustrationWorkerLockManagerAccessorForTests,
    setIllustrationWorkerLockManagerAccessorForTests,
} = executorModule
const { setIllustrationFeatureEnabled } = featureModule
const { resetIllustrationLockManagerAccessorForTests, setIllustrationLockManagerAccessorForTests } = lockModule
const {
    resetIllustrationOperationLockManagerAccessorForTests,
    setIllustrationOperationLockManagerAccessorForTests,
} = operationLockModule
const { runIllustrationRecovery } = recoveryModule
const { illustrationJobKey, illustrationJobStore } = storeModule

const BASE_TIME = Date.UTC(2026, 0, 4)
let lockManager: InMemoryLockManager
let coordinatorProof: { coordinatorLeaseId: string; coordinatorFence: number }

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

function installDatabase(source = 'Recovery source') {
    const message: any = { role: 'char', chatId: 'message-1', data: source }
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
            chats: [chat],
            chatPage: 0,
        }],
        sdProvider: 'novelai',
        NAIImgUrl: 'https://image.novelai.net/ai/generate-image',
        NAIImgModel: 'nai-diffusion-4-5-full',
        NAII2I: false,
        NAIImgConfig: {},
    }
    return { chat, message }
}

async function createClaimedTurn(source = 'Recovery source') {
    const target = installDatabase(source)
    const turn = await registerTrustedTurn({
        chaId: 'character-1',
        conversationId: 'conversation-1',
        expectedMessageId: 'message-1',
        rootTurnId: 'root-1',
        sourceVariantText: source,
    })
    const claimed = await illustrationJobStore.claimTurn({
        ...coordinatorProof,
        turnId: turn.turnId,
        expectedVersion: turn.version,
        leaseId: 'planner',
    })
    return { ...target, turn, claimed }
}

async function createQueuedJob(source = 'Recovery source') {
    const target = await createClaimedTurn(source)
    const [projected] = await submitPlanLedger({
        ...coordinatorProof,
        turnId: target.turn.turnId,
        expectedVersion: target.claimed.version,
        leaseId: 'planner',
        fence: target.claimed.fence,
        idempotencyKey: `plan:${target.turn.turnId}`,
        sourceRevisionHash: target.turn.sourceRevisionHash!,
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
        positive: 'prompt',
        negative: '',
    })
    harness.strictSave.mockClear()
    return { ...target, queued }
}

async function createTwoQueuedJobs(source = 'Two recovery scenes') {
    const target = await createClaimedTurn(source)
    const projected = await submitPlanLedger({
        ...coordinatorProof,
        turnId: target.turn.turnId,
        expectedVersion: target.claimed.version,
        leaseId: 'planner',
        fence: target.claimed.fence,
        idempotencyKey: `plan:${target.turn.turnId}`,
        sourceRevisionHash: target.turn.sourceRevisionHash!,
        slots: [
            {
                sceneId: 'scene-1',
                insertAfterUtf16: Math.floor(source.length / 2),
                scenePayload: { schemaVersion: 1, data: { description: 'first scene' } },
            },
            {
                sceneId: 'scene-2',
                insertAfterUtf16: source.length,
                scenePayload: { schemaVersion: 1, data: { description: 'second scene' } },
            },
        ],
    })
    const queued = []
    for (const [index, job] of projected.entries()) {
        const leaseId = `tagger-${index}`
        const claimedJob = await illustrationJobStore.claimJob({
            ...coordinatorProof,
            jobId: job.jobId,
            expectedVersion: job.version,
            leaseId,
        })
        queued.push(await supplyPromptLedger({
            ...coordinatorProof,
            jobId: job.jobId,
            expectedVersion: claimedJob.version,
            leaseId,
            fence: claimedJob.fence,
            idempotencyKey: `prompt:${job.jobId}`,
            positive: `prompt ${index}`,
            negative: '',
        }))
    }
    harness.strictSave.mockClear()
    return { ...target, queued }
}

function planInput(
    target: Awaited<ReturnType<typeof createClaimedTurn>>,
    offsets: number[],
) {
    return {
        ...coordinatorProof,
        turnId: target.turn.turnId,
        expectedVersion: target.claimed.version,
        leaseId: 'planner',
        fence: target.claimed.fence,
        idempotencyKey: `plan:${target.turn.turnId}`,
        sourceRevisionHash: target.turn.sourceRevisionHash!,
        slots: offsets.map((insertAfterUtf16, index) => ({
            sceneId: `scene-${index}`,
            insertAfterUtf16,
            scenePayload: { schemaVersion: 1, data: { description: `scene ${index}` } },
        })),
    }
}

async function advanceAsset(
    jobId: string,
    state: 'generating' | 'asset_writing' | 'asset_ready' | 'committing',
) {
    let job = (await illustrationJobStore.getJob(jobId))!
    job = await illustrationJobStore.transitionJob({
        jobId,
        expectedVersion: job.version,
        to: 'generating',
        patch: {
            idempotencyKey: `test:generating:${job.version}`,
            workerEpoch: 1,
            attemptId: 'attempt:recovery',
            assetId: 'asset:recovery',
        },
    })
    if (state === 'generating') return job
    job = await illustrationJobStore.transitionJob({
        jobId,
        expectedVersion: job.version,
        to: 'asset_writing',
        patch: { idempotencyKey: `test:writing:${job.version}`, workerEpoch: 1 },
    })
    if (state === 'asset_writing') return job
    job = await illustrationJobStore.transitionJob({
        jobId,
        expectedVersion: job.version,
        to: 'asset_ready',
        patch: { idempotencyKey: `test:ready:${job.version}`, workerEpoch: 1 },
    })
    if (state === 'asset_ready') return job
    return await illustrationJobStore.transitionJob({
        jobId,
        expectedVersion: job.version,
        to: 'committing',
        patch: { idempotencyKey: `test:committing:${job.version}`, workerEpoch: 1 },
    })
}

beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    harness.storageMap.clear()
    harness.integrity.clear()
    harness.provider.mockReset()
    harness.inspectInlay.mockReset()
    harness.repairInlay.mockReset()
    harness.strictSave.mockReset()
    harness.strictFailure = null
    harness.storageWriteHook = null
    installDatabase()
    lockManager = new InMemoryLockManager()
    setIllustrationLockManagerAccessorForTests(() => lockManager)
    setIllustrationOperationLockManagerAccessorForTests(() => lockManager)
    setIllustrationWorkerLockManagerAccessorForTests(() => lockManager)
    await setIllustrationFeatureEnabled(true)
    await refreshCoordinatorProof()
    harness.inspectInlay.mockImplementation(async (id: string) => {
        const status = harness.integrity.get(id) ?? 'missing'
        return {
            status,
            hasAsset: status !== 'missing',
            hasInfo: status === 'complete',
            hasMeta: status === 'complete',
        }
    })
    harness.repairInlay.mockImplementation(async (id: string) => {
        harness.integrity.set(id, 'complete')
    })
    harness.strictSave.mockImplementation(async () => {
        if (harness.strictFailure) throw harness.strictFailure
        return { success: true, durable: true }
    })
})

afterEach(async () => {
    expect(harness.provider).not.toHaveBeenCalled()
    resetIllustrationWorkerLockManagerAccessorForTests()
    resetIllustrationLockManagerAccessorForTests()
    resetIllustrationOperationLockManagerAccessorForTests()
    vi.useRealTimers()
})

describe('illustration recovery', () => {
    // §20 Finalization: concurrent callers converge and corrupt outranks stale.
    test('finalizes one turn version exactly once under concurrent helper calls', async () => {
        const { turn, queued } = await createTwoQueuedJobs()
        await illustrationJobStore.transitionJob({
            jobId: queued[0].jobId,
            expectedVersion: queued[0].version,
            to: 'stale',
            patch: { idempotencyKey: 'test:concurrent-stale', workerEpoch: 1 },
        })
        await illustrationJobStore.transitionJob({
            jobId: queued[1].jobId,
            expectedVersion: queued[1].version,
            to: 'corrupt',
            patch: { idempotencyKey: 'test:concurrent-corrupt', workerEpoch: 1 },
        })
        const live = (await illustrationJobStore.getTurn(turn.turnId))!

        await Promise.all([
            illustrationJobStore.finalizeTurnAfterJobs(turn.turnId),
            illustrationJobStore.finalizeTurnAfterJobs(turn.turnId),
            illustrationJobStore.finalizeTurnAfterJobs(turn.turnId),
        ])

        const finalized = (await illustrationJobStore.getTurn(turn.turnId))!
        expect(finalized).toMatchObject({
            state: 'corrupt',
            error: { code: 'job_corrupt' },
            version: live.version + 1,
        })
        await illustrationJobStore.finalizeTurnAfterJobs(turn.turnId)
        expect((await illustrationJobStore.getTurn(turn.turnId))?.version).toBe(finalized.version)
    })

    // §20 Recovery: the recovery pass delegates to the same terminal mapping.
    test('keeps a turn live until every sibling is terminal, then prefers a committed outcome', async () => {
        const { turn, queued } = await createTwoQueuedJobs()
        await illustrationJobStore.transitionJob({
            jobId: queued[0].jobId,
            expectedVersion: queued[0].version,
            to: 'stale',
            patch: { idempotencyKey: 'test:first-stale', workerEpoch: 1 },
        })

        await runIllustrationRecovery()

        expect((await illustrationJobStore.getTurn(turn.turnId))?.state).toBe('awaiting_prompt')
        expect((await illustrationJobStore.getJob(queued[1].jobId))?.state).toBe('queued')

        const committing = await advanceAsset(queued[1].jobId, 'committing')
        await illustrationJobStore.transitionJob({
            jobId: committing.jobId,
            expectedVersion: committing.version,
            to: 'committed',
            patch: { idempotencyKey: 'test:second-committed', workerEpoch: 1 },
        })
        await runIllustrationRecovery()

        expect((await illustrationJobStore.getTurn(turn.turnId))).toMatchObject({ state: 'completed' })
    })

    // §20 Crash/storage: generating without a verifiable deterministic asset is uncertain.
    test('settles an interrupted generating attempt as uncertain without provider work', async () => {
        const { queued } = await createQueuedJob()
        await advanceAsset(queued.jobId, 'generating')

        await runIllustrationRecovery()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('uncertain')
    })

    test('leaves a valid queued job queued for the executor without dispatching it', async () => {
        const { queued } = await createQueuedJob()

        await runIllustrationRecovery()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('queued')
    })

    // §12.2 crash after asset bytes: deterministic integrity resumes without a second charge.
    test('recovers a complete deterministic asset from generating without provider work', async () => {
        const { queued } = await createQueuedJob()
        const generating = await advanceAsset(queued.jobId, 'generating')
        harness.integrity.set(generating.assetId!, 'complete')

        await runIllustrationRecovery()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('committed')
    })

    // §13: an exact durable reference closes committing without provider work.
    test('reconciles an exact asset reference to committed', async () => {
        const { queued, message } = await createQueuedJob()
        const committing = await advanceAsset(queued.jobId, 'committing')
        harness.integrity.set(committing.assetId!, 'complete')
        message.data = message.data.replace(
            /<risu-illustration-slot[\s\S]*?<\/risu-illustration-slot>/,
            `{{inlay::${committing.assetId}}}`,
        )

        await runIllustrationRecovery()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('committed')
        expect(harness.strictSave).toHaveBeenCalledTimes(1)
    })

    // §13: intact slot + complete asset safely reuses the normal commit path.
    test('recommits an intact slot with a complete asset', async () => {
        const { queued, message } = await createQueuedJob()
        const ready = await advanceAsset(queued.jobId, 'asset_ready')
        harness.integrity.set(ready.assetId!, 'complete')

        await runIllustrationRecovery()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('committed')
        expect(message.data).toContain(`{{inlay::${ready.assetId}}}`)
    })

    // §13: target/source edit is stale.
    test('marks a changed source stale instead of recommitting', async () => {
        const { queued, message } = await createQueuedJob()
        const ready = await advanceAsset(queued.jobId, 'asset_ready')
        harness.integrity.set(ready.assetId!, 'complete')
        message.data = message.data.replace('Recovery source', 'Edited source')

        await runIllustrationRecovery()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('stale')
        expect(harness.strictSave).not.toHaveBeenCalled()
    })

    // §13: duplicated token topology fails closed as corrupt.
    test('marks duplicated slot tokens corrupt', async () => {
        const { queued, message } = await createQueuedJob()
        const committing = await advanceAsset(queued.jobId, 'committing')
        harness.integrity.set(committing.assetId!, 'complete')
        const slot = message.data.match(/<risu-illustration-slot[\s\S]*?<\/risu-illustration-slot>/)![0]
        message.data += slot

        await runIllustrationRecovery()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('corrupt')
    })

    test('marks duplicate asset references across logical variants corrupt', async () => {
        const { queued, message } = await createQueuedJob()
        const committing = await advanceAsset(queued.jobId, 'committing')
        harness.integrity.set(committing.assetId!, 'complete')
        const reference = `{{inlay::${committing.assetId}}}`
        const active = message.data.replace(
            /<risu-illustration-slot[\s\S]*?<\/risu-illustration-slot>/,
            reference,
        )
        message.data = active
        message.swipes = [active, `Other logical variant ${reference}`]
        message.swipeId = 0

        await runIllustrationRecovery()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('corrupt')
    })

    // §12.2 / §13: repairable records are repaired target-aware before recommit.
    test('repairs a partial asset record before committing', async () => {
        const { queued } = await createQueuedJob()
        const ready = await advanceAsset(queued.jobId, 'asset_ready')
        harness.integrity.set(ready.assetId!, 'repairable')

        await runIllustrationRecovery()

        expect(harness.repairInlay).toHaveBeenCalledWith(ready.assetId, {
            charId: 'character-1',
            chatId: 'conversation-1',
        })
        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('committed')
    })

    // §10.3 double-crash row: durable cancel survives asset_writing recovery and skips chat commit.
    test('finishes asset integrity then cancels an asset_writing job with durable cancel intent', async () => {
        const { queued } = await createQueuedJob()
        const generating = await advanceAsset(queued.jobId, 'generating')
        const cancelRequested = await illustrationJobStore.requestCancel({
            jobId: queued.jobId,
            expectedVersion: generating.version,
        })
        const writing = await illustrationJobStore.transitionJob({
            jobId: queued.jobId,
            expectedVersion: cancelRequested.version,
            to: 'asset_writing',
            patch: { idempotencyKey: 'test:cancel-writing', workerEpoch: 1 },
        })
        harness.integrity.set(writing.assetId!, 'complete')

        await runIllustrationRecovery()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('cancelled')
        expect(harness.strictSave).not.toHaveBeenCalled()
    })

    test('honors durable cancel intent after a second crash at asset_ready', async () => {
        const { queued } = await createQueuedJob()
        const generating = await advanceAsset(queued.jobId, 'generating')
        const cancelRequested = await illustrationJobStore.requestCancel({
            jobId: queued.jobId,
            expectedVersion: generating.version,
        })
        let job = await illustrationJobStore.transitionJob({
            jobId: queued.jobId,
            expectedVersion: cancelRequested.version,
            to: 'asset_writing',
            patch: { idempotencyKey: 'test:cancel-writing-second', workerEpoch: 1 },
        })
        job = await illustrationJobStore.transitionJob({
            jobId: queued.jobId,
            expectedVersion: job.version,
            to: 'asset_ready',
            patch: { idempotencyKey: 'test:cancel-ready-second', workerEpoch: 1 },
        })
        harness.integrity.set(job.assetId!, 'complete')

        await runIllustrationRecovery()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('cancelled')
        expect(harness.strictSave).not.toHaveBeenCalled()
    })

    test('leaves committing durable when a recovery strict flush fails', async () => {
        const { queued } = await createQueuedJob()
        const ready = await advanceAsset(queued.jobId, 'asset_ready')
        harness.integrity.set(ready.assetId!, 'complete')
        harness.strictFailure = new Error('recovery flush failed')

        await runIllustrationRecovery()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('committing')
    })

    test('settles a malformed committing record without an asset ID as uncertain', async () => {
        const { queued } = await createQueuedJob()
        const committing = await advanceAsset(queued.jobId, 'committing')
        const key = illustrationJobKey(committing.jobId)
        const malformed = { ...committing }
        delete malformed.assetId
        harness.storageMap.set(key, new TextEncoder().encode(JSON.stringify(malformed)))

        await runIllustrationRecovery()

        expect((await illustrationJobStore.getJob(queued.jobId))?.state).toBe('uncertain')
    })

    // §7.3 all-present projection: strict ACK is recovered before records advance.
    test('aligns all projected slots after a crash before projection_durable', async () => {
        const target = await createClaimedTurn('Projection all')
        harness.strictFailure = new Error('projection flush failed')
        await expect(submitPlanLedger(planInput(target, [4, 10]))).rejects.toThrow('projection flush failed')
        harness.strictFailure = null

        await runIllustrationRecovery()

        expect((await illustrationJobStore.getManifest(target.turn.turnId))?.phase)
            .toBe('projection_durable')
        expect((await illustrationJobStore.listJobs({ turnId: target.turn.turnId })))
            .toSatisfy((jobs: any[]) => jobs.every((job) => job.state === 'awaiting_prompt'))
        expect((await illustrationJobStore.getTurn(target.turn.turnId))?.state).toBe('awaiting_prompt')
    })

    test('keeps manifest-owned prepared jobs retryable after a recovery strict-flush failure', async () => {
        const target = await createClaimedTurn('Projection retry')
        harness.strictFailure = new Error('projection flush failed')
        await expect(submitPlanLedger(planInput(target, [5]))).rejects.toThrow('projection flush failed')

        await runIllustrationRecovery()

        expect((await illustrationJobStore.listJobs({ turnId: target.turn.turnId }))[0]?.state)
            .toBe('prepared')
        expect((await illustrationJobStore.getTurn(target.turn.turnId))?.state).toBe('awaiting_plan')

        harness.strictFailure = null
        await runIllustrationRecovery()
        expect((await illustrationJobStore.listJobs({ turnId: target.turn.turnId }))[0]?.state)
            .toBe('awaiting_prompt')
    })

    // §7.3 none-present projection: exact source is materialized once without re-planning.
    test('rematerializes once when no projected slots survived but the source still matches', async () => {
        const target = await createClaimedTurn('Projection none')
        const markerText = target.message.data
        harness.strictFailure = new Error('projection flush failed')
        await expect(submitPlanLedger(planInput(target, [5]))).rejects.toThrow('projection flush failed')
        target.message.data = markerText
        harness.strictFailure = null

        await runIllustrationRecovery()

        expect(target.message.data.match(/<risu-illustration-slot /g)).toHaveLength(1)
        expect((await illustrationJobStore.getManifest(target.turn.turnId))?.phase)
            .toBe('projection_durable')
    })

    // §7.3 partial projection must fail closed as corrupt_projection.
    test('marks a partial projection corrupt', async () => {
        const target = await createClaimedTurn('Projection partial')
        harness.strictFailure = new Error('projection flush failed')
        await expect(submitPlanLedger(planInput(target, [4, 12]))).rejects.toThrow('projection flush failed')
        target.message.data = target.message.data.replace(
            /<risu-illustration-slot[\s\S]*?<\/risu-illustration-slot>/,
            '',
        )
        harness.strictFailure = null

        await runIllustrationRecovery()

        expect((await illustrationJobStore.getTurn(target.turn.turnId))?.state).toBe('corrupt')
        expect((await illustrationJobStore.listJobs({ turnId: target.turn.turnId })))
            .toSatisfy((jobs: any[]) => jobs.every((job) => job.state === 'corrupt'))
    })

    // §20 manifest crash: missing prepared records are rebuilt from the manifest, never re-planned.
    test('rebuilds jobs after a crash between manifest record writes', async () => {
        const target = await createClaimedTurn('Record crash')
        let jobWrites = 0
        harness.storageWriteHook = (key) => {
            if (key.startsWith('illustration:v1:job:') && ++jobWrites === 2) {
                throw new Error('simulated record crash')
            }
        }
        await expect(submitPlanLedger(planInput(target, [2, 8]))).rejects.toThrow('simulated record crash')
        expect((await illustrationJobStore.listJobs({ turnId: target.turn.turnId }))).toHaveLength(0)
        harness.storageWriteHook = null

        await runIllustrationRecovery()

        expect((await illustrationJobStore.listJobs({ turnId: target.turn.turnId }))).toHaveLength(2)
        expect((await illustrationJobStore.getManifest(target.turn.turnId))?.phase)
            .toBe('projection_durable')
    })

    // §6.2 recovery retries a blocked marker flush only while target/source still match.
    test('retries blocked_capture once when source matches and otherwise leaves it blocked', async () => {
        installDatabase('Blocked source')
        harness.strictFailure = new Error('capture failed')
        await expect(registerTrustedTurn({
            chaId: 'character-1',
            conversationId: 'conversation-1',
            expectedMessageId: 'message-1',
            rootTurnId: 'root-1',
            sourceVariantText: 'Blocked source',
        })).rejects.toThrow('capture failed')
        const [blocked] = await illustrationJobStore.listTurns()
        harness.strictFailure = null

        await runIllustrationRecovery()
        expect((await illustrationJobStore.getTurn(blocked.turnId))?.state).toBe('awaiting_plan')

        harness.storageMap.clear()
        await setIllustrationFeatureEnabled(true)
        await refreshCoordinatorProof()
        installDatabase('Changed target')
        harness.strictFailure = new Error('capture failed')
        await expect(registerTrustedTurn({
            chaId: 'character-1',
            conversationId: 'conversation-1',
            expectedMessageId: 'message-1',
            rootTurnId: 'root-2',
            sourceVariantText: 'Changed target',
        })).rejects.toThrow('capture failed')
        const [second] = await illustrationJobStore.listTurns()
        harness.database.characters[0].chats[0].message[0].data = 'User changed it'
        harness.strictFailure = null

        await runIllustrationRecovery()
        expect((await illustrationJobStore.getTurn(second.turnId))?.state).toBe('blocked_capture')
    })

    test('keeps Agent-blocked jobs live when updating the parent turn', async () => {
        const target = await createClaimedTurn('Agent blocked recovery')
        const [projected] = await submitPlanLedger(planInput(target, [5]))
        const leaseId = 'tagger:agent-blocked-recovery'
        const claimed = await illustrationJobStore.claimJob({
            ...coordinatorProof,
            jobId: projected.jobId,
            expectedVersion: projected.version,
            leaseId,
        })
        const blocked = await illustrationJobStore.reportAgentFailure({
            protocolVersion: 1,
            kind: 'job',
            id: claimed.jobId,
            expectedVersion: claimed.version,
            leaseId,
            fence: claimed.fence,
            ...coordinatorProof,
            idempotencyKey: 'failure:agent-blocked-recovery',
            code: 'tagger_failed',
            retryable: true,
        })

        await runIllustrationRecovery()

        expect(await illustrationJobStore.getJob(claimed.jobId)).toEqual(blocked)
        expect((await illustrationJobStore.getTurn(target.turn.turnId))?.state)
            .toBe('awaiting_prompt')
    })

    // §22 feature flag: recovery is a no-op while disabled.
    test('does nothing while the feature flag is off', async () => {
        const { queued } = await createQueuedJob()
        const generating = await advanceAsset(queued.jobId, 'generating')
        await setIllustrationFeatureEnabled(false)

        await runIllustrationRecovery()

        expect(await illustrationJobStore.getJob(queued.jobId)).toEqual(generating)
    })
})
