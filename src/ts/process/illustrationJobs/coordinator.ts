import { getDatabase, type Chat, type Message, type character } from '../../storage/database.svelte'
import { ensureChatHydrated, saveChatToServerStrict } from '../../storage/chatStorage'
import {
    resolveSlotAnchor,
    validatePlacementOffsets,
    type FoundSlotResolution,
} from './anchors'
import {
    buildRequestMarker,
    buildSlotNode,
    findRequestMarkers,
    stripIllustrationControlNodes,
} from './controlNodes'
import {
    IllustrationLedgerCorruptError,
    IllustrationLedgerValidationError,
} from './errors'
import {
    claimCoordinator as claimCoordinatorRecord,
    markCoordinatorDraining as markCoordinatorDrainingRecord,
    releaseCoordinator as releaseCoordinatorRecord,
    releaseCoordinatorFinal as releaseCoordinatorFinalRecord,
    type ClaimCoordinatorInput,
    type CoordinatorReleaseProof,
    type ReleaseCoordinatorInput,
} from './coordinatorRecord'
import { requireIllustrationFeatureEnabled } from './featureFlag'
import { signalIllustrationExecutor } from './executorSignal'
import { withIllustrationOperationLock } from './operationLock'
import { computeNaiSettingsFingerprint } from './settingsFingerprint'
import { computeSourceRevisionHash, hashesMatch, sha256Hex } from './sourceHash'
import { canTransition } from './stateMachine'
import {
    MAX_JOBS_PER_TURN,
    illustrationJobStore,
    projectFullJobSnapshot,
    projectTurnSnapshot,
    type ReportAgentFailureInput,
    type RetryAgentFailureInput,
    validateHolderWrite,
} from './store'
import type {
    IllustrationCoordinatorProof,
    IllustrationCoordinatorRecordV1,
    IllustrationCoordinatorSnapshotV1,
    IllustrationHolderWrite,
    IllustrationJobFullSnapshotV1,
    IllustrationJobRecordV1,
    IllustrationJobSnapshotV1,
    IllustrationTurnRecordV1,
    IllustrationTurnSnapshotV1,
    ScenePayloadV1,
    StoredPlanManifestV1,
} from './types'

export const ILLUSTRATION_PROTOCOL_VERSION = 1

export async function claimCoordinatorLedger(
    input: ClaimCoordinatorInput,
): Promise<IllustrationCoordinatorSnapshotV1> {
    // Gate 4b injects a host-generated, non-forgeable runtime ID. This ledger
    // layer only stores and binds the verbatim value; it is not an auth boundary.
    return await claimCoordinatorRecord(input)
}

export async function releaseCoordinatorLedger(input: ReleaseCoordinatorInput): Promise<void> {
    await releaseCoordinatorRecord(input)
}

export async function markCoordinatorDrainingLedger(
    input: CoordinatorReleaseProof,
): Promise<IllustrationCoordinatorRecordV1> {
    return await markCoordinatorDrainingRecord(input)
}

export async function releaseCoordinatorFinalLedger(
    input: CoordinatorReleaseProof,
): Promise<void> {
    await releaseCoordinatorFinalRecord(input)
}

export async function listPendingTurnsLedger(): Promise<IllustrationTurnSnapshotV1[]> {
    return await illustrationJobStore.listPendingTurns()
}

export async function listJobsLedger(
    input: { turnId?: string } = {},
): Promise<IllustrationJobSnapshotV1[]> {
    return await illustrationJobStore.listJobs(input)
}

export async function claimTurnLedger(
    input: Parameters<typeof illustrationJobStore.claimTurnSnapshot>[0],
): Promise<IllustrationTurnSnapshotV1> {
    return await illustrationJobStore.claimTurnSnapshot(input)
}

export async function claimJobLedger(
    input: Parameters<typeof illustrationJobStore.claimJobSnapshot>[0],
): Promise<IllustrationJobFullSnapshotV1> {
    return await illustrationJobStore.claimJobSnapshot(input)
}

export async function reportAgentFailureLedger(
    input: ReportAgentFailureInput,
): Promise<IllustrationTurnSnapshotV1 | IllustrationJobSnapshotV1> {
    const record = await illustrationJobStore.reportAgentFailure(input)
    return input.kind === 'turn'
        ? projectTurnSnapshot(record as IllustrationTurnRecordV1)
        : projectFullJobSnapshot(record as IllustrationJobRecordV1)
}

export async function retryAgentFailureLedger(
    input: RetryAgentFailureInput,
): Promise<IllustrationTurnSnapshotV1 | IllustrationJobSnapshotV1> {
    const record = await illustrationJobStore.retryAgentFailure(input)
    return input.kind === 'turn'
        ? projectTurnSnapshot(record as IllustrationTurnRecordV1)
        : projectFullJobSnapshot(record as IllustrationJobRecordV1)
}

export type RegisterTrustedTurnInput = {
    chaId: string
    conversationId: string
    expectedMessageId: string
    rootTurnId: string
    sourceVariantText: string
}

type LoadedChat = {
    character: character
    chat: Chat
    chatIndex: number
}

type VariantLocation = {
    message: Message
    messageIndex: number
    activeSwipeIndex: number | null
    swipeHint: number
    getText(): string
    setText(value: string): void
}

function requireNonEmpty(value: string, label: string): void {
    if (typeof value !== 'string' || value.length === 0) {
        throw new IllustrationLedgerValidationError(`${label} must be a non-empty string`)
    }
}

async function loadChat(chaId: string, conversationId: string): Promise<LoadedChat> {
    const character = getDatabase().characters.find((candidate) => candidate.chaId === chaId)
    if (!character) throw new IllustrationLedgerValidationError('Illustration character target is missing')

    let chatIndex = character.chats.findIndex((candidate) => candidate?.id === conversationId)
    if (chatIndex < 0) throw new IllustrationLedgerValidationError('Illustration conversation target is missing')
    const hydrated = await ensureChatHydrated(character.chats, chatIndex, chaId)
    if (!hydrated || hydrated.id !== conversationId || hydrated._placeholder) {
        throw new IllustrationLedgerValidationError('Illustration conversation could not be hydrated')
    }

    chatIndex = character.chats.findIndex((candidate) => candidate?.id === conversationId)
    if (chatIndex < 0 || character.chats[chatIndex] !== hydrated) {
        throw new IllustrationLedgerValidationError('Illustration conversation moved during hydration')
    }
    return { character, chat: hydrated, chatIndex }
}

