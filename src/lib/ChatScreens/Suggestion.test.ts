// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import Suggestion from './Suggestion.svelte'

const mocks = vi.hoisted(() => {
    function store<T>(initial: T) {
        let value = initial
        const subscribers = new Set<(next: T) => void>()
        return {
            subscribe(run: (next: T) => void) {
                run(value)
                subscribers.add(run)
                return () => subscribers.delete(run)
            },
            set(next: T) {
                value = next
                for (const run of subscribers) run(value)
            },
            update(updater: (current: T) => T) {
                this.set(updater(value))
            },
        }
    }

    return {
        db: {} as any,
        doingChat: store(false),
        generationStates: store(new Map<string, unknown>()),
        selectedCharID: store(0),
        requestChatData: vi.fn(),
        alertConfirm: vi.fn(),
    }
})

vi.mock('../../ts/process/index.svelte', () => ({ doingChat: mocks.doingChat }))
vi.mock('src/ts/process/request/request', () => ({ requestChatData: mocks.requestChatData }))
vi.mock('../../ts/process/generationState', () => ({
    chatGenKey: (chatId?: string) => chatId ?? 'nochat',
    generationStates: mocks.generationStates,
    syncDoingChat: () => mocks.doingChat.set(false),
}))
vi.mock('src/ts/stores.svelte', () => ({
    DBState: { get db() { return mocks.db } },
    selectedCharID: mocks.selectedCharID,
}))
vi.mock('../../ts/stores.svelte', () => ({
    DBState: { get db() { return mocks.db } },
    selectedCharID: mocks.selectedCharID,
}))
vi.mock('../../ts/storage/database.svelte', () => ({ setDatabase: vi.fn() }))
vi.mock('src/ts/translator/translator', () => ({ translate: async (text: string) => text }))
vi.mock('src/ts/alert', () => ({ alertConfirm: mocks.alertConfirm }))
vi.mock('src/lang', () => ({ language: { creatingSuggestions: 'Creating suggestions' } }))
vi.mock('../../lang', () => ({ language: { creatingSuggestions: 'Creating suggestions' } }))
vi.mock('../../ts/util', () => ({
    getUserName: () => 'User',
    replacePlaceholders: (text: string) => text,
}))
vi.mock('src/ts/parser/parser.svelte', () => ({ ParseMarkdown: async (text: string) => text }))
vi.mock('../../ts/storage/defaultPrompts.js', () => ({ defaultAutoSuggestPrompt: 'Suggest replies' }))

function makeDb() {
    return {
        characters: [{
            name: 'Rina',
            chatPage: 0,
            chats: [{
                id: 'chat-1',
                message: [{ role: 'user', data: 'Hello' }],
                suggestMessages: ['Old suggestion'],
            }],
        }],
        autoTranslate: false,
        translator: '',
        autoSuggestPrompt: 'Suggest replies',
        subModel: 'openai',
    }
}

let mounted: unknown

async function mountSuggestion() {
    const target = document.createElement('div')
    document.body.appendChild(target)
    mounted = mount(Suggestion, {
        target,
        props: { send: vi.fn(), messageInput: vi.fn() },
    })
    await tick()
    return target
}

beforeEach(() => {
    mocks.db = makeDb()
    mocks.doingChat.set(false)
    mocks.generationStates.set(new Map())
    mocks.selectedCharID.set(0)
    mocks.requestChatData.mockReset()
    mocks.requestChatData.mockResolvedValue({ type: 'success', result: '- Fresh suggestion' })
    mocks.alertConfirm.mockReset()
    mocks.alertConfirm.mockResolvedValue(true)
})

afterEach(async () => {
    if (mounted) await unmount(mounted as never)
    mounted = undefined
    document.body.replaceChildren()
})

describe('Suggestion invalidation', () => {
    test('busy true then false invalidates persisted suggestions and starts one fresh request', async () => {
        await mountSuggestion()
        expect(mocks.requestChatData).not.toHaveBeenCalled()

        mocks.doingChat.set(true)
        await tick()
        expect(mocks.db.characters[0].chats[0].suggestMessages).toEqual([])

        mocks.doingChat.set(false)
        await vi.waitFor(() => expect(mocks.requestChatData).toHaveBeenCalledTimes(1))
        await vi.waitFor(() => expect(mocks.db.characters[0].chats[0].suggestMessages).toEqual(['Fresh suggestion']))
    })

    test('manual refresh clears the persisted value and starts one fresh request', async () => {
        const target = await mountSuggestion()
        expect(mocks.requestChatData).not.toHaveBeenCalled()

        const refresh = target.querySelector<HTMLButtonElement>('button')
        expect(refresh).not.toBeNull()
        refresh!.click()

        await vi.waitFor(() => expect(mocks.requestChatData).toHaveBeenCalledTimes(1))
        await vi.waitFor(() => expect(mocks.db.characters[0].chats[0].suggestMessages).toEqual(['Fresh suggestion']))
    })
})
