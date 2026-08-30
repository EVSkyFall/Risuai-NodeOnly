import { describe, test, expect, vi, beforeEach } from 'vitest'

// Issue #80: plugin reads of manifest-backed characters must return the
// pre-manifest shape (plain `additionalAssets`, no descriptor) for the one
// character requested, and must never reject on a load failure.
const loadAssetManifestItems = vi.fn()
vi.mock('../globalApi.svelte', () => ({
    loadAssetManifestItems: (...args: any[]) => loadAssetManifestItems(...args),
}))

const cacheMod = await import('../storage/assetManifestCache')
const { hydratePluginCharacterSnapshot, restorePluginCharacterManifest, hydratePluginDatabaseSnapshot, hydratePluginModuleSnapshot, restorePluginDbKey } = await import('./pluginCharacterSnapshot')

const descriptor = { id: 'm1', ownerKind: 'character', ownerId: 'c1', count: 2 } as any
const items: [string, string, string][] = [['smile', 'key-a', 'png'], ['angry', 'key-b', 'png']]

beforeEach(() => {
    loadAssetManifestItems.mockReset()
    loadAssetManifestItems.mockResolvedValue(items)
})

describe('hydratePluginCharacterSnapshot', () => {
    test('fills additionalAssets from the manifest and drops the descriptor', async () => {
        const snap: any = { name: 'a', additionalAssetManifest: descriptor }
        const out: any = await hydratePluginCharacterSnapshot(snap)
        expect(out).toBe(snap)
        expect(out.additionalAssets).toEqual(items)
        expect(out.additionalAssetManifest).toBeUndefined()
        expect(loadAssetManifestItems).toHaveBeenCalledWith(descriptor)
    })

    test('leaves a character that already carries additionalAssets untouched', async () => {
        const inline: [string, string, string][] = [['x', 'k', 'png']]
        const snap: any = { additionalAssets: inline, additionalAssetManifest: descriptor }
        const out: any = await hydratePluginCharacterSnapshot(snap)
        expect(out.additionalAssets).toBe(inline)
        expect(out.additionalAssetManifest).toBe(descriptor)
        expect(loadAssetManifestItems).not.toHaveBeenCalled()
    })

    test('does nothing for a character without a manifest', async () => {
        const snap: any = { name: 'plain' }
        expect(await hydratePluginCharacterSnapshot(snap)).toEqual({ name: 'plain' })
        expect(loadAssetManifestItems).not.toHaveBeenCalled()
    })

    test('passes null and undefined through', async () => {
        expect(await hydratePluginCharacterSnapshot(null)).toBeNull()
        expect(await hydratePluginCharacterSnapshot(undefined)).toBeUndefined()
    })

    test('keeps the descriptor-only shape instead of rejecting when the load fails', async () => {
        loadAssetManifestItems.mockRejectedValue(new Error('offline'))
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const snap: any = { additionalAssetManifest: descriptor }
        const out: any = await hydratePluginCharacterSnapshot(snap)
        expect(out.additionalAssets).toBeUndefined()
        expect(out.additionalAssetManifest).toBe(descriptor)
        expect(warn).toHaveBeenCalled()
        warn.mockRestore()
    })
})

describe('restorePluginCharacterManifest', () => {
    const current = { additionalAssetManifest: descriptor } as any

    test('restores the descriptor when the written array matches the cached manifest', () => {
        cacheMod.cacheFullAssetManifest(descriptor.id, items.map((t) => [...t] as [string, string, string]))
        const incoming: any = { name: 'renamed', additionalAssets: items.map((t) => [...t]) }
        const out = restorePluginCharacterManifest(incoming, current)
        expect(out.additionalAssets).toBeUndefined()
        expect(out.additionalAssetManifest).toBe(descriptor)
        expect(out.name).toBe('renamed')
    })

    test('keeps a changed array inline', () => {
        cacheMod.cacheFullAssetManifest(descriptor.id, items)
        const changed = [...items, ['new', 'key-c', 'png']]
        const out: any = restorePluginCharacterManifest({ additionalAssets: changed } as any, current)
        expect(out.additionalAssets).toBe(changed)
        expect(out.additionalAssetManifest).toBeUndefined()
    })

    test('keeps the array inline when the manifest is no longer cached', () => {
        cacheMod.cacheFullAssetManifest('other', [])
        const out: any = restorePluginCharacterManifest({ additionalAssets: items } as any, { additionalAssetManifest: { ...descriptor, id: 'evicted' } } as any)
        expect(out.additionalAssets).toBe(items)
    })

    test('does not touch writes for characters that were never manifest-backed', () => {
        const incoming: any = { additionalAssets: items }
        expect(restorePluginCharacterManifest(incoming, { additionalAssets: items } as any)).toBe(incoming)
        expect(incoming.additionalAssetManifest).toBeUndefined()
        expect(restorePluginCharacterManifest(incoming, undefined)).toBe(incoming)
    })

    test('leaves a write that already carries a descriptor alone', () => {
        const incoming: any = { additionalAssetManifest: descriptor }
        expect(restorePluginCharacterManifest(incoming, current)).toBe(incoming)
        expect(incoming.additionalAssets).toBeUndefined()
    })
})

