import { inspectInlayAssetIntegrity } from '../files/inlays'
import {
    IllustrationLedgerCorruptError,
    IllustrationLedgerValidationError,
    IllustrationLedgerVersionConflictError,
} from './errors'
import { emitIllustrationWakeHint } from './illustrationEvents'
import { signalIllustrationExecutor } from './executorSignal'
import { applyRestoreInlaySwap, revertRestoreInlaySwap } from './executor'
import { parseIllustrationPromptV1 } from './imagePrompt'
import { measureAndEnforceImagePromptForDispatch } from './imagePromptMeasurement'
import {
    admitRevisionChild,
    commitRestore,
    getImageRevisionTarget as getImageRevisionTargetLedger,
    listImageReferences as listImageReferencesLedger,
    listImageRevisions as listImageRevisionsLedger,
    prepareRestore,
    promptHashFor,
    readImageReference,
    readRestoreReceipt,
    reconcileCommittedRestore,
    restoreBindingHash,
    type GetImageRevisionTargetResult,
    type ListImageReferencesResult,
    type ListImageRevisionsResult,
} from './revisionLedger'
import { illustrationJobStore, projectFullJobSnapshot } from './store'
import type {
    IllustrationJobFullSnapshotV1,
    IllustrationPromptV1,
    IllustrationRevisionDisposition,
    IllustrationRevisionIdentity,
    IllustrationRevisionMode,
} from './types'

function assertProtocol(protocolVersion: unknown): void {
    if (protocolVersion !== 1) {
        throw new IllustrationLedgerValidationError('protocolVersion must be 1')
    }
}

export type CreateImageRevisionInput = {
    protocolVersion: 1
    idempotencyKey: string
    referenceId: string
    expectedOperationVersion: number
    sourceJobId: string
    expectedLineageVersion: number
    expectedCurrentAssetId: string
    mode: IllustrationRevisionMode
    disposition: IllustrationRevisionDisposition
    editedPrompt?: IllustrationPromptV1
    confirmNewImageCharge: boolean
    confirmNewLlmCharge: boolean
    workerEpoch?: number
}

export async function createImageRevision(
    input: CreateImageRevisionInput,
): Promise<IllustrationJobFullSnapshotV1> {
    assertProtocol(input.protocolVersion)
    if (input.mode !== 'exact-prompt' && input.mode !== 'edited-prompt' && input.mode !== 'retag') {
        throw new IllustrationLedgerValidationError('mode is invalid')
    }
    if (input.disposition !== 'replace' && input.disposition !== 'retain') {
        throw new IllustrationLedgerValidationError('disposition is invalid')
    }

    let editedPrompt: IllustrationPromptV1 | undefined
    let editedPromptHash: string | undefined
    if (input.mode === 'edited-prompt') {
        if (!input.editedPrompt) {
            throw new IllustrationLedgerValidationError('edited-prompt mode requires editedPrompt')
        }
        editedPrompt = parseIllustrationPromptV1(input.editedPrompt)
        editedPromptHash = await promptHashFor(editedPrompt)
        // Validate the edited prompt against the reference's captured measurement +
        // settings fingerprint BEFORE admission (exact measurement + drift, §4.1).
        const reference = await readImageReference(input.referenceId)
        if (!reference) {
            throw new IllustrationLedgerValidationError('Illustration reference was not found')
        }
        await measureAndEnforceImagePromptForDispatch({
            protocolVersion: 1,
            settingsFingerprint: reference.settingsFingerprint,
            prompt: editedPrompt,
        }, { requireNovelAiProvider: true })
    } else if (input.editedPrompt !== undefined) {
        throw new IllustrationLedgerValidationError('editedPrompt is only valid for edited-prompt mode')
    }

    const admitted = await admitRevisionChild({
        idempotencyKey: input.idempotencyKey,
        referenceId: input.referenceId,
        expectedOperationVersion: input.expectedOperationVersion,
        sourceJobId: input.sourceJobId,
        expectedLineageVersion: input.expectedLineageVersion,
        expectedCurrentAssetId: input.expectedCurrentAssetId,
        mode: input.mode,
        disposition: input.disposition,
        editedPrompt,
        editedPromptHash,
        confirmNewImageCharge: input.confirmNewImageCharge,
        confirmNewLlmCharge: input.confirmNewLlmCharge,
        workerEpoch: input.workerEpoch,
    })
    // exact/edited children enter `queued`; wake the executor. retag children enter
    // `awaiting_prompt` for the Plugin's Tagger and are not executor work yet.
    if (admitted.childJob.state === 'queued') signalIllustrationExecutor()
    emitIllustrationWakeHint('job_changed', admitted.childJob.turnId, admitted.childJob.jobId)
    return projectFullJobSnapshot(admitted.childJob)
}

export async function getImageRevisionTarget(input: {
    protocolVersion: 1
    referenceId: string
}): Promise<GetImageRevisionTargetResult> {
    assertProtocol(input.protocolVersion)
    return await getImageRevisionTargetLedger(input.referenceId)
}

export async function listImageRevisions(input: {
    protocolVersion: 1
    referenceId: string
    cursor?: string
    limit: number
}): Promise<ListImageRevisionsResult> {
    assertProtocol(input.protocolVersion)
    return await listImageRevisionsLedger({
        referenceId: input.referenceId,
        cursor: input.cursor,
        limit: input.limit,
    })
}

