import type { IllustrationPromptContextV2 } from './promptContextV2'
import type { IllustrationPromptEnvelopeV2 } from './promptEnvelopeV2'
import type { IllustrationPromptMeasurementReceiptV2 } from './promptMeasurementReceiptV2'

export type ScenePayloadV1 = {
    schemaVersion: number
    data: unknown
}

// Durable capture policy. The default (absent/invalid record) is 'manual'.
export type IllustrationCaptureMode = 'manual' | 'automatic'

// How a durable capture turn was admitted: 'manual' turns come from an explicit
// user "generate for this response" request; 'automatic' turns from the eager
// terminal-capture seam. Legacy records without this field decode as 'automatic'
// so pre-contract turns keep their historical meaning.
export type IllustrationCaptureOrigin = 'manual' | 'automatic'

export type PlanManifestV1 = {
    turnId: string
    planHash: string
    expectedCount: number
    sourceRevisionHash: string
    jobs: Array<{
        jobId: string
        slotToken: string
        insertAfterUtf16: number
        sceneId: string
        scenePayload: {
            schemaVersion: number
            data: unknown
        }
    }>
    phase: 'prepared' | 'records_complete' | 'projection_durable'
    version: number
}

export type IllustrationTargetV1 = {
    chaId: string
    conversationId: string
    expectedMessageId: string
    rootTurnId: string
    requestNonce: string
    slotToken: string
    capturedSwipeHint: number
    sourceRevisionHash: string
}

export type IllustrationPromptV1 = {
    schemaVersion: 1
    layout: 'flat' | 'nai-v4-characters'
    basePositive: string
    characterPositives: string[]
    baseNegative: string
    characterNegatives: string[]
}

export type LegacyIllustrationJobPromptV1 = {
    positive: string
    negative: string
}

export type IllustrationStoredPromptV1 =
    | IllustrationPromptV1
    | LegacyIllustrationJobPromptV1

export type IllustrationImagePromptMeasurementV1 = {
    model: string
    tokenizer: 't5-spiece-v1'
    positiveTokens: number
    negativeTokens: number
    maxPositiveTokens: number
    maxNegativeTokens: number
}

export type IllustrationImagePromptOverLimitPayloadV1 = Pick<
    IllustrationImagePromptMeasurementV1,
    | 'positiveTokens'
    | 'negativeTokens'
    | 'maxPositiveTokens'
    | 'maxNegativeTokens'
    | 'model'
>

export type IllustrationJobState =
    | 'prepared'
    | 'awaiting_prompt'
    | 'agent_blocked_retryable'
    | 'agent_blocked'
    // Image Revision V1: a retag revision child stops here after the Tagger
    // supplies a durable prompt. It is NON-terminal and reached ONLY from
    // awaiting_prompt on a retag child; the sole exit is enqueueRevisionImage
    // (prompt_ready -> queued), the forced second charge-confirmation step.
    | 'prompt_ready'
    | 'queued'
    | 'generating'
    | 'cancel_requested'
    | 'blocked_config'
    | 'asset_writing'
    | 'asset_ready'
    | 'committing'
    | 'committed'
    | 'failed'
    | 'stale'
    | 'uncertain'
    | 'cancelled'
    | 'corrupt'

// The canonical spec has no turn diagram. This is the smallest explicit turn
// machine needed by Gate 3b; orchestration of these states belongs to Gate 3c.
export type IllustrationTurnState =
    | 'prepared'
    | 'blocked_capture'
    | 'awaiting_plan'
    | 'agent_blocked_retryable'
    | 'agent_blocked'
    | 'awaiting_prompt'
    | 'blocked_manifest'
    | 'no_scenes'
    | 'completed'
    | 'cancelled'
    | 'stale'
    | 'corrupt'

export type IllustrationTurnTargetV1 = Omit<
    IllustrationTargetV1,
    'slotToken' | 'capturedSwipeHint' | 'sourceRevisionHash'
>

export type IllustrationRecordErrorV1 = {
    code: string
    certainty?: 'definite' | 'uncertain'
    message?: string
    retryable?: boolean
    payload?: IllustrationImagePromptOverLimitPayloadV1
}

export type IllustrationAgentFailureReceiptV1 = {
    idempotencyKey: string
    previousVersion: number
    resultVersion: number
    leaseId: string
    fence: number
    code: string
    retryable: boolean
    outcomeState: 'agent_blocked_retryable' | 'agent_blocked'
    agentAttemptCount: number
}

export type IllustrationPlanClosureReceiptV1 = {
    idempotencyKey: string
    previousVersion: number
    resultVersion: number
    leaseId: string
    fence: number
    state: 'stale' | 'corrupt'
    code: string
}

