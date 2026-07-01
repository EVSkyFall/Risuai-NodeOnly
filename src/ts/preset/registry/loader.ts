import type { BaseProviderDefinition, ModelProfile, RegistryCache } from '../types'

const BUNDLED_REGISTRY_ID = 'bundled'

const baseProviderModules = import.meta.glob<BaseProviderDefinition>('./bundled/base-providers/*.json', {
    eager: true,
    import: 'default',
})

const profileModules = import.meta.glob<ModelProfile>('./bundled/profiles/**/*.json', {
    eager: true,
    import: 'default',
})

let cachedRegistry: RegistryCache | undefined

function buildBundledRegistry(): RegistryCache {
    const baseProviders: Record<string, BaseProviderDefinition> = {}
    for (const definition of Object.values(baseProviderModules)) {
        baseProviders[definition.id] = definition
    }

    const profiles: Record<string, ModelProfile> = {}
    for (const profile of Object.values(profileModules)) {
        profiles[profile.id] = profile
    }

    return {
        schemaVersion: 4,
        registries: {
            [BUNDLED_REGISTRY_ID]: {
                fetchedAt: 0,
                baseProviders,
                profiles,
            },
        },
    }
}

export function loadBundledRegistry(): RegistryCache {
    if (!cachedRegistry) {
        cachedRegistry = buildBundledRegistry()
    }
    return cachedRegistry
}

export function getBundledRegistryId(): string {
    return BUNDLED_REGISTRY_ID
}
