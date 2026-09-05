import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Chat } from 'src/ts/storage/database.svelte'
import { makeJobFetch, type JobClaimHandle } from './jobFetch'
import { createMainJobCompletion, prepareMainJobContinuation } from './mainJobCompletion'
import { streamChatRequest } from 'src/ts/preset/adapter/openaiCompatible'
import type { ModelPreset } from 'src/ts/preset/types'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import modelJobs from '../../../../server/node/model-jobs.cjs'

const mocks = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock('src/ts/storage/chatStorage', () => ({ saveChatToServerStrict: mocks.save }))
vi.mock('src/ts/globalApi.svelte', () => ({ forageStorage: { createAuth: async () => 'test' } }))
vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => ({ nodeOnlyServerSideRequests: true }) }))

function deferred() {
    let resolve!: () => void
    return { promise: new Promise<void>((r) => { resolve = r }), resolve: () => resolve() }
}

async function fixture() {
    const handles: JobClaimHandle[] = []
    const state = {
        owner: '', pending: true, claimCalls: 0, probes: [] as string[], releases: [] as string[],
        loseClaimAck: false, failPending: false, events: [] as string[],
        disk: null as Chat | null,
    }
    vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
        const url = String(input), method = init?.method ?? 'GET'
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
        if (url === '/api/model-jobs?unclaimed=1') return json({ jobs: state.owner ? [] : [{ id: 'job', generationId: 'gen' }] })
        if (url === '/api/model-jobs' && method === 'POST') return json({ jobId: 'job' })
        if (url.endsWith('/stream')) return new Response('journal full tail', { headers: { 'x-model-job-upstream-status': '200' } })
        if (url === '/api/model-jobs/job') return json({ status: 'done' })
        if (url === '/api/model-jobs/job/claim') {
            if (method === 'POST') {
                state.claimCalls++
                state.events.push('claim')
                state.owner = JSON.parse(String(init.body)).claimToken
                if (state.loseClaimAck) throw new Error('lost ACK')
                return json({ success: true })
            }
            const token = new Headers(init?.headers).get('x-model-job-claim-token')
            if (method === 'DELETE') {
                state.releases.push(token)
                const released = state.owner === token
                if (released) state.owner = ''
                return json({ released })
            }
            state.probes.push(token)
            return json({ owned: state.owner === token })
        }
        if (url.startsWith('/api/pending-sends/') && method === 'DELETE') {
            expect(JSON.parse(String(init.body)).generationId).toBe('gen')
            if (state.failPending) return json({}, 503)
            state.pending = false
            state.events.push('pending')
            return json({ success: true })
        }
        throw new Error(`Unexpected test request ${method} ${url}`)
    }))
    const response = await makeJobFetch({
        realChatId: 'chat', generationId: 'gen', adapterKind: 'openai-compatible', streaming: false,
        onJobCreated: (handle) => handles.push(handle), fallbackFetch: vi.fn(),
    })('https://example.test/model')
    expect(await response.text()).toBe('journal full tail')
    const chat = { id: 'chat', message: [{ role: 'char', data: 'edited final', chatId: 'original', generationInfo: { generationId: 'gen' } }] } as Chat
    const complete = createMainJobCompletion({ generationId: 'gen', chatId: 'chat', handles,
        locate: () => ({ chaId: 'char', chatIndex: 2, chat }) })
    mocks.save.mockImplementation(async (_cha, _index, _id, value: Chat) => {
        state.disk = structuredClone(value)
        state.events.push('save')
        return { success: true, durable: true }
    })
    const discover = async () => (await (await fetch('/api/model-jobs?unclaimed=1')).json()).jobs
    return { state, handles, chat, complete, discover }
}

beforeEach(() => { mocks.save.mockReset() })
afterEach(() => vi.unstubAllGlobals())

