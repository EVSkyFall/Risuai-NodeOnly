import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../alert', () => ({
    alertInput: vi.fn(),
    waitAlert: vi.fn(),
    notifyError: vi.fn(),
}))

vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(async () => ({ id: 'chat-1', message: [] })),
    encodeRisuSaveLegacy: vi.fn(),
}))

vi.mock('./database.svelte', () => ({
    normalizeChat: (chat: any) => chat,
}))

const { NodeStorage } = await import('./nodeStorage')

const TIMEOUT_MS = 30_000

function setUpStorage(fetchMock: ReturnType<typeof vi.fn>) {
    ;(NodeStorage as any).sessionInitialized = true
    ;(NodeStorage as any).sessionPending = null
    const storage = new NodeStorage(fetchMock as any, { baseDelayMs: 0, delay: vi.fn(async () => {}), random: () => 1 })
    storage.authChecked = true
    vi.spyOn(storage, 'createAuth').mockResolvedValue('token')
    return storage
}

/** A fetch that never answers until its signal aborts — a half-open link. */
function hangingFetch() {
    return vi.fn((_input: any, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
}

function octetResponse() {
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/octet-stream' } })
}

describe('NodeStorage slow response and caller cancellation', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

    test('a slow chat response stays in flight without a first-byte deadline', async () => {
        let release!: (r: Response) => void
        const fetchMock = vi.fn(() => new Promise<Response>(resolve => { release = resolve }))
        const storage = setUpStorage(fetchMock)
        let settled = false
        const pending = storage.fetchChatContent('char-1', 0, 'chat-1').finally(() => { settled = true })
        await vi.advanceTimersByTimeAsync(120_000)
        expect(settled).toBe(false)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        release(octetResponse())
        await expect(pending).resolves.toEqual({ id: 'chat-1', message: [] })
    })

    test('manifest pages retain format version without a deadline', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ total: 0, offset: 0, limit: 500, items: [] }), { headers: { 'content-type': 'application/json' } }))
        const storage = setUpStorage(fetchMock)
        await expect(storage.getAssetManifestPage({ id: 'm1', version: 1, count: 0, sha256: 'x' }, { offset: 0, limit: 500 })).resolves.toMatchObject({ total: 0 })
        expect(String(fetchMock.mock.calls[0][0])).toBe('/api/asset-manifests/m1?offset=0&limit=500&v=1')
        expect(vi.getTimerCount()).toBe(0)
    })
})
