import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type {
    IllustrationJobRecordV1,
    IllustrationJobState,
    IllustrationJobTransitionPatch,
    IllustrationCoordinatorProof,
    IllustrationTurnRecordV1,
    PlanManifestV1,
} from '../types'
import { InMemoryLockManager } from './inMemoryLockManager'

const { storageMap, storageControl, storageCounters } = vi.hoisted(() => ({
    storageMap: new Map<string, Uint8Array>(),
    storageControl: {
        failSetKey: null as string | null,
        failSetCount: 0,
        // When set, the bulk-read mock emits the named key twice so the
        // duplicate-row fail-closed guard can be exercised end to end.
        duplicateBulkKey: null as string | null,
    },
    // Per-record vs bulk request accounting for the read fan-out regressions.
    // getItem counts single-record `/api/read`; getItems counts bulk reads;
    // bulkReadKeyCounts records the request width of each bulk read so a listing's
    // fan-out can be asserted proportional to pending work, not total history.
    storageCounters: {
        getItem: 0,
        getItems: 0,
        bulkReadKeyCounts: [] as number[],
    },
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: {
        async Init() {},
        async keys(prefix = '') {
            return [...storageMap.keys()].filter((key) => key.startsWith(prefix))
        },
        async getItem(key: string) {
            storageCounters.getItem += 1
            return storageMap.get(key) ?? null
        },
        async getItems(keys: string[]) {
            storageCounters.getItems += 1
            storageCounters.bulkReadKeyCounts.push(keys.length)
            // Mirror the Node bulk-read server contract: missing keys are
            // silently omitted from the response (no null placeholder), and the
            // caller must correlate results by the `key` field.
            const results: { key: string; value: Uint8Array }[] = []
            for (const key of keys) {
                const value = storageMap.get(key)
                if (value !== undefined) {
                    results.push({ key, value: new Uint8Array(value) })
                    if (storageControl.duplicateBulkKey === key) {
                        results.push({ key, value: new Uint8Array(value) })
                    }
                }
            }
            return results
        },
        async setItem(key: string, value: Uint8Array) {
            if (storageControl.failSetKey === key && storageControl.failSetCount > 0) {
                storageControl.failSetCount -= 1
                throw new Error(`injected set failure: ${key}`)
            }
            storageMap.set(key, new Uint8Array(value))
        },
        async removeItem(key: string) {
            storageMap.delete(key)
        },
    },
}))

vi.mock('src/ts/parser/parser.svelte', () => ({
    hasher: vi.fn(async () => new Uint8Array(32)),
}))

const storeModule = await import('../store')
const coordinatorRecordModule = await import('../coordinatorRecord')
const featureModule = await import('../featureFlag')
const lockModule = await import('../locks')
const errorModule = await import('../errors')

const {
    IllustrationJobStore,
    ILLUSTRATION_PENDING_TURNS_KEY,
    JOB_LEASE_DURATION_MS,
    MAX_JOBS_PER_TURN,
    TERMINAL_RECORD_TTL_MS,
    TURN_LEASE_DURATION_MS,
    illustrationJobKey,
    illustrationManifestKey,
    illustrationTurnKey,
    illustrationTurnJobsKey,
    validateHolderWrite,
} = storeModule
const {
    COORDINATOR_LEASE_DURATION_MS,
    claimCoordinator,
    markCoordinatorDraining,
} = coordinatorRecordModule
const { setIllustrationFeatureEnabled } = featureModule
const {
    resetIllustrationLockManagerAccessorForTests,
    setIllustrationLockManagerAccessorForTests,
} = lockModule
const {
    IllustrationLedgerConfirmationRequiredError,
    IllustrationCoordinatorDrainingError,
    IllustrationCoordinatorExpiredError,
    IllustrationCoordinatorMismatchError,
    IllustrationLedgerCorruptError,
    IllustrationLedgerHolderMismatchError,
    IllustrationLedgerLeaseConflictError,
    IllustrationLedgerUnavailableError,
    IllustrationLedgerValidationError,
    IllustrationLedgerVersionConflictError,
} = errorModule

const store = new IllustrationJobStore()
const BASE_TIME = Date.UTC(2026, 0, 1)
let transitionSequence = 0

function flatPrompt(positive: string, negative: string) {
    return {
        schemaVersion: 1 as const,
        layout: 'flat' as const,
        basePositive: positive,
        characterPositives: [],
        baseNegative: negative,
        characterNegatives: [],
    }
}
let lockManager: InMemoryLockManager
let coordinatorProof: IllustrationCoordinatorProof
let coordinatorVersion: number

async function refreshCoordinatorProof(): Promise<void> {
    const snapshot = await claimCoordinator({
        protocolVersion: 1,
        leaseId: 'test-coordinator',
        holderRuntimeId: 'test-runtime',
    })
    coordinatorVersion = snapshot.version
    coordinatorProof = {
        coordinatorLeaseId: 'test-coordinator',
        coordinatorFence: snapshot.fence,
    }
}

async function advanceTimeKeepingCoordinatorOwned(ms: number): Promise<void> {
    let remaining = ms
    const renewStep = COORDINATOR_LEASE_DURATION_MS - 1
    await refreshCoordinatorProof()
    while (remaining >= renewStep) {
        vi.advanceTimersByTime(renewStep)
        remaining -= renewStep
        await refreshCoordinatorProof()
    }
    vi.advanceTimersByTime(remaining)
}

function jobIdFor(turnId: string, index = 0): string {
    return `${turnId}:job:${index}`
}

function makeManifest(
    turnId: string,
    jobCount = 1,
    dataFactory: (index: number) => unknown = (index) => ({ description: `scene-${index}` }),
): Omit<PlanManifestV1, 'phase' | 'version'> {
    return {
        turnId,
        planHash: `plan:${turnId}`,
        expectedCount: jobCount,
        sourceRevisionHash: `source:${turnId}`,
        jobs: Array.from({ length: jobCount }, (_, index) => ({
            jobId: jobIdFor(turnId, index),
            slotToken: `slot:${turnId}:${index}`,
            insertAfterUtf16: index * 2,
            sceneId: `scene:${turnId}:${index}`,
            scenePayload: {
                schemaVersion: 1,
                data: dataFactory(index),
            },
        })),
    }
}

async function createClaimedTurn(turnId: string): Promise<{
    turn: IllustrationTurnRecordV1
    leaseId: string
}> {
    const leaseId = `lease:${turnId}`
    const created = await store.createTurn({ turnId, idempotencyKey: `create:${turnId}` })
    const awaiting = await store.updateTurn({
        turnId,
        expectedVersion: created.version,
        mutate: (draft) => {
            draft.state = 'awaiting_plan'
        },
    })
    const turn = await store.claimTurn({
        ...coordinatorProof,
        turnId,
        expectedVersion: awaiting.version,
        leaseId,
    })
    return { turn, leaseId }
}

async function createPreparedJobs(
    turnId: string,
    manifestInput = makeManifest(turnId),
): Promise<IllustrationJobRecordV1[]> {
    const { turn, leaseId } = await createClaimedTurn(turnId)
    const manifest = await store.createManifestPrepared({
        ...coordinatorProof,
        manifest: manifestInput,
        turnExpectedVersion: turn.version,
        leaseId,
        fence: turn.fence,
        idempotencyKey: `submit:${turnId}`,
    })
    return await store.createJobsFromManifest({
        turnId,
        expectedManifestVersion: manifest.version,
    })
}

async function transition(
    jobId: string,
    to: IllustrationJobState,
    patch: IllustrationJobTransitionPatch = {},
    holder?: { leaseId: string; fence: number },
): Promise<IllustrationJobRecordV1> {
    const current = await store.getJob(jobId)
    if (!current) throw new Error(`missing test job: ${jobId}`)
    return await store.transitionJob({
        jobId,
        expectedVersion: current.version,
        to,
        patch: {
            ...patch,
            idempotencyKey: patch.idempotencyKey ?? `transition:${jobId}:${++transitionSequence}`,
        },
        ...(holder ? { ...holder, ...coordinatorProof } : {}),
    })
}

async function queueJob(jobId: string): Promise<IllustrationJobRecordV1> {
    let current = await store.getJob(jobId)
    if (!current) throw new Error(`missing test job: ${jobId}`)
    if (current.state === 'prepared') current = await transition(jobId, 'awaiting_prompt')
    if (current.state !== 'awaiting_prompt') throw new Error(`cannot queue ${current.state}`)
    const leaseId = `tagger:${jobId}`
    const claimed = await store.claimJob({
        ...coordinatorProof,
        jobId,
        expectedVersion: current.version,
        leaseId,
    })
    return await store.transitionJob({
        jobId,
        expectedVersion: claimed.version,
        to: 'queued',
        leaseId,
        fence: claimed.fence,
        ...coordinatorProof,
        patch: {
            idempotencyKey: `supply:${jobId}:${++transitionSequence}`,
            prompt: flatPrompt(`positive:${jobId}`, `negative:${jobId}`),
        },
    })
}

type BuildableJobState =
    | 'prepared'
    | 'awaiting_prompt'
    | 'queued'
    | 'blocked_config'
    | 'generating'
    | 'cancel_requested'
    | 'asset_writing'
    | 'asset_ready'
    | 'committing'
    | 'uncertain'

async function createJobAtState(turnId: string, targetState: BuildableJobState): Promise<IllustrationJobRecordV1> {
    const [prepared] = await createPreparedJobs(turnId)
    if (targetState === 'prepared') return prepared

    const awaiting = await transition(prepared.jobId, 'awaiting_prompt')
    if (targetState === 'awaiting_prompt') return awaiting

    const queued = await queueJob(prepared.jobId)
    if (targetState === 'queued') return queued
    if (targetState === 'blocked_config') return await transition(prepared.jobId, 'blocked_config')

    const generating = await transition(prepared.jobId, 'generating', {
        attemptId: `attempt:${prepared.jobId}`,
        assetId: `asset:${prepared.jobId}`,
    })
    if (targetState === 'generating') return generating
    if (targetState === 'cancel_requested') {
        return await store.requestCancel({ jobId: prepared.jobId, expectedVersion: generating.version })
    }
    if (targetState === 'uncertain') {
        return await transition(prepared.jobId, 'uncertain', {
            error: { code: 'provider_timeout', certainty: 'uncertain' },
        })
    }

    const writing = await transition(prepared.jobId, 'asset_writing')
    if (targetState === 'asset_writing') return writing
    const ready = await transition(prepared.jobId, 'asset_ready')
    if (targetState === 'asset_ready') return ready
    return await transition(prepared.jobId, 'committing')
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
        resolve = done
    })
    return { promise, resolve }
}

