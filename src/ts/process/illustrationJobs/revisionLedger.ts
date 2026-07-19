import {
    listPersistentKeys,
    readManyPersistentJson,
    readPersistentJson,
    writePersistentJson,
} from '../../storage/persistentKv'
import {
    IllustrationLedgerConfirmationRequiredError,
    IllustrationLedgerCorruptError,
    IllustrationLedgerIdempotencyConflictError,
    IllustrationLedgerNotFoundError,
    IllustrationLedgerValidationError,
    IllustrationLedgerVersionConflictError,
} from './errors'
import { parseIllustrationPromptV1 } from './imagePrompt'
import { withIllustrationLedgerLock } from './locks'
import { sha256Hex } from './sourceHash'
import { ILLUSTRATION_JOB_PREFIX, illustrationJobKey } from './store'
import type {
    IllustrationImageLineageRecordV1,
    IllustrationImageReferenceRecordV1,
    IllustrationImageReferenceSummaryV1,
    IllustrationJobRecordV1,
    IllustrationJobRevisionDescriptorV1,
    IllustrationLineageRevisionEntryV1,
    IllustrationPromptV1,
    IllustrationRevisionChargeCertainty,
    IllustrationRevisionDisposition,
    IllustrationRevisionIdentity,
    IllustrationRevisionIntentReceiptV1,
    IllustrationRevisionMode,
    IllustrationRevisionSummaryV1,
    ScenePayloadV1,
} from './types'

export const ILLUSTRATION_REFERENCE_PREFIX = 'illustration:v1:reference:'
export const ILLUSTRATION_LINEAGE_PREFIX = 'illustration:v1:lineage:'
export const ILLUSTRATION_REVISION_INTENT_PREFIX = 'illustration:v1:revintent:'
export const ILLUSTRATION_REFERENCE_INDEX_KEY = 'illustration:v1:referenceIndex'

// Bounded lineage history. When exceeded, the oldest entries are compacted away
// but the current revision entry is always retained so restore of the live target
// (and any recent target) stays reachable (§4.2 retention).
export const MAX_LINEAGE_REVISIONS = 200
export const DEFAULT_REVISION_PAGE_LIMIT = 50
export const MAX_REVISION_PAGE_LIMIT = 200

export const illustrationReferenceKey = (referenceId: string) =>
    `${ILLUSTRATION_REFERENCE_PREFIX}${referenceId}`
export const illustrationLineageKey = (lineageId: string) =>
    `${ILLUSTRATION_LINEAGE_PREFIX}${lineageId}`

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T
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

export async function promptHashFor(prompt: IllustrationPromptV1): Promise<string> {
    // parseIllustrationPromptV1 normalizes key order and array density, so its
    // JSON serialization is a stable content hash of the structured prompt.
    return await sha256Hex(JSON.stringify(parseIllustrationPromptV1(prompt)))
}

export async function scenePayloadRef(scenePayload: ScenePayloadV1): Promise<string> {
    return `scene:${(await sha256Hex(JSON.stringify(scenePayload))).slice(0, 32)}`
}

async function genesisReferenceId(jobId: string): Promise<string> {
    return `ref:genesis:${(await sha256Hex(`genesis:${jobId}`)).slice(0, 40)}`
}

function makeOpaqueId(prefix: string): string {
    if (globalThis.crypto?.randomUUID) return `${prefix}:${globalThis.crypto.randomUUID()}`
    if (globalThis.crypto?.getRandomValues) {
        const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
        return `${prefix}:${[...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')}`
    }
    throw new IllustrationLedgerValidationError('Secure random identifiers are unavailable')
}

async function intentKey(idempotencyKey: string): Promise<string> {
    return `${ILLUSTRATION_REVISION_INTENT_PREFIX}${await sha256Hex(idempotencyKey)}`
}

async function readReferenceUnlocked(
    referenceId: string,
): Promise<IllustrationImageReferenceRecordV1 | null> {
    return await readPersistentJson<IllustrationImageReferenceRecordV1>(
        illustrationReferenceKey(referenceId),
    )
}

async function readLineageUnlocked(
    lineageId: string,
): Promise<IllustrationImageLineageRecordV1 | null> {
    return await readPersistentJson<IllustrationImageLineageRecordV1>(
        illustrationLineageKey(lineageId),
    )
}

// Lock-free job reads used INSIDE the ledger lock. The store's public getJob/
// listJobRecords re-acquire the same non-reentrant ledger lock, so they must never
// be called from within a ledger-lock scope; these read the KV directly instead.
async function listCommittedGenesisJobsUnlocked(filter: {
    conversationId?: string
    messageId?: string
}): Promise<IllustrationJobRecordV1[]> {
    const keys = await listPersistentKeys(ILLUSTRATION_JOB_PREFIX)
    const records = await readManyPersistentJson<IllustrationJobRecordV1>(keys)
    return records.filter((record): record is IllustrationJobRecordV1 =>
        record !== null
        && record.state === 'committed'
        && !record.revision
        && !!record.target
        && !!record.assetId
        && !!record.prompt
        && (filter.conversationId === undefined
            || record.target.conversationId === filter.conversationId)
        && (filter.messageId === undefined
            || record.target.expectedMessageId === filter.messageId))
}

