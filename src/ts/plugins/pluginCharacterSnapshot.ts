import { loadAssetManifestItems } from '../globalApi.svelte'
import { getCachedFullAssetManifest } from '../storage/assetManifestCache'
import type { character } from '../storage/database.svelte'
import type { AssetManifestDescriptor } from '../storage/nodeStorage'

type AssetFields = Pick<character, 'additionalAssets' | 'additionalAssetManifest'>

// Manifest ids are content-addressed, so a cached copy is never stale; only
// go to the server for what the cache is missing (plugins may poll).
function manifestItems(descriptor: AssetManifestDescriptor) {
    const cached = getCachedFullAssetManifest(descriptor.id)
    return cached ? Promise.resolve(cached) : loadAssetManifestItems(descriptor)
}

// Manifest-backed characters keep only an `additionalAssetManifest` descriptor
// in DBState (lazy asset manifests, issue #80). Plugins predate that and read
// `additionalAssets`, so a detached snapshot handed to a plugin is filled for
// that one character. DBState itself stays lazy; only the copy changes.
//
// Takes an already-detached copy (e.g. `$state.snapshot(...)`) and fills it in
// place. A load failure leaves the copy untouched — the plugin then sees the
// same descriptor-only shape as before, never a rejected call.
export async function hydratePluginCharacterSnapshot<T extends AssetFields>(
    snapshot: T | null | undefined,
): Promise<T | null | undefined> {
    if (!snapshot) return snapshot
    if (Array.isArray(snapshot.additionalAssets) || !snapshot.additionalAssetManifest) return snapshot
    try {
        // Copy: the loader hands back the cached array instance, and a plugin
        // editing it in place must not edit the cache the write-back compares
        // against below.
        const items = await manifestItems(snapshot.additionalAssetManifest)
        snapshot.additionalAssets = items.map((tuple) => [...tuple]) as [string, string, string][]
        delete snapshot.additionalAssetManifest
    } catch (error) {
        console.warn('[plugin] failed to load character assets for plugin snapshot', error)
    }
    return snapshot
}

function sameAssetTuples(a: readonly (readonly string[])[], b: readonly (readonly string[])[]) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        const x = a[i], y = b[i]
        if (x.length !== y.length) return false
        for (let j = 0; j < x.length; j++) if (x[j] !== y[j]) return false
    }
    return true
}

// Write-back counterpart. A plugin that only edited other fields hands the
// filled array straight back; keeping the descriptor in that case means the
// write is a no-op for assets, exactly like before lazy manifests. A genuinely
// changed list is left inline and takes the same path as a character import
// (re-canonicalized into a manifest on the next cold load).
export function restorePluginCharacterManifest<T extends AssetFields>(incoming: T, current: AssetFields | undefined): T {
    const descriptor = current?.additionalAssetManifest
    if (!incoming || !descriptor || Array.isArray(current?.additionalAssets)) return incoming
    if (!Array.isArray(incoming.additionalAssets) || incoming.additionalAssetManifest) return incoming
    const cached = getCachedFullAssetManifest(descriptor.id)
    if (!cached || !sameAssetTuples(cached, incoming.additionalAssets)) return incoming
    delete incoming.additionalAssets
    incoming.additionalAssetManifest = descriptor
    return incoming
}

type ModuleAssetFields = { assets?: [string, string, string][]; assetManifest?: AssetManifestDescriptor }

// Module counterpart: modules (and a persona's embedded module) are only
// reachable through getDatabase(), so their lazy manifests are filled there.
export async function hydratePluginModuleSnapshot<T extends ModuleAssetFields>(
    snapshot: T | null | undefined,
): Promise<T | null | undefined> {
    if (!snapshot) return snapshot
    if (Array.isArray(snapshot.assets) || !snapshot.assetManifest) return snapshot
    try {
        const items = await manifestItems(snapshot.assetManifest)
        snapshot.assets = items.map((tuple) => [...tuple]) as [string, string, string][]
        delete snapshot.assetManifest
    } catch (error) {
        console.warn('[plugin] failed to load module assets for plugin snapshot', error)
    }
    return snapshot
}

// Fills the module-shaped entries of a detached getDatabase() subset in
// place. Characters are deliberately left lazy (see getCharacter*).
export async function hydratePluginDatabaseSnapshot(subset: {
    modules?: ModuleAssetFields[]
    personas?: { embeddedModule?: ModuleAssetFields }[]
}): Promise<void> {
    const modules = [
        ...(Array.isArray(subset.modules) ? subset.modules : []),
        ...(Array.isArray(subset.personas) ? subset.personas.map((persona) => persona?.embeddedModule) : []),
    ]
    await Promise.all(modules.map((module) => hydratePluginModuleSnapshot(module)))
}
