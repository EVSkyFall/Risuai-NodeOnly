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
    ['awaiting_prompt', 'stale'],
    ['awaiting_prompt', 'corrupt'],
    ['queued', 'generating'],
    ['queued', 'blocked_config'],
    ['queued', 'corrupt'],
    ['blocked_config', 'queued'],
    ['blocked_config', 'cancelled'],
    ['blocked_config', 'stale'],
    ['blocked_config', 'corrupt'],
    ['generating', 'asset_writing'],
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

    test('pins the complete set of 36 allowed general transitions', () => {
        const allStates = Object.keys(JOB_TRANSITIONS) as IllustrationJobState[]
        const expected = new Set(allowedJobEdges.map(([from, to]) => `${from}->${to}`))
        expect(expected.size).toBe(36)

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
            'stale',
            'corrupt',
        ])
        for (const from of terminalStates) {
            for (const to of allStates) {
                expect(canTransition('turn', from, to), `${from} -> ${to}`).toBe(false)
            }
        }
    })
})
