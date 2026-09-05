import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import modelJobs from '../../../../server/node/model-jobs.cjs'
import { makeJobFetch, ModelJobBusyError, ModelJobConnectionLostError, type JobFetchOptions } from './jobFetch'

vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: { createAuth: async () => 'test-auth' },
}))

// --- harness ----------------------------------------------------------------
//
// makeJobFetch talks to exactly four server endpoints plus a fallback fetch.
// The harness stubs global fetch with a tiny in-memory server so each test
// declares only the behavior it cares about (creation outcome, stream bytes,
// final job status).

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder()
    return new ReadableStream({
        start(c) {
            for (const chunk of chunks) c.enqueue(enc.encode(chunk))
            c.close()
        },
    })
}

interface ServerBehavior {
    create?: { status: number, body?: unknown }
    createReject?: Error
    streamChunks?: string[]
    /** Per-attach chunk sets: successive GET /stream calls consume successive
     *  entries (the last repeats) — for reconnect tests. Overrides streamChunks. */
    streamChunksQueue?: string[][]
    /** Defaults to a healthy stream (content-type + upstream-status 200). */
    streamHeaders?: Record<string, string>
    /** Body of the never-closing kind for abort tests. */
    streamNeverEnds?: boolean
    /** GET /api/model-jobs/:id after the stream ends. */
    job?: { status: string, error?: string }
    /** Successive GET /api/model-jobs/:id responses (last repeats). Overrides job. */
    jobQueue?: { status: string, error?: string }[]
    jobReject?: Error
    claimFetch?: typeof fetch
}

