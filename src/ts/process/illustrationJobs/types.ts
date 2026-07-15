export type ScenePayloadV1 = {
    schemaVersion: number
    data: unknown
}

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

export type IllustrationJobState =
    | 'prepared'
    | 'awaiting_prompt'
    | 'agent_blocked_retryable'
    | 'agent_blocked'
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
    target?: IllustrationTurnTargetV1
    sourceTextUtf16?: string
    sourceRevisionHash?: string
    settingsFingerprint?: string
    error?: IllustrationRecordErrorV1
    lastPlanClosureWrite?: IllustrationPlanClosureReceiptV1
}

export type IllustrationJobPromptV1 = {
    positive: string
    negative: string
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
    prompt?: IllustrationJobPromptV1
    settingsFingerprint?: string
    attemptId?: string
    assetId?: string
    error?: IllustrationRecordErrorV1
    cancelRequestedAt?: number
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
    prompt?: IllustrationJobPromptV1
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
    lease?: IllustrationLeaseViewV1
    target?: IllustrationTurnTargetV1
    sourceTextUtf16?: string
    sourceRevisionHash?: string
    offsetEncoding: 'utf-16'
    settingsFingerprint?: string
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