async function readIndexUnlocked(): Promise<string[]> {
    let raw: unknown
    try {
        raw = await readPersistentJson<unknown>(ILLUSTRATION_REFERENCE_INDEX_KEY)
    } catch {
        return []
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
    const parsed = raw as { schemaVersion?: unknown; referenceIds?: unknown }
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.referenceIds)) return []
    return [...new Set(parsed.referenceIds.filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
    ))]
}

async function writeIndexUnlocked(referenceIds: readonly string[]): Promise<void> {
    await writePersistentJson(ILLUSTRATION_REFERENCE_INDEX_KEY, {
        schemaVersion: 1,
        referenceIds: [...new Set(referenceIds)].sort(),
    })
}

async function addToIndexUnlocked(referenceId: string): Promise<void> {
    const ids = await readIndexUnlocked()
    if (!ids.includes(referenceId)) await writeIndexUnlocked([...ids, referenceId])
}

async function writeReferenceUnlocked(record: IllustrationImageReferenceRecordV1): Promise<void> {
    await writePersistentJson(illustrationReferenceKey(record.referenceId), record)
}

async function writeLineageUnlocked(record: IllustrationImageLineageRecordV1): Promise<void> {
    await writePersistentJson(illustrationLineageKey(record.lineageId), compactLineage(record))
}

function compactLineage(
    record: IllustrationImageLineageRecordV1,
): IllustrationImageLineageRecordV1 {
    if (record.revisions.length <= MAX_LINEAGE_REVISIONS) return record
    const reference = record.referenceId
    // Preserve the newest window plus, defensively, ensure we never drop below the
    // window; the current entry is always within the newest window because a commit
    // appends it last. This keeps restore targets reachable for the recent history.
    const kept = record.revisions.slice(record.revisions.length - MAX_LINEAGE_REVISIONS)
    return { ...record, referenceId: reference, revisions: kept }
}

export function revisionEntryToSummary(
    entry: IllustrationLineageRevisionEntryV1,
    currentRevisionId: string,
): IllustrationRevisionSummaryV1 {
    return {
        revisionId: entry.revisionId,
        parentRevisionId: entry.parentRevisionId,
        jobId: entry.jobId,
        assetId: entry.assetId,
        promptHash: entry.promptHash,
        mode: entry.mode,
        disposition: entry.disposition,
        chargeCertainty: entry.chargeCertainty,
        isCurrent: entry.revisionId === currentRevisionId,
        createdAt: entry.createdAt,
    }
}

export function referenceIdentity(
    reference: IllustrationImageReferenceRecordV1,
): IllustrationRevisionIdentity {
    return {
        referenceId: reference.referenceId,
        operationVersion: reference.operationVersion,
        lineageId: reference.lineageId,
        lineageVersion: reference.lineageVersion,
        sourceJobId: reference.sourceJobId,
        currentAssetId: reference.currentAssetId,
    }
}

export function referenceToSummary(
    reference: IllustrationImageReferenceRecordV1,
): IllustrationImageReferenceSummaryV1 {
    return {
        protocolVersion: 1,
        referenceId: reference.referenceId,
        operationVersion: reference.operationVersion,
        lineageId: reference.lineageId,
        lineageVersion: reference.lineageVersion,
        sourceJobId: reference.sourceJobId,
        currentAssetId: reference.currentAssetId,
        target: {
            chaId: reference.target.chaId,
            conversationId: reference.target.conversationId,
            expectedMessageId: reference.target.expectedMessageId,
            rootTurnId: reference.target.rootTurnId,
        },
        createdAt: reference.createdAt,
        updatedAt: reference.updatedAt,
    }
}

// A committed job with a durable structured prompt and asset is genesis-eligible.
// Physical-legacy prompts are not measurable/revisable, so they are skipped.
function genesisEligible(job: IllustrationJobRecordV1): boolean {
    return (
        job.state === 'committed'
        && typeof job.assetId === 'string'
        && job.assetId.length > 0
        && !!job.target
        && !!job.prompt
        && !job.revision
        && typeof (job.prompt as { schemaVersion?: unknown }).schemaVersion === 'number'
        && typeof job.settingsFingerprint === 'string'
        && job.settingsFingerprint.length > 0
    )
}

