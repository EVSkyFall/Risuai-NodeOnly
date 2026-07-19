import { getDatabase, type Chat, type Message, type character } from '../../storage/database.svelte'
import { ensureChatHydrated, saveChatToServerStrict } from '../../storage/chatStorage'
import {
    inspectInlayAssetIntegrity,
    repairInlayAssetRecords,
    writeInlayImage,
} from '../files/inlays'
import {
    generateAIImageTyped,
    type ImageGenerationPriority,
    type ImageGenerationResult,
} from '../stableDiff'
import { patchSlotInVariant } from './anchors'
import {
    isIllustrationJobLiveContextCurrent,
    readStoredTransportConfig,
    resolveIllustrationJobContext,
    type IllustrationJobContextResult,
    type IllustrationJobLiveContext,
} from './coordinator'
import { illustrationTransportBroker } from './transportBroker'
import {
    dispatchComfyuiFlat,
    dispatchNaiCompatibleFlat,
    dispatchWebuiFlat,
    type TransportFetch,
    type TransportNativeFetch,
    type WebuiDispatchParams,
} from './transportDispatch'
import {
    computeEnvelopeHash,
    serializeEnvelopeForTransport,
    type IllustrationPromptEnvelopeV2,
} from './promptEnvelopeV2'
import {
    assertReceiptDispatchEligibleForTarget,
    envelopeToPromptV1,
    type IllustrationPromptMeasurementReceiptV2,
} from './promptMeasurementReceiptV2'
import {
    DEFAULT_NAI_ENDPOINT,
    resolvePromptTargetV2,
    verifyWebuiCheckpointBinding,
    type IllustrationPromptTargetV2,
    type IllustrationTransportConfigV1,
} from './promptContextV2'
import { findSlotNodes } from './controlNodes'
import {
    IllustrationImagePromptContractError,
    IllustrationLedgerHolderMismatchError,
    IllustrationLedgerUnavailableError,
    IllustrationLedgerValidationError,
    IllustrationLedgerVersionConflictError,
    IllustrationPromptV2ContractError,
} from './errors'
import {
    decodeIllustrationStoredPrompt,
    isLegacyIllustrationStoredPrompt,
} from './imagePrompt'
import { measureAndEnforceImagePromptForDispatch } from './imagePromptMeasurement'
import { isIllustrationFeatureEnabled, requireIllustrationFeatureEnabled } from './featureFlag'
import { emitIllustrationWakeHint } from './illustrationEvents'
import { registerIllustrationExecutorWakeListener } from './executorSignal'
import {
    checkReplacePrecondition,
    commitReplaceReference,
    commitRetainFork,
    type RevisionCommitResult,
} from './revisionLedger'
import {
    ILLUSTRATION_WORKER_LOCK_NAME,
} from './locks'
import {
    canonicalizeNaiSettings,
    computeNaiSettingsFingerprint,
    serializeCanonicalNaiSettings,
} from './settingsFingerprint'
import { computeSourceRevisionHash, hashesMatch, sha256Hex } from './sourceHash'
import { isTerminalJobState } from './stateMachine'
import { illustrationJobStore } from './store'
import type {
    IllustrationImageReferenceRecordV1,
    IllustrationJobRecordV1,
    IllustrationJobRevisionDescriptorV1,
    IllustrationJobTransitionPatch,
    IllustrationPromptV1,
} from './types'

export const ILLUSTRATION_EXECUTOR_POLL_MS = 5_000
export const ILLUSTRATION_IMAGE_DECODE_TIMEOUT_MS = 15_000
// A blocked_config V2 job whose captured target re-verifies via a LIVE backend probe
// (webui-flat probe-and-revalidate) must not fire that GET on every 5s executor poll.
// Every other resume path recomputes a purely local fingerprint at zero network cost, so
// only the live-probe binding needs a slower re-check cadence while blocked.
export const ILLUSTRATION_BLOCKED_LIVE_PROBE_MIN_INTERVAL_MS = 30_000

export interface IllustrationWorkerLockManager {
    request<T>(
        name: string,
        callback: () => T | Promise<T>,
        signal?: AbortSignal,
    ): Promise<T>
}

export type IllustrationWorkerLockManagerAccessor = () => IllustrationWorkerLockManager | undefined

function defaultWorkerLockManagerAccessor(): IllustrationWorkerLockManager | undefined {
    if (typeof navigator === 'undefined' || !navigator.locks?.request) return undefined
    return {
        request: async <T>(
            name: string,
            callback: () => T | Promise<T>,
            signal?: AbortSignal,
        ): Promise<T> => await navigator.locks.request(
            name,
            signal ? { signal } : {},
            async () => await callback(),
        ),
    }
}

let workerLockManagerAccessor: IllustrationWorkerLockManagerAccessor = defaultWorkerLockManagerAccessor

export function setIllustrationWorkerLockManagerAccessorForTests(
    accessor: IllustrationWorkerLockManagerAccessor,
): () => void {
    const previous = workerLockManagerAccessor
    workerLockManagerAccessor = accessor
    return () => {
        workerLockManagerAccessor = previous
    }
}

export function resetIllustrationWorkerLockManagerAccessorForTests(): void {
    workerLockManagerAccessor = defaultWorkerLockManagerAccessor
}

function requireWorkerLockManager(): IllustrationWorkerLockManager {
    const manager = workerLockManagerAccessor()
    if (!manager) throw new IllustrationLedgerUnavailableError()
    return manager
}

export async function deriveIllustrationAssetId(jobId: string, attemptId: string): Promise<string> {
    return `asset:${(await sha256Hex(`${jobId}:${attemptId}`)).slice(0, 32)}`
}

function freshAttemptId(): string {
    if (!globalThis.crypto?.randomUUID) {
        throw new IllustrationLedgerValidationError('Secure UUID generation is unavailable')
    }
    return globalThis.crypto.randomUUID()
}

function transitionKey(epoch: number, job: IllustrationJobRecordV1, step: string): string {
    return `worker:${epoch}:${job.jobId}:${job.attemptId ?? 'none'}:${step}:${job.version}`
}

async function transitionExecutorJob(
    input: Parameters<typeof illustrationJobStore.transitionJob>[0],
): Promise<IllustrationJobRecordV1> {
    const job = await illustrationJobStore.transitionJob(input)
    if (isTerminalJobState(job.state)) {
        await illustrationJobStore.finalizeTurnAfterJobs(job.turnId)
    }
    emitIllustrationWakeHint('job_changed', job.turnId, job.jobId)
    return job
}

async function cancelExecutorJob(
    input: Parameters<typeof illustrationJobStore.requestCancel>[0],
): Promise<IllustrationJobRecordV1> {
    const job = await illustrationJobStore.requestCancel(input)
    if (isTerminalJobState(job.state)) {
        await illustrationJobStore.finalizeTurnAfterJobs(job.turnId)
    }
    emitIllustrationWakeHint('job_changed', job.turnId, job.jobId)
    return job
}

async function transitionPreDispatchJob(
    snapshot: IllustrationJobRecordV1,
    to: 'blocked_config' | 'failed' | 'generating' | 'queued',
    patch: IllustrationJobTransitionPatch,
): Promise<IllustrationJobRecordV1 | null> {
    try {
        return await transitionExecutorJob({
            jobId: snapshot.jobId,
            expectedVersion: snapshot.version,
            to,
            patch,
        })
    } catch (error) {
        if (
            !(error instanceof IllustrationLedgerVersionConflictError)
            && !(error instanceof IllustrationLedgerHolderMismatchError)
        ) throw error
        const latest = await illustrationJobStore.getJob(snapshot.jobId)
        if (latest && latest.state !== snapshot.state) return null
        throw error
    }
}

type ImagePromptGateOutcome =
    | { ok: true; settingsSnapshot: string }
    | { ok: false; error: IllustrationImagePromptContractError }

function currentNaiSettingsSnapshot(): string {
    return serializeCanonicalNaiSettings(canonicalizeNaiSettings(getDatabase()))
}

type DispatchConfigurationBlockCode =
    | 'settings_fingerprint_mismatch'
    | 'unsupported_provider'
    // Prompt Target V2 (request §D2): the captured target no longer resolves / no
    // longer matches / failed its live checkpoint probe at dispatch => blocked_config,
    // provider-call-0. Distinct from the NAI V1 settings-fingerprint drift codes.
    | 'prompt_target_fingerprint_mismatch'
    | 'prompt_target_unavailable'

async function resolveDispatchConfigurationBlock(
    job: IllustrationJobRecordV1,
): Promise<DispatchConfigurationBlockCode | null> {
    const database = getDatabase()
    const settingsBefore = currentNaiSettingsSnapshot()
    const fingerprint = await computeNaiSettingsFingerprint(database)
    const settingsAfter = currentNaiSettingsSnapshot()
    if (getDatabase().sdProvider !== 'novelai') return 'unsupported_provider'
    if (settingsBefore !== settingsAfter || fingerprint !== job.settingsFingerprint) {
        return 'settings_fingerprint_mismatch'
    }
    return null
}

async function settleDispatchConfigurationBlock(
    job: IllustrationJobRecordV1,
    epoch: number,
    code: DispatchConfigurationBlockCode,
    step: string,
): Promise<void> {
    if (job.state !== 'queued' && job.state !== 'generating') return
    const blocked = await transitionPreDispatchJob(job, 'blocked_config', {
        idempotencyKey: transitionKey(epoch, job, step),
        workerEpoch: epoch,
        error: { code },
    })
    if (blocked || job.state !== 'generating') return

    let winner = await illustrationJobStore.getJob(job.jobId)
    while (
        winner?.state === 'cancel_requested'
        && winner.attemptId === job.attemptId
        && winner.assetId === job.assetId
    ) {
        try {
            await transitionExecutorJob({
                jobId: winner.jobId,
                expectedVersion: winner.version,
                to: 'cancelled',
                patch: {
                    idempotencyKey: transitionKey(epoch, winner, 'cancelled-config-race'),
                    workerEpoch: epoch,
                    error: null,
                },
            })
            return
        } catch (error) {
            if (!(error instanceof IllustrationLedgerVersionConflictError)) throw error
            winner = await illustrationJobStore.getJob(job.jobId)
        }
    }
}

async function runImagePromptGate(
    job: IllustrationJobRecordV1,
    prompt: IllustrationPromptV1,
): Promise<ImagePromptGateOutcome> {
    if (!job.settingsFingerprint) {
        return {
            ok: false,
            error: new IllustrationImagePromptContractError(
                'image_prompt_invalid',
                'The illustration job has no captured settings fingerprint',
            ),
        }
    }
    try {
        const settingsBefore = currentNaiSettingsSnapshot()
        await measureAndEnforceImagePromptForDispatch({
            protocolVersion: 1,
            settingsFingerprint: job.settingsFingerprint,
            prompt,
        }, { requireNovelAiProvider: true })
        const settingsAfter = currentNaiSettingsSnapshot()
        if (settingsAfter !== settingsBefore) {
            throw new IllustrationImagePromptContractError(
                'settings_fingerprint_mismatch',
                'The image settings changed while the prompt dispatch gate was running',
            )
        }
        return { ok: true, settingsSnapshot: settingsAfter }
    } catch (error) {
        if (!(error instanceof IllustrationImagePromptContractError)) throw error
        return { ok: false, error }
    }
}

function imagePromptRecordError(error: IllustrationImagePromptContractError) {
    return {
        code: error.code,
        retryable: false,
        ...(error.payload ? { payload: { ...error.payload } } : {}),
    }
}

async function settleImagePromptGateFailure(
    job: IllustrationJobRecordV1,
    epoch: number,
    error: IllustrationImagePromptContractError,
    step: string,
): Promise<void> {
    if (error.code === 'settings_fingerprint_mismatch') {
        await settleDispatchConfigurationBlock(job, epoch, error.code, step)
        return
    }
    const patch: IllustrationJobTransitionPatch = {
        idempotencyKey: transitionKey(epoch, job, step),
        workerEpoch: epoch,
        error: imagePromptRecordError(error),
    }
    if (job.state === 'queued') {
        await transitionPreDispatchJob(job, 'failed', patch)
        return
    }
    if (job.state !== 'generating') return
    await transitionExecutorJob({
        jobId: job.jobId,
        expectedVersion: job.version,
        to: 'failed',
        patch,
    })
}

