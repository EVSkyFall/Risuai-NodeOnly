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

// Fingerprint of every list handed to a plugin, by manifest id. The
// write-back compares against this rather than the full-manifest cache,
// which is a small LRU and may have evicted the entry by the time the
// plugin writes (e.g. getDatabase() filling more than eight modules).
const HANDED_OUT_LIMIT = 4096
const handedOut = new Map<string, string>()

function fingerprint(items: readonly (readonly string[])[]): string {
    // Two independent FNV-1a passes over the joined tuples.
    let a = 0x811c9dc5, b = 0x01000193
    const text = items.map((tuple) => tuple.join('\u0000')).join('\u0001')
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i)
        a = Math.imul(a ^ c, 0x01000193)
        b = Math.imul(b ^ c, 0x2f0b4a3d) + 0x9e3779b9
    }
    return `${items.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`
}

function rememberHandedOut(id: string, items: readonly (readonly string[])[]) {
    if (handedOut.size >= HANDED_OUT_LIMIT) handedOut.delete(handedOut.keys().next().value as string)
    handedOut.set(id, fingerprint(items))
}

// True when `incoming` is the list we handed out for `descriptor`, or, if we
// never handed it out, the list the cache still holds.
function matchesManifest(descriptor: AssetManifestDescriptor, incoming: readonly (readonly string[])[]): boolean {
    const remembered = handedOut.get(descriptor.id)
    if (remembered !== undefined) return remembered === fingerprint(incoming)
    const cached = getCachedFullAssetManifest(descriptor.id)
    return !!cached && sameAssetTuples(cached, incoming)
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
        rememberHandedOut(snapshot.additionalAssetManifest.id, items)
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
    if (!matchesManifest(descriptor, incoming.additionalAssets)) return incoming
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
        rememberHandedOut(snapshot.assetManifest.id, items)
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

// Write-back counterpart for module-shaped entries. A plugin that round-trips
// getDatabase() → setDatabase() hands every filled `assets` array straight
// back; matching entries whose list still equals the cached manifest get
// their descriptor back so the write is a no-op for assets.
function restoreModuleManifest<T extends ModuleAssetFields>(incoming: T, current: ModuleAssetFields | undefined): T {
    const descriptor = current?.assetManifest
    if (!incoming || !descriptor || Array.isArray(current?.assets)) return incoming
    if (!Array.isArray(incoming.assets) || incoming.assetManifest) return incoming
    if (!matchesManifest(descriptor, incoming.assets)) return incoming
    delete incoming.assets
    incoming.assetManifest = descriptor
    return incoming
}

type PluginDbValue = unknown

// Applies the write-back restore to a top-level DB key a plugin is writing.
// Modules match by id, personas by id (falling back to position). Any other
// key is returned untouched.
export function restorePluginDbKey(key: string, value: PluginDbValue, currentDb: { modules?: any[]; personas?: any[] } | undefined): PluginDbValue {
    if (!Array.isArray(value) || !currentDb) return value
    if (key === 'modules') {
        const byId = new Map((currentDb.modules ?? []).map((module) => [module?.id, module]))
        for (const module of value) {
            if (module) restoreModuleManifest(module, byId.get(module.id))
        }
    } else if (key === 'personas') {
        const byId = new Map((currentDb.personas ?? []).map((persona) => [persona?.id, persona]))
        value.forEach((persona, index) => {
            const current = (persona?.id !== undefined ? byId.get(persona.id) : undefined) ?? currentDb.personas?.[index]
            if (persona?.embeddedModule && current?.embeddedModule) {
                restoreModuleManifest(persona.embeddedModule, current.embeddedModule)
            }
        })
    }
    return value
}