async function ensureGenesisReferenceUnlocked(
    job: IllustrationJobRecordV1,
    now: number,
): Promise<IllustrationImageReferenceRecordV1 | null> {
    if (!genesisEligible(job)) return null
    let prompt: IllustrationPromptV1
    try {
        prompt = parseIllustrationPromptV1(job.prompt)
    } catch {
        return null
    }
    const referenceId = await genesisReferenceId(job.jobId)
    const existing = await readReferenceUnlocked(referenceId)
    if (existing) return existing

    const promptHash = await promptHashFor(prompt)
    const revisionId = `rev:genesis:${(await sha256Hex(`genesis-rev:${job.jobId}`)).slice(0, 40)}`
    const lineageId = `lineage:genesis:${(await sha256Hex(`genesis-lineage:${job.jobId}`)).slice(0, 40)}`
    const entry: IllustrationLineageRevisionEntryV1 = {
        revisionId,
        parentRevisionId: null,
        jobId: job.jobId,
        assetId: job.assetId!,
        prompt: cloneJson(prompt),
        promptHash,
        mode: 'genesis',
        disposition: null,
        chargeCertainty: 'charged',
        createdAt: job.createdAt ?? now,
    }
    const lineage: IllustrationImageLineageRecordV1 = {
        schemaVersion: 1,
        lineageId,
        referenceId,
        revisions: [entry],
        createdAt: now,
        updatedAt: now,
    }
    const reference: IllustrationImageReferenceRecordV1 = {
        schemaVersion: 1,
        referenceId,
        operationVersion: 0,
        lineageId,
        lineageVersion: 1,
        sourceJobId: job.jobId,
        currentAssetId: job.assetId!,
        currentRevisionId: revisionId,
        currentPrompt: cloneJson(prompt),
        currentPromptHash: promptHash,
        settingsFingerprint: job.settingsFingerprint!,
        sceneId: job.sceneId,
        scenePayload: cloneJson(job.scenePayload),
        target: cloneJson(job.target!),
        createdAt: now,
        updatedAt: now,
    }
    await writeLineageUnlocked(lineage)
    await writeReferenceUnlocked(reference)
    await addToIndexUnlocked(referenceId)
    return reference
}

export type ListImageReferencesInput = {
    conversationId?: string
    messageId?: string
    cursor?: string
    limit: number
}

export type ListImageReferencesResult = {
    protocolVersion: 1
    items: IllustrationImageReferenceSummaryV1[]
    nextCursor: string | null
}

function boundedLimit(limit: unknown): number {
    if (!Number.isSafeInteger(limit) || (limit as number) <= 0) {
        throw new IllustrationLedgerValidationError('limit must be a positive integer')
    }
    return Math.min(limit as number, MAX_REVISION_PAGE_LIMIT)
}

// Bounded, cursor-based reference listing with deterministic lazy backfill.
export async function listImageReferences(
    input: ListImageReferencesInput,
): Promise<ListImageReferencesResult> {
    const limit = boundedLimit(input.limit)
    if (input.conversationId !== undefined) assertNonEmptyString(input.conversationId, 'conversationId')
    if (input.messageId !== undefined) assertNonEmptyString(input.messageId, 'messageId')
    if (input.cursor !== undefined) assertNonEmptyString(input.cursor, 'cursor')

    return await withIllustrationLedgerLock(async () => {
        const now = Date.now()
        // 1. Backfill genesis references for committed jobs matching the filter.
        const committed = await listCommittedGenesisJobsUnlocked({
            conversationId: input.conversationId,
            messageId: input.messageId,
        })
        for (const job of committed) {
            await ensureGenesisReferenceUnlocked(job, now)
        }

        // 2. Read the reference index and load matching reference records.
        const ids = await readIndexUnlocked()
        const records = await readManyPersistentJson<IllustrationImageReferenceRecordV1>(
            ids.map((id) => illustrationReferenceKey(id)),
        )
        const healthy: string[] = []
        const matching: IllustrationImageReferenceRecordV1[] = []
        let indexChanged = false
        for (let i = 0; i < ids.length; i += 1) {
            const record = records[i]
            if (!record) {
                indexChanged = true
                continue
            }
            healthy.push(ids[i])
            if (input.conversationId !== undefined
                && record.target.conversationId !== input.conversationId) continue
            if (input.messageId !== undefined
                && record.target.expectedMessageId !== input.messageId) continue
            matching.push(record)
        }
        if (indexChanged) await writeIndexUnlocked(healthy)

        // 3. Stable order (createdAt asc, referenceId tie-break) and cursor paginate.
        matching.sort((left, right) =>
            left.createdAt - right.createdAt || left.referenceId.localeCompare(right.referenceId))
        let start = 0
        if (input.cursor !== undefined) {
            const cursorIndex = matching.findIndex((record) => record.referenceId === input.cursor)
            start = cursorIndex < 0 ? matching.length : cursorIndex + 1
        }
        const page = matching.slice(start, start + limit)
        const nextCursor = start + limit < matching.length
            ? page[page.length - 1]?.referenceId ?? null
            : null
        return {
            protocolVersion: 1,
            items: page.map(referenceToSummary),
            nextCursor,
        }
    })
}

export type GetImageRevisionTargetResult = {
    protocolVersion: 1
    identity: IllustrationRevisionIdentity
    prompt: IllustrationPromptV1
    promptHash: string
    scenePayloadRef: string
    providerDispatched: boolean
    chargeCertainty: IllustrationRevisionChargeCertainty
}

export function jobChargeStatus(job: IllustrationJobRecordV1 | null): {
    providerDispatched: boolean
    chargeCertainty: IllustrationRevisionChargeCertainty
} {
    if (!job) return { providerDispatched: false, chargeCertainty: 'not-started' }
    switch (job.state) {
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
            return job.error?.code?.startsWith('provider')
                ? { providerDispatched: true, chargeCertainty: 'not-charged' }
                : { providerDispatched: false, chargeCertainty: 'not-charged' }
        default:
            return { providerDispatched: false, chargeCertainty: 'not-started' }
    }
}

