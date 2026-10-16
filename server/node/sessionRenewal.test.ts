import { afterEach, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = fs.readFileSync(new URL('./server.cjs', import.meta.url), 'utf8')
const ast = ts.createSourceFile('server.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const functions = ast.statements.filter(n => ts.isFunctionDeclaration(n)
    && ['parseSessionCookie', 'saveSessions'].includes(n.name?.text ?? '')).map(n => n.getText(ast)).join('\n')
const route = ast.statements.find(n => n.getText(ast).startsWith("app.post('/api/session',"))!.getText(ast)
const lifetime = 7 * 24 * 60 * 60 * 1000

function fixture() {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const sessions = new Map<string, number>()
    const writeFileSync = vi.fn()
    const checkAuth = vi.fn(async () => true)
    const randomBytes = vi.fn(() => Buffer.alloc(32, 1))
    const logger = { error: vi.fn() }
    let handler: any
    const context = vm.createContext({ sessions, writeFileSync, checkAuth, logger, Date,
        setTimeout, clearTimeout, nodeCrypto: { randomBytes }, SESSION_FILE: 'synthetic-session-store',
        app: { post: (_path: string, fn: any) => { handler = fn } } })
    vm.runInContext(`let sessionSaveTimer, sessionRetryDelay = 5000;\n${functions}\n${route}`, context)
    const request = async (cookie?: string) => {
        const req = { headers: { cookie } }
        const res = { setHeader: vi.fn(), json: vi.fn() }
        await handler(req, res)
        return { req, res }
    }
    return { sessions, writeFileSync, checkAuth, randomBytes, logger, request }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

test('renewal extends the same valid token and sends its fresh cookie', async () => {
    const f = fixture()
    f.sessions.set('existing', Date.now() + 1000)
    const { res } = await f.request('other=value; risu-session=existing; tail=value')
    expect(f.sessions.get('existing')).toBe(Date.now() + lifetime)
    expect(f.sessions.size).toBe(1)
    expect(f.randomBytes).not.toHaveBeenCalled()
    expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie',
        'risu-session=existing; HttpOnly; SameSite=Strict; Max-Age=604800; Path=/')
    expect(res.json).toHaveBeenCalledWith({ ok: true })
})

test.each(['missing', 'expired', 'at-expiry', 'unknown'])('%s cookie mints a fresh session', async kind => {
    const f = fixture()
    if (kind === 'expired') f.sessions.set('old', Date.now() - 1)
    if (kind === 'at-expiry') f.sessions.set('old', Date.now())
    const { res } = await f.request(kind === 'missing' ? undefined : 'risu-session=old')
    const minted = Buffer.alloc(32, 1).toString('hex')
    expect(f.randomBytes).toHaveBeenCalledWith(32)
    expect(f.sessions.get(minted)).toBe(Date.now() + lifetime)
    expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie',
        `risu-session=${minted}; HttpOnly; SameSite=Strict; Max-Age=604800; Path=/`)
    expect(JSON.parse(f.writeFileSync.mock.calls[0][1])).toContainEqual([minted, Date.now() + lifetime])
    if (kind === 'expired') expect(f.sessions.has('old')).toBe(false)
})

test('renewal persists the extended expiry through saveSessions and prunes stale entries', async () => {
    const f = fixture()
    f.sessions.set('existing', Date.now() + 1000)
    f.sessions.set('stale', Date.now() - 1)
    await f.request('risu-session=existing')
    expect(f.writeFileSync).toHaveBeenCalledWith('synthetic-session-store',
        JSON.stringify([['existing', Date.now() + lifetime]]))
})

test('renewal persistence failure retries the latest extended expiry', async () => {
    const f = fixture()
    f.sessions.set('existing', Date.now() + 1000)
    f.writeFileSync.mockImplementationOnce(() => { throw new Error('synthetic disk failure') })
    await f.request('risu-session=existing')
    expect(f.logger.error).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.writeFileSync).toHaveBeenCalledTimes(2)
    expect(JSON.parse(f.writeFileSync.mock.calls[1][1])).toEqual([['existing', 1_000_000 + lifetime]])
})

test('even a valid cookie still requires JWT authentication to renew', async () => {
    const f = fixture()
    f.sessions.set('existing', Date.now() + 1000)
    f.checkAuth.mockResolvedValue(false)
    const { req, res } = await f.request('risu-session=existing')
    expect(f.checkAuth).toHaveBeenCalledWith(req, res)
    expect(f.sessions.get('existing')).toBe(Date.now() + 1000)
    expect(f.writeFileSync).not.toHaveBeenCalled()
    expect(res.setHeader).not.toHaveBeenCalled()
    expect(f.randomBytes).not.toHaveBeenCalled()
})