function decodeStored<T>(key: string): T | null {
    const value = storageMap.get(key)
    return value ? (JSON.parse(new TextDecoder().decode(value)) as T) : null
}

function encodeStored(key: string, value: unknown): void {
    storageMap.set(key, new TextEncoder().encode(JSON.stringify(value)))
}

beforeEach(async () => {
    storageMap.clear()
    storageControl.failSetKey = null
    storageControl.failSetCount = 0
    storageControl.duplicateBulkKey = null
    storageCounters.getItem = 0
    storageCounters.getItems = 0
    storageCounters.bulkReadKeyCounts = []
    transitionSequence = 0
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    lockManager = new InMemoryLockManager()
    setIllustrationLockManagerAccessorForTests(() => lockManager)
    await setIllustrationFeatureEnabled(true)
    await refreshCoordinatorProof()
})

afterEach(() => {
    resetIllustrationLockManagerAccessorForTests()
    vi.useRealTimers()
})

describe('turn records and version CAS', () => {
    test('creates idempotently and rejects a stale expectedVersion', async () => {
        const created = await store.createTurn({ turnId: 'turn-cas', idempotencyKey: 'create-cas' })
        const duplicate = await store.createTurn({ turnId: 'turn-cas', idempotencyKey: 'create-cas' })
        expect(duplicate).toEqual(created)

        const updated = await store.updateTurn({
            turnId: 'turn-cas',
            expectedVersion: created.version,
            mutate: (draft) => {
                draft.state = 'awaiting_plan'
            },
        })
        expect(updated.version).toBe(2)
        await expect(
            store.updateTurn({
                turnId: 'turn-cas',
                expectedVersion: created.version,
                mutate: (draft) => {
                    draft.state = 'blocked_capture'
                },
            }),
        ).rejects.toBeInstanceOf(IllustrationLedgerVersionConflictError)
    })

    test('serializes interleaved mutations without a lost update', async () => {
        const created = await store.createTurn({ turnId: 'turn-race', idempotencyKey: 'create-race' })
        const entered = deferred()
        const release = deferred()
        const first = store.updateTurn({
            turnId: created.turnId,
            expectedVersion: created.version,
            mutate: async (draft) => {
                entered.resolve()
                await release.promise
                draft.state = 'awaiting_plan'
            },
        })
        await entered.promise
        const second = store.updateTurn({
            turnId: created.turnId,
            expectedVersion: created.version,
            mutate: (draft) => {
                draft.state = 'blocked_capture'
            },
        })
        release.resolve()

        await expect(first).resolves.toMatchObject({ state: 'awaiting_plan', version: 2 })
        await expect(second).rejects.toBeInstanceOf(IllustrationLedgerVersionConflictError)
        await expect(store.getTurn(created.turnId)).resolves.toMatchObject({
            state: 'awaiting_plan',
            version: 2,
        })
    })

    test('increments the durable worker epoch under the ledger lock', async () => {
        await expect(store.acquireWorkerEpoch()).resolves.toBe(1)
        await expect(store.acquireWorkerEpoch()).resolves.toBe(2)
    })
})

describe('manifest and job materialization', () => {
    test('advances manifest phases one step forward only', async () => {
        const { turn, leaseId } = await createClaimedTurn('turn-phase')
        const prepared = await store.createManifestPrepared({
            ...coordinatorProof,
            manifest: makeManifest('turn-phase'),
            turnExpectedVersion: turn.version,
            leaseId,
            fence: turn.fence,
            idempotencyKey: 'submit-phase',
        })
        const duplicate = await store.createManifestPrepared({
            ...coordinatorProof,
            manifest: makeManifest('turn-phase'),
            turnExpectedVersion: turn.version,
            leaseId,
            fence: turn.fence,
            idempotencyKey: 'submit-phase',
        })
        expect(duplicate).toEqual(prepared)
        await expect(
            store.advanceManifestPhase({
                turnId: turn.turnId,
                expectedVersion: prepared.version,
                to: 'records_complete',
            }),
        ).rejects.toBeInstanceOf(IllustrationLedgerCorruptError)
        await store.createJobsFromManifest({
            turnId: turn.turnId,
            expectedManifestVersion: prepared.version,
        })
        const complete = await store.advanceManifestPhase({
            turnId: turn.turnId,
            expectedVersion: prepared.version,
            to: 'records_complete',
        })
        const durable = await store.advanceManifestPhase({
            turnId: turn.turnId,
            expectedVersion: complete.version,
            to: 'projection_durable',
        })
        expect(durable).toMatchObject({ phase: 'projection_durable', version: 3 })
        await expect(
            store.advanceManifestPhase({
                turnId: turn.turnId,
                expectedVersion: durable.version,
                to: 'records_complete',
            }),
        ).rejects.toBeInstanceOf(IllustrationLedgerValidationError)
    })

    test('creates manifest jobs idempotently without duplicating the index', async () => {
        const turnId = 'turn-idempotent-jobs'
        const { turn, leaseId } = await createClaimedTurn(turnId)
        const manifest = await store.createManifestPrepared({
            ...coordinatorProof,
            manifest: makeManifest(turnId, 3),
            turnExpectedVersion: turn.version,
            leaseId,
            fence: turn.fence,
            idempotencyKey: 'submit-idempotent-jobs',
        })
        const first = await store.createJobsFromManifest({
            turnId,
            expectedManifestVersion: manifest.version,
        })
        const second = await store.createJobsFromManifest({
            turnId,
            expectedManifestVersion: manifest.version,
        })
        expect(second).toEqual(first)
        expect(second.every((job) => job.version === 1)).toBe(true)
        expect(decodeStored<string[]>(illustrationTurnJobsKey(turnId))).toEqual(
            manifest.jobs.map((job) => job.jobId),
        )

        const transitioned = await transition(first[0].jobId, 'awaiting_prompt')
        const recoveredAfterTransition = await store.createJobsFromManifest({
            turnId,
            expectedManifestVersion: manifest.version,
        })
        expect(recoveredAfterTransition[0]).toEqual(transitioned)
    })

    test('returns an identical manifest replay after lease expiry without accepting a mismatch', async () => {
        const turnId = 'manifest-replay-expired'
        const manifestInput = makeManifest(turnId)
        const { turn, leaseId } = await createClaimedTurn(turnId)
        const stored = await store.createManifestPrepared({
            ...coordinatorProof,
            manifest: manifestInput,
            turnExpectedVersion: turn.version,
            leaseId,
            fence: turn.fence,
            idempotencyKey: 'submit-expired-replay',
        })

        await advanceTimeKeepingCoordinatorOwned(TURN_LEASE_DURATION_MS + 1)
        await expect(
            store.createManifestPrepared({
                ...coordinatorProof,
                manifest: manifestInput,
                turnExpectedVersion: turn.version,
                leaseId,
                fence: turn.fence,
                idempotencyKey: 'submit-expired-replay',
            }),
        ).resolves.toEqual(stored)
        await expect(
            store.createManifestPrepared({
                ...coordinatorProof,
                manifest: { ...manifestInput, planHash: 'mismatching-plan' },
                turnExpectedVersion: turn.version,
                leaseId,
                fence: turn.fence,
                idempotencyKey: 'submit-expired-replay',
            }),
        ).rejects.toBeInstanceOf(IllustrationLedgerHolderMismatchError)
    })

    test('returns an identical manifest replay after the turn advances without accepting a mismatch', async () => {
        const turnId = 'manifest-replay-advanced'
        const manifestInput = makeManifest(turnId)
        const { turn, leaseId } = await createClaimedTurn(turnId)
        const stored = await store.createManifestPrepared({
            ...coordinatorProof,
            manifest: manifestInput,
            turnExpectedVersion: turn.version,
            leaseId,
            fence: turn.fence,
            idempotencyKey: 'submit-advanced-replay',
        })
        const advancedTurn = await store.updateTurn({
            turnId,
            expectedVersion: turn.version,
            mutate: (draft) => {
                draft.state = 'awaiting_prompt'
            },
        })

        await expect(
            store.createManifestPrepared({
                ...coordinatorProof,
                manifest: manifestInput,
                turnExpectedVersion: turn.version,
                leaseId,
                fence: turn.fence,
                idempotencyKey: 'submit-advanced-replay',
            }),
        ).resolves.toEqual(stored)
        await expect(
            store.createManifestPrepared({
                ...coordinatorProof,
                manifest: { ...manifestInput, planHash: 'mismatching-plan' },
                turnExpectedVersion: advancedTurn.version,
                leaseId,
                fence: turn.fence,
                idempotencyKey: 'submit-advanced-replay',
            }),
        ).rejects.toBeInstanceOf(IllustrationLedgerValidationError)
    })

    test('allows only a fully durable job replay to bypass an advanced manifest version', async () => {
        const turnId = 'jobs-replay-advanced-manifest'
        const { turn, leaseId } = await createClaimedTurn(turnId)
        const manifest = await store.createManifestPrepared({
            ...coordinatorProof,
            manifest: makeManifest(turnId, 2),
            turnExpectedVersion: turn.version,
            leaseId,
            fence: turn.fence,
            idempotencyKey: 'submit-jobs-replay',
        })
        const created = await store.createJobsFromManifest({
            turnId,
            expectedManifestVersion: manifest.version,
        })
        await store.advanceManifestPhase({
            turnId,
            expectedVersion: manifest.version,
            to: 'records_complete',
        })

        await expect(
            store.createJobsFromManifest({
                turnId,
                expectedManifestVersion: manifest.version,
            }),
        ).resolves.toEqual(created)

        storageMap.delete(illustrationTurnJobsKey(turnId))
        await expect(
            store.createJobsFromManifest({
                turnId,
                expectedManifestVersion: manifest.version,
            }),
        ).rejects.toBeInstanceOf(IllustrationLedgerVersionConflictError)
        expect(storageMap.has(illustrationTurnJobsKey(turnId))).toBe(false)
    })

    test('recovers missing records and rebuilds the index after a partial storage failure', async () => {
        const turnId = 'turn-partial-jobs'
        const { turn, leaseId } = await createClaimedTurn(turnId)
        const manifest = await store.createManifestPrepared({
            ...coordinatorProof,
            manifest: makeManifest(turnId, 3),
            turnExpectedVersion: turn.version,
            leaseId,
            fence: turn.fence,
            idempotencyKey: 'submit-partial-jobs',
        })
        storageControl.failSetKey = illustrationJobKey(jobIdFor(turnId, 1))
        storageControl.failSetCount = 1
        await expect(
            store.createJobsFromManifest({ turnId, expectedManifestVersion: manifest.version }),
        ).rejects.toThrow('injected set failure')
        expect(storageMap.has(illustrationJobKey(jobIdFor(turnId, 0)))).toBe(true)
        expect(storageMap.has(illustrationJobKey(jobIdFor(turnId, 1)))).toBe(false)
        expect(storageMap.has(illustrationTurnJobsKey(turnId))).toBe(false)

        const recovered = await store.createJobsFromManifest({
            turnId,
            expectedManifestVersion: manifest.version,
        })
        expect(recovered).toHaveLength(3)
        expect(decodeStored<string[]>(illustrationTurnJobsKey(turnId))).toEqual(
            manifest.jobs.map((job) => job.jobId),
        )
    })
})