async function settleContextFailure(
    job: IllustrationJobRecordV1,
    context: Exclude<IllustrationJobContextResult, IllustrationJobLiveContext>,
    epoch: number,
): Promise<IllustrationJobRecordV1> {
    return await transitionExecutorJob({
        jobId: job.jobId,
        expectedVersion: job.version,
        to: context.kind,
        patch: {
            idempotencyKey: transitionKey(epoch, job, `target-${context.kind}`),
            workerEpoch: epoch,
            error: { code: context.reason },
        },
    })
}

async function transitionProviderFailure(
    jobId: string,
    epoch: number,
    certainty: 'definite' | 'uncertain',
): Promise<void> {
    let latest = await illustrationJobStore.getJob(jobId)
    const attemptId = latest?.attemptId
    const assetId = latest?.assetId
    for (;;) {
        if (
            !latest
            || latest.attemptId !== attemptId
            || latest.assetId !== assetId
            || (latest.state !== 'generating' && latest.state !== 'cancel_requested')
        ) return
        try {
            await transitionExecutorJob({
                jobId,
                expectedVersion: latest.version,
                to: certainty === 'definite' ? 'failed' : 'uncertain',
                patch: {
                    idempotencyKey: transitionKey(epoch, latest, `provider-${certainty}`),
                    workerEpoch: epoch,
                    error: { code: `provider_${certainty}`, certainty },
                },
            })
            return
        } catch (error) {
            if (!(error instanceof IllustrationLedgerVersionConflictError)) throw error
            latest = await illustrationJobStore.getJob(jobId)
        }
    }
}

type LogicalVariant = {
    messageIndex: number
    text: string
}

function logicalVariants(chat: Chat): { kind: 'valid', variants: LogicalVariant[] } | { kind: 'corrupt' } {
    const variants: LogicalVariant[] = []
    for (let messageIndex = 0; messageIndex < chat.message.length; messageIndex += 1) {
        const message = chat.message[messageIndex]
        if (message.swipes === undefined) {
            variants.push({ messageIndex, text: message.data })
            continue
        }
        if (
            message.swipes.length === 0
            || !Number.isSafeInteger(message.swipeId)
            || message.swipeId! < 0
            || message.swipeId! >= message.swipes.length
            || message.data !== message.swipes[message.swipeId!]
        ) {
            return { kind: 'corrupt' }
        }
        variants.push({ messageIndex, text: message.data })
        for (let swipeIndex = 0; swipeIndex < message.swipes.length; swipeIndex += 1) {
            if (swipeIndex === message.swipeId) continue
            variants.push({ messageIndex, text: message.swipes[swipeIndex] })
        }
    }
    return { kind: 'valid', variants }
}

function occurrenceCount(text: string, needle: string): number {
    if (needle.length === 0) return 0
    let count = 0
    let cursor = 0
    while ((cursor = text.indexOf(needle, cursor)) >= 0) {
        count += 1
        cursor += needle.length
    }
    return count
}

type LoadedJobChat = {
    character: character
    chat: Chat
    chatIndex: number
}

async function loadChatForTarget(chaId: string, conversationId: string): Promise<LoadedJobChat | null> {
    const character = getDatabase().characters.find((candidate) => candidate.chaId === chaId)
    if (!character) return null
    let chatIndex = character.chats.findIndex((chat) => chat?.id === conversationId)
    if (chatIndex < 0) return null
    const chat = await ensureChatHydrated(character.chats, chatIndex, chaId)
    if (!chat || chat.id !== conversationId || chat._placeholder) return null
    chatIndex = character.chats.findIndex((candidate) => candidate?.id === conversationId)
    if (chatIndex < 0 || character.chats[chatIndex] !== chat) return null
    return { character, chat, chatIndex }
}

async function loadJobChat(job: IllustrationJobRecordV1): Promise<LoadedJobChat | null> {
    if (!job.target) return null
    return await loadChatForTarget(job.target.chaId, job.target.conversationId)
}

async function reconcileDurableAssetReference(
    job: IllustrationJobRecordV1,
    epoch: number,
): Promise<'committed' | 'absent' | 'settled'> {
    if (!job.assetId || !job.target) return 'absent'
    const loaded = await loadJobChat(job)
    if (!loaded) return 'absent'
    const variants = logicalVariants(loaded.chat)
    if (variants.kind === 'corrupt') {
        await transitionExecutorJob({
            jobId: job.jobId,
            expectedVersion: job.version,
            to: 'corrupt',
            patch: {
                idempotencyKey: transitionKey(epoch, job, 'invalid-swipes'),
                workerEpoch: epoch,
                error: { code: 'invalid_swipe_state' },
            },
        })
        return 'settled'
    }

    const reference = `{{inlay::${job.assetId}}}`
    const matches = variants.variants.flatMap((variant) => {
        const count = occurrenceCount(variant.text, reference)
        return Array.from({ length: count }, () => variant)
    })
    if (matches.length === 0) return 'absent'
    if (
        matches.length !== 1
        || variants.variants.some((variant) => (
            findSlotNodes(variant.text).some((slot) => slot.slotToken === job.target!.slotToken)
        ))
        || loaded.chat.message[matches[0].messageIndex]?.chatId !== job.target.expectedMessageId
    ) {
        await transitionExecutorJob({
            jobId: job.jobId,
            expectedVersion: job.version,
            to: 'corrupt',
            patch: {
                idempotencyKey: transitionKey(epoch, job, 'duplicate-asset-reference'),
                workerEpoch: epoch,
                error: { code: 'duplicate_asset_reference' },
            },
        })
        return 'settled'
    }

    const siblings = await illustrationJobStore.listJobRecords({ turnId: job.turnId })
    const hash = await computeSourceRevisionHash(matches[0].text, {
        requestNonce: job.target.requestNonce,
        slotTokens: siblings.map((candidate) => candidate.slotToken),
        committedAssetIds: siblings
            .filter((candidate) => (
                candidate.jobId === job.jobId
                || candidate.state === 'committed'
                || candidate.state === 'committing'
            ))
            .flatMap((candidate) => candidate.assetId ? [candidate.assetId] : []),
    })
    if (!hashesMatch(hash, job.sourceRevisionHash)) {
        await transitionExecutorJob({
            jobId: job.jobId,
            expectedVersion: job.version,
            to: 'stale',
            patch: {
                idempotencyKey: transitionKey(epoch, job, 'durable-reference-stale'),
                workerEpoch: epoch,
                error: { code: 'source_hash_mismatch' },
            },
        })
        return 'settled'
    }
    const currentIndex = loaded.character.chats.findIndex(
        (candidate) => candidate?.id === job.target!.conversationId,
    )
    if (currentIndex < 0 || loaded.character.chats[currentIndex] !== loaded.chat) return 'absent'
    await saveChatToServerStrict(
        job.target.chaId,
        currentIndex,
        job.target.conversationId,
        loaded.chat,
    )
    await transitionExecutorJob({
        jobId: job.jobId,
        expectedVersion: job.version,
        to: 'committed',
        patch: {
            idempotencyKey: transitionKey(epoch, job, 'durable-reference-committed'),
            workerEpoch: epoch,
            error: null,
        },
    })
    return 'committed'
}

function applySlotPatch(context: IllustrationJobLiveContext, replacement: string): void {
    const patch = patchSlotInVariant(context.chat, context.resolution, replacement)
    const message: Message | undefined = context.chat.message[patch.messageIndex]
    if (!message) throw new IllustrationLedgerValidationError('Illustration message disappeared before commit')
    if (patch.data !== undefined) message.data = patch.data
    if (patch.swipe) {
        if (!message.swipes || message.swipes[patch.swipe.swipeIndex] === undefined) {
            throw new IllustrationLedgerValidationError('Illustration swipe disappeared before commit')
        }
        message.swipes[patch.swipe.swipeIndex] = patch.swipe.text
    }
}

export async function reconcileIllustrationCommittingJob(
    jobId: string,
    epoch: number,
    trustExistingReference = false,
): Promise<IllustrationJobRecordV1 | null> {
    let job = await illustrationJobStore.getJob(jobId)
    if (!job || job.state !== 'committing' || !job.assetId || !job.target) return job

    if (trustExistingReference) {
        const referenceResult = await reconcileDurableAssetReference(job, epoch)
        if (referenceResult !== 'absent') return await illustrationJobStore.getJob(jobId)
        job = await illustrationJobStore.getJob(jobId)
        if (!job || job.state !== 'committing') return job
    }

    let integrity = await inspectInlayAssetIntegrity(job.assetId)
    if (integrity.status === 'repairable') {
        await repairInlayAssetRecords(job.assetId, {
            charId: job.target.chaId,
            chatId: job.target.conversationId,
        })
        integrity = await inspectInlayAssetIntegrity(job.assetId)
    }
    if (integrity.status !== 'complete') {
        return await transitionExecutorJob({
            jobId,
            expectedVersion: job.version,
            to: 'uncertain',
            patch: {
                idempotencyKey: transitionKey(epoch, job, 'commit-integrity-missing'),
                workerEpoch: epoch,
                error: { code: 'asset_unverifiable', certainty: 'uncertain' },
            },
        })
    }

    const context = await resolveIllustrationJobContext(job)
    if (context.kind !== 'valid') return await settleContextFailure(job, context, epoch)
    const variants = logicalVariants(context.chat)
    if (variants.kind === 'corrupt' || variants.variants.some(
        (variant) => occurrenceCount(variant.text, `{{inlay::${job!.assetId}}}`) > 0,
    )) {
        return await transitionExecutorJob({
            jobId,
            expectedVersion: job.version,
            to: 'corrupt',
            patch: {
                idempotencyKey: transitionKey(epoch, job, 'duplicate-before-commit'),
                workerEpoch: epoch,
                error: { code: 'duplicate_asset_reference' },
            },
        })
    }

    applySlotPatch(context, `{{inlay::${job.assetId}}}`)
    const currentIndex = context.character.chats.findIndex(
        (chat) => chat?.id === job!.target!.conversationId,
    )
    if (currentIndex < 0 || context.character.chats[currentIndex] !== context.chat) {
        throw new IllustrationLedgerValidationError('Illustration conversation moved before commit flush')
    }
    await saveChatToServerStrict(
        job.target.chaId,
        currentIndex,
        job.target.conversationId,
        context.chat,
    )
    return await transitionExecutorJob({
        jobId,
        expectedVersion: job.version,
        to: 'committed',
        patch: {
            idempotencyKey: transitionKey(epoch, job, 'committed'),
            workerEpoch: epoch,
            error: null,
        },
    })
}

export async function commitIllustrationAssetReadyJob(
    jobId: string,
    epoch: number,
    trustExistingReference = false,
): Promise<IllustrationJobRecordV1 | null> {
    let job = await illustrationJobStore.getJob(jobId)
    if (!job || job.state !== 'asset_ready') return job
    if (job.cancelRequestedAt !== undefined) {
        return await cancelExecutorJob({ jobId, expectedVersion: job.version })
    }
    try {
        job = await transitionExecutorJob({
            jobId,
            expectedVersion: job.version,
            to: 'committing',
            patch: {
                idempotencyKey: transitionKey(epoch, job, 'committing'),
                workerEpoch: epoch,
            },
        })
    } catch {
        const winner = await illustrationJobStore.getJob(jobId)
        if (winner?.state === 'cancelled') return winner
        throw new IllustrationLedgerValidationError('Illustration commit CAS lost unexpectedly')
    }
    return await reconcileIllustrationCommittingJob(jobId, epoch, trustExistingReference)
}