test('EOF and a paused final save leave the journal discoverable across a crash; ACK precedes one idempotent claim', async () => {
    const { state, chat, handles, complete, discover } = await fixture()
    const ack = deferred()
    mocks.save.mockImplementation(async (_cha, _index, _id, value) => {
        const snapshot = structuredClone(value)
        await ack.promise
        state.disk = snapshot
        state.events.push('save')
    })
    expect(await discover()).toHaveLength(1)
    const finishing = complete()
    expect(await discover()).toHaveLength(1)
    expect(state.pending).toBe(true)
    expect(state.disk).toBeNull()
    expect(state.claimCalls).toBe(0)
    ack.resolve()
    expect(await finishing).toBe(true)
    expect(await complete()).toBe(true)
    expect(await handles[0].claim()).toBe(true)
    expect(state.events).toEqual(['save', 'pending', 'claim'])
    expect(state.claimCalls).toBe(1)
    expect(state.disk.message[0]).toMatchObject({ data: 'edited final', chatId: 'original', generationInfo: { generationId: 'gen', completed: true } })
    expect(chat.message).toHaveLength(1)
    expect(await discover()).toHaveLength(0)
})

test.each([false, true])('save failure preserves pending and reconciles only this token (owned=%s)', async (owned) => {
    const { state, handles, complete, discover } = await fixture()
    if (owned) state.owner = handles[0].claimToken
    mocks.save.mockRejectedValue(new Error('save ACK unavailable'))
    expect(await complete()).toBe(false)
    expect(state.claimCalls).toBe(0)
    expect(state.pending).toBe(true)
    expect(state.probes).toEqual([handles[0].claimToken])
    expect(state.releases).toEqual(owned ? [handles[0].claimToken] : [])
    expect(await discover()).toHaveLength(1)
})

test('lost claim ACK is confirmed with the same token after final persistence', async () => {
    const { state, handles, complete } = await fixture()
    state.loseClaimAck = true
    expect(await complete()).toBe(true)
    expect(state.events).toEqual(['save', 'pending', 'claim'])
    expect(state.probes).toEqual([handles[0].claimToken])
    expect(state.releases).toEqual([])
})

test('pending conclusion failure keeps a durably saved job discoverable', async () => {
    const { state, complete, discover } = await fixture()
    state.failPending = true
    expect(await complete()).toBe(false)
    expect(state.disk.message[0].generationInfo.completed).toBe(true)
    expect(state.pending).toBe(true)
    expect(state.claimCalls).toBe(0)
    expect(await discover()).toHaveLength(1)
})

test('continuation prefix and generation slot are durable before the request can start', async () => {
    const prefix = 'Previous response. '.repeat(20)
    const chat = { id: 'chat', message: [{ role: 'char', chatId: 'original', data: prefix, generationInfo: { generationId: 'continued' } }] } as Chat
    const ack = deferred()
    let persisted: Chat
    let requestStarted = false
    mocks.save.mockImplementation(async (_cha, _index, _id, value) => {
        persisted = structuredClone(value)
        await ack.promise
    })
    const preparing = prepareMainJobContinuation({ chatId: 'chat', generationId: 'continued', handles: [],
        locate: () => ({ chaId: 'char', chatIndex: 0, chat }) }).then(() => { requestStarted = true })
    expect(persisted.message[0]).toMatchObject({ chatId: 'original', generationInfo: { generationId: 'continued', continuePrefix: prefix } })
    expect(requestStarted).toBe(false)
    ack.resolve()
    await preparing
    expect(requestStarted).toBe(true)
})

