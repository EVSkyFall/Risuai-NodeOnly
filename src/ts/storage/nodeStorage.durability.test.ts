import { afterEach, expect, test, vi } from 'vitest'
vi.mock('../alert', () => ({ alertInput: vi.fn(), waitAlert: vi.fn(), notifyError: vi.fn() }))
vi.mock('./risuSave', () => ({ decodeRisuSave: vi.fn(), encodeRisuSaveLegacy: vi.fn() }))
vi.mock('./database.svelte', () => ({ normalizeChat: (c: any) => c }))
const { NodeStorage, ConflictError } = await import('./nodeStorage')
const json = (status: number, body: any) => new Response(JSON.stringify(body), { status })
const token = (exp: number, iat = 100) => `synthetic.${Buffer.from(JSON.stringify({ exp, iat })).toString('base64url')}.synthetic`
function storage() {
    ;(NodeStorage as any).sessionInitialized = true
    ;(NodeStorage as any).sessionPending = null
    return new NodeStorage()
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('cause4: patch 409 leaves old ETag so full write raises ConflictError', async () => {
    const s = storage()
    s.authChecked = true
    vi.spyOn(s, 'createAuth').mockResolvedValue('synthetic')
    s.setDbEtag('old')
    const fetch = vi.fn(async (_url, init) => {
        if (_url === '/api/patch') return json(409, { currentEtag: 'new' })
        expect(new Headers(init.headers).get('x-if-match')).toBe('old')
        return json(409, { error: 'changed', currentEtag: 'new' })
    })
    vi.stubGlobal('fetch', fetch)
    expect(await s.patchItem('database/database.bin', { patch: [], expectedHash: 'old' })).toMatchObject({ success: false })
    await expect(s.setItem('database/database.bin', new Uint8Array([1]), s._lastDbEtag)).rejects.toBeInstanceOf(ConflictError)
})

test('cause7a: expiration uses JWT lifetime at receipt, including login and test_auth', async () => {
    vi.useFakeTimers(); vi.setSystemTime(100000)
    const s = storage() as any
    const issued = token(200)
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { status: 'success', token: issued })))
    await s._refreshToken()
    expect(s.cachedJwt.expiresAt).toBe(200000)
    await s.loginWithPassword('synthetic')
    expect(s.cachedJwt.expiresAt).toBe(200000)
    s.authChecked = false
    await s.checkAuth()
    expect(s.cachedJwt.expiresAt).toBe(200000)
})

test('cause7b: half-life refresh runs off request path and valid token never waits', async () => {
    vi.useFakeTimers(); vi.setSystemTime(100000)
    const s = storage() as any
    let resolve: (r: Response) => void
    const fetch = vi.fn().mockResolvedValueOnce(json(200, { token: token(200) }))
        .mockImplementationOnce(() => new Promise<Response>(r => { resolve = r }))
    vi.stubGlobal('fetch', fetch)
    await s.createAuth()
    await vi.advanceTimersByTimeAsync(50000)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(await s.createAuth()).toBe(token(200))
    await vi.advanceTimersByTimeAsync(30000)
    expect(await s.createAuth()).toBe(token(200))
    resolve(json(200, { token: token(400) }))
    await s.refreshPending
    expect(s.cachedJwt.expiresAt).toBe(480000)
})

test('cause7c: failed refresh recovers via test_auth; failed recovery rejects, never stale/empty', async () => {
    vi.useFakeTimers(); vi.setSystemTime(100000)
    const s = storage() as any
    s.cachedJwt = { token: token(90), expiresAt: 90000 }; s.authChecked = true
    const fetch = vi.fn().mockResolvedValueOnce(json(503, {}))
        .mockResolvedValueOnce(json(200, { status: 'success', token: token(200) }))
    vi.stubGlobal('fetch', fetch)
    expect(await s.createAuth()).toBe(token(200))
    expect(fetch.mock.calls.map(c => c[0])).toEqual(['/api/token/refresh', '/api/test_auth'])
    fetch.mockResolvedValueOnce(json(503, {})).mockRejectedValueOnce(new Error('offline'))
    await expect(s.createAuth(true)).rejects.toThrow('offline')
    expect(s.authChecked).toBe(false)
})