// ===========================================================================
// Image Revision V1 execution + commit path (contract §4). A revision child job
// (job.revision present) targets an ALREADY-committed `{{inlay::oldAssetId}}`
// instead of a `{{ph::slotToken}}` placeholder, so it uses a dedicated context
// resolver (find the existing inlay) and a dedicated commit (replace/retain the
// inlay + reference/lineage CAS). It reuses the shared state machine, provider
// dispatch, asset-write, and measurement/config gates. The primary genesis path
// below is intentionally left untouched.
// ===========================================================================

type InlaySpan = { start: number; end: number }

function inlaySpansIn(text: string, token: string): InlaySpan[] {
    const spans: InlaySpan[] = []
    let cursor = 0
    let index = -1
    while ((index = text.indexOf(token, cursor)) >= 0) {
        spans.push({ start: index, end: index + token.length })
        cursor = index + token.length
    }
    return spans
}

type InlayLocation = {
    messageIndex: number
    activeSwipeIndex: number | null
    // 'data-and-active' mirrors message.data (and the active swipe when present);
    // { swipeIndex } is an inactive swipe.
    target: 'data-and-active' | { swipeIndex: number }
    span: InlaySpan
}

type InlayLocateResult =
    | { kind: 'found'; location: InlayLocation }
    | { kind: 'stale' | 'corrupt'; reason: string }

// Mirrors resolveSlotAnchor's logical-variant discipline (active-swipe mirror,
// exactly one logical occurrence) but for a committed `{{inlay::assetId}}` token.
function locateInlay(chat: Chat, expectedMessageId: string, assetId: string): InlayLocateResult {
    const token = `{{inlay::${assetId}}}`
    const indexes: number[] = []
    for (let i = 0; i < chat.message.length; i += 1) {
        if (chat.message[i].chatId === expectedMessageId) indexes.push(i)
    }
    if (indexes.length === 0) return { kind: 'stale', reason: 'message_missing' }
    if (indexes.length > 1) return { kind: 'corrupt', reason: 'message_identity_collision' }
    const messageIndex = indexes[0]
    const message = chat.message[messageIndex]
    const dataSpans = inlaySpansIn(message.data, token)

    if (message.swipes === undefined) {
        if (dataSpans.length === 0) return { kind: 'stale', reason: 'inlay_missing' }
        if (dataSpans.length > 1) return { kind: 'corrupt', reason: 'duplicate_inlay' }
        return {
            kind: 'found',
            location: { messageIndex, activeSwipeIndex: null, target: 'data-and-active', span: dataSpans[0] },
        }
    }
    if (
        message.swipes.length === 0
        || !Number.isSafeInteger(message.swipeId)
        || message.swipeId! < 0
        || message.swipeId! >= message.swipes.length
    ) return { kind: 'corrupt', reason: 'invalid_swipe_state' }
    const activeSwipeIndex = message.swipeId!
    if (message.data !== message.swipes[activeSwipeIndex]) {
        return { kind: 'corrupt', reason: 'active_mirror_desync' }
    }
    const activeSpans = inlaySpansIn(message.swipes[activeSwipeIndex], token)
    const activeHas = dataSpans.length > 0 || activeSpans.length > 0
    if (activeHas && (dataSpans.length !== 1 || activeSpans.length !== 1)) {
        return { kind: 'corrupt', reason: 'duplicate_inlay' }
    }
    const inactive: Array<{ swipeIndex: number; span: InlaySpan }> = []
    for (let s = 0; s < message.swipes.length; s += 1) {
        if (s === activeSwipeIndex) continue
        const spans = inlaySpansIn(message.swipes[s], token)
        if (spans.length > 1) return { kind: 'corrupt', reason: 'duplicate_inlay' }
        if (spans.length === 1) inactive.push({ swipeIndex: s, span: spans[0] })
    }
    const logical = (activeHas ? 1 : 0) + inactive.length
    if (logical === 0) return { kind: 'stale', reason: 'inlay_missing' }
    if (logical > 1) return { kind: 'corrupt', reason: 'multiple_logical_variants' }
    if (activeHas) {
        return {
            kind: 'found',
            location: { messageIndex, activeSwipeIndex, target: 'data-and-active', span: dataSpans[0] },
        }
    }
    return {
        kind: 'found',
        location: {
            messageIndex,
            activeSwipeIndex,
            target: { swipeIndex: inactive[0].swipeIndex },
            span: inactive[0].span,
        },
    }
}

// Splice a new inlay token: replace swaps the located token; retain inserts the
// new token immediately after the located token in the SAME variant.
function spliceInlay(
    chat: Chat,
    location: InlayLocation,
    disposition: 'replace' | 'retain',
    newToken: string,
): void {
    const message = chat.message[location.messageIndex]
    if (!message) throw new IllustrationLedgerValidationError('Illustration message disappeared before revision commit')
    const apply = (text: string): string =>
        disposition === 'replace'
            ? text.slice(0, location.span.start) + newToken + text.slice(location.span.end)
            : text.slice(0, location.span.end) + newToken + text.slice(location.span.end)
    if (location.target === 'data-and-active') {
        const next = apply(message.data)
        message.data = next
        if (location.activeSwipeIndex !== null) {
            if (!message.swipes || message.swipes[location.activeSwipeIndex] === undefined) {
                throw new IllustrationLedgerValidationError('Illustration active swipe disappeared before revision commit')
            }
            message.swipes[location.activeSwipeIndex] = next
        }
    } else {
        const swipeIndex = location.target.swipeIndex
        if (!message.swipes || message.swipes[swipeIndex] === undefined) {
            throw new IllustrationLedgerValidationError('Illustration swipe disappeared before revision commit')
        }
        message.swipes[swipeIndex] = apply(message.swipes[swipeIndex])
    }
}

type RevisionContextResult =
    | { kind: 'valid'; character: character; chat: Chat; chatIndex: number; location: InlayLocation }
    | { kind: 'stale' | 'corrupt'; reason: string }

async function resolveRevisionContext(job: IllustrationJobRecordV1): Promise<RevisionContextResult> {
    if (!job.revision || !job.target) return { kind: 'corrupt', reason: 'revision_target_missing' }
    const loaded = await loadJobChat(job)
    if (!loaded) return { kind: 'stale', reason: 'target_missing' }
    const located = locateInlay(loaded.chat, job.target.expectedMessageId, job.revision.expectedCurrentAssetId)
    if (located.kind !== 'found') return located
    return {
        kind: 'valid',
        character: loaded.character,
        chat: loaded.chat,
        chatIndex: loaded.chatIndex,
        location: located.location,
    }
}

async function settleRevisionContextFailure(
    job: IllustrationJobRecordV1,
    context: Exclude<RevisionContextResult, { kind: 'valid' }>,
    epoch: number,
): Promise<void> {
    // Old image stays: a revision that cannot resolve its target never touches the
    // chat or recharges. generating -> corrupt is not a legal transition, so a
    // corrupt result observed while generating is closed as stale.
    const desired = job.state === 'generating' && context.kind === 'corrupt' ? 'stale' : context.kind
    await transitionExecutorJob({
        jobId: job.jobId,
        expectedVersion: job.version,
        to: desired,
        patch: {
            idempotencyKey: transitionKey(epoch, job, `revision-${desired}`),
            workerEpoch: epoch,
            error: { code: `revision_${context.reason}` },
        },
    })
}

function revisionChargeCertaintyForCommit(): 'charged' {
    // The provider was dispatched and succeeded before the commit path is reached.
    return 'charged'
}

async function reconcileRevisionCommittingJob(
    jobId: string,
    epoch: number,
    trustExistingReference = false,
): Promise<IllustrationJobRecordV1 | null> {
    const job = await illustrationJobStore.getJob(jobId)
    if (!job || job.state !== 'committing' || !job.assetId || !job.target || !job.revision) return job
    const revision = job.revision
    const newAssetId = job.assetId
    const newToken = `{{inlay::${newAssetId}}}`

    let integrity = await inspectInlayAssetIntegrity(newAssetId)
    if (integrity.status === 'repairable') {
        await repairInlayAssetRecords(newAssetId, {
            charId: job.target.chaId,
            chatId: job.target.conversationId,
        })
        integrity = await inspectInlayAssetIntegrity(newAssetId)
    }
    if (integrity.status !== 'complete') {
        return await transitionExecutorJob({
            jobId,
            expectedVersion: job.version,
            to: 'uncertain',
            patch: {
                idempotencyKey: transitionKey(epoch, job, 'revision-commit-integrity-missing'),
                workerEpoch: epoch,
                error: { code: 'asset_unverifiable', certainty: 'uncertain' },
            },
        })
    }

    let childPrompt: IllustrationPromptV1
    try {
        childPrompt = decodeIllustrationStoredPrompt(job.prompt)
    } catch (error) {
        if (!(error instanceof IllustrationImagePromptContractError)) throw error
        return await transitionExecutorJob({
            jobId,
            expectedVersion: job.version,
            to: 'corrupt',
            patch: {
                idempotencyKey: transitionKey(epoch, job, 'revision-commit-prompt-invalid'),
                workerEpoch: epoch,
                error: { code: 'image_prompt_invalid' },
            },
        })
    }

    const loaded = await loadJobChat(job)
    if (!loaded) {
        return await transitionExecutorJob({
            jobId,
            expectedVersion: job.version,
            to: 'stale',
            patch: {
                idempotencyKey: transitionKey(epoch, job, 'revision-commit-target-missing'),
                workerEpoch: epoch,
                error: { code: 'revision_target_missing' },
            },
        })
    }

    // Recovery re-detect: if the new inlay is already durably present, the flush
    // already happened before the crash — finalize the ledger idempotently and
    // mark committed without a second flush or provider charge.
    const variants = logicalVariants(loaded.chat)
    if (variants.kind === 'corrupt') {
        return await transitionExecutorJob({
            jobId,
            expectedVersion: job.version,
            to: 'corrupt',
            patch: {
                idempotencyKey: transitionKey(epoch, job, 'revision-commit-invalid-swipes'),
                workerEpoch: epoch,
                error: { code: 'invalid_swipe_state' },
            },
        })
    }
    const newCount = variants.variants.reduce(
        (total, variant) => total + occurrenceCount(variant.text, newToken), 0,
    )
    if (newCount > 1) {
        return await transitionExecutorJob({
            jobId,
            expectedVersion: job.version,
            to: 'corrupt',
            patch: {
                idempotencyKey: transitionKey(epoch, job, 'revision-commit-duplicate-new'),
                workerEpoch: epoch,
                error: { code: 'duplicate_asset_reference' },
            },
        })
    }
    if (newCount === 1) {
        if (!trustExistingReference) {
            // The new inlay exists but this is not a recovery pass: another writer
            // placed it. Fail closed as corrupt rather than double-splice.
            return await transitionExecutorJob({
                jobId,
                expectedVersion: job.version,
                to: 'corrupt',
                patch: {
                    idempotencyKey: transitionKey(epoch, job, 'revision-commit-unexpected-new'),
                    workerEpoch: epoch,
                    error: { code: 'duplicate_asset_reference' },
                },
            })
        }
        const ledgerResult = await commitRevisionLedger(job, revision, newAssetId, childPrompt)
        if (!ledgerResult.applied) {
            return await transitionExecutorJob({
                jobId,
                expectedVersion: job.version,
                to: 'stale',
                patch: {
                    idempotencyKey: transitionKey(epoch, job, 'revision-commit-recovered-stale'),
                    workerEpoch: epoch,
                    error: { code: 'revision_superseded' },
                },
            })
        }
        return await transitionExecutorJob({
            jobId,
            expectedVersion: job.version,
            to: 'committed',
            patch: {
                idempotencyKey: transitionKey(epoch, job, 'revision-commit-recovered'),
                workerEpoch: epoch,
                error: null,
            },
        })
    }

    // Fresh commit: locate the exact single occurrence of the OLD asset in the
    // target message and CAS the reference before mutating the chat.
    const located = locateInlay(loaded.chat, job.target.expectedMessageId, revision.expectedCurrentAssetId)
    if (located.kind !== 'found') {
        const desired = located.kind
        return await transitionExecutorJob({
            jobId,
            expectedVersion: job.version,
            to: desired,
            patch: {
                idempotencyKey: transitionKey(epoch, job, `revision-commit-${located.reason}`),
                workerEpoch: epoch,
                error: { code: `revision_${located.reason}` },
            },
        })
    }
    if (revision.disposition === 'replace') {
        const pre = await checkReplacePrecondition(revision, newAssetId)
        if (pre === 'stale') {
            return await transitionExecutorJob({
                jobId,
                expectedVersion: job.version,
                to: 'stale',
                patch: {
                    idempotencyKey: transitionKey(epoch, job, 'revision-commit-superseded'),
                    workerEpoch: epoch,
                    error: { code: 'revision_superseded' },
                },
            })
        }
    }

    spliceInlay(loaded.chat, located.location, revision.disposition, newToken)
    const currentIndex = loaded.character.chats.findIndex(
        (candidate) => candidate?.id === job.target!.conversationId,
    )
    if (currentIndex < 0 || loaded.character.chats[currentIndex] !== loaded.chat) {
        throw new IllustrationLedgerValidationError('Illustration conversation moved before revision commit flush')
    }
    await saveChatToServerStrict(job.target.chaId, currentIndex, job.target.conversationId, loaded.chat)

    const ledgerResult = await commitRevisionLedger(job, revision, newAssetId, childPrompt)
    if (!ledgerResult.applied) {
        // The chat was flushed but the reference moved (only reachable via a
        // concurrent restore, out of scope for the serial pump). We cannot confirm
        // consistency, so fail closed to uncertain rather than claim committed.
        return await transitionExecutorJob({
            jobId,
            expectedVersion: job.version,
            to: 'uncertain',
            patch: {
                idempotencyKey: transitionKey(epoch, job, 'revision-commit-ledger-uncertain'),
                workerEpoch: epoch,
                error: { code: 'revision_commit_uncertain', certainty: 'uncertain' },
            },
        })
    }
    return await transitionExecutorJob({
        jobId,
        expectedVersion: job.version,
        to: 'committed',
        patch: {
            idempotencyKey: transitionKey(epoch, job, 'revision-committed'),
            workerEpoch: epoch,
            error: null,
        },
    })
}

