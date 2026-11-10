import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ChatSyncHost } from './chatStorage'

const state = vi.hoisted(() => ({
    db: { characters: [] as any[] },
    host: null as unknown as ChatSyncHost,
    refresh: null as any,
    generationsChanged: null as any,
    notifyInfo: null as any,
    loadToggles: null as any,
    track: null as any,
}))
state.refresh = vi.fn()
state.generationsChanged = vi.fn()
state.notifyInfo = vi.fn()
state.loadToggles = vi.fn()
state.track = vi.fn()

vi.mock('src/lang', () => ({ language: { chatForkName: '{} (diverged)', chatForked: 'saved as "{}"', chatRefreshedRetry: 'refreshed, try again' } }))
vi.mock('../alert', () => ({ notifyInfo: (...args: unknown[]) => state.notifyInfo(...args) }))
vi.mock('../globalApi.svelte', () => ({ trackCharacterForSave: (...args: unknown[]) => state.track(...args) }))
vi.mock('../polyfill', () => ({ safeStructuredClone: (value: unknown) => structuredClone(value) }))
vi.mock('../stores.svelte', async () => ({ selectedCharID: (await import('svelte/store')).writable(0) }))
vi.mock('./database.svelte', () => ({ getDatabase: () => state.db, loadTogglesFromChat: (...args: unknown[]) => state.loadToggles(...args) }))
vi.mock('./chatStorage', () => ({
    configureChatSyncHost: (host: ChatSyncHost) => { state.host = host },
    refreshChatFromServer: (...args: unknown[]) => state.refresh(...args),
    chatGenerationsChanged: () => state.generationsChanged(),
}))

const { initChatSyncHost, refreshOpenChatBeforeSend } = await import('./chatSyncHost')
const { endGeneration, startGeneration } = await import('../process/generationState')

beforeEach(() => {
    state.db.characters = [{
        chaId: 'cha',
        chatPage: 1,
        reloadKeys: 0,
        chats: [
            { id: 'first', name: 'First', message: [] },
            { id: 'open', name: 'Open $& chat', message: [{ role: 'user', data: 'hi' }] },
        ],
    }]
    for (const mock of [state.refresh, state.generationsChanged, state.notifyInfo, state.loadToggles, state.track]) mock.mockReset()
})

// Trap 9
describe('refresh before a send', () => {
    test('a send with text always goes out, on the refreshed chat', async () => {
        state.refresh.mockResolvedValue({ status: 'updated', messagesChanged: true })
        expect(await refreshOpenChatBeforeSend('send')).toEqual({ run: true, changed: false, forked: false })
        expect(state.refresh).toHaveBeenCalledWith('cha', 'open')
        expect(state.notifyInfo).not.toHaveBeenCalled()
    })

    test.each(['continue', 'reroll', 'resend', 'resume'] as const)('%s does not run when the messages changed, and says so once', async (kind) => {
        state.refresh.mockResolvedValue({ status: 'updated', messagesChanged: true })
        expect(await refreshOpenChatBeforeSend(kind)).toEqual({ run: false, changed: true, forked: false })
        expect(state.notifyInfo).toHaveBeenCalledTimes(1)
        expect(state.notifyInfo).toHaveBeenCalledWith('refreshed, try again')
    })

    test.each([
        { status: 'unchanged', messagesChanged: false },
        { status: 'updated', messagesChanged: false },
        // A refresh that could not be made (offline, generating) never blocks.
        { status: 'skipped', messagesChanged: false },
    ] as const)('reroll runs after a refresh that ended $status without touching the message list', async (result) => {
        state.refresh.mockResolvedValue(result)
        expect(await refreshOpenChatBeforeSend('reroll')).toEqual({ run: true, changed: false, forked: false })
        expect(state.notifyInfo).not.toHaveBeenCalled()
    })

    test('a fork moves the action to the new chat and says so', async () => {
        state.refresh.mockImplementation(async () => {
            state.db.characters[0].chats.push({ id: 'fork', name: 'Open (diverged)', message: [] })
            state.db.characters[0].chatPage = 2
            return { status: 'forked', messagesChanged: false, forkId: 'fork' }
        })
        expect(await refreshOpenChatBeforeSend('send')).toEqual({ run: true, changed: false, forked: true })
    })

    test.each(['send', 'reroll'] as const)('%s does not run on a chat the user moved to while the refresh was under way', async (kind) => {
        state.refresh.mockImplementation(async () => {
            state.db.characters[0].chatPage = 0
            return { status: 'unchanged', messagesChanged: false }
        })
        expect(await refreshOpenChatBeforeSend(kind)).toEqual({ run: false, changed: false, forked: false })
        expect(state.notifyInfo).not.toHaveBeenCalled()
    })

    test('a chat that is still loading is not refreshed', async () => {
        state.db.characters[0].chats[1]._placeholder = true
        expect(await refreshOpenChatBeforeSend('reroll')).toEqual({ run: true, changed: false, forked: false })
        expect(state.refresh).not.toHaveBeenCalled()
    })
})

describe('what chat sync gets from the app', () => {
    test('finds a chat by ids and can move the open chat', () => {
        initChatSyncHost()
        const live = state.host.findLive('cha', 'open')!
        expect(live.index).toBe(1)
        expect(live.isOpen).toBe(true)
        expect(state.host.findLive('cha', 'first')!.isOpen).toBe(false)
        expect(state.host.findLive('cha', 'gone')).toBeNull()
        expect(state.host.findLive('nobody', 'open')).toBeNull()
        live.open(0)
        expect(state.db.characters[0].chatPage).toBe(0)
    })

    test('names a fork after the chat, whatever characters the name holds', () => {
        initChatSyncHost()
        expect(state.host.forkName('Open $& chat')).toBe('Open $& chat (diverged)')
        state.host.notifyForked('Open $1 chat (diverged)')
        expect(state.notifyInfo).toHaveBeenCalledWith('saved as "Open $1 chat (diverged)"')
    })

    test('replaced content of the chat on screen applies its toggles; any other chat does nothing', () => {
        initChatSyncHost()
        state.host.contentReplaced('cha', 'first')
        expect(state.loadToggles).not.toHaveBeenCalled()
        state.host.contentReplaced('cha', 'open')
        expect(state.loadToggles).toHaveBeenCalledWith(state.db.characters[0].chats[1])
        expect(state.db.characters[0].reloadKeys).toBe(1)
    })

    test('reports generations by chat id and passes on every change of the registry', () => {
        initChatSyncHost()
        state.generationsChanged.mockClear()
        startGeneration('open', 'gen-1')
        expect(state.host.isGenerating('open')).toBe(true)
        expect(state.host.isGenerating('first')).toBe(false)
        endGeneration('open')
        expect(state.host.isGenerating('open')).toBe(false)
        expect(state.generationsChanged.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
})