export async function listImageReferences(input: {
    protocolVersion: 1
    conversationId?: string
    messageId?: string
    cursor?: string
    limit: number
}): Promise<ListImageReferencesResult> {
    assertProtocol(input.protocolVersion)
    return await listImageReferencesLedger({
        conversationId: input.conversationId,
        messageId: input.messageId,
        cursor: input.cursor,
        limit: input.limit,
    })
}

export type EnqueueRevisionImageInput = {
    protocolVersion: 1
    idempotencyKey: string
    jobId: string
    expectedVersion: number
    confirmNewImageCharge: true
}

export async function enqueueRevisionImage(
    input: EnqueueRevisionImageInput,
): Promise<IllustrationJobFullSnapshotV1> {
    assertProtocol(input.protocolVersion)
    const record = await illustrationJobStore.enqueueRevisionImageJob({
        jobId: input.jobId,
        expectedVersion: input.expectedVersion,
        confirmNewImageCharge: input.confirmNewImageCharge,
    })
    signalIllustrationExecutor()
    emitIllustrationWakeHint('job_changed', record.turnId, record.jobId)
    return projectFullJobSnapshot(record)
}

export type RestoreImageRevisionInput = {
    protocolVersion: 1
    idempotencyKey: string
    referenceId: string
    expectedOperationVersion: number
    expectedLineageVersion: number
    expectedCurrentAssetId: string
    targetRevisionId: string
    confirmNoCharge: true
}

export async function restoreImageRevision(
    input: RestoreImageRevisionInput,
): Promise<IllustrationRevisionIdentity> {
    assertProtocol(input.protocolVersion)
    if (input.confirmNoCharge !== true) {
        throw new IllustrationLedgerValidationError('restore requires confirmNoCharge: true')
    }
    const bindingHash = await restoreBindingHash({
        referenceId: input.referenceId,
        expectedOperationVersion: input.expectedOperationVersion,
        expectedLineageVersion: input.expectedLineageVersion,
        expectedCurrentAssetId: input.expectedCurrentAssetId,
        targetRevisionId: input.targetRevisionId,
    })
    // Idempotent replay for double click / ACK loss / reload.
    const replayed = await readRestoreReceipt(input.idempotencyKey, bindingHash)
    if (replayed) return replayed

    let prepared
    try {
        prepared = await prepareRestore({
            referenceId: input.referenceId,
            expectedOperationVersion: input.expectedOperationVersion,
            expectedLineageVersion: input.expectedLineageVersion,
            expectedCurrentAssetId: input.expectedCurrentAssetId,
            targetRevisionId: input.targetRevisionId,
        })
    } catch (error) {
        // A same-key retry of a restore whose reference commit landed but whose receipt
        // write tore fails the old-version CAS here even though it already committed.
        // If the live reference already points at the requested target, reconcile it as
        // an idempotent success and backfill the missing receipt.
        if (error instanceof IllustrationLedgerVersionConflictError) {
            const reconciled = await reconcileCommittedRestore({
                referenceId: input.referenceId,
                targetRevisionId: input.targetRevisionId,
                idempotencyKey: input.idempotencyKey,
                bindingHash,
            })
            if (reconciled) return reconciled
        }
        throw error
    }
    // The restore target asset must still be durably present (retention keeps
    // referenced assets); restoring to a missing asset fails closed with no chat
    // mutation and no charge (§4.1: restore is provider 0).
    const integrity = await inspectInlayAssetIntegrity(prepared.targetEntry.assetId)
    if (integrity.status !== 'complete') {
        throw new IllustrationLedgerCorruptError('Restore target asset is not available')
    }

    const swap = await applyRestoreInlaySwap(prepared.reference, prepared.targetEntry.assetId)
    if (swap === 'stale') {
        throw new IllustrationLedgerValidationError('Restore target inlay is no longer present')
    }
    if (swap === 'corrupt') {
        throw new IllustrationLedgerCorruptError('Restore target inlay is ambiguous')
    }

    let result
    try {
        result = await commitRestore({
            referenceId: input.referenceId,
            expectedOperationVersion: input.expectedOperationVersion,
            expectedLineageVersion: input.expectedLineageVersion,
            targetEntry: prepared.targetEntry,
            idempotencyKey: input.idempotencyKey,
            bindingHash,
        })
    } catch (error) {
        // A THROWN commit (durable storage failure) may leave the chat already flushed
        // to the restored asset while the ledger commit did not durably complete. Revert
        // the chat to the ledger's authoritative current asset before propagating, so
        // chat and ledger never diverge — mirroring the lost-CAS revert below. When the
        // reference write itself landed before the throw, the authoritative asset equals
        // the restored one and the revert is a no-op.
        const authoritative = await readImageReference(input.referenceId)
        if (authoritative) {
            await revertRestoreInlaySwap(authoritative, prepared.targetEntry.assetId)
        }
        throw error
    }
    if (!result.applied) {
        // Lost the lineage/operation CAS: a concurrent replace/restore committed in
        // the window between prepareRestore and commitRestore. applyRestoreInlaySwap
        // has ALREADY flushed the chat to the restored asset, so revert it back to the
        // ledger's authoritative current asset. Without this the chat shows the
        // restored asset while the ledger points elsewhere — a true divergence that
        // leaves the reference un-revisable (§4.2: on version conflict the existing
        // image keeps showing and nothing is re-charged).
        const authoritative = await readImageReference(input.referenceId)
        if (authoritative) {
            await revertRestoreInlaySwap(authoritative, prepared.targetEntry.assetId)
        }
        throw new IllustrationLedgerValidationError('Restore lost its lineage CAS')
    }
    emitIllustrationWakeHint('job_changed', `revision:${input.referenceId}`, undefined)
    return result.identity
}
