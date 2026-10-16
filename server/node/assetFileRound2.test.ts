import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import * as fsp from 'node:fs/promises'
import * as fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { AsyncLocalStorage } from 'node:async_hooks'
import { runInNewContext } from 'node:vm'

const sourceDir = process.env.ASSET_ROUND2_SOURCE_DIR || import.meta.dirname
const require = createRequire(import.meta.url)
const { createAssetFileStore } = require(path.join(sourceDir, 'assetFileStore.cjs'))
const transport = require(path.join(sourceDir, 'assetFileTransport.cjs'))
const source = fs.readFileSync(path.join(sourceDir, 'server.cjs'), 'utf8')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn() })
const section = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))
const evaluate = (code: string, deps: Record<string, any>, expression: string) => new Function(...Object.keys(deps), code + '\nreturn ' + expression)(...Object.values(deps))
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

async function fixture(options: Record<string, any> = {}) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asset-round2-'))
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

describe('round 2 asset regressions', () => {
    it('1: ordinary queued chat writes leave a dispatched migration publishable', async () => {
        const reached = deferred(), release = deferred()
        const { store, seed } = await fixture({ checkpoint: async () => { reached.resolve(); await release.promise } })
        seed('assets/a')
        const queue = evaluate(section('let storageOperationQueue', 'function withComfyWorldReplacementGate'), { assetFileStore: store, AsyncLocalStorage }, 'queueStorageOperation')
        const migrating = store.migrateOne('assets/a')
        await reached.promise
        await queue(() => seed('chat/a'))
        release.resolve()
        expect(await migrating).toBe(true)
    })

    it('1: bulk writes pause migration without interrupting unrelated Comfy work', async () => {
        const reached = deferred(), release = deferred()
        const { store, seed } = await fixture({ checkpoint: async (stage: string) => {
            if (stage === 'pre-publish') { reached.resolve(); await release.promise }
        } })
        seed('assets/a')
        const queue = evaluate(section('let storageOperationQueue', 'function withComfyWorldReplacementGate'), { assetFileStore: store, AsyncLocalStorage }, 'queueStorageOperation')
        const comfy = vi.fn(() => { throw new Error('must not interrupt Comfy') })
        const handler = route("app.post('/api/assets/bulk-write',", {
            checkAuth: async () => true, queueStorageOperation: queue, assetFileStore: store,
            withComfyWorldReplacementGate: comfy, BULK_BATCH: 100, kvSet() {},
        })
        const migrating = store.migrateOne('assets/a')
        await reached.promise
        const res: any = response(); res.json = () => {}
        const next = vi.fn()
        try {
            await handler({ body: [{ key: 'assets/b', value: Buffer.from('bulk').toString('base64') }] }, res, next)
        } finally { release.resolve() }
        expect(await migrating).toBe(false)
        expect(next).not.toHaveBeenCalled(); expect(comfy).not.toHaveBeenCalled()
        expect((await store.get('assets/b')).toString()).toBe('bulk')
    })

    it.each(['revision', 'pause', 'exception'])('1: records cancelled generations after %s', async reason => {
        const { store, seed, db } = await fixture({ checkpoint: async () => {
            if (reason === 'revision') seed('assets/a', 'replacement')
            if (reason === 'pause') await store.withMigrationPaused(async () => {})
            if (reason === 'exception') throw new Error('publish interrupted')
        } })
        seed('assets/a')
        if (reason === 'exception') await expect(store.migrateOne('assets/a')).rejects.toThrow('publish interrupted')
        else expect(await store.migrateOne('assets/a')).toBe(false)
        const rows = db.prepare('SELECT * FROM asset_file_generations').all() as any[]
        expect(rows).toHaveLength(1)
        expect(rows[0].retired).toBe(1)
        expect(await fsp.readFile(path.join(store.root, rows[0].generationId.slice(0, 2), rows[0].generationId + '.blob'), 'utf8')).toBe('assets/a')
    })

    it('1: retains and catalogs post-rename failures and subsequently retries', async () => {
        let failing = true
        const { store, db } = await fixture({ checkpoint: async (stage: string) => {
            if (stage === 'post-rename' && failing) throw new Error('post rename error')
        } })
        await store.put('assets/a', Buffer.from('bytes'))
        expect(db.prepare('SELECT retired, size FROM asset_file_generations').all()).toEqual([{ retired: 1, size: 5 }])
        expect((await store.get('assets/a')).toString()).toBe('bytes')
        failing = false
        expect(await store.migrateOne('assets/a')).toBe(true)
        expect((await store.stats()).assetFileBytes).toBe(10)
    })

    it('1: worker errors preserve renamed-generation metadata for retired registration', async () => {
        let handler: any
        const messages: any[] = []
        const generation = { generationId: 'ab'.repeat(32), size: 3, sha256: 'hash' }
        runInNewContext(fs.readFileSync(path.join(sourceDir, 'assetFileWorker.cjs'), 'utf8'), {
            require(name: string) {
                if (name === 'node:worker_threads') return { parentPort: { on: (_: string, fn: any) => { handler = fn }, postMessage: (m: any) => messages.push(m) }, workerData: { dbPath: 'test' } }
                if (name === 'better-sqlite3') return class {
                    pragma() {} transaction(fn: any) { return fn }
                    prepare() { return { get: () => ({ value: Buffer.from('abc'), sourceRevision: 'revision' }) } }
                }
                if (name === './assetFileIO.cjs') return { writeGeneration: async () => { throw Object.assign(new Error('renamed then failed'), { generation }) } }
                return require(name)
            },
        })
        await handler({ type: 'migrate', key: 'assets/a' })
        expect(messages[0].error.generation).toEqual({ key: 'assets/a', ...generation })
    })

    it('2: legacy capture writes no generations and releases its spool after use', async () => {
        let generationWrites = 0
        const { store, seed, db } = await fixture({ checkpoint: async () => { generationWrites++ } })
        seed('assets/a', 'captured')
        const captured = await store.capture()
        expect(generationWrites).toBe(0)
        expect(db.prepare('SELECT count(*) n FROM asset_file_generations').get()).toEqual({ n: 0 })
        expect(await fsp.readdir(store.root).catch(() => [])).toEqual([])
        expect(captured[0].kind).toBe('spool')
        await captured.dispose()
        await expect(fsp.stat(captured[0].sourcePath)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('2: worker releases its read transaction before writing the legacy spool', async () => {
        let handler: any, inTransaction = false, writes = 0
        runInNewContext(fs.readFileSync(path.join(sourceDir, 'assetFileWorker.cjs'), 'utf8'), {
            require(name: string) {
                if (name === 'node:worker_threads') return { parentPort: { on: (_: string, fn: any) => { handler = fn }, postMessage() {} }, workerData: { dbPath: 'test' } }
                if (name === 'better-sqlite3') return class {
                    pragma() {}
                    transaction(fn: any) { return () => { inTransaction = true; try { return fn() } finally { inTransaction = false } } }
                    prepare(sql: string) { return { get: () => sql.includes('asset_file_generations') ? undefined : { value: Buffer.from('abc') } } }
                }
                if (name === 'node:fs/promises') return { writeFile: async () => { expect(inTransaction).toBe(false); writes++ } }
                if (name === './assetFileIO.cjs') return { writeGeneration: async () => { throw new Error('capture must not generate files') } }
                return require(name)
            },
        })
        await handler({ type: 'capture', key: 'assets/a', sourcePath: 'spool' })
        expect(writes).toBe(1)
    })

    it.each(['directory', 'entries'])('3: %s import prepares outside transactions and publishes one consistent world', async kind => {
        const { store, seed, db, dir } = await fixture()
        seed('assets/old', 'old'); seed('database/database.bin', '{}')
        const observations: boolean[] = []
        const legacyBatch = store.legacyBatch
        store.legacyBatch = async (...args: any[]) => {
            const result = legacyBatch(...args)
            observations.push(db.inTransaction)
            await result
        }
        const fileDir = path.join(dir, 'incoming'); await fsp.mkdir(fileDir)
        const entries = [{ key: 'database/database.bin', value: Buffer.from('{}') }, { key: 'assets/new', value: Buffer.from('new') }]
        for (const e of entries) await fsp.writeFile(path.join(fileDir, Buffer.from(e.key).toString('hex')), e.value)
        const legacyWrite = (key: string, value: Buffer) => db.prepare('INSERT OR REPLACE INTO kv VALUES (?, ?, ?)').run(key, value, Date.now())
        const no = () => {}
        const start = source.includes('async function clearExistingData') ? 'async function clearExistingData' : 'function clearExistingData'
        const functions = evaluate(section(start, "app.post('/api/migrate/save-folder/scan'"), {
            sqliteDb: db, assetFileStore: store, nodeCrypto: crypto, path,
            fs: { ...fsp, readFile: async (filename: string) => { observations.push(db.inTransaction); return fsp.readFile(filename) } },
            readFileSync: (filename: string) => { observations.push(db.inTransaction); return fs.readFileSync(filename) },
            scanHexFilesInDir: () => ({ hexFiles: fs.readdirSync(fileDir), hasDatabase: true }),
            flushPendingDb: async () => {}, createBackupAndRotate: no, invalidateDbCache: no,
            DB_BLOB_KEY: 'database/database.bin', decodeRisuSave: async () => ({}),
            pluginStorage: { PREFIX: 'plugin-custom-storage/' },
            kvDelPrefix: (prefix: string) => db.prepare('DELETE FROM kv WHERE key LIKE ?').run(prefix + '%'),
            kvDel: (key: string) => db.prepare('DELETE FROM kv WHERE key = ?').run(key), kvSet: legacyWrite,
            REMOTE_MIGRATION_MARKER_KEY: 'marker', REMOTE_CHAT_RECOVERY_MARKER: 'recovery',
            pluginAtomic: { purgeForRestore: no }, comfyOrchestrator: { purgeForWorldReplacement: no }, clearEntities: no,
            writeFileSync: no, migrationMarkerPath: path.join(dir, 'marker'),
        }, '{ importHexFilesFromDir, importHexEntries }')
        if (kind === 'directory') await functions.importHexFilesFromDir(fileDir)
        else await functions.importHexEntries(entries)
        expect(observations.every(open => !open)).toBe(true)
        expect((await store.list()).map((e: any) => e.key)).toEqual(['assets/new'])
        expect(db.inTransaction).toBe(false)
    })

    it('4: freezes every mutable archive kind before calculating Content-Length', async () => {
        const { store, seed, db, dir } = await fixture()
        seed('plugin/blob', 'old kv')
        await store.put('assets/a', Buffer.from('old asset'))
        const asset = (await store.capture())[0]
        const original = Buffer.from('old buffer')
        const filename = path.join(dir, 'inlay'); await fsp.writeFile(filename, 'old file')
        const entries = await store.captureEntries([
            { ...asset, backupName: 'a' }, { kind: 'kv', key: 'plugin/blob', backupName: 'plugin/blob' },
            { kind: 'file', sourcePath: filename, backupName: 'inlay/a' },
            { kind: 'sidecar', sourcePath: filename, backupName: 'sidecar/a' },
            { kind: 'buffer', buffer: original, backupName: 'cold/a', size: original.length },
        ])
        const length = entries.reduce((n: number, e: any) => n + 8 + Buffer.byteLength(e.backupName) + e.size, 0)
        db.prepare('DELETE FROM kv WHERE key = ?').run('plugin/blob')
        await fsp.unlink(filename); original.fill(0); await store.remove('assets/a')
        const chunks = []
        for (const entry of entries) chunks.push(await collect(transport.backupEntryChunks(entry)))
        expect(Buffer.concat(chunks).length).toBe(length)
        expect(chunks.map((b: Buffer) => b.subarray(8 + b.readUInt32LE(0)).toString())).toEqual(['old asset', 'old kv', 'old file', 'old file', 'old buffer'])
        await entries.dispose()
    })

    it('6: timestamp stays monotonic across clear, legacy replace, delete and restart', async () => {
        const { store, db, dir } = await fixture()
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
        await store.put('assets/a', Buffer.from('first'))
        const before = (await store.stat('assets/a')).updated_at
        await store.legacyBatch((writer: any) => { writer.clear(); writer.put('assets/a', Buffer.from('second')) })
        expect((await store.stat('assets/a')).updated_at).toBeGreaterThan(before)
        const second = (await store.stat('assets/a')).updated_at
        await store.remove('assets/a'); await store.close()
        const reopened = createAssetFileStore(db, { saveDir: dir })
        cleanup.push(() => reopened.close())
        await reopened.legacyBatch((w: any) => w.put('assets/a', Buffer.from('third')))
        expect((await reopened.stat('assets/a')).updated_at).toBeGreaterThan(second)
        clock.mockRestore()
    })

    it('5: asset patches persist immediately, reload newer writes and cannot resurrect after clear', async () => {
        const { store } = await fixture()
        const utils = require('./utils.cjs')
        const timers: any[] = [], cache = {}, saveTimers = {}
        const handler = route("app.post('/api/patch',", {
            enablePatchSync: true, checkAuth: async () => true, normalizeFilePathHeader: (s: string) => s,
            isHex: () => true, queueStorageOperation: (fn: any) => fn(), dbCache: cache, saveTimers,
            readStorageValue: (key: string) => store.get(key), writeStorageValue: (key: string, b: Buffer) => store.put(key, b),
            assetFileStore: store, ...utils, applyPatch: require('fast-json-patch').applyPatch,
            setTimeout: (fn: any) => { timers.push(fn); return fn }, clearTimeout() {}, SAVE_INTERVAL: 5000,
            currentPersistWarning: () => null, clearPersistFailure() {}, recordPersistFailure() {}, logger: { error() {} },
        })
        const key = 'assets/patch'
        const set = (value: string) => store.put(key, Buffer.from(utils.encodeRisuSaveLegacy({ value })))
        const patch = async (before: string, after: string) => {
            const res: any = response(); res.send = (value: any) => { res.body = value }
            await handler({ headers: { 'file-path': Buffer.from(key).toString('hex') }, body: {
                expectedHash: utils.calculateHash({ value: before }).toString(16), patch: [{ op: 'replace', path: '/value', value: after }],
            } }, res)
            expect(res.code).toBe(200)
        }
        await set('old'); await patch('old', 'patched')
        expect((await utils.decodeRisuSave(await store.get(key))).value).toBe('patched')
        await set('newer'); await patch('newer', 'again')
        expect((await utils.decodeRisuSave(await store.get(key))).value).toBe('again')
        await store.legacyBatch((w: any) => w.clear())
        for (const fn of timers) await fn()
        expect(await store.get(key)).toBeNull()
        expect(timers).toHaveLength(0); expect(cache).toEqual({})
    })

    it('7: a matching ETag never opens a file or reads a legacy BLOB', async () => {
        const open = vi.fn(async () => { throw new Error('must not open') })
        const handler = route("app.get('/api/asset/:hexKey'", { sessionAuthMiddleware() {}, assetFileStore: { stat: async () => ({ updated_at: 77 }), open }, logger: { error() {} } })
        const res = response()
        await handler({ params: { hexKey: Buffer.from('assets/a').toString('hex') }, headers: { 'if-none-match': '"77"' } }, res)
        expect(res.code).toBe(304); expect(open).not.toHaveBeenCalled()
    })

    it('7: stream-open failure does not put immutable headers on a 500', async () => {
        const handler = route("app.get('/api/asset/:hexKey'", { sessionAuthMiddleware() {}, assetFileStore: {
            stat: async () => ({ updated_at: 77 }), open: async () => ({ updated_at: 77, size: 1, stream: Readable.from((async function* () { throw new Error('missing') })()) }),
        }, sendAsset: transport.sendAsset, logger: { error() {} }, resolveAssetPayload: () => ({ contentType: 'image/png' }) })
        const res = response()
        await handler({ params: { hexKey: Buffer.from('assets/a').toString('hex') }, headers: {} }, res)
        expect(res.code).toBe(500); expect(res.headers['Cache-Control']).toBeUndefined()
    })

    it('8: stats reads only the catalog, including retired files', async () => {
        const { store } = await fixture()
        await store.put('assets/a', Buffer.from('aaa')); await store.remove('assets/a')
        await store.put('assets/b', Buffer.from('bb'))
        const readdir = vi.spyOn(require('node:fs/promises'), 'readdir').mockRejectedValue(new Error('directory unavailable'))
        expect(await store.stats()).toEqual({ assetFileBytes: 5, fileSize: 2 })
        expect(readdir).not.toHaveBeenCalled(); readdir.mockRestore()
    })

    it('9: concurrent worker requests complete and close awaits manual publish checkpoints', async () => {
        const reached = deferred(), release = deferred()
        const { store, seed, db } = await fixture({ checkpoint: async () => { reached.resolve(); await release.promise } })
        seed('assets/a'); seed('assets/b')
        const first = store.migrateOne('assets/a'), second = store.migrateOne('assets/b')
        await reached.promise
        let closed = false
        const closing = store.close().then(() => { closed = true })
        await new Promise(resolve => setTimeout(resolve, 30))
        const closedEarly = closed
        release.resolve()
        expect(closedEarly).toBe(false)
        expect(await Promise.all([first, second])).toEqual([true, true])
        await closing
        expect(db.prepare('SELECT count(*) n FROM asset_file_generations WHERE retired = 0').get()).toEqual({ n: 2 })
    })

    it('10: secondary worker connection uses the existing busy_timeout', () => {
        const pragmas: string[] = []
        runInNewContext(fs.readFileSync(path.join(sourceDir, 'assetFileWorker.cjs'), 'utf8'), {
            require(name: string) {
                if (name === 'node:worker_threads') return { parentPort: { on() {} }, workerData: { dbPath: 'test' } }
                if (name === 'better-sqlite3') return class { pragma(s: string) { pragmas.push(s) } prepare() { return {} } }
                return require(name.startsWith('./') ? path.join(sourceDir, name) : name)
            },
        })
        expect(pragmas).toContain('busy_timeout = 5000')
    })

    it('11: export disconnect exits quietly and disposes captured sources', async () => {
        const dispose = vi.fn(async () => {})
        const assets: any = [{ kind: 'buffer', buffer: Buffer.from('a'), key: 'assets/a', size: 1 }]; assets.dispose = dispose
        const handler = route("app.get('/api/backup/export',", {
            checkAuth: async () => true, flushPendingDb: async () => {}, buildFullExportDbValue: async () => null,
            listInlayFiles: async () => [], kvListWithSizes: () => [], kvGet: () => null, listColdStorageBackupEntries: () => [],
            pluginAtomic: { exportRows: () => [] }, path, assetFileStore: { capture: async () => assets, captureEntries: async (e: any) => Object.assign(e, { dispose }) },
            backupEntryChunks: transport.backupEntryChunks, writeChunk: async (res: any) => { res.destroyed = true; throw new Error('client gone') },
        })
        const next = vi.fn(), res = response()
        await handler({ query: {} }, res, next)
        expect(next).not.toHaveBeenCalled(); expect(dispose).toHaveBeenCalled()
    })

    it('12: missing revision rows are recreated and the legacy asset migrates', async () => {
        const { db, store, seed } = await fixture()
        seed('assets/a')
        db.prepare('DELETE FROM asset_file_revisions').run()
        expect(await store.migrateOne('assets/a')).toBe(true)
        expect((await store.get('assets/a')).toString()).toBe('assets/a')
    })
})
