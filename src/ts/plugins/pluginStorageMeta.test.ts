import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
    db: {} as any,
    persistent: new Map<string, unknown>(),
    reads: [] as string[],
    writes: [] as Array<{ key: string, value: unknown }>,
}))

vi.mock('../storage/database.svelte', () => ({
    getDatabase: () => harness.db,
}))

vi.mock('../storage/persistentKv', () => ({
    listPersistentKeys: async () => [],
    makeEncodedStorageKey: (prefix: string, key: string) => `${prefix}${encodeURIComponent(key)}.json`,
    decodeStorageKeyComponent: (key: string) => decodeURIComponent(key),
    readPersistentJson: async (key: string) => {
        harness.reads.push(key)
        const stored = harness.persistent.get(key)
        if (stored instanceof Error) throw stored
        return stored ?? null
    },
    writePersistentJson: async (key: string, value: unknown) => {
        harness.writes.push({ key, value })
        harness.persistent.set(key, value)
    },
    removePersistentKey: async () => {},
    clearPersistentPrefix: async () => {},
}))

const { recordOwner } = await import('./pluginStorageMeta')

beforeEach(() => {
    harness.db = {}
    harness.persistent.clear()
    harness.reads.length = 0
    harness.writes.length = 0
    localStorage.clear()
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('recordOwner', () => {
    test('save records first claim, preserves the same-owner reference, and records owner changes', () => {
        const now = vi.spyOn(Date, 'now')
            .mockReturnValueOnce(100)
            .mockReturnValueOnce(200)

        expect(recordOwner('save', 'shared-key', 'plugin-a')).toBeUndefined()
        const first = harness.db.pluginStorageMeta['shared-key']
        expect(first).toEqual({ plugin: 'plugin-a', updatedAt: 100 })

        expect(recordOwner('save', 'shared-key', 'plugin-a')).toBeUndefined()
        expect(harness.db.pluginStorageMeta['shared-key']).toBe(first)
        expect(now).toHaveBeenCalledTimes(1)

        expect(recordOwner('save', 'shared-key', 'plugin-b')).toBeUndefined()
        expect(harness.db.pluginStorageMeta['shared-key']).toEqual({ plugin: 'plugin-b', updatedAt: 200 })
        expect(harness.db.pluginStorageMeta['shared-key']).not.toBe(first)
        expect(now).toHaveBeenCalledTimes(2)
    })

    test('local records first claim, skips same-owner storage churn, and records owner changes', () => {
        const now = vi.spyOn(Date, 'now')
            .mockReturnValueOnce(300)
            .mockReturnValueOnce(400)
        const setItem = vi.spyOn(Storage.prototype, 'setItem')

        expect(recordOwner('local', 'shared-key', 'plugin-a')).toBeUndefined()
        const firstRaw = localStorage.getItem('risu_plugin_storage_owners')
        expect(JSON.parse(firstRaw ?? '{}')['shared-key']).toEqual({ plugin: 'plugin-a', updatedAt: 300 })
        expect(setItem).toHaveBeenCalledTimes(1)

        expect(recordOwner('local', 'shared-key', 'plugin-a')).toBeUndefined()
        expect(localStorage.getItem('risu_plugin_storage_owners')).toBe(firstRaw)
        expect(setItem).toHaveBeenCalledTimes(1)
        expect(now).toHaveBeenCalledTimes(1)

        expect(recordOwner('local', 'shared-key', 'plugin-b')).toBeUndefined()
        expect(JSON.parse(localStorage.getItem('risu_plugin_storage_owners') ?? '{}')['shared-key']).toEqual({ plugin: 'plugin-b', updatedAt: 400 })
        expect(setItem).toHaveBeenCalledTimes(2)
        expect(now).toHaveBeenCalledTimes(2)
    })

    test('idb records first claim, skips same-owner writes, and records owner changes', async () => {
        const now = vi.spyOn(Date, 'now')
            .mockReturnValueOnce(500)
            .mockReturnValueOnce(600)
        const storageKey = 'cache/plugin-storage-meta/shared-key.json'

        const firstClaim = recordOwner('idb', 'shared-key', 'plugin-a')
        expect(firstClaim).toBeInstanceOf(Promise)
        await firstClaim
        const first = harness.persistent.get(storageKey)
        expect(first).toEqual({ plugin: 'plugin-a', updatedAt: 500 })
        expect(harness.writes).toHaveLength(1)

        const repeatedClaim = recordOwner('idb', 'shared-key', 'plugin-a')
        expect(repeatedClaim).toBeInstanceOf(Promise)
        await repeatedClaim
        expect(harness.persistent.get(storageKey)).toBe(first)
        expect(harness.writes).toHaveLength(1)
        expect(now).toHaveBeenCalledTimes(1)

        const ownerChange = recordOwner('idb', 'shared-key', 'plugin-b')
        expect(ownerChange).toBeInstanceOf(Promise)
        await ownerChange
        expect(harness.persistent.get(storageKey)).toEqual({ plugin: 'plugin-b', updatedAt: 600 })
        expect(harness.persistent.get(storageKey)).not.toBe(first)
        expect(harness.writes).toHaveLength(2)
        expect(now).toHaveBeenCalledTimes(2)
    })

    test('idb self-heals an unreadable record with a blind overwrite instead of rejecting', async () => {
        vi.spyOn(Date, 'now').mockReturnValueOnce(700)
        const storageKey = 'cache/plugin-storage-meta/broken-key.json'
        harness.persistent.set(storageKey, new Error('corrupt record'))

        await expect(recordOwner('idb', 'broken-key', 'plugin-a')).resolves.toBeUndefined()
        expect(harness.persistent.get(storageKey)).toEqual({ plugin: 'plugin-a', updatedAt: 700 })
        expect(harness.writes).toHaveLength(1)
    })
})