async function commitRevisionLedger(
    job: IllustrationJobRecordV1,
    revision: IllustrationJobRevisionDescriptorV1,
    newAssetId: string,
    childPrompt: IllustrationPromptV1,
): Promise<RevisionCommitResult> {
    const input = {
        revision,
        childJobId: job.jobId,
        newAssetId,
        childPrompt,
        chargeCertainty: revisionChargeCertaintyForCommit(),
    }
    return revision.disposition === 'replace'
        ? await commitReplaceReference(input)
        : await commitRetainFork(input)
}

export async function commitRevisionAssetReadyJob(
    jobId: string,
    epoch: number,
    trustExistingReference = false,
): Promise<IllustrationJobRecordV1 | null> {
    let job = await illustrationJobStore.getJob(jobId)
    if (!job || job.state !== 'asset_ready' || !job.revision) return job
    if (job.cancelRequestedAt !== undefined) {
        return await cancelExecutorJob({ jobId, expectedVersion: job.version })
    }
    try {
        job = await transitionExecutorJob({
            jobId,
            expectedVersion: job.version,
            to: 'committing',
            patch: {
                idempotencyKey: transitionKey(epoch, job, 'revision-committing'),
                workerEpoch: epoch,
            },
        })
    } catch {
        const winner = await illustrationJobStore.getJob(jobId)
        if (winner?.state === 'cancelled') return winner
        throw new IllustrationLedgerValidationError('Illustration revision commit CAS lost unexpectedly')
    }
    return await reconcileRevisionCommittingJob(jobId, epoch, trustExistingReference)
}

async function processQueuedRevisionJob(job: IllustrationJobRecordV1, epoch: number): Promise<void> {
    if (!(await isIllustrationFeatureEnabled())) return
    if (!job.revision) return
    let context = await resolveRevisionContext(job)
    if (context.kind !== 'valid') {
        await settleRevisionContextFailure(job, context, epoch)
        return
    }

    let dispatchPrompt: IllustrationPromptV1
    try {
        dispatchPrompt = decodeIllustrationStoredPrompt(job.prompt)
    } catch (error) {
        if (!(error instanceof IllustrationImagePromptContractError)) throw error
        await settleImagePromptGateFailure(job, epoch, error, 'revision-prompt-invalid')
        return
    }

    // exact-prompt drift and unsupported provider route through the shared
    // blocked_config recovery flow (§4.1).
    const configurationBlock = await resolveDispatchConfigurationBlock(job)
    if (configurationBlock) {
        await settleDispatchConfigurationBlock(job, epoch, configurationBlock, 'revision-blocked-config')
        return
    }

    const coldGate = await runImagePromptGate(job, dispatchPrompt)
    let latest = await illustrationJobStore.getJob(job.jobId)
    if (!latest || latest.state !== 'queued') return
    context = await resolveRevisionContext(latest)
    if (context.kind !== 'valid') {
        await settleRevisionContextFailure(latest, context, epoch)
        return
    }
    if (coldGate.ok === false) {
        await settleImagePromptGateFailure(latest, epoch, coldGate.error, `revision-prompt-${coldGate.error.code}`)
        return
    }
    job = latest

    const attemptId = job.attemptId ?? freshAttemptId()
    const assetId = await deriveIllustrationAssetId(job.jobId, attemptId)
    const generating = await transitionPreDispatchJob(job, 'generating', {
        idempotencyKey: `worker:${epoch}:${job.jobId}:${attemptId}:generating`,
        workerEpoch: epoch,
        attemptId,
        assetId,
        error: null,
    })
    if (!generating) return

    const dispatchRecord = await illustrationJobStore.getJob(job.jobId)
    if (!dispatchRecord
        || dispatchRecord.attemptId !== generating.attemptId
        || dispatchRecord.assetId !== generating.assetId) return
    if (dispatchRecord.state === 'cancel_requested') {
        await transitionExecutorJob({
            jobId: dispatchRecord.jobId,
            expectedVersion: dispatchRecord.version,
            to: 'cancelled',
            patch: {
                idempotencyKey: transitionKey(epoch, dispatchRecord, 'revision-cancelled-before-dispatch'),
                workerEpoch: epoch,
                error: null,
            },
        })
        return
    }
    if (dispatchRecord.state !== 'generating') return
    const dispatchContext = await resolveRevisionContext(dispatchRecord)
    if (dispatchContext.kind !== 'valid') {
        await settleRevisionContextFailure(dispatchRecord, dispatchContext, epoch)
        return
    }

    // Final measurement gate after entering the provider-intent state.
    const finalGate = await runImagePromptGate(dispatchRecord, dispatchPrompt)
    const finalLatest = await illustrationJobStore.getJob(dispatchRecord.jobId)
    if (!finalLatest) return
    if (finalLatest.state === 'cancel_requested') {
        await transitionExecutorJob({
            jobId: finalLatest.jobId,
            expectedVersion: finalLatest.version,
            to: 'cancelled',
            patch: {
                idempotencyKey: transitionKey(epoch, finalLatest, 'revision-cancelled-final-measurement'),
                workerEpoch: epoch,
                error: null,
            },
        })
        return
    }
    if (finalLatest.state !== 'generating') return
    const finalContext = await resolveRevisionContext(finalLatest)
    if (finalContext.kind !== 'valid') {
        await settleRevisionContextFailure(finalLatest, finalContext, epoch)
        return
    }
    if (finalGate.ok === false) {
        await settleImagePromptGateFailure(
            finalLatest,
            epoch,
            finalGate.error,
            `revision-prompt-final-${finalGate.error.code}`,
        )
        return
    }
    if (currentNaiSettingsSnapshot() !== finalGate.settingsSnapshot) {
        await settleImagePromptGateFailure(
            finalLatest,
            epoch,
            new IllustrationImagePromptContractError(
                'settings_fingerprint_mismatch',
                'The image settings changed after the final revision prompt measurement',
            ),
            'revision-prompt-final-settings-drift',
        )
        return
    }

    const attempt = await generateAIImageTyped(
        dispatchPrompt.basePositive,
        finalContext.character,
        dispatchPrompt.baseNegative,
        'inlay',
        'background',
        { preservePromptText: true, illustrationPrompt: dispatchPrompt },
    )
    if (attempt.result.ok === false) {
        await transitionProviderFailure(job.jobId, epoch, attempt.result.certainty)
        return
    }

    let writing = await illustrationJobStore.getJob(job.jobId)
    for (;;) {
        if (
            !writing
            || writing.attemptId !== generating.attemptId
            || writing.assetId !== generating.assetId
            || (writing.state !== 'generating' && writing.state !== 'cancel_requested')
        ) return
        try {
            writing = await transitionExecutorJob({
                jobId: job.jobId,
                expectedVersion: writing.version,
                to: 'asset_writing',
                patch: {
                    idempotencyKey: transitionKey(epoch, writing, 'revision-asset-writing'),
                    workerEpoch: epoch,
                },
            })
            break
        } catch (error) {
            if (!(error instanceof IllustrationLedgerVersionConflictError)) throw error
            writing = await illustrationJobStore.getJob(job.jobId)
        }
    }

    try {
        const image = new Image()
        image.src = attempt.result.bytesOrDataUrl
        await writeInlayImage(image, {
            id: assetId,
            target: { charId: job.target!.chaId, chatId: job.target!.conversationId },
            decodeTimeoutMs: ILLUSTRATION_IMAGE_DECODE_TIMEOUT_MS,
        })
        const written = await inspectInlayAssetIntegrity(assetId)
        if (written.status !== 'complete') throw new Error('asset integrity incomplete')
    } catch {
        let latestWriting = await illustrationJobStore.getJob(job.jobId)
        for (;;) {
            if (
                !latestWriting
                || latestWriting.state !== 'asset_writing'
                || latestWriting.attemptId !== generating.attemptId
                || latestWriting.assetId !== generating.assetId
            ) return
            try {
                await transitionExecutorJob({
                    jobId: job.jobId,
                    expectedVersion: latestWriting.version,
                    to: 'uncertain',
                    patch: {
                        idempotencyKey: transitionKey(epoch, latestWriting, 'revision-asset-write-uncertain'),
                        workerEpoch: epoch,
                        error: { code: 'asset_write_uncertain', certainty: 'uncertain' },
                    },
                })
                return
            } catch (error) {
                if (!(error instanceof IllustrationLedgerVersionConflictError)) throw error
                latestWriting = await illustrationJobStore.getJob(job.jobId)
            }
        }
    }

    let ready = await illustrationJobStore.getJob(job.jobId)
    for (;;) {
        if (
            !ready
            || ready.state !== 'asset_writing'
            || ready.attemptId !== generating.attemptId
            || ready.assetId !== generating.assetId
        ) return
        try {
            ready = await transitionExecutorJob({
                jobId: job.jobId,
                expectedVersion: ready.version,
                to: 'asset_ready',
                patch: {
                    idempotencyKey: transitionKey(epoch, ready, 'revision-asset-ready'),
                    workerEpoch: epoch,
                },
            })
            break
        } catch (error) {
            if (!(error instanceof IllustrationLedgerVersionConflictError)) throw error
            ready = await illustrationJobStore.getJob(job.jobId)
        }
    }
    ready = (await illustrationJobStore.getJob(job.jobId)) ?? ready
    if (ready.cancelRequestedAt !== undefined) {
        await cancelExecutorJob({ jobId: job.jobId, expectedVersion: ready.version })
        return
    }
    await commitRevisionAssetReadyJob(job.jobId, epoch)
}

async function resumeRevisionBlockedConfig(
    job: IllustrationJobRecordV1,
    epoch: number,
): Promise<boolean> {
    const database = getDatabase()
    if (database.sdProvider !== 'novelai') return false
    if ((await computeNaiSettingsFingerprint(database)) !== job.settingsFingerprint) return false
    const context = await resolveRevisionContext(job)
    if (context.kind !== 'valid') {
        await settleRevisionContextFailure(job, context, epoch)
        return true
    }
    await transitionPreDispatchJob(job, 'queued', {
        idempotencyKey: transitionKey(epoch, job, 'revision-resume-config'),
        workerEpoch: epoch,
        error: null,
    })
    return true
}

