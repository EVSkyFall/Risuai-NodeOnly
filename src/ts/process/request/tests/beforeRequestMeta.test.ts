import { describe, expect, test } from 'vitest'
import { buildBeforeRequestMeta, isLorebookSlotPlaced, isNormalLoreActive } from '../beforeRequestMeta'

type Active = { pos: string, inject: unknown, constant: boolean, role: 'system' | 'user' | 'assistant', prompt: string }
const active = (prompt: string, extras: Partial<Active> = {}): Active => ({
    pos: '', inject: null, constant: false, role: 'system', prompt, ...extras,
})
const injectAt = { operation: 'append', location: 'main', param: '', lore: false }

// What sendChat pushes into unformated.lorebook: one rendered message per normal active.
const rendered = (actives: Active[]) => actives.filter(isNormalLoreActive).map((a) => ({ role: a.role, content: `rendered ${a.prompt}` }))

describe('buildBeforeRequestMeta', () => {
    test('keeps the order of the pushed lorebook messages', () => {
        const actives = [active('c'), active('a'), active('b')]
        const meta = buildBeforeRequestMeta(actives, rendered(actives), true)
        expect(meta.lorebook!.entries.map((e) => e.content)).toEqual(['rendered c', 'rendered a', 'rendered b'])
    })

    test('includes only the normal actives (no position, depth or inject decorators)', () => {
        const actives = [
            active('normal-1'),
            active('depth', { pos: 'depth' }),
            active('reverse', { pos: 'reverse_depth' }),
            active('after-desc', { pos: 'after_desc' }),
            active('pt', { pos: 'pt_slot' }),
            active('injected', { inject: injectAt }),
            active('normal-2', { role: 'user' }),
        ]
        const meta = buildBeforeRequestMeta(actives, rendered(actives), false)
        expect(meta.lorebook!.entries).toEqual([
            { role: 'system', content: 'rendered normal-1', constant: false },
            { role: 'user', content: 'rendered normal-2', constant: false },
        ])
    })

    test('takes role and content from the pushed messages and maps constant from the active', () => {
        const actives = [active('always', { constant: true }), active('keyed'), active('also-always', { constant: true, role: 'assistant' })]
        const messages = [
            { role: 'system', content: 'always rendered' },
            { role: 'system', content: 'keyed rendered' },
            { role: 'assistant', content: 'also-always rendered' },
        ]
        expect(buildBeforeRequestMeta(actives, messages, true)).toEqual({
            lorebook: {
                placed: true,
                entries: [
                    { role: 'system', content: 'always rendered', constant: true },
                    { role: 'system', content: 'keyed rendered', constant: false },
                    { role: 'assistant', content: 'also-always rendered', constant: true },
                ],
            },
        })
    })

    test('passes placed through and returns new entry objects', () => {
        const actives = [active('x')]
        const messages = rendered(actives)
        const meta = buildBeforeRequestMeta(actives, messages, false)
        expect(meta.lorebook!.placed).toBe(false)
        expect(meta.lorebook!.entries[0]).not.toBe(messages[0])
    })

    test('no actives gives an empty entry list', () => {
        expect(buildBeforeRequestMeta([], [], true)).toEqual({ lorebook: { placed: true, entries: [] } })
    })
})

describe('isLorebookSlotPlaced', () => {
    test('prompt-template mode: placed exactly when the template has a lorebook card', () => {
        expect(isLorebookSlotPlaced([{ type: 'plain' }, { type: 'lorebook' }, { type: 'chat' }], undefined)).toBe(true)
        expect(isLorebookSlotPlaced([{ type: 'plain' }, { type: 'chat' }, { type: 'postEverything' }], undefined)).toBe(false)
    })

    test('prompt-template mode ignores the legacy format order', () => {
        expect(isLorebookSlotPlaced([{ type: 'chat' }], ['main', 'lorebook', 'chats'])).toBe(false)
        expect(isLorebookSlotPlaced([{ type: 'lorebook' }], ['main', 'chats'])).toBe(true)
    })

    test('legacy format-order mode: placed exactly when the order includes lorebook', () => {
        expect(isLorebookSlotPlaced(undefined, ['main', 'description', 'lorebook', 'chats', 'postEverything'])).toBe(true)
        expect(isLorebookSlotPlaced(null, ['main', 'description', 'chats', 'postEverything'])).toBe(false)
    })
})