export async function getImageRevisionTarget(
    referenceId: string,
): Promise<GetImageRevisionTargetResult> {
    assertNonEmptyString(referenceId, 'referenceId')
    return await withIllustrationLedgerLock(async () => {
        const reference = await readReferenceUnlocked(referenceId)
        if (!reference) throw new IllustrationLedgerNotFoundError('reference', referenceId)
        // If an active (non-terminal) revision child exists for this reference,
        // its dispatch/charge state drives the cancellation wording (§4.3); else
        // the committed current asset is charged.
        const active = await findActiveRevisionChildUnlocked(reference)
        const status = active
            ? jobChargeStatus(active)
            : { providerDispatched: true, chargeCertainty: 'charged' as const }
        return {
            protocolVersion: 1,
            identity: referenceIdentity(reference),
            prompt: cloneJson(reference.currentPrompt),
            promptHash: reference.currentPromptHash,
            scenePayloadRef: await scenePayloadRef(reference.scenePayload),
            providerDispatched: status.providerDispatched,
            chargeCertainty: status.chargeCertainty,
        }
    })
}

async function findActiveRevisionChildUnlocked(
    reference: IllustrationImageReferenceRecordV1,
): Promise<IllustrationJobRecordV1 | null> {
    // Scan all job records for a non-terminal revision child bound to this
    // reference. A lineage entry only records the jobId at commit; an in-flight
    // (never-committed) child would not yet be in the lineage, so a direct scan is
    // used. The set is small in practice (in-flight revisions only).
    const terminal = new Set(['committed', 'failed', 'stale', 'uncertain', 'cancelled', 'corrupt'])
    const keys = await listPersistentKeys(ILLUSTRATION_JOB_PREFIX)
    const records = await readManyPersistentJson<IllustrationJobRecordV1>(keys)
    let candidate: IllustrationJobRecordV1 | null = null
    for (const record of records) {
        if (!record || !record.revision || record.revision.referenceId !== reference.referenceId) continue
        if (terminal.has(record.state)) continue
        if (!candidate || record.createdAt > candidate.createdAt) candidate = record
    }
    return candidate
}

export type ListImageRevisionsResult = {
    protocolVersion: 1
    items: IllustrationRevisionSummaryV1[]
    nextCursor: string | null
}

export async function listImageRevisions(input: {
    referenceId: string
    cursor?: string
    limit: number
}): Promise<ListImageRevisionsResult> {
    assertNonEmptyString(input.referenceId, 'referenceId')
    const limit = boundedLimit(input.limit)
    if (input.cursor !== undefined) assertNonEmptyString(input.cursor, 'cursor')
    return await withIllustrationLedgerLock(async () => {
        const reference = await readReferenceUnlocked(input.referenceId)
        if (!reference) throw new IllustrationLedgerNotFoundError('reference', input.referenceId)
        const lineage = await readLineageUnlocked(reference.lineageId)
        if (!lineage) throw new IllustrationLedgerCorruptError('Reference lineage is missing')
        // Newest-first history.
        const ordered = [...lineage.revisions].sort(
            (left, right) => right.createdAt - left.createdAt
                || right.revisionId.localeCompare(left.revisionId),
        )
        let start = 0
        if (input.cursor !== undefined) {
            const cursorIndex = ordered.findIndex((entry) => entry.revisionId === input.cursor)
            start = cursorIndex < 0 ? ordered.length : cursorIndex + 1
        }
        const page = ordered.slice(start, start + limit)
        const nextCursor = start + limit < ordered.length
            ? page[page.length - 1]?.revisionId ?? null
            : null
        return {
            protocolVersion: 1,
            items: page.map((entry) => revisionEntryToSummary(entry, reference.currentRevisionId)),
            nextCursor,
        }
    })
}

// ---------------------------------------------------------------------------
// Admission (createImageRevision) — CAS operationVersion + create child.
// ---------------------------------------------------------------------------

export type AdmitRevisionInput = {
    idempotencyKey: string
    referenceId: string
    expectedOperationVersion: number
    sourceJobId: string
    expectedLineageVersion: number
    expectedCurrentAssetId: string
    mode: IllustrationRevisionMode
    disposition: IllustrationRevisionDisposition
    // Pre-validated + normalized edited prompt (edited-prompt mode only).
    editedPrompt?: IllustrationPromptV1
    editedPromptHash?: string
    confirmNewImageCharge: boolean
    confirmNewLlmCharge: boolean
    workerEpoch?: number
}

async function bindingHashFor(
    kind: 'revision' | 'restore',
    fields: Record<string, unknown>,
): Promise<string> {
    return await sha256Hex(JSON.stringify([kind, fields]))
}