function resolveCaptureVariant(
    chat: Chat,
    expectedMessageId: string,
    sourceVariantText: string,
): VariantLocation {
    const messageIndexes: number[] = []
    for (let index = 0; index < chat.message.length; index += 1) {
        if (chat.message[index].chatId === expectedMessageId) messageIndexes.push(index)
    }
    if (messageIndexes.length !== 1) {
        throw new IllustrationLedgerValidationError('Illustration message target is missing or duplicated')
    }

    const messageIndex = messageIndexes[0]
    const message = chat.message[messageIndex]
    if (message.swipes === undefined) {
        if (message.data !== sourceVariantText) {
            throw new IllustrationLedgerValidationError('Illustration source variant changed before capture')
        }
        return {
            message,
            messageIndex,
            activeSwipeIndex: null,
            swipeHint: 0,
            getText: () => message.data,
            setText: (value) => {
                message.data = value
            },
        }
    }

    if (
        message.swipes.length === 0
        || !Number.isSafeInteger(message.swipeId)
        || message.swipeId! < 0
        || message.swipeId! >= message.swipes.length
    ) {
        throw new IllustrationLedgerCorruptError('Illustration message has an invalid active swipe')
    }
    const activeSwipeIndex = message.swipeId!
    if (
        message.data !== message.swipes[activeSwipeIndex]
        || message.data !== sourceVariantText
    ) {
        throw new IllustrationLedgerValidationError('Illustration active swipe changed before capture')
    }
    return {
        message,
        messageIndex,
        activeSwipeIndex,
        swipeHint: activeSwipeIndex,
        getText: () => message.data,
        setText: (value) => {
            message.data = value
            message.swipes![activeSwipeIndex] = value
        },
    }
}

export type SubmitPlanLedgerInput = IllustrationHolderWrite & IllustrationCoordinatorProof & {
    turnId: string
    idempotencyKey: string
    sourceRevisionHash: string
    slots: Array<{
        sceneId: string
        insertAfterUtf16: number
        scenePayload: ScenePayloadV1
    }>
}

type MarkerResolution =
    | { kind: 'found', location: VariantLocation, start: number, end: number }
    | { kind: 'stale', reason: string }
    | { kind: 'corrupt', reason: string }

function messageVariants(message: Message, messageIndex: number): VariantLocation[] {
    if (message.swipes === undefined) {
        return [{
            message,
            messageIndex,
            activeSwipeIndex: null,
            swipeHint: 0,
            getText: () => message.data,
            setText: (value) => {
                message.data = value
            },
        }]
    }
    if (
        message.swipes.length === 0
        || !Number.isSafeInteger(message.swipeId)
        || message.swipeId! < 0
        || message.swipeId! >= message.swipes.length
        || message.data !== message.swipes[message.swipeId!]
    ) {
        throw new IllustrationLedgerCorruptError('Illustration active swipe mirrors are invalid')
    }

    const activeSwipeIndex = message.swipeId!
    const variants: VariantLocation[] = [{
        message,
        messageIndex,
        activeSwipeIndex,
        swipeHint: activeSwipeIndex,
        getText: () => message.data,
        setText: (value) => {
            message.data = value
            message.swipes![activeSwipeIndex] = value
        },
    }]
    for (let swipeIndex = 0; swipeIndex < message.swipes.length; swipeIndex += 1) {
        if (swipeIndex === activeSwipeIndex) continue
        variants.push({
            message,
            messageIndex,
            activeSwipeIndex,
            swipeHint: swipeIndex,
            getText: () => message.swipes![swipeIndex],
            setText: (value) => {
                message.swipes![swipeIndex] = value
            },
        })
    }
    return variants
}

function resolveRequestMarker(
    chat: Chat,
    expectedMessageId: string,
    requestNonce: string,
): MarkerResolution {
    const expectedIndexes = chat.message
        .map((message, index) => message.chatId === expectedMessageId ? index : -1)
        .filter((index) => index >= 0)
    if (expectedIndexes.length === 0) return { kind: 'stale', reason: 'message_missing' }
    if (expectedIndexes.length > 1) return { kind: 'corrupt', reason: 'message_identity_collision' }

    const matches: Array<{ location: VariantLocation, start: number, end: number }> = []
    for (let messageIndex = 0; messageIndex < chat.message.length; messageIndex += 1) {
        let variants: VariantLocation[]
        try {
            variants = messageVariants(chat.message[messageIndex], messageIndex)
        } catch {
            return { kind: 'corrupt', reason: 'invalid_swipe_state' }
        }
        for (const location of variants) {
            const markerMatches = findRequestMarkers(location.getText())
                .filter((marker) => marker.nonce === requestNonce)
            if (markerMatches.length > 1) return { kind: 'corrupt', reason: 'duplicate_marker' }
            if (markerMatches.length === 1) {
                if (messageIndex !== expectedIndexes[0]) {
                    return { kind: 'stale', reason: 'message_fence' }
                }
                matches.push({ location, start: markerMatches[0].start, end: markerMatches[0].end })
            }
        }
    }
    if (matches.length === 0) return { kind: 'stale', reason: 'marker_missing' }
    if (matches.length > 1) return { kind: 'corrupt', reason: 'multiple_logical_variants' }
    return { kind: 'found', ...matches[0] }
}

