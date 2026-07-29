// @vitest-environment node

import { describe, expect, it } from 'vitest'
import pkg from './worldReplacementGate.cjs'

const { createComfyWorldReplacementGate } = pkg as any

describe('Comfy world-replacement gate', () => {
  it('rejects new relays and drains an existing relay before replacement work starts', async () => {
    let paused = false
    const events: string[] = []
    const gate = createComfyWorldReplacementGate({
      orchestrator: {
        isWorldReplacementPaused: () => paused,
        pauseForWorldReplacement: async () => {
          paused = true
          events.push('paused')
        },
        resumeAfterWorldReplacement: async () => {
          paused = false
          events.push('resumed')
        },
      },
    })

    let releaseRelay!: () => void
    const relay = gate.withRelayOperation(async () => {
      events.push('relay-started')
      await new Promise<void>(resolve => { releaseRelay = resolve })
      events.push('relay-finished')
    })
    await Promise.resolve()

    const replacement = gate.withWorldReplacement(async () => {
      events.push('replacement-started')
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(['relay-started', 'paused'])
    await expect(gate.withRelayOperation(async () => {})).rejects.toMatchObject({
      code: 'COMFY_WORLD_REPLACING',
      httpStatus: 503,
      uncertain: false,
    })

    releaseRelay()
    await relay
    await replacement
    expect(events).toEqual([
      'relay-started',
      'paused',
      'relay-finished',
      'replacement-started',
      'resumed',
    ])
  })

  it('preserves the action result when resume and logging both fail', async () => {
    let paused = false
    const gate = createComfyWorldReplacementGate({
      logger: {
        error: () => {
          throw new Error('logger failed')
        },
      },
      orchestrator: {
        isWorldReplacementPaused: () => paused,
        pauseForWorldReplacement: async () => {
          paused = true
        },
        resumeAfterWorldReplacement: async () => {
          paused = false
          const error = new Error('cleanup busy') as NodeJS.ErrnoException
          error.code = 'EBUSY'
          throw error
        },
      },
    })

    await expect(gate.withWorldReplacement(async () => 'replacement-complete'))
      .resolves.toBe('replacement-complete')
    await expect(gate.withWorldReplacement(async () => 'next-replacement'))
      .resolves.toBe('next-replacement')
  })

  it('preserves the action error when resume also fails', async () => {
    let paused = false
    const actionError = new Error('replace failed')
    const gate = createComfyWorldReplacementGate({
      logger: { error: () => {} },
      orchestrator: {
        isWorldReplacementPaused: () => paused,
        pauseForWorldReplacement: async () => {
          paused = true
        },
        resumeAfterWorldReplacement: async () => {
          paused = false
          throw new Error('resume failed')
        },
      },
    })

    await expect(gate.withWorldReplacement(async () => {
      throw actionError
    })).rejects.toBe(actionError)
  })
})
