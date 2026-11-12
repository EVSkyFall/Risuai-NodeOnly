import { beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({ db: {} as any }))

vi.mock('src/ts/stores.svelte', async () => {
    const { writable } = await import('svelte/store')
    return { selectedCharID: writable(0), DBState: { get db() { return harness.db } } }
})
vi.mock('src/ts/storage/database.svelte', () => ({}))
vi.mock('src/ts/parser/chatVar.svelte', () => ({ getChatVar: () => '', setChatVar: () => {} }))
vi.mock('src/ts/tokenizer', () => ({ tokenize: async () => 1 }))
vi.mock('src/ts/parser/parser.svelte', () => ({ risuChatParser: (text: string) => text }))
vi.mock('src/ts/util', () => ({ findCharacterbyId: () => undefined, pickHashRand: () => 0, selectSingleFile: vi.fn() }))
vi.mock('src/ts/alert', () => ({ alertError: vi.fn(), notifySuccess: vi.fn() }))
vi.mock('src/lang', () => ({ language: {} }))
vi.mock('src/ts/globalApi.svelte', () => ({ downloadFile: vi.fn() }))
vi.mock('src/ts/process/modules', () => ({ getModuleLorebooks: () => [] }))

import { loadLoreBookV3Prompt } from './lorebook.svelte'

const lore = (extras: Record<string, unknown>) => ({
    key: '', secondkey: '', insertorder: 100, comment: '', content: '',
    mode: 'normal', alwaysActive: false, selective: false, ...extras,
})

beforeEach(() => {
    harness.db = {
        username: 'User',
        loreBookDepth: 5,
        loreBookToken: 100_000,
        characters: [{
            name: 'Char',
            chatPage: 0,
            globalLore: [
                lore({ comment: 'always', content: 'always text', alwaysActive: true }),
                lore({ comment: 'keyed', content: 'dragon text', key: 'dragon' }),
                lore({ comment: 'unmatched', content: 'unicorn text', key: 'unicorn' }),
                lore({ comment: 'forced', content: '@@activate\nforced text', key: 'nomatch' }),
                lore({ comment: 'local', content: 'local text', key: 'nothing', id: 'local-id' }),
            ],
            chats: [{
                fmIndex: -1,
                message: [{ role: 'user', data: 'hello dragon' }],
                // "Activate locally" in the lorebook UI stores this child entry.
                localLore: [lore({ mode: 'child', alwaysActive: true, id: 'local-id', insertorder: 100 })],
            }],
        }],
    }
})

describe('loadLoreBookV3Prompt constant flag', () => {
    test('marks always-active entries constant and every other activation not constant', async () => {
        const { actives } = await loadLoreBookV3Prompt()
        const bySource = Object.fromEntries(actives.map((a) => [a.source, a.constant]))
        expect(bySource).toEqual({
            always: true,
            keyed: false,
            forced: false,
            local: true,
        })
    })

    test('existing fields of an active are unchanged', async () => {
        const { actives } = await loadLoreBookV3Prompt()
        expect(actives.find((a) => a.source === 'keyed')).toEqual({
            depth: 0, pos: '', prompt: 'dragon text', role: 'system', order: 100, tokens: 1,
            priority: 100, source: 'keyed', inject: null, constant: false,
        })
    })
})
