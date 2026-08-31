import type { AssetManifestDescriptor } from './nodeStorage'

export type ResolveOwners = Array<{ manifestId: string; kind?: string; ownerId?: string; fuzzy: boolean }>
export type ResolveFn = (owners: ResolveOwners, names: string[]) => Promise<Record<string, string>>

const MAX_OWNER_SETS = 32
const MAX_NAMES_PER_SET = 4096

/**
 * Resolves `{{img::name}}`-style asset names against lazy asset manifests in
 * ONE server call, character manifest first, and remembers the answer.
 *
 * Why one call: the server matches every owner exactly before it tries the
 * fuzzy fallback, so an exact module asset can never lose to a fuzzy
 * near-miss on the character (v1.11.0 did character-fuzzy first, which
 * swallowed almost every module asset name on characters with many assets).
 *
 * Why remember: the parser runs for every message and for the background
 * embedding on each re-render. Manifest ids are content-addressed, so a
 * result for a given set of manifests never goes stale; misses are cached
 * too, keyed by the same set, so a chat-variable change does not cost a
 * round trip per message.
 */
export function createAssetNameResolver(resolve: ResolveFn) {
    const cache = new Map<string, Map<string, string | null>>()

    function bucket(key: string): Map<string, string | null> {
        let entry = cache.get(key)
        if (entry) {
            cache.delete(key)
            cache.set(key, entry)
            return entry
        }
        if (cache.size >= MAX_OWNER_SETS) cache.delete(cache.keys().next().value as string)
        entry = new Map()
        cache.set(key, entry)
        return entry
    }

    return async function resolveNames(
        characterManifest: AssetManifestDescriptor | undefined,
        moduleManifests: AssetManifestDescriptor[],
        names: string[],
        fuzzy: boolean,
    ): Promise<Record<string, string>> {
        const uniqueNames = [...new Set(names.map((name) => name.toLocaleLowerCase()))].filter((name) => name.length > 0)
        const manifests = [characterManifest, ...moduleManifests].filter((manifest): manifest is AssetManifestDescriptor => !!manifest?.id)
        const out: Record<string, string> = {}
        if (manifests.length === 0 || uniqueNames.length === 0) return out

        const key = (fuzzy ? 'f|' : 'e|') + manifests.map((manifest) => manifest.id).join('|')
        const known = bucket(key)
        const missing = uniqueNames.filter((name) => !known.has(name))
        if (missing.length > 0) {
            const owners: ResolveOwners = manifests.map((manifest) => ({
                manifestId: manifest.id,
                kind: manifest.ownerKind,
                ownerId: manifest.ownerId,
                fuzzy: fuzzy && manifest === characterManifest,
            }))
            const resolved = await resolve(owners, missing)
            for (const name of missing) {
                known.set(name, Object.hasOwn(resolved, name) ? resolved[name] : null)
            }
            while (known.size > MAX_NAMES_PER_SET) known.delete(known.keys().next().value as string)
        }
        for (const name of uniqueNames) {
            const path = known.get(name)
            if (path) out[name] = path
        }
        return out
    }
}