function assertReferenceCas(
    reference: IllustrationImageReferenceRecordV1,
    input: {
        expectedOperationVersion: number
        sourceJobId: string
        expectedLineageVersion: number
        expectedCurrentAssetId: string
    },
): void {
    assertNonNegativeInteger(input.expectedOperationVersion, 'expectedOperationVersion')
    assertNonNegativeInteger(input.expectedLineageVersion, 'expectedLineageVersion')
    assertNonEmptyString(input.sourceJobId, 'sourceJobId')
    assertNonEmptyString(input.expectedCurrentAssetId, 'expectedCurrentAssetId')
    // operationVersion is the primary monotonic admission CAS: a concurrent intent
    // that observed the same version loses here (§4). lineageVersion is the
    // current-asset pointer CAS. Both surface as version_conflict so the Plugin
    // refreshes its snapshot and retries with a new nonce.
    if (reference.operationVersion !== input.expectedOperationVersion) {
        throw new IllustrationLedgerVersionConflictError(
            input.expectedOperationVersion,
            reference.operationVersion,
        )
    }
    if (reference.lineageVersion !== input.expectedLineageVersion) {
        throw new IllustrationLedgerVersionConflictError(
            input.expectedLineageVersion,
            reference.lineageVersion,
        )
    }
    // With a matching operationVersion+lineageVersion the current asset/source job
    // must also match (they are written atomically). A mismatch is an inconsistent
    // client expectation rather than a lost race.
    if (reference.sourceJobId !== input.sourceJobId
        || reference.currentAssetId !== input.expectedCurrentAssetId) {
        throw new IllustrationLedgerValidationError(
            'Illustration revision expected-state mismatch (currentAssetId/sourceJobId)',
        )
    }
}

export type AdmitRevisionResult = {
    childJobId: string
    childJob: IllustrationJobRecordV1
}

