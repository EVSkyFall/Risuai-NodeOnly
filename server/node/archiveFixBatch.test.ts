import { expect, test, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

// Execute production functions and handlers without booting a second server.
const source = fs.readFileSync('server/node/server.cjs', 'utf8')
const ast = ts.createSourceFile('server.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
function functionText(name: string) {
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name)
    if (!node) throw new Error(`No function ${name}`)
    return node.getText(ast)
}
function routeText(method: string, route: string) {
    for (const n of ast.statements) {
        if (!ts.isExpressionStatement(n) || !ts.isCallExpression(n.expression)) continue
        const call = n.expression
        if (call.expression.getText(ast) === `app.${method}` && call.arguments[0]?.getText(ast) === `'${route}'`) return call.arguments.at(-1)!.getText(ast)
    }
    throw new Error(`No route ${route}`)
}
function harness(deps: Record<string, any>, names: string[] = []) {
    const ctx = vm.createContext({ Set, Map, Date, Object, Array, Buffer, console, ...deps })
    for (const name of names) vm.runInContext(functionText(name), ctx)
    return { ctx, fn: (name: string) => vm.runInContext(name, ctx), route: (method: string, route: string) => vm.runInContext(`(${routeText(method, route)})`, ctx) }
}
const archivedStubsOf = (db: any) => db?.nodeOnlyArchivedCharacters ?? []
const archiveRowId = (id: string, at: number) => `${id}/${at}`
const parseArchiveRowKey = (key: string, prefix: string) => {
    const [chaId, at] = key.slice(prefix.length).split('/')
    return at ? { chaId, archivedAt: Number(at), rowId: `${chaId}/${at}` } : null
}
const logger = () => ({ warn: vi.fn(), info: vi.fn() })
const referenceNames = ['referencedArchiveRowIds', 'retainedArchiveRowIds', 'listOrphanArchiveRows']

test.each([false, true])('S1: stats never decode snapshot blobs, archive rows present=%s', async present => {
    const scan = vi.fn(() => { throw new Error('stats must not scan snapshots') })
    const json = vi.fn(), next = vi.fn()
    const h = harness({
        checkAuth: async () => true, process, path, statSafe: () => null, diskFreeStat: async () => ({}),
        backupsDir: 'backups', DEFAULT_BACKUPS_DIR: 'backups', fs: { readdir: async () => [] },
        sqliteDb: { pragma: () => 0, prepare: () => ({ get: () => ({ c: 0, b: 0, s: 0 }) }) },
        DB_BLOB_KEY: 'database/database.bin', DB_BACKUP_PREFIX: 'database/dbbackup-',
        kvSize: () => 0, reclaimableChunkBytes: () => 0, isDbBlobChunked: () => false,
        kvList: prefix => prefix === 'archive/' && present ? ['archive/c/1000'] : [],
        kvListWithSizes: () => [], snapshotPluginSizer: () => () => ({ bytes: 0 }),
        assetFileStore: { list: async () => [], stats: async () => ({ assetFileBytes: 0, fileSize: 0 }) },
        ASSET_PREFIXES: ['assets/', 'archive/'], ARCHIVE_PREFIX: 'archive/',
        dbCache: { db: { characters: [] } }, DB_HEX_KEY: 'db', archivedStubsOf,
        ASSET_SWEEP_DISABLED_REASON: 'disabled', estimateServerBackupSize: async () => 0,
        sumInlayFsBytes: async () => 0, dbEtag: 'etag', logger: logger(), listOrphanArchiveRows: scan,
        decodeRisuSave: scan, kvGet: scan,
    })
    await h.route('get', '/api/db/stats')({}, { json }, next)
    expect(next).not.toHaveBeenCalled()
    expect(json.mock.calls[0][0].archiveOrphan).toEqual({ available: !present, count: 0, totalSize: 0 })
    expect(scan).not.toHaveBeenCalled()
})

test('S1: empty archive skips retained snapshot and migration scans even with stale metadata', async () => {
    const snapshots = vi.fn(() => { throw new Error('no scan needed') })
    const h = harness({ kvList: p => p === 'archive-meta/' ? ['archive-meta/c/1'] : [], ARCHIVE_PREFIX: 'archive/', ARCHIVE_META_PREFIX: 'archive-meta/', listSnapshotKeys: snapshots }, ['listOrphanArchiveRows'])
    expect(await h.fn('listOrphanArchiveRows')({})).toEqual({ payloads: [], metas: [], bytes: 0 })
    expect(snapshots).not.toHaveBeenCalled()
})

test('S2: one missing and one undecodable payload keep only their stubs and do not block export', async () => {
    const log = logger(), warnings: string[] = []
    const stubs = ['good', 'gone', 'bad'].map(chaId => ({ chaId, archivedAt: 1 }))
    const h = harness({ archivedStubsOf, isValidArchivedAt: Number.isFinite, logger: log,
        decodeArchivePayload: async id => { if (id === 'bad') throw new Error('corrupt'); return id === 'gone' ? null : { payload: { character: { chaId: id, chats: [] } } } },
    }, ['inlineArchivedCharacters'])
    const db = { characters: [{ chaId: 'live' }], nodeOnlyArchivedCharacters: stubs }
    await expect(h.fn('inlineArchivedCharacters')(db, warnings)).resolves.toBe(db)
    expect(db.characters.map(c => c.chaId)).toEqual(['live', 'good'])
    expect(db.nodeOnlyArchivedCharacters.map(c => c.chaId)).toEqual(['gone', 'bad'])
    expect(log.warn).toHaveBeenCalledOnce()
    expect(warnings[0]).toContain('gone, bad')
})

test('S2: explicit deletion uses the same live/snapshot/migration/pending reference union as purge', async () => {
    const stubs = (at: number) => ({ nodeOnlyArchivedCharacters: [{ chaId: 'c', archivedAt: at }] })
    const keys = [1, 2, 3, 4, 5].map(at => `archive/c/${at}`)
    const metas = keys.map(k => k.replace('archive/', 'archive-meta/'))
    const deleted: string[] = [], json = vi.fn(), log = logger()
    const db = { characters: [], ...stubs(1) }
    const h = harness({ archivedStubsOf, archiveRowId, parseArchiveRowKey, pendingActivations: new Map([['c', 4]]),
        listSnapshotKeys: () => ['snapshot'], kvList: p => p === 'migration-backup/' ? ['migration'] : p.startsWith('archive-meta/') ? metas : keys,
        decodeRisuSave: async value => value === 'snapshot' ? stubs(2) : stubs(3), kvGet: x => x,
        logger: log, ARCHIVE_PREFIX: 'archive/', ARCHIVE_META_PREFIX: 'archive-meta/', ARCHIVE_ORPHAN_GRACE_MS: 0,
        checkAuth: async () => true, isArchivableChaId: () => true, queueStorageOperation: fn => fn(), flushPendingDb: async () => {},
        loadDbCacheIfMissing: async () => true, dbCache: { db }, DB_HEX_KEY: 'db', listArchivePayloadKeysFor: () => keys,
        kvSize: () => 10, kvDel: k => deleted.push(k), sqliteDb: { transaction: fn => fn },
    }, referenceNames)
    const orphan = await h.fn('listOrphanArchiveRows')(db)
    expect(orphan.payloads.map(p => p.key)).toEqual(['archive/c/5'])
    await h.route('delete', '/api/characters/:chaId/archive')({ params: { chaId: 'c' } }, { json }, e => { throw e })
    expect(deleted).toEqual(['archive/c/5', 'archive-meta/c/5'])
    expect(json.mock.calls[0][0]).toMatchObject({ ok: true, deleted: 1, metas: 1 })
})

test('S3: dormant sweep includes live manifests and archives, keeps archived remotes and uses exported row API', async () => {
    const db = { characters: [{ chaId: 'live' }], nodeOnlyArchivedCharacters: [{ chaId: 'cold' }] }
    const live = vi.fn((refs, value) => { expect(value).toBe(db); refs.add('live.png') })
    const archive = vi.fn(refs => refs.add('cold.png'))
    const removed = vi.fn(), del = vi.fn()
    const rows = ['remotes/cold.local.bin', 'remotes/cold.local.bin.meta', 'remotes/meta-only.local.bin.meta'].map(key => ({ key, size: 10 }))
    db.nodeOnlyArchivedCharacters.push({ chaId: 'meta-only' })
    const h = harness({ ASSET_SWEEP_DISABLED_REASON: '', flushPendingDb: async () => {}, kvGet: () => 'db', DB_BLOB_KEY: 'database/database.bin',
        decodeRisuSave: async () => db, buildUncleanableSet: () => new Set(), addLiveManifestRefs: live, addArchivedCharacterRefs: archive,
        assetFileStore: { list: async () => ['live.png', 'cold.png'].map(k => ({ key: `assets/${k}`, size: 1 })), legacyBatch: async fn => fn({ remove: removed }) },
        collectPluginStorageAssetRefs: () => [], statsBasename: k => k.split('/').at(-1), archivedStubsOf,
        kvListWithSizes: () => rows, kvGetUpdatedAt: () => 1, AUTO_SWEEP_GRACE_MS: 0, kvDel: del,
        decodeRemoteMetaLastUsed: () => 0,
    }, ['computeAssetSweep'])
    expect(await h.fn('computeAssetSweep')({ includeAssets: true, includeRemotes: true })).toMatchObject({ assetsDeleted: 0, remotesDeleted: 0 })
    expect(live).toHaveBeenCalledOnce(); expect(archive).toHaveBeenCalledOnce()
    expect(removed).not.toHaveBeenCalled(); expect(del).not.toHaveBeenCalled()
    h.ctx.ASSET_SWEEP_DISABLED_REASON = 'still disabled'
    expect(await h.fn('computeAssetSweep')({ includeAssets: true })).toMatchObject({ disabled: true })
})

test('S4: corrupt rows do not block restoration; missing keys are cached until a new row appears', async () => {
    const keys = ['archive/c/1', 'archive/c/2']
    const decode = vi.fn(async (_id, at) => {
        if (at === 2) throw new Error('corrupt')
        return { payload: { character: { chats: [{ id: at === 3 ? 'missing' : 'found', message: [{ data: 'recovered' }] }] } } }
    })
    const h = harness({ listArchivePayloadKeysFor: () => keys, parseArchiveRowKey, ARCHIVE_PREFIX: 'archive/', decodeArchivePayload: decode,
        missingArchiveChatRows: new Map(), mergeChatStubWithFullChat: (stub, full) => ({ ...full, ...stub, message: full.message }), logger: logger(),
    }, ['restoreUnmergedArchivedChats'])
    const db = { characters: [{ chaId: 'c', chats: [{ id: 'found', _stub: true }, { id: 'missing', _stub: true }] }] }
    const first = await h.fn('restoreUnmergedArchivedChats')(db)
    expect(first.restored).toEqual(['c/found'])
    expect(first.unresolved).toEqual(['c/missing'])
    decode.mockClear()
    await h.fn('restoreUnmergedArchivedChats')(first.db)
    expect(decode).not.toHaveBeenCalled()
    keys.push('archive/c/3')
    const next = await h.fn('restoreUnmergedArchivedChats')(first.db)
    expect(next.restored).toEqual(['c/missing'])
})

const coldHeader = '\uEF01COLDSTORAGE\uEF01'
function inlayHarness(read: any, extra: Record<string, any> = {}) {
    return harness({ COLD_STORAGE_HEADER: coldHeader, INLAY_REF_RE: /\{\{(?:inlay|inlayed|inlayeddata)::(.+?)\}\}/g,
        readColdStorageJsonEntry: read, ...extra,
    }, ['isColdStorageChat', 'addInlayRefCounts'])
}
test.each([true, false])('S6: cold chats count inlays from array and object cold bodies (array=%s)', array => {
    const messages = [{ data: '{{inlay::cold}} {{inlayed::cold}}' }]
    const h = inlayHarness(() => ({ coldData: array ? messages : { message: messages } }))
    const counts = Object.create(null)
    expect(h.fn('addInlayRefCounts')(counts, [{ message: [{ data: coldHeader + 'key' }] }])).toBe(1)
    expect(counts).toEqual({ cold: 2 })
})

test.each(['missing', 'corrupt'])('S6: unreadable cold chat fails the entire deletion-reference request (%s)', kind => {
    const h = inlayHarness(() => { if (kind === 'corrupt') throw new Error('bad gzip'); return null })
    expect(() => h.fn('addInlayRefCounts')({}, [{ message: [{ data: coldHeader + 'lost' }] }])).toThrow('Cold chat inlay references could not be read (lost)')
})

test('S6: existing archive metadata with empty counts is corrected by scanning its cold payload, and failures reject the route', async () => {
    let broken = false
    const h = inlayHarness(() => { if (broken) throw new Error('bad gzip'); return { coldData: [{ data: '{{inlay::archived-cold}}' }] } }, {
        checkAuth: async () => true, queueStorageOperation: fn => fn(), ensureChatStore: async () => {}, fullChatStore: new Map(),
        listArchiveMetas: () => [{ chaId: 'c', archivedAt: 1, inlayRefs: {} }], archiveRowId, logger: logger(),
        decodeArchivePayload: async () => ({ payload: { character: { chats: [{ message: [{ data: coldHeader + 'key' }] }] } } }),
    })
    const json = vi.fn(), status = vi.fn().mockReturnThis(), res = { json, status }
    const route = h.route('get', '/api/inlays/references')
    await route({}, res)
    expect(json.mock.calls[0][0].refCounts).toEqual({ 'archived-cold': 1 })
    broken = true
    await route({}, res)
    expect(status).toHaveBeenLastCalledWith(500)
    expect(json.mock.calls.at(-1)![0].error).toContain('Cold chat inlay references could not be read')
})


test('S6: an unreadable cold body does not block archiving, but the following reference request fails', async () => {
    const rows = new Map<string, Buffer>(), log = logger()
    const char = { chaId: 'cold', name: 'Cold', chats: [{ id: 'x', message: [{ data: coldHeader + 'lost' }] }] }
    let meta: any
    const h = inlayHarness(() => null, {
        archivedStubsOf, archiveRowId, ARCHIVE_FORMAT_VERSION: 1,
        hydrateCharacterForArchive: async () => char,
        archiveKey: (id, at) => `archive/${id}/${at}`, archiveMetaKey: (id, at) => `archive-meta/${id}/${at}`,
        kvSize: () => 0, kvGet: () => null, kvDel: vi.fn(),
        kvSet: (key, value) => { rows.set(key, value); if (key.startsWith('archive-meta/')) meta = JSON.parse(value.toString()) },
        encodeRisuSaveLegacy: value => Buffer.from(JSON.stringify(value)),
        decodeArchivePayload: async (id, at) => ({ payload: JSON.parse(rows.get(`archive/${id}/${at}`)!.toString()) }),
        calculateHash: JSON.stringify, buildUncleanableSet: () => new Set(), logger: log,
        checkAuth: async () => true, queueStorageOperation: fn => fn(), ensureChatStore: async () => {}, fullChatStore: new Map(),
        listArchiveMetas: () => [meta],
    })
    for (const name of ['archiveInlayRefCounts', 'jsonLength', 'buildArchivedCharacterStub', 'writeArchiveRow']) vm.runInContext(functionText(name), h.ctx)
    expect(await h.fn('writeArchiveRow')({ characters: [char] }, 'cold')).toMatchObject({ ok: true, stub: { chaId: 'cold' } })
    expect(meta).toMatchObject({ inlayRefs: null, coldStorageKeys: ['lost'] })
    expect(log.warn).toHaveBeenCalledOnce()
    const json = vi.fn(), status = vi.fn().mockReturnThis()
    await h.route('get', '/api/inlays/references')({}, { json, status })
    expect(status).toHaveBeenCalledWith(500)
    expect(json.mock.calls[0][0].error).toContain('Cold chat inlay references could not be read (lost)')
})