// Recovery entry point for a revision child in the dispatch/commit pipeline. The
// live pump handles queued/blocked_config; this handles a crash mid-generation.
export async function recoverRevisionJob(job: IllustrationJobRecordV1, epoch: number): Promise<void> {
    if (!job.revision) return
    if (job.cancelRequestedAt !== undefined
        && ['prepared', 'awaiting_prompt', 'prompt_ready', 'queued', 'blocked_config', 'asset_ready'].includes(job.state)) {
        await illustrationJobStore.requestCancel({ jobId: job.jobId, expectedVersion: job.version })
        return
    }
    if (job.state === 'committing') {
        await reconcileRevisionCommittingJob(job.jobId, epoch, true)
        return
    }
    if (['generating', 'cancel_requested', 'asset_writing', 'asset_ready'].includes(job.state)) {
        // Verify the written asset; a missing/unverifiable asset closes uncertain.
        if (!job.assetId) {
            await transitionExecutorJob({
                jobId: job.jobId,
                expectedVersion: job.version,
                to: 'uncertain',
                patch: {
                    idempotencyKey: transitionKey(epoch, job, 'revision-recover-no-asset'),
                    workerEpoch: epoch,
                    error: { code: 'asset_unverifiable', certainty: 'uncertain' },
                },
            })
            return
        }
        let integrity = await inspectInlayAssetIntegrity(job.assetId)
        if (integrity.status === 'repairable' && job.target) {
            await repairInlayAssetRecords(job.assetId, {
                charId: job.target.chaId,
                chatId: job.target.conversationId,
            })
            integrity = await inspectInlayAssetIntegrity(job.assetId)
        }
        if (integrity.status !== 'complete') {
            await transitionExecutorJob({
                jobId: job.jobId,
                expectedVersion: job.version,
                to: 'uncertain',
                patch: {
                    idempotencyKey: transitionKey(epoch, job, 'revision-recover-unverifiable'),
                    workerEpoch: epoch,
                    error: { code: 'asset_unverifiable', certainty: 'uncertain' },
                },
            })
            return
        }
        let current: IllustrationJobRecordV1 | null = job
        if (current.state === 'generating' || current.state === 'cancel_requested') {
            current = await transitionExecutorJob({
                jobId: job.jobId,
                expectedVersion: current.version,
                to: 'asset_writing',
                patch: {
                    idempotencyKey: transitionKey(epoch, current, 'revision-recover-asset-writing'),
                    workerEpoch: epoch,
                },
            })
        }
        if (current && current.state === 'asset_writing') {
            current = await transitionExecutorJob({
                jobId: job.jobId,
                expectedVersion: current.version,
                to: 'asset_ready',
                patch: {
                    idempotencyKey: transitionKey(epoch, current, 'revision-recover-asset-ready'),
                    workerEpoch: epoch,
                },
            })
        }
        current = (await illustrationJobStore.getJob(job.jobId)) ?? current
        if (!current || current.state !== 'asset_ready') return
        if (current.cancelRequestedAt !== undefined) {
            await illustrationJobStore.requestCancel({ jobId: current.jobId, expectedVersion: current.version })
            return
        }
        await commitRevisionAssetReadyJob(job.jobId, epoch, true)
    }
}

// The chat-side of a no-charge restore: swap the currently displayed inlay for the
// restored asset's inlay. Returns the outcome for the ledger commit decision.
export async function applyRestoreInlaySwap(
    reference: IllustrationImageReferenceRecordV1,
    restoredAssetId: string,
): Promise<'ok' | 'noop' | 'stale' | 'corrupt'> {
    return await swapDisplayedInlayAsset(reference.target, reference.currentAssetId, restoredAssetId)
}

// Revert a restore whose ledger CAS was lost after the chat was already flushed:
// swap the displayed (would-be-restored) asset back to the ledger's authoritative
// current asset, so chat and ledger stay consistent (§4.2 version-conflict: the
// existing image keeps showing, no re-charge). Returns the swap outcome; callers
// treat any non-'ok' result as "chat already consistent or unrecoverable".
export async function revertRestoreInlaySwap(
    reference: IllustrationImageReferenceRecordV1,
    displayedAssetId: string,
): Promise<'ok' | 'noop' | 'stale' | 'corrupt'> {
    return await swapDisplayedInlayAsset(reference.target, displayedAssetId, reference.currentAssetId)
}

// Shared inlay re-point: replace the single occurrence of `fromAssetId` with
// `toAssetId` in the target message, failing closed if `toAssetId` is already
// present (would duplicate) or the source occurrence is missing/ambiguous.
async function swapDisplayedInlayAsset(
    target: IllustrationImageReferenceRecordV1['target'],
    fromAssetId: string,
    toAssetId: string,
): Promise<'ok' | 'noop' | 'stale' | 'corrupt'> {
    if (fromAssetId === toAssetId) return 'noop'
    const loaded = await loadChatForTarget(target.chaId, target.conversationId)
    if (!loaded) return 'stale'
    // The destination asset must not already be present (would duplicate).
    const variants = logicalVariants(loaded.chat)
    if (variants.kind === 'corrupt') return 'corrupt'
    const toToken = `{{inlay::${toAssetId}}}`
    if (variants.variants.some((variant) => occurrenceCount(variant.text, toToken) > 0)) {
        return 'corrupt'
    }
    const located = locateInlay(loaded.chat, target.expectedMessageId, fromAssetId)
    if (located.kind !== 'found') return located.kind
    spliceInlay(loaded.chat, located.location, 'replace', toToken)
    const currentIndex = loaded.character.chats.findIndex(
        (candidate) => candidate?.id === target.conversationId,
    )
    if (currentIndex < 0 || loaded.character.chats[currentIndex] !== loaded.chat) return 'stale'
    await saveChatToServerStrict(
        target.chaId,
        currentIndex,
        target.conversationId,
        loaded.chat,
    )
    return 'ok'
}

async function processQueuedJob(job: IllustrationJobRecordV1, epoch: number): Promise<void> {
    // Prompt Target V2 (request §D2): a job carrying a durable V2 envelope takes the
    // provider-neutral V2 dispatch path. This is the ONLY branch added to the V1
    // executor — everything below is the byte-identical V1 (incl. NAI genesis) path and
    // a V1 job never reaches the V2 modules (broker/serializer/transport dispatch).
    if (job.promptEnvelope) {
        await processQueuedV2Job(job, epoch)
        return
    }
    if (!(await isIllustrationFeatureEnabled())) return
    let context = await resolveIllustrationJobContext(job)
    if (context.kind !== 'valid') {
        await settleContextFailure(job, context, epoch)
        return
    }

    const physicalLegacyPrompt = isLegacyIllustrationStoredPrompt(job.prompt)
    let dispatchPrompt: IllustrationPromptV1
    try {
        dispatchPrompt = decodeIllustrationStoredPrompt(job.prompt)
    } catch (error) {
        if (!(error instanceof IllustrationImagePromptContractError)) throw error
        await settleImagePromptGateFailure(job, epoch, error, 'prompt-invalid')
        return
    }

    // §10.2 configuration recovery precedes the additive measurement contract
    // for both structured and physical legacy records.
    const configurationBlock = await resolveDispatchConfigurationBlock(job)
    if (configurationBlock) {
        await settleDispatchConfigurationBlock(job, epoch, configurationBlock, 'blocked-config')
        return
    }

    if (!physicalLegacyPrompt) {
        // Cold-load while queued. A crash here cannot be mistaken for an
        // ambiguous provider dispatch during recovery.
        const coldGate = await runImagePromptGate(job, dispatchPrompt)
        const latest = await illustrationJobStore.getJob(job.jobId)
        if (!latest || latest.state !== 'queued') return
        context = await resolveIllustrationJobContext(latest)
        if (context.kind !== 'valid') {
            await settleContextFailure(latest, context, epoch)
            return
        }
        if (coldGate.ok === false) {
            await settleImagePromptGateFailure(
                latest,
                epoch,
                coldGate.error,
                `prompt-contract-${coldGate.error.code}`,
            )
            return
        }
        job = latest
    }

    const attemptId = job.attemptId ?? freshAttemptId()
    const assetId = await deriveIllustrationAssetId(job.jobId, attemptId)
    let generating = await transitionPreDispatchJob(job, 'generating', {
        idempotencyKey: `worker:${epoch}:${job.jobId}:${attemptId}:generating`,
        workerEpoch: epoch,
        attemptId,
        assetId,
        error: null,
    })
    if (!generating) return

    const dispatchRecord = await illustrationJobStore.getJob(job.jobId)
    if (!dispatchRecord
        || dispatchRecord.attemptId !== generating.attemptId
        || dispatchRecord.assetId !== generating.assetId) return
    if (dispatchRecord.state === 'cancel_requested') {
        await transitionExecutorJob({
            jobId: dispatchRecord.jobId,
            expectedVersion: dispatchRecord.version,
            to: 'cancelled',
            patch: {
                idempotencyKey: transitionKey(epoch, dispatchRecord, 'cancelled-before-dispatch'),
                workerEpoch: epoch,
                error: null,
            },
        })
        return
    }
    if (dispatchRecord.state !== 'generating') return
    let dispatchContext = await resolveIllustrationJobContext(dispatchRecord)
    if (dispatchContext.kind !== 'valid') {
        if (dispatchContext.kind === 'stale') {
            await settleContextFailure(dispatchRecord, dispatchContext, epoch)
        } else {
            await transitionExecutorJob({
                jobId: dispatchRecord.jobId,
                expectedVersion: dispatchRecord.version,
                to: 'stale',
                patch: {
                    idempotencyKey: transitionKey(epoch, dispatchRecord, 'pre-provider-corrupt'),
                    workerEpoch: epoch,
                    error: { code: `pre_provider_${dispatchContext.reason}` },
                },
            })
        }
        return
    }
    generating = dispatchRecord

    if (!physicalLegacyPrompt) {
        // The queued pass loads the tokenizer safely; this cached pass repeats
        // the exact measurement after entering the provider-intent state.
        const finalGate = await runImagePromptGate(generating, dispatchPrompt)
        const finalContext = await resolveIllustrationJobContext(generating)
        const finalLatest = await illustrationJobStore.getJob(generating.jobId)
        if (!finalLatest) return
        if (finalLatest.state === 'cancel_requested') {
            await transitionExecutorJob({
                jobId: finalLatest.jobId,
                expectedVersion: finalLatest.version,
                to: 'cancelled',
                patch: {
                    idempotencyKey: transitionKey(epoch, finalLatest, 'cancelled-final-measurement'),
                    workerEpoch: epoch,
                    error: null,
                },
            })
            return
        }
        if (finalLatest.state !== 'generating') return
        if (finalContext.kind !== 'valid') {
            if (finalContext.kind === 'stale') {
                await settleContextFailure(finalLatest, finalContext, epoch)
            } else {
                await transitionExecutorJob({
                    jobId: finalLatest.jobId,
                    expectedVersion: finalLatest.version,
                    to: 'stale',
                    patch: {
                        idempotencyKey: transitionKey(epoch, finalLatest, 'final-pre-provider-corrupt'),
                        workerEpoch: epoch,
                        error: { code: `pre_provider_${finalContext.reason}` },
                    },
                })
            }
            return
        }
        if (!isIllustrationJobLiveContextCurrent(finalLatest, finalContext)) {
            await transitionExecutorJob({
                jobId: finalLatest.jobId,
                expectedVersion: finalLatest.version,
                to: 'stale',
                patch: {
                    idempotencyKey: transitionKey(epoch, finalLatest, 'final-context-changed'),
                    workerEpoch: epoch,
                    error: { code: 'pre_provider_context_changed' },
                },
            })
            return
        }
        if (finalGate.ok === false) {
            await settleImagePromptGateFailure(
                finalLatest,
                epoch,
                finalGate.error,
                `prompt-contract-final-${finalGate.error.code}`,
            )
            return
        }
        if (currentNaiSettingsSnapshot() !== finalGate.settingsSnapshot) {
            await settleImagePromptGateFailure(
                finalLatest,
                epoch,
                new IllustrationImagePromptContractError(
                    'settings_fingerprint_mismatch',
                    'The image settings changed after the final prompt measurement',
                ),
                'prompt-contract-final-settings-drift',
            )
            return
        }
        generating = finalLatest
        dispatchContext = finalContext

        // Measurement, hydration, and the final durable read are all async.
        // Cancellation and context guards win their races before contract
        // settlement; the synchronous settings guard then closes the last gap.
    }

    const attempt = await generateAIImageTyped(
        dispatchPrompt.basePositive,
        dispatchContext.character,
        dispatchPrompt.baseNegative,
        'inlay',
        'background',
        { preservePromptText: true, illustrationPrompt: dispatchPrompt },
    )
    if (attempt.result.ok === false) {
        await transitionProviderFailure(job.jobId, epoch, attempt.result.certainty)
        return
    }

    let latest = await illustrationJobStore.getJob(job.jobId)
    if (!latest || (latest.state !== 'generating' && latest.state !== 'cancel_requested')) return
    if (latest.state === 'generating') {
        const returnedContext = await resolveIllustrationJobContext(latest)
        if (returnedContext.kind !== 'valid') {
            if (returnedContext.kind === 'stale') {
                await settleContextFailure(latest, returnedContext, epoch)
            } else {
                await transitionExecutorJob({
                    jobId: latest.jobId,
                    expectedVersion: latest.version,
                    to: 'stale',
                    patch: {
                        idempotencyKey: transitionKey(epoch, latest, 'post-provider-corrupt'),
                        workerEpoch: epoch,
                        error: { code: `post_provider_${returnedContext.reason}` },
                    },
                })
            }
            return
        }
    }
    for (;;) {
        if (
            latest.attemptId !== generating.attemptId
            || latest.assetId !== generating.assetId
            || (latest.state !== 'generating' && latest.state !== 'cancel_requested')
        ) return
        try {
            generating = await transitionExecutorJob({
                jobId: job.jobId,
                expectedVersion: latest.version,
                to: 'asset_writing',
                patch: {
                    idempotencyKey: transitionKey(epoch, latest, 'asset-writing'),
                    workerEpoch: epoch,
                },
            })
            break
        } catch (error) {
            if (!(error instanceof IllustrationLedgerVersionConflictError)) throw error
            const winner = await illustrationJobStore.getJob(job.jobId)
            if (!winner) return
            latest = winner
        }
    }

    try {
        const image = new Image()
        image.src = attempt.result.bytesOrDataUrl
        await writeInlayImage(image, {
            id: assetId,
            target: { charId: job.target!.chaId, chatId: job.target!.conversationId },
            decodeTimeoutMs: ILLUSTRATION_IMAGE_DECODE_TIMEOUT_MS,
        })
        const integrity = await inspectInlayAssetIntegrity(assetId)
        if (integrity.status !== 'complete') throw new Error('asset integrity incomplete')
    } catch {
        let latestWriting = await illustrationJobStore.getJob(job.jobId)
        for (;;) {
            if (
                !latestWriting
                || latestWriting.state !== 'asset_writing'
                || latestWriting.attemptId !== generating.attemptId
                || latestWriting.assetId !== generating.assetId
            ) return
            try {
                await transitionExecutorJob({
                    jobId: job.jobId,
                    expectedVersion: latestWriting.version,
                    to: 'uncertain',
                    patch: {
                        idempotencyKey: transitionKey(epoch, latestWriting, 'asset-write-uncertain'),
                        workerEpoch: epoch,
                        error: { code: 'asset_write_uncertain', certainty: 'uncertain' },
                    },
                })
                return
            } catch (error) {
                if (!(error instanceof IllustrationLedgerVersionConflictError)) throw error
                latestWriting = await illustrationJobStore.getJob(job.jobId)
            }
        }
    }

    let latestWriting = await illustrationJobStore.getJob(job.jobId)
    let ready: IllustrationJobRecordV1
    for (;;) {
        if (
            !latestWriting
            || latestWriting.state !== 'asset_writing'
            || latestWriting.attemptId !== generating.attemptId
            || latestWriting.assetId !== generating.assetId
        ) return
        try {
            ready = await transitionExecutorJob({
                jobId: job.jobId,
                expectedVersion: latestWriting.version,
                to: 'asset_ready',
                patch: {
                    idempotencyKey: transitionKey(epoch, latestWriting, 'asset-ready'),
                    workerEpoch: epoch,
                },
            })
            break
        } catch (error) {
            if (!(error instanceof IllustrationLedgerVersionConflictError)) throw error
            latestWriting = await illustrationJobStore.getJob(job.jobId)
        }
    }
    ready = (await illustrationJobStore.getJob(job.jobId)) ?? ready
    if (ready.cancelRequestedAt !== undefined) {
        await cancelExecutorJob({ jobId: job.jobId, expectedVersion: ready.version })
        return
    }
    await commitIllustrationAssetReadyJob(job.jobId, epoch)
}