async function closeTurnBeforeProjection(
    turn: IllustrationTurnRecordV1,
    state: 'stale' | 'corrupt',
    code: string,
    input: SubmitPlanLedgerInput,
): Promise<never> {
    await illustrationJobStore.closeTurnFromPlan({
        turnId: turn.turnId,
        expectedVersion: turn.version,
        leaseId: input.leaseId,
        fence: input.fence,
        coordinatorLeaseId: input.coordinatorLeaseId,
        coordinatorFence: input.coordinatorFence,
        to: state,
        code,
        idempotencyKey: `plan-close:${input.idempotencyKey}:${state}:${code}`,
    })
    const jobs = await illustrationJobStore.listJobRecords({ turnId: turn.turnId })
    for (const job of jobs) {
        if (![
            'prepared',
            'awaiting_prompt',
            'agent_blocked_retryable',
            'agent_blocked',
            'queued',
            'blocked_config',
        ].includes(job.state)) continue
        await illustrationJobStore.transitionJob({
            jobId: job.jobId,
            expectedVersion: job.version,
            to: state,
            patch: {
                idempotencyKey: `turn-${state}:${turn.turnId}:${job.jobId}:${job.version}`,
                error: { code },
            },
        })
    }
    throw new IllustrationLedgerValidationError(`Illustration turn is ${state}: ${code}`)
}

async function planHashFor(input: SubmitPlanLedgerInput): Promise<string> {
    return await sha256Hex(JSON.stringify({
        sourceRevisionHash: input.sourceRevisionHash,
        slots: input.slots,
    }))
}

function materializedText(
    sourceTextUtf16: string,
    manifest: StoredPlanManifestV1,
): string {
    let text = sourceTextUtf16
    const entries = manifest.jobs
        .map((entry, manifestIndex) => ({ entry, manifestIndex }))
        .sort((left, right) =>
            right.entry.insertAfterUtf16 - left.entry.insertAfterUtf16
            || right.manifestIndex - left.manifestIndex)
    for (const { entry } of entries) {
        text = text.slice(0, entry.insertAfterUtf16)
            + buildSlotNode(entry.jobId, entry.slotToken)
            + text.slice(entry.insertAfterUtf16)
    }
    return text
}

async function alignProjectedJobs(
    turn: IllustrationTurnRecordV1,
    manifest: StoredPlanManifestV1,
    jobs: IllustrationJobRecordV1[],
    location: VariantLocation,
    workerEpoch?: number,
): Promise<IllustrationJobRecordV1[]> {
    const result: IllustrationJobRecordV1[] = []
    for (const job of jobs) {
        if (job.state !== 'prepared') {
            result.push(job)
            continue
        }
        result.push(await illustrationJobStore.transitionJob({
            jobId: job.jobId,
            expectedVersion: job.version,
            to: 'awaiting_prompt',
            patch: {
                idempotencyKey: `projection:${manifest.planHash}:${job.jobId}`,
                ...(workerEpoch === undefined ? {} : { workerEpoch }),
                settingsFingerprint: turn.settingsFingerprint,
                target: {
                    chaId: turn.target!.chaId,
                    conversationId: turn.target!.conversationId,
                    expectedMessageId: turn.target!.expectedMessageId,
                    rootTurnId: turn.target!.rootTurnId,
                    requestNonce: turn.target!.requestNonce,
                    slotToken: job.slotToken,
                    capturedSwipeHint: location.swipeHint,
                    sourceRevisionHash: turn.sourceRevisionHash!,
                },
            },
        }))
    }
    return result
}

