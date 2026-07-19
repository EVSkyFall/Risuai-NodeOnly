import {
    listPersistentKeys,
    readManyPersistentJson,
    readPersistentJson,
    removePersistentKey,
    writePersistentJson,
} from '../../storage/persistentKv'
import {
    IllustrationLedgerConfirmationRequiredError,
    IllustrationLedgerCorruptError,
    IllustrationLedgerHolderMismatchError,
    IllustrationLedgerIdempotencyConflictError,
    IllustrationLedgerLeaseConflictError,
    IllustrationLedgerNotFoundError,
    IllustrationLedgerValidationError,
    IllustrationLedgerVersionConflictError,
    IllustrationPromptContextRebindError,
} from './errors'
import type {
    IllustrationPromptContextV2,
    IllustrationTransportConfigV1,
} from './promptContextV2'
import { validateCoordinatorProofUnlocked } from './coordinatorRecord'
import {
    isLegacyIllustrationStoredPrompt,
    parseIllustrationPromptV1,
} from './imagePrompt'
import { withIllustrationLedgerLock } from './locks'
import {
    assertTransition,
    isPrunableJobState,
    isPrunableTurnState,
    isTerminalJobState,
    isTerminalTurnState,
} from './stateMachine'
import type {
    IllustrationCaptureOrigin,
    IllustrationHolderWrite,
    IllustrationCoordinatorProof,
    IllustrationJobFullSnapshotV1,
    IllustrationJobSnapshotV1,
    IllustrationJobRecordV1,
    IllustrationJobState,
    IllustrationJobTerminalSummaryV1,
    IllustrationJobTransitionPatch,
    IllustrationLeaseRecordFields,
    IllustrationRevisionChargeCertainty,
    IllustrationTargetV1,
    IllustrationTurnRecordV1,
    IllustrationTurnState,
    IllustrationTurnSnapshotV1,
    IllustrationTurnTargetV1,
    IllustrationWorkerEpochRecordV1,
    PlanManifestV1,
    StoredPlanManifestV1,
} from './types'

export const ILLUSTRATION_TURN_PREFIX = 'illustration:v1:turn:'
export const ILLUSTRATION_MANIFEST_PREFIX = 'illustration:v1:manifest:'
export const ILLUSTRATION_JOB_PREFIX = 'illustration:v1:job:'
export const ILLUSTRATION_TURN_JOBS_PREFIX = 'illustration:v1:turnjobs:'
export const ILLUSTRATION_WORKER_EPOCH_KEY = 'illustration:v1:workerEpoch'
// Prompt Target V2 (request §D1/§D5): the user's explicit transport election, set
// by the Plugin via a validated RPC. Core never guesses a non-native transport —
// this durable record is the only source. It stores NO credentials/URLs (those are
// referenced from the db by name at resolve time).
export const ILLUSTRATION_TRANSPORT_CONFIG_KEY = 'illustration:v1:transportConfig'
// Durable pending-turn index: the set of non-terminal turn IDs. `listPendingTurns`
// reads this and bulk-reads only those records, so the pending-listing cost stays
// proportional to in-flight turns instead of O(total accumulated turn history).
export const ILLUSTRATION_PENDING_TURNS_KEY = 'illustration:v1:pendingTurns'

// The listing subset of pending turn states (a subset of the full non-terminal set
// that the index tracks). Prepared/blocked_capture/awaiting_prompt turns stay in
// the index — they are in-flight, not terminal — but are not surfaced as pending.
const PENDING_TURN_LISTING_STATES: readonly IllustrationTurnState[] = [
    'awaiting_plan',
    'agent_blocked_retryable',
    'agent_blocked',
]

export const MAX_JOBS_PER_TURN = 15
export const MAX_SCENE_PAYLOAD_BYTES = 16 * 1024
export const MAX_PLAN_MANIFEST_BYTES = 192 * 1024
export const TURN_LEASE_DURATION_MS = 90_000
export const JOB_LEASE_DURATION_MS = 120_000
export const TERMINAL_RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const TURN_SUMMARY_RETENTION = 200
export const DEFAULT_PRUNE_MAX_DELETES = 100
export const MAX_AGENT_ATTEMPTS = 3
export const TERMINAL_SUMMARY_LIMIT = 50

const encoder = new TextEncoder()

export const illustrationTurnKey = (turnId: string) => `${ILLUSTRATION_TURN_PREFIX}${turnId}`
export const illustrationManifestKey = (turnId: string) => `${ILLUSTRATION_MANIFEST_PREFIX}${turnId}`
export const illustrationJobKey = (jobId: string) => `${ILLUSTRATION_JOB_PREFIX}${jobId}`
export const illustrationTurnJobsKey = (turnId: string) => `${ILLUSTRATION_TURN_JOBS_PREFIX}${turnId}`

type PlanManifestPreparedInput = Omit<PlanManifestV1, 'phase' | 'version'>
type Awaitable<T> = T | PromiseLike<T>

export type CreateTurnInput = {
    turnId: string
    idempotencyKey: string
    workerEpoch?: number
    origin?: IllustrationCaptureOrigin
    target?: IllustrationTurnTargetV1
    sourceTextUtf16?: string
    sourceRevisionHash?: string
    settingsFingerprint?: string
}

export type UpdateTurnInput = {
    turnId: string
    expectedVersion: number
    mutate: (
        draft: IllustrationTurnRecordV1,
    ) => Awaitable<void | IllustrationTurnRecordV1>
}

export type PrepareTurnPromptContextInput = {
    turnId: string
    expectedVersion: number
    promptContext: IllustrationPromptContextV2
}

// Durable persistence wrapper for the transport election (adds a monotonic version
// + updatedAt around IllustrationTransportConfigV1's payload).
type IllustrationTransportConfigRecordV1 = {
    schemaVersion: 1
    election: IllustrationTransportConfigV1['election']
    version: number
    updatedAt: number
}

export type CreateManifestPreparedInput = {
    manifest: PlanManifestPreparedInput
    turnExpectedVersion: number
    leaseId: string
    fence: number
    idempotencyKey: string
} & IllustrationCoordinatorProof

export type AdvanceManifestPhaseInput = {
    turnId: string
    expectedVersion: number
    to: 'records_complete' | 'projection_durable'
}

export type CreateJobsFromManifestInput = {
    turnId: string
    expectedManifestVersion: number
    workerEpoch?: number
}

export type TransitionJobInput = {
    jobId: string
    expectedVersion: number
    to: IllustrationJobState
    patch?: IllustrationJobTransitionPatch
    leaseId?: string
    fence?: number
    coordinatorLeaseId?: string
    coordinatorFence?: number
}

export type ClaimLeaseInput = {
    expectedVersion: number
    leaseId: string
} & IllustrationCoordinatorProof

export type ReportAgentFailureInput = IllustrationHolderWrite & IllustrationCoordinatorProof & {
    protocolVersion: 1
    kind: 'turn' | 'job'
    id: string
    idempotencyKey: string
    code: string
    retryable: boolean
}

export type RetryAgentFailureInput = IllustrationCoordinatorProof & {
    protocolVersion: 1
    kind: 'turn' | 'job'
    id: string
    expectedVersion: number
    confirmNewLlmCharge: true
}

export type CloseTurnFromPlanInput = IllustrationHolderWrite & IllustrationCoordinatorProof & {
    turnId: string
    to: 'stale' | 'corrupt'
    code: string
    idempotencyKey: string
}

export type RetryUncertainJobInput = {
    jobId: string
    expectedVersion: number
    confirmNewCharge: true
}

export type EnqueueRevisionImageInput = {
    jobId: string
    expectedVersion: number
    confirmNewImageCharge: true
}

export type PruneTerminalRecordsInput = {
    olderThanMs?: number
    maxDeletes?: number
}

export type PruneTerminalRecordsResult = {
    deletedJobIds: string[]
    deletedTurnIds: string[]
}

const transitionPatchKeys = new Set<keyof IllustrationJobTransitionPatch>([
    'idempotencyKey',
    'workerEpoch',
    'target',
    'prompt',
    'settingsFingerprint',
    'attemptId',
    'assetId',
    'error',
    'cancelRequestedAt',
])

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T
}

function hasOwn(value: object, key: PropertyKey): boolean {
    return Object.prototype.hasOwnProperty.call(value, key)
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
        return left.every((value, index) => jsonValuesEqual(value, right[index]))
    }
    if (left && right && typeof left === 'object' && typeof right === 'object') {
        const leftRecord = left as Record<string, unknown>
        const rightRecord = right as Record<string, unknown>
        const leftKeys = Object.keys(leftRecord).sort()
        const rightKeys = Object.keys(rightRecord).sort()
        return (
            leftKeys.length === rightKeys.length &&
            leftKeys.every(
                (key, index) =>
                    key === rightKeys[index] && jsonValuesEqual(leftRecord[key], rightRecord[key]),
            )
        )
    }
    return false
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new IllustrationLedgerValidationError(`${label} must be a non-empty string`)
    }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new IllustrationLedgerValidationError(`${label} must be a non-negative safe integer`)
    }
}

function assertVersion(expectedVersion: number, actualVersion: number): void {
    assertNonNegativeInteger(expectedVersion, 'expectedVersion')
    if (expectedVersion !== actualVersion) {
        throw new IllustrationLedgerVersionConflictError(expectedVersion, actualVersion)
    }
}

function assertJsonSerializable(value: unknown, label: string, seen = new Set<object>()): void {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new IllustrationLedgerValidationError(`${label} contains a non-finite number`)
        }
        return
    }
    if (typeof value !== 'object') {
        throw new IllustrationLedgerValidationError(`${label} is not JSON-serializable`)
    }
    if (seen.has(value)) {
        throw new IllustrationLedgerValidationError(`${label} contains a cycle`)
    }
    seen.add(value)
    if (Array.isArray(value)) {
        value.forEach((entry, index) => assertJsonSerializable(entry, `${label}[${index}]`, seen))
    } else {
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) {
            throw new IllustrationLedgerValidationError(`${label} must contain only plain objects`)
        }
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            assertJsonSerializable(entry, `${label}.${key}`, seen)
        }
    }
    seen.delete(value)
}

function jsonByteLength(value: unknown): number {
    return encoder.encode(JSON.stringify(value)).byteLength
}

function validateScenePayload(scenePayload: unknown, label: string): void {
    if (!scenePayload || typeof scenePayload !== 'object' || Array.isArray(scenePayload)) {
        throw new IllustrationLedgerValidationError(`${label} must be an object`)
    }
    const payload = scenePayload as { schemaVersion?: unknown; data?: unknown }
    if (!Number.isSafeInteger(payload.schemaVersion) || (payload.schemaVersion as number) < 1) {
        throw new IllustrationLedgerValidationError(`${label}.schemaVersion must be a positive integer`)
    }
    if (!hasOwn(payload, 'data')) {
        throw new IllustrationLedgerValidationError(`${label}.data is required`)
    }
    assertJsonSerializable(payload.data, `${label}.data`)
    if (jsonByteLength(scenePayload) > MAX_SCENE_PAYLOAD_BYTES) {
        throw new IllustrationLedgerValidationError(
            `${label} exceeds the ${MAX_SCENE_PAYLOAD_BYTES}-byte limit`,
        )
    }
}

