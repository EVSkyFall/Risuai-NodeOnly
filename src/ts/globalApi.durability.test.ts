import { afterEach, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import ts from 'typescript'
import { mergeServerDbWithTrackedLocalChanges, withTrackedCharacters, hasAmbiguousCharacterIds } from './storage/rebaseMerge'
import { newSaveTiming } from './storage/saveMetrics'

const source = fs.readFileSync('src/ts/globalApi.svelte.ts', 'utf8').replace(/\r\n/g, '\n')
const ast = ts.createSourceFile('globalApi.ts', source, ts.ScriptTarget.Latest, true)
function extract(name: string) {
    let text = ''
    function visit(node: ts.Node) {
        if (ts.isFunctionDeclaration(node) && node.name?.text === name) text = node.getText(ast).replace(/^export /, '')
        else ts.forEachChild(node, visit)
    }
    visit(ast)
    return text
}
function run(code: string, deps: Record<string, any>) {
    deps = { newSaveTiming, recordSaveSample: vi.fn(), recordDbTransferSize: vi.fn(),
        mergeServerDbWithTrackedLocalChanges, withTrackedCharacters, hasAmbiguousCharacterIds,
        generatingCharacters: () => new Map(), abortGenerationsAndWait: async () => {},
        normalizeJSON: (x: any) => x, convertStubsToPlaceholders: (x: any) => x,
        notifyDatabaseRebased: () => {}, notifyError: vi.fn(), ...deps }
    code = 'let saveSeq = 0, lastSavedSeq = 0; ' + code

    const js = ts.transpileModule(`const { ${Object.keys(deps).join(',')} } = deps; ${code}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
    return new Function('deps', js)(deps)
}
afterEach(() => vi.restoreAllMocks())

test('cause3: save loop retries beyond fifth failure and resets its backoff after success', async () => {
    const persist = vi.fn().mockRejectedValue(new Error('offline'))
    const sleep = vi.fn(async (_ms: number) => {})
    const alert = vi.fn()
    const api = run(`
        let changed = false, saveInFlight = null, savetrys = 0, saveRetryDelay = 500;
        const saving = { state: false };
        const changeTracker = { chat: [], character: [] };
        ${extract('triggerSave')}
        return { triggerSave, dirty: () => changed, clear: () => changed = false };
    `, { persistTrackedChanges: persist, takeTrackedChanges: () => ({ chat: [['c','x']] }), hasTrackedChanges: x => x.chat.length > 0,
        requeueTrackedChanges: vi.fn(), alertError: alert, sleep, console: { error: vi.fn() } })
    for (let i = 0; i < 9; i++) {
        api.clear(); await api.triggerSave(); expect(api.dirty()).toBe(true)
    }
    expect(persist).toHaveBeenCalledTimes(9)
    expect(alert).toHaveBeenCalledTimes(1)
    expect(sleep.mock.calls.map(c => c[0])).toEqual([500,1000,2000,4000,8000,16000,30000,30000,30000])
    persist.mockResolvedValueOnce('saved')
    api.clear(); await api.triggerSave(); expect(api.dirty()).toBe(false)
    await api.triggerSave()
    expect(sleep.mock.calls.at(-1)[0]).toBe(500)
})

test('cause4: 409 fallback rebases same-character remote new chat and preserves local deletion', async () => {
    const local = { characters: [{ chaId: 'c', name: 'local edit', chats: [{ id: 'keep', message: [{ data: 'local edit' }] }] }], botPresets: [], modules: [] }
    const server = { ...structuredClone(local), characters: [{ chaId: 'c', name: 'server', chats: [
        { id: 'keep', message: [{ data: 'original' }] }, { id: 'deleted', message: [] }, { id: 'other-tab-new', message: [{ data: 'remote new' }] },
    ] }] }
    let db: any = local, etag = 'old'
    class ConflictError extends Error { currentEtag = 'new' }
    class Encoder { async init() {} async set() {} encode() { return new Uint8Array([1]) } }
    const commit = vi.fn()
    class Patcher { async init() {} baselineArchivedCharacterIds() { return new Set() } baselineDb() { return local } estimatePayloadBytes() { return 0 } async prepare() { return { changedCharacterIds: ['c'], patchData: { patch: [], expectedHash: 'hash' }, commit } } }
    const storage = {
        patchItem: vi.fn().mockResolvedValueOnce({ success: false, etag: 'new' }).mockResolvedValue({ success: true, etag: 'merged' }),
        setDbEtag: vi.fn(v => { etag = v }), getDbEtag: () => etag,
        getItem: vi.fn(async () => new Uint8Array([2])),
        setItem: vi.fn(async (_key, _bytes, current) => {
            expect(current).toBe('old'); throw new ConflictError()
        }),
    }
    const api = run(`
        let changed = false, savetrys = 0, activeSavePatcher;
        let encoder = new RisuSaveEncoder(), patcher = new RisuSavePatcher();
        const knownChatIdsByCharacter = new Map([['c', new Set(['keep', 'deleted'])]]);
        ${extract('rebaseTrackedLocalChangesOnLatestServerDb')}
        ${extract('persistTrackedChanges')}
        return { persistTrackedChanges: changes => persistTrackedChanges(changes, newSaveTiming()), dirty: () => changed };
    `, { forageStorage: storage, getDatabase: () => db, setDatabase: v => { db = v },
        decodeRisuSave: async () => server, safeStructuredClone: structuredClone, supportsPatchSync: true,
        RisuSaveEncoder: Encoder, RisuSavePatcher: Patcher, collectChatsToPersist: () => [], findDangerousChatOps: () => [],
        requeueTrackedChanges: vi.fn(), updateKnownChatsAfterSuccessfulSave: vi.fn(),
        restoreChatShapeAfterRebase: () => {}, reanchorRebasedSelection: () => ({ botPresetsId: 0, selectedCharIndex: -1 }),
        selectedCharID: { subscribe: cb => { cb(-1); return () => {} }, set: vi.fn() },
        sleep: async () => {}, ConflictError, console: { warn: vi.fn() }, showPersistWarningOnce: vi.fn(),
    })
    const changes = { character: ['c'], chat: [['c', 'keep']], root: false }
    expect(await api.persistTrackedChanges(changes)).toBe('retry')
    expect(commit).not.toHaveBeenCalled()
    expect(api.dirty()).toBe(true)
    expect(db.characters[0].chats.map(c => c.id)).toEqual(['keep', 'other-tab-new'])
    expect(db.characters[0].chats[0].message[0].data).toBe('local edit')
    expect(db.characters[0].chats[1].message[0].data).toBe('remote new')
    expect(await api.persistTrackedChanges(changes)).toBe('saved')
    expect(commit).toHaveBeenCalledTimes(1)
})

test('cause6: queue registration marks a nonselected chat dirty', () => {
    const registration = source.slice(source.indexOf('    requeueChatSaveImpl = (chaId, chatId) =>'), source.indexOf('    let patcher = new RisuSavePatcher()', source.indexOf('export async function saveDb')))
    const api = run(`
        let changed = false, requeueChatSaveImpl;
        const pendingChatSaveRetries = [];
        const changeTracker = { chat: [['selected', 'other']] };
        ${extract('requeueChatSave')}
        ${registration}
        requeueChatSave('background', 'completed');
        requeueChatSave('background', 'completed');
        return { changed, chats: changeTracker.chat };
    `, {})
    expect(api.changed).toBe(true)
    expect(api.chats).toEqual([['selected','other'], ['background','completed']])
})

test.each(['fetchViaProxy2', 'fetchWithProxy'])('cause7f: %s resends the same body once only for Token Expired', async name => {
    const json = (status, body, expired = false) => new Response(JSON.stringify(body), { status, headers: expired ? { 'x-risu-auth-error': 'token-expired' } : {} })
    const fetch = vi.fn().mockResolvedValueOnce(json(400, { error: 'Token Expired' }, true))
        .mockResolvedValueOnce(json(200, { result: 'ok' }))
    const createAuth = vi.fn().mockResolvedValueOnce('old').mockResolvedValue('new')
    const fn = run(`${extract('fetchProxyWithAuthRetry')}\n${extract(name)}; return ${name};`, {
        fetch, forageStorage: { createAuth }, getEffectiveTurnId: () => 'turn', DBState: { db: {} },
        throwIfGlobalFetchAbortedBeforeDispatch: () => {}, addFetchLogInGlobalFetch: () => {},
        handleGlobalFetchTransportFailure: e => { throw e }, handleGlobalFetchBodyFailure: e => { throw e },
    })
    const controller = new AbortController()
    const body = new Uint8Array([1,2,3])
    const call = () => name === 'fetchViaProxy2'
        ? fn('https://synthetic.invalid', {}, body, { method: 'POST', signal: controller.signal })
        : fn('https://synthetic.invalid', { headers: {}, body: { prompt: 'synthetic' }, method: 'POST', abortSignal: controller.signal })
    expect((await call()).status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(createAuth).toHaveBeenLastCalledWith(true)
    expect(fetch.mock.calls[1][1].body).toEqual(fetch.mock.calls[0][1].body)
    expect(fetch.mock.calls[1][1].signal).toBe(controller.signal)
    expect(new Headers(fetch.mock.calls[1][1].headers).get('risu-auth')).toBe('new')
    fetch.mockReset().mockImplementation(async () => json(400, { error: 'Token Expired' }, true))
    expect((await call()).status).toBe(400)
    expect(fetch).toHaveBeenCalledTimes(2)
    fetch.mockReset().mockImplementation(async () => json(400, { error: 'Token Expired' }))
    expect((await call()).status).toBe(400)
    expect(fetch).toHaveBeenCalledTimes(1)
})

test.each(['throw', 'retry'])('round2-C-D: main loop joining backoff cannot lose retry (%s)', async kind => {
    const persist = kind === 'throw' ? vi.fn().mockRejectedValue(new Error('offline')) : vi.fn().mockResolvedValue('retry')
    let release: () => void
    const sleep = vi.fn((_ms: number) => new Promise<void>(r => { release = r }))
    const api = run(`
        let changed = false, saveInFlight = null, savetrys = 0, saveRetryDelay = 500;
        const saving = { state: false };
        const changeTracker = { chat: [], character: [] };
        ${extract('triggerSave')}
        return { triggerSave, dirty: () => changed, clear: () => changed = false };
    `, { persistTrackedChanges: persist, takeTrackedChanges: () => ({ chat: [['c','x']] }), hasTrackedChanges: x => x.chat.length > 0,
        requeueTrackedChanges: vi.fn(), alertError: vi.fn(), sleep, console: { error: vi.fn() } })
    for (const delay of [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
        const first = api.triggerSave()
        await Promise.resolve(); await Promise.resolve()
        expect(sleep).toHaveBeenLastCalledWith(delay)
        api.clear()
        const joiningLoop = api.triggerSave()
        release()
        await Promise.all([first, joiningLoop])
        expect(api.dirty()).toBe(true)
    }
    expect(persist).toHaveBeenCalledTimes(8)
})

test('round2-I: first general effect retains pre-init requeued chats', () => {
    const start = source.indexOf('            if (!didInitGeneralEffect)')
    const end = source.indexOf('            saveTimeoutExecute()', start)
    const api = run(`
        let didInitGeneralEffect = false;
        const changeTracker = { character: ['selected'], chat: [['background', 'unsaved']] };
        function effect() { ${source.slice(start, end)} }
        effect(); return changeTracker;
    `, {})
    expect(api.chat).toEqual([['background', 'unsaved']])
})

test('round2-F: job creation retries once with provenance and uses refreshed WS auth', async () => {
    let auth = 'old'
    const createAuth = vi.fn(async (force?: boolean) => { if (force) auth = 'new'; return auth })
    const json = (status, body, expired = false) => new Response(JSON.stringify(body), { status, headers: expired ? { 'x-risu-auth-error': 'token-expired' } : {} })
    const fetch = vi.fn().mockResolvedValueOnce(json(400, { error: 'Token Expired' }, true))
        .mockResolvedValueOnce(json(200, { jobId: 'synthetic-job' }))
    const sockets: any[] = []
    class Socket {
        onmessage: any
        constructor(public url: string) { sockets.push(this); queueMicrotask(() => this.onmessage?.({ data: 'headers' })) }
    }
    const fn = run(`${extract('fetchProxyWithAuthRetry')}
${extract('fetchViaProxyJobWs')}; return fetchViaProxyJobWs;`, {
        fetch, forageStorage: { createAuth }, defaultProxyJobHeartbeatSec: 10, location: { protocol: 'http:', host: 'synthetic.invalid' },
        WebSocket: Socket, Buffer, parseProxyJobWsEvent: () => ({ type: 'upstream_headers', status: 200, headers: {} }),
    })
    const signal = new AbortController().signal
    await expect(fn('https://synthetic.invalid', { method: 'POST', headers: {}, body: new Uint8Array([1]), signal })).resolves.toMatchObject({ status: 200 })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls.every(c => c[0] === '/proxy-stream-jobs')).toBe(true)
    expect(fetch.mock.calls[1][1].body).toBe(fetch.mock.calls[0][1].body)
    expect(fetch.mock.calls[1][1].signal).toBe(signal)
    expect(sockets[0].url).toContain('risu-auth=new')
    fetch.mockReset().mockImplementation(async () => json(400, { error: 'Token Expired' }, true))
    await expect(fn('x', { method: 'POST', headers: {} })).rejects.toThrow('Failed to create')
    expect(fetch).toHaveBeenCalledTimes(2)
    fetch.mockReset().mockImplementation(async () => json(400, { error: 'Token Expired' }))
    await expect(fn('x', { method: 'POST', headers: {} })).rejects.toThrow('Failed to create')
    expect(fetch).toHaveBeenCalledTimes(1)
})


test.each(['chat', 'character', 'root'])('round3-5: successful immediate save drains in-flight requeued %s through the actual loop', async kind => {
    const registration = source.slice(source.indexOf('    requeueChatSaveImpl = (chaId, chatId) =>'), source.indexOf('    let patcher = new RisuSavePatcher()', source.indexOf('export async function saveDb')))
    const immediate = source.slice(source.indexOf('    requestImmediateSaveImpl = async (options) =>'), source.indexOf('    while (true) {', source.indexOf('    requestImmediateSaveImpl = async (options) =>')))
    const loop = source.slice(source.indexOf('    while (true) {', source.indexOf('    requestImmediateSaveImpl = async (options) =>')), source.indexOf('\n}\n', source.indexOf('    requestImmediateSaveImpl = async (options) =>')))
    let release: () => void
    let started: () => void
    const firstStarted = new Promise<void>(r => { started = r })
    const persisted: any[] = []
    const persist = vi.fn(async changes => {
        persisted.push(structuredClone(changes))
        if (persisted.length === 1) { started(); await new Promise<void>(r => { release = r }) }
        return 'saved'
    })
    const stop = new Error('test loop reached idle')
    const sleep = vi.fn(async ms => { if (ms === 200 || persisted.length > 3) throw stop })
    const api = run(`
        let changed = false, saveInFlight = null, savetrys = 0, saveRetryDelay = 500;
        let requeueChatSaveImpl, requestImmediateSaveImpl;
        const pendingChatSaveRetries = [], saving = { state: false };
        const changeTracker = { character: ['selected'], chat: [['selected', 'initial']], root: false, botPreset: false, modules: false, plugins: false };
        ${extract('hasTrackedChanges')}
        ${extract('takeTrackedChanges')}
        ${extract('requeueTrackedChanges')}
        ${extract('requeueChatSave')}
        ${extract('triggerSave')}
        ${registration}
        ${immediate}
        return { immediate: () => requestImmediateSaveImpl(), requeue: () => {
            if (kind === 'chat') requeueChatSave('background', 'completed');
            else if (kind === 'character') { changeTracker.character.push('background'); changed = true; }
            else { changeTracker.root = true; changed = true; }
        }, loop: async () => { ${loop} }, pending: () => hasTrackedChanges(changeTracker) };
    `, { persistTrackedChanges: persist, safeStructuredClone: structuredClone, sleep, kind,
        requiresFullEncoderReload: { state: false }, tick: async () => {}, alertError: vi.fn(), console })
    const immediateSave = api.immediate()
    await firstStarted
    api.requeue()
    const loopRun = api.loop().catch(error => { if (error !== stop) throw error })
    await Promise.resolve()
    release()
    await Promise.all([immediateSave, loopRun])
    expect(persisted).toHaveLength(2)
    if (kind === 'chat') expect(persisted[1].chat).toEqual([['background', 'completed']])
    else if (kind === 'character') expect(persisted[1].character).toEqual(['background'])
    else expect(persisted[1].root).toBe(true)
    expect(api.pending()).toBe(false)
})


test.each(['download', 'decode'])('failed rebase %s preserves the pre-conflict ETag', async phase => {
    let etag = 'our-synced-revision'
    const offline = new Error('interrupted rebase')
    const forageStorage = {
        getDbEtag: () => etag,
        setDbEtag: (v: string) => { etag = v },
        getItem: async () => {
            // Headers can arrive before a response body fails.
            etag = 'foreign-revision'
            if (phase === 'download') throw offline
            return new Uint8Array([1])
        },
    }
    const rebase = run(`${extract('rebaseTrackedLocalChangesOnLatestServerDb')}; return rebaseTrackedLocalChangesOnLatestServerDb;`, {
        forageStorage, decodeRisuSave: async () => { throw offline },
    })
    await expect(rebase('foreign-revision', { characters: [] }, { character: [], chat: [] })).rejects.toBe(offline)
    expect(etag).toBe('our-synced-revision')
})
