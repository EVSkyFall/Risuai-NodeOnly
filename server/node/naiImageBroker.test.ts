// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { spawnServer, type ServerHandle } from '../../test/compat/helpers/spawnServer.js'
import { createClient, type RisuClient } from '../../test/compat/helpers/client.js'

interface TestContext {
    server: ServerHandle
    client: RisuClient
}

interface MockUpstream {
    origin: string
    close: () => Promise<void>
}

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

async function boot(extraEnv: Record<string, string> = {}): Promise<TestContext> {
    const server = await spawnServer({
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
    await Promise.all(servers.splice(0).map((server) => server.cleanup()))
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