async function submitPlanLedgerLocked(
    input: SubmitPlanLedgerInput,
): Promise<IllustrationJobRecordV1[]> {
    if (!Array.isArray(input.slots)) {
        throw new IllustrationLedgerValidationError('slots must be an array')
    }
    if (input.slots.length > MAX_JOBS_PER_TURN) {
        throw new IllustrationLedgerValidationError(`A turn may contain at most ${MAX_JOBS_PER_TURN} jobs`)
    }

    let turn = await illustrationJobStore.getTurn(input.turnId)
    if (!turn || !turn.target || turn.sourceTextUtf16 === undefined
        || !turn.sourceRevisionHash || !turn.settingsFingerprint) {
        throw new IllustrationLedgerValidationError('Illustration turn capture is incomplete')
    }
    if (input.sourceRevisionHash !== turn.sourceRevisionHash) {
        throw new IllustrationLedgerValidationError('sourceRevisionHash does not match the captured turn')
    }
    validatePlacementOffsets(
        turn.sourceTextUtf16,
        input.slots.map((slot) => slot.insertAfterUtf16),
    )

    const planHash = await planHashFor(input)
    let manifest = await illustrationJobStore.getManifest(turn.turnId)
    if (manifest && (
        manifest.idempotencyKey !== input.idempotencyKey
        || manifest.planHash !== planHash
        || manifest.sourceRevisionHash !== input.sourceRevisionHash
    )) {
        throw new IllustrationLedgerCorruptError('A conflicting plan already exists for this turn')
    }
    if (manifest) {
        manifest = await illustrationJobStore.createManifestPrepared({
            manifest: {
                turnId: manifest.turnId,
                planHash: manifest.planHash,
                expectedCount: manifest.expectedCount,
                sourceRevisionHash: manifest.sourceRevisionHash,
                jobs: manifest.jobs,
            },
            turnExpectedVersion: input.expectedVersion,
            leaseId: input.leaseId,
            fence: input.fence,
            coordinatorLeaseId: input.coordinatorLeaseId,
            coordinatorFence: input.coordinatorFence,
            idempotencyKey: input.idempotencyKey,
        })
        await recoverIllustrationProjectionLocked(turn.turnId, 0)
        manifest = await illustrationJobStore.getManifest(turn.turnId)
        const replayJobs = await illustrationJobStore.listJobRecords({ turnId: turn.turnId })
        if (
            manifest?.phase === 'projection_durable'
            && replayJobs.length === manifest.expectedCount
            && replayJobs.every((job) => job.state !== 'prepared')
        ) return replayJobs
        throw new IllustrationLedgerValidationError(
            'Illustration projection recovery did not reach a durable phase',
        )
    }

    validateHolderWrite(turn, input)

    const loaded = await loadChat(turn.target.chaId, turn.target.conversationId)
    const marker = resolveRequestMarker(
        loaded.chat,
        turn.target.expectedMessageId,
        turn.target.requestNonce,
    )
    if (marker.kind === 'stale') {
        return await closeTurnBeforeProjection(turn, 'stale', marker.reason, input)
    }
    if (marker.kind === 'corrupt') {
        return await closeTurnBeforeProjection(turn, 'corrupt', marker.reason, input)
    }

    const liveHash = await computeSourceRevisionHash(marker.location.getText(), {
        requestNonce: turn.target.requestNonce,
        slotTokens: [],
        committedAssetIds: [],
    })
    if (!hashesMatch(liveHash, turn.sourceRevisionHash)) {
        return await closeTurnBeforeProjection(turn, 'stale', 'source_hash_mismatch', input)
    }
    const markerless = marker.location.getText().slice(0, marker.start)
        + marker.location.getText().slice(marker.end)
    if (markerless !== turn.sourceTextUtf16) {
        return await closeTurnBeforeProjection(turn, 'stale', 'source_text_mismatch', input)
    }

    if (!manifest) {
        manifest = await illustrationJobStore.createManifestPrepared({
            manifest: {
                turnId: turn.turnId,
                planHash,
                expectedCount: input.slots.length,
                sourceRevisionHash: turn.sourceRevisionHash,
                jobs: input.slots.map((slot) => ({
                    jobId: `job_${secureIdentifier()}`,
                    slotToken: secureIdentifier(),
                    insertAfterUtf16: slot.insertAfterUtf16,
                    sceneId: slot.sceneId,
                    scenePayload: slot.scenePayload,
                })),
            },
            turnExpectedVersion: input.expectedVersion,
            leaseId: input.leaseId,
            fence: input.fence,
            coordinatorLeaseId: input.coordinatorLeaseId,
            coordinatorFence: input.coordinatorFence,
            idempotencyKey: input.idempotencyKey,
        })
        turn = await illustrationJobStore.getTurn(input.turnId)
        if (!turn) throw new IllustrationLedgerValidationError('Illustration turn disappeared')
    }

    let jobs = await illustrationJobStore.createJobsFromManifest({
        turnId: turn.turnId,
        expectedManifestVersion: manifest.version,
    })
    if (manifest.phase === 'prepared') {
        manifest = await illustrationJobStore.advanceManifestPhase({
            turnId: turn.turnId,
            expectedVersion: manifest.version,
            to: 'records_complete',
        })
    }

    const currentMarker = resolveRequestMarker(
        loaded.chat,
        turn.target.expectedMessageId,
        turn.target.requestNonce,
    )
    if (currentMarker.kind === 'stale') {
        return await closeTurnBeforeProjection(turn, 'stale', currentMarker.reason, input)
    }
    if (currentMarker.kind === 'corrupt') {
        return await closeTurnBeforeProjection(turn, 'corrupt', currentMarker.reason, input)
    }
    const currentHash = await computeSourceRevisionHash(currentMarker.location.getText(), {
        requestNonce: turn.target.requestNonce,
        slotTokens: [],
        committedAssetIds: [],
    })
    const currentMarkerless = currentMarker.location.getText().slice(0, currentMarker.start)
        + currentMarker.location.getText().slice(currentMarker.end)
    if (
        !hashesMatch(currentHash, turn.sourceRevisionHash)
        || currentMarkerless !== turn.sourceTextUtf16
    ) {
        return await closeTurnBeforeProjection(
            turn,
            'stale',
            'source_changed_before_projection',
            input,
        )
    }

    const nextText = input.slots.length === 0
        ? turn.sourceTextUtf16
        : materializedText(turn.sourceTextUtf16, manifest)
    currentMarker.location.setText(nextText)
    const currentIndex = loaded.character.chats.findIndex(
        (chat) => chat?.id === turn.target!.conversationId,
    )
    if (currentIndex < 0 || loaded.character.chats[currentIndex] !== loaded.chat) {
        throw new IllustrationLedgerValidationError('Illustration conversation moved before projection flush')
    }
    await saveChatToServerStrict(
        turn.target.chaId,
        currentIndex,
        turn.target.conversationId,
        loaded.chat,
    )

    manifest = await illustrationJobStore.advanceManifestPhase({
        turnId: turn.turnId,
        expectedVersion: manifest.version,
        to: 'projection_durable',
    })
    if (input.slots.length === 0) {
        await illustrationJobStore.updateTurn({
            turnId: turn.turnId,
            expectedVersion: turn.version,
            mutate: (draft) => {
                draft.state = 'no_scenes'
            },
        })
        return []
    }

    jobs = await alignProjectedJobs(turn, manifest, jobs, currentMarker.location)
    await illustrationJobStore.updateTurn({
        turnId: turn.turnId,
        expectedVersion: turn.version,
        mutate: (draft) => {
            draft.state = 'awaiting_prompt'
        },
    })
    return jobs
}

export async function submitPlanLedger(
    input: SubmitPlanLedgerInput,
): Promise<IllustrationJobRecordV1[]> {
    return await withIllustrationOperationLock(
        `risu-illustration-materialize:${input.turnId}`,
        async () => await submitPlanLedgerLocked(input),
    )
}

async function saveLoadedChatStrict(turn: IllustrationTurnRecordV1, loaded: LoadedChat): Promise<void> {
    const currentIndex = loaded.character.chats.findIndex(
        (chat) => chat?.id === turn.target!.conversationId,
    )
    if (currentIndex < 0 || loaded.character.chats[currentIndex] !== loaded.chat) {
        throw new IllustrationLedgerValidationError('Illustration conversation moved before recovery flush')
    }
    await saveChatToServerStrict(
        turn.target!.chaId,
        currentIndex,
        turn.target!.conversationId,
        loaded.chat,
    )
}

function projectionVariantKey(resolution: FoundSlotResolution): string {
    if (resolution.offsets.data) return `${resolution.messageIndex}:active`
    return `${resolution.messageIndex}:swipe:${resolution.offsets.swipe!.swipeIndex}`
}

function locationForResolution(chat: Chat, resolution: FoundSlotResolution): VariantLocation {
    const variants = messageVariants(chat.message[resolution.messageIndex], resolution.messageIndex)
    const expectedKey = projectionVariantKey(resolution)
    const location = variants.find((candidate) => {
        const key = candidate.activeSwipeIndex === null || candidate.swipeHint === candidate.activeSwipeIndex
            ? `${candidate.messageIndex}:active`
            : `${candidate.messageIndex}:swipe:${candidate.swipeHint}`
        return key === expectedKey
    })
    if (!location) throw new IllustrationLedgerCorruptError('Projected slot variant disappeared')
    return location
}

