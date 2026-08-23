'use strict';

const crypto = require('crypto');

function fallbackOwnerId(prefix, name, index) {
    return `${prefix}-${crypto.createHash('sha256')
        .update(`${String(name || '')}\0${index}`)
        .digest('hex')
        .slice(0, 24)}`;
}

function moduleOwnerId(module, index) {
    return String(module?.id || module?.namespace || fallbackOwnerId('module', module?.name, index));
}

function characterOwnerId(character, index) {
    return String(character?.chaId || fallbackOwnerId('character', character?.name, index));
}

function personaOwnerId(persona, index) {
    return String(persona?.id || persona?.personaId || fallbackOwnerId('persona', persona?.name, index));
}

function enrichDescriptor(descriptor, kind, ownerId) {
    return {
        ...descriptor,
        ownerKind: kind,
        ownerId,
    };
}

/**
 * Move large tuple arrays out of a decoded DB object and into immutable
 * manifests. Returns a shallow structural copy; the source object and its
 * arrays are never mutated. Empty arrays stay inline because they cost nothing
 * and preserve old UI initialization semantics.
 */
function stripAssetManifests(dbObj, store, { activate = true } = {}) {
    if (!dbObj || typeof dbObj !== 'object') return { db: dbObj, migrated: [] };
    const migrated = [];
    const out = { ...dbObj };

    if (Array.isArray(dbObj.modules)) {
        out.modules = dbObj.modules.map((module, index) => {
            if (!module || !Array.isArray(module.assets) || module.assets.length === 0) return module;
            const ownerId = moduleOwnerId(module, index);
            try {
                const descriptor = enrichDescriptor(
                    store.putManifest('module', ownerId, module.assets, { activate }),
                    'module', ownerId,
                );
                const next = { ...module, assetManifest: descriptor };
                delete next.assets;
                migrated.push(descriptor);
                return next;
            } catch (error) {
                store.recordMigrationFailure('module', ownerId, error);
                throw error;
            }
        });
    }

    if (Array.isArray(dbObj.characters)) {
        out.characters = dbObj.characters.map((character, index) => {
            if (!character || !Array.isArray(character.additionalAssets) || character.additionalAssets.length === 0) {
                return character;
            }
            const ownerId = characterOwnerId(character, index);
            try {
                const descriptor = enrichDescriptor(
                    store.putManifest('character', ownerId, character.additionalAssets, { activate }),
                    'character', ownerId,
                );
                const next = { ...character, additionalAssetManifest: descriptor };
                delete next.additionalAssets;
                migrated.push(descriptor);
                return next;
            } catch (error) {
                store.recordMigrationFailure('character', ownerId, error);
                throw error;
            }
        });
    }

    if (Array.isArray(dbObj.personas)) {
        out.personas = dbObj.personas.map((persona, index) => {
            const embedded = persona?.embeddedModule;
            if (!embedded || !Array.isArray(embedded.assets) || embedded.assets.length === 0) return persona;
            const ownerId = personaOwnerId(persona, index);
            try {
                const descriptor = enrichDescriptor(
                    store.putManifest('persona-module', ownerId, embedded.assets, { activate }),
                    'persona-module', ownerId,
                );
                const nextEmbedded = { ...embedded, assetManifest: descriptor };
                delete nextEmbedded.assets;
                migrated.push(descriptor);
                return { ...persona, embeddedModule: nextEmbedded };
            } catch (error) {
                store.recordMigrationFailure('persona-module', ownerId, error);
                throw error;
            }
        });
    }

    return { db: out, migrated };
}

function loadDescriptorItems(store, descriptor) {
    if (!descriptor?.id) throw new Error('Asset manifest descriptor is missing an id');
    const verified = store.verifyManifest(descriptor.id);
    if (!verified.ok) throw new Error(`Asset manifest is unavailable or corrupt: ${descriptor.id}`);
    if (descriptor.version !== undefined && verified.version !== descriptor.version) {
        throw new Error(`Asset manifest version mismatch: ${descriptor.id}`);
    }
    if (descriptor.count !== undefined && verified.count !== descriptor.count) {
        throw new Error(`Asset manifest count mismatch: ${descriptor.id}`);
    }
    if (descriptor.sha256 && verified.sha256 !== descriptor.sha256) {
        throw new Error(`Asset manifest hash mismatch: ${descriptor.id}`);
    }
    if (descriptor.ownerKind && verified.ownerKind !== descriptor.ownerKind) {
        throw new Error(`Asset manifest owner kind mismatch: ${descriptor.id}`);
    }
    if (descriptor.ownerId && verified.ownerId !== descriptor.ownerId) {
        throw new Error(`Asset manifest owner id mismatch: ${descriptor.id}`);
    }
    return store.loadItems(descriptor.id);
}

/** Rebuild legacy tuple arrays for disk persistence and RisuAI-compatible export. */
function hydrateAssetManifests(dbObj, store) {
    if (!dbObj || typeof dbObj !== 'object') return dbObj;
    const out = { ...dbObj };

    if (Array.isArray(dbObj.modules)) {
        out.modules = dbObj.modules.map((module) => {
            if (!module?.assetManifest) return module;
            const next = { ...module, assets: loadDescriptorItems(store, module.assetManifest) };
            delete next.assetManifest;
            return next;
        });
    }

    if (Array.isArray(dbObj.characters)) {
        out.characters = dbObj.characters.map((character) => {
            if (!character?.additionalAssetManifest) return character;
            const next = {
                ...character,
                additionalAssets: loadDescriptorItems(store, character.additionalAssetManifest),
            };
            delete next.additionalAssetManifest;
            return next;
        });
    }

    if (Array.isArray(dbObj.personas)) {
        out.personas = dbObj.personas.map((persona) => {
            const embedded = persona?.embeddedModule;
            if (!embedded?.assetManifest) return persona;
            const nextEmbedded = { ...embedded, assets: loadDescriptorItems(store, embedded.assetManifest) };
            delete nextEmbedded.assetManifest;
            return { ...persona, embeddedModule: nextEmbedded };
        });
    }

    return out;
}

function assetManifestSummary(dbObj) {
    const descriptors = [];
    for (const module of dbObj?.modules || []) if (module?.assetManifest) descriptors.push(module.assetManifest);
    for (const character of dbObj?.characters || []) {
        if (character?.additionalAssetManifest) descriptors.push(character.additionalAssetManifest);
    }
    for (const persona of dbObj?.personas || []) {
        if (persona?.embeddedModule?.assetManifest) descriptors.push(persona.embeddedModule.assetManifest);
    }
    return {
        manifests: descriptors.length,
        items: descriptors.reduce((sum, descriptor) => sum + (Number(descriptor.count) || 0), 0),
        descriptors,
    };
}

module.exports = {
    stripAssetManifests,
    hydrateAssetManifests,
    assetManifestSummary,
    moduleOwnerId,
    characterOwnerId,
    personaOwnerId,
};