describe('lease lifecycle and holder writes', () => {
    test('claims, renews, rejects an active rival, and fences an expired holder', async () => {
        const created = await store.createTurn({ turnId: 'turn-lease', idempotencyKey: 'create-lease' })
        const awaiting = await store.updateTurn({
            turnId: created.turnId,
            expectedVersion: created.version,
            mutate: (draft) => {
                draft.state = 'awaiting_plan'
            },
        })
        const claimed = await store.claimTurn({
            ...coordinatorProof,
            turnId: created.turnId,
            expectedVersion: awaiting.version,
            leaseId: 'holder-a',
        })
        expect(claimed).toMatchObject({ fence: 1, leaseId: 'holder-a' })
        expect(claimed.leaseExpiresAt).toBe(BASE_TIME + TURN_LEASE_DURATION_MS)

        vi.advanceTimersByTime(1_000)
        const renewed = await store.claimTurn({
            ...coordinatorProof,
            turnId: created.turnId,
            expectedVersion: claimed.version,
            leaseId: 'holder-a',
        })
        expect(renewed.fence).toBe(claimed.fence)
        expect(renewed.leaseExpiresAt).toBe(BASE_TIME + 1_000 + TURN_LEASE_DURATION_MS)
        await expect(
            store.claimTurn({
                ...coordinatorProof,
                turnId: created.turnId,
                expectedVersion: renewed.version,
                leaseId: 'holder-b',
            }),
        ).rejects.toBeInstanceOf(IllustrationLedgerLeaseConflictError)

        await advanceTimeKeepingCoordinatorOwned(TURN_LEASE_DURATION_MS)
        const reclaimed = await store.claimTurn({
            ...coordinatorProof,
            turnId: created.turnId,
            expectedVersion: renewed.version,
            leaseId: 'holder-b',
        })
        expect(reclaimed).toMatchObject({ fence: 2, leaseId: 'holder-b' })
        expect(() =>
            validateHolderWrite(reclaimed, {
                leaseId: reclaimed.leaseId!,
                expectedVersion: reclaimed.version,
                fence: renewed.fence,
            }),
        ).toThrow(IllustrationLedgerHolderMismatchError)
        expect(() =>
            validateHolderWrite(reclaimed, {
                leaseId: 'holder-a',
                expectedVersion: renewed.version,
                fence: renewed.fence,
            }),
        ).toThrow(IllustrationLedgerVersionConflictError)
        await expect(
            store.createManifestPrepared({
                ...coordinatorProof,
                manifest: makeManifest(created.turnId),
                turnExpectedVersion: reclaimed.version,
                leaseId: 'holder-a',
                fence: renewed.fence,
                idempotencyKey: 'late-plan-old-holder',
            }),
        ).rejects.toBeInstanceOf(IllustrationLedgerHolderMismatchError)
        await expect(
            store.createManifestPrepared({
                ...coordinatorProof,
                manifest: makeManifest(created.turnId),
                turnExpectedVersion: reclaimed.version,
                leaseId: 'holder-b',
                fence: renewed.fence,
                idempotencyKey: 'late-plan-stale-fence',
            }),
        ).rejects.toBeInstanceOf(IllustrationLedgerHolderMismatchError)
        expect(storageMap.has(illustrationManifestKey(created.turnId))).toBe(false)
    })

    test('accepts an exact holder lost-ACK replay after expiry but not changed provenance', async () => {
        const [prepared] = await createPreparedJobs('holder-replay-expired')
        const awaiting = await transition(prepared.jobId, 'awaiting_prompt')
        const leaseId = 'tagger:holder-replay-expired'
        const claimed = await store.claimJob({
            ...coordinatorProof,
            jobId: prepared.jobId,
            expectedVersion: awaiting.version,
            leaseId,
        })
        const patch = {
            idempotencyKey: 'supply:holder-replay-expired',
            prompt: flatPrompt('positive', 'negative'),
        }
        const queued = await store.transitionJob({
            ...coordinatorProof,
            jobId: prepared.jobId,
            expectedVersion: claimed.version,
            to: 'queued',
            leaseId,
            fence: claimed.fence,
            patch,
        })

        await advanceTimeKeepingCoordinatorOwned(JOB_LEASE_DURATION_MS + 1)
        await expect(
            store.transitionJob({
                ...coordinatorProof,
                jobId: prepared.jobId,
                expectedVersion: claimed.version,
                to: 'queued',
                leaseId,
                fence: claimed.fence,
                patch,
            }),
        ).resolves.toEqual(queued)
        await expect(
            store.transitionJob({
                ...coordinatorProof,
                jobId: prepared.jobId,
                expectedVersion: claimed.version,
                to: 'queued',
                leaseId,
                fence: claimed.fence,
                patch: { idempotencyKey: patch.idempotencyKey },
            }),
        ).rejects.toBeInstanceOf(IllustrationLedgerCorruptError)
        await expect(
            store.transitionJob({
                ...coordinatorProof,
                jobId: prepared.jobId,
                expectedVersion: claimed.version,
                to: 'queued',
                leaseId,
                fence: claimed.fence + 1,
                patch,
            }),
        ).rejects.toBeInstanceOf(IllustrationLedgerHolderMismatchError)

        await transition(prepared.jobId, 'generating', {
            attemptId: 'attempt:holder-replay-expired',
            assetId: 'asset:holder-replay-expired',
        })
        await expect(
            store.transitionJob({
                ...coordinatorProof,
                jobId: prepared.jobId,
                expectedVersion: claimed.version,
                to: 'queued',
                leaseId,
                fence: claimed.fence,
                patch,
            }),
        ).rejects.toBeInstanceOf(IllustrationLedgerVersionConflictError)
    })

    test('renews an expired same bearer as a fenced reclaim', async () => {
        const { turn, leaseId } = await createClaimedTurn('turn-same-bearer-reclaim')
        await advanceTimeKeepingCoordinatorOwned(TURN_LEASE_DURATION_MS)
        const reclaimed = await store.claimTurn({
            ...coordinatorProof,
            turnId: turn.turnId,
            expectedVersion: turn.version,
            leaseId,
        })
        expect(reclaimed.fence).toBe(turn.fence + 1)
        expect(() =>
            validateHolderWrite(reclaimed, {
                leaseId,
                expectedVersion: reclaimed.version,
                fence: turn.fence,
            }),
        ).toThrow(IllustrationLedgerHolderMismatchError)
    })

    test('deduplicates a lost-ACK Tagger write and rejects conflicting reuse', async () => {
        const [prepared] = await createPreparedJobs('turn-holder-idempotency')
        const awaiting = await transition(prepared.jobId, 'awaiting_prompt')
        const leaseId = 'tagger-holder'
        const claimed = await store.claimJob({
            ...coordinatorProof,
            jobId: prepared.jobId,
            expectedVersion: awaiting.version,
            leaseId,
        })
        expect(claimed.leaseExpiresAt).toBe(BASE_TIME + JOB_LEASE_DURATION_MS)
        const input = {
            ...coordinatorProof,
            jobId: prepared.jobId,
            expectedVersion: claimed.version,
            to: 'queued' as const,
            leaseId,
            fence: claimed.fence,
            patch: {
                idempotencyKey: 'supply-once',
                prompt: flatPrompt('positive', 'negative'),
            },
        }
        const written = await store.transitionJob(input)
        const duplicate = await store.transitionJob(input)
        expect(duplicate).toEqual(written)
        expect(duplicate.version).toBe(claimed.version + 1)
        await expect(
            store.transitionJob({
                jobId: input.jobId,
                expectedVersion: input.expectedVersion,
                to: input.to,
                patch: input.patch,
            }),
        ).rejects.toBeInstanceOf(IllustrationLedgerHolderMismatchError)

        await expect(
            store.transitionJob({
                ...input,
                patch: {
                    ...input.patch,
                    prompt: flatPrompt('different', 'negative'),
                },
            }),
        ).rejects.toBeInstanceOf(IllustrationLedgerCorruptError)
    })
})