describe('read-modify-write round trip', () => {
    test('an in-place edit of the returned array is treated as a change, not masked by cache aliasing', async () => {
        const shared = items.map((t) => [...t] as [string, string, string])
        loadAssetManifestItems.mockImplementation(async () => {
            cacheMod.cacheFullAssetManifest(descriptor.id, shared)
            return shared
        })
        const snap: any = await hydratePluginCharacterSnapshot({ additionalAssetManifest: descriptor } as any)
        expect(snap.additionalAssets).not.toBe(shared)

        snap.additionalAssets.push(['new', 'key-c', 'png'])
        snap.additionalAssets[0][0] = 'renamed'
        const out: any = restorePluginCharacterManifest(snap, { additionalAssetManifest: descriptor } as any)
        expect(out.additionalAssetManifest).toBeUndefined()
        expect(out.additionalAssets).toHaveLength(3)
        expect(cacheMod.getCachedFullAssetManifest(descriptor.id)).toEqual(items)
    })

    test('an untouched round trip restores the descriptor', async () => {
        loadAssetManifestItems.mockImplementation(async () => {
            cacheMod.cacheFullAssetManifest(descriptor.id, items)
            return items
        })
        const snap: any = await hydratePluginCharacterSnapshot({ name: 'x', additionalAssetManifest: descriptor } as any)
        snap.name = 'y'
        const out: any = restorePluginCharacterManifest(snap, { additionalAssetManifest: descriptor } as any)
        expect(out.additionalAssetManifest).toBe(descriptor)
        expect(out.additionalAssets).toBeUndefined()
    })
})

describe('hydratePluginDatabaseSnapshot', () => {
    const moduleManifest = { id: 'mod-1', ownerKind: 'module', ownerId: 'm1' } as any

    test('fills module and persona embedded-module assets, leaving characters alone', async () => {
        const subset: any = {
            modules: [{ name: 'm', assetManifest: moduleManifest }, { name: 'inline', assets: [['x', 'k', 'png']] }],
            personas: [{ name: 'p', embeddedModule: { assetManifest: moduleManifest } }, { name: 'plain' }],
            characters: [{ additionalAssetManifest: descriptor }],
        }
        await hydratePluginDatabaseSnapshot(subset)
        expect(subset.modules[0].assets).toEqual(items)
        expect(subset.modules[0].assetManifest).toBeUndefined()
        expect(subset.modules[1].assets).toEqual([['x', 'k', 'png']])
        expect(subset.personas[0].embeddedModule.assets).toEqual(items)
        expect(subset.personas[0].embeddedModule.assetManifest).toBeUndefined()
        expect(subset.characters[0].additionalAssetManifest).toBe(descriptor)
        expect(loadAssetManifestItems).toHaveBeenCalledTimes(2)
    })

    test('tolerates subsets without modules or personas', async () => {
        await expect(hydratePluginDatabaseSnapshot({})).resolves.toBeUndefined()
        await expect(hydratePluginDatabaseSnapshot({ modules: undefined, personas: [{}] } as any)).resolves.toBeUndefined()
        expect(loadAssetManifestItems).not.toHaveBeenCalled()
    })

    test('a failed module load keeps the descriptor and hands back a copy of the tuples otherwise', async () => {
        loadAssetManifestItems.mockRejectedValueOnce(new Error('offline'))
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const failed: any = await hydratePluginModuleSnapshot({ assetManifest: moduleManifest } as any)
        expect(failed.assets).toBeUndefined()
        expect(failed.assetManifest).toBe(moduleManifest)
        warn.mockRestore()

        const ok: any = await hydratePluginModuleSnapshot({ assetManifest: moduleManifest } as any)
        expect(ok.assets).toEqual(items)
        expect(ok.assets).not.toBe(items)
    })
})

describe('cache-first manifest lookup', () => {
    test('a cached manifest is served without a server round trip, as a copy', async () => {
        const cachedDescriptor = { ...descriptor, id: 'cached-char' }
        const cachedItems: [string, string, string][] = [['c', 'k', 'png']]
        cacheMod.cacheFullAssetManifest(cachedDescriptor.id, cachedItems)
        const snap: any = await hydratePluginCharacterSnapshot({ additionalAssetManifest: cachedDescriptor } as any)
        expect(snap.additionalAssets).toEqual(cachedItems)
        expect(snap.additionalAssets).not.toBe(cachedItems)
        expect(loadAssetManifestItems).not.toHaveBeenCalled()

        const mod: any = await hydratePluginModuleSnapshot({ assetManifest: { ...cachedDescriptor, ownerKind: 'module' } } as any)
        expect(mod.assets).toEqual(cachedItems)
        expect(loadAssetManifestItems).not.toHaveBeenCalled()
    })
})

