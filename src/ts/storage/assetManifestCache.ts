import type { AssetManifestTuple } from './nodeStorage'

const fullManifestCache = new Map<string, AssetManifestTuple[]>()

export function cacheFullAssetManifest(id: string, items: AssetManifestTuple[]) {
    fullManifestCache.set(id, items)
}

export function getCachedFullAssetManifest(id?: string): AssetManifestTuple[] | undefined {
    return id ? fullManifestCache.get(id) : undefined
}
