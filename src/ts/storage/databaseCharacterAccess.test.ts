import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../stores.svelte', async () => {
    const { writable } = await import('svelte/store')
    return {
        DBState: { db: {} as any },
        selectedCharID: writable(-1),
        selIdState: { selId: -1 },
    }
})

vi.mock('../globalApi.svelte', () => ({
    forageStorage: { realStorage: null },
    downloadFile: () => {},
    saveAsset: () => Promise.resolve(''),
}))

vi.mock('../alert', () => ({
    notifySuccess: () => {},
    alertError: () => {},
}))

vi.mock('../../lang', () => ({
    language: {},
    changeLanguage: () => {},
}))

const databaseModule = await import('./database.svelte')
const storesModule = await import('../stores.svelte')
const { getCharacterByIndex, getCurrentCharacter, getCurrentContextLite } = databaseModule
const { DBState, selectedCharID } = storesModule as any

function makeCharacter(name: string, chaId: string) {
    return {
        name,
        chaId,
        chatPage: 0,
        chats: [{
            id: `${chaId}-chat`,
            name: `${name} chat`,
            message: [{ role: 'user', data: `${name} message` }],
        }],
    } as any
}

beforeEach(() => {
    DBState.db = { characters: [] }
    selectedCharID.set(-1)
})

describe('character snapshot access', () => {
    test('getCurrentCharacter snapshots only the selected character', () => {
        const selected = makeCharacter('Selected', 'selected-id')
        const other = makeCharacter('Other', 'other-id')
        let otherCharacterReads = 0
        Object.defineProperty(other, 'expensiveDeepField', {
            enumerable: true,
            get() {
                otherCharacterReads += 1
                return { nested: 'other' }
            },
        })
        DBState.db = { characters: [selected, other] }
        selectedCharID.set(0)

        const result = getCurrentCharacter({ snapshot: true })

        expect(otherCharacterReads).toBe(0)
        expect(result).not.toBe(selected)
        expect(result.chats).not.toBe(selected.chats)
        expect(result.chats[0]).not.toBe(selected.chats[0])

        result.name = 'Mutated'
        result.chats[0].name = 'Mutated chat'
        result.chats[0].message[0].data = 'Mutated message'

        expect(selected.name).toBe('Selected')
        expect(selected.chats[0].name).toBe('Selected chat')
        expect(selected.chats[0].message[0].data).toBe('Selected message')
    })

    test('getCharacterByIndex snapshots only the requested character', () => {
        const other = makeCharacter('Other', 'other-id')
        const target = makeCharacter('Target', 'target-id')
        let otherCharacterReads = 0
        Object.defineProperty(other, 'expensiveDeepField', {
            enumerable: true,
            get() {
                otherCharacterReads += 1
                return { nested: 'other' }
            },
        })
        DBState.db = { characters: [other, target] }

        const result = getCharacterByIndex(1, { snapshot: true })

        expect(otherCharacterReads).toBe(0)
        expect(result).not.toBe(target)
        expect(result.chats).not.toBe(target.chats)
        expect(result.chats[0]).not.toBe(target.chats[0])

        result.name = 'Mutated'
        result.chats[0].name = 'Mutated chat'
        result.chats[0].message[0].data = 'Mutated message'

        expect(target.name).toBe('Target')
        expect(target.chats[0].name).toBe('Target chat')
        expect(target.chats[0].message[0].data).toBe('Target message')
    })

    test('preserves undefined snapshot results and live access semantics', () => {
        DBState.db = {}
        selectedCharID.set(4)

        expect(getCurrentCharacter({ snapshot: true })).toBeUndefined()
        expect(DBState.db.characters).toBeUndefined()
        expect(getCurrentCharacter()).toBeUndefined()
        expect(DBState.db.characters).toEqual([])

        DBState.db = {}
        expect(getCharacterByIndex(4, { snapshot: true })).toBeUndefined()
        expect(DBState.db.characters).toBeUndefined()
        expect(getCharacterByIndex(4)).toBeUndefined()
        expect(DBState.db.characters).toEqual([])

        const live = makeCharacter('Live', 'live-id')
        DBState.db = { characters: [live] }
        selectedCharID.set(0)
        expect(getCurrentCharacter()).toBe(live)
        expect(getCharacterByIndex(0)).toBe(live)
    })
})

describe('lite current context', () => {
    test('returns a detached scalar-only view of the selected character and chat', () => {
        const selected = makeCharacter('Selected', 'selected-id')
        let deepMessageReads = 0
        Object.defineProperty(selected.chats[0], 'message', {
            enumerable: true,
            get() {
                deepMessageReads += 1
                return [{ role: 'user', data: 'deep message' }]
            },
        })
        DBState.db = { characters: [selected] }
        selectedCharID.set(0)

        const result = getCurrentContextLite()

        expect(result).toEqual({
            chaId: 'selected-id',
            name: 'Selected',
            chatPage: 0,
            chatId: 'selected-id-chat',
            chatName: 'Selected chat',
        })
        expect(deepMessageReads).toBe(0)

        result.chaId = 'mutated-id'
        result.name = 'Mutated'
        result.chatName = 'Mutated chat'
        expect(selected.chaId).toBe('selected-id')
        expect(selected.name).toBe('Selected')
        expect(selected.chats[0].name).toBe('Selected chat')
    })

    test('returns nulls when no character is selected', () => {
        DBState.db = {}
        selectedCharID.set(-1)

        expect(getCurrentContextLite()).toEqual({
            chaId: null,
            name: null,
            chatPage: null,
            chatId: null,
            chatName: null,
        })
    })

    test('keeps character scalars when the current chat is missing', () => {
        const selected = makeCharacter('', 'selected-id')
        selected.chatPage = 3
        selected.chats = []
        DBState.db = { characters: [selected] }
        selectedCharID.set(0)

        expect(getCurrentContextLite()).toEqual({
            chaId: 'selected-id',
            name: '',
            chatPage: 3,
            chatId: null,
            chatName: null,
        })
    })
})
