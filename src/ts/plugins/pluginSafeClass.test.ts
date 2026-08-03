import { beforeEach, describe, expect, test, vi } from 'vitest'

const fake = vi.hoisted(() => {
    const storageMap = new Map<string, Uint8Array>()
    const counters = {
        bulkReads: 0,
        perKeyReads: 0,
        lastBulkKeys: [] as string[],
    }
    let bulkRows: ((keys: string[]) => { key: string; value: Uint8Array | null }[]) | null = null
    return { storageMap, counters, get bulkRows() { return bulkRows }, set bulkRows(v) { bulkRows = v } }
})

vi.mock('../parser/parser.svelte', () => ({
    hasher: async () => 'hash',
}))

vi.mock('../globalApi.svelte', () => ({
    toGetter: <T>(value: T) => value,
    forageStorage: {
        Init: async () => {},
        keys: async (prefix: string) =>
            [...fake.storageMap.keys()].filter((key) => key.startsWith(prefix)),
        getItem: async (key: string) => {
            fake.counters.perKeyReads++
            return fake.storageMap.get(key) ?? null
        },
        getItems: async (keys: string[]) => {
            fake.counters.bulkReads++
            fake.counters.lastBulkKeys = [...keys]
            if (fake.bulkRows) return fake.bulkRows(keys)
            return keys.map((key) => ({ key, value: fake.storageMap.get(key) ?? null }))
        },
        setItem: async (key: string, value: Uint8Array) => {
            fake.storageMap.set(key, value)
        },
        removeItem: async (key: string) => {
            fake.storageMap.delete(key)
        },
    },
}))

vi.mock('./pluginStorageMeta', () => ({
    recordOwner: async () => {},
    removeOwner: async () => {},
    clearOwners: async () => {},
}))

import { SafeLocalPluginStorage } from './pluginSafeClass'
import { makeEncodedStorageKey } from '../storage/persistentKv'

const PREFIX = 'cache/plugin-storage/'
const encoder = new TextEncoder()
let sequence = 0

function rawKey(key: string) {
    return makeEncodedStorageKey(PREFIX, key)
}

function seed(key: string, value: unknown) {
    fake.storageMap.set(rawKey(key), encoder.encode(JSON.stringify(value)))
}

function uniqueKey(label: string) {
    sequence++
    return `get-many-${sequence}-${label}`
}

beforeEach(() => {
    fake.storageMap.clear()
    fake.counters.bulkReads = 0
    fake.counters.perKeyReads = 0
    fake.counters.lastBulkKeys = []
    fake.bulkRows = null
})

describe('SafeLocalPluginStorage.getMany', () => {
    test('empty input performs no storage reads', async () => {
        const store = new SafeLocalPluginStorage()
        await expect(store.getMany([])).resolves.toEqual([])
        expect(fake.counters.bulkReads).toBe(0)
        expect(fake.counters.perKeyReads).toBe(0)
    })

    test('reads unique cache misses once while preserving order, duplicates, and nulls', async () => {
        const a = uniqueKey('a')
        const missing = uniqueKey('missing')
        const b = uniqueKey('b')
        seed(a, { value: 1 })
        seed(b, ['two'])

        const store = new SafeLocalPluginStorage()
        await store.setItem(uniqueKey('cached'), 'unrelated')
        const cached = uniqueKey('warm')
        await store.setItem(cached, { warm: true })

        const result = await store.getMany([a, missing, a, cached, b])

        expect(result).toEqual([
            { value: 1 },
            null,
            { value: 1 },
            { warm: true },
            ['two'],
        ])
        expect(fake.counters.bulkReads).toBe(1)
        expect(fake.counters.perKeyReads).toBe(0)
        expect(fake.counters.lastBulkKeys).toEqual([rawKey(a), rawKey(missing), rawKey(b)])
    })

    test('successful non-null reads are cached, while null remains a future miss', async () => {
        const present = uniqueKey('present')
        const missing = uniqueKey('missing')
        seed(present, 7)
        const store = new SafeLocalPluginStorage()

        await expect(store.getMany([present, missing])).resolves.toEqual([7, null])
        expect(fake.counters.bulkReads).toBe(1)

        await expect(store.getMany([present, missing])).resolves.toEqual([7, null])
        expect(fake.counters.bulkReads).toBe(2)
        expect(fake.counters.lastBulkKeys).toEqual([rawKey(missing)])
    })

    test('corrupt bulk data rejects without partially warming the cache', async () => {
        const good = uniqueKey('good')
        const bad = uniqueKey('bad')
        seed(good, { ok: true })
        fake.storageMap.set(rawKey(bad), encoder.encode('{broken'))
        const store = new SafeLocalPluginStorage()

        await expect(store.getMany([good, bad])).rejects.toThrow()
        expect(fake.counters.lastBulkKeys).toEqual([rawKey(good), rawKey(bad)])

        seed(bad, { fixed: true })
        await expect(store.getMany([good, bad])).resolves.toEqual([{ ok: true }, { fixed: true }])
        expect(fake.counters.bulkReads).toBe(2)
        expect(fake.counters.lastBulkKeys).toEqual([rawKey(good), rawKey(bad)])
    })

    test('bulk correlation errors fail closed', async () => {
        const requested = uniqueKey('requested')
        fake.bulkRows = () => [
            { key: rawKey(requested), value: encoder.encode('1') },
            { key: rawKey(uniqueKey('stray')), value: encoder.encode('2') },
        ]
        const store = new SafeLocalPluginStorage()

        await expect(store.getMany([requested])).rejects.toThrow(/unrequested key/)
    })
})

describe('SafeLocalPluginStorage.getItemUncached', () => {
    test('reads a fresh value without warming the shared plugin cache', async () => {
        const key = uniqueKey('uncached')
        seed(key, { version: 1 })
        const store = new SafeLocalPluginStorage()

        await expect(store.getItemUncached(key)).resolves.toEqual({ version: 1 })
        seed(key, { version: 2 })
        await expect(store.getItemUncached(key)).resolves.toEqual({ version: 2 })

        expect(fake.counters.perKeyReads).toBe(2)
    })
})
