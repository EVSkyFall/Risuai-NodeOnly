import { afterEach, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import nodeCrypto from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'

const source = fs.readFileSync(new URL('./server.cjs', import.meta.url), 'utf8')
const writeStart = source.indexOf("app.post('/api/write'")
const hydrateStart = source.indexOf('                    let fullDb = hydrateDatabaseForDisk(incomingDb);', writeStart)
const repairStart = source.lastIndexOf('                    await repairStubFlagLossChats(incomingDb);', hydrateStart)
const writeBoundary = source.slice(repairStart > writeStart ? repairStart : hydrateStart, source.indexOf('// Same boundary for lazy asset', hydrateStart))
const ast = ts.createSourceFile('server.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
function functions(names: string[]) {
    return ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? '')).map(n => n.getText(ast)).join('\n')
}
function fixture() {
    const disk = { characters: [{ chaId: 'char', chats: [{ id: 'chat', name: 'original', message: [{ data: 'disk message' }] }] }] }
    const kvSet = vi.fn((_key, data) => { Object.assign(disk, JSON.parse(data.toString())) })
    const logger = { error: vi.fn(), warn: vi.fn() }
    const ctx = vm.createContext({ Buffer, Map, Array, Date, performance, AsyncLocalStorage, setTimeout, clearTimeout, logger, kvSet,
        kvGet: vi.fn(() => Buffer.from(JSON.stringify(disk))),
        encodeRisuSaveLegacy: (x: any) => Buffer.from(JSON.stringify(x)),
        decodeRisuSave: async (b: Buffer) => JSON.parse(b.toString()), normalizeJSON: (x: any) => x,
        ensureChatStore: async () => {}, carryPendingActivations: () => {}, archivedStubsOf: () => [], pendingActivations: new Map(),
        findArchiveConflicts: () => null, databaseHashDiagnostics: () => ({}),
        findUnmergedArchivedChats: () => [], restoreArchivedChatsForDisk: async (db: any) => db,
        nodeCrypto: { randomUUID: () => 'assigned-id' },
        createBackupAndRotate: vi.fn(), clearPersistFailure: vi.fn(), recordPersistFailure: vi.fn(),
        writeFileSync: vi.fn(), SESSION_FILE: 'synthetic-sessions',
    })
    vm.runInContext(`
        const DB_HEX_KEY = 'db', SAVE_INTERVAL = 5000;
        let storageOperationQueue = Promise.resolve();
        const storageOperationContext = new AsyncLocalStorage();
        const CHAT_CONTENT_PERSIST_SOURCE = 'chat-content', CHAT_CONTENT_BACKUP_SOURCE = 'chat-content-backup';
        let dbDirty = false, dbRetryDelay = 5000, saveTimers = {}, dbCache = {};
        let fullChatStore = new Map(), dbEtag, lastDbPersistMs = null;
        const computeBufferEtag = () => 'synthetic-etag';
        const sessions = new Map(); let sessionSaveTimer, sessionRetryDelay = 5000;
        ${functions(['queueStorageOperation', 'writeStorageValue', 'chatToStub', 'scheduleChatContentPersist', 'retryDatabasePersist', 'flushPendingDb', 'scheduleDatabasePersist',
            'persistChatContentNow', 'persistDbCacheWithChats', 'recordChatContentPersistError', 'scheduleDatabaseSave',
            'initChatStore', 'findStubFlagLossChats', 'repairStubFlagLossChats', 'reassembleFullDb', 'mergeChatStubWithFullChat', 'saveSessions', 'checkAuth'])}
        function hydrateDatabaseForDisk(db) { return reassembleFullDb(db); }
        function stripDatabaseForClient(db) { return db; }
        async function writeBoundary(incomingDb, res) { ${writeBoundary}; return fullDb; }
        globalThis.api = { queueStorageOperation, persistChatContentNow, repairStubFlagLossChats, chatToStub, scheduleDatabaseSave, writeBoundary, scheduleChatContentPersist, scheduleDatabasePersist, flushPendingDb, persistDbCacheWithChats, saveSessions, checkAuth,
            setCache: value => dbCache.db = value, cache: () => dbCache.db,
            store: () => fullChatStore, setStore: value => fullChatStore = value, dirty: () => dbDirty,
            markDirty: () => dbDirty = true,
            cancelTimer: () => { clearTimeout(saveTimers.db); delete saveTimers.db; },
            sessions };
    `, ctx)
    return { ctx, api: (ctx as any).api, disk, kvSet, logger }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

test.each(['scheduleChatContentPersist', 'scheduleDatabasePersist', 'scheduleDatabaseSave'])('cause1: %s retries SQLITE_FULL without another edit', async method => {
    vi.useFakeTimers()
    const { api, disk, kvSet } = fixture()
    api.setCache({ ...structuredClone(disk), name: 'unsaved' })
    kvSet.mockImplementationOnce(() => { throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' }) })
    api[method]()
    await vi.advanceTimersByTimeAsync(5000)
    expect(api.dirty()).toBe(true)
    expect(kvSet).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(kvSet).toHaveBeenCalledTimes(2)
    expect(disk).toMatchObject({ name: 'unsaved' })
    expect(api.dirty()).toBe(false)
})

test('cause1: dirty flush persists even when its timer is gone', async () => {
    vi.useFakeTimers()
    const { api, disk, kvSet } = fixture()
    api.setCache({ ...structuredClone(disk), name: 'flush me' })
    api.scheduleChatContentPersist()
    api.cancelTimer()
    await api.flushPendingDb()
    expect(kvSet).toHaveBeenCalledTimes(1)
    expect(disk).toMatchObject({ name: 'flush me' })
})

test('cause1: retries remain pending beyond five failures with a ceiling interval', async () => {
    vi.useFakeTimers()
    const { api, disk, kvSet } = fixture()
    api.setCache(structuredClone(disk))
    kvSet.mockImplementation(() => { throw new Error('SQLITE_FULL') })
    api.scheduleChatContentPersist()
    for (const delay of [5000, 5000, 10000, 20000, 40000, 60000, 60000, 60000]) await vi.advanceTimersByTimeAsync(delay)
    expect(kvSet).toHaveBeenCalledTimes(8)
    expect(api.dirty()).toBe(true)
    kvSet.mockImplementation(() => {})
    await vi.advanceTimersByTimeAsync(60000)
    expect(api.dirty()).toBe(false)
})

test.each(['store', 'disk', 'empty'])('cause2: repairs %s chat and retains dirty metadata cache', async kind => {
    const { api, disk } = fixture()
    const cache = { title: 'unsaved metadata', characters: [{ chaId: 'char', chats: [{ id: 'chat', name: 'renamed' }] }] }
    api.setCache(cache)
    if (kind === 'store') api.setStore(new Map([['char', new Map([['chat', { id: 'chat', message: [{ data: 'RAM message' }] }]])]]))
    if (kind === 'empty') disk.characters[0].chats = []
    await api.persistDbCacheWithChats('db', 'database/database.bin')
    expect(api.cache()).toBe(cache)
    expect(disk).toMatchObject({ title: 'unsaved metadata' })
    expect(disk.characters[0].chats[0].message).toEqual(kind === 'empty' ? [] : [{ data: kind === 'store' ? 'RAM message' : 'disk message' }])
})

test('cause2: failed disk repair retains cache and dirty state for recovery', async () => {
    const { api, disk, ctx, kvSet } = fixture()
    const cache = { characters: [{ chaId: 'char', chats: [{ id: 'chat' }] }] }
    api.setCache(cache); api.markDirty()
    ;(ctx.kvGet as any).mockImplementationOnce(() => { throw new Error('read failed') })
    await expect(api.persistDbCacheWithChats('db', 'database/database.bin')).rejects.toThrow()
    expect(api.cache()).toBe(cache)
    expect(api.dirty()).toBe(true)
    expect(kvSet).not.toHaveBeenCalled()
    await api.persistDbCacheWithChats('db', 'database/database.bin')
    expect(disk.characters[0].chats[0].message[0].data).toBe('disk message')
})

test('cause8: session write retries the latest map on timer and next change', async () => {
    vi.useFakeTimers()
    const { api, ctx, logger } = fixture()
    const write = ctx.writeFileSync as any
    write.mockImplementationOnce(() => { throw new Error('disk full') })
    api.sessions.set('synthetic-a', 123)
    api.saveSessions()
    expect(logger.error).toHaveBeenCalled()
    api.sessions.set('synthetic-b', 456)
    await vi.advanceTimersByTimeAsync(5000)
    expect(write).toHaveBeenCalledTimes(2)
    expect(JSON.parse(write.mock.calls[1][1])).toEqual([['synthetic-a', 123], ['synthetic-b', 456]])
    write.mockImplementationOnce(() => { throw new Error('again') })
    api.saveSessions()
    api.sessions.set('synthetic-c', 789)
    api.saveSessions()
    await vi.advanceTimersByTimeAsync(60000)
    expect(write).toHaveBeenCalledTimes(4)
})

test('cause9: status-only missing-header probe does not log', async () => {
    const { api, ctx } = fixture()
    const log = vi.fn()
    ctx.console = { log }
    await expect(api.checkAuth({ headers: {} }, {}, true)).resolves.toBe(false)
    expect(log).not.toHaveBeenCalled()
})


test('cause2-write: full write boundary repairs from disk when RAM lacks the payload', async () => {
    const { api } = fixture()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
    const incoming = { characters: [{ chaId: 'char', chats: [{ id: 'chat', name: 'rename' }] }] }
    const full = await api.writeBoundary(incoming, res)
    expect(res.status).not.toHaveBeenCalled()
    expect(full.characters[0].chats[0].message).toEqual([{ data: 'disk message' }])
    expect(full.characters[0].chats[0].name).toBe('rename')
})

test('cause9-cookie: test_auth accepts the session before probing a missing JWT', async () => {
    const route = ast.statements.find(n => n.getText(ast).startsWith("app.get('/api/test_auth'"))!.getText(ast)
    let handler: any
    const checkAuth = vi.fn(async () => false)
    const sessions = new Map([['synthetic-session', Date.now() + 60000]])
    vm.runInNewContext(`${functions(['parseSessionCookie', 'hasValidSession'])}\n${route}`, {
        app: { get: (_path, fn) => { handler = fn } }, password: 'synthetic', sessions, Date, checkAuth,
        createServerJwt: () => 'synthetic-jwt',
    })
    const send = vi.fn()
    await handler({ headers: { cookie: 'risu-session=synthetic-session' } }, { send })
    expect(send).toHaveBeenCalledWith({ status: 'success', token: 'synthetic-jwt' })
    expect(checkAuth).not.toHaveBeenCalled()
})

test('round2-A: failed flush logs and leaves retry without rejecting reads/exports', async () => {
    vi.useFakeTimers()
    const { api, disk, kvSet, logger } = fixture()
    api.setCache({ ...structuredClone(disk), title: 'RAM edit' })
    api.scheduleDatabasePersist()
    kvSet.mockImplementationOnce(() => { throw new Error('SQLITE_FULL') })
    await expect(api.flushPendingDb()).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalled()
    expect(api.dirty()).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(disk).toMatchObject({ title: 'RAM edit' })
})

test('round2-B: retry persist retains ACKed payload before its stub arrives', async () => {
    vi.useFakeTimers()
    const { api, disk, kvSet } = fixture()
    api.setCache(structuredClone(disk))
    api.setStore(new Map([['char', new Map([['chat', disk.characters[0].chats[0]]])]]))
    kvSet.mockImplementationOnce(() => { throw new Error('SQLITE_FULL') })
    api.scheduleDatabasePersist()
    await vi.advanceTimersByTimeAsync(5000)
    api.store().get('char').set('new', { id: 'new', message: [{ data: 'ACKed new chat' }] })
    api.scheduleChatContentPersist()
    await vi.advanceTimersByTimeAsync(5000)
    expect(api.store().get('char').get('new')?.message[0].data).toBe('ACKed new chat')
    api.cache().characters[0].chats.push({ id: 'new', _stub: true })
    api.scheduleDatabasePersist()
    await api.flushPendingDb()
    expect(disk.characters[0].chats[1].message[0].data).toBe('ACKed new chat')
})

test.each(['idless', 'identified', 'empty'])('round2-G: idless repair preserves positional disk content (%s)', async kind => {
    const { api, disk } = fixture()
    if (kind !== 'identified') delete disk.characters[0].chats[0].id
    if (kind === 'empty') disk.characters[0].chats = []
    api.setCache({ characters: [{ chaId: 'other', chats: [] }, { chaId: 'char', chats: [{ name: 'rename' }] }] })
    await api.persistDbCacheWithChats('db', 'database/database.bin')
    expect(disk.characters[1].chats[0].message).toEqual(kind === 'empty' ? [] : [{ data: 'disk message' }])
    if (kind === 'identified') expect(disk.characters[1].chats[0].id).toBe('chat')
})

test('round2-H: MCP persist uses latest patch cache, never its scheduling snapshot', async () => {
    vi.useFakeTimers()
    const { api, disk } = fixture()
    api.setCache({ ...structuredClone(disk), name: 'MCP edit' })
    api.scheduleDatabaseSave()
    api.setCache({ ...structuredClone(disk), name: 'newer patch' })
    api.scheduleDatabasePersist()
    await vi.advanceTimersByTimeAsync(5000)
    expect(disk).toMatchObject({ name: 'newer patch' })
    expect(api.dirty()).toBe(false)
})

test.each(['patch', 'chat'])('round2-J: disk repair decode yield preserves concurrent %s ACK', async kind => {
    vi.useFakeTimers()
    const { api, disk, ctx } = fixture()
    api.setCache({ characters: [{ chaId: 'char', chats: [{ id: 'chat' }] }] })
    api.markDirty()
    let release: () => void
    ctx.decodeRisuSave = async (bytes: Buffer) => {
        const decoded = JSON.parse(bytes.toString())
        await new Promise<void>(r => { release = r })
        return decoded
    }
    const pending = api.flushPendingDb()
    await vi.advanceTimersByTimeAsync(0)
    if (kind === 'patch') api.setCache({ ...structuredClone(disk), title: 'newer patch' })
    else api.setStore(new Map([['char', new Map([['chat', { id: 'chat', message: [{ data: 'newer ACK' }] }]])]]))
    api.scheduleDatabasePersist()
    release()
    await pending
    if (kind === 'patch') expect(disk).toMatchObject({ title: 'newer patch' })
    else expect(disk.characters[0].chats[0].message[0].data).toBe('newer ACK')
    expect(api.dirty()).toBe(false)
})

test('round2-F: only expired auth rejection emits retry provenance header', async () => {
    const { api, ctx } = fixture()
    ctx.console = { log: vi.fn() }
    const res = { status: vi.fn().mockReturnThis(), send: vi.fn(), setHeader: vi.fn() }
    const token = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.synthetic`
    expect(await api.checkAuth({ headers: { 'risu-auth': token } }, res)).toBe(false)
    expect(res.setHeader).toHaveBeenCalledWith('x-risu-auth-error', 'token-expired')
    res.setHeader.mockClear()
    await api.checkAuth({ headers: {} }, res)
    expect(res.setHeader).not.toHaveBeenCalled()
    await api.checkAuth({ headers: { 'risu-auth': token } }, res, true)
    expect(res.setHeader).not.toHaveBeenCalled()
})

test('round2-J-cold: cold flush adopts cache populated while disk decode yields', async () => {
    vi.useFakeTimers()
    const { api, disk, ctx } = fixture()
    api.markDirty()
    let release: () => void
    ctx.decodeRisuSave = async (bytes: Buffer) => {
        const decoded = JSON.parse(bytes.toString())
        await new Promise<void>(r => { release = r })
        return decoded
    }
    const pending = api.flushPendingDb()
    await vi.advanceTimersByTimeAsync(0)
    api.setCache({ ...structuredClone(disk), title: 'new warm cache' })
    api.scheduleDatabasePersist()
    release()
    await pending
    expect(disk).toMatchObject({ title: 'new warm cache' })
    expect(api.dirty()).toBe(false)
})

test('round2-A-read: warm cache read does not depend on reading disk', async () => {
    const { api, disk, ctx } = fixture()
    api.setCache({ ...structuredClone(disk), title: 'only RAM' })
    ctx.kvGet = vi.fn(() => { throw new Error('disk read unavailable') })
    const key = Buffer.from('database/database.bin').toString('hex')
    let handler: any
    ctx.app = { get: (_path, fn) => { handler = fn } }
    ctx.normalizeFilePathHeader = (x: any) => x
    ctx.isHex = () => true
    vm.runInContext(`checkAuth = async () => true; dbCache['${key}'] = dbCache.db;
        ${ast.statements.find(n => n.getText(ast).startsWith("app.get('/api/read'"))!.getText(ast)}`, ctx)
    const res = { status: vi.fn().mockReturnThis(), send: vi.fn(), setHeader: vi.fn() }
    const next = vi.fn()
    await handler({ headers: { 'file-path': key } }, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(JSON.parse(res.send.mock.calls[0][0].toString())).toMatchObject({ title: 'only RAM' })
    expect(ctx.kvGet).not.toHaveBeenCalled()
})


test.each(['idless', 'identified', 'empty'])('round3-1: repaired %s cache stays stub-only through a later ACK and hash roundtrip', async kind => {
    const { api, disk } = fixture()
    if (kind !== 'identified') delete disk.characters[0].chats[0].id
    if (kind === 'empty') disk.characters[0].chats = []
    api.setCache({ characters: [{ chaId: 'char', chats: [{ name: 'rename', note: 'stray payload' }] }] })
    await api.persistDbCacheWithChats('db', 'database/database.bin')
    const stub = api.cache().characters[0].chats[0]
    expect(stub).toEqual({ id: kind === 'identified' ? 'chat' : 'assigned-id', name: 'rename', _stub: true })
    expect(api.store().get('char').get(stub.id).message).toEqual(kind === 'empty' ? [] : [{ data: 'disk message' }])
    api.store().get('char').set(stub.id, { id: stub.id, message: [{ data: 'newer ACK' }] })
    api.markDirty()
    await api.flushPendingDb()
    expect(disk.characters[0].chats[0].message).toEqual([{ data: 'newer ACK' }])
    const clientView = { ...disk, characters: disk.characters.map(c => ({ ...c, chats: c.chats.map(api.chatToStub) })) }
    const hash = value => nodeCrypto.createHash('md5').update(JSON.stringify(value)).digest('hex')
    expect(hash(api.cache())).toBe(hash(clientView))
    expect(api.cache().characters[0].chats[0]).toEqual(stub)
})

function installWriteRoute(ctx: any) {
    let handler: any
    ctx.app = { post: (_path, fn) => { handler = fn } }
    ctx.normalizeFilePathHeader = x => x
    ctx.isHex = () => true
    ctx.findAssetManifestConflicts = () => []
    ctx.loadDbCacheIfMissing = async () => false
    ctx.pluginStorage = { migrateFromDb: () => ({ migrated: false }) }
    ctx.computeDatabaseEtagFromObject = () => 'new-etag'
    vm.runInContext(`checkAuth = async () => true; ${ast.statements.find(n => n.getText(ast).startsWith("app.post('/api/write'"))!.getText(ast)}`, ctx)
    return async (db: any) => {
        const response = { status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn() }
        const next = vi.fn()
        await handler({ headers: { 'file-path': Buffer.from('database/database.bin').toString('hex') }, body: Buffer.from(JSON.stringify(db)) }, response, next)
        expect(next).not.toHaveBeenCalled()
        expect(response.status).not.toHaveBeenCalled()
        expect(response.send).toHaveBeenCalledWith(expect.objectContaining({ success: true }))
    }
}

test.each(['cold', 'warm'])('round3-2: %s flush and api/write cannot overwrite the newer write with an older decode', async mode => {
    vi.useFakeTimers()
    const { api, disk, ctx } = fixture()
    if (mode === 'warm') api.setCache({ characters: [{ chaId: 'char', chats: [{ id: 'chat' }] }] })
    api.markDirty()
    let release: () => void
    let announce: () => void
    const decoding = new Promise<void>(r => { announce = r })
    const decode = ctx.decodeRisuSave
    let first = true
    ctx.decodeRisuSave = async bytes => {
        const result = await decode(bytes)
        if (first) { first = false; announce(); await new Promise<void>(r => { release = r }) }
        return result
    }
    const flush = api.flushPendingDb()
    await decoding
    const write = installWriteRoute(ctx)({ characters: [{ chaId: 'char', chats: [{ id: 'chat', message: [{ data: 'new write' }] }] }], title: 'new write' })
    await vi.advanceTimersByTimeAsync(0)
    release()
    await Promise.all([flush, write])
    expect(disk).toMatchObject({ title: 'new write' })
    expect(disk.characters[0].chats[0].message).toEqual([{ data: 'new write' }])
    expect(api.cache()).toMatchObject({ title: 'new write' })
    expect(api.dirty()).toBe(false)
})

test('round3-2: nested flush joins its queue context without deadlock and detached descendants enqueue', async () => {
    const { api, disk } = fixture()
    api.setCache(structuredClone(disk)); api.markDirty()
    let detached: Promise<any>
    let fired: () => void
    const timerFired = new Promise<void>(r => { fired = r })
    await api.queueStorageOperation(async () => {
        await api.flushPendingDb()
        setTimeout(() => { detached = api.persistChatContentNow(); fired() }, 0)
    })
    let release: () => void
    const blocking = api.queueStorageOperation(() => new Promise<void>(r => { release = r }))
    await Promise.resolve()
    let done = false
    await timerFired
    detached.then(() => { done = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(done).toBe(false)
    release()
    await Promise.all([blocking, detached])
})

test('round3-3: disappeared cache reports no persist and retains dirty state', async () => {
    const { api, disk, ctx, kvSet } = fixture()
    api.setCache(structuredClone(disk)); api.markDirty()
    ctx.ensureChatStore = async () => { api.setCache(undefined) }
    expect(await api.persistChatContentNow()).toMatchObject({ didPersist: false })
    expect(api.dirty()).toBe(true)
    expect(kvSet).not.toHaveBeenCalled()
})


test('round3-1: positional ID prefers newer RAM payload and preserves explicit metadata clears', async () => {
    const { api, disk } = fixture()
    api.setStore(new Map([['char', new Map([['chat', { id: 'chat', folderId: 'old', modules: ['old'], message: [{ data: 'ACKed RAM' }] }]])]]))
    api.setCache({ characters: [{ chaId: 'char', chats: [{ name: 'renamed', folderId: null, modules: null }] }] })
    await api.persistDbCacheWithChats('db', 'database/database.bin')
    expect(api.cache().characters[0].chats[0]).toEqual({ id: 'chat', name: 'renamed', _stub: true, folderId: null, modules: null })
    expect(disk.characters[0].chats[0]).toMatchObject({ message: [{ data: 'ACKed RAM' }], folderId: null, modules: null })
})

test('round3-2: flush waits for an in-flight api/write before reading the cold disk blob', async () => {
    vi.useFakeTimers()
    const { api, disk, ctx } = fixture()
    let release: () => void
    let announce: () => void
    const decoding = new Promise<void>(r => { announce = r })
    const decode = ctx.decodeRisuSave
    let first = true
    ctx.decodeRisuSave = async bytes => {
        const result = await decode(bytes)
        if (first) { first = false; announce(); await new Promise<void>(r => { release = r }) }
        return result
    }
    const write = installWriteRoute(ctx)({ characters: [{ chaId: 'char', chats: [{ id: 'chat', message: [{ data: 'new write' }] }] }], title: 'new write' })
    await decoding
    api.markDirty()
    const flush = api.flushPendingDb()
    await vi.advanceTimersByTimeAsync(0)
    expect(ctx.kvGet).not.toHaveBeenCalled()
    release()
    await Promise.all([write, flush])
    expect(disk.characters[0].chats[0].message).toEqual([{ data: 'new write' }])
    expect(api.dirty()).toBe(false)
})

test('round3-3: missing cache and disk retain dirty state and retry after a blob becomes available', async () => {
    vi.useFakeTimers()
    const { api, ctx, kvSet } = fixture()
    const read = ctx.kvGet
    ctx.kvGet = () => undefined
    api.markDirty()
    await api.flushPendingDb()
    expect(api.dirty()).toBe(true)
    expect(kvSet).not.toHaveBeenCalled()
    ctx.kvGet = read
    await vi.advanceTimersByTimeAsync(5000)
    expect(api.dirty()).toBe(false)
    expect(kvSet).toHaveBeenCalledTimes(1)
})