function validateManifest(manifest: PlanManifestV1): void {
    assertNonEmptyString(manifest.turnId, 'manifest.turnId')
    assertNonEmptyString(manifest.planHash, 'manifest.planHash')
    assertNonEmptyString(manifest.sourceRevisionHash, 'manifest.sourceRevisionHash')
    assertNonNegativeInteger(manifest.expectedCount, 'manifest.expectedCount')
    assertNonNegativeInteger(manifest.version, 'manifest.version')
    if (!['prepared', 'records_complete', 'projection_durable'].includes(manifest.phase)) {
        throw new IllustrationLedgerValidationError('manifest.phase is invalid')
    }
    if (!Array.isArray(manifest.jobs)) {
        throw new IllustrationLedgerValidationError('manifest.jobs must be an array')
    }
    if (manifest.expectedCount > MAX_JOBS_PER_TURN || manifest.jobs.length > MAX_JOBS_PER_TURN) {
        throw new IllustrationLedgerValidationError(`A turn may contain at most ${MAX_JOBS_PER_TURN} jobs`)
    }
    if (manifest.expectedCount !== manifest.jobs.length) {
        throw new IllustrationLedgerValidationError('manifest.expectedCount must equal manifest.jobs.length')
    }

    const jobIds = new Set<string>()
    const slotTokens = new Set<string>()
    const sceneIds = new Set<string>()
    manifest.jobs.forEach((job, index) => {
        const label = `manifest.jobs[${index}]`
        assertNonEmptyString(job.jobId, `${label}.jobId`)
        assertNonEmptyString(job.slotToken, `${label}.slotToken`)
        assertNonEmptyString(job.sceneId, `${label}.sceneId`)
        assertNonNegativeInteger(job.insertAfterUtf16, `${label}.insertAfterUtf16`)
        validateScenePayload(job.scenePayload, `${label}.scenePayload`)
        if (jobIds.has(job.jobId)) throw new IllustrationLedgerValidationError('Duplicate jobId in manifest')
        if (slotTokens.has(job.slotToken)) {
            throw new IllustrationLedgerValidationError('Duplicate slotToken in manifest')
        }
        if (sceneIds.has(job.sceneId)) throw new IllustrationLedgerValidationError('Duplicate sceneId in manifest')
        jobIds.add(job.jobId)
        slotTokens.add(job.slotToken)
        sceneIds.add(job.sceneId)
    })

    const canonicalManifest: PlanManifestV1 = {
        turnId: manifest.turnId,
        planHash: manifest.planHash,
        expectedCount: manifest.expectedCount,
        sourceRevisionHash: manifest.sourceRevisionHash,
        jobs: manifest.jobs,
        phase: 'prepared',
        version: 1,
    }
    assertJsonSerializable(canonicalManifest, 'manifest')
    if (jsonByteLength(canonicalManifest) > MAX_PLAN_MANIFEST_BYTES) {
        throw new IllustrationLedgerValidationError(
            `Plan manifest exceeds the ${MAX_PLAN_MANIFEST_BYTES}-byte limit`,
        )
    }
}

function validateWorkerEpoch(workerEpoch: number): void {
    assertNonNegativeInteger(workerEpoch, 'workerEpoch')
}

function validateRecordBasics(record: IllustrationLeaseRecordFields): void {
    assertNonNegativeInteger(record.version, 'record.version')
    assertNonNegativeInteger(record.leaseExpiresAt, 'record.leaseExpiresAt')
    assertNonNegativeInteger(record.fence, 'record.fence')
    validateWorkerEpoch(record.workerEpoch)
    assertNonNegativeInteger(record.updatedAt, 'record.updatedAt')
    assertNonEmptyString(record.idempotencyKey, 'record.idempotencyKey')
    assertNonNegativeInteger(record.agentAttemptCount ?? 0, 'record.agentAttemptCount')
    if (
        record.agentHardRetryPending !== undefined
        && typeof record.agentHardRetryPending !== 'boolean'
    ) {
        throw new IllustrationLedgerValidationError('record.agentHardRetryPending must be a boolean')
    }
    if (record.leaseId !== null) assertNonEmptyString(record.leaseId, 'record.leaseId')
}

function coordinatorProofFrom(input: {
    coordinatorLeaseId?: string
    coordinatorFence?: number
}): IllustrationCoordinatorProof {
    return {
        coordinatorLeaseId: input.coordinatorLeaseId as string,
        coordinatorFence: input.coordinatorFence as number,
    }
}

export function projectTurnSnapshot(
    record: IllustrationTurnRecordV1,
    callerLeaseId?: string,
): IllustrationTurnSnapshotV1 {
    return {
        protocolVersion: 1,
        turnId: record.turnId,
        version: record.version,
        state: record.state,
        origin: record.origin ?? 'automatic',
        ...(record.leaseId === null ? {} : {
            lease: {
                expiresAt: record.leaseExpiresAt,
                fence: record.fence,
                ownedByCaller: callerLeaseId !== undefined && record.leaseId === callerLeaseId,
            },
        }),
        ...(record.target ? { target: cloneJson(record.target) } : {}),
        ...(record.sourceTextUtf16 === undefined ? {} : { sourceTextUtf16: record.sourceTextUtf16 }),
        ...(record.sourceRevisionHash === undefined ? {} : {
            sourceRevisionHash: record.sourceRevisionHash,
        }),
        offsetEncoding: 'utf-16',
        ...(record.settingsFingerprint === undefined ? {} : {
            settingsFingerprint: record.settingsFingerprint,
        }),
        ...(record.promptContext === undefined ? {} : {
            promptContext: cloneJson(record.promptContext),
        }),
        agentAttemptCount: record.agentAttemptCount ?? 0,
        updatedAt: record.updatedAt,
        ...(record.error ? { error: cloneJson(record.error) } : {}),
    }
}

export function projectFullJobSnapshot(
    record: IllustrationJobRecordV1,
    callerLeaseId?: string,
): IllustrationJobFullSnapshotV1 {
    return {
        protocolVersion: 1,
        turnId: record.turnId,
        jobId: record.jobId,
        slotOrdinal: record.slotOrdinal ?? 0,
        version: record.version,
        state: record.state,
        ...(record.leaseId === null ? {} : {
            lease: {
                expiresAt: record.leaseExpiresAt,
                fence: record.fence,
                ownedByCaller: callerLeaseId !== undefined && record.leaseId === callerLeaseId,
            },
        }),
        workerEpoch: record.workerEpoch,
        ...(record.target ? { target: cloneJson(record.target) } : {}),
        sceneId: record.sceneId,
        scenePayload: cloneJson(record.scenePayload),
        hasDurablePrompt: record.prompt !== undefined,
        ...(record.attemptId === undefined ? {} : { attemptId: record.attemptId }),
        ...(record.assetId === undefined ? {} : { assetId: record.assetId }),
        createdAt: record.createdAt ?? record.updatedAt,
        updatedAt: record.updatedAt,
        agentAttemptCount: record.agentAttemptCount ?? 0,
        ...(record.error ? { error: cloneJson(record.error) } : {}),
        ...(record.revision ? { revision: projectRevisionDescriptor(record) } : {}),
    }
}

// Image Revision V1: the private-bridge projection of a revision child's descriptor,
// enriched with the provider-dispatch/charge status derived from the current state.
function projectRevisionDescriptor(
    record: IllustrationJobRecordV1,
): NonNullable<IllustrationJobFullSnapshotV1['revision']> {
    const revision = record.revision!
    const status = revisionJobChargeStatus(record.state, record.error?.code)
    return {
        referenceId: revision.referenceId,
        lineageId: revision.lineageId,
        revisionId: revision.revisionId,
        parentRevisionId: revision.parentRevisionId,
        mode: revision.mode,
        disposition: revision.disposition,
        operationVersion: revision.admittedOperationVersion,
        providerDispatched: status.providerDispatched,
        chargeCertainty: status.chargeCertainty,
    }
}

// Kept in sync with revisionLedger.jobChargeStatus; duplicated here to avoid a
// store<->revisionLedger import cycle (revisionLedger imports store).
function revisionJobChargeStatus(
    state: IllustrationJobState,
    errorCode: string | undefined,
): { providerDispatched: boolean; chargeCertainty: IllustrationRevisionChargeCertainty } {
    switch (state) {
        case 'prepared':
        case 'awaiting_prompt':
        case 'prompt_ready':
        case 'agent_blocked_retryable':
        case 'agent_blocked':
        case 'queued':
        case 'blocked_config':
            return { providerDispatched: false, chargeCertainty: 'not-started' }
        case 'generating':
        case 'cancel_requested':
        case 'asset_writing':
        case 'asset_ready':
        case 'committing':
        case 'committed':
            return { providerDispatched: true, chargeCertainty: 'charged' }
        case 'uncertain':
            return { providerDispatched: true, chargeCertainty: 'uncertain' }
        case 'failed':
            return errorCode?.startsWith('provider')
                ? { providerDispatched: true, chargeCertainty: 'not-charged' }
                : { providerDispatched: false, chargeCertainty: 'not-charged' }
        default:
            return { providerDispatched: false, chargeCertainty: 'not-started' }
    }
}

function toTerminalJobSummary(record: IllustrationJobRecordV1): IllustrationJobTerminalSummaryV1 {
    if (!isPrunableJobState(record.state)) {
        throw new IllustrationLedgerCorruptError(`Job ${record.jobId} is not terminal-summary eligible`)
    }
    return {
        protocolVersion: 1,
        turnId: record.turnId,
        jobId: record.jobId,
        slotOrdinal: record.slotOrdinal ?? 0,
        version: record.version,
        state: record.state as IllustrationJobTerminalSummaryV1['state'],
        ...(record.target ? {
            target: {
                chaId: record.target.chaId,
                conversationId: record.target.conversationId,
                expectedMessageId: record.target.expectedMessageId,
                rootTurnId: record.target.rootTurnId,
            },
        } : {}),
        sceneId: record.sceneId,
        createdAt: record.createdAt ?? record.updatedAt,
        updatedAt: record.updatedAt,
        ...(record.error ? { error: { code: record.error.code } } : {}),
    }
}

function compareJobSnapshotOrder(
    left: IllustrationJobSnapshotV1,
    right: IllustrationJobSnapshotV1,
): number {
    return left.slotOrdinal - right.slotOrdinal
        || left.createdAt - right.createdAt
        || left.jobId.localeCompare(right.jobId)
}

function replayedAgentFailure<T extends IllustrationTurnRecordV1 | IllustrationJobRecordV1>(
    current: T,
    input: ReportAgentFailureInput,
): T | null {
    const history = current.agentFailureWrites
        ?? (current.lastAgentFailureWrite ? [current.lastAgentFailureWrite] : [])
    const receipt = history.find((candidate) => candidate.idempotencyKey === input.idempotencyKey)
    if (!receipt) return null
    if (receipt.leaseId !== input.leaseId || receipt.fence !== input.fence) {
        throw new IllustrationLedgerHolderMismatchError(
            'Repeated Agent failure report must use the original holder lease and fence',
        )
    }
    if (
        receipt.previousVersion !== input.expectedVersion
        || receipt.code !== input.code
        || receipt.retryable !== input.retryable
    ) {
        throw new IllustrationLedgerIdempotencyConflictError(
            'Agent failure idempotencyKey is bound to different report data',
        )
    }
    if (
        current.version !== receipt.resultVersion
        || current.state !== receipt.outcomeState
        || (current.agentAttemptCount ?? 0) !== receipt.agentAttemptCount
    ) {
        throw new IllustrationLedgerIdempotencyConflictError(
            'Agent failure idempotencyKey is stale after the blocked outcome changed',
        )
    }
    return cloneJson(current)
}