async function exactCapturedSourceLocations(
    chat: Chat,
    turn: IllustrationTurnRecordV1,
): Promise<VariantLocation[]> {
    if (!turn.target || turn.sourceTextUtf16 === undefined || !turn.sourceRevisionHash) return []
    const indexes = chat.message
        .map((message, index) => message.chatId === turn.target!.expectedMessageId ? index : -1)
        .filter((index) => index >= 0)
    if (indexes.length !== 1) return []
    let variants: VariantLocation[]
    try {
        variants = messageVariants(chat.message[indexes[0]], indexes[0])
    } catch {
        return []
    }
    const matches: VariantLocation[] = []
    for (const location of variants) {
        if (location.getText() !== turn.sourceTextUtf16) continue
        const hash = await computeSourceRevisionHash(location.getText(), {
            requestNonce: turn.target.requestNonce,
            slotTokens: [],
            committedAssetIds: [],
        })
        if (hashesMatch(hash, turn.sourceRevisionHash)) matches.push(location)
    }
    return matches
}

async function updateRecoveryTurn(
    turn: IllustrationTurnRecordV1,
    state: IllustrationTurnRecordV1['state'],
    code?: string,
): Promise<IllustrationTurnRecordV1> {
    return await illustrationJobStore.updateTurn({
        turnId: turn.turnId,
        expectedVersion: turn.version,
        mutate: (draft) => {
            draft.state = state
            if (code) draft.error = { code }
            else delete draft.error
        },
    })
}

async function settleProjectionFailure(
    turn: IllustrationTurnRecordV1,
    state: 'stale' | 'corrupt',
    code: string,
    workerEpoch: number,
): Promise<void> {
    const jobs = await illustrationJobStore.listJobRecords({ turnId: turn.turnId })
    for (const job of jobs) {
        if (!canTransition('job', job.state, state)) continue
        await illustrationJobStore.transitionJob({
            jobId: job.jobId,
            expectedVersion: job.version,
            to: state,
            patch: {
                idempotencyKey: `recovery:${workerEpoch}:${job.jobId}:${state}:${job.version}`,
                workerEpoch,
                error: { code },
            },
        })
    }
    const latest = await illustrationJobStore.getTurn(turn.turnId)
    if (latest && canTransition('turn', latest.state, state)) {
        await updateRecoveryTurn(latest, state, code)
    }
}

export async function recoverIllustrationCapture(turnId: string): Promise<void> {
    const turn = await illustrationJobStore.getTurn(turnId)
    if (!turn || (turn.state !== 'prepared' && turn.state !== 'blocked_capture')) return
    if (!turn.target || turn.sourceTextUtf16 === undefined || !turn.sourceRevisionHash) {
        if (turn.state === 'prepared') await updateRecoveryTurn(turn, 'corrupt', 'capture_incomplete')
        return
    }

    let loaded: LoadedChat
    try {
        loaded = await loadChat(turn.target.chaId, turn.target.conversationId)
    } catch (error) {
        if (turn.state === 'prepared' && error instanceof IllustrationLedgerValidationError) {
            await updateRecoveryTurn(turn, 'stale', 'capture_target_missing')
        }
        return
    }

    const marker = resolveRequestMarker(
        loaded.chat,
        turn.target.expectedMessageId,
        turn.target.requestNonce,
    )
    let location: VariantLocation
    if (marker.kind === 'corrupt') {
        await updateRecoveryTurn(turn, 'corrupt', marker.reason)
        return
    }
    if (marker.kind === 'found') {
        const markerless = marker.location.getText().slice(0, marker.start)
            + marker.location.getText().slice(marker.end)
        const hash = await computeSourceRevisionHash(marker.location.getText(), {
            requestNonce: turn.target.requestNonce,
            slotTokens: [],
            committedAssetIds: [],
        })
        if (markerless !== turn.sourceTextUtf16 || !hashesMatch(hash, turn.sourceRevisionHash)) {
            if (turn.state === 'prepared') await updateRecoveryTurn(turn, 'stale', 'capture_source_changed')
            return
        }
        location = marker.location
    } else {
        if (marker.reason !== 'marker_missing') {
            if (turn.state === 'prepared') await updateRecoveryTurn(turn, 'stale', marker.reason)
            return
        }
        const candidates = await exactCapturedSourceLocations(loaded.chat, turn)
        if (candidates.length > 1) {
            await updateRecoveryTurn(turn, 'corrupt', 'multiple_capture_variants')
            return
        }
        if (candidates.length === 0) {
            if (turn.state === 'prepared') await updateRecoveryTurn(turn, 'stale', 'capture_source_changed')
            return
        }
        location = candidates[0]
        location.setText(`${location.getText()}${buildRequestMarker(turn.target.requestNonce)}`)
    }

    try {
        await saveLoadedChatStrict(turn, loaded)
    } catch {
        const latest = await illustrationJobStore.getTurn(turn.turnId)
        if (!latest || (latest.state !== 'prepared' && latest.state !== 'blocked_capture')) return
        await updateRecoveryTurn(latest, 'blocked_capture', 'capture_flush_failed')
        return
    }
    const latest = await illustrationJobStore.getTurn(turn.turnId)
    if (latest && (latest.state === 'prepared' || latest.state === 'blocked_capture')) {
        await updateRecoveryTurn(latest, 'awaiting_plan')
    }
}