test('cause7d: apparent auth success without a token does not latch authChecked', async () => {
    const s = storage() as any
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { status: 'success' })))
    await expect(s.checkAuth()).rejects.toThrow()
    expect(s.authChecked).toBe(false)
    expect(s.cachedJwt).toBeNull()
})

test('cause7: background recovery failure retries and session initialization never joins itself', async () => {
    vi.useFakeTimers(); vi.setSystemTime(100000)
    const s = storage() as any
    ;(NodeStorage as any).sessionInitialized = false
    const fetch = vi.fn().mockResolvedValueOnce(json(200, { token: token(200) }))
        .mockResolvedValueOnce(json(503, {})).mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(json(503, {})).mockResolvedValueOnce(json(200, { status: 'success', token: token(400) }))
        .mockResolvedValueOnce(json(200, {}))
    vi.stubGlobal('fetch', fetch)
    await s.createAuth()
    await vi.advanceTimersByTimeAsync(55000)
    expect(s.cachedJwt.token).toBe(token(400))
    await s.checkAuth()
    expect((NodeStorage as any).sessionInitialized).toBe(true)
    expect(fetch.mock.calls.at(-1)[0]).toBe('/api/session')
})

test('cause7a-browser: JWT payload decodes with the shipped browser Buffer polyfill', async () => {
    vi.useFakeTimers(); vi.setSystemTime(100000)
    const issued = token(200)
    const { Buffer: BrowserBuffer } = await import('buffer/')
    vi.stubGlobal('Buffer', BrowserBuffer)
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { token: issued })))
    const s = storage() as any
    expect(await s.createAuth()).toBe(issued)
    expect(s.cachedJwt.expiresAt).toBe(200000)
})

test.each([90, 100])('round2-E: nonpositive server lifetime %s uses growing refresh backoff', async exp => {
    vi.useFakeTimers(); vi.setSystemTime(100000)
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const issued = token(exp as any)
    const fetch = vi.fn(async () => json(200, { token: issued }))
    vi.stubGlobal('fetch', fetch)
    const s = storage() as any
    await s.createAuth()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(timer).toHaveBeenLastCalledWith(expect.any(Function), 5000)
    for (const delay of [5000, 10000, 20000, 40000, 60000]) {
        const count = fetch.mock.calls.length
        await vi.advanceTimersByTimeAsync(delay - 1)
        expect(fetch).toHaveBeenCalledTimes(count)
        await vi.advanceTimersByTimeAsync(1)
        expect(fetch).toHaveBeenCalledTimes(count + 1)
    }
    fetch.mockImplementation(async () => json(200, { token: token((Date.now() + 100000) / 1000, Date.now() / 1000) }))
    await vi.advanceTimersByTimeAsync(60000)
    expect(s.refreshRetryDelay).toBe(5000)
})


test.each([-86400000, 86400000])('round3-4: fresh token stays usable with client clock skew %s', async skew => {
    vi.useFakeTimers(); vi.setSystemTime(100000 + skew)
    const s = storage() as any
    const issued = token(400, 100)
    const fetch = vi.fn(async () => json(200, { token: issued }))
    vi.stubGlobal('fetch', fetch)
    expect(await s.createAuth()).toBe(issued)
    expect(s.cachedJwt.expiresAt).toBe(400000 + skew)
    expect(await s.createAuth()).toBe(issued)
    await vi.advanceTimersByTimeAsync(149999)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(2)
})

test.each([
    {}, { exp: 400 }, { iat: 100 }, { iat: null, exp: 400 }, { iat: 100, exp: null },
    { iat: 'bad', exp: 400 }, { iat: 100, exp: 'bad' },
    { iat: 'Infinity', exp: 400 }, { iat: 100, exp: 'Infinity' },
])('round3-4: missing/non-finite fields use five minutes at receipt: %j', async payload => {
    vi.useFakeTimers(); vi.setSystemTime(86400000)
    const s = storage() as any
    const issued = `synthetic.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.synthetic`
    const fetch = vi.fn(async () => json(200, { token: issued }))
    vi.stubGlobal('fetch', fetch)
    await s.createAuth()
    expect(s.cachedJwt.expiresAt).toBe(86700000)
    expect(await s.createAuth()).toBe(issued)
    await vi.advanceTimersByTimeAsync(149999)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(2)
})
