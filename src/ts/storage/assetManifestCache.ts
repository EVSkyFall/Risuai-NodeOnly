import type { AssetManifestTuple } from './nodeStorage'

const MAX_ENTRIES = 8
const MAX_BYTES = 32 * 1024 * 1024
const fullManifestCache = new Map<string, { items: AssetManifestTuple[]; bytes: number }>()
let fullManifestCacheBytes = 0

function estimateTupleBytes(items: AssetManifestTuple[]) {
    let bytes = 0
    for (const item of items) {
        for (const value of item) bytes += (value?.length ?? 0) * 2
        bytes += 32
    }
    return bytes
}

export function cacheFullAssetManifest(id: string, items: AssetManifestTuple[]) {
    const previous = fullManifestCache.get(id)
    if (previous) fullManifestCacheBytes -= previous.bytes
    fullManifestCache.delete(id)
    const bytes = estimateTupleBytes(items)
    if (bytes > MAX_BYTES) return
    fullManifestCache.set(id, { items, bytes })
    fullManifestCacheBytes += bytes
    while (fullManifestCache.size > MAX_ENTRIES || fullManifestCacheBytes > MAX_BYTES) {
        const oldestId = fullManifestCache.keys().next().value as string | undefined
        if (!oldestId) break
        const oldest = fullManifestCache.get(oldestId)
        fullManifestCache.delete(oldestId)
        fullManifestCacheBytes -= oldest?.bytes ?? 0
    }
}

export function getCachedFullAssetManifest(id?: string): AssetManifestTuple[] | undefined {
    if (!id) return undefined
    const entry = fullManifestCache.get(id)
    if (!entry) return undefined
    fullManifestCache.delete(id)
    fullManifestCache.set(id, entry)
    return entry.items
}