function jobIdempotencyKey(manifest: PlanManifestV1, jobId: string): string {
    return `manifest:${manifest.planHash}:job:${jobId}`
}

function slotOrdinalsForManifest(manifest: PlanManifestV1): Map<string, number> {
    const ordered = manifest.jobs
        .map((job, manifestIndex) => ({ job, manifestIndex }))
        .sort((left, right) =>
            left.job.insertAfterUtf16 - right.job.insertAfterUtf16
            || left.manifestIndex - right.manifestIndex)
    return new Map(ordered.map(({ job }, slotOrdinal) => [job.jobId, slotOrdinal]))
}

function manifestBodyMatches(
    stored: StoredPlanManifestV1,
    input: PlanManifestPreparedInput,
    idempotencyKey: string,
): boolean {
    return (
        stored.idempotencyKey === idempotencyKey &&
        stored.turnId === input.turnId &&
        stored.planHash === input.planHash &&
        stored.expectedCount === input.expectedCount &&
        stored.sourceRevisionHash === input.sourceRevisionHash &&
        jsonValuesEqual(stored.jobs, input.jobs)
    )
}

function jobMatchesManifest(
    record: IllustrationJobRecordV1,
    manifest: PlanManifestV1,
    job: PlanManifestV1['jobs'][number],
): boolean {
    const slotOrdinal = slotOrdinalsForManifest(manifest).get(job.jobId)
    return (
        record.jobId === job.jobId &&
        record.turnId === manifest.turnId &&
        record.creationIdempotencyKey === jobIdempotencyKey(manifest, job.jobId) &&
        record.slotToken === job.slotToken &&
        record.insertAfterUtf16 === job.insertAfterUtf16 &&
        record.sceneId === job.sceneId &&
        record.sourceRevisionHash === manifest.sourceRevisionHash &&
        record.slotOrdinal === slotOrdinal &&
        jsonValuesEqual(record.scenePayload, job.scenePayload)
    )
}

function turnMatchesCreateInput(record: IllustrationTurnRecordV1, input: CreateTurnInput): boolean {
    return (
        record.turnId === input.turnId &&
        record.idempotencyKey === input.idempotencyKey &&
        record.workerEpoch === (input.workerEpoch ?? 0) &&
        record.origin === input.origin &&
        jsonValuesEqual(record.target, input.target) &&
        record.sourceTextUtf16 === input.sourceTextUtf16 &&
        record.sourceRevisionHash === input.sourceRevisionHash &&
        record.settingsFingerprint === input.settingsFingerprint
    )
}

export function validateHolderWrite(
    record: Pick<
        IllustrationLeaseRecordFields,
        'leaseId' | 'leaseExpiresAt' | 'fence' | 'version'
    >,
    input: IllustrationHolderWrite,
    now = Date.now(),
): void {
    assertVersion(input.expectedVersion, record.version)
    assertNonEmptyString(input.leaseId, 'leaseId')
    assertNonNegativeInteger(input.fence, 'fence')
    if (record.leaseId !== input.leaseId) {
        throw new IllustrationLedgerHolderMismatchError('Illustration leaseId does not match the active holder')
    }
    if (record.fence !== input.fence) {
        throw new IllustrationLedgerHolderMismatchError('Illustration fence does not match the active holder')
    }
    if (record.leaseExpiresAt <= now) {
        throw new IllustrationLedgerHolderMismatchError('Illustration holder lease has expired')
    }
}

function validateHolderIdentityWithoutVersion(
    record: Pick<IllustrationLeaseRecordFields, 'leaseId' | 'leaseExpiresAt' | 'fence'>,
    leaseId: string | undefined,
    fence: number | undefined,
    now: number,
): boolean {
    return (
        leaseId !== undefined &&
        fence !== undefined &&
        record.leaseId === leaseId &&
        record.fence === fence &&
        record.leaseExpiresAt > now
    )
}

function patchMatchesRecord(
    record: IllustrationJobRecordV1,
    patch: IllustrationJobTransitionPatch,
): boolean {
    return Object.entries(patch).every(([key, value]) => {
        if (key === 'error' && value === null) return record.error === undefined
        if (key === 'cancelRequestedAt' && value === null) return record.cancelRequestedAt === undefined
        return jsonValuesEqual(record[key as keyof IllustrationJobRecordV1], value)
    })
}

function sortedPatchKeys(patch: IllustrationJobTransitionPatch): string[] {
    return Object.keys(patch).sort()
}

function isLostAckTransition(
    record: IllustrationJobRecordV1,
    input: TransitionJobInput,
    patch: IllustrationJobTransitionPatch,
    now: number,
): boolean {
    if (
        record.version !== input.expectedVersion + 1 ||
        record.state !== input.to ||
        !patch.idempotencyKey ||
        record.idempotencyKey !== patch.idempotencyKey
    ) {
        return false
    }
    if (!patchMatchesRecord(record, patch)) {
        throw new IllustrationLedgerCorruptError(
            'A repeated transition idempotencyKey has conflicting patch data',
        )
    }
    if (record.lastHolderWrite) {
        if (!jsonValuesEqual(record.lastHolderWrite.patchKeys, sortedPatchKeys(patch))) {
            throw new IllustrationLedgerCorruptError(
                'A repeated holder write must include the complete original patch',
            )
        }
        if (
            input.leaseId !== record.lastHolderWrite.leaseId ||
            input.fence !== record.lastHolderWrite.fence
        ) {
            throw new IllustrationLedgerHolderMismatchError(
                'Repeated holder write must include the original leaseId and fence',
            )
        }
        if (
            record.leaseId !== record.lastHolderWrite.leaseId ||
            record.fence !== record.lastHolderWrite.fence
        ) {
            throw new IllustrationLedgerHolderMismatchError(
                'Repeated holder write no longer matches the stored lease and fence',
            )
        }
    } else if (input.leaseId !== undefined || input.fence !== undefined) {
        if (!validateHolderIdentityWithoutVersion(record, input.leaseId, input.fence, now)) {
            throw new IllustrationLedgerHolderMismatchError(
                'Repeated holder write does not match the active lease and fence',
            )
        }
    }
    return true
}

function makeOpaqueId(prefix: string): string {
    if (globalThis.crypto?.randomUUID) {
        return `${prefix}:${globalThis.crypto.randomUUID()}`
    }
    if (globalThis.crypto?.getRandomValues) {
        const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
        return `${prefix}:${[...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')}`
    }
    throw new IllustrationLedgerValidationError('Secure random identifiers are unavailable')
}

export class IllustrationJobStore {
    private async readTurnUnlocked(turnId: string): Promise<IllustrationTurnRecordV1 | null> {
        return await readPersistentJson<IllustrationTurnRecordV1>(illustrationTurnKey(turnId))
    }

    private async requireTurnUnlocked(turnId: string): Promise<IllustrationTurnRecordV1> {
        const record = await this.readTurnUnlocked(turnId)
        if (!record) throw new IllustrationLedgerNotFoundError('turn', turnId)
        return record
    }

    private async readManifestUnlocked(turnId: string): Promise<StoredPlanManifestV1 | null> {
        return await readPersistentJson<StoredPlanManifestV1>(illustrationManifestKey(turnId))
    }

    private async requireManifestUnlocked(turnId: string): Promise<StoredPlanManifestV1> {
        const manifest = await this.readManifestUnlocked(turnId)
        if (!manifest) throw new IllustrationLedgerNotFoundError('manifest', turnId)
        return manifest
    }

    private async readJobUnlocked(jobId: string): Promise<IllustrationJobRecordV1 | null> {
        return await readPersistentJson<IllustrationJobRecordV1>(illustrationJobKey(jobId))
    }

    private async requireJobUnlocked(jobId: string): Promise<IllustrationJobRecordV1> {
        const record = await this.readJobUnlocked(jobId)
        if (!record) throw new IllustrationLedgerNotFoundError('job', jobId)
        return record
    }

    private async listTurnJobRecordsUnlocked(turnId: string): Promise<IllustrationJobRecordV1[]> {
        const jobIds =
            (await readPersistentJson<string[]>(illustrationTurnJobsKey(turnId))) ?? []
        const records = await readManyPersistentJson<IllustrationJobRecordV1>(
            jobIds.map((jobId) => illustrationJobKey(jobId)),
        )
        return records
            .filter((record): record is IllustrationJobRecordV1 => record !== null)
            .map((record) => {
                if (record.turnId !== turnId) {
                    throw new IllustrationLedgerCorruptError(
                        `Turn-job index points to job ${record.jobId} from another turn`,
                    )
                }
                return record
            })
    }

