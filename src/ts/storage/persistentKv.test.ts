import { beforeEach, describe, expect, test, vi } from 'vitest'

// In-memory forageStorage seam with request accounting so we can prove the
// bulk-read primitive issues one bulk call (not N per-record reads) and
// preserves per-key identity / corrupt fail-closed semantics.
const { storageMap, counters, control } = vi.hoisted(() => ({
    storageMap: new Map<string, Uint8Array>(),
    counters: { getItem: 0, getItems: 0 },
    control: {
        // Optional response mutators for fail-closed coverage.
        duplicateKey: null as string | null,
        injectUnrequestedKey: null as string | null,
        // When false, the mock has no bulk API (browser fallback path).
        bulkEnabled: true,
    },
}))

vi.mock('src/ts/globalApi.svelte', () => {
    const forageStorage: Record<string, unknown> = {
        async Init() {},
        async keys(prefix = '') {
            return [...storageMap.keys()].filter((key) => key.startsWith(prefix))
        },
        async getItem(key: string) {
            counters.getItem += 1
            return storageMap.get(key) ?? null
        },
        async setItem(key: string, value: Uint8Array) {
            storageMap.set(key, new Uint8Array(value))
        },
        async removeItem(key: string) {
            storageMap.delete(key)
        },
    }
    // getItems is looked up dynamically via a getter so a single mock can model
    // both the Node bulk path and a backend that lacks the bulk API.
    Object.defineProperty(forageStorage, 'getItems', {
        get() {
            if (!control.bulkEnabled) return undefined
            return async (keys: string[]) => {
                counters.getItems += 1
                const results: { key: string; value: Uint8Array }[] = []
                for (const key of keys) {
                    const value = storageMap.get(key)
                    if (value !== undefined) {
                        results.push({ key, value: new Uint8Array(value) })
                        if (control.duplicateKey === key) {
                            results.push({ key, value: new Uint8Array(value) })
                        }
                    }
                }
                if (control.injectUnrequestedKey) {
                    results.push({
                        key: control.injectUnrequestedKey,
                        value: new TextEncoder().encode('{}'),
                    })
                }
                return results
            }
        },
    })
    return { forageStorage }
})

vi.mock('src/ts/parser/parser.svelte', () => ({
    hasher: vi.fn(async () => new Uint8Array(32)),
}))

const { readManyPersistentJson } = await import('./persistentKv')

function seed(key: string, value: unknown): void {
    storageMap.set(key, new TextEncoder().encode(JSON.stringify(value)))
}

beforeEach(() => {
    storageMap.clear()
    counters.getItem = 0
    counters.getItems = 0
    control.duplicateKey = null
    control.injectUnrequestedKey = null
    control.bulkEnabled = true
})

describe('readManyPersistentJson', () => {
    test('makes zero network calls for an empty key list', async () => {
        const result = await readManyPersistentJson<unknown>([])
        expect(result).toEqual([])
        expect(counters.getItem).toBe(0)
        expect(counters.getItems).toBe(0)
    })

    test('reads many keys in a single bulk call with no per-record reads', async () => {
        seed('a', { v: 1 })
        seed('b', { v: 2 })
        seed('c', { v: 3 })

        const result = await readManyPersistentJson<{ v: number }>(['a', 'b', 'c'])

        expect(result).toEqual([{ v: 1 }, { v: 2 }, { v: 3 }])
        expect(counters.getItem).toBe(0)
        expect(counters.getItems).toBe(1)
    })

    test('preserves input identity and order, mapping missing keys to null', async () => {
        seed('present', { ok: true })
        // 'gap' is never seeded — the bulk server omits it from the response.

        const result = await readManyPersistentJson<{ ok: boolean }>([
            'gap',
            'present',
            'other-gap',
        ])

        expect(result).toEqual([null, { ok: true }, null])
    })

    test('honours duplicate input keys with one output slot each', async () => {
        seed('dup', { v: 7 })

        const result = await readManyPersistentJson<{ v: number }>(['dup', 'dup'])

        expect(result).toEqual([{ v: 7 }, { v: 7 }])
        // Deduplicated on the wire: one bulk call, unique keys only.
        expect(counters.getItems).toBe(1)
    })

    test('throws on corrupt JSON bytes, matching single-read semantics', async () => {
        storageMap.set('bad', new TextEncoder().encode('{ not json'))

        await expect(readManyPersistentJson<unknown>(['bad'])).rejects.toBeInstanceOf(SyntaxError)
    })

    test('fails closed when the response contains a duplicate row', async () => {
        seed('x', { v: 1 })
        control.duplicateKey = 'x'

        await expect(readManyPersistentJson<unknown>(['x'])).rejects.toThrow(/duplicate/i)
    })

    test('fails closed when the response contains an unrequested key', async () => {
        seed('x', { v: 1 })
        control.injectUnrequestedKey = 'stray'

        await expect(readManyPersistentJson<unknown>(['x'])).rejects.toThrow(/unrequested/i)
    })

    test('falls back to per-key reads when no bulk API is available', async () => {
        control.bulkEnabled = false
        seed('a', { v: 1 })
        seed('b', { v: 2 })

        const result = await readManyPersistentJson<{ v: number }>(['a', 'missing', 'b'])

        expect(result).toEqual([{ v: 1 }, null, { v: 2 }])
        expect(counters.getItems).toBe(0)
        expect(counters.getItem).toBe(3)
    })
})