export async function admitRevisionChild(
    input: AdmitRevisionInput,
): Promise<AdmitRevisionResult> {
    assertNonEmptyString(input.idempotencyKey, 'idempotencyKey')
    assertNonEmptyString(input.referenceId, 'referenceId')
    if (input.mode !== 'exact-prompt' && input.mode !== 'edited-prompt' && input.mode !== 'retag') {
        throw new IllustrationLedgerValidationError('mode is invalid')
    }
    if (input.disposition !== 'replace' && input.disposition !== 'retain') {
        throw new IllustrationLedgerValidationError('disposition is invalid')
    }
    // Forced charge confirmations (§4 booleans). exact/edited incur an image charge
    // immediately; retag incurs an LLM charge now (Tagger) and the image charge is a
    // separate, later enqueueRevisionImage step.
    if (input.mode === 'retag') {
        if (input.confirmNewLlmCharge !== true) {
            throw new IllustrationLedgerConfirmationRequiredError(
                'Retagging requires confirmNewLlmCharge: true',
            )
        }
    } else if (input.confirmNewImageCharge !== true) {
        throw new IllustrationLedgerConfirmationRequiredError(
            'A new revision image requires confirmNewImageCharge: true',
        )
    }

    return await withIllustrationLedgerLock(async () => {
        const now = Date.now()
        const bindingHash = await bindingHashFor('revision', {
            referenceId: input.referenceId,
            expectedOperationVersion: input.expectedOperationVersion,
            sourceJobId: input.sourceJobId,
            expectedLineageVersion: input.expectedLineageVersion,
            expectedCurrentAssetId: input.expectedCurrentAssetId,
            mode: input.mode,
            disposition: input.disposition,
            editedPromptHash: input.editedPromptHash ?? null,
        })
        const receiptKey = await intentKey(input.idempotencyKey)
        const receipt = await readPersistentJson<IllustrationRevisionIntentReceiptV1>(receiptKey)
        if (receipt) {
            if (receipt.kind !== 'revision' || receipt.bindingHash !== bindingHash) {
                throw new IllustrationLedgerIdempotencyConflictError(
                    'Revision idempotencyKey is bound to a different intent',
                )
            }
            const childJobId = receipt.childJobId!
            const childJob = await readPersistentJson<IllustrationJobRecordV1>(
                illustrationJobKey(childJobId),
            )
            if (!childJob) throw new IllustrationLedgerCorruptError('Admitted revision child is missing')
            return { childJobId, childJob: cloneJson(childJob) }
        }

        const reference = await readReferenceUnlocked(input.referenceId)
        if (!reference) throw new IllustrationLedgerNotFoundError('reference', input.referenceId)
        assertReferenceCas(reference, input)

        const childJobId = makeOpaqueId('revjob')
        const revisionId = makeOpaqueId('rev')
        const disposition = input.disposition
        const forkReferenceId = disposition === 'retain' ? makeOpaqueId('ref') : undefined
        const forkLineageId = disposition === 'retain' ? makeOpaqueId('lineage') : undefined

        let prompt: IllustrationPromptV1 | undefined
        let promptHash: string
        let state: IllustrationJobRecordV1['state']
        if (input.mode === 'exact-prompt') {
            prompt = cloneJson(reference.currentPrompt)
            promptHash = reference.currentPromptHash
            state = 'queued'
        } else if (input.mode === 'edited-prompt') {
            if (!input.editedPrompt || !input.editedPromptHash) {
                throw new IllustrationLedgerValidationError('edited-prompt requires editedPrompt')
            }
            prompt = cloneJson(input.editedPrompt)
            promptHash = input.editedPromptHash
            state = 'queued'
        } else {
            // retag: child starts awaiting_prompt (no durable prompt yet); the
            // Tagger supplies it, then it stops at prompt_ready. The promptHash is
            // the parent's until the Tagger supplies a new one.
            prompt = undefined
            promptHash = reference.currentPromptHash
            state = 'awaiting_prompt'
        }

        const revision: IllustrationJobRevisionDescriptorV1 = {
            referenceId: reference.referenceId,
            lineageId: reference.lineageId,
            parentRevisionId: reference.currentRevisionId,
            revisionId,
            mode: input.mode,
            disposition,
            admittedOperationVersion: reference.operationVersion + 1,
            expectedLineageVersion: reference.lineageVersion,
            expectedCurrentAssetId: reference.currentAssetId,
            ...(forkReferenceId ? { forkReferenceId } : {}),
            ...(forkLineageId ? { forkLineageId } : {}),
            promptHash,
        }

        const childJob: IllustrationJobRecordV1 = {
            schemaVersion: 1,
            turnId: `revision:${reference.referenceId}`,
            jobId: childJobId,
            slotToken: `revision:${revisionId}`,
            insertAfterUtf16: 0,
            sceneId: reference.sceneId,
            scenePayload: cloneJson(reference.scenePayload),
            sourceRevisionHash: reference.target.sourceRevisionHash,
            slotOrdinal: 0,
            createdAt: now,
            state,
            version: 1,
            leaseId: null,
            leaseExpiresAt: 0,
            fence: 0,
            workerEpoch: input.workerEpoch ?? 0,
            updatedAt: now,
            idempotencyKey: `revision:${childJobId}`,
            agentAttemptCount: 0,
            creationIdempotencyKey: `revision:${childJobId}`,
            target: cloneJson(reference.target),
            settingsFingerprint: reference.settingsFingerprint,
            ...(prompt ? { prompt } : {}),
            revision,
        }

        // The KV exposes only single-key writes, so these three records cannot be one
        // durable transaction (§4). Order them to fail closed instead:
        //   1. reference operationVersion bump  (admission CAS is consumed even if the
        //      child later fails/cancels; a crash after this yields a consumed op and a
        //      version_conflict on retry — the contract's failed-attempt/refresh path)
        //   2. durable idempotency receipt        (seals the admitted childJobId)
        //   3. the executable child job LAST      (only dispatchable once the receipt is
        //      durable — so a crash before the receipt never leaves an orphan 'queued'
        //      child that the pump would dispatch and charge for)
        const nextReference: IllustrationImageReferenceRecordV1 = {
            ...reference,
            operationVersion: reference.operationVersion + 1,
            updatedAt: now,
        }
        await writeReferenceUnlocked(nextReference)
        const nextReceipt: IllustrationRevisionIntentReceiptV1 = {
            schemaVersion: 1,
            idempotencyKey: input.idempotencyKey,
            referenceId: reference.referenceId,
            kind: 'revision',
            bindingHash,
            admittedOperationVersion: reference.operationVersion + 1,
            childJobId,
            createdAt: now,
        }
        await writePersistentJson(receiptKey, nextReceipt)
        await writePersistentJson(illustrationJobKey(childJobId), childJob)
        return { childJobId, childJob: cloneJson(childJob) }
    })
}

// ---------------------------------------------------------------------------
// Commit-time reference CAS (replace / retain fork). Called from the executor
// AFTER the new asset is written+verified and the chat inlay has been spliced.
// ---------------------------------------------------------------------------

export type RevisionCommitInput = {
    revision: IllustrationJobRevisionDescriptorV1
    childJobId: string
    newAssetId: string
    childPrompt: IllustrationPromptV1
    chargeCertainty: IllustrationRevisionChargeCertainty
}

export type RevisionCommitResult =
    | { applied: true; identity: IllustrationRevisionIdentity }
    | { applied: false; reason: 'stale' }

// Precondition read used BEFORE the chat flush so we never mutate the chat when the
// current asset has already moved (a late result). Returns 'ok' | 'stale'.
export async function checkReplacePrecondition(
    revision: IllustrationJobRevisionDescriptorV1,
    newAssetId: string,
): Promise<'ok' | 'applied' | 'stale'> {
    return await withIllustrationLedgerLock(async () => {
        const reference = await readReferenceUnlocked(revision.referenceId)
        if (!reference) return 'stale'
        if (reference.currentRevisionId === revision.revisionId
            && reference.currentAssetId === newAssetId) return 'applied'
        if (reference.currentAssetId !== revision.expectedCurrentAssetId
            || reference.lineageVersion !== revision.expectedLineageVersion) return 'stale'
        return 'ok'
    })
}