describe('restorePluginDbKey', () => {
    const moduleManifest = { id: 'mod-rt', ownerKind: 'module', ownerId: 'm1' } as any
    const current = {
        modules: [{ id: 'm1', assetManifest: moduleManifest }, { id: 'm2', assets: [['x', 'k', 'png']] }],
        personas: [{ id: 'p1', embeddedModule: { assetManifest: moduleManifest } }],
    }

    test('an untouched getDatabase() → setDatabase() round trip keeps module and persona manifests', () => {
        cacheMod.cacheFullAssetManifest(moduleManifest.id, items)
        const modules: any = [{ id: 'm1', assets: items.map((t) => [...t]) }, { id: 'm2', assets: [['x', 'k', 'png']] }, { id: 'new', assets: [['n', 'k', 'png']] }]
        const out: any = restorePluginDbKey('modules', modules, current)
        expect(out[0].assetManifest).toBe(moduleManifest)
        expect(out[0].assets).toBeUndefined()
        expect(out[1].assets).toEqual([['x', 'k', 'png']])
        expect(out[2].assets).toEqual([['n', 'k', 'png']])

        const personas: any = [{ id: 'p1', embeddedModule: { assets: items.map((t) => [...t]) } }]
        restorePluginDbKey('personas', personas, current)
        expect(personas[0].embeddedModule.assetManifest).toBe(moduleManifest)
        expect(personas[0].embeddedModule.assets).toBeUndefined()
    })

    test('a changed module asset list stays inline', () => {
        cacheMod.cacheFullAssetManifest(moduleManifest.id, items)
        const modules: any = [{ id: 'm1', assets: [...items, ['extra', 'k', 'png']] }]
        restorePluginDbKey('modules', modules, current)
        expect(modules[0].assetManifest).toBeUndefined()
        expect(modules[0].assets).toHaveLength(3)
    })

    test('personas without an id match by position; other keys pass through', () => {
        cacheMod.cacheFullAssetManifest(moduleManifest.id, items)
        const personas: any = [{ embeddedModule: { assets: items.map((t) => [...t]) } }]
        restorePluginDbKey('personas', personas, current)
        expect(personas[0].embeddedModule.assetManifest).toBe(moduleManifest)
        const chars = [{ additionalAssets: items }]
        expect(restorePluginDbKey('characters', chars, current)).toBe(chars)
        expect(restorePluginDbKey('modules', 'not-an-array', current)).toBe('not-an-array')
    })
})

describe('write-back survives full-manifest cache eviction', () => {
    test('a list handed out through getDatabase() is restored even after the LRU dropped it', async () => {
        const manifests = Array.from({ length: 10 }, (_, i) => ({ id: `evict-${i}`, ownerKind: 'module', ownerId: `m${i}` } as any))
        loadAssetManifestItems.mockImplementation(async (m: any) => {
            const list: [string, string, string][] = [[`a${m.id}`, 'k', 'png']]
            cacheMod.cacheFullAssetManifest(m.id, list)
            return list
        })
        const subset: any = { modules: manifests.map((assetManifest, i) => ({ id: `m${i}`, assetManifest })) }
        await hydratePluginDatabaseSnapshot(subset)
        // The first manifest is gone from the 8-entry LRU by now.
        expect(cacheMod.getCachedFullAssetManifest('evict-0')).toBeUndefined()

        const current = { modules: manifests.map((assetManifest, i) => ({ id: `m${i}`, assetManifest })) }
        restorePluginDbKey('modules', subset.modules, current)
        for (let i = 0; i < 10; i++) {
            expect(subset.modules[i].assetManifest).toBe(manifests[i])
            expect(subset.modules[i].assets).toBeUndefined()
        }
    })

    test('an edited list is still detected as a change without the cache', async () => {
        const manifest = { id: 'evict-edit', ownerKind: 'character', ownerId: 'c' } as any
        loadAssetManifestItems.mockResolvedValue([['a', 'k', 'png']])
        const snap: any = await hydratePluginCharacterSnapshot({ additionalAssetManifest: manifest } as any)
        for (let i = 0; i < 9; i++) cacheMod.cacheFullAssetManifest(`filler-${i}`, [])
        snap.additionalAssets[0][0] = 'renamed'
        const out: any = restorePluginCharacterManifest(snap, { additionalAssetManifest: manifest } as any)
        expect(out.additionalAssetManifest).toBeUndefined()
        expect(out.additionalAssets[0][0]).toBe('renamed')
    })
})
