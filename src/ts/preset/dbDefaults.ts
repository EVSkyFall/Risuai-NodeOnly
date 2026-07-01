import type { ApiKeyPoolEntry, ModelPreset, ModelPresetMigrationSummary, RegistryCache } from './types'

export interface ModelPresetDefaultsTarget {
    modelPresets?: ModelPreset[]
    modelPresetMigrationVersion?: number
    modelPresetMigrationAppliedAt?: number
    modelPresetMigrationReport?: ModelPresetMigrationSummary
    apiKeyPool?: Record<string, ApiKeyPoolEntry>
    modelProfileRegistryCache?: RegistryCache
    modelProfileRegistryLastFetched?: number
    modelProfileVisibilityLevel?: 'all' | 'hideDeprecated' | 'currentOnly'
}

export function createEmptyRegistryCache(): RegistryCache {
    return {
        schemaVersion: 4,
        registries: {},
    }
}

export function applyModelPresetDefaults(data: ModelPresetDefaultsTarget): void {
    if (!Array.isArray(data.modelPresets)) {
        data.modelPresets = []
    }
    if (!data.apiKeyPool || typeof data.apiKeyPool !== 'object' || Array.isArray(data.apiKeyPool)) {
        data.apiKeyPool = {}
    }
    if (!data.modelProfileRegistryCache || data.modelProfileRegistryCache.schemaVersion !== 4) {
        data.modelProfileRegistryCache = createEmptyRegistryCache()
    }
    data.modelProfileRegistryLastFetched ??= 0
    // Default to current-only: most users want just the latest models; outdated
    // /deprecated profiles stay downloaded but hidden until opted into.
    data.modelProfileVisibilityLevel ??= 'currentOnly'
}
