// Data-driven items for the Model Preset page's "Settings" tab.
// Rendered with SettingRenderer layout="row" (see ui.md "Setting 행 레이아웃").

import type { Database } from '../storage/database.svelte'
import type { SettingItem } from './types'

// Switching registry source (toggle / URL) should take effect on the next menu
// entry, not 5s later. Clearing last-fetched bypasses the debounce; the sync
// itself detects the source change (the cached entry's `source` no longer
// matches) and re-downloads, resetting the notice baseline accordingly.
function triggerRegistryResync(db: Database): void {
    db.modelProfileRegistryLastFetched = 0
}

export const modelPresetOptionsItems: SettingItem[] = [
    {
        id: 'modelPreset.visibilityLevel',
        type: 'select',
        labelKey: 'profileVisibilityLevel',
        helpKey: 'profileVisibilityLevel',
        bindKey: 'modelProfileVisibilityLevel',
        options: {
            // First option is the convention default (see SettingSelect reset
            // fallback) — keep it aligned with dbDefaults' 'currentOnly'.
            selectOptions: [
                { value: 'currentOnly', labelKey: 'profileVisibilityCurrentOnly' },
                { value: 'hideDeprecated', labelKey: 'profileVisibilityHideDeprecated' },
                { value: 'all', labelKey: 'profileVisibilityAll' },
            ],
        },
    },
    {
        id: 'modelPreset.useCustomRegistry',
        type: 'check',
        labelKey: 'useCustomRegistry',
        helpKey: 'useCustomRegistry',
        bindKey: 'useCustomModelRegistry',
        onChange: (_v, ctx) => triggerRegistryResync(ctx.db),
    },
    {
        id: 'modelPreset.customRegistryUrl',
        type: 'text',
        labelKey: 'customRegistryUrl',
        helpKey: 'customRegistryUrl',
        bindKey: 'modelProfileRegistryBaseUrl',
        condition: (ctx) => !!ctx.db.useCustomModelRegistry,
        options: { placeholder: 'https://raw.githubusercontent.com/<user>/<repo>/<branch>/' },
        onChange: (_v, ctx) => triggerRegistryResync(ctx.db),
    },
    {
        id: 'modelPreset.customRegistryWarning',
        type: 'custom',
        componentId: 'CustomizationWarning',
        componentProps: { messageKey: 'customRegistryWarning' },
        condition: (ctx) => !!ctx.db.useCustomModelRegistry,
    },
    {
        id: 'modelPreset.registryRefresh',
        type: 'custom',
        componentId: 'ModelRegistryRefresh',
    },
]