async function recoverIllustrationProjectionLocked(
    turnId: string,
    workerEpoch: number,
): Promise<void> {
    let turn = await illustrationJobStore.getTurn(turnId)
    if (!turn || (turn.state !== 'awaiting_plan' && turn.state !== 'awaiting_prompt')) return
    if (!turn.target || turn.sourceTextUtf16 === undefined
        || !turn.sourceRevisionHash || !turn.settingsFingerprint) {
        await settleProjectionFailure(turn, 'corrupt', 'projection_capture_incomplete', workerEpoch)
        return
    }
    let manifest = await illustrationJobStore.getManifest(turn.turnId)
    if (!manifest) return
    if (turn.state === 'awaiting_prompt' && manifest.phase === 'projection_durable') {
        const existingJobs = await illustrationJobStore.listJobRecords({ turnId: turn.turnId })
        if (
            existingJobs.length === manifest.expectedCount
            && existingJobs.every((job) => job.state !== 'prepared')
        ) return
    }

    let jobs: IllustrationJobRecordV1[]
    try {
        jobs = await illustrationJobStore.createJobsFromManifest({
            turnId: turn.turnId,
            expectedManifestVersion: manifest.version,
            workerEpoch,
        })
        if (manifest.phase === 'prepared') {
            manifest = await illustrationJobStore.advanceManifestPhase({
                turnId: turn.turnId,
                expectedVersion: manifest.version,
                to: 'records_complete',
            })
        }
    } catch (error) {
        if (!(error instanceof IllustrationLedgerCorruptError)) throw error
        const latest = await illustrationJobStore.getTurn(turn.turnId)
        if (!latest) return
        if (latest.state === 'awaiting_plan') {
            await updateRecoveryTurn(latest, 'blocked_manifest', 'manifest_records_conflict')
        } else {
            await settleProjectionFailure(latest, 'corrupt', 'manifest_records_conflict', workerEpoch)
        }
        return
    }

    let loaded: LoadedChat
    try {
        loaded = await loadChat(turn.target.chaId, turn.target.conversationId)
    } catch (error) {
        if (error instanceof IllustrationLedgerValidationError) {
            await settleProjectionFailure(turn, 'stale', 'projection_target_missing', workerEpoch)
        }
        return
    }

    if (manifest.expectedCount === 0) {
        const marker = resolveRequestMarker(
            loaded.chat,
            turn.target.expectedMessageId,
            turn.target.requestNonce,
        )
        if (marker.kind === 'corrupt') {
            await settleProjectionFailure(turn, 'corrupt', 'corrupt_projection', workerEpoch)
            return
        }
        if (marker.kind === 'found') marker.location.setText(turn.sourceTextUtf16)
        else {
            const candidates = await exactCapturedSourceLocations(loaded.chat, turn)
            if (candidates.length !== 1) {
                await settleProjectionFailure(
                    turn,
                    candidates.length > 1 ? 'corrupt' : 'stale',
                    candidates.length > 1 ? 'corrupt_projection' : 'source_hash_mismatch',
                    workerEpoch,
                )
                return
            }
        }
        await saveLoadedChatStrict(turn, loaded)
        if (manifest.phase === 'records_complete') {
            manifest = await illustrationJobStore.advanceManifestPhase({
                turnId: turn.turnId,
                expectedVersion: manifest.version,
                to: 'projection_durable',
            })
        }
        turn = (await illustrationJobStore.getTurn(turn.turnId)) ?? turn
        if (turn.state === 'awaiting_plan') await updateRecoveryTurn(turn, 'no_scenes')
        return
    }

    const found: FoundSlotResolution[] = []
    let missingCount = 0
    for (const entry of manifest.jobs) {
        const resolution = resolveSlotAnchor(loaded.chat, {
            chaId: turn.target.chaId,
            conversationId: turn.target.conversationId,
            expectedMessageId: turn.target.expectedMessageId,
            rootTurnId: turn.target.rootTurnId,
            requestNonce: turn.target.requestNonce,
            slotToken: entry.slotToken,
            capturedSwipeHint: 0,
            sourceRevisionHash: turn.sourceRevisionHash,
        })
        if (resolution.kind === 'found') found.push(resolution)
        else if (resolution.kind === 'stale' && resolution.reason === 'slot_missing') missingCount += 1
        else {
            await settleProjectionFailure(
                turn,
                resolution.kind === 'corrupt' ? 'corrupt' : 'stale',
                resolution.kind === 'corrupt' ? 'corrupt_projection' : resolution.reason,
                workerEpoch,
            )
            return
        }
    }

    if (found.length > 0 && missingCount > 0) {
        await settleProjectionFailure(turn, 'corrupt', 'corrupt_projection', workerEpoch)
        return
    }

    let location: VariantLocation
    let projectionChanged = false
    if (found.length === manifest.expectedCount) {
        const keys = new Set(found.map(projectionVariantKey))
        if (keys.size !== 1) {
            await settleProjectionFailure(turn, 'corrupt', 'corrupt_projection', workerEpoch)
            return
        }
        location = locationForResolution(loaded.chat, found[0])
    } else {
        const marker = resolveRequestMarker(
            loaded.chat,
            turn.target.expectedMessageId,
            turn.target.requestNonce,
        )
        if (marker.kind === 'corrupt') {
            await settleProjectionFailure(turn, 'corrupt', 'corrupt_projection', workerEpoch)
            return
        }
        if (marker.kind === 'found') {
            const markerless = marker.location.getText().slice(0, marker.start)
                + marker.location.getText().slice(marker.end)
            if (markerless !== turn.sourceTextUtf16) {
                await settleProjectionFailure(turn, 'stale', 'source_hash_mismatch', workerEpoch)
                return
            }
            location = marker.location
        } else {
            const candidates = await exactCapturedSourceLocations(loaded.chat, turn)
            if (candidates.length !== 1) {
                await settleProjectionFailure(
                    turn,
                    candidates.length > 1 ? 'corrupt' : 'stale',
                    candidates.length > 1 ? 'corrupt_projection' : 'source_hash_mismatch',
                    workerEpoch,
                )
                return
            }
            location = candidates[0]
        }
        location.setText(materializedText(turn.sourceTextUtf16, manifest))
        projectionChanged = true
    }

    const projectedHash = await computeSourceRevisionHash(location.getText(), {
        requestNonce: turn.target.requestNonce,
        slotTokens: manifest.jobs.map((entry) => entry.slotToken),
        committedAssetIds: jobs
            .filter((job) => job.state === 'committed' || job.state === 'committing')
            .flatMap((job) => job.assetId ? [job.assetId] : []),
    })
    if (!hashesMatch(projectedHash, turn.sourceRevisionHash)) {
        await settleProjectionFailure(turn, 'stale', 'source_hash_mismatch', workerEpoch)
        return
    }

    if (manifest.phase !== 'projection_durable' || projectionChanged) {
        await saveLoadedChatStrict(turn, loaded)
    }
    if (manifest.phase === 'records_complete') {
        manifest = await illustrationJobStore.advanceManifestPhase({
            turnId: turn.turnId,
            expectedVersion: manifest.version,
            to: 'projection_durable',
        })
    }
    jobs = await alignProjectedJobs(turn, manifest, jobs, location, workerEpoch)
    turn = (await illustrationJobStore.getTurn(turn.turnId)) ?? turn
    if (turn.state === 'awaiting_plan') await updateRecoveryTurn(turn, 'awaiting_prompt')
}

