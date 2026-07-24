// Persisted plugin INSTALLATION identity (Pure Plugin Primitives V1 §3).
//
// A plugin's only identity today is `plugin.name`, which comes from the
// user-editable `//@name` script header. Namespacing durable storage on that is
// unsafe: renaming a plugin (or two plugins colliding on a name) would silently
// re-point or cross-wire every durable record it owns. `installId` is a
// host-minted UUID that survives edits, renames and OTA updates.
//
// FOLLOW-UP (deliberately NOT done in this slice): the V3 permission system
// still keys on plugin NAME (`permissionKeyOf` in apiV3/v3.svelte.ts). Re-keying
// it to installId would invalidate every grant the user has already given, so it
// is left for a slice that can carry a migration.

/** Lowercase UUID, matching what crypto.randomUUID() emits. */
export const INSTALL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Structural minimum this module needs. Kept local rather than importing
 * RisuPlugin so the identity rules stay independently testable without pulling
 * the whole plugin runtime into the graph.
 */
export interface PluginInstallIdentity {
    name: string
    installId?: string
}

export function newInstallId(): string {
    return crypto.randomUUID()
}

export function isValidInstallId(value: unknown): value is string {
    return typeof value === 'string' && INSTALL_ID_PATTERN.test(value)
}

/**
 * Carry the predecessor's installId onto an incoming plugin record, minting one
 * only when there is nothing valid to inherit.
 *
 * This is the single most load-bearing rule in the file: an OTA update builds a
 * brand-new plugin object and drops it over the old array slot, so without this
 * every update would hand the plugin a fresh namespace and orphan ALL of its
 * durable storage.
 */
export function preserveInstallId<T extends PluginInstallIdentity>(next: T, previous?: T | null): T {
    if (isValidInstallId(next.installId)) return next
    next.installId = isValidInstallId(previous?.installId) ? previous!.installId! : newInstallId()
    return next
}

/**
 * One-time backfill for installations that predate this field. Idempotent, and
 * never reorders or otherwise disturbs the list. Returns how many ids were
 * assigned so callers can skip persisting when there was nothing to do.
 */
export function backfillInstallIds<T extends PluginInstallIdentity>(plugins: T[] | null | undefined): number {
    if (!Array.isArray(plugins)) return 0
    let assigned = 0
    for (const plugin of plugins) {
        if (!plugin || isValidInstallId(plugin.installId)) continue
        plugin.installId = newInstallId()
        assigned++
    }
    return assigned
}

/**
 * Place an imported/updated plugin into the persisted list, preserving the
 * installId of whatever it replaces.
 *
 * The placement rules are a verbatim lift of the pre-existing importPlugin
 * logic (replace in place when the name already exists; otherwise append unless
 * this is a plain update). `oldPluginIndex` is passed in rather than recomputed
 * so the behaviour — including its use of an index resolved before the
 * confirmation dialog — is unchanged.
 */
export function commitImportedPlugin<T extends PluginInstallIdentity>(
    plugins: T[],
    pluginData: T,
    oldPluginIndex: number,
    options: { isUpdate: boolean; isHotReload: boolean },
): void {
    preserveInstallId(pluginData, oldPluginIndex !== -1 ? plugins[oldPluginIndex] : null)

    if (oldPluginIndex !== -1) {
        plugins[oldPluginIndex] = pluginData
    } else if (!options.isUpdate || options.isHotReload) {
        plugins.push(pluginData)
    }
}