export type IllustrationLeaseRecordFields = {
    version: number
    leaseId: string | null
    leaseExpiresAt: number
    fence: number
    workerEpoch: number
    updatedAt: number
    idempotencyKey: string
    agentAttemptCount: number
    agentHardRetryPending?: boolean
    lastAgentFailureWrite?: IllustrationAgentFailureReceiptV1
    agentFailureWrites?: IllustrationAgentFailureReceiptV1[]
}

export type IllustrationTurnRecordV1 = IllustrationLeaseRecordFields & {
    schemaVersion: 1
    turnId: string
    state: IllustrationTurnState
    // Absent on legacy records; decoded as 'automatic' at every read boundary.
    origin?: IllustrationCaptureOrigin
    target?: IllustrationTurnTargetV1
    sourceTextUtf16?: string
    sourceRevisionHash?: string
    settingsFingerprint?: string
    // Prompt Target V2 (request §4): the durable PromptContext captured by
    // preparePromptContext. Once set it is immutable — a re-prepare is rejected.
    // Absent on legacy/V1-only turns.
    promptContext?: IllustrationPromptContextV2
    error?: IllustrationRecordErrorV1
    lastPlanClosureWrite?: IllustrationPlanClosureReceiptV1
}

export type IllustrationJobRecordV1 = IllustrationLeaseRecordFields & {
    schemaVersion: 1
    turnId: string
    jobId: string
    slotToken: string
    insertAfterUtf16: number
    sceneId: string
    scenePayload: ScenePayloadV1
    sourceRevisionHash: string
    slotOrdinal: number
    createdAt: number
    state: IllustrationJobState
    creationIdempotencyKey: string
    lastHolderWrite?: {
        leaseId: string
        fence: number
        patchKeys: string[]
    }
    lastRetryWrite?: {
        previousVersion: number
        attemptId: string
        assetId: string
    }
    target?: IllustrationTargetV1
    prompt?: IllustrationStoredPromptV1
    // Prompt Target V2 (request §D1): a V2-supplied job carries the Plugin's compiled
    // envelope and the side-effect-free measurement receipt instead of a V1 `prompt`.
    // Both are additive — legacy/V1 records never set them, and a V2 job never sets
    // `prompt`. Durable so a reload preserves envelope/receipt identity (§10-21).
    promptEnvelope?: IllustrationPromptEnvelopeV2
    promptReceipt?: IllustrationPromptMeasurementReceiptV2
    settingsFingerprint?: string
    attemptId?: string
    assetId?: string
    error?: IllustrationRecordErrorV1
    cancelRequestedAt?: number
    // Image Revision V1: present only on revision child jobs. Immutable once set;
    // it never appears on manifest-projected (genesis) jobs. Its presence routes
    // the job through the revision execution/commit path (inlay swap/insert +
    // reference/lineage CAS) instead of the slot-splice commit.
    revision?: IllustrationJobRevisionDescriptorV1
}

// ---------------------------------------------------------------------------
// Image Revision V1 (contract §4/§6): durable reference/lineage ledger types.
// ---------------------------------------------------------------------------

export type IllustrationRevisionMode = 'exact-prompt' | 'edited-prompt' | 'retag'
export type IllustrationRevisionDisposition = 'replace' | 'retain'

// The provider-dispatch/charge state surfaced to the Plugin for cancellation
// wording (§4.3) and history (§6). 'not-started' = no provider dispatch yet;
// 'charged' = dispatch happened and a charge is assumed; 'not-charged' = closed
// out before/without a charge; 'uncertain' = dispatch happened but the charge is
// unknown (mirrors the ledger 'uncertain' terminal).
export type IllustrationRevisionChargeCertainty =
    | 'not-started'
    | 'charged'
    | 'not-charged'
    | 'uncertain'

// Internal lineage-entry mode. Superset of the RPC-visible IllustrationRevisionMode:
// adds 'genesis' (the original committed asset) and 'restore' (a no-charge re-point).
export type IllustrationLineageEntryMode =
    | 'genesis'
    | 'exact-prompt'
    | 'edited-prompt'
    | 'retag'
    | 'restore'

export type IllustrationRevisionIdentity = {
    referenceId: string
    operationVersion: number
    lineageId: string
    lineageVersion: number
    sourceJobId: string
    currentAssetId: string
}

// Immutable descriptor attached to a revision child job at admission time.
export type IllustrationJobRevisionDescriptorV1 = {
    referenceId: string
    lineageId: string
    parentRevisionId: string
    // The lineage entry id this child will create on commit.
    revisionId: string
    mode: IllustrationRevisionMode
    disposition: IllustrationRevisionDisposition
    // The reference operationVersion consumed when this child was admitted.
    admittedOperationVersion: number
    // Commit-time CAS inputs captured at admission (the "expected" tuple).
    expectedLineageVersion: number
    expectedCurrentAssetId: string
    // Retain fork identities, minted at admission, materialized at commit.
    forkReferenceId?: string
    forkLineageId?: string
    // Prompt hash bound at admission (exact/edited); recomputed for retag at supply.
    promptHash: string
}

