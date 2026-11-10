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

type IdentifiedEntry = { id?: string }
type IdentifiedCharacter = { chaId?: string }
type IdentifiedChat = { id?: string }

export type RebasedSelectionInput = {
    mergedBotPresets: IdentifiedEntry[] | undefined
    localBotPresets: IdentifiedEntry[] | undefined
    localBotPresetsId: number | undefined
    mergedPersonas?: IdentifiedEntry[] | undefined
    localPersonas?: IdentifiedEntry[] | undefined
    localSelectedPersona?: number | undefined
    mergedCharacters: IdentifiedCharacter[] | undefined
    localCharacters: IdentifiedCharacter[] | undefined
    localSelectedCharIndex: number
}

export type RebasedSelection = {
    botPresetsId: number
    selectedPersona?: number
    selectedCharIndex: number
}

export function reanchorRebasedSelection(input: RebasedSelectionInput): RebasedSelection {
    const out: RebasedSelection = {
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
    if (input.localSelectedPersona !== undefined || input.mergedPersonas !== undefined) {
        out.selectedPersona = reanchorPersonaIndex(
            input.mergedPersonas,
            input.localPersonas,
            input.localSelectedPersona,
        )
    }
    return out
}

export function reanchorPresetIndex(
    merged: IdentifiedEntry[] | undefined,
    local: IdentifiedEntry[] | undefined,
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

export function reanchorPersonaIndex(
    merged: IdentifiedEntry[] | undefined,
    local: IdentifiedEntry[] | undefined,
    localId: number | undefined,
): number {
    return reanchorPresetIndex(merged, local, localId)
}

export function reanchorCharacterIndex(
    merged: IdentifiedCharacter[] | undefined,
    local: IdentifiedCharacter[] | undefined,
    localIndex: number,
): number {
    if (localIndex < 0) return localIndex
    const chaId = Array.isArray(local) ? local[localIndex]?.chaId : undefined
    if (!chaId || !Array.isArray(merged)) return -1
    return merged.findIndex((character) => character?.chaId === chaId)
}

export function reanchorChatPage(
    mergedChats: IdentifiedChat[] | undefined,
    localChar: { chatPage?: number; chats?: IdentifiedChat[] } | undefined,
    remoteChar: { chatPage?: number } | undefined,
): number {
    const chatsLen = Array.isArray(mergedChats) ? mergedChats.length : 0
    if (chatsLen === 0) return 0
    if (localChar && Array.isArray(localChar.chats) && typeof localChar.chatPage === 'number') {
        const openChat = localChar.chats[localChar.chatPage]
        if (openChat?.id) {
            const byId = mergedChats!.findIndex((c) => c?.id === openChat.id)
            if (byId >= 0) return byId
        }
    }
    const fallbackPage = typeof remoteChar?.chatPage === 'number' && Number.isFinite(remoteChar.chatPage)
        ? Math.trunc(remoteChar.chatPage)
        : (typeof localChar?.chatPage === 'number' && Number.isFinite(localChar.chatPage)
            ? Math.trunc(localChar.chatPage)
            : 0)
    return Math.min(Math.max(fallbackPage, 0), chatsLen - 1)
}
