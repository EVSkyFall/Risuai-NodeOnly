import { describe, test, expect, vi, beforeEach } from 'vitest'

// Shared fake server store: one Map standing in for the Node KV, with call
// counters distinguishing bulk reads from per-key reads. init() must use the
// bulk path — the per-key form cost N×RTT at boot and delayed plugin data by
// seconds on remote servers (2026-07-22 report).
const fake = vi.hoisted(() => {
    const storageMap = new Map<string, Uint8Array>()
    const counters = { bulkReads: 0, perKeyReads: 0 }
    return { storageMap, counters }
})

// persistentKv imports hasher from parser.svelte, whose module graph drags in
// reactive store $effect chains that crash outside the app runtime — stub it.
vi.mock('../parser/parser.svelte', () => ({
    hasher: async (data: Uint8Array) => {
        let h = 0
        for (const b of data) h = (h * 31 + b) >>> 0
        return h.toString(16)
    },
}))

vi.mock('../globalApi.svelte', () => ({
    forageStorage: {
        Init: async () => {},
        keys: async (prefix: string) =>
            [...fake.storageMap.keys()].filter((k) => k.startsWith(prefix)),
        getItem: async (key: string) => {
            fake.counters.perKeyReads++
            return fake.storageMap.get(key) ?? null
        },
        getItems: async (keys: string[]) => {
            fake.counters.bulkReads++
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

import { PluginCustomKvStorage } from './pluginKvStorage'
import { makeEncodedStorageKey } from '../storage/persistentKv'

const CUSTOM_PREFIX = 'plugin-custom-storage/'
const encoder = new TextEncoder()

function seed(rawKey: string, value: unknown) {
    fake.storageMap.set(
        makeEncodedStorageKey(CUSTOM_PREFIX, rawKey),
        encoder.encode(JSON.stringify(value)),
    )
}

beforeEach(() => {
    fake.storageMap.clear()
    fake.counters.bulkReads = 0
    fake.counters.perKeyReads = 0
})

describe('PluginCustomKvStorage.init', () => {
    test('loads every stored key through a single bulk read, not N per-key reads', async () => {
        seed('omninode_config', { tier: 'heavy' })
        seed('provider/settings', { endpoint: 'https://example.invalid' })
        seed('한글 키', [1, 2, 3])

        const store = new PluginCustomKvStorage()
        await store.init()

        expect(store.getItem('omninode_config')).toEqual({ tier: 'heavy' })
        expect(store.getItem('provider/settings')).toEqual({ endpoint: 'https://example.invalid' })
        expect(store.getItem('한글 키')).toEqual([1, 2, 3])
        expect(store.length).toBe(3)

        expect(fake.counters.bulkReads).toBe(1)
        expect(fake.counters.perKeyReads).toBe(0)
    })

    test('round trip: setItem → flushImmediate → fresh instance init sees the value', async () => {
        const writer = new PluginCustomKvStorage()
        await writer.init()
        writer.setItem('sr_onboarding', { done: true })
        await writer.flushImmediate()

        const reader = new PluginCustomKvStorage()
        await reader.init()
        expect(reader.getItem('sr_onboarding')).toEqual({ done: true })
    })

    test('empty namespace init is a no-op with no reads', async () => {
        const store = new PluginCustomKvStorage()
        await store.init()
        expect(store.length).toBe(0)
        expect(fake.counters.perKeyReads).toBe(0)
    })
})
