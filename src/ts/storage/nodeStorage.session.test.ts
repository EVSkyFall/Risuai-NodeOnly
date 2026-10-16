import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.mock('../alert', () => ({ alertInput: vi.fn(), waitAlert: vi.fn(), notifyError: vi.fn() }))
vi.mock('./risuSave', () => ({ decodeRisuSave: vi.fn(), encodeRisuSaveLegacy: vi.fn() }))
vi.mock('./database.svelte', () => ({ normalizeChat: (c: any) => c }))
const { NodeStorage } = await import('./nodeStorage')
const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status })
const token = (id: number) => `synthetic.${Buffer.from(JSON.stringify({ iat: 100, exp: 200, id })).toString('base64url')}.synthetic`

function fixture() {
    let issued = 0
    const session = vi.fn(async (_url: string, _init?: RequestInit) => json({ ok: true }))
    const refresh = vi.fn(async () => json({ token: token(++issued) }))
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/session') return session(url, init)
        if (url === '/api/token/refresh') return refresh()
        if (url === '/api/test_auth') return json({ status: 'success', token: token(++issued) })
        if (url === '/api/list') return json({ content: ['assets/synthetic'] })
        throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    return { storage: new NodeStorage(), fetch, session, refresh }
}

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(100000)
    // Reset legacy state as well so the unmodified implementation is tested independently.
    ;(NodeStorage as any).sessionInitialized = false
    ;(NodeStorage as any).sessionPending = null
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('boot issues its cookie before the first storage read proceeds', async () => {
    const f = fixture()
    let release!: (r: Response) => void
    f.session.mockImplementationOnce(() => new Promise<Response>(r => { release = r }))
    const boot = f.storage.keys()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.session).toHaveBeenCalledTimes(1)
    expect(f.fetch.mock.calls.some(([url]) => url === '/api/list')).toBe(false)
    release(json({ ok: true }))
    expect(await boot).toEqual(['assets/synthetic'])
    expect(f.session).toHaveBeenCalledWith('/api/session', { method: 'POST', headers: { 'risu-auth': token(1) } })
})

test.each(['on-demand', 'background'])('%s JWT refresh renews after boot with the new JWT', async mode => {
    const f = fixture()
    await f.storage.keys()
    if (mode === 'on-demand') expect(await f.storage.createAuth(true)).toBe(token(2))
    else await vi.advanceTimersByTimeAsync(50000)
    expect(f.refresh).toHaveBeenCalledTimes(1)
    expect(f.session).toHaveBeenCalledTimes(2)
    expect(f.session).toHaveBeenLastCalledWith('/api/session', { method: 'POST', headers: { 'risu-auth': token(2) } })
})

test.each(['http', 'network'])('failed %s renewal warns and the next refresh retries', async failure => {
    const f = fixture()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await f.storage.keys()
    if (failure === 'http') f.session.mockResolvedValueOnce(json({}, 503))
    else f.session.mockRejectedValueOnce(new Error('synthetic offline'))
    expect(await f.storage.createAuth(true)).toBe(token(2))
    await vi.advanceTimersByTimeAsync(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(await f.storage.createAuth(true)).toBe(token(3))
    expect(f.session).toHaveBeenCalledTimes(3)
    const { notifyError, alertInput } = await import('../alert')
    expect(notifyError).not.toHaveBeenCalled()
    expect(alertInput).not.toHaveBeenCalled()
})

test('pending renewal neither delays JWT delivery nor suppresses the next renewal', async () => {
    const f = fixture()
    await f.storage.keys()
    let release!: (r: Response) => void
    f.session.mockImplementationOnce(() => new Promise<Response>(r => { release = r }))
    expect(await f.storage.createAuth(true)).toBe(token(2))
    expect(await f.storage.createAuth()).toBe(token(2))
    expect(await f.storage.createAuth(true)).toBe(token(3))
    expect(f.session).toHaveBeenCalledTimes(3)
    release(json({ ok: true }))
})

test('refresh recovered by test_auth renews using the recovered JWT', async () => {
    const f = fixture()
    await f.storage.keys()
    f.refresh.mockResolvedValueOnce(json({}, 503))
    expect(await f.storage.createAuth(true)).toBe(token(2))
    expect(f.session).toHaveBeenCalledTimes(2)
    expect(f.session).toHaveBeenLastCalledWith('/api/session', { method: 'POST', headers: { 'risu-auth': token(2) } })
})

test('failed boot issuance recovers at the next background refresh', async () => {
    const f = fixture()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    f.session.mockRejectedValueOnce(new Error('synthetic offline'))
    expect(await f.storage.keys()).toEqual(['assets/synthetic'])
    await vi.advanceTimersByTimeAsync(50000)
    expect(f.session).toHaveBeenCalledTimes(2)
})