// ---------------------------------------------------------------------------
// Prompt Target V2 dispatch (request §D2/§D3/§7/§8).
//
// A queued job carrying a durable V2 envelope re-resolves + re-verifies its CAPTURED
// target against the CURRENT config (fingerprint drift => blocked_config, provider-
// call-0), live-probes a webui probe-and-revalidate checkpoint, re-binds the receipt
// (dispatch-ineligible / cross-target reuse => provider-call-0), acquires the provider-
// wide broker slot for the captured concurrency key (current policy of that key), then
// serializes + dispatches over the same redacted global-fetch conventions the V1 path
// uses. novelai-native reuses the byte-identical NAI genesis dispatch (native captions
// + server-side risu-image-class marking); the three flat transports use the transport
// dispatch builders. Socket/timeout => uncertain, never auto-duplicated. The generated
// asset is handed to the same asset-write/commit machinery the V1 path uses (replicated
// in writeAndCommitV2ProviderImage so the V1 tail stays byte-identical).
// ---------------------------------------------------------------------------

// Injectable transport I/O so the exact wire body + certainty are unit-testable without
// a live provider (mirrors the worker-lock-manager accessor pattern).
export type IllustrationV2TransportFetchers = {
    // JSON-decoding POST (webui /txt2img, comfy /prompt).
    fetchImpl: TransportFetch
    // Raw-bytes POST (nai-compatible ZIP body).
    rawFetchImpl: TransportFetch
    // Raw GET (comfy /history + /view).
    nativeFetchImpl: TransportNativeFetch
}

let v2TransportFetchersOverride: IllustrationV2TransportFetchers | null = null

export function setIllustrationV2TransportFetchersForTests(
    fetchers: IllustrationV2TransportFetchers,
): () => void {
    const previous = v2TransportFetchersOverride
    v2TransportFetchersOverride = fetchers
    return () => {
        v2TransportFetchersOverride = previous
    }
}

export function resetIllustrationV2TransportFetchersForTests(): void {
    v2TransportFetchersOverride = null
}

async function getV2TransportFetchers(): Promise<IllustrationV2TransportFetchers> {
    if (v2TransportFetchersOverride) return v2TransportFetchersOverride
    // Lazily imported so the executor's static graph is unchanged and the default only
    // resolves the real global-fetch when a live V2 dispatch actually runs.
    const { globalFetch, fetchNative } = await import('../../globalApi.svelte')
    const post = (raw: boolean): TransportFetch => async (url, arg) => {
        const response = await globalFetch(url, {
            method: arg.method ?? 'POST',
            body: arg.body,
            headers: arg.headers,
            plainFetchDeforce: arg.plainFetchDeforce,
            redactRequestLog: arg.redactRequestLog,
            proxyRequestHeaders: arg.proxyRequestHeaders,
            abortSignal: arg.abortSignal,
            rawResponse: raw,
        })
        return { ok: response.ok, data: response.data, headers: response.headers ?? {}, status: response.status }
    }
    const nativeFetchImpl: TransportNativeFetch = async (url, arg) => await fetchNative(url, {
        method: arg.method ?? 'GET',
        headers: arg.headers,
        body: arg.body as string | Uint8Array | ArrayBuffer | undefined,
        signal: arg.abortSignal,
    })
    return { fetchImpl: post(false), rawFetchImpl: post(true), nativeFetchImpl }
}

function webuiDispatchParamsFromDb(db: ReturnType<typeof getDatabase>): WebuiDispatchParams {
    const config = db.sdConfig
    return {
        width: config.width,
        height: config.height,
        steps: db.sdSteps,
        cfgScale: db.sdCFG,
        samplerName: config.sampler_name,
        enableHr: config.enable_hr,
        denoisingStrength: config.denoising_strength,
        hrScale: config.hr_scale,
        hrUpscaler: config.hr_upscaler,
    }
}

// nai-compatible responses are NAI-shaped ZIPs (the same envelope stableDiff unpacks
// via processZip); dispatchNaiCompatibleFlat re-adds the data-url prefix, so we return
// just the base64 payload.
async function extractNaiZipImage(data: unknown): Promise<string | null> {
    if (!(data instanceof Uint8Array)) return null
    const { processZip } = await import('../processzip')
    const dataUrl = await processZip(data)
    const comma = dataUrl.indexOf(',')
    return comma >= 0 ? dataUrl.slice(comma + 1) : null
}

async function dispatchIllustrationEnvelopeV2(
    target: IllustrationPromptTargetV2,
    transportConfig: IllustrationTransportConfigV1,
    envelope: IllustrationPromptEnvelopeV2,
    dispatchCharacter: character,
    priorityClass: ImageGenerationPriority,
): Promise<ImageGenerationResult> {
    const db = getDatabase()
    if (target.transportId === 'novelai-native') {
        // Reuse the byte-identical NAI genesis dispatch (native structured captions +
        // server-side risu-image-class marking) — never a flat transport builder.
        const prompt = envelopeToPromptV1(envelope)
        const attempt = await generateAIImageTyped(
            prompt.basePositive,
            dispatchCharacter,
            prompt.baseNegative,
            'inlay',
            priorityClass,
            { preservePromptText: true, illustrationPrompt: prompt },
        )
        return attempt.result
    }

    // flat / pipe-slots serialize to exact positive/negative transport text.
    const serialized = serializeEnvelopeForTransport(envelope, target)
    const fetchers = await getV2TransportFetchers()
    const election = transportConfig.election

    if (target.transportId === 'webui-flat') {
        const pinnedCheckpoint = election?.transportId === 'webui-flat' && election.binding.mode === 'request-pinned'
            ? election.binding.checkpoint
            : null
        return await dispatchWebuiFlat({
            target,
            endpoint: db.webUiUrl,
            positive: serialized.positive,
            negative: serialized.negative,
            params: webuiDispatchParamsFromDb(db),
            pinnedCheckpoint,
            fetchImpl: fetchers.fetchImpl,
            priorityClass,
        })
    }

    if (target.transportId === 'nai-compatible-flat') {
        return await dispatchNaiCompatibleFlat({
            target,
            endpoint: db.NAIImgUrl ?? DEFAULT_NAI_ENDPOINT,
            positive: serialized.positive,
            negative: serialized.negative,
            modelId: db.NAIImgModel ?? null,
            apiKey: db.NAIApiKey ?? '',
            fetchImpl: fetchers.rawFetchImpl,
            priorityClass,
            extractImage: extractNaiZipImage,
        })
    }

    if (target.transportId === 'comfyui-flat') {
        if (election?.transportId !== 'comfyui-flat') {
            return { ok: false, certainty: 'definite', reason: 'comfyui-flat dispatch is missing its node-binding election' }
        }
        const timeoutSeconds = typeof db.comfyConfig?.timeout === 'number' ? db.comfyConfig.timeout : 60
        return await dispatchComfyuiFlat({
            target,
            endpoint: db.comfyUiUrl,
            positive: serialized.positive,
            negative: serialized.negative,
            workflowJson: db.comfyConfig?.workflow ?? '',
            positiveNode: election.positiveNode,
            negativeNode: election.negativeNode,
            fetchImpl: fetchers.fetchImpl,
            nativeFetchImpl: fetchers.nativeFetchImpl,
            timeoutMs: timeoutSeconds * 1000,
            now: () => Date.now(),
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        })
    }

    return { ok: false, certainty: 'definite', reason: `unsupported V2 transport "${target.transportId}"` }
}

