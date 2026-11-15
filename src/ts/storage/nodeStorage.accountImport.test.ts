import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../alert', () => ({
    alertInput: vi.fn(),
    waitAlert: vi.fn(),
    notifyError: vi.fn(),
}))

vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(),
    encodeRisuSaveLegacy: vi.fn(),
}))

vi.mock('./database.svelte', () => ({
    normalizeChat: (chat: any) => chat,
}))

const { NodeStorage } = await import('./nodeStorage')

// NodeOnly puts no time limit on these requests (fork policy: no timeouts),
// and there is no writer-session event for a refused write: upstream's tests
// of both are left out. A cut-off answer must still fail.
function setUpStorage(fetchMock: ReturnType<typeof vi.fn>) {
    ;(NodeStorage as any).sessionInitialized = true
    ;(NodeStorage as any).sessionPending = null
    const storage = new NodeStorage(fetchMock as any, { baseDelayMs: 0, delay: vi.fn(async () => {}), random: () => 1 })
    storage.authChecked = true
    vi.spyOn(storage, 'createAuth').mockResolvedValue('token')
    return storage
}

/** A response whose body the test writes. */
function streamResponse() {
    const encoder = new TextEncoder()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
    return {
        response: new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } }),
        push: (line: string) => controller.enqueue(encoder.encode(line + '\n')),
        end: () => controller.close(),
        fail: (error: Error) => controller.error(error),
    }
}

describe('NodeStorage RisuAI account import', () => {
    afterEach(() => { vi.restoreAllMocks() })

    test('a status read whose body is cut off fails instead of reading as an empty status', async () => {
        const truncated = streamResponse()
        const broken = streamResponse()
        const fetchMock = vi.fn().mockResolvedValueOnce(truncated.response).mockResolvedValueOnce(broken.response)
        const storage = setUpStorage(fetchMock)

        truncated.push('{"state":')
        truncated.end()
        await expect(storage.getRisuAccountImportStatus()).rejects.toBeInstanceOf(SyntaxError)

        const pending = storage.getRisuAccountImportStatus()
        broken.push('{"state":')
        broken.fail(new TypeError('network error'))
        await expect(pending).rejects.toThrow()
    })
})
