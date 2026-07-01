// Locale-aware text picker for registry-defined strings.
// Reads DBState.db.language and falls back to the base English string.
// Used by SchemaFormRenderer/SchemaFieldRenderer + ModelProfileBrowser.

import { DBState } from 'src/ts/stores.svelte'

export type RegistryLocale = 'ko' | 'en'

export function pickRegistryLocale(): RegistryLocale {
    return DBState.db?.language === 'ko' ? 'ko' : 'en'
}

export function localizeRegistryText(
    base: string | undefined,
    i18n: Record<string, string> | undefined,
    locale: RegistryLocale = pickRegistryLocale(),
): string {
    return i18n?.[locale] ?? base ?? ''
}

export function localizeDisplayName(
    item: { displayName: string; displayNameI18n?: Record<string, string> },
    locale: RegistryLocale = pickRegistryLocale(),
): string {
    return item.displayNameI18n?.[locale] ?? item.displayName
}

export function localizeDescription(
    item: { description?: string; descriptionI18n?: Record<string, string> },
    locale: RegistryLocale = pickRegistryLocale(),
): string {
    return item.descriptionI18n?.[locale] ?? item.description ?? ''
}

export function localizeGroupLabel(
    group: { label: string; labelI18n?: Record<string, string> },
    locale: RegistryLocale = pickRegistryLocale(),
): string {
    return group.labelI18n?.[locale] ?? group.label
}