type V2DispatchGate =
    | { kind: 'ready'; target: IllustrationPromptTargetV2; transportConfig: IllustrationTransportConfigV1 }
    | { kind: 'drift'; code: DispatchConfigurationBlockCode }
    | { kind: 'rebind'; error: IllustrationPromptV2ContractError }

// Re-resolve the captured target against the CURRENT db + transport election, verify the
// fingerprint still matches, live-probe a webui probe-and-revalidate checkpoint, and
// re-bind the receipt to the current target + envelope. Any drift/probe failure is a
// definite blocked_config (provider-call-0); a receipt-binding failure is a definite
// failed (provider-call-0). Queue tuning alone never changes the fingerprint (§20).
async function evaluateV2DispatchGate(
    job: IllustrationJobRecordV1,
    envelope: IllustrationPromptEnvelopeV2,
    receipt: IllustrationPromptMeasurementReceiptV2,
): Promise<V2DispatchGate> {
    const turn = await illustrationJobStore.getTurn(job.turnId)
    const captured = turn?.promptContext?.target.targetFingerprint
    if (!captured) return { kind: 'drift', code: 'prompt_target_unavailable' }

    let transportConfig: IllustrationTransportConfigV1
    let target: IllustrationPromptTargetV2
    try {
        transportConfig = await readStoredTransportConfig()
        target = await resolvePromptTargetV2(getDatabase(), transportConfig)
    } catch {
        // The captured transport no longer resolves (endpoint/provider/election gone).
        return { kind: 'drift', code: 'prompt_target_unavailable' }
    }
    if (target.targetFingerprint !== captured) {
        return { kind: 'drift', code: 'prompt_target_fingerprint_mismatch' }
    }
    // Carried gap 1 (request §7.3): live-probe a webui probe-and-revalidate checkpoint at
    // DISPATCH; probe failure / checkpoint drift => blocked_config, provider-call-0.
    try {
        await verifyWebuiCheckpointBinding(getDatabase().webUiUrl ?? '', target)
    } catch {
        return { kind: 'drift', code: 'prompt_target_fingerprint_mismatch' }
    }
    // Re-bind the receipt to the CURRENT target + this envelope; executor consults
    // dispatchEligible (request §6/§10-10), never modelVerdict.
    const envelopeHash = await computeEnvelopeHash(envelope)
    try {
        assertReceiptDispatchEligibleForTarget(receipt, target, envelopeHash)
    } catch (error) {
        if (error instanceof IllustrationPromptV2ContractError) return { kind: 'rebind', error }
        throw error
    }
    return { kind: 'ready', target, transportConfig }
}

async function settleV2ReceiptRebindFailure(
    job: IllustrationJobRecordV1,
    epoch: number,
    error: IllustrationPromptV2ContractError,
    step: string,
): Promise<void> {
    const patch: IllustrationJobTransitionPatch = {
        idempotencyKey: transitionKey(epoch, job, step),
        workerEpoch: epoch,
        error: { code: error.code, retryable: false },
    }
    if (job.state === 'queued') {
        await transitionPreDispatchJob(job, 'failed', patch)
        return
    }
    if (job.state !== 'generating') return
    await transitionExecutorJob({
        jobId: job.jobId,
        expectedVersion: job.version,
        to: 'failed',
        patch,
    })
}

async function processQueuedV2Job(job: IllustrationJobRecordV1, epoch: number): Promise<void> {
    if (!(await isIllustrationFeatureEnabled())) return
    const envelope = job.promptEnvelope
    const receipt = job.promptReceipt
    // The delegate guard only routes jobs that carry a durable envelope; a receipt is
    // always written with it. A record missing either is inert here (never dispatched).
    if (!envelope || !receipt) return

    let context = await resolveIllustrationJobContext(job)
    if (context.kind !== 'valid') {
        await settleContextFailure(job, context, epoch)
        return
    }

    // Pre-dispatch gate #1 (while queued): re-resolve/fingerprint/probe/rebind.
    const queuedGate = await evaluateV2DispatchGate(job, envelope, receipt)
    if (queuedGate.kind === 'drift') {
        await settleDispatchConfigurationBlock(job, epoch, queuedGate.code, `v2-config-${queuedGate.code}`)
        return
    }
    if (queuedGate.kind === 'rebind') {
        await settleV2ReceiptRebindFailure(job, epoch, queuedGate.error, 'v2-receipt-rebind')
        return
    }

    const attemptId = job.attemptId ?? freshAttemptId()
    const assetId = await deriveIllustrationAssetId(job.jobId, attemptId)
    let generating = await transitionPreDispatchJob(job, 'generating', {
        idempotencyKey: `worker:${epoch}:${job.jobId}:${attemptId}:generating`,
        workerEpoch: epoch,
        attemptId,
        assetId,
        error: null,
    })
    if (!generating) return

    const dispatchRecord = await illustrationJobStore.getJob(job.jobId)
    if (!dispatchRecord
        || dispatchRecord.attemptId !== generating.attemptId
        || dispatchRecord.assetId !== generating.assetId) return
    if (dispatchRecord.state === 'cancel_requested') {
        await transitionExecutorJob({
            jobId: dispatchRecord.jobId,
            expectedVersion: dispatchRecord.version,
            to: 'cancelled',
            patch: {
                idempotencyKey: transitionKey(epoch, dispatchRecord, 'cancelled-before-dispatch'),
                workerEpoch: epoch,
                error: null,
            },
        })
        return
    }
    if (dispatchRecord.state !== 'generating') return
    const dispatchContext = await resolveIllustrationJobContext(dispatchRecord)
    if (dispatchContext.kind !== 'valid') {
        if (dispatchContext.kind === 'stale') {
            await settleContextFailure(dispatchRecord, dispatchContext, epoch)
        } else {
            await transitionExecutorJob({
                jobId: dispatchRecord.jobId,
                expectedVersion: dispatchRecord.version,
                to: 'stale',
                patch: {
                    idempotencyKey: transitionKey(epoch, dispatchRecord, 'pre-provider-corrupt'),
                    workerEpoch: epoch,
                    error: { code: `pre_provider_${dispatchContext.reason}` },
                },
            })
        }
        return
    }
    generating = dispatchRecord

    // Pre-dispatch gate #2 (after entering the provider-intent state): a config change
    // during the transition still yields provider-call-0.
    const finalGate = await evaluateV2DispatchGate(generating, envelope, receipt)
    if (finalGate.kind === 'drift') {
        await settleDispatchConfigurationBlock(generating, epoch, finalGate.code, `v2-final-${finalGate.code}`)
        return
    }
    if (finalGate.kind === 'rebind') {
        await settleV2ReceiptRebindFailure(generating, epoch, finalGate.error, 'v2-final-receipt-rebind')
        return
    }
    if (!isIllustrationJobLiveContextCurrent(generating, dispatchContext)) {
        await transitionExecutorJob({
            jobId: generating.jobId,
            expectedVersion: generating.version,
            to: 'stale',
            patch: {
                idempotencyKey: transitionKey(epoch, generating, 'final-context-changed'),
                workerEpoch: epoch,
                error: { code: 'pre_provider_context_changed' },
            },
        })
        return
    }

    // Provider-wide broker slot for the captured concurrency key, applying the CURRENT
    // policy of that key (request §4/§8). Released as soon as the provider call returns.
    const release = await illustrationTransportBroker.acquire(
        finalGate.target.queue.concurrencyKey,
        {
            maxConcurrency: finalGate.target.queue.maxConcurrency,
            priorityPolicy: finalGate.target.queue.priorityPolicy,
        },
        'background',
    )
    let result: ImageGenerationResult
    try {
        result = await dispatchIllustrationEnvelopeV2(
            finalGate.target,
            finalGate.transportConfig,
            envelope,
            dispatchContext.character,
            'background',
        )
    } finally {
        release()
    }

    if (result.ok === false) {
        // socket/timeout/lost response => uncertain (never auto-duplicated, request §8).
        await transitionProviderFailure(job.jobId, epoch, result.certainty)
        return
    }
    await writeAndCommitV2ProviderImage(job, generating, result.bytesOrDataUrl, assetId, epoch)
}

// The provider-neutral asset-write/commit tail, replicated from processQueuedJob so the
// V1 (NAI genesis) path stays byte-identical. It calls the SAME machinery (write inlay,
// integrity, CAS transitions, commit) V1 uses — only the image source differs.
async function writeAndCommitV2ProviderImage(
    job: IllustrationJobRecordV1,
    generatingInput: IllustrationJobRecordV1,
    bytesOrDataUrl: string,
    assetId: string,
    epoch: number,
): Promise<void> {
    let generating = generatingInput
    let latest = await illustrationJobStore.getJob(job.jobId)
    if (!latest || (latest.state !== 'generating' && latest.state !== 'cancel_requested')) return
    if (latest.state === 'generating') {
        const returnedContext = await resolveIllustrationJobContext(latest)
        if (returnedContext.kind !== 'valid') {
            if (returnedContext.kind === 'stale') {
                await settleContextFailure(latest, returnedContext, epoch)
            } else {
                await transitionExecutorJob({
                    jobId: latest.jobId,
                    expectedVersion: latest.version,
                    to: 'stale',
                    patch: {
                        idempotencyKey: transitionKey(epoch, latest, 'post-provider-corrupt'),
                        workerEpoch: epoch,
                        error: { code: `post_provider_${returnedContext.reason}` },
                    },
                })
            }
            return
        }
    }
    for (;;) {
        if (
            latest.attemptId !== generating.attemptId
            || latest.assetId !== generating.assetId
            || (latest.state !== 'generating' && latest.state !== 'cancel_requested')
        ) return
        try {
            generating = await transitionExecutorJob({
                jobId: job.jobId,
                expectedVersion: latest.version,
                to: 'asset_writing',
                patch: {
                    idempotencyKey: transitionKey(epoch, latest, 'asset-writing'),
                    workerEpoch: epoch,
                },
            })
            break
        } catch (error) {
            if (!(error instanceof IllustrationLedgerVersionConflictError)) throw error
            const winner = await illustrationJobStore.getJob(job.jobId)
            if (!winner) return
            latest = winner
        }
    }

    try {
        const image = new Image()
        image.src = bytesOrDataUrl
        await writeInlayImage(image, {
            id: assetId,
            target: { charId: job.target!.chaId, chatId: job.target!.conversationId },
            decodeTimeoutMs: ILLUSTRATION_IMAGE_DECODE_TIMEOUT_MS,
        })
        const integrity = await inspectInlayAssetIntegrity(assetId)
        if (integrity.status !== 'complete') throw new Error('asset integrity incomplete')
    } catch {
        let latestWriting = await illustrationJobStore.getJob(job.jobId)
        for (;;) {
            if (
                !latestWriting
                || latestWriting.state !== 'asset_writing'
                || latestWriting.attemptId !== generating.attemptId
                || latestWriting.assetId !== generating.assetId
            ) return
            try {
                await transitionExecutorJob({
                    jobId: job.jobId,
                    expectedVersion: latestWriting.version,
                    to: 'uncertain',
                    patch: {
                        idempotencyKey: transitionKey(epoch, latestWriting, 'asset-write-uncertain'),
                        workerEpoch: epoch,
                        error: { code: 'asset_write_uncertain', certainty: 'uncertain' },
                    },
                })
                return
            } catch (error) {
                if (!(error instanceof IllustrationLedgerVersionConflictError)) throw error
                latestWriting = await illustrationJobStore.getJob(job.jobId)
            }
        }
    }

    let latestWriting = await illustrationJobStore.getJob(job.jobId)
    let ready: IllustrationJobRecordV1
    for (;;) {
        if (
            !latestWriting
            || latestWriting.state !== 'asset_writing'
            || latestWriting.attemptId !== generating.attemptId
            || latestWriting.assetId !== generating.assetId
        ) return
        try {
            ready = await transitionExecutorJob({
                jobId: job.jobId,
                expectedVersion: latestWriting.version,
                to: 'asset_ready',
                patch: {
                    idempotencyKey: transitionKey(epoch, latestWriting, 'asset-ready'),
                    workerEpoch: epoch,
                },
            })
            break
        } catch (error) {
            if (!(error instanceof IllustrationLedgerVersionConflictError)) throw error
            latestWriting = await illustrationJobStore.getJob(job.jobId)
        }
    }
    ready = (await illustrationJobStore.getJob(job.jobId)) ?? ready
    if (ready.cancelRequestedAt !== undefined) {
        await cancelExecutorJob({ jobId: job.jobId, expectedVersion: ready.version })
        return
    }
    await commitIllustrationAssetReadyJob(job.jobId, epoch)
}

