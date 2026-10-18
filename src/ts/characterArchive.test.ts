import { describe, test, expect, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'

// Deactivate → activate before the deactivation's save reached the server:
// the server still lists the character as active (409 ARCHIVE_ALREADY_ACTIVE).
// Activation used to drop the stub then, and the save that followed deleted
// the character from the database. And deactivation must not ask the server
// to archive before every earlier edit has actually been saved.

class CharacterArchiveError extends Error {
    code: string
    chats: string[]
    constructor(code: string, message: string, chats: string[] = []) {
        super(message)
        this.code = code
        this.chats = chats
    }
}

const flushSaves = vi.fn<() => Promise<boolean>>()
const trackCharacterForSave = vi.fn()
const requestImmediateSave = vi.fn()
const storage = {
    activateCharacter: vi.fn(),
    archiveCharacter: vi.fn(),
    archiveCharacters: vi.fn(),
}
const overlay = vi.fn()
const deselectCharacter = vi.fn()
const state: { db: any } = { db: null }

vi.mock('./globalApi.svelte', () => ({
    checkCharOrder: () => {},
    flushSaves: () => flushSaves(),
    forageStorage: { get realStorage() { return storage } },
    requestImmediateSave: () => requestImmediateSave(),
    requiresFullEncoderReload: { state: false },
    trackCharacterForSave: (id: string) => trackCharacterForSave(id),
}))
const { writable } = await import('svelte/store')
const selectedCharID = writable(-1)
vi.mock('./stores.svelte', async () => {
    return {
        DBState: { get db() { return state.db } },
        loadingOverlayStore: { set: (v: any) => overlay(v) },
        selectedCharID,
    }
})
vi.mock('./alert', () => ({
    alertConfirm: async () => true,
    alertError: vi.fn(),
    notifySuccess: () => {},
    notifyError: vi.fn(),
}))
vi.mock('./characters', () => ({ changeChar: () => {}, deselectCharacter: () => deselectCharacter() }))
vi.mock('./storage/chatStorage', () => ({ convertStubsToPlaceholders: (chats: any[]) => chats }))
vi.mock('./storage/nodeStorage', () => ({ CharacterArchiveError }))
vi.mock('src/lang', () => ({
    language: new Proxy({}, { get: (_t, key) => typeof key === 'string' && /(Confirm|Progress)$/.test(key) ? () => String(key) : String(key) }),
}))

const { activateCharacter, archiveCharacter, archiveCharacters, restoreTrashedCharacter, trashDeactivatedCharacter } = await import('./characterArchive')

const stub = { chaId: 'c1', name: 'One', archivedAt: 1000 }
const restored = () => ({ chaId: 'c1', name: 'One', chats: [{ id: 'x', name: 'Chat', _stub: true }] })

beforeEach(() => {
    vi.clearAllMocks()
    flushSaves.mockResolvedValue(true)
})

describe('activateCharacter', () => {
    test('waits for the pending save and retries when the server still has the character active', async () => {
        state.db = { characters: [], nodeOnlyArchivedCharacters: [{ ...stub }] }
        storage.activateCharacter
            .mockRejectedValueOnce(new CharacterArchiveError('ARCHIVE_ALREADY_ACTIVE', 'Character is already active'))
            .mockResolvedValueOnce(restored())
        expect(await activateCharacter('c1')).toBe(0)
        expect(flushSaves).toHaveBeenCalledTimes(1)
        expect(storage.activateCharacter).toHaveBeenNthCalledWith(2, 'c1', 1000)
        expect(state.db.characters.map((c: any) => c.chaId)).toEqual(['c1'])
        expect(state.db.nodeOnlyArchivedCharacters).toEqual([])
    })

    test('keeps the stub when the server still reports it active after saving', async () => {
        state.db = { characters: [], nodeOnlyArchivedCharacters: [{ ...stub }] }
        storage.activateCharacter.mockRejectedValue(new CharacterArchiveError('ARCHIVE_ALREADY_ACTIVE', 'Character is already active'))
        await expect(activateCharacter('c1')).rejects.toMatchObject({ code: 'ARCHIVE_ALREADY_ACTIVE' })
        expect(state.db.nodeOnlyArchivedCharacters).toEqual([stub])
        expect(state.db.characters).toEqual([])
    })

    test('can cancel the activation wait while keeping its stub', async () => {
        state.db = { characters: [], nodeOnlyArchivedCharacters: [{ ...stub }] }
        const controller = new AbortController()
        flushSaves.mockImplementation(async () => { controller.abort(); return false })
        storage.activateCharacter.mockRejectedValue(new CharacterArchiveError('ARCHIVE_ALREADY_ACTIVE', 'Character is already active'))
        await expect(activateCharacter('c1', controller.signal)).rejects.toBeInstanceOf(Error)
        expect(storage.activateCharacter).toHaveBeenCalledTimes(1)
        expect(state.db.nodeOnlyArchivedCharacters).toEqual([stub])
    })

    test('works on the database object current after the save, not the one it started with', async () => {
        const before = { characters: [], nodeOnlyArchivedCharacters: [{ ...stub }] }
        const after = { characters: [], nodeOnlyArchivedCharacters: [{ ...stub }] }
        state.db = before
        storage.activateCharacter
            .mockRejectedValueOnce(new CharacterArchiveError('ARCHIVE_ALREADY_ACTIVE', 'x'))
            .mockResolvedValueOnce(restored())
        flushSaves.mockImplementation(async () => { state.db = after; return true })
        await activateCharacter('c1')
        expect(after.characters.map((c: any) => c.chaId)).toEqual(['c1'])
        expect(after.nodeOnlyArchivedCharacters).toEqual([])
    })
})

describe('archiveCharacter', () => {
    test('cancels the archive wait while earlier edits remain queued', async () => {
        state.db = { characters: [{ chaId: 'c1', name: 'One', chats: [] }], nodeOnlyArchivedCharacters: [] }
        let finish!: (ok: boolean) => void
        flushSaves.mockImplementation(() => new Promise(r => { finish = r }))
        const pending = archiveCharacter(0, { skipConfirm: true })
        await vi.waitFor(() => expect(flushSaves).toHaveBeenCalled())
        const active = overlay.mock.calls.find(call => call[0].active)![0]
        expect(active.onCancel).toBeTypeOf('function')
        active.onCancel()
        expect(await pending).toBe(false)
        expect(storage.archiveCharacter).not.toHaveBeenCalled()
        expect(state.db.characters).toHaveLength(1)
        finish(true)
    })

    test('gives an id-less chat an id and saves it before the server builds the payload', async () => {
        const chat: any = { name: 'Chat 1', message: [{ role: 'user', data: 'hi' }] }
        const placeholder: any = { id: 'p', name: 'Old', message: [], _placeholder: true }
        state.db = { characters: [{ chaId: 'c1', name: 'One', chats: [chat, placeholder] }], nodeOnlyArchivedCharacters: [] }
        const order: string[] = []
        trackCharacterForSave.mockImplementation(() => order.push('track'))
        flushSaves.mockImplementation(async () => { order.push('flush'); return true })
        storage.archiveCharacter.mockImplementation(async () => { order.push('archive'); return { ...stub } })
        expect(await archiveCharacter(0, { skipConfirm: true })).toBe(true)
        expect(typeof chat.id).toBe('string')
        expect(chat.id.length).toBeGreaterThan(0)
        expect(placeholder.id).toBe('p')
        expect(trackCharacterForSave).toHaveBeenCalledWith('c1')
        expect(order.slice(0, 3)).toEqual(['track', 'flush', 'archive'])
        expect(state.db.characters).toEqual([])
        expect(state.db.nodeOnlyArchivedCharacters.map((s: any) => s.chaId)).toEqual(['c1'])
    })

    test('waits for the transition to be saved before reporting success', async () => {
        state.db = { characters: [{ chaId: 'c1', name: 'One', chats: [] }], nodeOnlyArchivedCharacters: [] }
        storage.archiveCharacter.mockResolvedValue({ ...stub })
        await archiveCharacter(0, { skipConfirm: true })
        // Once before the server call, once after moving the character.
        expect(flushSaves).toHaveBeenCalledTimes(2)
        expect(requestImmediateSave).not.toHaveBeenCalled()
    })
})

describe('archiveCharacters (bulk)', () => {
    const chars = (n: number) => Array.from({ length: n }, (_, i) => ({ chaId: `c${i}`, name: `C${i}`, chats: [] }))
    const okFor = (ids: string[]) => ids.map((chaId) => ({ chaId, ok: true, stub: { chaId, name: chaId, archivedAt: 1 } }))

    test('sends chunks of 20 and saves after each, with one save before the first', async () => {
        state.db = { characters: chars(45), nodeOnlyArchivedCharacters: [] }
        const order: string[] = []
        flushSaves.mockImplementation(async () => { order.push('flush'); return true })
        storage.archiveCharacters.mockImplementation(async (ids: string[]) => { order.push(`batch${ids.length}`); return okFor(ids) })
        const out = await archiveCharacters(state.db.characters.map((c: any) => c.chaId), { trash: true })
        expect(order).toEqual(['flush', 'batch20', 'flush', 'batch20', 'flush', 'batch5', 'flush'])
        expect(storage.archiveCharacters).toHaveBeenCalledWith(expect.any(Array), { acceptLostChats: true })
        expect(out).toMatchObject({ done: 45, failed: [], lost: [], stopped: false })
        expect(state.db.characters).toEqual([])
        expect(state.db.nodeOnlyArchivedCharacters).toHaveLength(45)
        expect(state.db.nodeOnlyArchivedCharacters.every((s: any) => typeof s.trashedAt === 'number')).toBe(true)
        expect(overlay).toHaveBeenLastCalledWith({ active: false, text: '', onCancel: null })
    })

    test('moves only the characters the server archived', async () => {
        state.db = { characters: chars(3), nodeOnlyArchivedCharacters: [] }
        storage.archiveCharacters.mockResolvedValue([
            { chaId: 'c0', ok: true, stub: { chaId: 'c0' } },
            { chaId: 'c1', ok: false, code: 'ARCHIVE_VERIFY_FAILED', error: 'bad' },
            { chaId: 'c2', ok: false, code: 'ARCHIVE_CHATS_UNAVAILABLE', error: 'lost', chats: ['X'] },
        ])
        const out = await archiveCharacters(['c0', 'c1', 'c2'])
        expect(storage.archiveCharacters).toHaveBeenCalledWith(['c0', 'c1', 'c2'], { acceptLostChats: false })
        expect(state.db.characters.map((c: any) => c.chaId)).toEqual(['c1', 'c2'])
        expect(out.done).toBe(1)
        expect(out.failed).toEqual([{ chaId: 'c1', name: 'C1', reason: 'bad' }])
        expect(out.lost).toEqual([{ chaId: 'c2', name: 'C2', chats: ['X'] }])
    })

    test('resumes remaining chunks after a transient save failure', async () => {
        state.db = { characters: chars(30), nodeOnlyArchivedCharacters: [] }
        flushSaves.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
        storage.archiveCharacters.mockImplementation(async (ids: string[]) => okFor(ids))
        const out = await archiveCharacters(state.db.characters.map((c: any) => c.chaId))
        expect(storage.archiveCharacters).toHaveBeenCalledTimes(2)
        expect(out).toMatchObject({ done: 30, stopped: false })
        expect(state.db.characters).toHaveLength(0)
    })

    test('waits for earlier edits and starts automatically when saving recovers', async () => {
        state.db = { characters: chars(2), nodeOnlyArchivedCharacters: [] }
        flushSaves.mockResolvedValue(false)
        storage.archiveCharacters.mockImplementation(async (ids: string[]) => okFor(ids))
        const pending = archiveCharacters(['c0', 'c1'])
        await vi.waitFor(() => expect(flushSaves).toHaveBeenCalled())
        expect(storage.archiveCharacters).not.toHaveBeenCalled()
        expect(state.db.characters).toHaveLength(2)
        flushSaves.mockResolvedValue(true)
        expect(await pending).toMatchObject({ done: 2, stopped: false })
        expect(overlay).toHaveBeenLastCalledWith({ active: false, text: '', onCancel: null })
    })

    test('accepts a second run and starts it automatically in submission order', async () => {
        state.db = { characters: chars(2), nodeOnlyArchivedCharacters: [] }
        let release!: () => void
        storage.archiveCharacters.mockImplementationOnce((ids: string[]) => new Promise((r) => { release = () => r(okFor(ids)) }))
            .mockImplementation(async (ids: string[]) => okFor(ids))
        const first = archiveCharacters(['c0'])
        const second = archiveCharacters(['c1'])
        await vi.waitFor(() => expect(storage.archiveCharacters).toHaveBeenCalledTimes(1))
        release()
        expect(await first).toMatchObject({ done: 1 })
        expect(await second).toMatchObject({ done: 1 })
        expect(storage.archiveCharacters.mock.calls.map(call => call[0])).toEqual([['c0'], ['c1']])
    })

    test('a failed run does not poison queued valid work', async () => {
        state.db = { characters: chars(2), nodeOnlyArchivedCharacters: [] }
        storage.archiveCharacters.mockRejectedValueOnce(new Error('request failed'))
            .mockImplementation(async (ids: string[]) => okFor(ids))
        const first = archiveCharacters(['c0']).catch(error => error)
        const second = archiveCharacters(['c1'])
        expect(await first).toMatchObject({ message: 'request failed' })
        expect(await second).toMatchObject({ done: 1 })
        expect(state.db.characters.map((c: any) => c.chaId)).toEqual(['c0'])
    })

    test('retries a transient failed middle chunk, then completes every remaining chunk', async () => {
        state.db = { characters: chars(45), nodeOnlyArchivedCharacters: [] }
        storage.archiveCharacters.mockImplementationOnce(async ids => okFor(ids))
            .mockRejectedValueOnce(new TypeError('network down'))
            .mockRejectedValueOnce(new CharacterArchiveError('HTTP_503', 'busy'))
            .mockImplementation(async ids => okFor(ids))
        const ids = state.db.characters.map(c => c.chaId)
        expect(await archiveCharacters(ids)).toMatchObject({ done: 45, stopped: false })
        expect(storage.archiveCharacters.mock.calls.map(c => c[0])).toEqual([ids.slice(0, 20), ids.slice(20, 40), ids.slice(20, 40), ids.slice(20, 40), ids.slice(40)])
    })

    test('cancel after a submitted chunk keeps its successes and leaves later chunks active', async () => {
        state.db = { characters: chars(25), nodeOnlyArchivedCharacters: [] }
        let finish!: () => void
        storage.archiveCharacters.mockImplementationOnce(ids => new Promise(resolve => { finish = () => resolve(okFor(ids)) }))
        const pending = archiveCharacters(state.db.characters.map(c => c.chaId))
        await vi.waitFor(() => expect(storage.archiveCharacters).toHaveBeenCalledTimes(1))
        overlay.mock.calls.find(call => call[0].active)![0].onCancel()
        finish()
        expect(await pending).toMatchObject({ done: 20, stopped: true })
        expect(state.db.characters.map(c => c.chaId)).toEqual(['c20', 'c21', 'c22', 'c23', 'c24'])
        expect(state.db.nodeOnlyArchivedCharacters).toHaveLength(20)
        expect(storage.archiveCharacters).toHaveBeenCalledTimes(1)
    })

    test('keeps the selected character selected by id, and deselects an archived one', async () => {
        state.db = { characters: chars(4), nodeOnlyArchivedCharacters: [] }
        selectedCharID.set(3)
        storage.archiveCharacters.mockImplementation(async (ids: string[]) => okFor(ids))
        await archiveCharacters(['c0', 'c1'])
        expect(get(selectedCharID)).toBe(1)
        expect(state.db.characters[1].chaId).toBe('c3')
        await archiveCharacters(['c3'])
        expect(deselectCharacter).toHaveBeenCalled()
        selectedCharID.set(-1)
    })
})

describe('trash keeps the folder', () => {
    // checkCharOrder is mocked out here; the real one drops trashed ids from
    // every folder, which `leaveOrder` stands in for.
    const leaveOrder = (chaId: string) => {
        for (const e of state.db.characterOrder) if (typeof e !== 'string') e.data = e.data.filter((id: string) => id !== chaId)
    }

    test('restoring puts the character back into the folder it was trashed from', () => {
        state.db = {
            characters: [],
            characterOrder: ['top', { id: 'F', name: 'F', data: ['c1', 'c2'], color: '' }],
            nodeOnlyArchivedCharacters: [{ ...stub }, { chaId: 'top', name: 'Top', archivedAt: 1 }],
        }
        expect(trashDeactivatedCharacter('c1')).toBe(true)
        expect(trashDeactivatedCharacter('top')).toBe(true)
        expect(state.db.nodeOnlyArchivedCharacters[0].trashedFromFolder).toBe('F')
        expect(state.db.nodeOnlyArchivedCharacters[1].trashedFromFolder).toBeUndefined()
        leaveOrder('c1')

        expect(restoreTrashedCharacter('c1')).toBe(true)
        expect(state.db.characterOrder[1].data).toEqual(['c2', 'c1'])
        expect(state.db.nodeOnlyArchivedCharacters[0].trashedAt).toBeUndefined()
        expect(state.db.nodeOnlyArchivedCharacters[0].trashedFromFolder).toBeUndefined()
    })

    test('a folder deleted meanwhile is not recreated', () => {
        state.db = {
            characters: [],
            characterOrder: [{ id: 'F', name: 'F', data: ['c1'], color: '' }],
            nodeOnlyArchivedCharacters: [{ ...stub }],
        }
        trashDeactivatedCharacter('c1')
        state.db.characterOrder = []
        expect(restoreTrashedCharacter('c1')).toBe(true)
        expect(state.db.characterOrder).toEqual([])
    })

    test('bulk trash records the folder of each character', async () => {
        state.db = {
            characters: [{ chaId: 'a', name: 'A', chats: [] }, { chaId: 'b', name: 'B', chats: [] }],
            characterOrder: ['a', { id: 'F', name: 'F', data: ['b'], color: '' }],
            nodeOnlyArchivedCharacters: [],
        }
        storage.archiveCharacters.mockResolvedValue([
            { chaId: 'a', ok: true, stub: { chaId: 'a', archivedAt: 1 } },
            { chaId: 'b', ok: true, stub: { chaId: 'b', archivedAt: 1 } },
        ])
        await archiveCharacters(['a', 'b'], { trash: true })
        const byId = Object.fromEntries(state.db.nodeOnlyArchivedCharacters.map((s: any) => [s.chaId, s]))
        expect(byId.a.trashedFromFolder).toBeUndefined()
        expect(byId.b.trashedFromFolder).toBe('F')
    })
})
