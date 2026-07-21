import { describe, test, expect } from 'vitest'
import { reanchorRebasedSelection } from './rebaseSelection'

// 2026-07-21 multi-browser incident #2: the rebase kept the LOCAL
// botPresetsId scalar while adopting the SERVER botPresets array (and swapped
// the characters array under the UI's index-based selection), so an index
// could point at the wrong element or out of bounds — saveCurrentPreset then
// crashed reading `botPresets[botPresetsId].name`. Selections must re-anchor
// by identity against the merged arrays.

const preset = (id: string) => ({ id })
const char = (chaId: string) => ({ chaId })

describe('reanchorRebasedSelection — bot preset index', () => {
    test('follows the active preset id to its new index in the merged array', () => {
        const result = reanchorRebasedSelection({
            localBotPresets: [preset('a'), preset('b'), preset('c')],
            localBotPresetsId: 2,
            mergedBotPresets: [preset('c'), preset('a')],
            mergedCharacters: [],
            localCharacters: [],
            localSelectedCharIndex: -1,
        })
        expect(result.botPresetsId).toBe(0)
    })

    test('clamps into bounds when the active preset was deleted server-side', () => {
        const result = reanchorRebasedSelection({
            localBotPresets: [preset('a'), preset('b'), preset('c')],
            localBotPresetsId: 2,
            mergedBotPresets: [preset('x'), preset('y')],
            mergedCharacters: [],
            localCharacters: [],
            localSelectedCharIndex: -1,
        })
        // The out-of-bounds local index (2) must never survive against a
        // 2-entry merged array — this was the crash.
        expect(result.botPresetsId).toBe(1)
    })

    test('preserves the explicit no-preset state and handles empty arrays', () => {
        const noSelection = reanchorRebasedSelection({
            localBotPresets: [preset('a')],
            localBotPresetsId: -1,
            mergedBotPresets: [preset('a')],
            mergedCharacters: [],
            localCharacters: [],
            localSelectedCharIndex: -1,
        })
        expect(noSelection.botPresetsId).toBe(-1)

        const emptyMerged = reanchorRebasedSelection({
            localBotPresets: [preset('a')],
            localBotPresetsId: 0,
            mergedBotPresets: [],
            mergedCharacters: [],
            localCharacters: [],
            localSelectedCharIndex: -1,
        })
        expect(emptyMerged.botPresetsId).toBe(-1)
    })
})

describe('reanchorRebasedSelection — selected character index', () => {
    test('follows the selected chaId to its new index after the merge reordered characters', () => {
        const result = reanchorRebasedSelection({
            localBotPresets: [],
            localBotPresetsId: -1,
            mergedBotPresets: [],
            localCharacters: [char('c1'), char('c2'), char('c3')],
            localSelectedCharIndex: 2,
            mergedCharacters: [char('c3'), char('c1'), char('c2')],
        })
        expect(result.selectedCharIndex).toBe(0)
    })

    test('returns -1 (deselect) when the selected character was deleted server-side', () => {
        const result = reanchorRebasedSelection({
            localBotPresets: [],
            localBotPresetsId: -1,
            mergedBotPresets: [],
            localCharacters: [char('c1'), char('c2')],
            localSelectedCharIndex: 1,
            mergedCharacters: [char('c1')],
        })
        expect(result.selectedCharIndex).toBe(-1)
    })

    test('keeps an inactive selection (-1) and an unchanged layout stable', () => {
        const inactive = reanchorRebasedSelection({
            localBotPresets: [],
            localBotPresetsId: -1,
            mergedBotPresets: [],
            localCharacters: [char('c1')],
            localSelectedCharIndex: -1,
            mergedCharacters: [char('c1')],
        })
        expect(inactive.selectedCharIndex).toBe(-1)

        const unchanged = reanchorRebasedSelection({
            localBotPresets: [],
            localBotPresetsId: -1,
            mergedBotPresets: [],
            localCharacters: [char('c1'), char('c2')],
            localSelectedCharIndex: 1,
            mergedCharacters: [char('c1'), char('c2')],
        })
        expect(unchanged.selectedCharIndex).toBe(1)
    })
})
