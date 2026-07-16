import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type {
    IllustrationCoordinatorProof,
    IllustrationJobRecordV1,
    IllustrationTurnRecordV1,
} from '../types'
import { InMemoryLockManager } from './inMemoryLockManager'

const storageMap = vi.hoisted(() => new Map<string, Uint8Array>())

vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: {
        async Init() {},
        async keys(prefix = '') {
            return [...storageMap.keys()].filter((key) => key.startsWith(prefix))
        },
        async getItem(key: string) {
            return storageMap.get(key) ?? null
        },
        async setItem(key: string, value: Uint8Array) {
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

const coordinatorModule = await import('../coordinatorRecord')
const errorModule = await import('../errors')
const featureModule = await import('../featureFlag')
const lockModule = await import('../locks')
const storeModule = await import('../store')

const {
    COORDINATOR_LEASE_DURATION_MS,
    claimCoordinator,
    markCoordinatorDraining,
} = coordinatorModule
const {
    IllustrationCoordinatorDrainingError,
    IllustrationCoordinatorExpiredError,
    IllustrationCoordinatorMismatchError,
    IllustrationLedgerConfirmationRequiredError,
    IllustrationLedgerHolderMismatchError,
    IllustrationLedgerIdempotencyConflictError,
    IllustrationLedgerValidationError,
} = errorModule
const { IllustrationFeatureDisabledError, setIllustrationFeatureEnabled } = featureModule
const {
    resetIllustrationLockManagerAccessorForTests,
    setIllustrationLockManagerAccessorForTests,
} = lockModule
const { IllustrationJobStore, MAX_AGENT_ATTEMPTS } = storeModule

const BASE_TIME = Date.UTC(2026, 6, 15, 1)
const store = new IllustrationJobStore()
let coordinatorProof: IllustrationCoordinatorProof
let coordinatorVersion: number
let lockManager: InMemoryLockManager

async function installCoordinator(): Promise<void> {
    const snapshot = await claimCoordinator({
        protocolVersion: 1,
        leaseId: 'coordinator',
        holderRuntimeId: 'runtime',
    })
    coordinatorVersion = snapshot.version
    coordinatorProof = {
        coordinatorLeaseId: 'coordinator',
        coordinatorFence: snapshot.fence,
    }
}

async function createClaimedTurn(turnId: string, leaseId = `planner:${turnId}`) {
    const created = await store.createTurn({ turnId, idempotencyKey: `create:${turnId}` })
    const awaiting = await store.updateTurn({
        turnId,
        expectedVersion: created.version,
        mutate: (draft) => {
            draft.state = 'awaiting_plan'
        },
    })
    const claimed = await store.claimTurn({
        ...coordinatorProof,
        turnId,
        expectedVersion: awaiting.version,
        leaseId,
    })
    return { claimed, leaseId }
}

async function createClaimedJob(turnId: string, leaseId = `tagger:${turnId}`) {
    const planner = await createClaimedTurn(turnId)
    const jobId = `job:${turnId}`
    const manifest = await store.createManifestPrepared({
        ...coordinatorProof,
        manifest: {
            turnId,
            planHash: `plan:${turnId}`,
            expectedCount: 1,
            sourceRevisionHash: `source:${turnId}`,
            jobs: [{
                jobId,
                slotToken: `slot:${turnId}`,
                insertAfterUtf16: 0,
                sceneId: `scene:${turnId}`,
                scenePayload: { schemaVersion: 1, data: {} },
            }],
        },
        turnExpectedVersion: planner.claimed.version,
        leaseId: planner.leaseId,
        fence: planner.claimed.fence,
        idempotencyKey: `submit:${turnId}`,
    })
    const [prepared] = await store.createJobsFromManifest({
        turnId,
        expectedManifestVersion: manifest.version,
    })
    const awaiting = await store.transitionJob({
        jobId,
        expectedVersion: prepared.version,
        to: 'awaiting_prompt',
        patch: { idempotencyKey: `project:${turnId}` },
    })
    const claimed = await store.claimJob({
        ...coordinatorProof,
        jobId,
        expectedVersion: awaiting.version,
        leaseId,
    })
    return { claimed, leaseId }
}

async function reportTurnFailure(
    turn: IllustrationTurnRecordV1,
    leaseId: string,
    idempotencyKey: string,
    retryable = true,
) {
    return await store.reportAgentFailure({
        protocolVersion: 1,
        kind: 'turn',
        id: turn.turnId,
        expectedVersion: turn.version,
        leaseId,
        fence: turn.fence,
        ...coordinatorProof,
        idempotencyKey,
        code: 'planner_failed',
        retryable,
    }) as IllustrationTurnRecordV1
}

async function reportJobFailure(
    job: IllustrationJobRecordV1,
    leaseId: string,
    idempotencyKey: string,
    retryable = true,
) {
    return await store.reportAgentFailure({
        protocolVersion: 1,
        kind: 'job',
        id: job.jobId,
        expectedVersion: job.version,
        leaseId,
        fence: job.fence,
        ...coordinatorProof,
        idempotencyKey,
        code: 'tagger_failed',
        retryable,
    }) as IllustrationJobRecordV1
}

beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    storageMap.clear()
    lockManager = new InMemoryLockManager()
    setIllustrationLockManagerAccessorForTests(() => lockManager)
    await setIllustrationFeatureEnabled(true)
    await installCoordinator()
})

