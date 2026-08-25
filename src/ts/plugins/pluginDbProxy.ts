// V2 plugin view of `db.pluginCustomStorage`.
//
// Plugin values live in pluginStorageStore, never in the DB (see the store's
// INVARIANT). V2 plugins historically read/wrote `risuai.db.pluginCustomStorage`
// directly, so the safe DB proxy hands out this live object instead of the
// real (always empty) DB field, and bulk writers (setDatabase/setDatabaseLite)
// route the key through replacePluginCustomStorage.

import * as pluginStorageStore from "./pluginStorageStore";

export const PLUGIN_CUSTOM_STORAGE_KEY = "pluginCustomStorage";

export function pluginCustomStorageProxy(): Record<string, any> {
    return new Proxy({} as Record<string, any>, {
        get(_t, prop) {
            if (typeof prop !== "string") return undefined;
            return pluginStorageStore.getItemSync(prop) ?? undefined;
        },
        set(_t, prop, value) {
            if (typeof prop === "string") pluginStorageStore.setItemSync(prop, value);
            return true;
        },
        deleteProperty(_t, prop) {
            if (typeof prop === "string") pluginStorageStore.removeItemSync(prop);
            return true;
        },
        has(_t, prop) {
            return typeof prop === "string" && pluginStorageStore.has(prop);
        },
        ownKeys() {
            return pluginStorageStore.keys();
        },
        getOwnPropertyDescriptor(_t, prop) {
            if (typeof prop !== "string" || !pluginStorageStore.has(prop)) return undefined;
            return {
                value: pluginStorageStore.getItemSync(prop) ?? undefined,
                writable: true,
                enumerable: true,
                configurable: true,
            };
        },
    });
}

// `db.pluginCustomStorage = obj` semantics: the store becomes exactly `obj`.
export function replacePluginCustomStorage(obj: unknown): void {
    pluginStorageStore.clearSync();
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj as Record<string, any>)) {
        pluginStorageStore.setItemSync(k, v);
    }
}

// Applies one key of a plugin-supplied DB object. Returns true when the key
// was handled here (so callers must not write it into the real DB).
export function applyPluginDbKey(key: string, value: unknown): boolean {
    if (key !== PLUGIN_CUSTOM_STORAGE_KEY) return false;
    replacePluginCustomStorage(value);
    return true;
}
