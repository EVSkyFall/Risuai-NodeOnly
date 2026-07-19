import { describe, expect, test } from 'vitest'
import { IllustrationLedgerTransitionError } from '../errors'
import {
    JOB_TRANSITIONS,
    TURN_TRANSITIONS,
    assertTransition,
    canTransition,
    isPrunableJobState,
    isTerminalJobState,
    isTerminalTurnState,
} from '../stateMachine'
import type { IllustrationJobState, IllustrationTurnState } from '../types'

const allowedJobEdges: Array<[IllustrationJobState, IllustrationJobState]> = [
    ['prepared', 'awaiting_prompt'],
    ['prepared', 'stale'],
    ['prepared', 'corrupt'],
    ['awaiting_prompt', 'queued'],
    ['awaiting_prompt', 'prompt_ready'], // Image Revision V1: retag child Tagger supply.
    ['awaiting_prompt', 'agent_blocked_retryable'], // Report §8: retryable Tagger failure.
    ['awaiting_prompt', 'agent_blocked'], // Report §8: hard/exhausted Tagger failure.
    ['awaiting_prompt', 'stale'],
    ['awaiting_prompt', 'corrupt'],
    ['prompt_ready', 'queued'], // Image Revision V1: enqueueRevisionImage only.
    ['prompt_ready', 'cancelled'],
    ['prompt_ready', 'stale'],
    ['prompt_ready', 'corrupt'],
    ['agent_blocked_retryable', 'awaiting_prompt'], // Report §8: retryAgentFailure only.
    ['agent_blocked_retryable', 'cancelled'], // Report §8: blocked work is cancellable.
    ['agent_blocked_retryable', 'stale'], // Report §8: edit-staleness closure.
    ['agent_blocked_retryable', 'corrupt'], // Report §8: corrupt closure.
    ['agent_blocked', 'awaiting_prompt'], // Report §8: confirmed manual retry only.
    ['agent_blocked', 'cancelled'], // Report §8: blocked work is cancellable.
    ['agent_blocked', 'stale'], // Report §8: edit-staleness closure.
    ['agent_blocked', 'corrupt'], // Report §8: corrupt closure.
    ['queued', 'generating'],
    ['queued', 'blocked_config'],
    ['queued', 'failed'],
    ['queued', 'corrupt'],
    ['blocked_config', 'queued'],
    ['blocked_config', 'cancelled'],
    ['blocked_config', 'stale'],
    ['blocked_config', 'corrupt'],
    ['generating', 'asset_writing'],
    ['generating', 'blocked_config'],
    ['generating', 'failed'],
    ['generating', 'stale'],
    ['generating', 'uncertain'],
    ['asset_writing', 'asset_ready'],
    ['asset_ready', 'committing'],
    ['asset_ready', 'cancelled'],
    ['asset_ready', 'stale'],
    ['asset_ready', 'uncertain'],
    ['committing', 'committed'],
    ['committing', 'uncertain'],
    ['prepared', 'cancelled'],
    ['awaiting_prompt', 'cancelled'],
    ['queued', 'cancelled'],
    ['generating', 'cancel_requested'],
    ['cancel_requested', 'asset_writing'],
    ['cancel_requested', 'failed'],
    ['cancel_requested', 'uncertain'],
    ['cancel_requested', 'cancelled'],
    ['asset_writing', 'uncertain'],
    ['committing', 'stale'],
    ['queued', 'stale'],
    ['committing', 'corrupt'],
]

const forbiddenJobEdges: Array<[IllustrationJobState, IllustrationJobState]> = [
    ['prepared', 'generating'],
    ['queued', 'committed'],
    ['committed', 'queued'],
    ['generating', 'queued'],
    ['cancelled', 'queued'],
    ['uncertain', 'queued'],
]

