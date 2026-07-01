/**
 * Prompt Preset Settings Data
 *
 * Data-driven definition for the new PromptPreset menu (SettingsMenuIndex 17).
 * Three tabs: basic info / prompt / advanced settings.
 *
 * Data layer is shared with BotSettings (db.botPresets, db.mainPrompt etc.).
 * Edits in either menu reflect immediately in the other — the new menu is a
 * different view of the same active preset.
 */

import type { SettingItem } from './types';

export const promptPresetBasicInfoItems: SettingItem[] = [
    {
        id: 'promptPreset.basicInfo',
        type: 'custom',
        componentId: 'PromptPresetBasicInfo',
        keywords: ['preset', 'name', 'icon', 'copy', 'export', 'import'],
    },
];

export const promptPresetPromptItems: SettingItem[] = [
    {
        id: 'promptPreset.editor',
        type: 'custom',
        componentId: 'PromptEditorSection',
        keywords: ['mainPrompt', 'jailbreak', 'globalNote', 'formatingOrder', 'promptPreprocess', 'promptTemplate'],
    },
];

export const promptPresetAdvancedItems: SettingItem[] = [
    {
        id: 'promptPreset.advanced.template',
        type: 'accordion',
        labelKey: 'promptTemplate',
        helpKey: 'botPromptTemplate',
        options: {
            styled: true,
            children: [
                {
                    id: 'promptPreset.advanced.template.block',
                    type: 'custom',
                    componentId: 'PromptTemplateBlock',
                },
            ],
        },
        keywords: ['template', 'prompt'],
    },
    {
        id: 'promptPreset.advanced.tools',
        type: 'accordion',
        labelKey: 'tools',
        helpKey: 'tools',
        options: {
            styled: true,
            children: [
                {
                    id: 'promptPreset.advanced.tools.block',
                    type: 'custom',
                    componentId: 'PromptToolsBlock',
                },
            ],
        },
        keywords: ['tools', 'search', 'modelTools'],
    },
    {
        id: 'promptPreset.advanced.regex',
        type: 'accordion',
        labelKey: 'regexScript',
        helpKey: 'botRegexScript',
        options: {
            styled: true,
            children: [
                {
                    id: 'promptPreset.advanced.regex.block',
                    type: 'custom',
                    componentId: 'PromptRegexBlock',
                },
            ],
        },
        keywords: ['regex', 'presetRegex'],
    },
    {
        id: 'promptPreset.advanced.moduleIntegration',
        type: 'accordion',
        labelKey: 'moduleIntergration',
        helpKey: 'moduleIntergration',
        options: {
            styled: true,
            children: [
                {
                    id: 'promptPreset.advanced.moduleIntegration.value',
                    type: 'textarea',
                    bindKey: 'moduleIntergration',
                },
            ],
        },
        keywords: ['module', 'integration'],
    },
];
