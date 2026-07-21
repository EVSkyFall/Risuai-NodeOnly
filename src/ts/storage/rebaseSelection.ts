// Pure selection re-anchoring for the save loop's rebase path.
//
// The rebase mixes LOCAL root scalars with SERVER-side arrays: the wholesale
// local-root copy excludes `characters` and `botPresets`, but `botPresetsId`
// (a root scalar indexing into botPresets) rides along from local — and the
// UI's selectedCharID store indexes into the characters array that the rebase
// just replaced. When the two browsers' arrays differ in order or length, an
// index-based selection points at the wrong element or out of bounds
// (2026-07-21 multi-browser incident #2: saveCurrentPreset crashed reading
// `botPresets[botPresetsId].name`). Selections must be re-derived by stable
// IDENTITY (preset id / character chaId) against the merged arrays — the same
// principle as database.svelte.ts's withStableActivePreset, made pure here so
// the rebase (which operates on detached merged/local objects, not the global
// db) can use and test it.

type IdentifiedPreset = { id?: string }
type IdentifiedCharacter = { chaId?: string }

export type RebasedSelectionInput = {
    mergedBotPresets: IdentifiedPreset[] | undefined
    localBotPresets: IdentifiedPreset[] | undefined
    localBotPresetsId: number | undefined
    mergedCharacters: IdentifiedCharacter[] | undefined
    localCharacters: IdentifiedCharacter[] | undefined
    localSelectedCharIndex: number
}

export type RebasedSelection = {
    botPresetsId: number
    selectedCharIndex: number
}

export function reanchorRebasedSelection(input: RebasedSelectionInput): RebasedSelection {
    return {
        botPresetsId: reanchorPresetIndex(
            input.mergedBotPresets,
            input.localBotPresets,
            input.localBotPresetsId,
        ),
        selectedCharIndex: reanchorCharacterIndex(
            input.mergedCharacters,
            input.localCharacters,
            input.localSelectedCharIndex,
        ),
    }
}

function reanchorPresetIndex(
    merged: IdentifiedPreset[] | undefined,
    local: IdentifiedPreset[] | undefined,
    localId: number | undefined,
): number {
    const mergedLength = Array.isArray(merged) ? merged.length : 0
    // -1 is the legitimate "no preset selected" state — preserve it, and fall
    // back to it when the merged array has nothing to select.
    if (localId === -1 || localId === undefined) return -1
    if (mergedLength === 0) return -1
    const activeId = Array.isArray(local) ? local[localId]?.id : undefined
    if (activeId) {
        const byIdentity = merged!.findIndex((preset) => preset?.id === activeId)
        if (byIdentity >= 0) return byIdentity
    }
    // Active preset no longer exists in the merged array: clamp into bounds so
    // downstream index reads stay valid (mirrors withStableActivePreset).
    return Math.min(Math.max(localId, 0), mergedLength - 1)
}

function reanchorCharacterIndex(
    merged: IdentifiedCharacter[] | undefined,
    local: IdentifiedCharacter[] | undefined,
    localIndex: number,
): number {
    if (localIndex < 0) return localIndex
    const chaId = Array.isArray(local) ? local[localIndex]?.chaId : undefined
    if (!chaId || !Array.isArray(merged)) return -1
    return merged.findIndex((character) => character?.chaId === chaId)
}
