import { IllustrationLedgerTransitionError } from './errors'
import type { IllustrationJobState, IllustrationTurnState } from './types'

export const JOB_TRANSITIONS: Readonly<Record<IllustrationJobState, readonly IllustrationJobState[]>> = {
    prepared: [
        'awaiting_prompt',
        'cancelled',
        'stale', // §5-8 / §8.3 / §13: edited or moved target before dispatch.
        'corrupt', // §7.3 / §8.2: broken projection or duplicate anchor before dispatch.
    ],
    awaiting_prompt: [
        'queued',
        'agent_blocked_retryable', // Report §8: retryable Tagger failure is durably blocked.
        'agent_blocked', // Report §8: non-retryable/exhausted Tagger failure is durably blocked.
        'cancelled',
        'stale', // §5-8 / §8.3 / §13: edited or moved target before dispatch.
        'corrupt', // §7.3 / §8.2: broken projection or duplicate anchor before dispatch.
    ],
    agent_blocked_retryable: [
        'awaiting_prompt', // Report §8: only retryAgentFailure may reopen the Tagger.
        'cancelled', // Report §8: blocked Agent work remains manually cancellable.
        'stale', // Report §8: edit-staleness closure mirrors blocked_config.
        'corrupt', // Report §8: projection-corruption closure mirrors blocked_config.
    ],
    agent_blocked: [
        'awaiting_prompt', // Report §8: only retryAgentFailure may reopen the Tagger.
        'cancelled', // Report §8: blocked Agent work remains manually cancellable.
        'stale', // Report §8: edit-staleness closure mirrors blocked_config.
        'corrupt', // Report §8: projection-corruption closure mirrors blocked_config.
    ],
    queued: [
        'generating',
        'blocked_config',
        'failed', // Image prompt contract rejection before provider dispatch.
        'cancelled',
        'stale',
        'corrupt', // §7.3 / §8.2: broken projection or duplicate anchor before dispatch.
    ],
    generating: [
        'asset_writing',
        'blocked_config', // Only before provider dispatch when configuration drift is detected.
        'failed',
        'stale',
        'uncertain',
        'cancel_requested',
    ],
    cancel_requested: ['asset_writing', 'failed', 'uncertain', 'cancelled'],
    blocked_config: [
        'queued',
        'cancelled',
        'stale', // §5-8 / §8.3 / §13: edited or moved target while configuration is blocked.
        'corrupt', // §7.3 / §8.2: broken projection or duplicate anchor while blocked.
    ],
    asset_writing: ['asset_ready', 'uncertain'],
    asset_ready: [
        'committing',
        'cancelled',
        'stale',
        'uncertain', // §13: neither asset nor provider result can be verified during reconcile.
    ],
    committing: [
        'committed',
        'stale',
        'corrupt',
        'uncertain', // §13: neither asset nor provider result can be verified during reconcile.
    ],
    committed: [],
    failed: [],
    stale: [],
    uncertain: [],
    cancelled: [],
    corrupt: [],
}

export const TURN_TRANSITIONS: Readonly<Record<IllustrationTurnState, readonly IllustrationTurnState[]>> = {
    prepared: ['awaiting_plan', 'blocked_capture', 'cancelled', 'stale', 'corrupt'],
    blocked_capture: ['awaiting_plan', 'cancelled', 'stale', 'corrupt'],
    awaiting_plan: [
        'awaiting_prompt',
        'agent_blocked_retryable', // Report §8: retryable Planner failure is durably blocked.
        'agent_blocked', // Report §8: non-retryable/exhausted Planner failure is durably blocked.
        'blocked_manifest',
        'no_scenes',
        'cancelled',
        'stale',
        'corrupt',
    ],
    agent_blocked_retryable: [
        'awaiting_plan', // Report §8: only retryAgentFailure may reopen the Planner.
        'cancelled', // Gate 4a decision 1A: blocked Planner work is cancellable.
        'stale', // Report §8: edit-staleness closure mirrors blocked_config.
        'corrupt', // Report §8: capture/projection corruption remains fail-closed.
    ],
    agent_blocked: [
        'awaiting_plan', // Report §8: only retryAgentFailure may reopen the Planner.
        'cancelled', // Gate 4a decision 1A: blocked Planner work is cancellable.
        'stale', // Report §8: edit-staleness closure mirrors blocked_config.
        'corrupt', // Report §8: capture/projection corruption remains fail-closed.
    ],
    awaiting_prompt: ['completed', 'stale', 'corrupt'],
    blocked_manifest: [],
    no_scenes: [],
    completed: [],
    cancelled: [],
    stale: [],
    corrupt: [],
}

const terminalJobStates = new Set<IllustrationJobState>([
    'committed',
    'failed',
    'stale',
    'uncertain',
    'cancelled',
    'corrupt',
])

const prunableJobStates = new Set<IllustrationJobState>([
    'committed',
    'failed',
    'stale',
    'cancelled',
    'corrupt',
])

const terminalTurnStates = new Set<IllustrationTurnState>([
    'blocked_manifest',
    'no_scenes',
    'completed',
    'cancelled',
    'stale',
    'corrupt',
])

export function canTransition(
    kind: 'job',
    from: IllustrationJobState,
    to: IllustrationJobState,
): boolean
export function canTransition(
    kind: 'turn',
    from: IllustrationTurnState,
    to: IllustrationTurnState,
): boolean
export function canTransition(kind: 'job' | 'turn', from: string, to: string): boolean {
    const transitions = kind === 'job' ? JOB_TRANSITIONS : TURN_TRANSITIONS
    return (transitions as Record<string, readonly string[]>)[from]?.includes(to) ?? false
}

export function assertTransition(
    kind: 'job',
    from: IllustrationJobState,
    to: IllustrationJobState,
): void
export function assertTransition(
    kind: 'turn',
    from: IllustrationTurnState,
    to: IllustrationTurnState,
): void
export function assertTransition(kind: 'job' | 'turn', from: string, to: string): void {
    const transitions = kind === 'job' ? JOB_TRANSITIONS : TURN_TRANSITIONS
    if (!((transitions as Record<string, readonly string[]>)[from]?.includes(to) ?? false)) {
        throw new IllustrationLedgerTransitionError(kind, from, to)
    }
}

export function isTerminalJobState(state: IllustrationJobState): boolean {
    return terminalJobStates.has(state)
}

export function isPrunableJobState(state: IllustrationJobState): boolean {
    return prunableJobStates.has(state)
}

export function isTerminalTurnState(state: IllustrationTurnState): boolean {
    return terminalTurnStates.has(state)
}

export const isPrunableTurnState = isTerminalTurnState
