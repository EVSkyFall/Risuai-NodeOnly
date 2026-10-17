import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { once } from 'node:events'
import http from 'node:http'
import { connect, type Socket } from 'node:net'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import vm from 'node:vm'
import ts from 'typescript'
import express from 'express'
import compression from 'compression'
import Database from 'better-sqlite3'
import storeModule from './assetFileStore.cjs'
import transport from './assetFileTransport.cjs'

const source = fs.readFileSync(new URL('./server.cjs', import.meta.url), 'utf8')
const ast = ts.createSourceFile('server.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const functions = ['checkAuth', 'normalizeFilePathHeader', 'isHex', 'queueStorageOperation', 'writeStorageValue', 'shouldCompress']
const variables = ['storageOperationQueue', 'storageOperationContext', 'hexRegex', 'LOGS_POST_MAX_ENTRIES']
const extracted = ast.statements.filter(node => {
    if (ts.isFunctionDeclaration(node)) return functions.includes(node.name?.text ?? '')
    if (ts.isVariableStatement(node)) return node.declarationList.declarations.some(d => variables.includes(d.name.getText(ast)))
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return false
    const call = node.expression
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.expression.getText(ast) !== 'app') return false
    const route = call.arguments[0]
    if (route && ts.isStringLiteral(route)) return ['/api/read', '/api/write', '/api/logs'].includes(route.text)
        && (call.expression.name.text === 'post' || route.text === '/api/read')
    // Include the production compression and body parsers, not just the handlers.
    return call.expression.name.text === 'use' && /compression\(|express\.(json|raw|text)\(/.test(node.getText(ast))
}).map(node => node.getText(ast)).join('\n')

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
    for (const action of cleanup.splice(0).reverse()) await action()
    vi.restoreAllMocks()
})
const hex = (key: string) => Buffer.from(key).toString('hex')
const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>(r => { resolve = r })
    return { promise, resolve }
}

async function fixture(checkpoint = async (_stage: string) => {}) {
    const dir = await mkdtemp(path.join(tmpdir(), 'asset-read-hang-'))
    const db = new Database(path.join(dir, 'test.db'))
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL)')
    const store = storeModule.createAssetFileStore(db, { saveDir: dir, checkpoint })
    const app = express()
    const jwtSecret = crypto.randomBytes(32)
    const logs: unknown[] = []
    const opened: any[] = []
    const open = store.open
    vi.spyOn(store, 'open').mockImplementation(async (key: string) => {
        const entry = await open(key)
        if (entry) opened.push(entry)
        return entry
    })
    vm.runInNewContext(extracted, {
        app, compression, express, Buffer, AsyncLocalStorage, nodeCrypto: crypto, jwtSecret,
        assetFileStore: store, sendAsset: transport.sendAsset,
        logger: { error: vi.fn() }, console,
        addLogBatch: (entries: unknown[]) => { logs.push(...entries); return entries.length },
    })
    app.use((error: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (res.headersSent) return next(error)
        res.status(500).json({ error: error.message })
    })
    const server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address() as { port: number }
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
    cleanup.push(async () => {
        agent.destroy()
        await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
        for (const entry of opened) {
            if (!entry.stream.closed) {
                const closed = once(entry.stream, 'close').catch(() => {})
                entry.stream.destroy()
                await closed
            }
        }
        await store.close()
        db.close()
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    })
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')
    const token = `${header}.${payload}.${crypto.createHmac('sha256', jwtSecret).update(`${header}.${payload}`).digest('base64url')}`
    const sockets: Socket[] = []
    function request(url: string, { method = 'GET', body, headers = {}, connection = agent }: {
        method?: string, body?: Buffer, headers?: Record<string, string>, connection?: http.Agent | false,
    } = {}) {
        return new Promise<{ status: number, headers: http.IncomingHttpHeaders, bytes: Buffer }>((resolve, reject) => {
            const req = http.request({ hostname: '127.0.0.1', port: address.port, path: url, method, agent: connection,
                headers: { 'risu-auth': token, ...(body ? { 'content-length': String(body.length) } : {}), ...headers },
            }, res => {
                const chunks: Buffer[] = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('error', reject)
                res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, bytes: Buffer.concat(chunks) }))
            })
            req.on('socket', socket => sockets.push(socket))
            req.on('error', reject)
            req.end(body)
        })
    }
    const write = (key: string, body: Buffer, connection: http.Agent | false = agent) => request('/api/write', {
        method: 'POST', body, connection, headers: { 'file-path': hex(key), 'content-type': 'application/octet-stream' },
    })
    const read = (key: string, encoding = 'br') => request('/api/read', { headers: { 'file-path': hex(key), 'accept-encoding': encoding } })
    return { request, write, read, sockets, logs, opened, store, db, port: address.port, token }
}

function decoded(response: { headers: http.IncomingHttpHeaders, bytes: Buffer }) {
    if (response.headers['content-encoding'] === 'br') return brotliDecompressSync(response.bytes)
    if (response.headers['content-encoding'] === 'gzip') return gunzipSync(response.bytes)
    return response.bytes
}