export type IllustrationLineageRevisionEntryV1 = {
    revisionId: string
    parentRevisionId: string | null
    jobId: string | null
    assetId: string
    // Full structured prompt is retained so a no-charge restore can re-point the
    // reference to any past revision's exact prompt (getImageRevisionTarget). It is
    // ABSENT for an envelope-identity (V2) entry — a V2 job never stores a V1 prompt,
    // so the entry's prompt-identity is the receipt's envelopeHash carried in
    // `promptHash` instead (Sol #8). Absence of `prompt` is the envelope-identity
    // discriminant.
    prompt?: IllustrationPromptV1
    promptHash: string
    mode: IllustrationLineageEntryMode
    disposition: IllustrationRevisionDisposition | null
    chargeCertainty: IllustrationRevisionChargeCertainty
    createdAt: number
}

export type IllustrationImageReferenceRecordV1 = {
    schemaVersion: 1
    referenceId: string
    operationVersion: number
    lineageId: string
    lineageVersion: number
    sourceJobId: string
    currentAssetId: string
    currentRevisionId: string
    // Absent for an envelope-identity (V2) reference — mirrors the lineage entry's
    // `prompt`; the identity is `currentPromptHash` (the receipt envelopeHash) (Sol #8).
    currentPrompt?: IllustrationPromptV1
    currentPromptHash: string
    settingsFingerprint: string
    sceneId: string
    scenePayload: ScenePayloadV1
    target: IllustrationTargetV1
    // Retain provenance: present only on forked references.
    sourceLineageId?: string
    sourceRevisionId?: string
    createdAt: number
    updatedAt: number
}

// Slim stub of a revision evicted from the bounded live window. Retains only the
// identity needed to keep the revision's asset restorable (§4.2 reachability); the
// full structured prompt is intentionally dropped to keep the archive bounded.
export type IllustrationLineageRevisionStubV1 = {
    revisionId: string
    assetId: string
    promptHash: string
    createdAt: number
}

export type IllustrationImageLineageRecordV1 = {
    schemaVersion: 1
    lineageId: string
    referenceId: string
    revisions: IllustrationLineageRevisionEntryV1[]
    // Slim stubs of revisions compacted out of the live window; a restore falls back
    // to these so an evicted revision's asset stays reachable.
    archivedRevisions?: IllustrationLineageRevisionStubV1[]
    createdAt: number
    updatedAt: number
}

// Durable admission receipt keyed by the Plugin's idempotencyKey. A repeated key
// with the same binding returns the same admitted child/result; a divergent
// binding is an idempotency_conflict.
export type IllustrationRevisionIntentReceiptV1 = {
    schemaVersion: 1
    idempotencyKey: string
    referenceId: string
    kind: 'revision' | 'restore'
    bindingHash: string
    admittedOperationVersion: number
    childJobId?: string
    // The admitted child job record, sealed alongside the receipt so a same-key retry
    // can re-materialize the child idempotently if the child-job write tore after the
    // receipt became durable (receipt-before-child order, §4).
    childJobRecord?: IllustrationJobRecordV1
    restoredIdentity?: IllustrationRevisionIdentity
    createdAt: number
}

export type IllustrationRevisionSummaryV1 = {
    revisionId: string
    parentRevisionId: string | null
    jobId: string | null
    assetId: string
    promptHash: string
    mode: IllustrationLineageEntryMode
    disposition: IllustrationRevisionDisposition | null
    chargeCertainty: IllustrationRevisionChargeCertainty
    isCurrent: boolean
    createdAt: number
}

export type IllustrationImageReferenceSummaryV1 = {
    protocolVersion: 1
    referenceId: string
    operationVersion: number
    lineageId: string
    lineageVersion: number
    sourceJobId: string
    currentAssetId: string
    target: Pick<
        IllustrationTargetV1,
        'chaId' | 'conversationId' | 'expectedMessageId' | 'rootTurnId'
    >
    createdAt: number
    updatedAt: number
}

export type IllustrationRevisionJobProjectionV1 = {
    referenceId: string
    lineageId: string
    revisionId: string
    parentRevisionId: string
    mode: IllustrationRevisionMode
    disposition: IllustrationRevisionDisposition
    operationVersion: number
    providerDispatched: boolean
    chargeCertainty: IllustrationRevisionChargeCertainty
}