describe('illustration job transition matrix', () => {
    test.each(allowedJobEdges)('allows %s -> %s', (from, to) => {
        expect(canTransition('job', from, to)).toBe(true)
        expect(() => assertTransition('job', from, to)).not.toThrow()
    })

    test.each(forbiddenJobEdges)('rejects %s -> %s', (from, to) => {
        expect(canTransition('job', from, to)).toBe(false)
        expect(() => assertTransition('job', from, to)).toThrow(IllustrationLedgerTransitionError)
    })

    test('pins the complete set of 53 allowed general transitions', () => {
        const allStates = Object.keys(JOB_TRANSITIONS) as IllustrationJobState[]
        const expected = new Set(allowedJobEdges.map(([from, to]) => `${from}->${to}`))
        expect(expected.size).toBe(53)

        for (const from of allStates) {
            for (const to of allStates) {
                expect(canTransition('job', from, to), `${from} -> ${to}`)
                    .toBe(expected.has(`${from}->${to}`))
            }
        }
    })

    test('keeps uncertain terminal for automation but protected from pruning', () => {
        expect(isTerminalJobState('uncertain')).toBe(true)
        expect(isPrunableJobState('uncertain')).toBe(false)
        expect(isPrunableJobState('failed')).toBe(true)
    })

    test('gives every terminal job state zero outgoing general transitions', () => {
        const allStates = Object.keys(JOB_TRANSITIONS) as IllustrationJobState[]
        const terminalStates = allStates.filter(isTerminalJobState)
        expect(terminalStates).toEqual([
            'committed',
            'failed',
            'stale',
            'uncertain',
            'cancelled',
            'corrupt',
        ])
        for (const from of terminalStates) {
            for (const to of allStates) {
                expect(canTransition('job', from, to), `${from} -> ${to}`).toBe(false)
            }
        }
    })
})

describe('illustration turn transition extension', () => {
    const allowedTurnEdges: Array<[IllustrationTurnState, IllustrationTurnState]> = [
        ['prepared', 'awaiting_plan'],
        ['prepared', 'blocked_capture'],
        ['prepared', 'cancelled'],
        ['prepared', 'stale'],
        ['prepared', 'corrupt'],
        ['blocked_capture', 'awaiting_plan'],
        ['blocked_capture', 'cancelled'],
        ['blocked_capture', 'stale'],
        ['blocked_capture', 'corrupt'],
        ['awaiting_plan', 'awaiting_prompt'],
        ['awaiting_plan', 'agent_blocked_retryable'], // Report §8: retryable Planner failure.
        ['awaiting_plan', 'agent_blocked'], // Report §8: hard/exhausted Planner failure.
        ['awaiting_plan', 'blocked_manifest'],
        ['awaiting_plan', 'no_scenes'],
        ['awaiting_plan', 'cancelled'],
        ['awaiting_plan', 'stale'],
        ['awaiting_plan', 'corrupt'],
        ['agent_blocked_retryable', 'awaiting_plan'], // Report §8: retryAgentFailure only.
        ['agent_blocked_retryable', 'cancelled'], // Decision 1A: blocked turn cancellation.
        ['agent_blocked_retryable', 'stale'], // Report §8: edit-staleness closure.
        ['agent_blocked_retryable', 'corrupt'], // Report §8: corrupt closure.
        ['agent_blocked', 'awaiting_plan'], // Report §8: confirmed manual retry only.
        ['agent_blocked', 'cancelled'], // Decision 1A: blocked turn cancellation.
        ['agent_blocked', 'stale'], // Report §8: edit-staleness closure.
        ['agent_blocked', 'corrupt'], // Report §8: corrupt closure.
        ['awaiting_prompt', 'completed'],
        ['awaiting_prompt', 'stale'],
        ['awaiting_prompt', 'corrupt'],
    ]

    test('models capture retry and a single normal completion state', () => {
        expect(canTransition('turn', 'prepared', 'blocked_capture')).toBe(true)
        expect(canTransition('turn', 'blocked_capture', 'awaiting_plan')).toBe(true)
        expect(canTransition('turn', 'awaiting_plan', 'awaiting_prompt')).toBe(true)
        expect(canTransition('turn', 'awaiting_prompt', 'completed')).toBe(true)
        expect(canTransition('turn', 'completed', 'awaiting_plan')).toBe(false)
    })

    test('gives every terminal turn state zero outgoing transitions', () => {
        const allStates = Object.keys(TURN_TRANSITIONS) as IllustrationTurnState[]
        const terminalStates = allStates.filter(isTerminalTurnState)
        expect(terminalStates).toEqual([
            'blocked_manifest',
            'no_scenes',
            'completed',
            'cancelled',
            'stale',
            'corrupt',
        ])
        for (const from of terminalStates) {
            for (const to of allStates) {
                expect(canTransition('turn', from, to), `${from} -> ${to}`).toBe(false)
            }
        }
    })

    test('pins the complete set of 28 allowed turn transitions', () => {
        const allStates = Object.keys(TURN_TRANSITIONS) as IllustrationTurnState[]
        const expected = new Set(allowedTurnEdges.map(([from, to]) => `${from}->${to}`))
        expect(expected.size).toBe(28)
        for (const from of allStates) {
            for (const to of allStates) {
                expect(canTransition('turn', from, to), `${from} -> ${to}`)
                    .toBe(expected.has(`${from}->${to}`))
            }
        }
    })
})
