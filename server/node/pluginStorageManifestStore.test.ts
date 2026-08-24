import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

const { createPluginStorageManifestStore } = require('./pluginStorageManifestStore.cjs')
const { stripPluginStorageManifest, hydratePluginStorageManifest } = require('./pluginStorageManifestMigration.cjs')

describe('plugin storage manifest store', () => {
    it('round-trips arbitrary JSON values and preserves key order', () => {
        const db = new Database(':memory:')
        const store = createPluginStorageManifestStore(db, { maxCacheBytes: 0 })
        const source = { z: { nested: ['한글', 1, true, null] }, a: 'value', empty: {} }
        const descriptor = store.putSnapshot(source)
        expect(store.verifySnapshot(descriptor.id)).toMatchObject({ ok: true, count: 3 })
        expect(store.loadSnapshot(descriptor.id)).toEqual(source)
        expect(Object.keys(store.loadSnapshot(descriptor.id))).toEqual(Object.keys(source))
        db.close()
    })

    it('creates copy-on-write snapshots for loaded keys and prunes the superseded revision', () => {
        const db = new Database(':memory:')
        const store = createPluginStorageManifestStore(db)
        const first = store.putSnapshot({ keep: { n: 1 }, edit: 'old', remove: 3 })
        const second = store.applyLoadedValues(first.id, { edit: 'new', added: [1, 2] }, ['edit', 'remove'])
        expect(() => store.loadSnapshot(first.id)).toThrow(/missing/i)
        expect(store.loadSnapshot(second.id)).toEqual({ keep: { n: 1 }, edit: 'new', added: [1, 2] })
        expect(store.loadSubset(second.id, ['keep', 'added'])).toEqual({ keep: { n: 1 }, added: [1, 2] })
        expect(store.stats()).toMatchObject({ snapshots: 1, values: 3 })
        db.close()
    })

    it('returns defensive value copies and rejects stale snapshot edits', () => {
        const db = new Database(':memory:')
        const store = createPluginStorageManifestStore(db)
        const first = store.putSnapshot({ nested: { count: 1 } })
        const value = store.loadSnapshot(first.id)
        value.nested.count = 99
        expect(store.loadSnapshot(first.id)).toEqual({ nested: { count: 1 } })

        const second = store.applyLoadedValues(first.id, { nested: { count: 2 } }, ['nested'])
        expect(() => store.applyLoadedValues(first.id, {}, [])).toThrow(/conflict/i)
        expect(store.getLiveDescriptor()).toEqual(second)
        db.close()
    })

    it('strips client payload and restores an exact legacy database', () => {
        const db = new Database(':memory:')
        const store = createPluginStorageManifestStore(db)
        const source = { characters: [], pluginCustomStorage: { one: { a: 1 }, two: '둘' } }
        const stripped = stripPluginStorageManifest(source, store).db
        expect(stripped.pluginCustomStorage).toEqual({})
        expect(stripped.pluginStorageManifest.count).toBe(2)
        expect(source.pluginCustomStorage).toEqual({ one: { a: 1 }, two: '둘' })
        expect(hydratePluginStorageManifest(stripped, store)).toEqual(source)
        db.close()
    })

    it('refuses hydration after snapshot corruption', () => {
        const db = new Database(':memory:')
        const store = createPluginStorageManifestStore(db)
        const stripped = stripPluginStorageManifest({ pluginCustomStorage: { a: 1 } }, store).db
        db.prepare('UPDATE plugin_storage_snapshots SET map_payload = ? WHERE snapshot_id = ?')
            .run(Buffer.from('broken'), stripped.pluginStorageManifest.id)
        expect(() => hydratePluginStorageManifest(stripped, store)).toThrow(/corrupt|checksum/i)
        db.close()
    })
})
