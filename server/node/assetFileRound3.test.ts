import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import * as fsp from 'node:fs/promises'
import * as fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'

const sourceDir = process.env.ASSET_ROUND3_SOURCE_DIR || import.meta.dirname
const require = createRequire(import.meta.url)
const { createAssetFileStore } = require(path.join(sourceDir, 'assetFileStore.cjs'))
const transport = require(path.join(sourceDir, 'assetFileTransport.cjs'))
const source = fs.readFileSync(path.join(sourceDir, 'server.cjs'), 'utf8')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn() })
const section = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))
const evaluate = (code: string, deps: Record<string, any>, expression: string) => new Function(...Object.keys(deps), code + '\nreturn ' + expression)(...Object.values(deps))

async function fixture(options: Record<string, any> = {}) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asset-round3-'))
    const db = new Database(path.join(dir, 'test.db'))
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL)')
    const store = createAssetFileStore(db, { saveDir: dir, logger: { warn() {} }, ...options })
    cleanup.push(async () => { await store.close(); db.close(); await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }) })
    const seed = (key: string, value = key, time = 42) => db.prepare('INSERT OR REPLACE INTO kv VALUES (?, ?, ?)').run(key, Buffer.from(value), time)
    return { dir, db, store, seed }
}
async function collect(stream: AsyncIterable<Buffer>) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks) }
function response() {
    return Object.assign(new EventEmitter(), {
        headers: {} as Record<string, any>, code: 200, destroyed: false, headersSent: false,
        status(n: number) { this.code = n; return this },
        set(k: any, v?: any) { if (typeof k === 'object') Object.assign(this.headers, k); else this.headers[k] = v; return this },
        setHeader(k: string, v: any) { this.headers[k] = v }, end() {}, destroy() { this.destroyed = true },
    })
}
function route(start: string, deps: Record<string, any>) {
    let handler: any
    const tail = source.slice(source.indexOf(start))
    const end = /\r?\n\}\);?/.exec(tail)!
    const register = (...args: any[]) => { handler = args.at(-1) }
    evaluate(tail.slice(0, end.index + end[0].length), { app: { get: register, post: register }, ...deps }, 'undefined')
    return handler
}

