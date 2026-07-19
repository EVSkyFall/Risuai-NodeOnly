import { getDatabase } from '../../storage/database.svelte'
import {
    inspectInlayAssetIntegrity,
    repairInlayAssetRecords,
} from '../files/inlays'
import {
    recoverIllustrationCapture,
    recoverIllustrationProjection,
    resolveIllustrationJobContext,
    type IllustrationJobContextResult,
} from './coordinator'
import {
    commitIllustrationAssetReadyJob,
    reconcileIllustrationCommittingJob,
    recoverRevisionJob,
    withIllustrationWorkerEpoch,
} from './executor'
import { isIllustrationFeatureEnabled } from './featureFlag'
import { isLegacyIllustrationStoredPrompt } from './imagePrompt'
import { computeNaiSettingsFingerprint } from './settingsFingerprint'
import { canTransition, isTerminalJobState, isTerminalTurnState } from './stateMachine'
import { illustrationJobStore } from './store'
import type {
    IllustrationJobRecordV1,
    IllustrationJobState,
} from './types'

export type IllustrationRecoverySummary = {
    turnsExamined: number
    jobsExamined: number
}

function recoveryKey(epoch: number, job: IllustrationJobRecordV1, step: string): string {
    return `recovery:${epoch}:${job.jobId}:${job.attemptId ?? 'none'}:${step}:${job.version}`
}

async function transitionRecoveryJob(
    job: IllustrationJobRecordV1,
    to: IllustrationJobState,
    epoch: number,
    step: string,
    error?: { code: string, certainty?: 'definite' | 'uncertain' },
): Promise<IllustrationJobRecordV1> {
    return await illustrationJobStore.transitionJob({
        jobId: job.jobId,
        expectedVersion: job.version,
        to,
        patch: {
            idempotencyKey: recoveryKey(epoch, job, step),
            workerEpoch: epoch,
            ...(error ? { error } : { error: null }),
        },
    })
}

async function settleRecoveryContext(
    job: IllustrationJobRecordV1,
    context: Exclude<IllustrationJobContextResult, { kind: 'valid' }>,
    epoch: number,
): Promise<void> {
    const desired = job.state === 'generating' && context.kind === 'corrupt'
        ? 'stale'
        : context.kind
    if (!canTransition('job', job.state, desired)) return
    await transitionRecoveryJob(
        job,
        desired,
        epoch,
        `context-${desired}`,
        { code: context.kind === 'corrupt' ? `recovery_${context.reason}` : context.reason },
    )
}

async function ensureRecoveredAssetIntegrity(job: IllustrationJobRecordV1): Promise<boolean> {
    if (!job.assetId || !job.target) return false
    try {
        let integrity = await inspectInlayAssetIntegrity(job.assetId)
        if (integrity.status === 'repairable') {
            await repairInlayAssetRecords(job.assetId, {
                charId: job.target.chaId,
                chatId: job.target.conversationId,
            })
            integrity = await inspectInlayAssetIntegrity(job.assetId)
        }
        return integrity.status === 'complete'
    } catch {
        return false
    }
}

async function settleUnverifiableAsset(
    job: IllustrationJobRecordV1,
    epoch: number,
): Promise<void> {
    if (!canTransition('job', job.state, 'uncertain')) return
    await transitionRecoveryJob(job, 'uncertain', epoch, 'asset-unverifiable', {
        code: 'asset_unverifiable',
        certainty: 'uncertain',
    })
}

async function recoverAssetPipeline(
    initial: IllustrationJobRecordV1,
    epoch: number,
): Promise<void> {
    let job = initial
    if (job.state === 'committing') {
        if (!job.assetId || !job.target) {
            await settleUnverifiableAsset(job, epoch)
            return
        }
        await reconcileIllustrationCommittingJob(job.jobId, epoch, true)
        return
    }

    if (!(await ensureRecoveredAssetIntegrity(job))) {
        await settleUnverifiableAsset(job, epoch)
        return
    }

    if (job.state === 'generating' && job.cancelRequestedAt === undefined) {
        const context = await resolveIllustrationJobContext(job)
        if (context.kind !== 'valid') {
            await settleRecoveryContext(job, context, epoch)
            return
        }
    }

    if (job.state === 'generating' || job.state === 'cancel_requested') {
        job = await transitionRecoveryJob(job, 'asset_writing', epoch, 'asset-writing')
    }
    if (job.state === 'asset_writing') {
        job = await transitionRecoveryJob(job, 'asset_ready', epoch, 'asset-ready')
    }
    if (job.state !== 'asset_ready') return

    const latest = (await illustrationJobStore.getJob(job.jobId)) ?? job
    if (latest.cancelRequestedAt !== undefined) {
        await illustrationJobStore.requestCancel({
            jobId: latest.jobId,
            expectedVersion: latest.version,
        })
        return
    }
    await commitIllustrationAssetReadyJob(latest.jobId, epoch, true)
}

