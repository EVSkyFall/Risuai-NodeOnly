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
    | 'awaiting_prompt'
    | 'blocked_manifest'
    | 'no_scenes'
    | 'completed'
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
}

export type IllustrationLeaseRecordFields = {
    version: number
    leaseId: string | null
    leaseExpiresAt: number
    fence: number
    workerEpoch: number
    updatedAt: number
    idempotencyKey: string
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