describe('round 3 asset regressions', () => {
    it.each(['directory', 'entries'])('1: %s import clears caches warmed during staging on success and failure', async kind => {
        for (const fails of [false, true]) {
            const { store, seed, db, dir } = await fixture()
            seed('database/database.bin', '{"world":"old"}')
            const incoming = [{ key: 'database/database.bin', value: Buffer.from('{"world":"new"}') }, { key: 'assets/new', value: Buffer.from('new') }]
            const folder = path.join(dir, 'incoming'); await fsp.mkdir(folder)
            for (const e of incoming) await fsp.writeFile(path.join(folder, Buffer.from(e.key).toString('hex')), e.value)
            const no = () => {}
            const read = (key: string) => db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value
            const code = `let dbCache = {}, fullChatStore = null, dbEtag = null; const saveTimers = {};
                const initChatStore = obj => { fullChatStore = obj; };
                ${section('function invalidateDbCache()', '// ─── Chat runtime')}
                ${section('async function ensureChatStore()', '// Stub metadata')}
                ${section('async function loadDatabase()', '/** Persist database changes')}
                ${section('function clearExistingData', "app.post('/api/migrate/save-folder/scan'")}`
            const functions = evaluate(code, {
                sqliteDb: db, assetFileStore: store, nodeCrypto: crypto, path, fs: fsp,
                readFileSync: fs.readFileSync, scanHexFilesInDir: () => ({ hexFiles: fs.readdirSync(folder), hasDatabase: true }),
                flushPendingDb: async () => {}, createBackupAndRotate: no, DB_BLOB_KEY: 'database/database.bin', DB_HEX_KEY: 'db',
                decodeRisuSave: async (b: Buffer) => JSON.parse(b.toString()), normalizeJSON: (x: any) => x,
                decodeDatabaseWithPersistentChatIds: async (b: Buffer) => JSON.parse(b.toString()), migrateRemoteBlocksIfNeeded: async () => {},
                pluginStorage: { PREFIX: 'plugin-custom-storage/' }, kvGet: read,
                kvDelPrefix: (prefix: string) => db.prepare('DELETE FROM kv WHERE key LIKE ?').run(prefix + '%'),
                kvDel: (key: string) => db.prepare('DELETE FROM kv WHERE key = ?').run(key),
                kvSet: (key: string, value: Buffer) => { if (fails) throw new Error('publish failed'); seed(key, value.toString()) },
                REMOTE_MIGRATION_MARKER_KEY: 'marker', REMOTE_CHAT_RECOVERY_MARKER: 'recovery',
                pluginAtomic: { purgeForRestore: no }, comfyOrchestrator: { purgeForWorldReplacement: no }, clearEntities: no,
                writeFileSync: no, migrationMarkerPath: path.join(dir, 'marker'),
            }, '{ importHexFilesFromDir, importHexEntries, ensureChatStore, loadDatabase, caches: () => ({dbCache, fullChatStore}) }')
            const prepare = store.prepare
            store.prepare = async (...args: any[]) => {
                await functions.ensureChatStore(); await functions.loadDatabase()
                expect(functions.caches()).toMatchObject({ dbCache: { db: { world: 'old' } }, fullChatStore: { world: 'old' } })
                return prepare(...args)
            }
            const run = kind === 'directory' ? functions.importHexFilesFromDir(folder) : functions.importHexEntries(incoming)
            if (fails) await expect(run).rejects.toThrow('publish failed'); else await run
            expect(functions.caches()).toEqual({ dbCache: {}, fullChatStore: null })
            expect(JSON.parse(read('database/database.bin').toString()).world).toBe(fails ? 'old' : 'new')
        }
    })

    it('2: missing generations are absent without retiring their rows, including conditional GET', async () => {
        const warn = vi.fn(), { store, db } = await fixture({ logger: { warn } })
        await store.put('assets/a', Buffer.from('present'))
        const meta = await store.stat('assets/a')
        await fsp.unlink(path.join(store.root, meta.generationId.slice(0, 2), meta.generationId + '.blob'))
        expect(await store.get('assets/a')).toBeNull()
        expect(await store.open('assets/a')).toBeNull()
        expect(await store.stat('assets/a')).toBeNull()
        const handler = route("app.get('/api/asset/:hexKey'", { sessionAuthMiddleware() {}, assetFileStore: store, logger: { error() {} } })
        const res = response()
        await handler({ params: { hexKey: Buffer.from('assets/a').toString('hex') }, headers: { 'if-none-match': `"${meta.updated_at}"` } }, res)
        expect(res.code).toBe(404)
        expect(db.prepare('SELECT retired FROM asset_file_generations').get()).toEqual({ retired: 0 })
        expect(warn.mock.calls.flat().join(' ')).toContain(meta.generationId)
        expect(warn.mock.calls.flat().join(' ')).toContain('assets/a')
    })

    it.each([0, 2, 20])('2: capture declares actual size %i and skips missing generations', async size => {
        const warn = vi.fn(), { store } = await fixture({ logger: { warn } })
        for (const key of ['assets/a', 'assets/missing']) await store.put(key, Buffer.from('original'))
        const meta = await store.stat('assets/a'), missing = await store.stat('assets/missing')
        const filename = path.join(store.root, meta.generationId.slice(0, 2), meta.generationId + '.blob')
        await fsp.writeFile(filename, Buffer.alloc(size, 65))
        await fsp.unlink(path.join(store.root, missing.generationId.slice(0, 2), missing.generationId + '.blob'))
        const entries = await store.capture()
        expect(entries).toHaveLength(1); expect(entries[0].size).toBe(size)
        await fsp.appendFile(filename, 'later growth')
        const bytes = await collect(transport.backupEntryChunks({ ...entries[0], backupName: 'a' }))
        expect(bytes.length).toBe(9 + size); expect(bytes.readUInt32LE(5)).toBe(size)
        expect(warn.mock.calls.flat().join(' ')).toContain(meta.generationId)
    })

    it('2: worker capture that finds a migrated generation also checks disk size and absence', async () => {
        const { store } = await fixture()
        await store.put('assets/a', Buffer.from('original'))
        const meta = await store.stat('assets/a')
        const filename = path.join(store.root, meta.generationId.slice(0, 2), meta.generationId + '.blob')
        await fsp.writeFile(filename, 'short')
        const entries = await store.captureEntries([{ kind: 'kv', key: 'assets/a' }])
        expect(entries).toHaveLength(1); expect(entries[0].size).toBe(5)
        await fsp.unlink(filename)
        expect(await store.captureEntries([{ kind: 'kv', key: 'assets/a' }])).toHaveLength(0)
    })

    it('2: ignoreExisting restores a missing generation from the legacy hex file', async () => {
        const { store, dir, db } = await fixture()
        await store.put('assets/a', Buffer.from('old'))
        const meta = await store.stat('assets/a')
        await fsp.unlink(path.join(store.root, meta.generationId.slice(0, 2), meta.generationId + '.blob'))
        await fsp.writeFile(path.join(dir, Buffer.from('assets/a').toString('hex')), 'recovered')
        const dbSource = fs.readFileSync(path.join(sourceDir, 'db.cjs'), 'utf8')
        const code = dbSource.slice(dbSource.indexOf('function migrateFromSaveDir'), dbSource.indexOf('// Chunk-aware store'))
        const migrate = evaluate(code, { fs, path, db, savePath: dir, migrationMarker: path.join(dir, 'marker'), DB_BLOB_KEY: 'database/database.bin', console: { log() {} } }, 'migrateFromSaveDir')
        await store.legacyBatch(migrate)
        expect((await store.get('assets/a')).toString()).toBe('recovered')
    })

    it.each([1, 2])('3: retirement registration fails %i time(s) but preserves KV fallback and traceability', async failures => {
        const warn = vi.fn(), { store, db } = await fixture({ logger: { warn } })
        const prepare = db.prepare.bind(db); let calls = 0
        vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
            if (sql.includes('INSERT OR IGNORE INTO asset_file_generations') && calls++ < failures) throw new Error('registration unavailable')
            return prepare(sql)
        })
        await store.put('assets/a', Buffer.from('bytes'))
        expect((await store.get('assets/a')).toString()).toBe('bytes')
        expect(calls).toBe(2)
        const rows = prepare('SELECT * FROM asset_file_generations').all() as any[]
        if (failures === 1) expect(rows).toMatchObject([{ retired: 1, size: 5, sha256: crypto.createHash('sha256').update('bytes').digest('hex') }])
        else {
            const shard = (await fsp.readdir(store.root))[0], file = (await fsp.readdir(path.join(store.root, shard)))[0]
            expect(warn.mock.calls.flat().join(' ')).toContain(file.replace('.blob', ''))
        }
    })

    it.each(['file', 'sidecar'])('4: disappeared %s is skipped but other copy errors propagate', async kind => {
        const warn = vi.fn(), { store, dir } = await fixture({ logger: { warn } })
        const sourcePath = path.join(dir, 'gone')
        const entries = await store.captureEntries([{ kind, sourcePath, backupName: 'gone' }, { kind: 'buffer', buffer: Buffer.from('kept'), backupName: 'kept' }])
        expect(entries.map((e: any) => e.backupName)).toEqual(['kept']); expect(warn).toHaveBeenCalled()
        const copy = vi.spyOn(require('node:fs/promises'), 'copyFile').mockRejectedValue(Object.assign(new Error('permission'), { code: 'EACCES' }))
        await expect(store.captureEntries([{ kind, sourcePath }])).rejects.toThrow('permission'); copy.mockRestore()
    })

    it('5: stages in main DB, cleans leftovers at boot/import, drops on success/failure, and publishes atomically', async () => {
        const { store, db, dir, seed } = await fixture()
        db.exec('CREATE TABLE asset_import_crashed(key TEXT); CREATE TABLE asset_importance(key TEXT)')
        await store.close()
        const reopened = createAssetFileStore(db, { saveDir: dir }); cleanup.push(() => reopened.close())
        const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name)
        expect(tables()).not.toContain('asset_import_crashed'); expect(tables()).toContain('asset_importance')
        const observer = new Database(db.name); cleanup.push(async () => { observer.close() })
        for (const fails of [false, true]) {
            seed('database/database.bin', 'old'); seed('coldstorage/a', 'old')
            db.exec('CREATE TABLE asset_import_leftover(key TEXT)')
            const stage = evaluate(section('async function publishSaveFolderEntries', 'async function importHexFilesFromDir'), {
                sqliteDb: db, assetFileStore: reopened, nodeCrypto: crypto, DB_BLOB_KEY: 'database/database.bin',
                invalidateDbCache() {}, clearExistingData: (writer: any) => { writer.clear(); db.prepare('DELETE FROM kv').run() },
                kvSet: (key: string, value: Buffer) => { if (fails) throw new Error('publish failed'); seed(key, value.toString()) },
            }, 'publishSaveFolderEntries')
            async function* incoming() {
                yield { key: 'database/database.bin', value: Buffer.from('new') }
                yield { key: 'coldstorage/a', value: Buffer.from('new') }
                const staged = tables().filter((n: string) => n.startsWith('asset_import_'))
                expect(staged).toHaveLength(1); expect(staged).not.toContain('asset_import_leftover')
                expect(db.prepare('SELECT name FROM sqlite_temp_master').all()).toEqual([])
                expect(observer.prepare('SELECT value FROM kv WHERE key = ?').get('coldstorage/a').value.toString()).toBe('old')
            }
            if (fails) await expect(stage(incoming(), {}, false)).rejects.toThrow('publish failed'); else await stage(incoming(), {}, false)
            expect(tables().filter((n: string) => n.startsWith('asset_import_'))).toEqual([])
            expect(observer.prepare('SELECT value FROM kv WHERE key = ?').get('coldstorage/a').value.toString()).toBe(fails ? 'old' : 'new')
        }
    })

    it('6: parent retains the generation id when worker dies after rename, and the next migration retries', async () => {
        const { db, dir, seed } = await fixture(); seed('assets/a', 'bytes')
        let dispatched: any, crashes = true
        const NativeWorker = require('node:worker_threads').Worker
        class Worker extends NativeWorker {
            constructor(filename: string, options: any) {
                const crash = crashes; crashes = false
                super(crash ? path.join(import.meta.dirname, 'fixtures/assetFileWorkerCrash.cjs') : filename, options)
            }
            postMessage(message: any) { dispatched = message; super.postMessage(message) }
        }
        const module = { exports: {} as any }
        runInNewContext(fs.readFileSync(path.join(sourceDir, 'assetFileStore.cjs'), 'utf8'), {
            module, __dirname: sourceDir, Buffer, console, setTimeout, clearTimeout,
            require: (name: string) => name === 'node:worker_threads' ? { Worker } : require(name.startsWith('./') ? path.join(sourceDir, name) : name),
        })
        const store = module.exports.createAssetFileStore(db, { saveDir: dir }); cleanup.push(() => store.close())
        await expect(store.migrateOne('assets/a')).rejects.toThrow('exited')
        expect(dispatched.generationId).toMatch(/^[a-f0-9]{64}$/)
        const old = db.prepare('SELECT * FROM asset_file_generations').get() as any
        expect(old).toMatchObject({ generationId: dispatched.generationId, retired: 1, size: 5, sha256: crypto.createHash('sha256').update('bytes').digest('hex') })
        expect(await store.migrateOne('assets/a')).toBe(true)
        expect(dispatched.generationId).not.toBe(old.generationId)
    })

    it('7: empty asset patch releases its decoded cache', async () => {
        const { store } = await fixture(), utils = require('./utils.cjs'), cache = {}
        await store.put('assets/a', Buffer.from(utils.encodeRisuSaveLegacy({ value: 'old' })))
        const handler = route("app.post('/api/patch',", {
            enablePatchSync: true, checkAuth: async () => true, normalizeFilePathHeader: (s: string) => s, isHex: () => true,
            queueStorageOperation: (fn: any) => fn(), dbCache: cache, saveTimers: {}, assetFileStore: store,
            readStorageValue: (key: string) => store.get(key), ...utils, currentPersistWarning: () => null,
            logger: { error() {} },
        })
        const res: any = response(); res.send = (body: any) => { res.body = body }
        await handler({ headers: { 'file-path': Buffer.from('assets/a').toString('hex') }, body: { expectedHash: utils.calculateHash({ value: 'old' }).toString(16), patch: [] } }, res)
        expect(res.code).toBe(200); expect(res.body.success).toBe(true); expect(cache).toEqual({})
    })
})