describe('cancellation intent', () => {
    test('maps all immediate states and keeps asset_writing as an intent-only write', async () => {
        const prepared = await createJobAtState('cancel-prepared', 'prepared')
        await expect(
            store.transitionJob({
                jobId: prepared.jobId,
                expectedVersion: prepared.version,
                to: 'cancelled',
                patch: { idempotencyKey: 'bypass-request-cancel' },
            }),
        ).rejects.toBeInstanceOf(IllustrationLedgerValidationError)
        await expect(
            store.requestCancel({ jobId: prepared.jobId, expectedVersion: prepared.version }),
        ).resolves.toMatchObject({ state: 'cancelled', cancelRequestedAt: BASE_TIME })

        const awaiting = await createJobAtState('cancel-awaiting', 'awaiting_prompt')
        await expect(
            store.requestCancel({ jobId: awaiting.jobId, expectedVersion: awaiting.version }),
        ).resolves.toMatchObject({ state: 'cancelled' })

        const queued = await createJobAtState('cancel-queued', 'queued')
        await expect(
            store.requestCancel({ jobId: queued.jobId, expectedVersion: queued.version }),
        ).resolves.toMatchObject({ state: 'cancelled' })

        const blocked = await createJobAtState('cancel-blocked', 'blocked_config')
        await expect(
            store.requestCancel({ jobId: blocked.jobId, expectedVersion: blocked.version }),
        ).resolves.toMatchObject({ state: 'cancelled' })

        const writing = await createJobAtState('cancel-writing', 'asset_writing')
        const intentOnly = await store.requestCancel({
            jobId: writing.jobId,
            expectedVersion: writing.version,
        })
        expect(intentOnly).toMatchObject({
            state: 'asset_writing',
            cancelRequestedAt: BASE_TIME,
            version: writing.version + 1,
        })

        const ready = await createJobAtState('cancel-ready', 'asset_ready')
        await expect(
            store.requestCancel({ jobId: ready.jobId, expectedVersion: ready.version }),
        ).resolves.toMatchObject({ state: 'cancelled' })

        const committing = await createJobAtState('cancel-committing', 'committing')
        await expect(
            store.requestCancel({ jobId: committing.jobId, expectedVersion: committing.version }),
        ).rejects.toBeInstanceOf(IllustrationLedgerValidationError)
    })

    test('persists one cancelRequestedAt through writing and refuses a cancelled commit', async () => {
        const generating = await createJobAtState('cancel-generating', 'generating')
        await expect(
            store.transitionJob({
                jobId: generating.jobId,
                expectedVersion: generating.version,
                to: 'cancel_requested',
                patch: { idempotencyKey: 'bypass-generating-cancel' },
            }),
        ).rejects.toBeInstanceOf(IllustrationLedgerValidationError)
        const requested = await store.requestCancel({
            jobId: generating.jobId,
            expectedVersion: generating.version,
        })
        expect(requested).toMatchObject({ state: 'cancel_requested', cancelRequestedAt: BASE_TIME })
        const duplicate = await store.requestCancel({
            jobId: generating.jobId,
            expectedVersion: requested.version,
        })
        expect(duplicate).toEqual(requested)

        const writing = await transition(generating.jobId, 'asset_writing')
        const ready = await transition(generating.jobId, 'asset_ready')
        expect(writing.cancelRequestedAt).toBe(BASE_TIME)
        expect(ready.cancelRequestedAt).toBe(BASE_TIME)
        await expect(
            transition(generating.jobId, 'committing'),
        ).rejects.toBeInstanceOf(IllustrationLedgerValidationError)
        const cancelled = await store.requestCancel({
            jobId: generating.jobId,
            expectedVersion: ready.version,
        })
        expect(cancelled).toMatchObject({ state: 'cancelled', cancelRequestedAt: BASE_TIME })
    })
})

describe('fail-closed Web Locks behavior', () => {
    test('rejects every public store operation when Web Locks are unavailable', async () => {
        storageMap.clear()
        setIllustrationLockManagerAccessorForTests(() => undefined)
        const manifest = makeManifest('no-lock')
        const operations: Array<() => Promise<unknown>> = [
            () => store.createTurn({ turnId: 'no-lock', idempotencyKey: 'create' }),
            () => store.getTurn('no-lock'),
            () => store.listTurns(),
            () =>
                store.updateTurn({
                    turnId: 'no-lock',
                    expectedVersion: 1,
                    mutate: () => undefined,
                }),
            () =>
                store.createManifestPrepared({
                    ...coordinatorProof,
                    manifest,
                    turnExpectedVersion: 1,
                    leaseId: 'lease',
                    fence: 1,
                    idempotencyKey: 'submit',
                }),
            () => store.getManifest('no-lock'),
            () =>
                store.advanceManifestPhase({
                    turnId: 'no-lock',
                    expectedVersion: 1,
                    to: 'records_complete',
                }),
            () =>
                store.createJobsFromManifest({
                    turnId: 'no-lock',
                    expectedManifestVersion: 1,
                }),
            () => store.getJob(jobIdFor('no-lock')),
            () => store.listJobs(),
            () => store.listJobRecords(),
            () => store.listPendingTurns(),
            () =>
                store.transitionJob({
                    jobId: jobIdFor('no-lock'),
                    expectedVersion: 1,
                    to: 'cancelled',
                    patch: { idempotencyKey: 'cancel' },
                }),
            () => store.requestCancel({ jobId: jobIdFor('no-lock'), expectedVersion: 1 }),
            () => store.requestCancelTurn({ turnId: 'no-lock', expectedVersion: 1 }),
            () => store.closeTurnFromPlan({
                ...coordinatorProof,
                turnId: 'no-lock',
                expectedVersion: 1,
                leaseId: 'lease',
                fence: 1,
                to: 'stale',
                code: 'test',
                idempotencyKey: 'close',
            }),
            () => store.claimTurn({
                ...coordinatorProof,
                turnId: 'no-lock',
                expectedVersion: 1,
                leaseId: 'lease',
            }),
            () => store.claimJob({
                ...coordinatorProof,
                jobId: jobIdFor('no-lock'),
                expectedVersion: 1,
                leaseId: 'lease',
            }),
            () => store.claimTurnSnapshot({
                ...coordinatorProof,
                turnId: 'no-lock',
                expectedVersion: 1,
                leaseId: 'lease',
            }),
            () => store.claimJobSnapshot({
                ...coordinatorProof,
                jobId: jobIdFor('no-lock'),
                expectedVersion: 1,
                leaseId: 'lease',
            }),
            () => store.reportAgentFailure({
                protocolVersion: 1,
                kind: 'turn',
                id: 'no-lock',
                expectedVersion: 1,
                leaseId: 'lease',
                fence: 1,
                ...coordinatorProof,
                idempotencyKey: 'failure',
                code: 'test',
                retryable: true,
            }),
            () => store.retryAgentFailure({
                protocolVersion: 1,
                kind: 'turn',
                id: 'no-lock',
                expectedVersion: 1,
                confirmNewLlmCharge: true,
                ...coordinatorProof,
            }),
            () => store.acquireWorkerEpoch(),
            () =>
                store.retryUncertainJob({
                    jobId: jobIdFor('no-lock'),
                    expectedVersion: 1,
                    confirmNewCharge: true,
                }),
            () => store.pruneTerminalRecords(),
        ]

        for (const operation of operations) {
            await expect(operation()).rejects.toBeInstanceOf(IllustrationLedgerUnavailableError)
        }
        expect(storageMap.size).toBe(0)
    })
})

describe('manifest bounds', () => {
    async function expectManifestRejectedWithoutWrite(
        turnId: string,
        manifest: Omit<PlanManifestV1, 'phase' | 'version'>,
    ): Promise<void> {
        const { turn, leaseId } = await createClaimedTurn(turnId)
        const beforeKeys = [...storageMap.keys()].sort()
        await expect(
            store.createManifestPrepared({
                ...coordinatorProof,
                manifest,
                turnExpectedVersion: turn.version,
                leaseId,
                fence: turn.fence,
                idempotencyKey: `submit:${turnId}`,
            }),
        ).rejects.toBeInstanceOf(IllustrationLedgerValidationError)
        expect([...storageMap.keys()].sort()).toEqual(beforeKeys)
        expect(storageMap.has(illustrationManifestKey(turnId))).toBe(false)
    }

    test('accepts 15 jobs and rejects the 16th before writing', async () => {
        const acceptedTurnId = 'bounds-fifteen'
        const { turn, leaseId } = await createClaimedTurn(acceptedTurnId)
        const accepted = await store.createManifestPrepared({
            ...coordinatorProof,
            manifest: makeManifest(acceptedTurnId, MAX_JOBS_PER_TURN),
            turnExpectedVersion: turn.version,
            leaseId,
            fence: turn.fence,
            idempotencyKey: 'submit-fifteen',
        })
        expect(accepted.jobs).toHaveLength(15)

        await expectManifestRejectedWithoutWrite(
            'bounds-sixteen',
            makeManifest('bounds-sixteen', MAX_JOBS_PER_TURN + 1),
        )
    })

    test('rejects an oversized scene payload before writing', async () => {
        await expectManifestRejectedWithoutWrite(
            'bounds-scene',
            makeManifest('bounds-scene', 1, () => 'x'.repeat(17_000)),
        )
    })

    test('rejects a plan over 192 KiB even when each scene is under 16 KiB', async () => {
        await expectManifestRejectedWithoutWrite(
            'bounds-plan',
            makeManifest('bounds-plan', 15, () => 'x'.repeat(13_500)),
        )
    })

    test('rejects non-JSON scene data with a typed error before writing', async () => {
        const cycle: Record<string, unknown> = {}
        cycle.self = cycle
        const invalidValues: unknown[] = [
            Number.NaN,
            new Date(0),
            undefined,
            () => 'not-json',
            1n,
            cycle,
        ]
        for (let index = 0; index < invalidValues.length; index += 1) {
            const turnId = `bounds-json-${index}`
            await expectManifestRejectedWithoutWrite(
                turnId,
                makeManifest(turnId, 1, () => invalidValues[index]),
            )
        }
    })

    test('does not allow a transition patch to rewrite manifest scenePayload', async () => {
        const [prepared] = await createPreparedJobs('immutable-scene-payload')
        await expect(
            store.transitionJob({
                jobId: prepared.jobId,
                expectedVersion: prepared.version,
                to: 'awaiting_prompt',
                patch: {
                    idempotencyKey: 'rewrite-scene',
                    scenePayload: { schemaVersion: 1, data: { changed: true } },
                } as IllustrationJobTransitionPatch,
            }),
        ).rejects.toBeInstanceOf(IllustrationLedgerValidationError)
    })
})