export async function recoverIllustrationProjection(
    turnId: string,
    workerEpoch: number,
): Promise<void> {
    return await withIllustrationOperationLock(
        `risu-illustration-materialize:${turnId}`,
        async () => await recoverIllustrationProjectionLocked(turnId, workerEpoch),
    )
}

export const MAX_ILLUSTRATION_PROMPT_BYTES = 16 * 1024

export type SupplyPromptLedgerInput = IllustrationHolderWrite & IllustrationCoordinatorProof & {
    jobId: string
    idempotencyKey: string
    positive: string
    negative: string
}

export type IllustrationJobLiveContext = {
    kind: 'valid'
    character: character
    chat: Chat
    chatIndex: number
    resolution: FoundSlotResolution
    variantText: string
}

export type IllustrationJobContextResult = IllustrationJobLiveContext | {
    kind: 'stale' | 'corrupt'
    reason: string
}

function resolvedVariantText(chat: Chat, resolution: FoundSlotResolution): string {
    const message = chat.message[resolution.messageIndex]
    if (resolution.offsets.data) return message.data
    const swipeIndex = resolution.offsets.swipe?.swipeIndex
    if (swipeIndex === undefined || message.swipes?.[swipeIndex] === undefined) {
        throw new IllustrationLedgerCorruptError('Resolved illustration swipe disappeared')
    }
    return message.swipes[swipeIndex]
}

export async function resolveIllustrationJobContext(
    job: IllustrationJobRecordV1,
): Promise<IllustrationJobContextResult> {
    if (!job.target) return { kind: 'corrupt', reason: 'target_missing' }

    let loaded: LoadedChat
    try {
        loaded = await loadChat(job.target.chaId, job.target.conversationId)
    } catch (error) {
        if (!(error instanceof IllustrationLedgerValidationError)) throw error
        return { kind: 'stale', reason: 'target_missing' }
    }
    const resolution = resolveSlotAnchor(loaded.chat, job.target)
    if (resolution.kind !== 'found') return resolution

    const siblings = await illustrationJobStore.listJobRecords({ turnId: job.turnId })
    const variantText = resolvedVariantText(loaded.chat, resolution)
    const liveHash = await computeSourceRevisionHash(variantText, {
        requestNonce: job.target.requestNonce,
        slotTokens: siblings.map((candidate) => candidate.slotToken),
        committedAssetIds: siblings
            .filter((candidate) => candidate.state === 'committed' || candidate.state === 'committing')
            .flatMap((candidate) => candidate.assetId ? [candidate.assetId] : []),
    })
    if (!hashesMatch(liveHash, job.sourceRevisionHash)) {
        return { kind: 'stale', reason: 'source_hash_mismatch' }
    }
    return {
        kind: 'valid',
        character: loaded.character,
        chat: loaded.chat,
        chatIndex: loaded.chatIndex,
        resolution,
        variantText,
    }
}

function validatePromptText(positive: string, negative: string): void {
    if (typeof positive !== 'string' || positive.trim().length === 0) {
        throw new IllustrationLedgerValidationError('positive prompt must be a non-empty string')
    }
    if (typeof negative !== 'string') {
        throw new IllustrationLedgerValidationError('negative prompt must be a string')
    }
    const encoder = new TextEncoder()
    if (encoder.encode(positive).byteLength > MAX_ILLUSTRATION_PROMPT_BYTES) {
        throw new IllustrationLedgerValidationError('positive prompt must be at most 16 KiB UTF-8')
    }
    if (encoder.encode(negative).byteLength > MAX_ILLUSTRATION_PROMPT_BYTES) {
        throw new IllustrationLedgerValidationError('negative prompt must be at most 16 KiB UTF-8')
    }
}

export async function supplyPromptLedger(
    input: SupplyPromptLedgerInput,
): Promise<IllustrationJobRecordV1> {
    validatePromptText(input.positive, input.negative)
    const job = await illustrationJobStore.getJob(input.jobId)
    if (!job) throw new IllustrationLedgerValidationError('Illustration job was not found')
    if (job.state !== 'awaiting_prompt') {
        const replay = await illustrationJobStore.transitionJob({
            jobId: job.jobId,
            expectedVersion: input.expectedVersion,
            to: 'queued',
            leaseId: input.leaseId,
            fence: input.fence,
            coordinatorLeaseId: input.coordinatorLeaseId,
            coordinatorFence: input.coordinatorFence,
            patch: {
                idempotencyKey: input.idempotencyKey,
                prompt: { positive: input.positive, negative: input.negative },
            },
        })
        signalIllustrationExecutor()
        return replay
    }
    validateHolderWrite(job, input)

    const context = await resolveIllustrationJobContext(job)
    if (context.kind !== 'valid') {
        await illustrationJobStore.transitionJob({
            jobId: job.jobId,
            expectedVersion: input.expectedVersion,
            to: context.kind,
            leaseId: input.leaseId,
            fence: input.fence,
            coordinatorLeaseId: input.coordinatorLeaseId,
            coordinatorFence: input.coordinatorFence,
            patch: {
                idempotencyKey: `prompt-target:${input.idempotencyKey}:${context.kind}`,
                error: { code: context.reason },
            },
        })
        throw new IllustrationLedgerValidationError(
            `Illustration job is ${context.kind}: ${context.reason}`,
        )
    }

    const queued = await illustrationJobStore.transitionJob({
        jobId: job.jobId,
        expectedVersion: input.expectedVersion,
        to: 'queued',
        leaseId: input.leaseId,
        fence: input.fence,
        coordinatorLeaseId: input.coordinatorLeaseId,
        coordinatorFence: input.coordinatorFence,
        patch: {
            idempotencyKey: input.idempotencyKey,
            prompt: { positive: input.positive, negative: input.negative },
        },
    })
    signalIllustrationExecutor()
    return queued
}

