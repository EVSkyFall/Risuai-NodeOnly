'use strict';

function stripPluginStorageManifest(dbObj, store, { activate = true } = {}) {
    if (!dbObj || typeof dbObj !== 'object') return { db: dbObj, migrated: null };
    const current = dbObj.pluginCustomStorage;
    if (dbObj.pluginStorageManifest && current && Object.keys(current).length === 0) {
        return { db: dbObj, migrated: null };
    }
    if (!current || typeof current !== 'object' || Array.isArray(current) || Object.keys(current).length === 0) {
        return { db: dbObj, migrated: null };
    }
    const descriptor = store.putSnapshot(current, { activate });
    return {
        db: { ...dbObj, pluginCustomStorage: {}, pluginStorageManifest: descriptor },
        migrated: descriptor,
    };
}

function hydratePluginStorageManifest(dbObj, store) {
    if (!dbObj || typeof dbObj !== 'object' || !dbObj.pluginStorageManifest) return dbObj;
    const descriptor = dbObj.pluginStorageManifest;
    const verified = store.verifySnapshot(descriptor.id);
    if (!verified.ok) throw new Error(`Plugin storage snapshot is unavailable or corrupt: ${descriptor.id}`);
    if (descriptor.count !== undefined && descriptor.count !== verified.count) {
        throw new Error(`Plugin storage snapshot count mismatch: ${descriptor.id}`);
    }
    if (descriptor.sha256 && descriptor.sha256 !== verified.sha256) {
        throw new Error(`Plugin storage snapshot hash mismatch: ${descriptor.id}`);
    }
    const out = { ...dbObj, pluginCustomStorage: store.loadSnapshot(descriptor.id) };
    delete out.pluginStorageManifest;
    return out;
}

module.exports = { stripPluginStorageManifest, hydratePluginStorageManifest };