describe('retention pruning', () => {
    test('deletes old prunable jobs within the bound and protects active and uncertain jobs', async () => {
        const cancelledA = await createJobAtState('prune-cancelled-a', 'prepared')
        await store.requestCancel({ jobId: cancelledA.jobId, expectedVersion: cancelledA.version })
        const cancelledB = await createJobAtState('prune-cancelled-b', 'prepared')
        await store.requestCancel({ jobId: cancelledB.jobId, expectedVersion: cancelledB.version })
        const active = await createJobAtState('prune-active', 'prepared')
        const uncertain = await createJobAtState('prune-uncertain', 'uncertain')

        vi.advanceTimersByTime(TERMINAL_RECORD_TTL_MS + 1)
        const first = await store.pruneTerminalRecords({ maxDeletes: 1 })
        expect(first.deletedJobIds).toHaveLength(1)
        expect([cancelledA.jobId, cancelledB.jobId]).toContain(first.deletedJobIds[0])
        const deletedTurnId = first.deletedJobIds[0].split(':job:')[0]
        expect(decodeStored<string[]>(illustrationTurnJobsKey(deletedTurnId))).toEqual([])
        expect(await store.getJob(active.jobId)).not.toBeNull()
        expect(await store.getJob(uncertain.jobId)).not.toBeNull()

        const second = await store.pruneTerminalRecords({ maxDeletes: 10 })
        expect(second.deletedJobIds).toHaveLength(1)
        expect(await store.getJob(active.jobId)).not.toBeNull()
        expect(await store.getJob(uncertain.jobId)).toMatchObject({ state: 'uncertain' })
    })

    test('keeps the latest 200 terminal turns and protects an older turn with an active job', async () => {
        const makeTerminalTurn = (turnId: string, updatedAt: number): IllustrationTurnRecordV1 => ({
            schemaVersion: 1,
            turnId,
            state: 'completed',
            version: 1,
            leaseId: null,
            leaseExpiresAt: 0,
            fence: 0,
            workerEpoch: 0,
            agentAttemptCount: 0,
            updatedAt,
            idempotencyKey: `create:${turnId}`,
        })
        for (let index = 0; index <= 200; index += 1) {
            const turnId = `summary-${index}`
            encodeStored(illustrationTurnKey(turnId), makeTerminalTurn(turnId, BASE_TIME + index))
        }

        const guardedTurnId = 'summary-guarded-active'
        const guardedJobId = jobIdFor(guardedTurnId)
        encodeStored(
            illustrationTurnKey(guardedTurnId),
            makeTerminalTurn(guardedTurnId, BASE_TIME - 1),
        )
        encodeStored(illustrationJobKey(guardedJobId), {
            schemaVersion: 1,
            turnId: guardedTurnId,
            jobId: guardedJobId,
            slotToken: 'guarded-slot',
            insertAfterUtf16: 0,
            sceneId: 'guarded-scene',
            scenePayload: { schemaVersion: 1, data: {} },
            sourceRevisionHash: 'guarded-source',
            slotOrdinal: 0,
            createdAt: BASE_TIME - 1,
            state: 'prepared',
            version: 1,
            leaseId: null,
            leaseExpiresAt: 0,
            fence: 0,
            workerEpoch: 0,
            agentAttemptCount: 0,
            updatedAt: BASE_TIME - 1,
            idempotencyKey: 'guarded-create',
            creationIdempotencyKey: 'guarded-create',
        } satisfies IllustrationJobRecordV1)
        encodeStored(illustrationTurnJobsKey(guardedTurnId), [guardedJobId])

        vi.advanceTimersByTime(TERMINAL_RECORD_TTL_MS + 1_000)
        const result = await store.pruneTerminalRecords({ maxDeletes: 10 })
        expect(result.deletedTurnIds).toEqual(['summary-0'])
        expect(await store.getTurn('summary-0')).toBeNull()
        expect(await store.getTurn('summary-1')).not.toBeNull()
        expect(await store.getTurn('summary-200')).not.toBeNull()
        expect(await store.getTurn(guardedTurnId)).not.toBeNull()
        expect(await store.getJob(guardedJobId)).toMatchObject({ state: 'prepared' })
    })

    test('deletes a terminal turn with its manifest and index as one budgeted group', async () => {
        const terminalTurn = (turnId: string, updatedAt: number): IllustrationTurnRecordV1 => ({
            schemaVersion: 1,
            turnId,
            state: 'completed',
            version: 1,
            leaseId: null,
            leaseExpiresAt: 0,
            fence: 0,
            workerEpoch: 0,
            agentAttemptCount: 0,
            updatedAt,
            idempotencyKey: `create:${turnId}`,
        })
        const targetTurnId = 'prune-group-target'
        encodeStored(illustrationTurnKey(targetTurnId), terminalTurn(targetTurnId, BASE_TIME))
        encodeStored(illustrationManifestKey(targetTurnId), {
            ...makeManifest(targetTurnId),
            phase: 'prepared',
            version: 1,
            updatedAt: BASE_TIME,
            idempotencyKey: 'submit:prune-group-target',
        })
        encodeStored(illustrationTurnJobsKey(targetTurnId), null)
        for (let index = 0; index < 200; index += 1) {
            const turnId = `prune-group-protected-${index}`
            encodeStored(illustrationTurnKey(turnId), terminalTurn(turnId, BASE_TIME + index + 1))
        }

        vi.advanceTimersByTime(TERMINAL_RECORD_TTL_MS + 1_000)
        for (const maxDeletes of [1, 2]) {
            const result = await store.pruneTerminalRecords({ maxDeletes })
            expect(result.deletedTurnIds).toEqual([])
            expect(storageMap.has(illustrationTurnKey(targetTurnId))).toBe(true)
            expect(storageMap.has(illustrationManifestKey(targetTurnId))).toBe(true)
            expect(storageMap.has(illustrationTurnJobsKey(targetTurnId))).toBe(true)
        }

        const removed = await store.pruneTerminalRecords({ maxDeletes: 3 })
        expect(removed.deletedTurnIds).toEqual([targetTurnId])
        expect(storageMap.has(illustrationTurnKey(targetTurnId))).toBe(false)
        expect(storageMap.has(illustrationManifestKey(targetTurnId))).toBe(false)
        expect(storageMap.has(illustrationTurnJobsKey(targetTurnId))).toBe(false)
    })

    test('sweeps orphan manifest and index keys within the physical delete budget', async () => {
        const turnId = 'prune-orphan'
        encodeStored(illustrationManifestKey(turnId), null)
        encodeStored(illustrationTurnJobsKey(turnId), [])

        await store.pruneTerminalRecords({ olderThanMs: 0, maxDeletes: 1 })
        expect(
            Number(storageMap.has(illustrationManifestKey(turnId))) +
                Number(storageMap.has(illustrationTurnJobsKey(turnId))),
        ).toBe(1)
        await store.pruneTerminalRecords({ olderThanMs: 0, maxDeletes: 1 })
        expect(storageMap.has(illustrationManifestKey(turnId))).toBe(false)
        expect(storageMap.has(illustrationTurnJobsKey(turnId))).toBe(false)
    })

    test('never sweeps manifest or index keys belonging to a live turn', async () => {
        const turnId = 'prune-live-dependencies'
        await store.createTurn({ turnId, idempotencyKey: 'create:prune-live-dependencies' })
        encodeStored(illustrationManifestKey(turnId), {
            ...makeManifest(turnId),
            phase: 'prepared',
            version: 1,
            updatedAt: BASE_TIME,
            idempotencyKey: 'submit:prune-live-dependencies',
        })
        encodeStored(illustrationTurnJobsKey(turnId), [])

        await store.pruneTerminalRecords({ olderThanMs: 0, maxDeletes: 10 })
        expect(storageMap.has(illustrationManifestKey(turnId))).toBe(true)
        expect(storageMap.has(illustrationTurnJobsKey(turnId))).toBe(true)
    })
})

describe('manual uncertain retry', () => {
    test('requires confirmation and creates fresh attempt, asset, and idempotency identifiers', async () => {
        const uncertain = await createJobAtState('retry-uncertain', 'uncertain')
        await expect(
            store.retryUncertainJob({
                jobId: uncertain.jobId,
                expectedVersion: uncertain.version,
                confirmNewCharge: false as true,
            }),
        ).rejects.toBeInstanceOf(IllustrationLedgerConfirmationRequiredError)

        const retried = await store.retryUncertainJob({
            jobId: uncertain.jobId,
            expectedVersion: uncertain.version,
            confirmNewCharge: true,
        })
        expect(retried).toMatchObject({ state: 'queued', version: uncertain.version + 1 })
        expect(retried.attemptId).not.toBe(uncertain.attemptId)
        expect(retried.assetId).not.toBe(uncertain.assetId)
        expect(retried.idempotencyKey).not.toBe(uncertain.idempotencyKey)
        await expect(
            store.retryUncertainJob({
                jobId: uncertain.jobId,
                expectedVersion: uncertain.version,
                confirmNewCharge: true,
            }),
        ).resolves.toEqual(retried)

        const prepared = await createJobAtState('retry-prepared', 'prepared')
        await expect(
            store.retryUncertainJob({
                jobId: prepared.jobId,
                expectedVersion: prepared.version,
                confirmNewCharge: true,
            }),
        ).rejects.toBeInstanceOf(IllustrationLedgerValidationError)
    })

    test('does not mistake an arbitrary retry-prefixed Tagger key for retry provenance', async () => {
        const [prepared] = await createPreparedJobs('retry-prefix-spoof')
        const awaiting = await transition(prepared.jobId, 'awaiting_prompt')
        const leaseId = 'retry-prefix-tagger'
        const claimed = await store.claimJob({
            ...coordinatorProof,
            jobId: prepared.jobId,
            expectedVersion: awaiting.version,
            leaseId,
        })
        const queued = await store.transitionJob({
            ...coordinatorProof,
            jobId: prepared.jobId,
            expectedVersion: claimed.version,
            to: 'queued',
            leaseId,
            fence: claimed.fence,
            patch: {
                idempotencyKey: 'retry:spoof',
                prompt: flatPrompt('positive', 'negative'),
            },
        })
        await expect(
            store.retryUncertainJob({
                jobId: queued.jobId,
                expectedVersion: claimed.version,
                confirmNewCharge: true,
            }),
        ).rejects.toBeInstanceOf(IllustrationLedgerVersionConflictError)
    })

    test('clears inherited cancellation intent before a fresh paid attempt', async () => {
        const generating = await createJobAtState('retry-cancelled-uncertain', 'generating')
        const cancelRequested = await store.requestCancel({
            jobId: generating.jobId,
            expectedVersion: generating.version,
        })
        const uncertain = await transition(generating.jobId, 'uncertain', {
            error: { code: 'provider_timeout', certainty: 'uncertain' },
        })
        expect(cancelRequested.cancelRequestedAt).toBe(BASE_TIME)
        expect(uncertain).toMatchObject({
            state: 'uncertain',
            cancelRequestedAt: BASE_TIME,
        })

        const retried = await store.retryUncertainJob({
            jobId: generating.jobId,
            expectedVersion: uncertain.version,
            confirmNewCharge: true,
        })
        expect(retried.state).toBe('queued')
        expect(retried.cancelRequestedAt).toBeUndefined()
        await transition(generating.jobId, 'generating')
        await transition(generating.jobId, 'asset_writing')
        await transition(generating.jobId, 'asset_ready')
        await expect(transition(generating.jobId, 'committing')).resolves.toMatchObject({
            state: 'committing',
        })
    })
})

