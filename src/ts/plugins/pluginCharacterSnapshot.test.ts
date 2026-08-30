import { describe, test, expect, vi, beforeEach } from 'vitest'

// Issue #80: plugin reads of manifest-backed characters must return the
// pre-manifest shape (plain `additionalAssets`, no descriptor) for the one
// character requested, and must never reject on a load failure.
const loadAssetManifestItems = vi.fn()
vi.mock('../globalApi.svelte', () => ({
    loadAssetManifestItems: (...args: any[]) => loadAssetManifestItems(...args),
}))

const cacheMod = await import('../storage/assetManifestCache')
const { hydratePluginCharacterSnapshot, restorePluginCharacterManifest } = await import('./pluginCharacterSnapshot')

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