afterEach(() => {
    resetIllustrationLockManagerAccessorForTests()
    vi.useRealTimers()
})

describe('Agent failure ledger operations', () => {
    test('increments retryable failures, deduplicates lost ACK, and preserves count through retry', async () => {
        const { claimed, leaseId } = await createClaimedTurn('turn-retryable')
        const blocked = await reportTurnFailure(claimed, leaseId, 'failure:k1')
        expect(blocked).toMatchObject({
            state: 'agent_blocked_retryable',
            agentAttemptCount: 1,
            leaseId: null,
            leaseExpiresAt: 0,
            error: { code: 'planner_failed', retryable: true },
        })
        const replay = await reportTurnFailure(claimed, leaseId, 'failure:k1')
        expect(replay).toEqual(blocked)

        const retried = await store.retryAgentFailure({
            protocolVersion: 1,
            kind: 'turn',
            id: claimed.turnId,
            expectedVersion: blocked.version,
            confirmNewLlmCharge: true,
            ...coordinatorProof,
        }) as IllustrationTurnRecordV1
        expect(retried).toMatchObject({ state: 'awaiting_plan', agentAttemptCount: 1 })
        expect(retried.error).toBeUndefined()
        await expect(reportTurnFailure(claimed, leaseId, 'failure:k1'))
            .rejects.toBeInstanceOf(IllustrationLedgerIdempotencyConflictError)
    })

    test('cancels an Agent-blocked turn as a durable terminal CAS', async () => {
        const { claimed, leaseId } = await createClaimedTurn('turn-cancel-blocked')
        const blocked = await reportTurnFailure(claimed, leaseId, 'failure:cancel-blocked')
        const cancelled = await store.requestCancelTurn({
            turnId: claimed.turnId,
            expectedVersion: blocked.version,
        })
        expect(cancelled).toMatchObject({
            state: 'cancelled',
            version: blocked.version + 1,
            leaseId: null,
        })
        expect(await store.requestCancelTurn({
            turnId: claimed.turnId,
            expectedVersion: blocked.version,
        })).toEqual(cancelled)
    })

    test('escalates at the cap, permits one confirmed attempt from hard block, and resets only on success', async () => {
        const turnId = 'turn-cap'
        let { claimed, leaseId } = await createClaimedTurn(turnId, 'planner:cap')
        for (let attempt = 1; attempt <= MAX_AGENT_ATTEMPTS; attempt += 1) {
            const blocked = await reportTurnFailure(claimed, leaseId, `failure:${attempt}`)
            expect(blocked.agentAttemptCount).toBe(attempt)
            expect(blocked.state).toBe(
                attempt < MAX_AGENT_ATTEMPTS ? 'agent_blocked_retryable' : 'agent_blocked',
            )
            const retried = await store.retryAgentFailure({
                protocolVersion: 1,
                kind: 'turn',
                id: turnId,
                expectedVersion: blocked.version,
                confirmNewLlmCharge: true,
                ...coordinatorProof,
            }) as IllustrationTurnRecordV1
            expect(retried.agentAttemptCount).toBe(attempt)
            claimed = await store.claimTurn({
                ...coordinatorProof,
                turnId,
                expectedVersion: retried.version,
                leaseId,
            })
        }
        const escalatedAgain = await reportTurnFailure(claimed, leaseId, 'failure:after-cap')
        expect(escalatedAgain).toMatchObject({
            state: 'agent_blocked',
            agentAttemptCount: MAX_AGENT_ATTEMPTS + 1,
        })

        const retryForSuccess = await store.retryAgentFailure({
            protocolVersion: 1,
            kind: 'turn',
            id: turnId,
            expectedVersion: escalatedAgain.version,
            confirmNewLlmCharge: true,
            ...coordinatorProof,
        }) as IllustrationTurnRecordV1
        const successClaim = await store.claimTurn({
            ...coordinatorProof,
            turnId,
            expectedVersion: retryForSuccess.version,
            leaseId,
        })
        await store.createManifestPrepared({
            ...coordinatorProof,
            manifest: {
                turnId,
                planHash: 'successful-plan',
                expectedCount: 0,
                sourceRevisionHash: 'source:turn-cap',
                jobs: [],
            },
            turnExpectedVersion: successClaim.version,
            leaseId,
            fence: successClaim.fence,
            idempotencyKey: 'submit:successful-plan',
        })
        expect((await store.getTurn(turnId))?.agentAttemptCount).toBe(0)
    })

    test('hard-blocks non-retryable failures without incrementing and rejects holder races atomically', async () => {
        const { claimed, leaseId } = await createClaimedTurn('turn-hard')
        const hard = await reportTurnFailure(claimed, leaseId, 'failure:hard', false)
        expect(hard).toMatchObject({ state: 'agent_blocked', agentAttemptCount: 0 })
        const hardRetry = await store.retryAgentFailure({
            protocolVersion: 1,
            kind: 'turn',
            id: claimed.turnId,
            expectedVersion: hard.version,
            confirmNewLlmCharge: true,
            ...coordinatorProof,
        }) as IllustrationTurnRecordV1
        expect(hardRetry).toMatchObject({
            state: 'awaiting_plan',
            agentAttemptCount: 0,
            agentHardRetryPending: true,
        })
        const hardRetryClaim = await store.claimTurn({
            ...coordinatorProof,
            turnId: claimed.turnId,
            expectedVersion: hardRetry.version,
            leaseId,
        })
        const hardAgain = await reportTurnFailure(
            hardRetryClaim,
            leaseId,
            'failure:hard-again',
        )
        expect(hardAgain).toMatchObject({ state: 'agent_blocked', agentAttemptCount: 1 })
        expect(hardAgain.agentHardRetryPending).toBeUndefined()

        const other = await createClaimedTurn('turn-holder-mismatch')
        await expect(store.reportAgentFailure({
            protocolVersion: 1,
            kind: 'turn',
            id: other.claimed.turnId,
            expectedVersion: other.claimed.version,
            leaseId: other.leaseId,
            fence: other.claimed.fence,
            coordinatorLeaseId: 'wrong-coordinator',
            coordinatorFence: coordinatorProof.coordinatorFence,
            idempotencyKey: 'failure:wrong-coordinator',
            code: 'planner_failed',
            retryable: true,
        })).rejects.toBeInstanceOf(IllustrationCoordinatorMismatchError)
        expect(await store.getTurn(other.claimed.turnId)).toEqual(other.claimed)

        await expect(store.reportAgentFailure({
            protocolVersion: 1,
            kind: 'turn',
            id: other.claimed.turnId,
            expectedVersion: other.claimed.version,
            leaseId: other.leaseId,
            fence: other.claimed.fence + 1,
            ...coordinatorProof,
            idempotencyKey: 'failure:wrong-holder',
            code: 'planner_failed',
            retryable: true,
        })).rejects.toBeInstanceOf(IllustrationLedgerHolderMismatchError)
        expect(await store.getTurn(other.claimed.turnId)).toMatchObject({
            state: 'awaiting_plan',
            agentAttemptCount: 0,
        })
    })

    test('rejects expired coordinator proof on report and retry without partial writes', async () => {
        const reportTarget = await createClaimedTurn('turn-expired-report')
        const retryTarget = await createClaimedTurn('turn-expired-retry')
        const blocked = await reportTurnFailure(
            retryTarget.claimed,
            retryTarget.leaseId,
            'failure:expired-retry-setup',
        )
        vi.advanceTimersByTime(COORDINATOR_LEASE_DURATION_MS)

        await expect(reportTurnFailure(
            reportTarget.claimed,
            reportTarget.leaseId,
            'failure:expired-report',
        )).rejects.toBeInstanceOf(IllustrationCoordinatorExpiredError)
        expect(await store.getTurn(reportTarget.claimed.turnId)).toEqual(reportTarget.claimed)

        await expect(store.retryAgentFailure({
            protocolVersion: 1,
            kind: 'turn',
            id: retryTarget.claimed.turnId,
            expectedVersion: blocked.version,
            confirmNewLlmCharge: true,
            ...coordinatorProof,
        })).rejects.toBeInstanceOf(IllustrationCoordinatorExpiredError)
        expect(await store.getTurn(retryTarget.claimed.turnId)).toEqual(blocked)
    })

    test('reports while draining but retry requires active non-draining coordinator proof', async () => {
        const { claimed, leaseId } = await createClaimedTurn('turn-draining')
        const draining = await markCoordinatorDraining({
            protocolVersion: 1,
            leaseId: 'coordinator',
            expectedVersion: coordinatorVersion,
            fence: coordinatorProof.coordinatorFence,
        })
        coordinatorVersion = draining.version
        const blocked = await reportTurnFailure(claimed, leaseId, 'failure:draining')
        expect(blocked.state).toBe('agent_blocked_retryable')
        await expect(store.retryAgentFailure({
            protocolVersion: 1,
            kind: 'turn',
            id: claimed.turnId,
            expectedVersion: blocked.version,
            confirmNewLlmCharge: true,
            ...coordinatorProof,
        })).rejects.toBeInstanceOf(IllustrationCoordinatorDrainingError)
        expect((await store.getTurn(claimed.turnId))?.state).toBe('agent_blocked_retryable')
    })

    test('allows failure reporting while feature OFF but rejects a retry', async () => {
        const { claimed, leaseId } = await createClaimedTurn('turn-feature-off')
        await setIllustrationFeatureEnabled(false)
        const blocked = await reportTurnFailure(claimed, leaseId, 'failure:feature-off')
        expect(blocked.state).toBe('agent_blocked_retryable')
        await expect(store.retryAgentFailure({
            protocolVersion: 1,
            kind: 'turn',
            id: blocked.turnId,
            expectedVersion: blocked.version,
            confirmNewLlmCharge: true,
            ...coordinatorProof,
        })).rejects.toBeInstanceOf(IllustrationFeatureDisabledError)
    })

    test('requires the literal charge confirmation and valid coordinator proof', async () => {
        const { claimed, leaseId } = await createClaimedTurn('turn-confirm')
        const blocked = await reportTurnFailure(claimed, leaseId, 'failure:confirm')
        await expect(store.retryAgentFailure({
            protocolVersion: 1,
            kind: 'turn',
            id: claimed.turnId,
            expectedVersion: blocked.version,
            confirmNewLlmCharge: false,
            ...coordinatorProof,
        } as never)).rejects.toBeInstanceOf(IllustrationLedgerConfirmationRequiredError)
        await expect(store.retryAgentFailure({
            protocolVersion: 1,
            kind: 'turn',
            id: claimed.turnId,
            expectedVersion: blocked.version,
            confirmNewLlmCharge: true,
            coordinatorLeaseId: 'wrong',
            coordinatorFence: coordinatorProof.coordinatorFence,
        })).rejects.toBeInstanceOf(IllustrationCoordinatorMismatchError)
        expect((await store.getTurn(claimed.turnId))?.version).toBe(blocked.version)
    })

    test('keeps every used failure key bound across later reports and retries', async () => {
        const turnId = 'turn-key-history'
        const leaseId = 'planner:key-history'
        let { claimed } = await createClaimedTurn(turnId, leaseId)
        for (const key of ['failure:k1', 'failure:k2']) {
            const blocked = await reportTurnFailure(claimed, leaseId, key)
            const retried = await store.retryAgentFailure({
                protocolVersion: 1,
                kind: 'turn',
                id: turnId,
                expectedVersion: blocked.version,
                confirmNewLlmCharge: true,
                ...coordinatorProof,
            }) as IllustrationTurnRecordV1
            claimed = await store.claimTurn({
                ...coordinatorProof,
                turnId,
                expectedVersion: retried.version,
                leaseId,
            })
        }
        await expect(reportTurnFailure(claimed, leaseId, 'failure:k1'))
            .rejects.toBeInstanceOf(IllustrationLedgerHolderMismatchError)
        expect((await store.getTurn(turnId))?.state).toBe('awaiting_plan')
    })

    test('supports job failure/retry and resets the cumulative count on durable prompt success', async () => {
        const { claimed, leaseId } = await createClaimedJob('job-success-reset')
        const blocked = await reportJobFailure(claimed, leaseId, 'failure:job')
        const retried = await store.retryAgentFailure({
            protocolVersion: 1,
            kind: 'job',
            id: claimed.jobId,
            expectedVersion: blocked.version,
            confirmNewLlmCharge: true,
            ...coordinatorProof,
        }) as IllustrationJobRecordV1
        expect(retried).toMatchObject({ state: 'awaiting_prompt', agentAttemptCount: 1 })
        const reclaimed = await store.claimJob({
            ...coordinatorProof,
            jobId: claimed.jobId,
            expectedVersion: retried.version,
            leaseId,
        })
        const queued = await store.transitionJob({
            ...coordinatorProof,
            jobId: claimed.jobId,
            expectedVersion: reclaimed.version,
            to: 'queued',
            leaseId,
            fence: reclaimed.fence,
            patch: {
                idempotencyKey: 'prompt:success',
                prompt: {
                    schemaVersion: 1,
                    layout: 'flat',
                    basePositive: 'positive',
                    characterPositives: [],
                    baseNegative: 'negative',
                    characterNegatives: [],
                },
            },
        })
        expect(queued).toMatchObject({ state: 'queued', agentAttemptCount: 0 })
    })

    test('prevents generic mutators from entering or leaving Agent failure states', async () => {
        const { claimed } = await createClaimedTurn('turn-bypass')
        await expect(store.updateTurn({
            turnId: claimed.turnId,
            expectedVersion: claimed.version,
            mutate: (draft) => {
                draft.state = 'agent_blocked'
            },
        })).rejects.toBeInstanceOf(IllustrationLedgerValidationError)

        const { claimed: job } = await createClaimedJob('job-bypass')
        await expect(store.transitionJob({
            jobId: job.jobId,
            expectedVersion: job.version,
            to: 'agent_blocked',
            patch: { idempotencyKey: 'failure:bypass' },
        })).rejects.toBeInstanceOf(IllustrationLedgerValidationError)

        const { claimed: claimedBlockedTurn, leaseId: blockedTurnLeaseId } =
            await createClaimedTurn('turn-leave-bypass')
        const blockedTurn = await reportTurnFailure(
            claimedBlockedTurn,
            blockedTurnLeaseId,
            'failure:turn-leave-bypass',
        )
        await expect(store.updateTurn({
            turnId: blockedTurn.turnId,
            expectedVersion: blockedTurn.version,
            mutate: (draft) => {
                draft.state = 'awaiting_plan'
            },
        })).rejects.toBeInstanceOf(IllustrationLedgerValidationError)
        expect(await store.getTurn(blockedTurn.turnId)).toEqual(blockedTurn)

        const { claimed: claimedBlockedJob, leaseId: blockedJobLeaseId } =
            await createClaimedJob('job-leave-bypass')
        const blockedJob = await reportJobFailure(
            claimedBlockedJob,
            blockedJobLeaseId,
            'failure:job-leave-bypass',
        )
        await expect(store.transitionJob({
            jobId: blockedJob.jobId,
            expectedVersion: blockedJob.version,
            to: 'awaiting_prompt',
            patch: { idempotencyKey: 'retry:bypass' },
        })).rejects.toBeInstanceOf(IllustrationLedgerValidationError)
        expect(await store.getJob(blockedJob.jobId)).toEqual(blockedJob)
    })

    test('prevents generic turn mutators from rewriting Agent counters and durable receipts', async () => {
        const { claimed } = await createClaimedTurn('turn-agent-provenance-bypass')
        const failureReceipt = {
            idempotencyKey: 'failure:forged',
            previousVersion: claimed.version,
            resultVersion: claimed.version + 1,
            leaseId: 'planner:forged',
            fence: claimed.fence,
            code: 'forged',
            retryable: true,
            outcomeState: 'agent_blocked_retryable' as const,
            agentAttemptCount: 1,
        }
        const mutations: Array<(draft: IllustrationTurnRecordV1) => void> = [
            (draft) => { draft.agentAttemptCount = 1 },
            (draft) => { draft.agentHardRetryPending = true },
            (draft) => { draft.lastAgentFailureWrite = failureReceipt },
            (draft) => { draft.agentFailureWrites = [failureReceipt] },
            (draft) => {
                draft.lastPlanClosureWrite = {
                    idempotencyKey: 'plan:forged',
                    previousVersion: claimed.version,
                    resultVersion: claimed.version + 1,
                    leaseId: 'planner:forged',
                    fence: claimed.fence,
                    state: 'stale',
                    code: 'forged',
                }
            },
        ]

        for (const mutate of mutations) {
            await expect(store.updateTurn({
                turnId: claimed.turnId,
                expectedVersion: claimed.version,
                mutate,
            })).rejects.toBeInstanceOf(IllustrationLedgerValidationError)
            expect(await store.getTurn(claimed.turnId)).toEqual(claimed)
        }
    })
})
