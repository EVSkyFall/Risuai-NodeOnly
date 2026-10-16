import { afterEach, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import nodeCrypto from 'node:crypto'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { Readable } from 'node:stream'
import vm from 'node:vm'
import express from 'express'
import ts from 'typescript'
import transport from './assetFileTransport.cjs'

const source = fs.readFileSync(new URL('./server.cjs', import.meta.url), 'utf8')
const ast = ts.createSourceFile('server.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const routes = ['/api/asset/:hexKey', '/api/db/flush', '/api/inlays/compress']
const functions = ['parseSessionCookie', 'hasValidSession', 'sessionAuthMiddleware', 'checkAuth', 'detectMime', 'resolveAssetPayload']
const extracted = ast.statements.filter(node => {
    if (ts.isFunctionDeclaration(node)) return functions.includes(node.name?.text ?? '')
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return false
    const call = node.expression
    const route = call.arguments[0]
    return ts.isPropertyAccessExpression(call.expression)
        && call.expression.expression.getText(ast) === 'app'
        && route && ts.isStringLiteral(route) && routes.includes(route.text)
}).map(node => node.getText(ast)).join('\n')

const servers: Server[] = []
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
        server.closeAllConnections()
    })))
})

async function fixture() {
    const app = express()
    app.use(express.json())
    const bytes = Buffer.from('synthetic asset bytes')
    const key = 'assets/public.png'
    const assetFileStore = {
        stat: vi.fn(async (name: string) => name === key ? { updated_at: 123 } : null),
        open: vi.fn(async () => ({ updated_at: 123, size: bytes.length, stream: Readable.from([bytes]) })),
    }
    const flushPendingDb = vi.fn(async () => {})
    const listInlayFiles = vi.fn(async () => [{ id: 'image', ext: 'png', filePath: 'synthetic-image' }])
    const writeInlayFile = vi.fn(async () => {})
    const kvDel = vi.fn()
    const jwtSecret = nodeCrypto.randomBytes(32)
    const cookie = 'risu-session=synthetic-session'
    const ctx = vm.createContext({
        app, Buffer, nodeCrypto, jwtSecret,
        sessions: new Map([['synthetic-session', Date.now() + 60_000]]),
        console: { log: vi.fn() }, logger: { error: vi.fn() },
        assetFileStore, sendAsset: transport.sendAsset, ASSET_EXT_MIME: { png: 'image/png' },
        queueStorageOperation: async (work: () => Promise<void>) => work(),
        flushPendingDb, dbEtag: 'synthetic-etag',
        COMPRESS_IMAGE_EXTS: new Set(['png']), listInlayFiles, writeInlayFile, kvDel,
        readInlaySidecar: async () => ({ type: 'image', ext: 'png', name: 'image' }),
        fs: { readFile: async () => Buffer.alloc(100) },
        getVips: async () => ({ Image: { newFromBuffer: () => ({
            writeToBuffer: () => Buffer.alloc(10), delete: () => {},
        }) } }),
    })
    vm.runInContext(extracted, ctx)
    expect(vm.runInContext('hasValidSession({ headers: { cookie: "risu-session=synthetic-session" } })', ctx)).toBe(true)
    const server = app.listen(0, '127.0.0.1')
    servers.push(server)
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test listener address')
    const base = `http://127.0.0.1:${address.port}`
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url')
    const signature = nodeCrypto.createHmac('sha256', jwtSecret).update(`${header}.${payload}`).digest('base64url')
    return {
        request: (url: string, init?: RequestInit) => fetch(base + url, init),
        assetUrl: `/api/asset/${Buffer.from(key).toString('hex')}`,
        token: `${header}.${payload}.${signature}`, cookie, bytes,
        assetFileStore, flushPendingDb, listInlayFiles, writeInlayFile, kvDel,
    }
}

test('asset serves an assets/ key without cookie or JWT', async () => {
    const f = await fixture()
    const response = await f.request(f.assetUrl)
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(response.headers.get('etag')).toBe('"123"')
})

