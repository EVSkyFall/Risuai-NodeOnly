import { IllustrationLedgerTransitionError } from './errors'
import type { IllustrationJobState, IllustrationTurnState } from './types'

export const JOB_TRANSITIONS: Readonly<Record<IllustrationJobState, readonly IllustrationJobState[]>> = {
    prepared: ['awaiting_prompt', 'cancelled'],
    awaiting_prompt: ['queued', 'cancelled'],
    queued: ['generating', 'blocked_config', 'cancelled', 'stale'],
    generating: ['asset_writing', 'failed', 'stale', 'uncertain', 'cancel_requested'],
    cancel_requested: ['asset_writing', 'failed', 'uncertain', 'cancelled'],
    blocked_config: ['queued', 'cancelled'],
    asset_writing: ['asset_ready', 'uncertain'],
    asset_ready: ['committing', 'cancelled', 'stale'],
    committing: ['committed', 'stale', 'corrupt'],
    committed: [],
    failed: [],
    stale: [],
    uncertain: [],
    cancelled: [],
    corrupt: [],
}

export const TURN_TRANSITIONS: Readonly<Record<IllustrationTurnState, readonly IllustrationTurnState[]>> = {
    prepared: ['awaiting_plan', 'blocked_capture', 'stale', 'corrupt'],
    blocked_capture: ['awaiting_plan', 'stale', 'corrupt'],
    awaiting_plan: ['awaiting_prompt', 'blocked_manifest', 'no_scenes', 'stale', 'corrupt'],
    awaiting_prompt: ['completed', 'stale', 'corrupt'],
    blocked_manifest: [],
    no_scenes: [],
    completed: [],
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