test('the real SSE adapter can return at DONE before EOF status; completion still claims once after terminal', async () => {
    const terminal = deferred()
    const handles: JobClaimHandle[] = []
    let claims = 0, statusReads = 0, saved = false, pendingCleared = false
    vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
        const url = String(input), method = init?.method ?? 'GET'
        const json = (value: unknown) => new Response(JSON.stringify(value))
        if (url === '/api/model-jobs') return json({ jobId: 'job' })
        if (url.endsWith('/stream')) return new Response('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n',
            { headers: { 'x-model-job-upstream-status': '200', 'content-type': 'text/event-stream' } })
        if (url === '/api/model-jobs/job') {
            statusReads++
            await terminal.promise
            return json({ status: 'done' })
        }
        if (url.endsWith('/claim') && method === 'POST') {
            expect(saved && pendingCleared).toBe(true)
            claims++
            return json({ success: true })
        }
        if (url.startsWith('/api/pending-sends/')) { pendingCleared = true; return json({ success: true }) }
        throw new Error(`Unexpected request ${url}`)
    }))
    const fetchImpl = makeJobFetch({ realChatId: 'chat', generationId: 'gen', adapterKind: 'openai-compatible', streaming: true,
        onJobCreated: (handle) => handles.push(handle), fallbackFetch: vi.fn(), reconnectBaseDelayMs: 1 })
    const preset: ModelPreset = { id: 'preset', name: 'Preset', userValues: {}, createdAt: 1, updatedAt: 1,
        profileSnapshot: { profileId: 'test', profileVersion: 1, providerBaseId: 'test', providerBaseVersion: 1,
            adapterKind: 'openai-compatible', auth: { kind: 'bearer', fields: ['apiKey'] },
            endpoint: { kind: 'static', url: 'https://example.test/chat' }, modelId: 'test', schema: [],
            uiSchema: { groups: [], fields: [] }, defaults: {}, headerTemplate: {}, capabilities: ['streaming'] } }
    let text = ''
    for await (const delta of streamChatRequest(preset, { messages: [{ role: 'user', content: 'Prompt' }], fetchImpl }, { apiKey: 'test' })) {
        text += delta.textDelta ?? ''
    }
    expect(text).toBe('Hello')
    expect(handles[0].terminal).toBe(false)
    expect(claims).toBe(0)
    const chat = { id: 'chat', message: [{ role: 'char', data: text, generationInfo: { generationId: 'gen' } }] } as Chat
    mocks.save.mockImplementation(async () => { saved = true })
    const complete = createMainJobCompletion({ chatId: 'chat', generationId: 'gen', handles,
        locate: () => ({ chaId: 'char', chatIndex: 0, chat }) })
    const completing = complete()
    await vi.waitFor(() => expect(statusReads).toBeGreaterThanOrEqual(2))
    expect(claims).toBe(0)
    terminal.resolve()
    expect(await completing).toBe(true)
    expect(await complete()).toBe(true)
    expect(claims).toBe(1)
})

test('a real job database reopened after live EOF still discovers the journal before final-save ACK', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-job-crash-'))
    let store = modelJobs.createModelJobs({ saveDir: dir })
    const sql = new Database(path.join(dir, 'model-jobs.db'))
    sql.prepare(`INSERT INTO model_jobs (id, chat_id, generation_id, status, created_at, ended_at)
        VALUES ('job', 'chat', 'gen', 'done', ?, ?)`).run(Date.now(), Date.now())
    sql.close()
    fs.writeFileSync(store.journalPath('job'), 'full journal tail')
    const handles: JobClaimHandle[] = []
    const ack = deferred()
    let finishing: Promise<boolean> | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
        const url = String(input), method = init?.method ?? 'GET'
        const json = (value: unknown) => new Response(JSON.stringify(value))
        if (url === '/api/model-jobs') return json({ jobId: 'job' })
        if (url.endsWith('/stream')) return new Response(fs.readFileSync(store.journalPath('job')), { headers: { 'x-model-job-upstream-status': '200' } })
        if (url.endsWith('/claim')) {
            if (method === 'POST') return json(store.claimJob('job', JSON.parse(String(init.body)).claimToken))
            return json({ owned: store.ownsJobClaim('job', new Headers(init.headers).get('x-model-job-claim-token')) })
        }
        if (url.startsWith('/api/pending-sends/')) return json({ success: true })
        return json(store.getJob('job'))
    }))
    try {
        const response = await makeJobFetch({ realChatId: 'chat', generationId: 'gen', adapterKind: 'openai-compatible', streaming: false,
            onJobCreated: (handle) => handles.push(handle), fallbackFetch: vi.fn() })('https://example.test/model')
        expect(await response.text()).toBe('full journal tail')
        const chat = { id: 'chat', message: [{ role: 'char', data: 'final edited tail', generationInfo: { generationId: 'gen' } }] } as Chat
        mocks.save.mockImplementation(async () => { await ack.promise })
        finishing = createMainJobCompletion({ generationId: 'gen', chatId: 'chat', handles,
            locate: () => ({ chaId: 'char', chatIndex: 0, chat }) })()
        store.close()
        store = modelJobs.createModelJobs({ saveDir: dir })
        expect(store.listJobs('unclaimed').map((job: any) => job.id)).toContain('job')
        expect(fs.readFileSync(store.journalPath('job'), 'utf8')).toBe('full journal tail')
        ack.resolve()
        expect(await finishing).toBe(true)
        expect(store.listJobs('unclaimed')).toEqual([])
    } finally {
        ack.resolve()
        await finishing
        store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