test('anonymous asset HEAD, conditional GET and missing asset retain their semantics', async () => {
    const f = await fixture()
    const head = await f.request(f.assetUrl, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect(head.headers.get('content-length')).toBe(String(f.bytes.length))
    f.assetFileStore.open.mockClear()
    const cached = await f.request(f.assetUrl, { headers: { 'if-none-match': '"123"' } })
    expect(cached.status).toBe(304)
    expect(cached.headers.get('etag')).toBe('"123"')
    expect(cached.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(f.assetFileStore.open).not.toHaveBeenCalled()
    const missing = await f.request(`/api/asset/${Buffer.from('assets/missing.png').toString('hex')}`)
    expect(missing.status).toBe(404)
    expect(missing.headers.get('cache-control')).toBe('no-store')
})

test('db flush succeeds without cookie or JWT', async () => {
    const f = await fixture()
    const response = await f.request('/api/db/flush', { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, etag: 'synthetic-etag' })
    expect(f.flushPendingDb).toHaveBeenCalledOnce()
})

test('compress rejects a valid cookie without JWT before any compression or SSE', async () => {
    const f = await fixture()
    const response = await f.request('/api/inlays/compress', { method: 'POST', headers: { cookie: f.cookie } })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'No auth header' })
    expect(response.headers.get('content-type')).not.toContain('text/event-stream')
    expect(f.listInlayFiles).not.toHaveBeenCalled()
    expect(f.writeInlayFile).not.toHaveBeenCalled()
})

async function expectCompression(response: Response, f: Awaited<ReturnType<typeof fixture>>) {
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const events = (await response.text()).trim().split('\n\n').map(line => JSON.parse(line.slice(6)))
    expect(events).toEqual([
        { type: 'progress', current: 1, total: 1, compressed: 1, skipped: 0, totalSaved: 90 },
        { type: 'done', total: 1, compressed: 1, skipped: 0, totalSaved: 90 },
    ])
    expect(f.writeInlayFile).toHaveBeenCalledWith('image', 'webp', Buffer.alloc(10), { type: 'image', ext: 'webp', name: 'image' })
    expect(f.kvDel).toHaveBeenCalledWith('inlay_thumb/image')
}

test('compress proceeds with a valid JWT and no cookie', async () => {
    const f = await fixture()
    const response = await f.request('/api/inlays/compress', { method: 'POST', headers: { 'risu-auth': f.token } })
    await expectCompression(response, f)
})

test('compression button fetch obtains the shared JWT and completes compression without a cookie', async () => {
    const f = await fixture()
    const component = fs.readFileSync(new URL('../../src/lib/Setting/Pages/Advanced/InlayCompressButton.svelte', import.meta.url), 'utf8')
    const script = component.split('<script lang="ts">')[1].split('</script>')[0]
    const clientAst = ts.createSourceFile('button.ts', script, ts.ScriptTarget.Latest, true)
    let fetchCall: ts.CallExpression | undefined
    function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && node.expression.getText(clientAst) === 'fetch') fetchCall = node
        ts.forEachChild(node, visit)
    }
    visit(clientAst)
    expect(fetchCall).toBeDefined()
    const createAuth = vi.fn(async () => f.token)
    const fetchSpy = vi.fn(f.request)
    const module = ts.transpileModule(`async function request() { return ${fetchCall!.getText(clientAst)}; } request();`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    })
    const response = await vm.runInNewContext(module.outputText, {
        fetch: fetchSpy,
        require: (name: string) => {
            expect(name).toBe('src/ts/globalApi.svelte')
            return { forageStorage: { createAuth } }
        },
    })
    expect(createAuth).toHaveBeenCalledOnce()
    expect(fetchSpy).toHaveBeenCalledWith('/api/inlays/compress', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'risu-auth': f.token },
        body: JSON.stringify({ quality: 85 }),
    })
    await expectCompression(response, f)
})
