import { getDatabase, type Chat, type Message, type character } from '../../storage/database.svelte'
import { ensureChatHydrated, saveChatToServerStrict } from '../../storage/chatStorage'
import {
    inspectInlayAssetIntegrity,
    repairInlayAssetRecords,
    writeInlayImage,
} from '../files/inlays'
import { generateAIImageTyped } from '../stableDiff'
import { patchSlotInVariant } from './anchors'
import {
    resolveIllustrationJobContext,
    type IllustrationJobContextResult,
    type IllustrationJobLiveContext,
} from './coordinator'
import { findSlotNodes } from './controlNodes'
import {
    IllustrationLedgerHolderMismatchError,
    IllustrationLedgerUnavailableError,
    IllustrationLedgerValidationError,
    IllustrationLedgerVersionConflictError,
} from './errors'
import { isIllustrationFeatureEnabled, requireIllustrationFeatureEnabled } from './featureFlag'
import { emitIllustrationWakeHint } from './illustrationEvents'
import { registerIllustrationExecutorWakeListener } from './executorSignal'
import {
    ILLUSTRATION_WORKER_LOCK_NAME,
} from './locks'
import { computeNaiSettingsFingerprint } from './settingsFingerprint'
import { computeSourceRevisionHash, hashesMatch, sha256Hex } from './sourceHash'
import { isTerminalJobState } from './stateMachine'
import { illustrationJobStore } from './store'
import type { IllustrationJobRecordV1, IllustrationJobTransitionPatch } from './types'

export const ILLUSTRATION_EXECUTOR_POLL_MS = 5_000
export const ILLUSTRATION_IMAGE_DECODE_TIMEOUT_MS = 15_000

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
    to: 'blocked_config' | 'generating' | 'queued',
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

async function loadJobChat(job: IllustrationJobRecordV1): Promise<{
    character: character
    chat: Chat
    chatIndex: number
} | null> {
    if (!job.target) return null
    const character = getDatabase().characters.find((candidate) => candidate.chaId === job.target!.chaId)
    if (!character) return null
    let chatIndex = character.chats.findIndex((chat) => chat?.id === job.target!.conversationId)
    if (chatIndex < 0) return null
    const chat = await ensureChatHydrated(character.chats, chatIndex, job.target.chaId)
    if (!chat || chat.id !== job.target.conversationId || chat._placeholder) return null
    chatIndex = character.chats.findIndex((candidate) => candidate?.id === job.target!.conversationId)
    if (chatIndex < 0 || character.chats[chatIndex] !== chat) return null
    return { character, chat, chatIndex }
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

async function processQueuedJob(job: IllustrationJobRecordV1, epoch: number): Promise<void> {
    if (!(await isIllustrationFeatureEnabled())) return
    const context = await resolveIllustrationJobContext(job)
    if (context.kind !== 'valid') {
        await settleContextFailure(job, context, epoch)
        return
    }

    const database = getDatabase()
    const fingerprint = await computeNaiSettingsFingerprint(database)
    if (database.sdProvider !== 'novelai' || fingerprint !== job.settingsFingerprint) {
        await transitionPreDispatchJob(job, 'blocked_config', {
            idempotencyKey: transitionKey(epoch, job, 'blocked-config'),
            workerEpoch: epoch,
            error: { code: database.sdProvider === 'novelai' ? 'settings_fingerprint_mismatch' : 'unsupported_provider' },
        })
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

    const attempt = await generateAIImageTyped(
        generating.prompt!.positive,
        dispatchContext.character,
        generating.prompt!.negative,
        'inlay',
        'background',
        { preservePromptText: true },
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

async function resumeBlockedConfig(job: IllustrationJobRecordV1, epoch: number): Promise<boolean> {
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

async function processNextJob(epoch: number): Promise<boolean> {
    const jobs = await illustrationJobStore.listJobRecords()
    const queued = jobs.find((job) => job.state === 'queued')
    if (queued) {
        await processQueuedJob(queued, epoch)
        return true
    }
    for (const job of jobs) {
        if (job.state === 'blocked_config' && await resumeBlockedConfig(job, epoch)) return true
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