describe('index representation', () => {
    test('stores a small per-turn string array instead of a whole queue record', async () => {
        const turnId = 'index-shape'
        await createPreparedJobs(turnId, makeManifest(turnId, 2))
        const index = decodeStored<unknown>(illustrationTurnJobsKey(turnId))
        expect(index).toEqual([jobIdFor(turnId, 0), jobIdFor(turnId, 1)])
        expect(storageMap.has(illustrationTurnKey(turnId))).toBe(true)
        expect(storageMap.has(illustrationJobKey(jobIdFor(turnId, 0)))).toBe(true)
    })
})

describe('Gate 4a snapshots and outstanding Agent states', () => {
    function storedJob(
        jobId: string,
        state: IllustrationJobState,
        options: { slotOrdinal?: number; createdAt?: number; updatedAt?: number } = {},
    ): IllustrationJobRecordV1 {
        const turnId = `turn:${jobId}`
        const createdAt = options.createdAt ?? BASE_TIME
        return {
            schemaVersion: 1,
            turnId,
            jobId,
            slotToken: `slot:${jobId}`,
            insertAfterUtf16: options.slotOrdinal ?? 0,
            sceneId: `scene:${jobId}`,
            scenePayload: { schemaVersion: 1, data: { secret: `payload:${jobId}` } },
            sourceRevisionHash: `source:${jobId}`,
            slotOrdinal: options.slotOrdinal ?? 0,
            createdAt,
            state,
            version: 1,
            leaseId: null,
            leaseExpiresAt: 0,
            fence: 0,
            workerEpoch: 0,
            updatedAt: options.updatedAt ?? createdAt,
            idempotencyKey: `state:${jobId}`,
            agentAttemptCount: state.startsWith('agent_blocked') ? 1 : 0,
            creationIdempotencyKey: `create:${jobId}`,
            prompt: { positive: `positive:${jobId}`, negative: `negative:${jobId}` },
        }
    }

    function storedTurn(
        turnId: string,
        state: IllustrationTurnRecordV1['state'],
    ): IllustrationTurnRecordV1 {
        return {
            schemaVersion: 1,
            turnId,
            state,
            version: 1,
            leaseId: null,
            leaseExpiresAt: 0,
            fence: 0,
            workerEpoch: 0,
            updatedAt: BASE_TIME,
            idempotencyKey: `create:${turnId}`,
            agentAttemptCount: state.startsWith('agent_blocked') ? 1 : 0,
        }
    }

    test('assigns immutable slot ordinals by offset then manifest order and lists stably', async () => {
        const turnId = 'slot-order'
        const { turn, leaseId } = await createClaimedTurn(turnId)
        const baseManifest = makeManifest(turnId, 4)
        const offsets = [8, 2, 2, 5]
        const manifest = await store.createManifestPrepared({
            ...coordinatorProof,
            manifest: {
                ...baseManifest,
                jobs: baseManifest.jobs.map((job, index) => ({
                    ...job,
                    insertAfterUtf16: offsets[index],
                })),
            },
            turnExpectedVersion: turn.version,
            leaseId,
            fence: turn.fence,
            idempotencyKey: 'submit:slot-order',
        })
        const jobs = await store.createJobsFromManifest({
            turnId,
            expectedManifestVersion: manifest.version,
        })
        expect(jobs.map((job) => [job.jobId, job.slotOrdinal])).toEqual([
            [jobIdFor(turnId, 0), 3],
            [jobIdFor(turnId, 1), 0],
            [jobIdFor(turnId, 2), 1],
            [jobIdFor(turnId, 3), 2],
        ])
        const createdAt = jobs[1].createdAt
        await transition(jobs[1].jobId, 'awaiting_prompt')
        expect((await store.getJob(jobs[1].jobId))?.createdAt).toBe(createdAt)
        const snapshots = await store.listJobs({ turnId })
        expect(snapshots.map((job) => job.jobId)).toEqual([
            jobIdFor(turnId, 1),
            jobIdFor(turnId, 2),
            jobIdFor(turnId, 3),
            jobIdFor(turnId, 0),
        ])
    })

    test('orders snapshots by slot ordinal, then creation time, then job id', async () => {
        storageMap.clear()
        const records = [
            storedJob('sort:later', 'queued', { slotOrdinal: 0, createdAt: BASE_TIME + 1 }),
            storedJob('sort:b', 'queued', { slotOrdinal: 0, createdAt: BASE_TIME }),
            storedJob('sort:a', 'queued', { slotOrdinal: 0, createdAt: BASE_TIME }),
            storedJob('sort:next-slot', 'queued', { slotOrdinal: 1, createdAt: BASE_TIME - 1 }),
        ]
        for (const record of records) {
            encodeStored(illustrationJobKey(record.jobId), record)
        }

        expect((await store.listJobs()).map((record) => record.jobId)).toEqual([
            'sort:a',
            'sort:b',
            'sort:later',
            'sort:next-slot',
        ])
    })

    test('returns all live and uncertain jobs plus only 50 sanitized recent terminal summaries', async () => {
        storageMap.clear()
        for (let index = 0; index < 60; index += 1) {
            const record = storedJob(`terminal:${index}`, 'committed', {
                slotOrdinal: index % 15,
                createdAt: BASE_TIME + index,
                updatedAt: BASE_TIME + index,
            })
            if (index === 59) {
                record.error = {
                    code: 'terminal_error',
                    message: 'sensitive provider detail',
                    retryable: false,
                }
                record.target = {
                    chaId: 'character-1',
                    conversationId: 'conversation-1',
                    expectedMessageId: 'message-1',
                    rootTurnId: 'root-1',
                    requestNonce: 'request-secret',
                    slotToken: 'slot-secret',
                    capturedSwipeHint: 0,
                    sourceRevisionHash: 'source-secret',
                }
            }
            encodeStored(illustrationJobKey(record.jobId), record)
        }
        const fullStates: IllustrationJobState[] = [
            'prepared',
            'awaiting_prompt',
            'agent_blocked_retryable',
            'agent_blocked',
            'queued',
            'generating',
            'cancel_requested',
            'blocked_config',
            'asset_writing',
            'asset_ready',
            'committing',
            'uncertain',
        ]
        for (const [index, state] of fullStates.entries()) {
            const record = storedJob(`full:${state}`, state, {
                slotOrdinal: index,
                createdAt: BASE_TIME + 100 + index,
            })
            encodeStored(illustrationJobKey(record.jobId), record)
        }

        const snapshots = await store.listJobs()
        expect(snapshots).toHaveLength(50 + fullStates.length)
        for (const state of fullStates) {
            const full = snapshots.find((entry) => entry.jobId === `full:${state}`)!
            expect(full).toHaveProperty('scenePayload')
            expect(full).toMatchObject({ state, hasDurablePrompt: true })
        }
        const summaries = snapshots.filter((entry) => entry.state === 'committed')
        expect(summaries).toHaveLength(50)
        expect(summaries.some((entry) => entry.jobId === 'terminal:9')).toBe(false)
        expect(summaries.some((entry) => entry.jobId === 'terminal:10')).toBe(true)
        for (const summary of summaries) {
            expect(summary).not.toHaveProperty('scenePayload')
            expect(summary).not.toHaveProperty('prompt')
            expect(summary).not.toHaveProperty('hasDurablePrompt')
        }
        const redacted = summaries.find((entry) => entry.jobId === 'terminal:59')!
        expect(redacted.error).toEqual({ code: 'terminal_error' })
        expect(redacted.target).toEqual({
            chaId: 'character-1',
            conversationId: 'conversation-1',
            expectedMessageId: 'message-1',
            rootTurnId: 'root-1',
        })
        expect(JSON.stringify(redacted)).not.toContain('sensitive provider detail')
        expect(JSON.stringify(redacted)).not.toContain('request-secret')
    })

    test('keeps a 200-turn by 15-job terminal history well under 1 MiB', async () => {
        storageMap.clear()
        for (let turnIndex = 0; turnIndex < 200; turnIndex += 1) {
            for (let slotOrdinal = 0; slotOrdinal < 15; slotOrdinal += 1) {
                const jobId = `history:${turnIndex}:${slotOrdinal}`
                const record = storedJob(jobId, 'committed', {
                    slotOrdinal,
                    createdAt: BASE_TIME + turnIndex,
                    updatedAt: BASE_TIME + turnIndex * 15 + slotOrdinal,
                })
                encodeStored(illustrationJobKey(jobId), record)
            }
        }
        const snapshots = await store.listJobs()
        const byteLength = new TextEncoder().encode(JSON.stringify(snapshots)).byteLength
        expect(snapshots).toHaveLength(50)
        expect(byteLength).toBeLessThan(128 * 1024)
    })

    test('lists Agent-blocked turns and never prunes blocked turn or job records', async () => {
        storageMap.clear()
        for (const state of ['agent_blocked_retryable', 'agent_blocked'] as const) {
            const turn = storedTurn(`pending:${state}`, state)
            const job = storedJob(`outstanding:${state}`, state)
            encodeStored(illustrationTurnKey(turn.turnId), turn)
            encodeStored(illustrationJobKey(job.jobId), job)
        }
        const pending = await store.listPendingTurns()
        expect(pending.map((turn) => turn.state).sort()).toEqual([
            'agent_blocked',
            'agent_blocked_retryable',
        ])

        vi.advanceTimersByTime(TERMINAL_RECORD_TTL_MS + 1)
        const result = await store.pruneTerminalRecords({ maxDeletes: 100 })
        expect(result).toEqual({ deletedJobIds: [], deletedTurnIds: [] })
        expect(await store.getTurn('pending:agent_blocked')).not.toBeNull()
        expect(await store.getJob('outstanding:agent_blocked_retryable')).not.toBeNull()
    })
})

