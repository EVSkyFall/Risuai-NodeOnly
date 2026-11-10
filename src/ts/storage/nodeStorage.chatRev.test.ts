import { afterEach, expect, test, vi } from 'vitest'
vi.mock('../alert', () => ({ alertInput: vi.fn(), waitAlert: vi.fn(), notifyError: vi.fn() }))
vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(async (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes))),
    encodeRisuSaveLegacy: vi.fn((chat: unknown) => new TextEncoder().encode(JSON.stringify(chat))),
}))
vi.mock('./database.svelte', () => ({ normalizeChat: (c: any) => c }))
const { NodeStorage, DurableChatSaveError } = await import('./nodeStorage')
const { createChatDeltaSync } = await import('./chatDeltaSync')

// The revision a chat save builds on travels in x-chat-base-rev; the server's
// answer to it is an outcome the caller settles, not an error.

const json = (status: number, body: any, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers })
function storage(respond: (headers: Headers, init: RequestInit) => Response | Promise<Response>) {
    const s = new NodeStorage()
    const seen: Headers[] = []
    vi.spyOn(s as any, 'authFetch').mockImplementation(async (_url: any, init: RequestInit = {}) => {
        const headers = new Headers(init.headers)
        seen.push(headers)
        return respond(headers, init)
    })
    return { s, seen }
}
afterEach(() => { vi.restoreAllMocks() })

const chat = { id: 'x', message: [{ role: 'user', data: 'hello' }] }

test('a save names its base revision and returns the new one', async () => {
    const { s, seen } = storage(() => json(200, { success: true, revision: 'r2' }))
    expect(await s.postChatContent('c', 0, 'x', chat, { baseRev: 'r1' })).toEqual({ status: 'ok', revision: 'r2' })
    expect(seen[0].get('x-chat-base-rev')).toBe('r1')
    expect(seen[0].get('x-chat-id')).toBe('x')
    expect(seen[0].has('x-strict-flush')).toBe(false)
    expect(seen[0].has('x-chat-fork-of')).toBe(false)
})

test('a chat the server does not hold yet is sent without a base, a fork names its origin', async () => {
    const { s, seen } = storage(() => json(200, { success: true }, { 'x-chat-rev': 'from-header' }))
    expect(await s.postChatContent('c', 3, 'f', chat, { forkOf: 'x' })).toEqual({ status: 'ok', revision: 'from-header' })
    expect(seen[0].has('x-chat-base-rev')).toBe(false)
    expect(seen[0].get('x-chat-fork-of')).toBe('x')
})

test('a refused revision is an outcome for delta, full and strict saves alike', async () => {
    const { s } = storage(() => json(409, { success: false, code: 'CHAT_REV_CONFLICT', revision: 'theirs' }))
    const conflict = { status: 'conflict', revision: 'theirs' }
    expect(await s.postChatContent('c', 0, 'x', chat, { baseRev: 'mine' })).toEqual(conflict)
    expect(await s.postChatContent('c', 0, 'x', chat, { baseRev: 'mine', strict: true })).toEqual(conflict)
    expect(await s.postChatContent('c', 0, 'x', chat, { baseRev: 'mine', deltaBase: { count: 1, fp: 'p' } })).toEqual(conflict)
    // The pre-revision entry point has no way to settle it and fails as before.
    await expect(s.saveChatContentDeltaUnqueued('c', 0, 'x', chat, null)).rejects.toThrow('409')
})

test('a delta whose prefix does not verify still asks for a full save', async () => {
    const { s } = storage(() => json(409, { code: 'CHAT_DELTA_BASE_MISMATCH' }))
    expect(await s.postChatContent('c', 0, 'x', chat, { baseRev: 'r', deltaBase: { count: 1, fp: 'p' } })).toEqual({ status: 'base-mismatch' })
})