export async function commitReplaceReference(
    input: RevisionCommitInput,
): Promise<RevisionCommitResult> {
    return await withIllustrationLedgerLock(async () => {
        const now = Date.now()
        const { revision } = input
        const reference = await readReferenceUnlocked(revision.referenceId)
        if (!reference) return { applied: false, reason: 'stale' }
        // Idempotent replay (recovery re-detected the flushed inlay).
        if (reference.currentRevisionId === revision.revisionId
            && reference.currentAssetId === input.newAssetId) {
            return { applied: true, identity: referenceIdentity(reference) }
        }
        if (reference.currentAssetId !== revision.expectedCurrentAssetId
            || reference.lineageVersion !== revision.expectedLineageVersion) {
            return { applied: false, reason: 'stale' }
        }
        const lineage = await readLineageUnlocked(reference.lineageId)
        if (!lineage) return { applied: false, reason: 'stale' }
        const promptHash = await promptHashFor(input.childPrompt)
        const entry: IllustrationLineageRevisionEntryV1 = {
            revisionId: revision.revisionId,
            parentRevisionId: revision.parentRevisionId,
            jobId: input.childJobId,
            assetId: input.newAssetId,
            prompt: cloneJson(input.childPrompt),
            promptHash,
            mode: revision.mode,
            disposition: 'replace',
            chargeCertainty: input.chargeCertainty,
            createdAt: now,
        }
        const nextLineage: IllustrationImageLineageRecordV1 = {
            ...lineage,
            revisions: [...lineage.revisions, entry],
            updatedAt: now,
        }
        const nextReference: IllustrationImageReferenceRecordV1 = {
            ...reference,
            lineageVersion: reference.lineageVersion + 1,
            currentAssetId: input.newAssetId,
            currentRevisionId: revision.revisionId,
            currentPrompt: cloneJson(input.childPrompt),
            currentPromptHash: promptHash,
            sourceJobId: input.childJobId,
            updatedAt: now,
        }
        await writeLineageUnlocked(nextLineage)
        await writeReferenceUnlocked(nextReference)
        return { applied: true, identity: referenceIdentity(nextReference) }
    })
}

export async function commitRetainFork(
    input: RevisionCommitInput,
): Promise<RevisionCommitResult> {
    return await withIllustrationLedgerLock(async () => {
        const now = Date.now()
        const { revision } = input
        if (!revision.forkReferenceId || !revision.forkLineageId) {
            return { applied: false, reason: 'stale' }
        }
        const source = await readReferenceUnlocked(revision.referenceId)
        if (!source) return { applied: false, reason: 'stale' }
        const existingFork = await readReferenceUnlocked(revision.forkReferenceId)
        if (existingFork) {
            // Idempotent replay.
            return { applied: true, identity: referenceIdentity(existingFork) }
        }
        const promptHash = await promptHashFor(input.childPrompt)
        const entry: IllustrationLineageRevisionEntryV1 = {
            revisionId: revision.revisionId,
            parentRevisionId: null,
            jobId: input.childJobId,
            assetId: input.newAssetId,
            prompt: cloneJson(input.childPrompt),
            promptHash,
            mode: revision.mode,
            disposition: 'retain',
            chargeCertainty: input.chargeCertainty,
            createdAt: now,
        }
        const forkLineage: IllustrationImageLineageRecordV1 = {
            schemaVersion: 1,
            lineageId: revision.forkLineageId,
            referenceId: revision.forkReferenceId,
            revisions: [entry],
            createdAt: now,
            updatedAt: now,
        }
        const forkReference: IllustrationImageReferenceRecordV1 = {
            schemaVersion: 1,
            referenceId: revision.forkReferenceId,
            operationVersion: 0,
            lineageId: revision.forkLineageId,
            lineageVersion: 1,
            sourceJobId: input.childJobId,
            currentAssetId: input.newAssetId,
            currentRevisionId: revision.revisionId,
            currentPrompt: cloneJson(input.childPrompt),
            currentPromptHash: promptHash,
            settingsFingerprint: source.settingsFingerprint,
            sceneId: source.sceneId,
            scenePayload: cloneJson(source.scenePayload),
            target: cloneJson(source.target),
            sourceLineageId: source.lineageId,
            sourceRevisionId: revision.parentRevisionId,
            createdAt: now,
            updatedAt: now,
        }
        await writeLineageUnlocked(forkLineage)
        await writeReferenceUnlocked(forkReference)
        await addToIndexUnlocked(forkReference.referenceId)
        // The SOURCE reference/lineage/currentAssetId are intentionally left
        // untouched (§4.2 retain invariant).
        return { applied: true, identity: referenceIdentity(forkReference) }
    })
}

// ---------------------------------------------------------------------------
// Restore (no-charge re-point). The CAS + prompt lookup happen here; the caller
// (revision.ts) performs the chat inlay swap between the two lock phases.
// ---------------------------------------------------------------------------

export type RestorePreparation = {
    reference: IllustrationImageReferenceRecordV1
    targetEntry: IllustrationLineageRevisionEntryV1
}