async function recoverPreDispatchJob(job: IllustrationJobRecordV1, epoch: number): Promise<void> {
    if (job.cancelRequestedAt !== undefined) {
        await illustrationJobStore.requestCancel({ jobId: job.jobId, expectedVersion: job.version })
        return
    }
    if (job.state === 'prepared') {
        const [turn, manifest] = await Promise.all([
            illustrationJobStore.getTurn(job.turnId),
            illustrationJobStore.getManifest(job.turnId),
        ])
        const entry = manifest?.jobs.find((candidate) => candidate.jobId === job.jobId)
        if (
            turn
            && !isTerminalTurnState(turn.state)
            && entry?.slotToken === job.slotToken
            && manifest?.sourceRevisionHash === job.sourceRevisionHash
        ) return
        await transitionRecoveryJob(job, 'corrupt', epoch, 'orphan-prepared', {
            code: 'prepared_job_without_projection',
        })
        return
    }

    const context = await resolveIllustrationJobContext(job)
    if (context.kind !== 'valid') {
        await settleRecoveryContext(job, context, epoch)
        return
    }

    if (job.state === 'queued') {
        // The live executor applies the resumable configuration gate uniformly,
        // then measures structured records. Recovery only handles physical
        // legacy records here so it never adds a retroactive tokenizer dependency.
        if (!isLegacyIllustrationStoredPrompt(job.prompt)) return
        const database = getDatabase()
        const fingerprint = await computeNaiSettingsFingerprint(database)
        if (database.sdProvider !== 'novelai' || fingerprint !== job.settingsFingerprint) {
            await transitionRecoveryJob(job, 'blocked_config', epoch, 'blocked-config', {
                code: database.sdProvider === 'novelai'
                    ? 'settings_fingerprint_mismatch'
                    : 'unsupported_provider',
            })
        }
        return
    }
    if (job.state === 'blocked_config') {
        const database = getDatabase()
        const fingerprint = await computeNaiSettingsFingerprint(database)
        if (
            database.sdProvider === 'novelai'
            && fingerprint === job.settingsFingerprint
        ) {
            await transitionRecoveryJob(job, 'queued', epoch, 'resume-config')
        }
    }
}

async function recoverJob(job: IllustrationJobRecordV1, epoch: number): Promise<void> {
    if (isTerminalJobState(job.state)) return
    // Image Revision V1: revision child jobs use a dedicated recovery path (inlay
    // swap/insert + reference CAS). prompt_ready children are stable — they await an
    // explicit user image confirmation and need no recovery action.
    if (job.revision) {
        if (job.state === 'prompt_ready' || job.state === 'awaiting_prompt') return
        await recoverRevisionJob(job, epoch)
        return
    }
    if (['prepared', 'awaiting_prompt', 'queued', 'blocked_config'].includes(job.state)) {
        await recoverPreDispatchJob(job, epoch)
        return
    }
    if (['generating', 'cancel_requested', 'asset_writing', 'asset_ready', 'committing'].includes(job.state)) {
        await recoverAssetPipeline(job, epoch)
    }
}

export async function runIllustrationRecovery(): Promise<IllustrationRecoverySummary> {
    if (!(await isIllustrationFeatureEnabled())) {
        return { turnsExamined: 0, jobsExamined: 0 }
    }
    return await withIllustrationWorkerEpoch(async (epoch) => {
        const turns = (await illustrationJobStore.listTurns())
            .filter((turn) => !isTerminalTurnState(turn.state))
        for (const turn of turns) {
            try {
                if (turn.state === 'prepared' || turn.state === 'blocked_capture') {
                    await recoverIllustrationCapture(turn.turnId)
                }
                const current = await illustrationJobStore.getTurn(turn.turnId)
                if (current?.state === 'awaiting_plan' || current?.state === 'awaiting_prompt') {
                    await recoverIllustrationProjection(turn.turnId, epoch)
                }
            } catch {
                console.warn('[illustration] recovery left one turn unchanged')
            }
        }

        const jobs = (await illustrationJobStore.listJobRecords())
            .filter((job) => !isTerminalJobState(job.state))
        for (const job of jobs) {
            try {
                const latest = await illustrationJobStore.getJob(job.jobId)
                if (latest && !isTerminalJobState(latest.state)) await recoverJob(latest, epoch)
            } catch {
                console.warn('[illustration] recovery left one job unchanged')
            }
        }

        for (const turn of turns) {
            try {
                await illustrationJobStore.finalizeTurnAfterJobs(turn.turnId)
            } catch {
                console.warn('[illustration] recovery could not finalize one turn')
            }
        }
        return { turnsExamined: turns.length, jobsExamined: jobs.length }
    })
}