    private async readPendingIndexUnlocked(): Promise<string[] | null> {
        let raw: unknown
        try {
            raw = await readPersistentJson<unknown>(ILLUSTRATION_PENDING_TURNS_KEY)
        } catch {
            // Corrupt index bytes: report as missing so the caller rebuilds from
            // the authoritative turn scan rather than fabricating a listing.
            return null
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
        const parsed = raw as { schemaVersion?: unknown; turnIds?: unknown }
        if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.turnIds)) return null
        if (!parsed.turnIds.every((id) => typeof id === 'string' && id.length > 0)) return null
        return [...new Set(parsed.turnIds as string[])]
    }

    private async writePendingIndexUnlocked(turnIds: readonly string[]): Promise<void> {
        const unique = [...new Set(turnIds)].sort()
        await writePersistentJson(ILLUSTRATION_PENDING_TURNS_KEY, { schemaVersion: 1, turnIds: unique })
    }

    private async rebuildPendingIndexUnlocked(): Promise<string[]> {
        const keys = await listPersistentKeys(ILLUSTRATION_TURN_PREFIX)
        const records = await readManyPersistentJson<IllustrationTurnRecordV1>(keys)
        const turnIds = records
            .filter((record): record is IllustrationTurnRecordV1 =>
                record !== null && !isTerminalTurnState(record.state))
            .map((record) => record.turnId)
        const unique = [...new Set(turnIds)].sort()
        await this.writePendingIndexUnlocked(unique)
        return unique
    }

    private async ensurePendingIndexUnlocked(): Promise<string[]> {
        return (await this.readPendingIndexUnlocked()) ?? (await this.rebuildPendingIndexUnlocked())
    }

    // Called within the ledger lock after every turn-state write. Membership tracks
    // non-terminal turns; a terminal transition removes the turn. Missing/corrupt
    // index triggers a one-time rebuild from the scan before the delta is applied,
    // so a partial write can never overwrite the complete set with a single entry.
    private async syncPendingIndexUnlocked(
        turnId: string,
        state: IllustrationTurnState,
    ): Promise<void> {
        const ids = await this.ensurePendingIndexUnlocked()
        const shouldBePending = !isTerminalTurnState(state)
        const has = ids.includes(turnId)
        if (shouldBePending && !has) {
            await this.writePendingIndexUnlocked([...ids, turnId])
        } else if (!shouldBePending && has) {
            await this.writePendingIndexUnlocked(ids.filter((id) => id !== turnId))
        }
    }

    private async finalizeTurnAfterJobsUnlocked(
        turnId: string,
    ): Promise<IllustrationTurnRecordV1 | null> {
        // Image Revision V1: revision child jobs carry a synthetic turnId with no
        // turn record. There is nothing to finalize; return null rather than throw
        // so the shared terminal-transition/cancel paths tolerate revision children.
        const observed = await this.readTurnUnlocked(turnId)
        if (!observed) return null
        if (observed.state !== 'awaiting_prompt') return cloneJson(observed)

        const jobs = await this.listTurnJobRecordsUnlocked(turnId)
        if (jobs.length === 0 || !jobs.every((job) => isTerminalJobState(job.state))) {
            return cloneJson(observed)
        }

        const current = await this.requireTurnUnlocked(turnId)
        if (current.state !== 'awaiting_prompt') return cloneJson(current)
        assertVersion(observed.version, current.version)

        const next = cloneJson(current)
        if (jobs.some((job) => job.state === 'committed')) next.state = 'completed'
        else if (jobs.some((job) => job.state === 'corrupt')) next.state = 'corrupt'
        else if (jobs.some((job) => job.state === 'stale')) next.state = 'stale'
        else next.state = 'completed'

        if (next.state === 'stale' || next.state === 'corrupt') {
            next.error = { code: `job_${next.state}` }
        } else {
            delete next.error
        }
        assertTransition('turn', current.state, next.state)
        validateRecordBasics(next)
        assertJsonSerializable(next, 'turn record')
        next.version = current.version + 1
        next.updatedAt = Date.now()
        await writePersistentJson(illustrationTurnKey(turnId), next)
        await this.syncPendingIndexUnlocked(next.turnId, next.state)
        return cloneJson(next)
    }

    private async assertManifestRecordsCompleteUnlocked(
        manifest: StoredPlanManifestV1,
    ): Promise<void> {
        validateManifest(manifest)
        const records = await Promise.all(
            manifest.jobs.map((job) => this.readJobUnlocked(job.jobId)),
        )
        records.forEach((record, index) => {
            if (!record || !jobMatchesManifest(record, manifest, manifest.jobs[index])) {
                throw new IllustrationLedgerCorruptError(
                    `Manifest job ${manifest.jobs[index].jobId} is missing or conflicting`,
                )
            }
        })
        const index = await readPersistentJson<string[]>(illustrationTurnJobsKey(manifest.turnId))
        const expectedJobIds = manifest.jobs.map((job) => job.jobId)
        if (!Array.isArray(index) || !jsonValuesEqual(index, expectedJobIds)) {
            throw new IllustrationLedgerCorruptError(
                `Turn-job index is incomplete for manifest ${manifest.turnId}`,
            )
        }
    }

    async createTurn(input: CreateTurnInput): Promise<IllustrationTurnRecordV1> {
        return await withIllustrationLedgerLock(async () => {
            assertNonEmptyString(input.turnId, 'turnId')
            assertNonEmptyString(input.idempotencyKey, 'idempotencyKey')
            const workerEpoch = input.workerEpoch ?? 0
            validateWorkerEpoch(workerEpoch)
            if (input.target) assertJsonSerializable(input.target, 'target')

            const existing = await this.readTurnUnlocked(input.turnId)
            if (existing) {
                if (turnMatchesCreateInput(existing, input)) return cloneJson(existing)
                throw new IllustrationLedgerCorruptError(
                    `Turn ${input.turnId} already exists with conflicting creation data`,
                )
            }

            const now = Date.now()
            const record: IllustrationTurnRecordV1 = {
                schemaVersion: 1,
                turnId: input.turnId,
                state: 'prepared',
                version: 1,
                leaseId: null,
                leaseExpiresAt: 0,
                fence: 0,
                workerEpoch,
                updatedAt: now,
                idempotencyKey: input.idempotencyKey,
                agentAttemptCount: 0,
                ...(input.origin !== undefined ? { origin: input.origin } : {}),
                ...(input.target ? { target: cloneJson(input.target) } : {}),
                ...(input.sourceTextUtf16 !== undefined ? { sourceTextUtf16: input.sourceTextUtf16 } : {}),
                ...(input.sourceRevisionHash !== undefined
                    ? { sourceRevisionHash: input.sourceRevisionHash }
                    : {}),
                ...(input.settingsFingerprint !== undefined
                    ? { settingsFingerprint: input.settingsFingerprint }
                    : {}),
            }
            await writePersistentJson(illustrationTurnKey(input.turnId), record)
            await this.syncPendingIndexUnlocked(record.turnId, record.state)
            return cloneJson(record)
        })
    }

    async getTurn(turnId: string): Promise<IllustrationTurnRecordV1 | null> {
        return await withIllustrationLedgerLock(async () => {
            assertNonEmptyString(turnId, 'turnId')
            const record = await this.readTurnUnlocked(turnId)
            return record ? cloneJson(record) : null
        })
    }

    async listTurns(): Promise<IllustrationTurnRecordV1[]> {
        return await withIllustrationLedgerLock(async () => {
            const keys = await listPersistentKeys(ILLUSTRATION_TURN_PREFIX)
            const records = await Promise.all(
                keys.map((key) => readPersistentJson<IllustrationTurnRecordV1>(key)),
            )
            return records
                .filter((record): record is IllustrationTurnRecordV1 => record !== null)
                .sort((left, right) => right.updatedAt - left.updatedAt)
                .map(cloneJson)
        })
    }

    async updateTurn(input: UpdateTurnInput): Promise<IllustrationTurnRecordV1> {
        return await withIllustrationLedgerLock(async () => {
            const current = await this.requireTurnUnlocked(input.turnId)
            assertVersion(input.expectedVersion, current.version)
            const draft = cloneJson(current)
            const returned = await input.mutate(draft)
            const candidate = returned ?? draft
            if (!candidate || typeof candidate !== 'object') {
                throw new IllustrationLedgerValidationError('Turn mutator must return a turn record or void')
            }
            if (
                candidate.turnId !== current.turnId
                || candidate.schemaVersion !== 1
                || candidate.origin !== current.origin
            ) {
                throw new IllustrationLedgerValidationError('Turn identity fields are immutable')
            }
            if (
                candidate.leaseId !== current.leaseId ||
                candidate.leaseExpiresAt !== current.leaseExpiresAt ||
                candidate.fence !== current.fence
            ) {
                throw new IllustrationLedgerValidationError('Turn lease fields may only change through claimTurn')
            }
            if (
                candidate.agentAttemptCount !== current.agentAttemptCount
                || candidate.agentHardRetryPending !== current.agentHardRetryPending
                || !jsonValuesEqual(candidate.lastAgentFailureWrite, current.lastAgentFailureWrite)
                || !jsonValuesEqual(candidate.agentFailureWrites, current.agentFailureWrites)
                || !jsonValuesEqual(candidate.lastPlanClosureWrite, current.lastPlanClosureWrite)
            ) {
                throw new IllustrationLedgerValidationError(
                    'Turn failure counters and closure receipts may only change through their dedicated ledger operations',
                )
            }
            if (
                (current.state === 'agent_blocked_retryable' || current.state === 'agent_blocked')
                && candidate.state === 'awaiting_plan'
            ) {
                throw new IllustrationLedgerValidationError(
                    'Agent-blocked turns may only be reopened through retryAgentFailure',
                )
            }
            if (
                current.state === 'awaiting_plan'
                && (candidate.state === 'agent_blocked_retryable' || candidate.state === 'agent_blocked')
            ) {
                throw new IllustrationLedgerValidationError(
                    'Agent failure states may only be entered through reportAgentFailure',
                )
            }
            if (candidate.state === 'cancelled' && current.state !== 'cancelled') {
                throw new IllustrationLedgerValidationError(
                    'Turn cancellation must use requestCancelTurn',
                )
            }
            if (candidate.state !== current.state) {
                assertTransition('turn', current.state, candidate.state)
            }
            validateRecordBasics(candidate)
            assertJsonSerializable(candidate, 'turn record')
            candidate.version = current.version + 1
            candidate.updatedAt = Date.now()
            await writePersistentJson(illustrationTurnKey(current.turnId), candidate)
            await this.syncPendingIndexUnlocked(candidate.turnId, candidate.state)
            return cloneJson(candidate)
        })
    }

    // Prompt Target V2 (request §4): atomically bind a durable PromptContext to a
    // turn under version CAS. A turn that already carries a context REJECTS the
    // re-bind with a stable validation-family error — prepared targets never drift.
    async prepareTurnPromptContext(
        input: PrepareTurnPromptContextInput,
    ): Promise<IllustrationTurnRecordV1> {
        return await this.updateTurn({
            turnId: input.turnId,
            expectedVersion: input.expectedVersion,
            mutate: (draft) => {
                if (draft.promptContext !== undefined) {
                    throw new IllustrationPromptContextRebindError()
                }
                draft.promptContext = input.promptContext
            },
        })
    }

    async createManifestPrepared(
        input: CreateManifestPreparedInput,
    ): Promise<StoredPlanManifestV1> {
        return await withIllustrationLedgerLock(async () => {
            assertNonEmptyString(input.idempotencyKey, 'idempotencyKey')
            assertNonEmptyString(input.manifest.turnId, 'manifest.turnId')
            assertJsonSerializable(input.manifest, 'plan manifest')

            const now = Date.now()
            await validateCoordinatorProofUnlocked(input, { now })
            const existing = await this.readManifestUnlocked(input.manifest.turnId)
            if (
                existing &&
                manifestBodyMatches(existing, input.manifest, input.idempotencyKey)
            ) {
                const turn = await this.requireTurnUnlocked(input.manifest.turnId)
                if (existing.holderWrite) {
                    if (
                        existing.holderWrite.turnExpectedVersion !== input.turnExpectedVersion
                        || existing.holderWrite.leaseId !== input.leaseId
                        || existing.holderWrite.fence !== input.fence
                    ) {
                        throw new IllustrationLedgerHolderMismatchError(
                            'Repeated plan submission must use the original turn version, lease, and fence',
                        )
                    }
                } else {
                    validateHolderWrite(turn, {
                        leaseId: input.leaseId,
                        expectedVersion: input.turnExpectedVersion,
                        fence: input.fence,
                    }, now)
                }
                if ((turn.agentAttemptCount ?? 0) !== 0 || turn.agentHardRetryPending === true) {
                    const reset: IllustrationTurnRecordV1 = {
                        ...turn,
                        agentAttemptCount: 0,
                        version: turn.version + 1,
                        updatedAt: now,
                    }
                    delete reset.agentHardRetryPending
                    await writePersistentJson(illustrationTurnKey(turn.turnId), reset)
                }
                return cloneJson(existing)
            }

            const manifestCandidate: PlanManifestV1 = {
                ...input.manifest,
                phase: 'prepared',
                version: 1,
            }
            validateManifest(manifestCandidate)
            const manifest = cloneJson(manifestCandidate)

            const turn = await this.requireTurnUnlocked(manifest.turnId)
            if (turn.state !== 'awaiting_plan') {
                throw new IllustrationLedgerValidationError('Only an awaiting_plan turn may accept a plan')
            }
            validateHolderWrite(turn, {
                leaseId: input.leaseId,
                expectedVersion: input.turnExpectedVersion,
                fence: input.fence,
            })

            if (existing) {
                throw new IllustrationLedgerCorruptError(
                    `Turn ${manifest.turnId} already has a conflicting plan manifest`,
                )
            }

            const stored: StoredPlanManifestV1 = {
                ...manifest,
                updatedAt: now,
                idempotencyKey: input.idempotencyKey,
                holderWrite: {
                    turnExpectedVersion: input.turnExpectedVersion,
                    leaseId: input.leaseId,
                    fence: input.fence,
                },
            }
            await writePersistentJson(illustrationManifestKey(manifest.turnId), stored)
            if ((turn.agentAttemptCount ?? 0) !== 0 || turn.agentHardRetryPending === true) {
                const reset: IllustrationTurnRecordV1 = {
                    ...turn,
                    agentAttemptCount: 0,
                    version: turn.version + 1,
                    updatedAt: now,
                }
                delete reset.agentHardRetryPending
                await writePersistentJson(illustrationTurnKey(turn.turnId), reset)
            }
            return cloneJson(stored)
        })
    }

    async getManifest(turnId: string): Promise<StoredPlanManifestV1 | null> {
        return await withIllustrationLedgerLock(async () => {
            assertNonEmptyString(turnId, 'turnId')
            const manifest = await this.readManifestUnlocked(turnId)
            return manifest ? cloneJson(manifest) : null
        })
    }

    async advanceManifestPhase(input: AdvanceManifestPhaseInput): Promise<StoredPlanManifestV1> {
        return await withIllustrationLedgerLock(async () => {
            const current = await this.requireManifestUnlocked(input.turnId)
            if (current.phase === input.to) {
                if (
                    current.version === input.expectedVersion ||
                    current.version === input.expectedVersion + 1
                ) {
                    return cloneJson(current)
                }
                throw new IllustrationLedgerVersionConflictError(input.expectedVersion, current.version)
            }
            assertVersion(input.expectedVersion, current.version)
            const allowed =
                (current.phase === 'prepared' && input.to === 'records_complete') ||
                (current.phase === 'records_complete' && input.to === 'projection_durable')
            if (!allowed) {
                throw new IllustrationLedgerValidationError(
                    `Manifest phase must advance one step: ${current.phase} -> ${input.to}`,
                )
            }
            if (current.phase === 'prepared' && input.to === 'records_complete') {
                await this.assertManifestRecordsCompleteUnlocked(current)
            }
            const next: StoredPlanManifestV1 = {
                ...current,
                phase: input.to,
                version: current.version + 1,
                updatedAt: Date.now(),
            }
            await writePersistentJson(illustrationManifestKey(current.turnId), next)
            return cloneJson(next)
        })
    }

    async createJobsFromManifest(
        input: CreateJobsFromManifestInput,
    ): Promise<IllustrationJobRecordV1[]> {
        return await withIllustrationLedgerLock(async () => {
            const manifest = await this.requireManifestUnlocked(input.turnId)
            validateManifest(manifest)
            const workerEpoch = input.workerEpoch ?? 0
            validateWorkerEpoch(workerEpoch)

            const existing = await Promise.all(
                manifest.jobs.map((job) => this.readJobUnlocked(job.jobId)),
            )
            const desiredIndex = manifest.jobs.map((job) => job.jobId)
            const currentIndex = await readPersistentJson<string[]>(
                illustrationTurnJobsKey(manifest.turnId),
            )
            if (
                existing.every(
                    (record, index) =>
                        record !== null && jobMatchesManifest(record, manifest, manifest.jobs[index]),
                ) &&
                Array.isArray(currentIndex) &&
                jsonValuesEqual(currentIndex, desiredIndex)
            ) {
                return existing.map((record) => cloneJson(record!))
            }

            assertVersion(input.expectedManifestVersion, manifest.version)
            existing.forEach((record, index) => {
                if (record && !jobMatchesManifest(record, manifest, manifest.jobs[index])) {
                    throw new IllustrationLedgerCorruptError(
                        `Job ${manifest.jobs[index].jobId} conflicts with its plan manifest`,
                    )
                }
            })

            const now = Date.now()
            const slotOrdinals = slotOrdinalsForManifest(manifest)
            const result: IllustrationJobRecordV1[] = []
            for (let index = 0; index < manifest.jobs.length; index += 1) {
                const prior = existing[index]
                if (prior) {
                    result.push(prior)
                    continue
                }
                const job = manifest.jobs[index]
                const record: IllustrationJobRecordV1 = {
                    schemaVersion: 1,
                    turnId: manifest.turnId,
                    jobId: job.jobId,
                    slotToken: job.slotToken,
                    insertAfterUtf16: job.insertAfterUtf16,
                    sceneId: job.sceneId,
                    scenePayload: cloneJson(job.scenePayload),
                    sourceRevisionHash: manifest.sourceRevisionHash,
                    slotOrdinal: slotOrdinals.get(job.jobId)!,
                    createdAt: now,
                    state: 'prepared',
                    version: 1,
                    leaseId: null,
                    leaseExpiresAt: 0,
                    fence: 0,
                    workerEpoch,
                    updatedAt: now,
                    idempotencyKey: jobIdempotencyKey(manifest, job.jobId),
                    agentAttemptCount: 0,
                    creationIdempotencyKey: jobIdempotencyKey(manifest, job.jobId),
                }
                await writePersistentJson(illustrationJobKey(job.jobId), record)
                result.push(record)
            }

            if (!Array.isArray(currentIndex) || !jsonValuesEqual(currentIndex, desiredIndex)) {
                // This small derived index is the only ledger JSON value without
                // record version/updatedAt fields. The ledger lock guards it.
                await writePersistentJson(illustrationTurnJobsKey(manifest.turnId), desiredIndex)
            }
            return result.map(cloneJson)
        })
    }

    async getJob(jobId: string): Promise<IllustrationJobRecordV1 | null> {
        return await withIllustrationLedgerLock(async () => {
            assertNonEmptyString(jobId, 'jobId')
            const record = await this.readJobUnlocked(jobId)
            return record ? cloneJson(record) : null
        })
    }

    async listJobRecords(input: { turnId?: string } = {}): Promise<IllustrationJobRecordV1[]> {
        return await withIllustrationLedgerLock(async () => {
            if (input.turnId !== undefined) {
                assertNonEmptyString(input.turnId, 'turnId')
                return (await this.listTurnJobRecordsUnlocked(input.turnId)).map(cloneJson)
            }
            const keys = await listPersistentKeys(ILLUSTRATION_JOB_PREFIX)
            const records = await Promise.all(
                keys.map((key) => readPersistentJson<IllustrationJobRecordV1>(key)),
            )
            return records
                .filter((record): record is IllustrationJobRecordV1 => record !== null)
                .sort((left, right) => right.updatedAt - left.updatedAt)
                .map(cloneJson)
        })
    }

    async finalizeTurnAfterJobs(turnId: string): Promise<IllustrationTurnRecordV1 | null> {
        return await withIllustrationLedgerLock(async () => {
            assertNonEmptyString(turnId, 'turnId')
            return await this.finalizeTurnAfterJobsUnlocked(turnId)
        })
    }

    async listJobs(input: { turnId?: string } = {}): Promise<IllustrationJobSnapshotV1[]> {
        return await withIllustrationLedgerLock(async () => {
            let records: IllustrationJobRecordV1[]
            if (input.turnId !== undefined) {
                assertNonEmptyString(input.turnId, 'turnId')
                records = await this.listTurnJobRecordsUnlocked(input.turnId)
            } else {
                const keys = await listPersistentKeys(ILLUSTRATION_JOB_PREFIX)
                const read = await readManyPersistentJson<IllustrationJobRecordV1>(keys)
                records = read.filter((record): record is IllustrationJobRecordV1 => record !== null)
            }

            const full = records.filter((record) =>
                !isTerminalJobState(record.state) || record.state === 'uncertain')
            const summaries = records
                .filter((record) => isPrunableJobState(record.state))
                .sort((left, right) =>
                    right.updatedAt - left.updatedAt || left.jobId.localeCompare(right.jobId))
                .slice(0, TERMINAL_SUMMARY_LIMIT)
            return [
                ...full.map((record) => projectFullJobSnapshot(record)),
                ...summaries.map((record) => toTerminalJobSummary(record)),
            ].sort(compareJobSnapshotOrder)
        })
    }

    async listPendingTurns(): Promise<IllustrationTurnSnapshotV1[]> {
        return await withIllustrationLedgerLock(async () => {
            // Read the durable pending index (rebuilding once from a full scan if it
            // is missing or corrupt) and bulk-read exactly those records, so the cost
            // stays proportional to in-flight turns, not O(total turn history).
            const ids = await this.ensurePendingIndexUnlocked()
            const records = await readManyPersistentJson<IllustrationTurnRecordV1>(
                ids.map((turnId) => illustrationTurnKey(turnId)),
            )
            const listing: IllustrationTurnRecordV1[] = []
            const healthy: string[] = []
            let indexChanged = false
            for (let index = 0; index < ids.length; index += 1) {
                const record = records[index]
                // Self-heal: an indexed ID whose record is missing or has become
                // terminal is dropped from the index (never fabricated). In-flight
                // non-terminal turns stay indexed even when they are not listed as
                // pending (prepared/blocked_capture/awaiting_prompt).
                if (record === null || isTerminalTurnState(record.state)) {
                    indexChanged = true
                    continue
                }
                healthy.push(ids[index])
                if (PENDING_TURN_LISTING_STATES.includes(record.state)) listing.push(record)
            }
            if (indexChanged) await this.writePendingIndexUnlocked(healthy)
            return listing
                .sort((left, right) =>
                    left.updatedAt - right.updatedAt || left.turnId.localeCompare(right.turnId))
                .map((record) => projectTurnSnapshot(record))
        })
    }

    async transitionJob(input: TransitionJobInput): Promise<IllustrationJobRecordV1> {
        return await withIllustrationLedgerLock(async () => {
            const current = await this.requireJobUnlocked(input.jobId)
            const patch = input.patch ?? {}
            for (const key of Object.keys(patch)) {
                if (!transitionPatchKeys.has(key as keyof IllustrationJobTransitionPatch)) {
                    throw new IllustrationLedgerValidationError(`Unsupported job patch field: ${key}`)
                }
            }

            const now = Date.now()
            // Holder/coordinator fields identify Plugin Agent pipeline writes.
            // Executor-owned NAI/asset transitions intentionally omit them: the
            // coordinator governs Agent LLM work, not Core's NAI worker.
            // Image Revision V1: a retag revision child's Tagger supply stops at
            // prompt_ready instead of queued, but it is the same durable-prompt
            // Plugin Agent write and requires the same holder+coordinator proof.
            const promptSupply = current.state === 'awaiting_prompt'
                && (input.to === 'queued' || input.to === 'prompt_ready')
            const pluginAgentWrite = promptSupply
                || input.leaseId !== undefined
                || input.fence !== undefined
                || input.coordinatorLeaseId !== undefined
                || input.coordinatorFence !== undefined
            if (pluginAgentWrite) {
                if (
                    input.leaseId === undefined
                    || input.fence === undefined
                    || input.coordinatorLeaseId === undefined
                    || input.coordinatorFence === undefined
                ) {
                    throw new IllustrationLedgerHolderMismatchError(
                        'Plugin Agent writes require holder and coordinator proof',
                    )
                }
                await validateCoordinatorProofUnlocked(coordinatorProofFrom(input), { now })
            }
            if (current.version !== input.expectedVersion) {
                if (isLostAckTransition(current, input, patch, now)) return cloneJson(current)
                throw new IllustrationLedgerVersionConflictError(input.expectedVersion, current.version)
            }
            assertTransition('job', current.state, input.to)
            if (
                (current.state === 'agent_blocked_retryable' || current.state === 'agent_blocked')
                && input.to === 'awaiting_prompt'
            ) {
                throw new IllustrationLedgerValidationError(
                    'Agent-blocked jobs may only be reopened through retryAgentFailure',
                )
            }
            if (
                current.state === 'awaiting_prompt'
                && (input.to === 'agent_blocked_retryable' || input.to === 'agent_blocked')
            ) {
                throw new IllustrationLedgerValidationError(
                    'Agent failure states may only be entered through reportAgentFailure',
                )
            }
            if (pluginAgentWrite) {
                validateHolderWrite(current, {
                    leaseId: input.leaseId!,
                    expectedVersion: input.expectedVersion,
                    fence: input.fence!,
                }, now)
            }

            assertNonEmptyString(patch.idempotencyKey, 'patch.idempotencyKey')
            if (patch.idempotencyKey === current.idempotencyKey) {
                throw new IllustrationLedgerCorruptError('A job transition idempotencyKey may not be reused')
            }
            const next = cloneJson(current)
            next.state = input.to
            next.idempotencyKey = patch.idempotencyKey
            if (pluginAgentWrite) {
                next.lastHolderWrite = {
                    leaseId: input.leaseId!,
                    fence: input.fence!,
                    patchKeys: sortedPatchKeys(patch),
                }
            } else {
                delete next.lastHolderWrite
            }
            if (
                current.state === 'awaiting_prompt'
                && (input.to === 'queued' || input.to === 'prompt_ready')
            ) {
                // Gate 4a decision 2A: a durable prompt is the Tagger success
                // boundary that resets the cumulative Agent failure count.
                next.agentAttemptCount = 0
                delete next.agentHardRetryPending
            }
            delete next.lastRetryWrite

            if (hasOwn(patch, 'workerEpoch')) {
                validateWorkerEpoch(patch.workerEpoch as number)
                next.workerEpoch = patch.workerEpoch as number
            }
            if (hasOwn(patch, 'target')) {
                assertJsonSerializable(patch.target, 'patch.target')
                next.target = cloneJson(patch.target as IllustrationTargetV1)
            }
            if (hasOwn(patch, 'prompt')) {
                if (!patch.prompt || isLegacyIllustrationStoredPrompt(patch.prompt)) {
                    throw new IllustrationLedgerValidationError(
                        'New durable prompts must use IllustrationPromptV1',
                    )
                }
                next.prompt = parseIllustrationPromptV1(patch.prompt)
            }
            if (hasOwn(patch, 'settingsFingerprint')) {
                assertNonEmptyString(patch.settingsFingerprint, 'patch.settingsFingerprint')
                next.settingsFingerprint = patch.settingsFingerprint
            }
            if (hasOwn(patch, 'attemptId')) {
                assertNonEmptyString(patch.attemptId, 'patch.attemptId')
                next.attemptId = patch.attemptId
            }
            if (hasOwn(patch, 'assetId')) {
                assertNonEmptyString(patch.assetId, 'patch.assetId')
                next.assetId = patch.assetId
            }
            if (hasOwn(patch, 'error')) {
                if (patch.error === null) {
                    delete next.error
                } else {
                    if (!patch.error) throw new IllustrationLedgerValidationError('patch.error is invalid')
                    assertNonEmptyString(patch.error.code, 'patch.error.code')
                    assertJsonSerializable(patch.error, 'patch.error')
                    next.error = cloneJson(patch.error)
                }
            }
            if (hasOwn(patch, 'cancelRequestedAt')) {
                if (current.cancelRequestedAt === undefined) {
                    throw new IllustrationLedgerValidationError(
                        'cancelRequestedAt may only be created by requestCancel',
                    )
                }
                if (patch.cancelRequestedAt !== current.cancelRequestedAt) {
                    throw new IllustrationLedgerValidationError(
                        'cancelRequestedAt may not be cleared or changed before terminal state',
                    )
                }
            }
            if (current.cancelRequestedAt !== undefined) {
                next.cancelRequestedAt = current.cancelRequestedAt
            }

            if (
                current.state === 'awaiting_prompt'
                && (input.to === 'queued' || input.to === 'prompt_ready')
                && !next.prompt
            ) {
                throw new IllustrationLedgerValidationError('Final prompts must be durable before queuing')
            }
            if (current.state === 'queued' && input.to === 'generating') {
                assertNonEmptyString(next.attemptId, 'attemptId')
                assertNonEmptyString(next.assetId, 'assetId')
            }
            if (current.state === 'cancel_requested' && next.cancelRequestedAt === undefined) {
                throw new IllustrationLedgerCorruptError('cancel_requested job is missing cancelRequestedAt')
            }
            if (
                (input.to === 'cancel_requested' || input.to === 'cancelled') &&
                next.cancelRequestedAt === undefined
            ) {
                throw new IllustrationLedgerValidationError(
                    'Cancellation state transitions must go through requestCancel',
                )
            }
            if (current.state === 'asset_ready' && input.to === 'committing' && next.cancelRequestedAt !== undefined) {
                throw new IllustrationLedgerValidationError(
                    'A job with durable cancellation intent may not begin committing',
                )
            }

            next.version = current.version + 1
            next.updatedAt = now
            await writePersistentJson(illustrationJobKey(current.jobId), next)
            return cloneJson(next)
        })
    }

    async requestCancel(input: {
        jobId: string
        expectedVersion: number
    }): Promise<IllustrationJobRecordV1> {
        return await withIllustrationLedgerLock(async () => {
            const current = await this.requireJobUnlocked(input.jobId)
            if (current.version !== input.expectedVersion) {
                if (
                    current.version === input.expectedVersion + 1 &&
                    current.cancelRequestedAt !== undefined &&
                    current.idempotencyKey.startsWith(`cancel:${current.jobId}:`)
                ) {
                    return cloneJson(current)
                }
                throw new IllustrationLedgerVersionConflictError(input.expectedVersion, current.version)
            }

            if (
                current.cancelRequestedAt !== undefined &&
                (current.state === 'cancel_requested' ||
                    current.state === 'cancelled' ||
                    current.state === 'asset_writing')
            ) {
                return cloneJson(current)
            }

            let nextState: IllustrationJobState
            switch (current.state) {
                case 'prepared':
                case 'awaiting_prompt':
                case 'prompt_ready':
                case 'agent_blocked_retryable':
                case 'agent_blocked':
                case 'queued':
                case 'blocked_config':
                case 'asset_ready':
                    nextState = 'cancelled'
                    break
                case 'generating':
                    nextState = 'cancel_requested'
                    break
                case 'asset_writing':
                    nextState = 'asset_writing'
                    break
                default:
                    throw new IllustrationLedgerValidationError(
                        `Cancellation is not accepted from ${current.state}`,
                    )
            }
            if (nextState !== current.state) assertTransition('job', current.state, nextState)

            const now = Date.now()
            const next: IllustrationJobRecordV1 = {
                ...current,
                state: nextState,
                cancelRequestedAt: current.cancelRequestedAt ?? now,
                idempotencyKey: `cancel:${current.jobId}:${current.cancelRequestedAt ?? now}`,
                version: current.version + 1,
                updatedAt: now,
            }
            delete next.lastHolderWrite
            delete next.lastRetryWrite
            await writePersistentJson(illustrationJobKey(current.jobId), next)
            return cloneJson(next)
        })
    }

    async closeTurnFromPlan(input: CloseTurnFromPlanInput): Promise<IllustrationTurnRecordV1> {
        return await withIllustrationLedgerLock(async () => {
            assertNonEmptyString(input.code, 'code')
            assertNonEmptyString(input.idempotencyKey, 'idempotencyKey')
            const now = Date.now()
            await validateCoordinatorProofUnlocked(input, { now })
            const current = await this.requireTurnUnlocked(input.turnId)
            const receipt = current.lastPlanClosureWrite
            if (receipt?.idempotencyKey === input.idempotencyKey) {
                if (
                    receipt.previousVersion !== input.expectedVersion
                    || receipt.leaseId !== input.leaseId
                    || receipt.fence !== input.fence
                    || receipt.state !== input.to
                    || receipt.code !== input.code
                    || current.version !== receipt.resultVersion
                    || current.state !== receipt.state
                ) {
                    throw new IllustrationLedgerIdempotencyConflictError(
                        'Plan closure idempotencyKey is bound to a different write',
                    )
                }
                return cloneJson(current)
            }
            validateHolderWrite(current, input, now)
            if (current.state !== 'awaiting_plan') {
                throw new IllustrationLedgerValidationError(
                    'Only an awaiting_plan turn may be closed by submitPlan',
                )
            }
            assertTransition('turn', current.state, input.to)
            const next: IllustrationTurnRecordV1 = {
                ...current,
                state: input.to,
                leaseId: null,
                leaseExpiresAt: 0,
                error: { code: input.code },
                version: current.version + 1,
                updatedAt: now,
                lastPlanClosureWrite: {
                    idempotencyKey: input.idempotencyKey,
                    previousVersion: current.version,
                    resultVersion: current.version + 1,
                    leaseId: input.leaseId,
                    fence: input.fence,
                    state: input.to,
                    code: input.code,
                },
            }
            await writePersistentJson(illustrationTurnKey(current.turnId), next)
            await this.syncPendingIndexUnlocked(next.turnId, next.state)
            return cloneJson(next)
        })
    }

    async requestCancelTurn(input: {
        turnId: string
        expectedVersion: number
    }): Promise<IllustrationTurnRecordV1> {
        return await withIllustrationLedgerLock(async () => {
            const current = await this.requireTurnUnlocked(input.turnId)
            if (current.version !== input.expectedVersion) {
                if (
                    current.version === input.expectedVersion + 1
                    && current.state === 'cancelled'
                ) return cloneJson(current)
                throw new IllustrationLedgerVersionConflictError(input.expectedVersion, current.version)
            }
            if (![
                'prepared',
                'blocked_capture',
                'awaiting_plan',
                'agent_blocked_retryable',
                'agent_blocked',
            ].includes(current.state)) {
                throw new IllustrationLedgerValidationError(
                    `Turn cancellation is not accepted from ${current.state}`,
                )
            }
            assertTransition('turn', current.state, 'cancelled')
            const now = Date.now()
            const next: IllustrationTurnRecordV1 = {
                ...current,
                state: 'cancelled',
                leaseId: null,
                leaseExpiresAt: 0,
                version: current.version + 1,
                updatedAt: now,
            }
            await writePersistentJson(illustrationTurnKey(current.turnId), next)
            await this.syncPendingIndexUnlocked(next.turnId, next.state)
            return cloneJson(next)
        })
    }

    private claimLeaseRecord<T extends IllustrationTurnRecordV1 | IllustrationJobRecordV1>(
        current: T,
        input: ClaimLeaseInput,
        durationMs: number,
        now: number,
    ): T {
        assertVersion(input.expectedVersion, current.version)
        assertNonEmptyString(input.leaseId, 'leaseId')
        const unexpired = current.leaseId !== null && current.leaseExpiresAt > now
        if (unexpired && current.leaseId !== input.leaseId) {
            throw new IllustrationLedgerLeaseConflictError('Illustration record is leased by another holder')
        }
        const sameBearerRenewal = unexpired && current.leaseId === input.leaseId
        return {
            ...current,
            leaseId: input.leaseId,
            leaseExpiresAt: now + durationMs,
            fence: sameBearerRenewal ? current.fence : current.fence + 1,
            version: current.version + 1,
            updatedAt: now,
        }
    }

    async claimTurn(input: ClaimLeaseInput & { turnId: string }): Promise<IllustrationTurnRecordV1> {
        return await withIllustrationLedgerLock(async () => {
            const current = await this.requireTurnUnlocked(input.turnId)
            const now = Date.now()
            await validateCoordinatorProofUnlocked(input, { now })
            if (current.state !== 'awaiting_plan') {
                throw new IllustrationLedgerValidationError('Only awaiting_plan turns may be claimed')
            }
            const next = this.claimLeaseRecord(current, input, TURN_LEASE_DURATION_MS, now)
            await writePersistentJson(illustrationTurnKey(current.turnId), next)
            return cloneJson(next)
        })
    }

    async claimJob(input: ClaimLeaseInput & { jobId: string }): Promise<IllustrationJobRecordV1> {
        return await withIllustrationLedgerLock(async () => {
            const current = await this.requireJobUnlocked(input.jobId)
            const now = Date.now()
            await validateCoordinatorProofUnlocked(input, { now })
            if (current.state !== 'awaiting_prompt') {
                throw new IllustrationLedgerValidationError('Only awaiting_prompt jobs may be claimed')
            }
            const next = this.claimLeaseRecord(current, input, JOB_LEASE_DURATION_MS, now)
            await writePersistentJson(illustrationJobKey(current.jobId), next)
            return cloneJson(next)
        })
    }

    async claimTurnSnapshot(
        input: ClaimLeaseInput & { turnId: string },
    ): Promise<IllustrationTurnSnapshotV1> {
        return projectTurnSnapshot(await this.claimTurn(input), input.leaseId)
    }

    async claimJobSnapshot(
        input: ClaimLeaseInput & { jobId: string },
    ): Promise<IllustrationJobFullSnapshotV1> {
        return projectFullJobSnapshot(await this.claimJob(input), input.leaseId)
    }

    async reportAgentFailure(
        input: ReportAgentFailureInput,
    ): Promise<IllustrationTurnRecordV1 | IllustrationJobRecordV1> {
        return await withIllustrationLedgerLock(async () => {
            if (input.protocolVersion !== 1) {
                throw new IllustrationLedgerValidationError('protocolVersion must be 1')
            }
            if (input.kind !== 'turn' && input.kind !== 'job') {
                throw new IllustrationLedgerValidationError('kind must be turn or job')
            }
            assertNonEmptyString(input.id, 'id')
            assertNonEmptyString(input.idempotencyKey, 'idempotencyKey')
            assertNonEmptyString(input.code, 'code')
            if (typeof input.retryable !== 'boolean') {
                throw new IllustrationLedgerValidationError('retryable must be a boolean')
            }
            const now = Date.now()
            await validateCoordinatorProofUnlocked(input, {
                allowDraining: true,
                allowFeatureDisabled: true,
                now,
            })
            const current = input.kind === 'turn'
                ? await this.requireTurnUnlocked(input.id)
                : await this.requireJobUnlocked(input.id)
            const replay = replayedAgentFailure(current, input)
            if (replay) return replay
            validateHolderWrite(current, input, now)

            const expectedState = input.kind === 'turn' ? 'awaiting_plan' : 'awaiting_prompt'
            if (current.state !== expectedState) {
                throw new IllustrationLedgerValidationError(
                    `Only ${expectedState} records may report an Agent failure`,
                )
            }
            const priorAttemptCount = current.agentAttemptCount ?? 0
            const agentAttemptCount = input.retryable
                ? priorAttemptCount + 1
                : priorAttemptCount
            const outcomeState = input.retryable
                && agentAttemptCount < MAX_AGENT_ATTEMPTS
                && current.agentHardRetryPending !== true
                ? 'agent_blocked_retryable'
                : 'agent_blocked'
            if (input.kind === 'turn') {
                assertTransition(
                    'turn',
                    current.state as IllustrationTurnState,
                    outcomeState,
                )
            } else {
                assertTransition('job', current.state as IllustrationJobState, outcomeState)
            }
            const receipt = {
                idempotencyKey: input.idempotencyKey,
                previousVersion: current.version,
                resultVersion: current.version + 1,
                leaseId: input.leaseId,
                fence: input.fence,
                code: input.code,
                retryable: input.retryable,
                outcomeState,
                agentAttemptCount,
            }
            const priorHistory = current.agentFailureWrites
                ?? (current.lastAgentFailureWrite ? [current.lastAgentFailureWrite] : [])
            const next = {
                ...current,
                state: outcomeState,
                leaseId: null,
                leaseExpiresAt: 0,
                agentAttemptCount,
                error: { code: input.code, retryable: input.retryable },
                version: current.version + 1,
                updatedAt: now,
                lastAgentFailureWrite: receipt,
                agentFailureWrites: [...priorHistory, receipt],
            } as IllustrationTurnRecordV1 | IllustrationJobRecordV1
            delete next.agentHardRetryPending
            if (input.kind === 'job') {
                delete (next as IllustrationJobRecordV1).lastHolderWrite
                delete (next as IllustrationJobRecordV1).lastRetryWrite
                await writePersistentJson(illustrationJobKey(input.id), next)
            } else {
                await writePersistentJson(illustrationTurnKey(input.id), next)
            }
            return cloneJson(next)
        })
    }

    async retryAgentFailure(
        input: RetryAgentFailureInput,
    ): Promise<IllustrationTurnRecordV1 | IllustrationJobRecordV1> {
        return await withIllustrationLedgerLock(async () => {
            if (input.protocolVersion !== 1) {
                throw new IllustrationLedgerValidationError('protocolVersion must be 1')
            }
            if (input.confirmNewLlmCharge !== true) {
                throw new IllustrationLedgerConfirmationRequiredError(
                    'Retrying blocked Agent work requires confirmNewLlmCharge: true',
                )
            }
            if (input.kind !== 'turn' && input.kind !== 'job') {
                throw new IllustrationLedgerValidationError('kind must be turn or job')
            }
            assertNonEmptyString(input.id, 'id')
            const now = Date.now()
            await validateCoordinatorProofUnlocked(input, { now })
            const current = input.kind === 'turn'
                ? await this.requireTurnUnlocked(input.id)
                : await this.requireJobUnlocked(input.id)
            assertVersion(input.expectedVersion, current.version)
            if (current.state !== 'agent_blocked_retryable' && current.state !== 'agent_blocked') {
                throw new IllustrationLedgerValidationError(
                    'Only agent_blocked_retryable or agent_blocked records may be retried',
                )
            }
            const nextState = input.kind === 'turn' ? 'awaiting_plan' : 'awaiting_prompt'
            if (input.kind === 'turn') {
                assertTransition('turn', current.state as IllustrationTurnState, 'awaiting_plan')
            } else {
                assertTransition('job', current.state as IllustrationJobState, 'awaiting_prompt')
            }
            const next = {
                ...current,
                state: nextState,
                leaseId: null,
                leaseExpiresAt: 0,
                // Gate 4a decision 2A deliberately preserves the cumulative count.
                // A successful manifest/prompt acceptance is the reset boundary.
                agentAttemptCount: current.agentAttemptCount ?? 0,
                version: current.version + 1,
                updatedAt: now,
            } as IllustrationTurnRecordV1 | IllustrationJobRecordV1
            if (current.state === 'agent_blocked') next.agentHardRetryPending = true
            else delete next.agentHardRetryPending
            delete next.error
            if (input.kind === 'job') {
                delete (next as IllustrationJobRecordV1).lastHolderWrite
                delete (next as IllustrationJobRecordV1).lastRetryWrite
                await writePersistentJson(illustrationJobKey(input.id), next)
            } else {
                await writePersistentJson(illustrationTurnKey(input.id), next)
            }
            return cloneJson(next)
        })
    }

    // Prompt Target V2: read the durable transport election RAW (no interpretation).
    // Absent/legacy => an empty election. Re-validation lives in the coordinator layer
    // so the store keeps a type-only dependency on the (measurement-importing)
    // promptContextV2 module and never drags that chain into store-only test harnesses.
    // Readable without any lease so a reloading Plugin/executor can resolve the target
    // before opening a scheduler.
    async getTransportConfig(): Promise<IllustrationTransportConfigV1> {
        const record = await readPersistentJson<IllustrationTransportConfigRecordV1>(
            ILLUSTRATION_TRANSPORT_CONFIG_KEY,
        )
        return { schemaVersion: 1, election: record?.election ?? null }
    }

    // Overwrite the durable transport election under the ledger lock. The config is
    // strictly validated by the caller (coordinator.setTransportConfig via
    // parseTransportConfig); this only persists it with a monotonic version. There is
    // no per-turn binding here — the durable PromptContext snapshot
    // (prepareTurnPromptContext) is what freezes a turn's target.
    async setTransportConfig(
        config: IllustrationTransportConfigV1,
    ): Promise<IllustrationTransportConfigV1> {
        return await withIllustrationLedgerLock(async () => {
            const current = await readPersistentJson<IllustrationTransportConfigRecordV1>(
                ILLUSTRATION_TRANSPORT_CONFIG_KEY,
            )
            const next: IllustrationTransportConfigRecordV1 = {
                schemaVersion: 1,
                election: config.election,
                version: (current?.version ?? 0) + 1,
                updatedAt: Date.now(),
            }
            assertJsonSerializable(next, 'transport config record')
            await writePersistentJson(ILLUSTRATION_TRANSPORT_CONFIG_KEY, next)
            return { schemaVersion: 1, election: config.election }
        })
    }

    async acquireWorkerEpoch(): Promise<number> {
        return await withIllustrationLedgerLock(async () => {
            const current = await readPersistentJson<IllustrationWorkerEpochRecordV1>(
                ILLUSTRATION_WORKER_EPOCH_KEY,
            )
            const value = (current?.value ?? 0) + 1
            if (!Number.isSafeInteger(value)) {
                throw new IllustrationLedgerCorruptError('Illustration worker epoch overflowed')
            }
            const next: IllustrationWorkerEpochRecordV1 = {
                value,
                version: (current?.version ?? 0) + 1,
                updatedAt: Date.now(),
            }
            await writePersistentJson(ILLUSTRATION_WORKER_EPOCH_KEY, next)
            return value
        })
    }

    async retryUncertainJob(input: RetryUncertainJobInput): Promise<IllustrationJobRecordV1> {
        return await withIllustrationLedgerLock(async () => {
            if (input.confirmNewCharge !== true) {
                throw new IllustrationLedgerConfirmationRequiredError()
            }
            const current = await this.requireJobUnlocked(input.jobId)
            if (current.version !== input.expectedVersion) {
                if (
                    current.version === input.expectedVersion + 1 &&
                    current.state === 'queued' &&
                    current.lastRetryWrite?.previousVersion === input.expectedVersion &&
                    current.lastRetryWrite.attemptId === current.attemptId &&
                    current.lastRetryWrite.assetId === current.assetId
                ) {
                    return cloneJson(current)
                }
                throw new IllustrationLedgerVersionConflictError(input.expectedVersion, current.version)
            }
            if (current.state !== 'uncertain') {
                throw new IllustrationLedgerValidationError('Only uncertain jobs may be retried')
            }

            let attemptId: string
            let assetId: string
            do attemptId = makeOpaqueId('attempt')
            while (attemptId === current.attemptId)
            do assetId = makeOpaqueId('asset')
            while (assetId === current.assetId)

            const next: IllustrationJobRecordV1 = {
                ...current,
                state: 'queued',
                attemptId,
                assetId,
                idempotencyKey: `retry:${attemptId}`,
                leaseId: null,
                leaseExpiresAt: 0,
                version: current.version + 1,
                updatedAt: Date.now(),
                lastRetryWrite: {
                    previousVersion: current.version,
                    attemptId,
                    assetId,
                },
            }
            delete next.error
            delete next.lastHolderWrite
            // uncertain is a terminal boundary; the explicit paid retry starts a
            // fresh attempt and does not inherit a prior attempt's cancel intent.
            delete next.cancelRequestedAt
            await writePersistentJson(illustrationJobKey(current.jobId), next)
            return cloneJson(next)
        })
    }

    // Image Revision V1: the forced second charge-confirmation step for a retag
    // revision child. Transitions prompt_ready -> queued only with an explicit
    // confirmNewImageCharge, so the Tagger (LLM) and the image are two distinct
    // confirmations. Idempotent for double click / ACK loss / reload.
    async enqueueRevisionImageJob(
        input: EnqueueRevisionImageInput,
    ): Promise<IllustrationJobRecordV1> {
        return await withIllustrationLedgerLock(async () => {
            if (input.confirmNewImageCharge !== true) {
                throw new IllustrationLedgerConfirmationRequiredError(
                    'Enqueuing a retag revision image requires confirmNewImageCharge: true',
                )
            }
            const current = await this.requireJobUnlocked(input.jobId)
            const enqueueKey = `enqueue:${input.jobId}:${input.expectedVersion}`
            if (current.version !== input.expectedVersion) {
                if (
                    current.version === input.expectedVersion + 1
                    && current.state === 'queued'
                    && current.idempotencyKey === enqueueKey
                ) return cloneJson(current)
                throw new IllustrationLedgerVersionConflictError(input.expectedVersion, current.version)
            }
            if (!current.revision || current.revision.mode !== 'retag') {
                throw new IllustrationLedgerValidationError(
                    'Only retag revision children may be enqueued for an image',
                )
            }
            if (current.state !== 'prompt_ready') {
                throw new IllustrationLedgerValidationError(
                    'Only a prompt_ready revision child may be enqueued for an image',
                )
            }
            if (!current.prompt) {
                throw new IllustrationLedgerValidationError(
                    'A prompt_ready revision child must carry a durable prompt',
                )
            }
            assertTransition('job', current.state, 'queued')
            const now = Date.now()
            const next: IllustrationJobRecordV1 = {
                ...current,
                state: 'queued',
                idempotencyKey: enqueueKey,
                version: current.version + 1,
                updatedAt: now,
            }
            delete next.lastHolderWrite
            delete next.lastRetryWrite
            await writePersistentJson(illustrationJobKey(current.jobId), next)
            return cloneJson(next)
        })
    }

    async pruneTerminalRecords(
        input: PruneTerminalRecordsInput = {},
    ): Promise<PruneTerminalRecordsResult> {
        return await withIllustrationLedgerLock(async () => {
            const olderThanMs = input.olderThanMs ?? TERMINAL_RECORD_TTL_MS
            const maxDeletes = input.maxDeletes ?? DEFAULT_PRUNE_MAX_DELETES
            assertNonNegativeInteger(olderThanMs, 'olderThanMs')
            assertNonNegativeInteger(maxDeletes, 'maxDeletes')
            if (maxDeletes === 0) return { deletedJobIds: [], deletedTurnIds: [] }

            const [jobKeys, turnKeys, manifestKeys, turnJobsKeys] = await Promise.all([
                listPersistentKeys(ILLUSTRATION_JOB_PREFIX),
                listPersistentKeys(ILLUSTRATION_TURN_PREFIX),
                listPersistentKeys(ILLUSTRATION_MANIFEST_PREFIX),
                listPersistentKeys(ILLUSTRATION_TURN_JOBS_PREFIX),
            ])
            const manifestKeySet = new Set(manifestKeys)
            const turnJobsKeySet = new Set(turnJobsKeys)
            const jobs = (
                await Promise.all(
                    jobKeys.map(async (key) => ({
                        key,
                        record: await readPersistentJson<IllustrationJobRecordV1>(key),
                    })),
                )
            ).filter(
                (entry): entry is { key: string; record: IllustrationJobRecordV1 } =>
                    entry.record !== null,
            )
            const turns = (
                await Promise.all(
                    turnKeys.map(async (key) => ({
                        key,
                        record: await readPersistentJson<IllustrationTurnRecordV1>(key),
                    })),
                )
            ).filter(
                (entry): entry is { key: string; record: IllustrationTurnRecordV1 } =>
                    entry.record !== null,
            )

            const jobsByTurn = new Map<string, IllustrationJobRecordV1[]>()
            for (const { record } of jobs) {
                const bucket = jobsByTurn.get(record.turnId) ?? []
                bucket.push(record)
                jobsByTurn.set(record.turnId, bucket)
            }

            const terminalTurnsNewestFirst = turns
                .filter(({ record }) => isPrunableTurnState(record.state))
                .sort((left, right) => right.record.updatedAt - left.record.updatedAt)
            const protectedTurnIds = new Set(
                terminalTurnsNewestFirst
                    .slice(0, TURN_SUMMARY_RETENTION)
                    .map(({ record }) => record.turnId),
            )
            const cutoff = Date.now() - olderThanMs
            const candidates: Array<{
                kind: 'job' | 'turn'
                key: string
                id: string
                turnId: string
                updatedAt: number
            }> = []

            for (const { key, record } of jobs) {
                // uncertain is terminal for automatic transitions but remains a
                // protected manual-recovery/cost-evidence state.
                if (isTerminalJobState(record.state) && isPrunableJobState(record.state) && record.updatedAt < cutoff) {
                    candidates.push({
                        kind: 'job',
                        key,
                        id: record.jobId,
                        turnId: record.turnId,
                        updatedAt: record.updatedAt,
                    })
                }
            }
            for (const { key, record } of turns) {
                if (
                    isPrunableTurnState(record.state) &&
                    record.updatedAt < cutoff &&
                    !protectedTurnIds.has(record.turnId) &&
                    (jobsByTurn.get(record.turnId)?.length ?? 0) === 0
                ) {
                    candidates.push({
                        kind: 'turn',
                        key,
                        id: record.turnId,
                        turnId: record.turnId,
                        updatedAt: record.updatedAt,
                    })
                }
            }
            candidates.sort(
                (left, right) =>
                    left.updatedAt - right.updatedAt ||
                    (left.kind === right.kind ? left.id.localeCompare(right.id) : left.kind === 'job' ? -1 : 1),
            )

            const deletedJobIds: string[] = []
            const deletedTurnIds: string[] = []
            const deletedJobsByTurn = new Map<string, Set<string>>()
            const removedKeys = new Set<string>()
            let deletedKeyCount = 0
            for (const candidate of candidates) {
                if (candidate.kind === 'job') {
                    if (deletedKeyCount >= maxDeletes) break
                    await removePersistentKey(candidate.key)
                    removedKeys.add(candidate.key)
                    deletedKeyCount += 1
                    deletedJobIds.push(candidate.id)
                    const deleted = deletedJobsByTurn.get(candidate.turnId) ?? new Set<string>()
                    deleted.add(candidate.id)
                    deletedJobsByTurn.set(candidate.turnId, deleted)
                } else {
                    const currentTurn = await this.readTurnUnlocked(candidate.turnId)
                    if (
                        !currentTurn ||
                        !isPrunableTurnState(currentTurn.state) ||
                        currentTurn.updatedAt >= cutoff ||
                        protectedTurnIds.has(currentTurn.turnId)
                    ) {
                        continue
                    }
                    const manifestKey = illustrationManifestKey(candidate.turnId)
                    const turnJobsKey = illustrationTurnJobsKey(candidate.turnId)
                    const dependentKeys: string[] = []
                    if (manifestKeySet.has(manifestKey) && !removedKeys.has(manifestKey)) {
                        dependentKeys.push(manifestKey)
                    }
                    if (turnJobsKeySet.has(turnJobsKey) && !removedKeys.has(turnJobsKey)) {
                        dependentKeys.push(turnJobsKey)
                    }
                    const groupKeys = [...dependentKeys, candidate.key]
                    if (deletedKeyCount + groupKeys.length > maxDeletes) continue

                    // Dependencies go first so a partial storage failure cannot
                    // leave a deleted turn with newly orphaned ledger keys.
                    for (const key of groupKeys) {
                        await removePersistentKey(key)
                        removedKeys.add(key)
                        deletedKeyCount += 1
                    }
                    deletedTurnIds.push(candidate.id)
                }
            }

            for (const [turnId, deletedJobIdsForTurn] of deletedJobsByTurn) {
                const indexKey = illustrationTurnJobsKey(turnId)
                const currentIndex = (await readPersistentJson<string[]>(indexKey)) ?? []
                const nextIndex = currentIndex.filter((jobId) => !deletedJobIdsForTurn.has(jobId))
                if (!jsonValuesEqual(currentIndex, nextIndex)) {
                    await writePersistentJson(indexKey, nextIndex)
                }
            }

            const orphanCandidates = [
                ...manifestKeys.map((key) => ({
                    key,
                    turnId: key.slice(ILLUSTRATION_MANIFEST_PREFIX.length),
                })),
                ...turnJobsKeys.map((key) => ({
                    key,
                    turnId: key.slice(ILLUSTRATION_TURN_JOBS_PREFIX.length),
                })),
            ].sort((left, right) => left.key.localeCompare(right.key))
            for (const candidate of orphanCandidates) {
                if (deletedKeyCount >= maxDeletes) break
                if (removedKeys.has(candidate.key)) continue
                if ((await this.readTurnUnlocked(candidate.turnId)) !== null) continue
                await removePersistentKey(candidate.key)
                removedKeys.add(candidate.key)
                deletedKeyCount += 1
            }
            return { deletedJobIds, deletedTurnIds }
        })
    }
}

export const illustrationJobStore = new IllustrationJobStore()