test('a strict save resolves only on a durable acknowledgement', async () => {
    const durable = storage((headers) => {
        expect(headers.get('x-strict-flush')).toBe('1')
        return json(200, { success: true, durable: true, revision: 'r2' })
    })
    expect(await durable.s.postChatContent('c', 0, 'x', chat, { baseRev: 'r1', strict: true }))
        .toEqual({ status: 'ok', revision: 'r2', durable: { success: true, durable: true, revision: 'r2' } })

    const notDurable = storage(() => json(200, { success: true, revision: 'r2' }))
    await expect(notDurable.s.postChatContent('c', 0, 'x', chat, { strict: true })).rejects.toBeInstanceOf(DurableChatSaveError)
    const failed = storage(() => json(500, { success: false, error: 'disk full', source: 'chat-content' }))
    await expect(failed.s.postChatContent('c', 0, 'x', chat, { strict: true })).rejects.toMatchObject({ message: 'disk full', status: 500, source: 'chat-content' })
    const offline = storage(() => { throw new TypeError('Failed to fetch') })
    await expect(offline.s.postChatContent('c', 0, 'x', chat, { strict: true })).rejects.toBeInstanceOf(DurableChatSaveError)
    await expect(offline.s.postChatContent('c', 0, 'x', chat, {})).rejects.toBeInstanceOf(TypeError)
})

test('a fetch against the revision this tab holds costs no body when nothing changed', async () => {
    const { s, seen } = storage((headers) => headers.get('x-chat-base-rev') === 'r1'
        ? new Response(null, { status: 204, headers: { 'x-chat-rev': 'r1' } })
        : new Response(JSON.stringify(chat), { status: 200, headers: { 'x-chat-rev': 'r1' } }))
    expect(await s.fetchChatContentDelta('c', 0, 'x', null, 'r1')).toEqual({ notModified: true, revision: 'r1' })
    expect(await s.fetchChatContentDelta('c', 0, 'x', null)).toEqual({ chat, deltaBase: null, revision: 'r1' })
    expect(seen[1].has('x-chat-base-rev')).toBe(false)
    expect(await s.fetchChatContentWithRevision('c', 0, 'x')).toEqual({ chat, revision: 'r1' })
})

test('delta sync carries the revision through: unchanged, conflict, and a full save after a prefix mismatch', async () => {
    const answers: Response[] = []
    const { s, seen } = storage(() => answers.shift()!)
    const copies = { get: vi.fn(async () => null), put: vi.fn(async () => {}) }
    const sync = createChatDeltaSync({
        fetchChatContentDelta: (...args) => s.fetchChatContentDelta(...args),
        saveChatContentDelta: (...args) => s.saveChatContentDeltaUnqueued(...args),
        postChatContent: (...args) => s.postChatContent(...args),
    }, copies)

    answers.push(new Response(JSON.stringify(chat), { status: 200, headers: { 'x-chat-rev': 'r1' } }))
    expect(await sync.fetchChatRev('c', 0, 'x')).toEqual({ kind: 'ok', chat, revision: 'r1' })

    // A check against a known revision does not read the local copy first.
    copies.get.mockClear()
    answers.push(new Response(null, { status: 204, headers: { 'x-chat-rev': 'r1' } }))
    expect(await sync.fetchChatRev('c', 0, 'x', 'r1')).toEqual({ kind: 'same', revision: 'r1' })
    expect(copies.get).not.toHaveBeenCalled()
    answers.push(json(404, {}))
    expect(await sync.fetchChatRev('c', 0, 'x', 'r1')).toEqual({ kind: 'missing' })

    const longer: any = { ...chat, message: [...chat.message, { role: 'char', data: 'reply' }] }
    seen.length = 0
    answers.push(json(409, { code: 'CHAT_REV_CONFLICT', revision: 'r9' }))
    expect(await sync.postChat('c', 0, 'x', longer, { baseRev: 'r1' })).toEqual({ status: 'conflict', revision: 'r9' })
    expect(seen).toHaveLength(1)
    expect(seen[0].get('x-chat-base-count')).toBe('1')

    // The prefix is refused: the whole chat goes out, on the same base revision.
    seen.length = 0
    answers.push(json(409, { code: 'CHAT_DELTA_BASE_MISMATCH' }), json(200, { success: true, revision: 'r2' }))
    expect(await sync.postChat('c', 0, 'x', longer, { baseRev: 'r1' })).toEqual({ status: 'ok', revision: 'r2' })
    expect(seen.map((h) => [h.has('x-chat-base-count'), h.get('x-chat-base-rev')])).toEqual([[true, 'r1'], [false, 'r1']])
})