export async function prepareRestore(input: {
    referenceId: string
    expectedOperationVersion: number
    expectedLineageVersion: number
    expectedCurrentAssetId: string
    targetRevisionId: string
}): Promise<RestorePreparation> {
    return await withIllustrationLedgerLock(async () => {
        const reference = await readReferenceUnlocked(input.referenceId)
        if (!reference) throw new IllustrationLedgerNotFoundError('reference', input.referenceId)
        assertReferenceCas(reference, {
            expectedOperationVersion: input.expectedOperationVersion,
            sourceJobId: reference.sourceJobId,
            expectedLineageVersion: input.expectedLineageVersion,
            expectedCurrentAssetId: input.expectedCurrentAssetId,
        })
        const lineage = await readLineageUnlocked(reference.lineageId)
        if (!lineage) throw new IllustrationLedgerCorruptError('Reference lineage is missing')
        const targetEntry = lineage.revisions.find(
            (entry) => entry.revisionId === input.targetRevisionId,
        )
        if (!targetEntry) {
            throw new IllustrationLedgerNotFoundError('revision', input.targetRevisionId)
        }
        return { reference: cloneJson(reference), targetEntry: cloneJson(targetEntry) }
    })
}

export type RestoreCommitResult =
    | { applied: true; identity: IllustrationRevisionIdentity }
    | { applied: false; reason: 'stale' }

export async function commitRestore(input: {
    referenceId: string
    expectedOperationVersion: number
    expectedLineageVersion: number
    targetEntry: IllustrationLineageRevisionEntryV1
    idempotencyKey: string
    bindingHash: string
}): Promise<RestoreCommitResult> {
    return await withIllustrationLedgerLock(async () => {
        const now = Date.now()
        const reference = await readReferenceUnlocked(input.referenceId)
        if (!reference) return { applied: false, reason: 'stale' }
        // Idempotent replay.
        if (reference.currentRevisionId === input.targetEntry.revisionId
            && reference.currentAssetId === input.targetEntry.assetId) {
            return { applied: true, identity: referenceIdentity(reference) }
        }
        if (reference.operationVersion !== input.expectedOperationVersion
            || reference.lineageVersion !== input.expectedLineageVersion) {
            return { applied: false, reason: 'stale' }
        }
        const nextReference: IllustrationImageReferenceRecordV1 = {
            ...reference,
            operationVersion: reference.operationVersion + 1,
            lineageVersion: reference.lineageVersion + 1,
            currentAssetId: input.targetEntry.assetId,
            currentRevisionId: input.targetEntry.revisionId,
            currentPrompt: cloneJson(input.targetEntry.prompt),
            currentPromptHash: input.targetEntry.promptHash,
            sourceJobId: input.targetEntry.jobId ?? reference.sourceJobId,
            updatedAt: now,
        }
        await writeReferenceUnlocked(nextReference)
        const receiptKey = await intentKey(input.idempotencyKey)
        const nextReceipt: IllustrationRevisionIntentReceiptV1 = {
            schemaVersion: 1,
            idempotencyKey: input.idempotencyKey,
            referenceId: input.referenceId,
            kind: 'restore',
            bindingHash: input.bindingHash,
            admittedOperationVersion: reference.operationVersion + 1,
            restoredIdentity: referenceIdentity(nextReference),
            createdAt: now,
        }
        await writePersistentJson(receiptKey, nextReceipt)
        return { applied: true, identity: referenceIdentity(nextReference) }
    })
}

export async function readRestoreReceipt(
    idempotencyKey: string,
    bindingHash: string,
): Promise<IllustrationRevisionIdentity | null> {
    return await withIllustrationLedgerLock(async () => {
        const receipt = await readPersistentJson<IllustrationRevisionIntentReceiptV1>(
            await intentKey(idempotencyKey),
        )
        if (!receipt) return null
        if (receipt.kind !== 'restore' || receipt.bindingHash !== bindingHash) {
            throw new IllustrationLedgerIdempotencyConflictError(
                'Restore idempotencyKey is bound to a different intent',
            )
        }
        return receipt.restoredIdentity ?? null
    })
}

// Restore-target binding hash (shared between the replay check and commit receipt).
export async function restoreBindingHash(input: {
    referenceId: string
    expectedOperationVersion: number
    expectedLineageVersion: number
    expectedCurrentAssetId: string
    targetRevisionId: string
}): Promise<string> {
    return await bindingHashFor('restore', {
        referenceId: input.referenceId,
        expectedOperationVersion: input.expectedOperationVersion,
        expectedLineageVersion: input.expectedLineageVersion,
        expectedCurrentAssetId: input.expectedCurrentAssetId,
        targetRevisionId: input.targetRevisionId,
    })
}

// Test/introspection helpers.
export async function readImageReference(
    referenceId: string,
): Promise<IllustrationImageReferenceRecordV1 | null> {
    return await withIllustrationLedgerLock(async () => {
        const record = await readReferenceUnlocked(referenceId)
        return record ? cloneJson(record) : null
    })
}

export async function readImageLineage(
    lineageId: string,
): Promise<IllustrationImageLineageRecordV1 | null> {
    return await withIllustrationLedgerLock(async () => {
        const record = await readLineageUnlocked(lineageId)
        return record ? cloneJson(record) : null
    })
}
