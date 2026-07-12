import { describe, expect, it } from 'vitest'
import { commitMainRequestSnapshot, getReplayableSnapshot, stageMainRequestSnapshot } from './requestReplay'

const snap = (id: string) => ({
    formated: [{ role: 'user' as const, content: 'hello' }],
    biasString: [['needle', 0.25]] as [string, number][],
    staticModel: '',
    tools: [],
    forGenerationId: id,
    capturedAt: 123
})

describe('request replay snapshot', () => {
    it('staged snapshots are not replayable until committed', () => {
        const a = snap('generation-a')
        stageMainRequestSnapshot(a)
        expect(getReplayableSnapshot('generation-a')).toBeNull()

        commitMainRequestSnapshot('generation-a')
        expect(getReplayableSnapshot(undefined)).toBeNull()
        expect(getReplayableSnapshot('generation-b')).toBeNull()
        expect(getReplayableSnapshot('generation-a')).toBe(a)
        expect(getReplayableSnapshot('generation-a')?.biasString).toEqual([['needle', 0.25]])
    })

    it('a failed (uncommitted) attempt does not clobber the committed snapshot', () => {
        const a = snap('generation-a')
        stageMainRequestSnapshot(a)
        commitMainRequestSnapshot('generation-a')

        // dispatched but its request failed — commit never happens for it
        stageMainRequestSnapshot(snap('generation-b'))
        expect(getReplayableSnapshot('generation-b')).toBeNull()
        expect(getReplayableSnapshot('generation-a')).toBe(a)
    })

    it('an unrelated send cannot commit a stale pending from a failed attempt', () => {
        const a = snap('generation-a')
        stageMainRequestSnapshot(a)
        commitMainRequestSnapshot('generation-a')

        stageMainRequestSnapshot(snap('generation-b'))
        // e.g. a preview/continue send reaches the commit site without staging
        commitMainRequestSnapshot('generation-preview')
        expect(getReplayableSnapshot('generation-b')).toBeNull()
        expect(getReplayableSnapshot('generation-a')).toBe(a)
    })
})
