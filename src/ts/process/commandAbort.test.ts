import { beforeEach, describe, expect, test, vi } from 'vitest'
import { get } from 'svelte/store'
const harness = vi.hoisted(() => ({
    chat: { id: 'command-chat', message: [] as any[] },
    send: vi.fn(), trigger: vi.fn(), setChat: vi.fn(),
}))
vi.mock('../storage/database.svelte', () => ({
    getDatabase: () => ({ characters: [{ type: 'character', chatPage: 0, chats: [harness.chat] }] }),
    getCurrentCharacter: () => ({ type: 'character', chatPage: 0, chats: [harness.chat] }),
    getCurrentChat: () => harness.chat,
    setCurrentChat: harness.setChat,
    setDatabase: vi.fn(),
}))
vi.mock('../stores.svelte', () => ({ selectedCharID: { subscribe: (run: any) => { run(0); return () => {} } } }))
vi.mock('../parser/parser.svelte', () => ({ risuChatParser: (value: string) => value }))
vi.mock('../alert', () => ({ alertInput: vi.fn(), alertMd: vi.fn(), alertNormal: vi.fn(), alertSelect: vi.fn() }))
vi.mock('./tts', () => ({ sayTTS: vi.fn() }))
vi.mock('./lorebook.svelte', () => ({ loadLoreBookV3Prompt: vi.fn() }))
vi.mock('./index.svelte', () => ({ sendChat: harness.send }))
vi.mock('./triggers', () => ({ runTrigger: harness.trigger }))
import { processMultiCommand } from './command'
import { abortGeneration, endAllGenerations, endGeneration, generationStates, registerAbort, startGeneration } from './generationState'

beforeEach(() => { endAllGenerations(); harness.chat.message = []; vi.clearAllMocks() })
function prepare() {
    const controller = new AbortController()
    registerAbort(harness.chat.id, controller)
    startGeneration(harness.chat.id, 'input-command')
    return controller
}
describe('command preprocessing Stop', () => {
    test('manual trigger receives Stop and cannot publish a late chat', async () => {
        const controller = prepare()
        let release!: (value: any) => void
        harness.trigger.mockImplementation(() => new Promise(resolve => { release = resolve }))
        const pending = processMultiCommand('/trigger waiting', controller.signal)
        for (let i = 0; i < 20; i++) await Promise.resolve()
        expect(harness.trigger.mock.calls[0][2].signal).toBe(controller.signal)
        abortGeneration(harness.chat.id)
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        release({ chat: { message: [{ data: 'late' }] } })
        for (let i = 0; i < 20; i++) await Promise.resolve()
        expect(harness.setChat).not.toHaveBeenCalled()
    })
    test('multisend hands its controller to the nested send and stops before the next message', async () => {
        const controller = prepare()
        harness.send.mockImplementation(async (_index, arg) => {
            expect(get(generationStates).has(harness.chat.id)).toBe(false)
            expect(arg.signal).toBe(controller.signal)
            startGeneration(harness.chat.id, 'nested')
            expect(get(generationStates).get(harness.chat.id)?.abortController).toBe(controller)
            return new Promise(() => {})
        })
        const pending = processMultiCommand('/multisend "first|||second"', controller.signal, 'input-command')
        for (let i = 0; i < 30; i++) await Promise.resolve()
        expect(harness.send).toHaveBeenCalledOnce()
        abortGeneration(harness.chat.id)
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        expect(harness.chat.message).toHaveLength(1)
    })
    test('normal multisend preserves the parent controller between sends', async () => {
        const controller = prepare()
        harness.send.mockImplementation(async () => { startGeneration(harness.chat.id, 'nested'); return true })
        await processMultiCommand('/multisend "first|||second"', controller.signal, 'input-command')
        expect(harness.send).toHaveBeenCalledTimes(2)
        expect(get(generationStates).get(harness.chat.id)).toMatchObject({ generationId: 'input-command', abortController: controller })
    })
})


test('a multisend invoked by an active trigger cannot hand off that generation', async () => {
    const controller = prepare()
    startGeneration(harness.chat.id, 'active-send')
    const actualSend = vi.fn()
    harness.send.mockImplementation(async () => {
        if (get(generationStates).has(harness.chat.id)) return false
        actualSend()
        return true
    })
    await processMultiCommand('/multisend "first|||second"', controller.signal)
    expect(actualSend).not.toHaveBeenCalled()
    expect(get(generationStates).get(harness.chat.id)).toMatchObject({ generationId: 'active-send', abortController: controller })
})


test('multisend restores Stop even when a nested send cleared its pending controller', async () => {
    const controller = prepare()
    harness.send.mockImplementation(async () => {
        startGeneration(harness.chat.id, 'nested')
        endGeneration(harness.chat.id)
        return false
    })
    await processMultiCommand('/multisend first', controller.signal, 'input-command')
    expect(get(generationStates).get(harness.chat.id)).toMatchObject({ generationId: 'input-command', abortController: controller })
    expect(abortGeneration(harness.chat.id)).toBe(true)
    expect(controller.signal.aborted).toBe(true)
})