async function resumeBlockedConfig(job: IllustrationJobRecordV1, epoch: number): Promise<boolean> {
    // Prompt Target V2 (request §D2): a V2 job blocked on target drift re-queues once its
    // captured target resolves + matches + re-binds again — the symmetric restore of the
    // same blocked_config drift flow, evaluated against the V2 gate rather than NAI settings.
    if (job.promptEnvelope) return await resumeV2BlockedConfig(job, epoch)
    const database = getDatabase()
    if (database.sdProvider !== 'novelai') return false
    if ((await computeNaiSettingsFingerprint(database)) !== job.settingsFingerprint) return false
    const context = await resolveIllustrationJobContext(job)
    if (context.kind !== 'valid') {
        await settleContextFailure(job, context, epoch)
        return true
    }
    await transitionPreDispatchJob(job, 'queued', {
        idempotencyKey: transitionKey(epoch, job, 'resume-config'),
        workerEpoch: epoch,
        error: null,
    })
    return true
}

// Per-job earliest wall-clock at which a blocked live-probe re-check may fire again. In
// memory only: a process restart re-probes once immediately (bounded), which is the
// correct fail-open. Entries are cleared when the job leaves blocked_config.
const blockedLiveProbeNextAt = new Map<string, number>()

// Only a webui-flat probe-and-revalidate target re-verifies its blocked_config via a live
// backend GET (verifyWebuiCheckpointBinding). The captured target carries the same
// transport/binding the live one must fingerprint-match, so the binding mode is readable
// from the durable turn snapshot without a network call.
async function v2BlockedResumeUsesLiveProbe(job: IllustrationJobRecordV1): Promise<boolean> {
    const turn = await illustrationJobStore.getTurn(job.turnId)
    const target = turn?.promptContext?.target
    return target?.transportId === 'webui-flat' && target.bindingMode === 'probe-and-revalidate'
}

async function resumeV2BlockedConfig(job: IllustrationJobRecordV1, epoch: number): Promise<boolean> {
    const envelope = job.promptEnvelope
    const receipt = job.promptReceipt
    if (!envelope || !receipt) return false
    // A webui-flat probe-and-revalidate target can only detect checkpoint restoration via a
    // live backend GET. Firing that on every 5s poll while blocked would hammer a remote /
    // metered backend uncapped (and stall the single pump for each probe's duration), so
    // throttle the live re-check to a slower cadence. Every other V2 binding mode resolves
    // drift locally at zero network cost and keeps the normal poll cadence — parity with the
    // V1/NAI local-fingerprint resume.
    if (await v2BlockedResumeUsesLiveProbe(job)) {
        const now = Date.now()
        const nextAt = blockedLiveProbeNextAt.get(job.jobId)
        if (nextAt !== undefined && now < nextAt) return false
        blockedLiveProbeNextAt.set(job.jobId, now + ILLUSTRATION_BLOCKED_LIVE_PROBE_MIN_INTERVAL_MS)
    }
    // Still drifted / probe-failing / re-bind-failing => stay blocked (no state change).
    const gate = await evaluateV2DispatchGate(job, envelope, receipt)
    if (gate.kind !== 'ready') return false
    blockedLiveProbeNextAt.delete(job.jobId)
    const context = await resolveIllustrationJobContext(job)
    if (context.kind !== 'valid') {
        await settleContextFailure(job, context, epoch)
        return true
    }
    await transitionPreDispatchJob(job, 'queued', {
        idempotencyKey: transitionKey(epoch, job, 'v2-resume-config'),
        workerEpoch: epoch,
        error: null,
    })
    return true
}

export function resetIllustrationBlockedProbeBackoffForTests(): void {
    blockedLiveProbeNextAt.clear()
}

async function processNextJob(epoch: number): Promise<boolean> {
    const jobs = await illustrationJobStore.listJobRecords()
    const queued = jobs.find((job) => job.state === 'queued')
    if (queued) {
        if (queued.revision) await processQueuedRevisionJob(queued, epoch)
        else await processQueuedJob(queued, epoch)
        return true
    }
    for (const job of jobs) {
        if (job.state === 'blocked_config') {
            const resumed = job.revision
                ? await resumeRevisionBlockedConfig(job, epoch)
                : await resumeBlockedConfig(job, epoch)
            if (resumed) return true
        }
    }
    return false
}

let leaderActive = false
let activeEpoch = 0
let leadershipPromise: Promise<void> | null = null
let startPromise: Promise<void> | null = null
let pendingRestartPromise: Promise<void> | null = null
let stopResolve: (() => void) | null = null
let pumpPromise: Promise<void> | null = null
let pollTimer: ReturnType<typeof setTimeout> | null = null
let wakeRequested = false
let unregisterWakeListener: (() => void) | null = null
let leadershipAbortController: AbortController | null = null
let stopRequested = false
let leadershipTearingDown = false
let desiredRunning = false
let lifecycleGeneration = 0

function clearPollTimer(): void {
    if (pollTimer !== null) {
        clearTimeout(pollTimer)
        pollTimer = null
    }
}

async function schedulePollIfNeeded(): Promise<void> {
    if (!leaderActive || stopRequested || pollTimer !== null) return
    if (!(await isIllustrationFeatureEnabled())) return
    const jobs = await illustrationJobStore.listJobRecords()
    if (!jobs.some((job) => !isTerminalJobState(job.state))) return
    pollTimer = setTimeout(() => {
        pollTimer = null
        void pokeExecutor()
    }, ILLUSTRATION_EXECUTOR_POLL_MS)
}

async function runPump(): Promise<void> {
    do {
        wakeRequested = false
        while (leaderActive && !stopRequested && await isIllustrationFeatureEnabled()) {
            const progressed = await processNextJob(activeEpoch)
            if (!progressed) break
        }
    } while (leaderActive && !stopRequested && wakeRequested)
    await schedulePollIfNeeded()
}

function launchPump(): Promise<void> {
    let tracked!: Promise<void>
    tracked = runPump()
        .catch(() => {
            console.warn('[illustration] executor pump stopped after a job error')
        })
        .finally(() => {
            if (pumpPromise === tracked) pumpPromise = null
            if (!wakeRequested) void schedulePollIfNeeded()
        })
    pumpPromise = tracked
    return tracked
}

export async function pokeExecutor(): Promise<void> {
    if (!leaderActive || stopRequested) return
    wakeRequested = true
    while (leaderActive && !stopRequested) {
        clearPollTimer()
        const running = pumpPromise ?? launchPump()
        await running
        if (pumpPromise && pumpPromise !== running) continue
        if (!wakeRequested) return
    }
}

function startWasSuperseded(generation: number): boolean {
    return !desiredRunning || generation !== lifecycleGeneration || stopRequested
}

function stoppedStartError(): IllustrationLedgerValidationError {
    return new IllustrationLedgerValidationError('Illustration executor start was stopped')
}

function beginIllustrationExecutor(generation: number): Promise<void> {
    if (!desiredRunning || generation !== lifecycleGeneration) return Promise.reject(stoppedStartError())
    stopRequested = false
    const starting = (async () => {
        await requireIllustrationFeatureEnabled()
        if (startWasSuperseded(generation)) throw stoppedStartError()
        const manager = requireWorkerLockManager()
        let readyResolve!: () => void
        let readyReject!: (error: unknown) => void
        const ready = new Promise<void>((resolve, reject) => {
            readyResolve = resolve
            readyReject = reject
        })
        const stopped = new Promise<void>((resolve) => {
            stopResolve = resolve
        })
        const abortController = new AbortController()
        leadershipAbortController = abortController
        if (stopRequested) abortController.abort()

        leadershipPromise = manager.request(ILLUSTRATION_WORKER_LOCK_NAME, async () => {
            try {
                if (startWasSuperseded(generation)) throw stoppedStartError()
                await requireIllustrationFeatureEnabled()
                if (startWasSuperseded(generation)) throw stoppedStartError()
                activeEpoch = await illustrationJobStore.acquireWorkerEpoch()
                if (startWasSuperseded(generation)) throw stoppedStartError()
                leaderActive = true
                unregisterWakeListener = registerIllustrationExecutorWakeListener(() => {
                    void pokeExecutor()
                })
                readyResolve()
                void pokeExecutor()
                await stopped
                if (pumpPromise) await pumpPromise
            } catch (error) {
                readyReject(error)
                throw error
            } finally {
                leadershipTearingDown = true
                clearPollTimer()
                unregisterWakeListener?.()
                unregisterWakeListener = null
                leaderActive = false
                activeEpoch = 0
            }
        }, abortController.signal).catch((error) => {
            readyReject(error)
        }).finally(() => {
            if (leadershipPromise === leadership) leadershipPromise = null
            if (leadershipAbortController === abortController) leadershipAbortController = null
            if (startPromise === starting) startPromise = null
            stopResolve = null
            leadershipTearingDown = false
        })
        const leadership = leadershipPromise
        return await ready
    })()
    startPromise = starting
    void starting.catch(() => {
        if (startPromise === starting && leadershipPromise === null) startPromise = null
    })
    return starting
}

export function startIllustrationExecutor(): Promise<void> {
    if (pendingRestartPromise && desiredRunning) return pendingRestartPromise
    if (startPromise && desiredRunning && !stopRequested && !leadershipTearingDown) return startPromise

    desiredRunning = true
    const generation = lifecycleGeneration + 1
    lifecycleGeneration = generation
    if (!stopRequested && !leadershipTearingDown && !startPromise && !leadershipPromise) {
        return beginIllustrationExecutor(generation)
    }

    const priorStart = startPromise
    let restarting!: Promise<void>
    restarting = (async () => {
        if (priorStart) await priorStart.catch(() => undefined)
        const priorLeadership = leadershipPromise
        if (priorLeadership) await priorLeadership
        if (!desiredRunning || generation !== lifecycleGeneration) throw stoppedStartError()
        return await beginIllustrationExecutor(generation)
    })()
    pendingRestartPromise = restarting
    void restarting.then(
        () => {
            if (pendingRestartPromise === restarting) pendingRestartPromise = null
        },
        () => {
            if (pendingRestartPromise === restarting) pendingRestartPromise = null
        },
    )
    return restarting
}

export async function stopIllustrationExecutor(): Promise<void> {
    desiredRunning = false
    lifecycleGeneration += 1
    stopRequested = true
    clearPollTimer()
    const pumpAtStop = pumpPromise
    const leadershipAtStop = leadershipPromise
    const pendingAtStop = pendingRestartPromise
    stopResolve?.()
    if (!leaderActive) leadershipAbortController?.abort()
    if (pumpAtStop) await pumpAtStop
    if (leadershipAtStop) await leadershipAtStop
    if (pendingAtStop) await pendingAtStop.catch(() => undefined)
}

export async function withIllustrationWorkerEpoch<T>(
    callback: (epoch: number) => Promise<T>,
): Promise<T> {
    const manager = requireWorkerLockManager()
    return await manager.request(ILLUSTRATION_WORKER_LOCK_NAME, async () => {
        await requireIllustrationFeatureEnabled()
        const epoch = await illustrationJobStore.acquireWorkerEpoch()
        return await callback(epoch)
    })
}