export async function cancelLedger(input: {
    jobId: string
    expectedVersion: number
}): Promise<IllustrationJobRecordV1> {
    const cancelled = await illustrationJobStore.requestCancel(input)
    signalIllustrationExecutor()
    return cancelled
}

async function removeCancelledTurnMarkerBestEffort(
    turn: IllustrationTurnRecordV1,
): Promise<void> {
    if (!turn.target) return
    try {
        const loaded = await loadChat(turn.target.chaId, turn.target.conversationId)
        const marker = resolveRequestMarker(
            loaded.chat,
            turn.target.expectedMessageId,
            turn.target.requestNonce,
        )
        if (marker.kind !== 'found') return
        const text = marker.location.getText()
        marker.location.setText(text.slice(0, marker.start) + text.slice(marker.end))
        await saveLoadedChatStrict(turn, loaded)
    } catch {
        // The ledger transition is the authority and has already ACKed. A marker
        // left by a failed strict flush is inert: cancelled turns cannot claim
        // work, and prompt/render boundaries strip or hide control nodes.
    }
}

export async function cancelTurnLedger(input: {
    turnId: string
    expectedVersion: number
}): Promise<IllustrationTurnSnapshotV1> {
    const cancelled = await illustrationJobStore.requestCancelTurn(input)
    await removeCancelledTurnMarkerBestEffort(cancelled)
    return projectTurnSnapshot(cancelled)
}

export async function retryUncertainLedger(input: {
    jobId: string
    expectedVersion: number
    confirmNewCharge: true
}): Promise<IllustrationJobRecordV1> {
    const queued = await illustrationJobStore.retryUncertainJob(input)
    signalIllustrationExecutor()
    return queued
}

function secureIdentifier(): string {
    if (!globalThis.crypto?.getRandomValues) {
        throw new IllustrationLedgerValidationError('Secure random identifiers are unavailable')
    }
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

async function requestKeyFor(input: RegisterTrustedTurnInput): Promise<string> {
    return await sha256Hex(JSON.stringify([
        ILLUSTRATION_PROTOCOL_VERSION,
        input.chaId,
        input.conversationId,
        input.expectedMessageId,
        input.rootTurnId,
    ]))
}

export async function registerTrustedTurn(
    input: RegisterTrustedTurnInput,
): Promise<IllustrationTurnRecordV1> {
    await requireIllustrationFeatureEnabled()
    requireNonEmpty(input.chaId, 'chaId')
    requireNonEmpty(input.conversationId, 'conversationId')
    requireNonEmpty(input.expectedMessageId, 'expectedMessageId')
    requireNonEmpty(input.rootTurnId, 'rootTurnId')
    if (typeof input.sourceVariantText !== 'string') {
        throw new IllustrationLedgerValidationError('sourceVariantText must be a string')
    }

    const turnId = await requestKeyFor(input)
    const existing = await illustrationJobStore.getTurn(turnId)
    if (existing) return existing

    const loaded = await loadChat(input.chaId, input.conversationId)
    const location = resolveCaptureVariant(
        loaded.chat,
        input.expectedMessageId,
        input.sourceVariantText,
    )
    const requestNonce = secureIdentifier()
    const sourceTextUtf16 = stripIllustrationControlNodes(input.sourceVariantText)
    const sourceRevisionHash = await computeSourceRevisionHash(sourceTextUtf16, {
        requestNonce,
        slotTokens: [],
        committedAssetIds: [],
    })
    const settingsFingerprint = await computeNaiSettingsFingerprint(getDatabase())

    let prepared: IllustrationTurnRecordV1
    try {
        prepared = await illustrationJobStore.createTurn({
            turnId,
            idempotencyKey: `capture:${turnId}`,
            target: {
                chaId: input.chaId,
                conversationId: input.conversationId,
                expectedMessageId: input.expectedMessageId,
                rootTurnId: input.rootTurnId,
                requestNonce,
            },
            sourceTextUtf16,
            sourceRevisionHash,
            settingsFingerprint,
        })
    } catch (error) {
        if (error instanceof IllustrationLedgerCorruptError) {
            const winner = await illustrationJobStore.getTurn(turnId)
            if (winner) return winner
        }
        throw error
    }

    let currentLocation: VariantLocation
    let currentIndex: number
    try {
        currentIndex = loaded.character.chats.findIndex((chat) => chat?.id === input.conversationId)
        if (currentIndex < 0 || loaded.character.chats[currentIndex] !== loaded.chat) {
            throw new IllustrationLedgerValidationError('Illustration conversation moved before capture')
        }
        currentLocation = resolveCaptureVariant(
            loaded.chat,
            input.expectedMessageId,
            input.sourceVariantText,
        )
        if (currentLocation.activeSwipeIndex !== location.activeSwipeIndex) {
            throw new IllustrationLedgerValidationError('Illustration active swipe changed before capture')
        }
    } catch (error) {
        await illustrationJobStore.updateTurn({
            turnId,
            expectedVersion: prepared.version,
            mutate: (draft) => {
                draft.state = 'blocked_capture'
                draft.error = { code: 'capture_variant_raced' }
            },
        })
        throw error
    }
    currentLocation.setText(`${currentLocation.getText()}${buildRequestMarker(requestNonce)}`)

    try {
        await saveChatToServerStrict(input.chaId, currentIndex, input.conversationId, loaded.chat)
    } catch (error) {
        await illustrationJobStore.updateTurn({
            turnId,
            expectedVersion: prepared.version,
            mutate: (draft) => {
                draft.state = 'blocked_capture'
                draft.error = { code: 'capture_flush_failed' }
            },
        })
        throw error
    }

    return await illustrationJobStore.updateTurn({
        turnId,
        expectedVersion: prepared.version,
        mutate: (draft) => {
            draft.state = 'awaiting_plan'
            delete draft.error
        },
    })
}