describe('bounded snapshot reads (bulk read fan-out)', () => {
    function bulkStoredJob(
        jobId: string,
        state: IllustrationJobState,
        options: {
            turnId?: string
            slotOrdinal?: number
            createdAt?: number
            updatedAt?: number
        } = {},
    ): IllustrationJobRecordV1 {
        const createdAt = options.createdAt ?? BASE_TIME
        return {
            schemaVersion: 1,
            turnId: options.turnId ?? `turn:${jobId}`,
            jobId,
            slotToken: `slot:${jobId}`,
            insertAfterUtf16: options.slotOrdinal ?? 0,
            sceneId: `scene:${jobId}`,
            scenePayload: { schemaVersion: 1, data: { secret: `payload:${jobId}` } },
            sourceRevisionHash: `source:${jobId}`,
            slotOrdinal: options.slotOrdinal ?? 0,
            createdAt,
            state,
            version: 1,
            leaseId: null,
            leaseExpiresAt: 0,
            fence: 0,
            workerEpoch: 0,
            updatedAt: options.updatedAt ?? createdAt,
            idempotencyKey: `state:${jobId}`,
            agentAttemptCount: state.startsWith('agent_blocked') ? 1 : 0,
            creationIdempotencyKey: `create:${jobId}`,
            prompt: { positive: `positive:${jobId}`, negative: `negative:${jobId}` },
        }
    }

    function bulkStoredTurn(
        turnId: string,
        state: IllustrationTurnRecordV1['state'],
        updatedAt = BASE_TIME,
    ): IllustrationTurnRecordV1 {
        return {
            schemaVersion: 1,
            turnId,
            state,
            version: 1,
            leaseId: null,
            leaseExpiresAt: 0,
            fence: 0,
            workerEpoch: 0,
            updatedAt,
            idempotencyKey: `create:${turnId}`,
            agentAttemptCount: state.startsWith('agent_blocked') ? 1 : 0,
        }
    }

    test('reads listJobs with no per-record reads and lists pending turns from the bounded index', async () => {
        storageMap.clear()
        // 3,000 terminal jobs — only the 50 most-recently-updated survive the cap.
        for (let index = 0; index < 3_000; index += 1) {
            const jobId = `terminal:${index}`
            encodeStored(
                illustrationJobKey(jobId),
                bulkStoredJob(jobId, 'committed', {
                    slotOrdinal: index % 15,
                    createdAt: BASE_TIME + index,
                    updatedAt: BASE_TIME + index,
                }),
            )
        }
        // N live/uncertain jobs — all survive regardless of the cap.
        const liveStates: IllustrationJobState[] = ['queued', 'generating', 'uncertain']
        liveStates.forEach((state, index) => {
            const jobId = `live:${state}`
            encodeStored(
                illustrationJobKey(jobId),
                bulkStoredJob(jobId, state, {
                    slotOrdinal: 20 + index,
                    createdAt: BASE_TIME + 10_000 + index,
                }),
            )
        })
        // 200 terminal turns + 6 pending/blocked turns.
        for (let index = 0; index < 200; index += 1) {
            const turnId = `done:${index}`
            encodeStored(
                illustrationTurnKey(turnId),
                bulkStoredTurn(turnId, 'completed', BASE_TIME + index),
            )
        }
        const blockedStates: IllustrationTurnRecordV1['state'][] = [
            'awaiting_plan',
            'awaiting_plan',
            'agent_blocked_retryable',
            'agent_blocked_retryable',
            'agent_blocked',
            'agent_blocked',
        ]
        blockedStates.forEach((state, index) => {
            const turnId = `pending:${index}`
            encodeStored(
                illustrationTurnKey(turnId),
                bulkStoredTurn(turnId, state, BASE_TIME + 5_000 + index),
            )
        })

        // Prime the pending index: the first listing rebuilds it once from a full
        // scan and persists it, so the steady-state pass never rescans history.
        expect(await store.listPendingTurns()).toHaveLength(6)

        storageCounters.getItem = 0
        storageCounters.getItems = 0
        storageCounters.bulkReadKeyCounts = []

        const jobs = await store.listJobs()
        const turns = await store.listPendingTurns()

        // Acceptance: no per-record `/api/read` for records; the pending listing
        // reads only the small index record (one getItem) plus one bulk read of
        // exactly the indexed pending turns, alongside listJobs' single bulk read.
        expect(storageCounters.getItem).toBe(1)
        expect(storageCounters.getItems).toBe(2)
        // Acceptance 8: the pending bulk-read width tracks the 6 pending turns, NOT
        // the 200 terminal turns — the listing does not scale with terminal history.
        expect(storageCounters.bulkReadKeyCounts).toContain(6)
        expect(Math.min(...storageCounters.bulkReadKeyCounts)).toBe(6)

        // Result parity: every live/uncertain job plus the newest 50 terminal.
        const live = jobs.filter((job) => liveStates.includes(job.state))
        const terminals = jobs.filter((job) => job.state === 'committed')
        expect(live.map((job) => job.jobId).sort()).toEqual([
            'live:generating',
            'live:queued',
            'live:uncertain',
        ])
        expect(terminals).toHaveLength(50)
        expect(terminals.some((job) => job.jobId === 'terminal:2999')).toBe(true)
        expect(terminals.some((job) => job.jobId === 'terminal:2949')).toBe(false)

        expect(turns).toHaveLength(6)
        expect(turns.map((turn) => turn.state).sort()).toEqual([
            'agent_blocked',
            'agent_blocked',
            'agent_blocked_retryable',
            'agent_blocked_retryable',
            'awaiting_plan',
            'awaiting_plan',
        ])
    })

    test('listJobs({turnId}) uses a single bulk-read and drops a missing indexed job', async () => {
        storageMap.clear()
        const turnId = 'bulk-turn'
        const present = bulkStoredJob(`${turnId}:job:0`, 'queued', { turnId, slotOrdinal: 0 })
        const alsoPresent = bulkStoredJob(`${turnId}:job:1`, 'generating', { turnId, slotOrdinal: 1 })
        encodeStored(illustrationJobKey(present.jobId), present)
        encodeStored(illustrationJobKey(alsoPresent.jobId), alsoPresent)
        // Index references a third job whose record was never written (lost ACK).
        encodeStored(illustrationTurnJobsKey(turnId), [
            present.jobId,
            `${turnId}:job:missing`,
            alsoPresent.jobId,
        ])

        storageCounters.getItem = 0
        storageCounters.getItems = 0

        const jobs = await store.listJobs({ turnId })

        // One single read for the turnjobs index, one bulk read for the jobs.
        expect(storageCounters.getItem).toBe(1)
        expect(storageCounters.getItems).toBe(1)
        expect(jobs.map((job) => job.jobId)).toEqual([`${turnId}:job:0`, `${turnId}:job:1`])
    })

    test('fails closed when the turn-job index points at another turn', async () => {
        storageMap.clear()
        const turnId = 'guard-turn'
        const foreign = bulkStoredJob(`${turnId}:job:0`, 'queued', { turnId: 'other-turn' })
        encodeStored(illustrationJobKey(foreign.jobId), foreign)
        encodeStored(illustrationTurnJobsKey(turnId), [foreign.jobId])

        await expect(store.listJobs({ turnId })).rejects.toBeInstanceOf(
            IllustrationLedgerCorruptError,
        )
    })

    test('fails closed on corrupt JSON bytes in a scanned job record', async () => {
        storageMap.clear()
        encodeStored(illustrationJobKey('good:job'), bulkStoredJob('good:job', 'queued'))
        storageMap.set(
            illustrationJobKey('corrupt:job'),
            new TextEncoder().encode('{ this is not json'),
        )

        await expect(store.listJobs()).rejects.toBeInstanceOf(SyntaxError)
    })

    test('fails closed when the bulk response returns a duplicate row', async () => {
        storageMap.clear()
        encodeStored(illustrationJobKey('dup:job'), bulkStoredJob('dup:job', 'queued'))
        storageControl.duplicateBulkKey = illustrationJobKey('dup:job')

        await expect(store.listJobs()).rejects.toThrow(/duplicate/i)
    })
})