function setupServer(behavior: ServerBehavior) {
    const calls: { url: string, init?: RequestInit }[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        calls.push({ url, init })
        const method = init?.method ?? 'GET'
        if (url === '/api/model-jobs' && method === 'POST') {
            if (behavior.createReject) throw behavior.createReject
            const c = behavior.create ?? { status: 200, body: { jobId: 'job-1' } }
            return new Response(JSON.stringify(c.body ?? {}), { status: c.status })
        }
        if (url === '/api/model-jobs/job-1/stream') {
            const headers = behavior.streamHeaders ?? {
                'content-type': 'text/event-stream',
                'x-model-job-upstream-status': '200',
            }
            let chunks = behavior.streamChunks ?? []
            if (behavior.streamChunksQueue) {
                chunks = behavior.streamChunksQueue.length > 1
                    ? behavior.streamChunksQueue.shift()!
                    : behavior.streamChunksQueue[0] ?? []
            }
            const body = behavior.streamNeverEnds
                ? new ReadableStream<Uint8Array>({ start() { /* never closes */ } })
                : streamOf(...chunks)
            return new Response(body, { status: 200, headers })
        }
        if (url === '/api/model-jobs/job-1' && method === 'DELETE') {
            return new Response('{"success":true}', { status: 200 })
        }
        if (url === '/api/model-jobs/job-1' && method === 'GET') {
            if (behavior.jobReject) throw behavior.jobReject
            let job = behavior.job ?? { status: 'done' }
            if (behavior.jobQueue && behavior.jobQueue.length > 0) {
                job = behavior.jobQueue.length > 1 ? behavior.jobQueue.shift()! : behavior.jobQueue[0]
            }
            return new Response(JSON.stringify(job), { status: 200 })
        }
        if (url === '/api/model-jobs/job-1/claim') {
            if (behavior.claimFetch) return behavior.claimFetch(input, init)
            if (method !== 'POST') throw new Error(`unexpected claim method: ${method}`)
            return new Response('{"success":true}', { status: 200 })
        }
        throw new Error(`unexpected fetch: ${method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    return { calls }
}

function makeOpts(overrides: Partial<JobFetchOptions> = {}): JobFetchOptions {
    return {
        realChatId: 'chat-1',
        generationId: 'gen-1',
        adapterKind: 'openai-compatible',
        streaming: true,
        timeoutMs: 60_000,
        fallbackFetch: vi.fn(async () => new Response('fallback')) as unknown as typeof fetch,
        ...overrides,
    }
}

function callsFor(calls: { url: string, init?: RequestInit }[], url: string, method = 'GET') {
    return calls.filter((c) => c.url === url && (c.init?.method ?? 'GET') === method)
}

// Drain the response the way the streaming adapters do (body reader), so
// stream errors surface with their original class. (happy-dom's text()/json()
// wrap stream errors in a DOMException, unlike real browsers.)
async function drain(res: Response): Promise<string> {
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let out = ''
    while (true) {
        const { done, value } = await reader.read()
        if (done) return out
        out += dec.decode(value, { stream: true })
    }
}

afterEach(() => {
    vi.unstubAllGlobals()
})

// --- tests ------------------------------------------------------------------

describe('makeJobFetch', () => {
    test('streams journal bytes through and claims after a clean done', async () => {
        const { calls } = setupServer({ streamChunks: ['hel', 'lo ', 'world'], job: { status: 'done' } })
        const res = await makeJobFetch(makeOpts())('https://provider.example/v1/chat', {
            method: 'POST',
            headers: { authorization: 'Bearer sk-x' },
            body: '{"model":"m"}',
        })
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toBe('text/event-stream')
        expect(await res.text()).toBe('hello world')

        // Job creation carried the request + job metadata and the app auth header.
        const [create] = callsFor(calls, '/api/model-jobs', 'POST')
        expect((create.init?.headers as Record<string, string>)['risu-auth']).toBe('test-auth')
        expect(JSON.parse(create.init?.body as string)).toMatchObject({
            targetUrl: 'https://provider.example/v1/chat',
            method: 'POST',
            headers: { authorization: 'Bearer sk-x' },
            body: '{"model":"m"}',
            chatId: 'chat-1',
            generationId: 'gen-1',
            adapterKind: 'openai-compatible',
            streaming: true,
            timeoutMs: 60_000,
        })
        // Claim is fire-and-forget after the verified-done close.
        await vi.waitFor(() => {
            expect(callsFor(calls, '/api/model-jobs/job-1/claim', 'POST')).toHaveLength(1)
        })
    })

    test('mirrors the upstream status onto the returned Response', async () => {
        setupServer({
            streamChunks: ['{"error":"rate limited"}'],
            streamHeaders: { 'content-type': 'application/json', 'x-model-job-upstream-status': '429' },
            job: { status: 'done' },
        })
        const res = await makeJobFetch(makeOpts())('https://provider.example/v1/chat', { method: 'POST', body: '{}' })
        expect(res.status).toBe(429)
        expect(res.headers.get('content-type')).toBe('application/json')
        expect(await res.json()).toEqual({ error: 'rate limited' })
    })

    test('missing upstream-status header throws TypeError like a network failure', async () => {
        setupServer({ streamHeaders: { 'content-type': 'text/plain' } })
        await expect(makeJobFetch(makeOpts())('https://provider.example/v1/chat', { method: 'POST', body: '{}' }))
            .rejects.toThrow(TypeError)
    })

    test('reattaches after a dropped tail and resumes without duplicating bytes', async () => {
        const { calls } = setupServer({
            // First attach delivers a prefix then the connection "drops"; the
            // reattach replays the journal from byte 0 with more appended.
            streamChunksQueue: [['hel'], ['hello world']],
            jobQueue: [{ status: 'running' }, { status: 'done' }],
        })
        const res = await makeJobFetch(makeOpts({ reconnectBaseDelayMs: 1 }))('https://provider.example/v1/chat', { method: 'POST', body: '{}' })
        expect(await res.text()).toBe('hello world') // replayed prefix skipped, not duplicated
        expect(callsFor(calls, '/api/model-jobs/job-1/stream')).toHaveLength(2)
        await vi.waitFor(() => {
            expect(callsFor(calls, '/api/model-jobs/job-1/claim', 'POST')).toHaveLength(1)
        })
    })

    test('reattach cycles without progress eventually error the body (끊김 ≠ 완료), no claim', async () => {
        // Server accepts every reattach but the job never progresses nor
        // finishes — the no-progress cap must break the loop.
        const { calls } = setupServer({ streamChunks: ['partial tex'], job: { status: 'running' } })
        const res = await makeJobFetch(makeOpts({ reconnectBaseDelayMs: 1 }))('https://provider.example/v1/chat', { method: 'POST', body: '{}' })
        await expect(drain(res)).rejects.toThrow(ModelJobConnectionLostError)
        expect(callsFor(calls, '/api/model-jobs/job-1/claim', 'POST')).toHaveLength(0)
    })

    test('unreachable status check after stream end also counts as connection lost', async () => {
        setupServer({ streamChunks: ['partial'], jobReject: new TypeError('network down') })
        const res = await makeJobFetch(makeOpts({ reconnectBaseDelayMs: 1 }))('https://provider.example/v1/chat', { method: 'POST', body: '{}' })
        // Asserted by type, not text: the message is localized (language.errors).
        await expect(drain(res)).rejects.toThrow(ModelJobConnectionLostError)
    })

    test('aux jobs forward kind and their own unique key', async () => {
        const { calls } = setupServer({ streamChunks: ['{"ok":true}'], job: { status: 'done' } })
        await makeJobFetch(makeOpts({ jobKind: 'aux', realChatId: 'aux-gen-9' }))('https://provider.example/v1/chat', { method: 'POST', body: '{}' })
        const [create] = callsFor(calls, '/api/model-jobs', 'POST')
        expect(JSON.parse(create.init?.body as string)).toMatchObject({ kind: 'aux', chatId: 'aux-gen-9' })
    })

    test('stream end with failed job errors the body with the job error and claims it', async () => {
        const { calls } = setupServer({ streamChunks: ['par'], job: { status: 'failed', error: 'upstream timeout' } })
        const res = await makeJobFetch(makeOpts())('https://provider.example/v1/chat', { method: 'POST', body: '{}' })
        await expect(drain(res)).rejects.toThrow('upstream timeout')
        // The user saw this failure live — claim so the next boot's discovery
        // doesn't insert a duplicate error into the chat.
        await vi.waitFor(() => {
            expect(callsFor(calls, '/api/model-jobs/job-1/claim', 'POST')).toHaveLength(1)
        })
    })

    test('stream end with aborted job does not claim', async () => {
        const { calls } = setupServer({ streamChunks: ['par'], job: { status: 'aborted' } })
        const res = await makeJobFetch(makeOpts())('https://provider.example/v1/chat', { method: 'POST', body: '{}' })
        await expect(drain(res)).rejects.toThrow('model job aborted')
        await new Promise((r) => setTimeout(r, 10))
        expect(callsFor(calls, '/api/model-jobs/job-1/claim', 'POST')).toHaveLength(0)
    })

    test('abort fires a job DELETE', async () => {
        const { calls } = setupServer({ streamNeverEnds: true })
        const controller = new AbortController()
        const res = await makeJobFetch(makeOpts())('https://provider.example/v1/chat', {
            method: 'POST',
            body: '{}',
            signal: controller.signal,
        })
        void res.body!.getReader().read().catch(() => {})
        controller.abort()
        await vi.waitFor(() => {
            expect(callsFor(calls, '/api/model-jobs/job-1', 'DELETE')).toHaveLength(1)
        })
    })

    test('creation 409 throws ModelJobBusyError and never falls back', async () => {
        setupServer({ create: { status: 409, body: { error: 'busy', jobId: 'job-1' } } })
        const opts = makeOpts()
        await expect(makeJobFetch(opts)('https://provider.example/v1/chat', { method: 'POST', body: '{}' }))
            .rejects.toThrow(ModelJobBusyError)
        expect(opts.fallbackFetch).not.toHaveBeenCalled()
    })

    test('creation network failure falls back to the direct fetch with the same args', async () => {
        setupServer({ createReject: new TypeError('Failed to fetch') })
        const opts = makeOpts()
        const init = { method: 'POST', body: '{}' }
        const res = await makeJobFetch(opts)('https://provider.example/v1/chat', init)
        expect(await res.text()).toBe('fallback')
        expect(opts.fallbackFetch).toHaveBeenCalledWith('https://provider.example/v1/chat', init)
    })

    test('creation 5xx (misbehaving/older server) falls back to the direct fetch', async () => {
        setupServer({ create: { status: 500, body: {} } })
        const opts = makeOpts()
        const res = await makeJobFetch(opts)('https://provider.example/v1/chat', { method: 'POST', body: '{}' })
        expect(await res.text()).toBe('fallback')
        expect(opts.fallbackFetch).toHaveBeenCalledTimes(1)
    })

    test('creation abort surfaces the abort instead of falling back', async () => {
        setupServer({ createReject: new DOMException('The operation was aborted.', 'AbortError') })
        const controller = new AbortController()
        controller.abort()
        const opts = makeOpts()
        await expect(makeJobFetch(opts)('https://provider.example/v1/chat', {
            method: 'POST',
            body: '{}',
            signal: controller.signal,
        })).rejects.toThrow('aborted')
        expect(opts.fallbackFetch).not.toHaveBeenCalled()
    })
})

// Keep the claim boundary real: a permissive fetch stub hid the tokenless
// live EOF request even after the server began requiring claim ownership.
describe('live EOF against the model-jobs claim routes', () => {
    let saveDir: string
    let store: ReturnType<typeof modelJobs.createModelJobs>
    let appServer: http.Server
    let base: string
    let directFetch: typeof fetch
    let claimResponses: { method: string, status: number, body: Record<string, unknown> }[]

    beforeAll(async () => {
        directFetch = globalThis.fetch.bind(globalThis)
        saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-fetch-claim-test-'))
        store = modelJobs.createModelJobs({ saveDir })
        const app = express()
        app.use((req, res, next) => {
            res.set('access-control-allow-origin', '*')
            res.set('access-control-allow-headers', 'content-type, risu-auth, x-model-job-claim-token')
            res.set('access-control-allow-methods', 'GET, POST, DELETE')
            if (req.method === 'OPTIONS') res.sendStatus(204)
            else next()
        })
        app.use(express.json())
        store.registerRoutes(app, {
            auth: async (req: express.Request, res: express.Response) => {
                if (req.get('risu-auth') === 'test-auth') return true
                res.status(400).send({ error: 'No auth header' })
                return false
            },
        })
        appServer = http.createServer(app)
        await new Promise<void>((resolve, reject) => {
            appServer.once('error', reject)
            appServer.listen(0, '127.0.0.1', resolve)
        })
        base = `http://127.0.0.1:${(appServer.address() as { port: number }).port}`
    })

    function seedJob(status = 'done') {
        const Database = require('better-sqlite3')
        const db = new Database(path.join(saveDir, 'model-jobs.db'))
        try {
            db.prepare('DELETE FROM model_jobs WHERE id = ?').run('job-1')
            db.prepare(`
                INSERT INTO model_jobs (id, chat_id, generation_id, status, created_at)
                VALUES ('job-1', 'chat-1', 'gen-1', ?, ?)
            `).run(status, Date.now())
        } finally {
            db.close()
        }
    }

    beforeEach(() => {
        seedJob()
        claimResponses = []
    })

    afterAll(async () => {
        await new Promise<void>((resolve, reject) => {
            appServer.close((err) => err ? reject(err) : resolve())
            appServer.closeAllConnections()
        })
        store.close()
        fs.rmSync(saveDir, { recursive: true, force: true })
    })

    const routeClaim: typeof fetch = async (input, init) => {
        const res = await directFetch(`${base}${input}`, init)
        const body = await res.json()
        claimResponses.push({ method: init?.method ?? 'GET', status: res.status, body })
        return new Response(JSON.stringify(body), { status: res.status, headers: res.headers })
    }

    test('the real server rejects a tokenless POST with 400 and leaves the job recoverable', async () => {
        const res = await routeClaim('/api/model-jobs/job-1/claim', {
            method: 'POST', headers: { 'risu-auth': 'test-auth' },
        })
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({ error: 'claimToken is required' })
        expect(store.getJob('job-1')?.claimed).toBe(false)
    })

    test.each(['done', 'failed'])('live %s EOF claims with a token accepted by the real server', async (status) => {
        seedJob(status)
        const { calls } = setupServer({
            streamChunks: ['hello world'], job: { status, error: 'upstream timeout' }, claimFetch: routeClaim,
        })
        const res = await makeJobFetch(makeOpts())('https://provider.example/v1/chat')
        if (status === 'done') expect(await drain(res)).toBe('hello world')
        else await expect(drain(res)).rejects.toThrow('upstream timeout')

        await vi.waitFor(() => expect(claimResponses).toHaveLength(1))
        expect(claimResponses[0]).toEqual({ method: 'POST', status: 200, body: { success: true } })
        const [claim] = callsFor(calls, '/api/model-jobs/job-1/claim', 'POST')
        expect(new Headers(claim.init?.headers).get('content-type')).toBe('application/json')
        const { claimToken } = JSON.parse(claim.init?.body as string)
        expect(claimToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
        expect(store.getJob('job-1')?.claimed).toBe(true)
        expect(store.ownsJobClaim('job-1', claimToken)).toBe(true)

        // Repeating the same claim is idempotent; another owner cannot take
        // or release it. Only the token holder can make it recoverable again.
        expect(await (await routeClaim(claim.url, claim.init)).json()).toEqual({ success: true })
        expect(await (await routeClaim(claim.url, {
            ...claim.init, body: JSON.stringify({ claimToken: 'other-owner' }),
        })).json()).toEqual({ success: false })
        const ownerHeaders = { 'risu-auth': 'test-auth', 'x-model-job-claim-token': claimToken }
        expect(await (await routeClaim(claim.url, { headers: ownerHeaders })).json()).toEqual({ owned: true })
        expect(await (await routeClaim(claim.url, {
            method: 'DELETE', headers: { ...ownerHeaders, 'x-model-job-claim-token': 'other-owner' },
        })).json()).toEqual({ released: false })
        expect(store.ownsJobClaim('job-1', claimToken)).toBe(true)
        expect(await (await routeClaim(claim.url, { method: 'DELETE', headers: ownerHeaders })).json())
            .toEqual({ released: true })
        expect(store.getJob('job-1')?.claimed).toBe(false)
    })

    test.each(['lost response', 'HTTP error', 'invalid JSON'])(
        'confirms the same token after a committed claim with %s, without releasing it', async (failure) => {
            const { calls } = setupServer({
                streamChunks: ['hello world'], job: { status: 'done' },
                claimFetch: async (input, init) => {
                    const res = await routeClaim(input, init)
                    if (init?.method === 'POST') {
                        if (failure === 'lost response') throw new TypeError('claim acknowledgment lost')
                        if (failure === 'HTTP error') return new Response('', { status: 502 })
                        return new Response('invalid JSON', { status: 200 })
                    }
                    return res
                },
            })
            const res = await makeJobFetch(makeOpts())('https://provider.example/v1/chat')
            expect(await drain(res)).toBe('hello world')
            await vi.waitFor(() => expect(claimResponses).toHaveLength(2))
            expect(claimResponses).toEqual([
                { method: 'POST', status: 200, body: { success: true } },
                { method: 'GET', status: 200, body: { owned: true } },
            ])
            const [post] = callsFor(calls, '/api/model-jobs/job-1/claim', 'POST')
            const [probe] = callsFor(calls, '/api/model-jobs/job-1/claim')
            const { claimToken } = JSON.parse(post.init?.body as string)
            expect(new Headers(probe.init?.headers).get('x-model-job-claim-token')).toBe(claimToken)
            expect(store.ownsJobClaim('job-1', claimToken)).toBe(true)
            expect(callsFor(calls, '/api/model-jobs/job-1/claim', 'DELETE')).toHaveLength(0)
        },
    )

    test('a live claim losing to another owner preserves both the output and the other claim', async () => {
        expect(store.claimJob('job-1', 'recovery-owner')).toEqual({ success: true })
        const { calls } = setupServer({ streamChunks: ['hello world'], claimFetch: routeClaim })
        const res = await makeJobFetch(makeOpts())('https://provider.example/v1/chat')
        expect(await drain(res)).toBe('hello world')
        await vi.waitFor(() => expect(claimResponses).toHaveLength(1))
        expect(claimResponses[0]).toEqual({ method: 'POST', status: 200, body: { success: false } })
        expect(store.ownsJobClaim('job-1', 'recovery-owner')).toBe(true)
        expect(callsFor(calls, '/api/model-jobs/job-1/claim')).toHaveLength(0)
        expect(callsFor(calls, '/api/model-jobs/job-1/claim', 'DELETE')).toHaveLength(0)
    })
})