describe('asset reads through the production HTTP routes and compression', () => {
    it.each(['br', 'gzip', 'identity'])('write, logs, delayed read reuse ONE keep-alive connection (%s)', async encoding => {
        const f = await fixture()
        const bytes = crypto.randomBytes(1_459_906)
        const key = `assets/${crypto.createHash('sha256').update(bytes).digest('hex')}.png`
        expect((await f.write(key, bytes)).status).toBe(200)
        const log = Buffer.from(JSON.stringify({ message: 'x'.repeat(443) }))
        expect(log.length).toBe(457)
        expect((await f.request('/api/logs', { method: 'POST', body: log, headers: { 'content-type': 'application/json' } })).status).toBe(200)
        await new Promise(resolve => setTimeout(resolve, 800))
        const read = await f.read(key, encoding)
        expect(read.status).toBe(200)
        expect(read.headers['content-encoding']).toBe(encoding === 'identity' ? undefined : encoding)
        expect(decoded(read)).toEqual(bytes)
        expect(f.logs).toHaveLength(1)
        expect(f.sockets).toHaveLength(3)
        expect(new Set(f.sockets).size).toBe(1)
        await expect.poll(() => f.opened.every(entry => entry.stream.closed)).toBe(true)
    })

    it('reads immediately after write, including an empty generation', async () => {
        const f = await fixture()
        for (const bytes of [crypto.randomBytes(1_459_906), Buffer.alloc(0)]) {
            expect((await f.write('assets/immediate.png', bytes)).status).toBe(200)
            const read = await f.read('assets/immediate.png')
            expect(read.status).toBe(200)
            expect(decoded(read)).toEqual(bytes)
        }
        expect(new Set(f.sockets).size).toBe(1)
    })

    it('reads the published generation while its replacement is still being written', async () => {
        const reached = deferred(), release = deferred()
        let hold = false
        const f = await fixture(async stage => {
            if (hold && stage === 'temp-write') { reached.resolve(); await release.promise }
        })
        const old = crypto.randomBytes(1_459_906), replacement = crypto.randomBytes(1_459_906)
        const key = 'assets/concurrent.png'
        expect((await f.write(key, old)).status).toBe(200)
        hold = true
        // An Agent with maxSockets:1 serializes requests; true overlap needs another connection.
        const writing = f.write(key, replacement, false)
        try {
            await reached.promise
            expect(decoded(await f.read(key))).toEqual(old)
        } finally { release.resolve() }
        expect((await writing).status).toBe(200)
        expect(decoded(await f.read(key))).toEqual(replacement)
        expect(f.sockets[0]).toBe(f.sockets[2])
        expect(f.sockets[0]).toBe(f.sockets[3])
    })

    it('returns an error response if the generation cannot be read', async () => {
        const f = await fixture()
        const key = 'assets/unreadable.png'
        expect((await f.write(key, Buffer.from('bytes'))).status).toBe(200)
        const row = f.db.prepare('SELECT generationId FROM asset_file_generations WHERE key = ? AND retired = 0').get(key) as any
        const file = path.join(f.store.root, row.generationId.slice(0, 2), row.generationId + '.blob')
        await rm(file)
        await mkdir(file)
        expect((await f.read(key)).status).toBe(500)
    })

    it('answers pipelined write and read requests on ONE socket while publication is pending', async () => {
        const reached = deferred(), release = deferred()
        let hold = false
        const f = await fixture(async stage => {
            if (hold && stage === 'temp-write') { reached.resolve(); await release.promise }
        })
        const old = crypto.randomBytes(1_459_906), replacement = crypto.randomBytes(1_459_906)
        const key = 'assets/pipelined.png'
        expect((await f.write(key, old)).status).toBe(200)
        hold = true
        const socket = connect(f.port, '127.0.0.1')
        cleanup.push(async () => { socket.destroy() })
        await once(socket, 'connect')
        const response = new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = []
            socket.on('data', chunk => chunks.push(chunk))
            socket.on('error', reject)
            socket.on('end', () => resolve(Buffer.concat(chunks)))
        })
        const common = `Host: localhost\r\nrisu-auth: ${f.token}\r\nfile-path: ${hex(key)}\r\n`
        socket.write(Buffer.concat([
            Buffer.from(`POST /api/write HTTP/1.1\r\n${common}Content-Type: application/octet-stream\r\nContent-Length: ${replacement.length}\r\n\r\n`),
            replacement,
            Buffer.from(`GET /api/read HTTP/1.1\r\n${common}Accept-Encoding: identity\r\nConnection: close\r\n\r\n`),
        ]))
        try {
            await reached.promise
            await expect.poll(() => f.opened.length).toBe(1)
        } finally { release.resolve() }
        let wire = await response
        const bodies: Buffer[] = []
        for (let i = 0; i < 2; i++) {
            const boundary = wire.indexOf('\r\n\r\n')
            expect(boundary).toBeGreaterThan(0)
            const headers = wire.subarray(0, boundary).toString()
            expect(headers).toMatch(/^HTTP\/1\.1 200 /)
            const length = Number(/content-length: (\d+)/i.exec(headers)![1])
            bodies.push(wire.subarray(boundary + 4, boundary + 4 + length))
            wire = wire.subarray(boundary + 4 + length)
        }
        expect(wire.length).toBe(0)
        expect(JSON.parse(bodies[0].toString())).toEqual({ success: true })
        expect(bodies[1]).toEqual(old)
        expect(decoded(await f.read(key))).toEqual(replacement)
    })
})