describe('atomic coordinator proof on plugin Agent writes', () => {
    type ProofOperation = {
        name: string
        run: (proof: IllustrationCoordinatorProof) => Promise<unknown>
        read: () => Promise<unknown>
    }

    async function makeProofOperations(prefix: string): Promise<ProofOperation[]> {
        const claimTurnId = `${prefix}:claim-turn`
        const claimTurnCreated = await store.createTurn({
            turnId: claimTurnId,
            idempotencyKey: `create:${claimTurnId}`,
        })
        await store.updateTurn({
            turnId: claimTurnId,
            expectedVersion: claimTurnCreated.version,
            mutate: (draft) => {
                draft.state = 'awaiting_plan'
            },
        })

        const [claimJobPrepared] = await createPreparedJobs(`${prefix}:claim-job`)
        const claimJobAwaiting = await transition(claimJobPrepared.jobId, 'awaiting_prompt')

        const planTurnId = `${prefix}:plan`
        const plan = await createClaimedTurn(planTurnId)
        const planManifest = makeManifest(planTurnId)

        const [promptPrepared] = await createPreparedJobs(`${prefix}:prompt`)
        const promptAwaiting = await transition(promptPrepared.jobId, 'awaiting_prompt')
        const promptLeaseId = `tagger:${prefix}:prompt`
        const promptClaimed = await store.claimJob({
            ...coordinatorProof,
            jobId: promptPrepared.jobId,
            expectedVersion: promptAwaiting.version,
            leaseId: promptLeaseId,
        })

        return [
            {
                name: 'claimTurn',
                run: async (proof) => await store.claimTurn({
                    ...proof,
                    turnId: claimTurnId,
                    expectedVersion: claimTurnCreated.version + 1,
                    leaseId: `planner:${prefix}:claim`,
                }),
                read: async () => await store.getTurn(claimTurnId),
            },
            {
                name: 'claimJob',
                run: async (proof) => await store.claimJob({
                    ...proof,
                    jobId: claimJobPrepared.jobId,
                    expectedVersion: claimJobAwaiting.version,
                    leaseId: `tagger:${prefix}:claim`,
                }),
                read: async () => await store.getJob(claimJobPrepared.jobId),
            },
            {
                name: 'submitPlan ledger CAS',
                run: async (proof) => await store.createManifestPrepared({
                    ...proof,
                    manifest: planManifest,
                    turnExpectedVersion: plan.turn.version,
                    leaseId: plan.leaseId,
                    fence: plan.turn.fence,
                    idempotencyKey: `submit:${prefix}:proof`,
                }),
                read: async () => ({
                    turn: await store.getTurn(planTurnId),
                    manifest: await store.getManifest(planTurnId),
                }),
            },
            {
                name: 'supplyPrompt ledger CAS',
                run: async (proof) => await store.transitionJob({
                    ...proof,
                    jobId: promptPrepared.jobId,
                    expectedVersion: promptClaimed.version,
                    to: 'queued',
                    leaseId: promptLeaseId,
                    fence: promptClaimed.fence,
                    patch: {
                        idempotencyKey: `prompt:${prefix}:proof`,
                        prompt: flatPrompt('positive', 'negative'),
                    },
                }),
                read: async () => await store.getJob(promptPrepared.jobId),
            },
        ]
    }

    async function expectAllRejectedWithoutWrites(
        operations: ProofOperation[],
        proof: IllustrationCoordinatorProof,
        errorType: new (...args: any[]) => Error,
    ): Promise<void> {
        for (const operation of operations) {
            const before = await operation.read()
            await expect(operation.run(proof), operation.name).rejects.toBeInstanceOf(errorType)
            expect(await operation.read(), operation.name).toEqual(before)
        }
    }

    test('rejects an awaiting_prompt to queued write that omits all proof', async () => {
        const [prepared] = await createPreparedJobs('missing-prompt-proof')
        const awaiting = await transition(prepared.jobId, 'awaiting_prompt')
        await expect(store.transitionJob({
            jobId: prepared.jobId,
            expectedVersion: awaiting.version,
            to: 'queued',
            patch: {
                idempotencyKey: 'prompt:missing-proof',
                prompt: flatPrompt('positive', 'negative'),
            },
        })).rejects.toBeInstanceOf(IllustrationLedgerHolderMismatchError)
        expect(await store.getJob(prepared.jobId)).toEqual(awaiting)
    })

    test('rejects wrong coordinator lease and fence on every claim/plan/prompt CAS', async () => {
        const operations = await makeProofOperations('wrong-proof')
        await expectAllRejectedWithoutWrites(
            operations,
            { ...coordinatorProof, coordinatorLeaseId: 'wrong-coordinator' },
            IllustrationCoordinatorMismatchError,
        )
        await expectAllRejectedWithoutWrites(
            operations,
            { ...coordinatorProof, coordinatorFence: coordinatorProof.coordinatorFence + 1 },
            IllustrationCoordinatorMismatchError,
        )
    })

    test('rejects expired coordinator proof on every claim/plan/prompt CAS', async () => {
        const operations = await makeProofOperations('expired-proof')
        vi.advanceTimersByTime(COORDINATOR_LEASE_DURATION_MS)
        await expectAllRejectedWithoutWrites(
            operations,
            coordinatorProof,
            IllustrationCoordinatorExpiredError,
        )
    })

    test('rejects draining coordinator proof on every new claim/plan/prompt CAS', async () => {
        const operations = await makeProofOperations('draining-proof')
        await markCoordinatorDraining({
            protocolVersion: 1,
            leaseId: coordinatorProof.coordinatorLeaseId,
            expectedVersion: coordinatorVersion,
            fence: coordinatorProof.coordinatorFence,
        })
        await expectAllRejectedWithoutWrites(
            operations,
            coordinatorProof,
            IllustrationCoordinatorDrainingError,
        )
    })
})

describe('pending turn index and origin', () => {
    function pendingIndexTurnIds(): string[] | undefined {
        return decodeStored<{ schemaVersion: number; turnIds: string[] }>(
            ILLUSTRATION_PENDING_TURNS_KEY,
        )?.turnIds
    }

    function indexTurnRecord(
        turnId: string,
        state: IllustrationTurnRecordV1['state'],
    ): IllustrationTurnRecordV1 {
        return {
            schemaVersion: 1,
            turnId,
            state,
            version: 1,
            leaseId: null,
            leaseExpiresAt: 0,
            fence: 0,
            workerEpoch: 0,
            updatedAt: BASE_TIME,
            idempotencyKey: `create:${turnId}`,
            agentAttemptCount: state.startsWith('agent_blocked') ? 1 : 0,
        }
    }

    test('createTurn adds the new turn to the durable pending index', async () => {
        await store.createTurn({ turnId: 't1', idempotencyKey: 'i1' })
        expect(decodeStored(ILLUSTRATION_PENDING_TURNS_KEY)).toEqual({
            schemaVersion: 1,
            turnIds: ['t1'],
        })
    })

    test('a non-terminal transition keeps the turn indexed', async () => {
        await store.createTurn({ turnId: 't1', idempotencyKey: 'i1' })
        const turn = await store.getTurn('t1')
        await store.updateTurn({
            turnId: 't1',
            expectedVersion: turn!.version,
            mutate: (draft) => { draft.state = 'awaiting_plan' },
        })
        expect(pendingIndexTurnIds()).toEqual(['t1'])
    })

    test('a terminal transition removes the turn from the index', async () => {
        await store.createTurn({ turnId: 't1', idempotencyKey: 'i1' })
        const turn = await store.getTurn('t1')
        await store.requestCancelTurn({ turnId: 't1', expectedVersion: turn!.version })
        expect(pendingIndexTurnIds()).toEqual([])
    })

    test('rebuilds the index from a full scan when it is missing', async () => {
        encodeStored(illustrationTurnKey('a'), indexTurnRecord('a', 'awaiting_plan'))
        encodeStored(illustrationTurnKey('b'), indexTurnRecord('b', 'completed'))
        encodeStored(illustrationTurnKey('c'), indexTurnRecord('c', 'prepared'))
        expect(decodeStored(ILLUSTRATION_PENDING_TURNS_KEY)).toBeNull()

        const pending = await store.listPendingTurns()

        // Only the listing-pending turn surfaces...
        expect(pending.map((turn) => turn.turnId)).toEqual(['a'])
        // ...but the index tracks every non-terminal turn (a + c), never the
        // terminal one (b).
        expect(pendingIndexTurnIds()).toEqual(['a', 'c'])
    })

    test('rebuilds the index from a full scan when it is structurally corrupt', async () => {
        encodeStored(ILLUSTRATION_PENDING_TURNS_KEY, { schemaVersion: 2, turnIds: 'nope' })
        encodeStored(illustrationTurnKey('a'), indexTurnRecord('a', 'awaiting_plan'))

        const pending = await store.listPendingTurns()

        expect(pending.map((turn) => turn.turnId)).toEqual(['a'])
        expect(decodeStored(ILLUSTRATION_PENDING_TURNS_KEY)).toEqual({
            schemaVersion: 1,
            turnIds: ['a'],
        })
    })

    test('self-heals an indexed turn whose record is missing', async () => {
        encodeStored(ILLUSTRATION_PENDING_TURNS_KEY, { schemaVersion: 1, turnIds: ['ghost', 'real'] })
        encodeStored(illustrationTurnKey('real'), indexTurnRecord('real', 'awaiting_plan'))

        const pending = await store.listPendingTurns()

        expect(pending.map((turn) => turn.turnId)).toEqual(['real'])
        expect(pendingIndexTurnIds()).toEqual(['real'])
    })

    test('self-heals an indexed turn that has become terminal', async () => {
        encodeStored(ILLUSTRATION_PENDING_TURNS_KEY, { schemaVersion: 1, turnIds: ['done', 'active'] })
        encodeStored(illustrationTurnKey('done'), indexTurnRecord('done', 'completed'))
        encodeStored(illustrationTurnKey('active'), indexTurnRecord('active', 'awaiting_plan'))

        const pending = await store.listPendingTurns()

        expect(pending.map((turn) => turn.turnId)).toEqual(['active'])
        expect(pendingIndexTurnIds()).toEqual(['active'])
    })

    test('createTurn persists an explicit origin', async () => {
        await store.createTurn({ turnId: 'm1', idempotencyKey: 'i', origin: 'manual' })
        expect((await store.getTurn('m1'))!.origin).toBe('manual')
    })

    test('projects a legacy origin-less turn as automatic and forbids mutating origin', async () => {
        await store.createTurn({ turnId: 'leg', idempotencyKey: 'i' })
        const turn = await store.getTurn('leg')
        expect(turn!.origin).toBeUndefined()
        await expect(store.updateTurn({
            turnId: 'leg',
            expectedVersion: turn!.version,
            mutate: (draft) => {
                draft.origin = 'manual'
                draft.state = 'awaiting_plan'
            },
        })).rejects.toThrow(/immutable/)
    })

    test('listPendingTurns projects origin, defaulting a legacy turn to automatic', async () => {
        encodeStored(illustrationTurnKey('legacy'), indexTurnRecord('legacy', 'awaiting_plan'))
        encodeStored(illustrationTurnKey('manual'), {
            ...indexTurnRecord('manual', 'awaiting_plan'),
            origin: 'manual',
        })

        const pending = await store.listPendingTurns()
        const originById = Object.fromEntries(pending.map((turn) => [turn.turnId, turn.origin]))

        expect(originById.legacy).toBe('automatic')
        expect(originById.manual).toBe('manual')
    })
})
