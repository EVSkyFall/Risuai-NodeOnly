// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { spawnServer, type ServerHandle, type SpawnServerOptions } from '../../test/compat/helpers/spawnServer.js'
import { createClient, type RisuClient } from '../../test/compat/helpers/client.js'

interface TestContext {
    server: ServerHandle
    client: RisuClient
}

interface MockUpstream {
    origin: string
    close: () => Promise<void>
}

interface ActiveLease {
    leaseId: string
    startedAt: number
    host: string
    requestClass: 'interactive' | 'background'
    pid: number
}

interface BrokerStatus {
    active: boolean
    cooldownUntil: number | null
    queueDepth: { interactive: number; background: number }
}

const ACTIVE_LEASE_KEY = 'nai_broker/active_lease'

const servers: ServerHandle[] = []
const upstreams: MockUpstream[] = []

function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>((done) => { resolve = done })
    return { promise, resolve }
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function within<T>(promise: Promise<T>, ms = 3_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

async function waitFor(predicate: () => boolean, ms = 3_000): Promise<void> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
        if (predicate()) return
        await delay(25)
    }
    throw new Error(`Condition did not become true within ${ms}ms`)
}

function seedActiveLease(saveDir: string, lease: ActiveLease) {
    const db = new Database(path.join(saveDir, 'risuai.db'))
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS kv (
                key TEXT PRIMARY KEY,
                value BLOB NOT NULL,
                updated_at INTEGER NOT NULL
            )
        `)
        db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)')
            .run(ACTIVE_LEASE_KEY, Buffer.from(JSON.stringify(lease)), Date.now())
    } finally {
        db.close()
    }
}

function readActiveLease(cwd: string): ActiveLease | null {
    const db = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true, fileMustExist: true })
    try {
        db.pragma('busy_timeout = 5000')
        const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(ACTIVE_LEASE_KEY) as { value: Buffer } | undefined
        return row ? JSON.parse(Buffer.from(row.value).toString('utf-8')) as ActiveLease : null
    } finally {
        db.close()
    }
}

async function startUpstream(
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<MockUpstream> {
    const server = createServer((req, res) => {
        Promise.resolve(handler(req, res)).catch(() => {
            if (!res.headersSent) res.statusCode = 500
            res.end()
        })
    })
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address() as AddressInfo
    const mock = {
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve())
            server.closeAllConnections()
        }),
    }
    upstreams.push(mock)
    return mock
}

async function boot(
    extraEnv: Record<string, string> = {},
    options: Omit<SpawnServerOptions, 'env'> = {},
): Promise<TestContext> {
    const server = await spawnServer({
        ...options,
        env: {
            RISU_TUNNEL_DISABLED: 'true',
            RISU_UPDATE_CHECK: 'false',
            RISU_NAI_BROKER_ALLOW_INSECURE_TEST_TARGET: 'true',
            ...extraEnv,
        },
    })
    servers.push(server)
    return { server, client: await createClient(server.port, server.password) }
}

async function readBrokerStatus(context: TestContext): Promise<BrokerStatus> {
    const response = await context.client.fetch('/api/nai-broker/status')
    expect(response.status).toBe(200)
    return await response.json() as BrokerStatus
}

function validBody(id: string, parameters: Record<string, unknown> = {}) {
    return {
        input: `prompt-${id}`,
        model: 'nai-diffusion-4-full',
        action: 'generate',
        parameters,
    }
}

function proxyRequest(
    context: TestContext,
    target: string,
    options: {
        id?: string
        requestClass?: 'interactive' | 'background' | string | null
        route?: '/proxy' | '/proxy2'
        method?: string
        authorization?: string | null
        body?: unknown
        contentType?: string
        signal?: AbortSignal
        forwardedHeaders?: Record<string, string>
    } = {},
) {
    const id = options.id ?? 'request'
    const forwardedHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-test-id': id,
        ...options.forwardedHeaders,
    }
    if (options.authorization !== null) {
        forwardedHeaders.Authorization = options.authorization ?? 'Bearer test-nai-key'
    }
    const headers: Record<string, string> = {
        'content-type': options.contentType ?? 'application/json',
        'risu-url': encodeURIComponent(target),
        'risu-header': encodeURIComponent(JSON.stringify(forwardedHeaders)),
    }
    if (options.requestClass !== null && options.requestClass !== undefined) {
        headers['risu-image-class'] = options.requestClass
    }
    const method = options.method ?? 'POST'
    return context.client.fetch(options.route ?? '/proxy2', {
        method,
        headers,
        body: method === 'GET' ? undefined : JSON.stringify(options.body ?? validBody(id)),
        signal: options.signal,
    })
}

afterEach(async () => {
    for (const server of servers.splice(0).reverse()) await server.cleanup()
    await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()))
})

describe('server-authoritative NAI image broker', { timeout: 30_000 }, () => {
    it('keeps maxActive at one across 15 background and interleaved interactive calls', async () => {
        let active = 0
        let maxActive = 0
        let requestCount = 0
        const upstream = await startUpstream(async (_req, res) => {
            requestCount += 1
            active += 1
            maxActive = Math.max(maxActive, active)
            res.once('close', () => { active -= 1 })
            await delay(10)
            res.writeHead(200, { 'content-type': 'image/png' })
            res.end(Buffer.from('image'))
        })
        const context = await boot()

        const calls: Promise<Response>[] = []
        for (let index = 0; index < 15; index++) {
            calls.push(proxyRequest(context, `${upstream.origin}/ai/generate-image`, {
                id: `background-${index}`,
                requestClass: 'background',
                route: index % 2 === 0 ? '/proxy' : '/proxy2',
            }))
            if (index % 3 === 0) {
                calls.push(proxyRequest(context, `${upstream.origin}/ai/generate-image`, {
                    id: `interactive-${index}`,
                    requestClass: index === 0 ? null : 'interactive',
                    route: index % 2 === 0 ? '/proxy2' : '/proxy',
                }))
            }
        }

        const responses = await within(Promise.all(calls), 10_000)
        await Promise.all(responses.map((response) => response.arrayBuffer()))
        expect(responses.every((response) => response.status === 200)).toBe(true)
        expect(requestCount).toBe(20)
        expect(maxActive).toBe(1)
    })

    it('starts every queued interactive call before any queued background call', async () => {
        const blockerStarted = deferred()
        const releaseBlocker = deferred()
        const startOrder: string[] = []
        const upstream = await startUpstream(async (req, res) => {
            const id = String(req.headers['x-test-id'])
            startOrder.push(id)
            if (id === 'blocker') {
                blockerStarted.resolve()
                await releaseBlocker.promise
            }
            res.writeHead(200, { 'content-type': 'image/png' })
            res.end(Buffer.from(id))
        })
        const context = await boot()

        const blocker = proxyRequest(context, `${upstream.origin}/ai/generate-image`, {
            id: 'blocker',
            requestClass: 'background',
        })
        await blockerStarted.promise
        const backgrounds = ['b1', 'b2', 'b3'].map((id) => proxyRequest(
            context,
            `${upstream.origin}/ai/generate-image`,
            { id, requestClass: 'background' },
        ))
        await delay(50)
        const interactives = ['i1', 'i2', 'i3'].map((id) => proxyRequest(
            context,
            `${upstream.origin}/ai/generate-image`,
            { id, requestClass: 'interactive' },
        ))
        await delay(100)
        releaseBlocker.resolve()

        const responses = await within(Promise.all([blocker, ...backgrounds, ...interactives]))
        await Promise.all(responses.map((response) => response.arrayBuffer()))
        const queuedOrder = startOrder.slice(1)
        const lastInteractive = Math.max(...queuedOrder.map((id, index) => id.startsWith('i') ? index : -1))
        const firstBackground = queuedOrder.findIndex((id) => id.startsWith('b'))
        expect(startOrder[0]).toBe('blocker')
        expect(queuedOrder.filter((id) => id.startsWith('i'))).toHaveLength(3)
        expect(lastInteractive).toBeLessThan(firstBackground)
    })

    it('does not dispatch the next call until a disconnected client has aborted and settled upstream', async () => {
        const firstStarted = deferred()
        let firstSettled = false
        let secondStarted = false
        let secondSawFirstSettled = false
        const upstream = await startUpstream((req, res) => {
            const id = String(req.headers['x-test-id'])
            if (id === 'first') {
                res.writeHead(200, { 'content-type': 'image/png' })
                res.write(Buffer.from('first-chunk'))
                firstStarted.resolve()
                const timer = setInterval(() => res.write(Buffer.from('more')), 25)
                res.once('close', () => {
                    clearInterval(timer)
                    firstSettled = true
                })
                return
            }
            secondStarted = true
            secondSawFirstSettled = firstSettled
            res.writeHead(200, { 'content-type': 'image/png' })
            res.end(Buffer.from('second'))
        })
        const context = await boot()
        const abortController = new AbortController()
        const firstResponse = await proxyRequest(context, `${upstream.origin}/ai/generate-image`, {
            id: 'first',
            requestClass: 'background',
            signal: abortController.signal,
        })
        await firstStarted.promise
        const reader = firstResponse.body!.getReader()
        await reader.read()
        const second = proxyRequest(context, `${upstream.origin}/ai/generate-image`, {
            id: 'second',
            requestClass: 'interactive',
        })
        await delay(75)
        expect(secondStarted).toBe(false)

        abortController.abort()
        await reader.read().catch(() => undefined)
        const secondResponse = await within(second)
        await secondResponse.arrayBuffer()
        expect(secondResponse.status).toBe(200)
        expect(firstSettled).toBe(true)
        expect(secondSawFirstSettled).toBe(true)
    })

    it('drops a queued request that disconnects before dispatch', async () => {
        const blockerStarted = deferred()
        const releaseBlocker = deferred()
        const upstreamIds: string[] = []
        const upstream = await startUpstream(async (req, res) => {
            const id = String(req.headers['x-test-id'])
            upstreamIds.push(id)
            if (id === 'blocker') {
                blockerStarted.resolve()
                await releaseBlocker.promise
            }
            res.writeHead(200, { 'content-type': 'image/png' })
            res.end(Buffer.from(id))
        })
        const context = await boot()
        const blocker = proxyRequest(context, `${upstream.origin}/ai/generate-image`, {
            id: 'blocker',
            requestClass: 'background',
        })
        await blockerStarted.promise

        const abortController = new AbortController()
        const abandoned = proxyRequest(context, `${upstream.origin}/ai/generate-image`, {
            id: 'abandoned',
            requestClass: 'background',
            signal: abortController.signal,
        }).catch(() => null)
        await delay(75)
        abortController.abort()
        await abandoned
        const survivor = proxyRequest(context, `${upstream.origin}/ai/generate-image`, {
            id: 'survivor',
            requestClass: 'interactive',
        })
        releaseBlocker.resolve()

        const [blockerResponse, survivorResponse] = await within(Promise.all([blocker, survivor]))
        await Promise.all([blockerResponse.arrayBuffer(), survivorResponse.arrayBuffer()])
        expect(upstreamIds).toEqual(['blocker', 'survivor'])
    })

    it('releases the permit after an upstream 500 response body settles', async () => {
        let requestCount = 0
        const upstream = await startUpstream((req, res) => {
            requestCount += 1
            const first = req.headers['x-test-id'] === 'first'
            res.writeHead(first ? 500 : 200, { 'content-type': 'image/png' })
            res.end(Buffer.from(first ? 'provider failure' : 'second'))
        })
        const context = await boot()
        const first = proxyRequest(context, `${upstream.origin}/ai/generate-image`, { id: 'first' })
        const second = proxyRequest(context, `${upstream.origin}/ai/generate-image`, { id: 'second' })

        const [firstResponse, secondResponse] = await within(Promise.all([first, second]))
        await Promise.all([firstResponse.arrayBuffer(), secondResponse.arrayBuffer()])
        expect(firstResponse.status).toBe(500)
        expect(firstResponse.headers.get('risu-image-result')).toBe('provider-response')
        expect(secondResponse.status).toBe(200)
        expect(requestCount).toBe(2)
    })

    it('releases the permit after an upstream connection reset', async () => {
        let requestCount = 0
        const upstream = await startUpstream((req, res) => {
            requestCount += 1
            if (req.headers['x-test-id'] === 'first') {
                req.socket.destroy()
                return
            }
            res.writeHead(200, { 'content-type': 'image/png' })
            res.end(Buffer.from('second'))
        })
        const context = await boot()
        const first = proxyRequest(context, `${upstream.origin}/ai/generate-image`, { id: 'first' })
        const second = proxyRequest(context, `${upstream.origin}/ai/generate-image`, { id: 'second' })

        const [firstResponse, secondResponse] = await within(Promise.all([first, second]))
        await Promise.all([firstResponse.arrayBuffer(), secondResponse.arrayBuffer()])
        expect(firstResponse.status).toBe(502)
        expect(firstResponse.headers.get('risu-image-result')).toBe('transport-error')
        expect(secondResponse.status).toBe(200)
        expect(requestCount).toBe(2)
    })

    it('aborts a hung upstream at the server-owned max hold and releases the permit', async () => {
        let requestCount = 0
        let firstSettled = false
        const upstream = await startUpstream((req, res) => {
            requestCount += 1
            if (req.headers['x-test-id'] === 'first') {
                res.writeHead(200, { 'content-type': 'image/png' })
                res.write(Buffer.from('partial'))
                res.once('close', () => { firstSettled = true })
                return
            }
            res.writeHead(200, { 'content-type': 'image/png' })
            res.end(Buffer.from('second'))
        })
        const context = await boot({ RISU_NAI_IMAGE_MAX_HOLD_MS: '150' })
        const firstResponse = await proxyRequest(context, `${upstream.origin}/ai/generate-image`, { id: 'first' })
        const firstBody = firstResponse.arrayBuffer().catch(() => new ArrayBuffer(0))
        const secondResponse = await within(proxyRequest(
            context,
            `${upstream.origin}/ai/generate-image`,
            { id: 'second' },
        ))
        await Promise.all([firstBody, secondResponse.arrayBuffer()])

        expect(secondResponse.status).toBe(200)
        expect(firstSettled).toBe(true)
        expect(requestCount).toBe(2)
    })

    it('strips local metadata, preserves provider auth, and never logs request sentinels', async () => {
        const secret = 'SECRET_SENTINEL_NAI_KEY'
        const base64Sentinel = 'BASE64_SENTINEL_REFERENCE_IMAGE'
        let upstreamHeaders: IncomingMessage['headers'] = {}
        const upstream = await startUpstream(async (req, res) => {
            upstreamHeaders = req.headers
            const chunks: Buffer[] = []
            for await (const chunk of req) chunks.push(Buffer.from(chunk))
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(Buffer.concat(chunks))
        })
        const context = await boot()
        const response = await proxyRequest(context, `${upstream.origin}/ai/generate-image`, {
            id: 'secret',
            requestClass: 'interactive',
            authorization: `Bearer ${secret}`,
            body: validBody('secret', { image: base64Sentinel }),
            forwardedHeaders: { 'risu-image-class': 'background', 'risu-auth': 'must-not-forward' },
        })
        await response.arrayBuffer()
        await delay(50)

        expect(response.status).toBe(500)
        expect(upstreamHeaders.authorization).toBe(`Bearer ${secret}`)
        expect(upstreamHeaders['risu-image-class']).toBeUndefined()
        expect(upstreamHeaders['risu-auth']).toBeUndefined()
        const output = context.server.getOutput()
        expect(output.stdout).not.toContain(secret)
        expect(output.stderr).not.toContain(secret)
        expect(output.stdout).not.toContain(base64Sentinel)
        expect(output.stderr).not.toContain(base64Sentinel)
    })

    it('lets non-NAI proxy traffic pass while the NAI permit is busy', async () => {
        const naiStarted = deferred()
        const releaseNai = deferred()
        const upstream = await startUpstream(async (req, res) => {
            if (req.url === '/ai/generate-image') {
                naiStarted.resolve()
                await releaseNai.promise
                res.writeHead(200, { 'content-type': 'image/png' })
                res.end(Buffer.from('nai'))
                return
            }
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
        })
        const context = await boot()
        const nai = proxyRequest(context, `${upstream.origin}/ai/generate-image`, {
            id: 'nai',
            requestClass: 'background',
        })
        await naiStarted.promise

        try {
            const passthrough = await within(proxyRequest(context, `${upstream.origin}/ordinary`, {
                id: 'ordinary',
                requestClass: null,
            }), 1_000)
            expect(passthrough.status).toBe(200)
            expect(await passthrough.json()).toEqual({ ok: true })
        } finally {
            releaseNai.resolve()
        }
        const naiResponse = await nai
        await naiResponse.arrayBuffer()
    })

    it('makes zero upstream calls when the durable lease write fails and releases the permit', async () => {
        let upstreamCalls = 0
        const upstream = await startUpstream((_req, res) => {
            upstreamCalls += 1
            res.writeHead(200, { 'content-type': 'image/png' })
            res.end(Buffer.from('image'))
        })
        const context = await boot()
        const db = new Database(path.join(context.server.cwd, 'save', 'risuai.db'))
        db.pragma('busy_timeout = 5000')
        try {
            db.exec(`
                CREATE TRIGGER fail_nai_active_lease
                BEFORE INSERT ON kv
                WHEN NEW.key = '${ACTIVE_LEASE_KEY}'
                BEGIN
                    SELECT RAISE(FAIL, 'test lease write failure');
                END
            `)

            const failed = await proxyRequest(context, `${upstream.origin}/ai/generate-image`, { id: 'blocked' })
            await failed.arrayBuffer()
            expect(failed.status).toBe(503)
            expect(failed.headers.get('risu-image-result')).toBe('lease-write-failed')
            expect(upstreamCalls).toBe(0)
            expect(readActiveLease(context.server.cwd)).toBeNull()

            db.exec('DROP TRIGGER fail_nai_active_lease')
            const recovered = await proxyRequest(context, `${upstream.origin}/ai/generate-image`, { id: 'recovered' })
            await recovered.arrayBuffer()
            expect(recovered.status).toBe(200)
            expect(upstreamCalls).toBe(1)
        } finally {
            db.exec('DROP TRIGGER IF EXISTS fail_nai_active_lease')
            db.close()
        }
    })

    it('persists the active lease before dispatch and clears it after the body settles', async () => {
        const upstreamStarted = deferred()
        const releaseBody = deferred()
        const upstream = await startUpstream(async (_req, res) => {
            res.writeHead(200, { 'content-type': 'image/png' })
            res.write(Buffer.from('partial'))
            upstreamStarted.resolve()
            await releaseBody.promise
            res.end(Buffer.from('complete'))
        })
        const context = await boot()
        const responsePromise = proxyRequest(context, `${upstream.origin}/ai/generate-image`, {
            id: 'lease-lifecycle',
            requestClass: 'background',
        })

        await upstreamStarted.promise
        const lease = readActiveLease(context.server.cwd)
        expect(lease).not.toBeNull()
        expect(lease?.leaseId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
        expect(lease?.startedAt).toBeGreaterThan(0)
        expect(lease?.host).toBe('127.0.0.1')
        expect(lease?.requestClass).toBe('background')
        expect(lease?.pid).toBe(context.server.pid)

        releaseBody.resolve()
        const response = await responsePromise
        await response.arrayBuffer()
        expect(response.status).toBe(200)
        await waitFor(() => readActiveLease(context.server.cwd) === null)
    })

    it('holds queued requests during a fresh boot cooldown and exposes the hold state', async () => {
        let upstreamCalls = 0
        const upstream = await startUpstream((_req, res) => {
            upstreamCalls += 1
            res.writeHead(200, { 'content-type': 'image/png' })
            res.end(Buffer.from('image'))
        })
        const seededLease: ActiveLease = {
            leaseId: 'seeded-fresh-lease',
            startedAt: Date.now() - 100,
            host: 'image.novelai.net',
            requestClass: 'background',
            pid: 12345,
        }
        const context = await boot(
            {
                // Window must comfortably exceed worst-case server boot (spawnServer
                // waits up to 10s) because startedAt is anchored BEFORE boot.
                RISU_NAI_IMAGE_MAX_HOLD_MS: '8000',
                RISU_NAI_BROKER_COOLDOWN_MARGIN_MS: '4000',
            },
            { seedSave: async (saveDir) => seedActiveLease(saveDir, seededLease) },
        )

        const initialStatus = await readBrokerStatus(context)
        expect(initialStatus.active).toBe(false)
        expect(initialStatus.cooldownUntil).toBe(seededLease.startedAt + 12_000)
        expect(initialStatus.cooldownUntil).toBeGreaterThan(Date.now())

        const request = proxyRequest(context, `${upstream.origin}/ai/generate-image`, {
            id: 'after-cooldown',
            requestClass: 'interactive',
        })
        await delay(150)
        expect(upstreamCalls).toBe(0)
        const queuedStatus = await readBrokerStatus(context)
        expect(queuedStatus.cooldownUntil).toBe(initialStatus.cooldownUntil)
        expect(queuedStatus.queueDepth).toEqual({ interactive: 1, background: 0 })

        const response = await within(request, 20_000)
        await response.arrayBuffer()
        expect(response.status).toBe(200)
        expect(upstreamCalls).toBe(1)
        await waitFor(() => readActiveLease(context.server.cwd) === null)
        const finalStatus = await readBrokerStatus(context)
        expect(finalStatus.cooldownUntil).toBeNull()
        expect(finalStatus.queueDepth).toEqual({ interactive: 0, background: 0 })
        const output = context.server.getOutput()
        expect(output.stdout + output.stderr).toContain('previous upstream outcome UNKNOWN')
    })

    it('clears an expired boot lease and proceeds without a cooldown', async () => {
        let upstreamCalls = 0
        const upstream = await startUpstream((_req, res) => {
            upstreamCalls += 1
            res.writeHead(200, { 'content-type': 'image/png' })
            res.end(Buffer.from('image'))
        })
        const seededLease: ActiveLease = {
            leaseId: 'seeded-expired-lease',
            startedAt: Date.now() - 60_000,
            host: 'image.novelai.net',
            requestClass: 'interactive',
            pid: 12345,
        }
        const context = await boot(
            {
                RISU_NAI_IMAGE_MAX_HOLD_MS: '500',
                RISU_NAI_BROKER_COOLDOWN_MARGIN_MS: '100',
            },
            { seedSave: async (saveDir) => seedActiveLease(saveDir, seededLease) },
        )

        expect(readActiveLease(context.server.cwd)).toBeNull()
        const status = await readBrokerStatus(context)
        expect(status.cooldownUntil).toBeNull()
        const response = await within(proxyRequest(
            context,
            `${upstream.origin}/ai/generate-image`,
            { id: 'expired-fast-path' },
        ), 2_000)
        await response.arrayBuffer()
        expect(response.status).toBe(200)
        expect(upstreamCalls).toBe(1)
        await waitFor(() => readActiveLease(context.server.cwd) === null)
    })

    it('enters cooldown after SIGKILL leaves an acknowledged active lease', async () => {
        const upstreamStarted = deferred()
        const upstream = await startUpstream((_req, res) => {
            res.writeHead(200, { 'content-type': 'image/png' })
            res.write(Buffer.from('partial'))
            upstreamStarted.resolve()
            const timer = setInterval(() => res.write(Buffer.from('more')), 50)
            res.once('close', () => clearInterval(timer))
        })
        const cooldownEnv = {
            RISU_NAI_IMAGE_MAX_HOLD_MS: '5000',
            RISU_NAI_BROKER_COOLDOWN_MARGIN_MS: '2000',
        }
        const first = await boot(cooldownEnv)
        const firstResponse = await proxyRequest(first, `${upstream.origin}/ai/generate-image`, {
            id: 'crash-orphan',
            requestClass: 'background',
        })
        const firstBody = firstResponse.arrayBuffer().catch(() => new ArrayBuffer(0))
        await upstreamStarted.promise

        const acknowledgedLease = readActiveLease(first.server.cwd)
        expect(acknowledgedLease).not.toBeNull()
        expect(acknowledgedLease?.pid).toBe(first.server.pid)
        await first.server.stop('SIGKILL')
        await within(firstBody)

        const restarted = await boot(cooldownEnv, { cwd: first.server.cwd })
        const status = await readBrokerStatus(restarted)
        expect(status.active).toBe(false)
        expect(status.cooldownUntil).toBe(acknowledgedLease!.startedAt + 7000)
        expect(status.cooldownUntil).toBeGreaterThan(Date.now())
        expect(readActiveLease(restarted.server.cwd)?.leaseId).toBe(acknowledgedLease?.leaseId)
        const output = restarted.server.getOutput()
        expect(output.stdout + output.stderr).toContain('previous upstream outcome UNKNOWN')
    })

    it('rejects invalid marked request shapes before any queue slot or upstream call', async () => {
        let upstreamCalls = 0
        const upstream = await startUpstream((_req, res) => {
            upstreamCalls += 1
            res.end('unexpected')
        })
        const context = await boot({ RISU_NAI_BROKER_ALLOW_INSECURE_TEST_TARGET: 'false' })
        const officialTarget = 'https://image.novelai.net/ai/generate-image'
        const unauthenticated = fetch(`http://127.0.0.1:${context.server.port}/proxy2`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'risu-url': encodeURIComponent(officialTarget),
                'risu-header': encodeURIComponent(JSON.stringify({ Authorization: 'Bearer test-nai-key' })),
                'risu-image-class': 'interactive',
            },
            body: JSON.stringify(validBody('unauthenticated')),
        })
        const cases = [
            proxyRequest(context, `${upstream.origin}/ai/generate-image`, { requestClass: 'urgent' }),
            proxyRequest(context, `${upstream.origin}/ai/generate-image`, { requestClass: 'interactive' }),
            proxyRequest(context, 'https://example.com/not-an-image-endpoint', { requestClass: 'interactive' }),
            proxyRequest(context, officialTarget, { requestClass: 'interactive', method: 'GET' }),
            proxyRequest(context, officialTarget, { requestClass: 'interactive', contentType: 'text/plain' }),
            proxyRequest(context, officialTarget, { requestClass: 'interactive', body: { action: 'generate' } }),
            proxyRequest(context, officialTarget, { requestClass: 'interactive', authorization: null }),
        ]

        const [unauthenticatedResponse, responses] = await Promise.all([unauthenticated, Promise.all(cases)])
        await Promise.all(responses.map((response) => response.arrayBuffer()))
        await unauthenticatedResponse.arrayBuffer()
        expect(unauthenticatedResponse.status).toBe(400)
        expect(unauthenticatedResponse.headers.get('risu-image-result')).toBeNull()
        expect(responses.every((response) => response.status === 400)).toBe(true)
        expect(responses.every((response) => response.headers.get('risu-image-result') === 'validation-reject')).toBe(true)
        expect(upstreamCalls).toBe(0)
    })
})