export type StoredPlanManifestV1 = PlanManifestV1 & {
    updatedAt: number
    idempotencyKey: string
    holderWrite?: {
        turnExpectedVersion: number
        leaseId: string
        fence: number
    }
}

export type IllustrationWorkerEpochRecordV1 = {
    value: number
    version: number
    updatedAt: number
}

export type IllustrationJobTransitionPatch = {
    idempotencyKey?: string
    workerEpoch?: number
    target?: IllustrationTargetV1
    prompt?: IllustrationStoredPromptV1
    // Prompt Target V2 (request §D1): durable envelope + receipt written atomically
    // with the awaiting_prompt -> queued transition by supplyPromptEnvelope.
    promptEnvelope?: IllustrationPromptEnvelopeV2
    promptReceipt?: IllustrationPromptMeasurementReceiptV2
    settingsFingerprint?: string
    attemptId?: string
    assetId?: string
    error?: IllustrationRecordErrorV1 | null
    cancelRequestedAt?: number | null
}

export type IllustrationHolderWrite = {
    leaseId: string
    expectedVersion: number
    fence: number
}

export type IllustrationCoordinatorProof = {
    coordinatorLeaseId: string
    coordinatorFence: number
}

export type IllustrationCoordinatorRecordV1 = {
    version: number
    fence: number
    leaseId: string | null
    holderRuntimeId: string | null
    expiresAt: number
    draining: boolean
    updatedAt: number
}

export type IllustrationCoordinatorSnapshotV1 = {
    protocolVersion: 1
    version: number
    fence: number
    expiresAt: number
    ownedByCaller: boolean
    draining: boolean
}

// Coordinator Recovery Status V2 (§5): an EXPECTED non-owner standby outcome
// carried as transport-safe DATA instead of a thrown coded error. Only surfaces
// on the opt-in claimCoordinator waitStatus path; the default claim path keeps
// throwing so byte-identical legacy behavior is preserved.
export type IllustrationCoordinatorWaitStateV1 = 'leased' | 'draining' | 'orphan-cooldown'

export type IllustrationCoordinatorWaitV1 = {
    protocolVersion: 1
    ownedByCaller: false
    state: IllustrationCoordinatorWaitStateV1
    // Live foreign/draining lease -> exact expiresAt; orphan cooldown -> null (no
    // live lease to count down from).
    expiresAt: number | null
    // Orphan cooldown -> exact bounded retryAt; otherwise null.
    retryAt: number | null
    canForceTakeover: boolean
}

export type IllustrationLeaseViewV1 = {
    expiresAt: number
    fence: number
    ownedByCaller: boolean
}

export type IllustrationTurnSnapshotV1 = {
    protocolVersion: 1
    turnId: string
    version: number
    state: IllustrationTurnState
    // Always projected; legacy records without a durable origin surface 'automatic'.
    origin: IllustrationCaptureOrigin
    lease?: IllustrationLeaseViewV1
    target?: IllustrationTurnTargetV1
    sourceTextUtf16?: string
    sourceRevisionHash?: string
    offsetEncoding: 'utf-16'
    settingsFingerprint?: string
    // Prompt Target V2: the prepared PromptContext, projected so a reloading
    // Plugin can restore target/profile/config/catalog identity (request §10-21/23).
    promptContext?: IllustrationPromptContextV2
    agentAttemptCount: number
    updatedAt: number
    error?: IllustrationRecordErrorV1
}

export type IllustrationJobFullSnapshotV1 = {
    protocolVersion: 1
    turnId: string
    jobId: string
    slotOrdinal: number
    version: number
    state: IllustrationJobState
    lease?: IllustrationLeaseViewV1
    workerEpoch: number
    target?: IllustrationTargetV1
    sceneId: string
    scenePayload: ScenePayloadV1
    hasDurablePrompt: boolean
    attemptId?: string
    assetId?: string
    createdAt: number
    updatedAt: number
    agentAttemptCount: number
    error?: IllustrationRecordErrorV1
    // Image Revision V1: present only on revision child jobs.
    revision?: IllustrationRevisionJobProjectionV1
}

export type IllustrationJobTerminalSummaryV1 = {
    protocolVersion: 1
    turnId: string
    jobId: string
    slotOrdinal: number
    version: number
    state: 'committed' | 'failed' | 'stale' | 'cancelled' | 'corrupt'
    target?: Pick<
        IllustrationTargetV1,
        'chaId' | 'conversationId' | 'expectedMessageId' | 'rootTurnId'
    >
    sceneId: string
    createdAt: number
    updatedAt: number
    error?: Pick<IllustrationRecordErrorV1, 'code'>
}

export type IllustrationJobSnapshotV1 =
    | IllustrationJobFullSnapshotV1
    | IllustrationJobTerminalSummaryV1
