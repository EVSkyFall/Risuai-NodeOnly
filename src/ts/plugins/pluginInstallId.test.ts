import { describe, expect, it } from 'vitest'
import {
    INSTALL_ID_PATTERN,
    backfillInstallIds,
    commitImportedPlugin,
    isValidInstallId,
    newInstallId,
    preserveInstallId,
    type PluginInstallIdentity,
} from './pluginInstallId'

interface FakePlugin extends PluginInstallIdentity {
    script: string
}

const mk = (name: string, script = 'x', installId?: string): FakePlugin => ({ name, script, installId })

describe('installId minting', () => {
    it('mints a namespace-shaped uuid', () => {
        const id = newInstallId()
        expect(INSTALL_ID_PATTERN.test(id)).toBe(true)
        expect(isValidInstallId(id)).toBe(true)
        expect(newInstallId()).not.toBe(id)
    })

    it('rejects anything that is not a lowercase uuid', () => {
        expect(isValidInstallId('')).toBe(false)
        expect(isValidInstallId(undefined)).toBe(false)
        expect(isValidInstallId('not-a-uuid')).toBe(false)
        // Uppercase would still match [0-9a-f-]{36} on the server? No — it must not.
        expect(isValidInstallId('11111111-1111-4111-8111-11111111111A')).toBe(false)
    })
})

describe('preserveInstallId', () => {
    it('mints when there is no predecessor', () => {
        const next = mk('p')
        preserveInstallId(next, null)
        expect(isValidInstallId(next.installId)).toBe(true)
    })

    it('carries the predecessor id across an update', () => {
        const previous = mk('p', 'v1', '11111111-1111-4111-8111-111111111111')
        const next = mk('p', 'v2')
        preserveInstallId(next, previous)
        expect(next.installId).toBe(previous.installId)
    })

    it('mints when the predecessor id is malformed rather than propagating garbage', () => {
        const previous = mk('p', 'v1', 'NOPE')
        const next = mk('p', 'v2')
        preserveInstallId(next, previous)
        expect(next.installId).not.toBe('NOPE')
        expect(isValidInstallId(next.installId)).toBe(true)
    })

    it('never overwrites an id the incoming record already legitimately carries', () => {
        const keep = '22222222-2222-4222-8222-222222222222'
        const next = mk('p', 'v2', keep)
        preserveInstallId(next, null)
        expect(next.installId).toBe(keep)
    })
})

describe('backfillInstallIds', () => {
    it('assigns exactly the missing ids and preserves order', () => {
        const kept = '33333333-3333-4333-8333-333333333333'
        const plugins = [mk('a'), mk('b', 'x', kept), mk('c')]
        const assigned = backfillInstallIds(plugins)

        expect(assigned).toBe(2)
        expect(plugins.map((p) => p.name)).toEqual(['a', 'b', 'c'])
        expect(plugins[1].installId).toBe(kept)
        expect(isValidInstallId(plugins[0].installId)).toBe(true)
        expect(isValidInstallId(plugins[2].installId)).toBe(true)
        expect(plugins[0].installId).not.toBe(plugins[2].installId)
    })

    it('is idempotent — a second pass writes nothing', () => {
        const plugins = [mk('a'), mk('b')]
        expect(backfillInstallIds(plugins)).toBe(2)
        const snapshot = plugins.map((p) => p.installId)
        expect(backfillInstallIds(plugins)).toBe(0)
        expect(plugins.map((p) => p.installId)).toEqual(snapshot)
    })

    it('tolerates a null/absent list', () => {
        expect(backfillInstallIds(undefined as any)).toBe(0)
        expect(backfillInstallIds(null as any)).toBe(0)
    })
})

describe('commitImportedPlugin', () => {
    it('mints an id on a fresh install and appends', () => {
        const plugins: FakePlugin[] = []
        const incoming = mk('new', 'v1')
        commitImportedPlugin(plugins, incoming, -1, { isUpdate: false, isHotReload: false })

        expect(plugins).toHaveLength(1)
        expect(isValidInstallId(plugins[0].installId)).toBe(true)
    })

    it('PRESERVES the installId across an update — durable storage must not be orphaned', () => {
        const original = '44444444-4444-4444-8444-444444444444'
        const plugins = [mk('demo', 'v1', original)]
        const updated = mk('demo', 'v2')

        commitImportedPlugin(plugins, updated, 0, { isUpdate: true, isHotReload: false })

        expect(plugins).toHaveLength(1)
        expect(plugins[0].script).toBe('v2')
        expect(plugins[0].installId).toBe(original)
    })

    it('preserves the installId on a re-import over an existing plugin too', () => {
        const original = '55555555-5555-4555-8555-555555555555'
        const plugins = [mk('demo', 'v1', original)]
        commitImportedPlugin(plugins, mk('demo', 'v9'), 0, { isUpdate: false, isHotReload: false })
        expect(plugins[0].installId).toBe(original)
    })

    it('does not append an unknown plugin during a plain update (upstream behaviour)', () => {
        const plugins: FakePlugin[] = []
        commitImportedPlugin(plugins, mk('ghost'), -1, { isUpdate: true, isHotReload: false })
        expect(plugins).toHaveLength(0)
    })

    it('appends an unknown plugin during a hot reload', () => {
        const plugins: FakePlugin[] = []
        commitImportedPlugin(plugins, mk('ghost'), -1, { isUpdate: true, isHotReload: true })
        expect(plugins).toHaveLength(1)
        expect(isValidInstallId(plugins[0].installId)).toBe(true)
    })
})
