import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import storeModule from './assetFileStore.cjs'
import io from './assetFileIO.cjs'
import transcodeModule from './mediaTranscode.cjs'
import { isWebp, markedPicture, picture } from './mediaTranscodeTestKit'

const { createAssetFileStore } = storeModule
const { createMediaTranscode, normalizeConfig } = transcodeModule
const DAY = 86_400_000
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action() })

async function fixture(config: Record<string, any> | null = { enabled: true, paceMs: 0 }, options: Record<string, any> = {}) {
    const dir = await mkdtemp(path.join(tmpdir(), 'media-transcode-'))
    const db = new Database(path.join(dir, 'test.db'))
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL)')
    const logs: string[] = []
    const logger = { warn: (s: string) => logs.push(`warn ${s}`), info: (s: string) => logs.push(`info ${s}`) }
    const store = createAssetFileStore(db, { saveDir: dir, logger })
    let chain: Promise<any> = Promise.resolve()
    const hooks: { beforeQueue?: () => Promise<void> } = {}
    const queue = (operation: () => any) => {
        const run = chain.then(async () => {
            const before = hooks.beforeQueue
            hooks.beforeQueue = undefined
            if (before) await before()
            return operation()
        })
        chain = run.catch(() => {})
        return run
    }
    const transcode = createMediaTranscode({ db, saveDir: dir, store, queue, logger, ...options })
    const setConfig = (value: Record<string, any> | null) => {
        const file = path.join(dir, 'media-transcode.json')
        if (value) writeFileSync(file, JSON.stringify(value))
        else if (existsSync(file)) unlinkSync(file)
    }
    setConfig(config)
    cleanup.push(async () => {
        await transcode.stop(); await store.close(); db.close()
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    })
    const liveId = (key: string) => db.prepare('SELECT generationId FROM asset_file_generations WHERE key = ? AND retired = 0').get(key)?.generationId
    const age = (key: string, days: number) => db.prepare('UPDATE asset_file_generations SET updated_at = ? WHERE key = ? AND retired = 0')
        .run(Date.now() - days * DAY, key)
    const retireAge = (id: string, days: number) => db.prepare('UPDATE asset_file_retirements SET retired_at = ? WHERE generationId = ?')
        .run(Date.now() - days * DAY, id)
    const logRow = (id: string) => db.prepare('SELECT * FROM media_transcode_log WHERE id = ?').get(id)
    const file = (id: string) => io.generationPath(store.root, id)
    const rel = (id: string) => `assets/${id.slice(0, 2)}/${id}.blob`
    // Runs passes until the scheduler says there is nothing left for now.
    const settle = async () => { for (let i = 0; i < 50; i++) if (await transcode.pass() !== 0) return; throw new Error('never settled') }
    const put = async (key: string, bytes: Buffer, days = 60) => { await store.put(key, bytes); age(key, days); return liveId(key) }
    return { dir, db, store, transcode, setConfig, liveId, age, retireAge, logRow, file, rel, settle, put, logs, hooks }
}

describe('media transcode: converting assets', () => {
    it('does nothing until it is switched on', async () => {
        const { transcode, put, logRow, db } = await fixture(null)
        const id = await put('assets/a.png', await markedPicture())
        expect(await transcode.pass()).toBe(60_000)
        expect(logRow(id)).toBeUndefined()
        expect(db.prepare('SELECT count(*) n FROM media_transcode_log').get().n).toBe(0)
    })

    it('converts an old marked PNG under the same key and keeps the original on disk', async () => {
        const { store, settle, put, liveId, logRow, file, db } = await fixture()
        const png = await markedPicture()
        const original = await put('assets/a.png', png)
        await settle()
        const converted = liveId('assets/a.png')
        expect(converted).not.toBe(original)
        const bytes = await store.get('assets/a.png')
        expect(isWebp(bytes)).toBe(true)
        expect(bytes.length).toBeLessThan(png.length)
        const row = logRow(original)
        expect(row).toMatchObject({ kind: 'asset', key: 'assets/a.png', outcome: 'converted', result: converted })
        expect(JSON.parse(row.detail)).toMatchObject({ from: png.length, to: bytes.length })
        expect(readFileSync(file(original)).equals(png)).toBe(true)
        expect(db.prepare('SELECT retired FROM asset_file_generations WHERE generationId = ?').get(original).retired).toBe(1)
        // The WebP it made is not looked at again.
        await settle()
        expect(logRow(converted)).toBeUndefined()
        expect(liveId('assets/a.png')).toBe(converted)
    })

    it('leaves alone what is young, unmarked, not a PNG, or not a plain PNG', async () => {
        const { settle, put, liveId, logRow } = await fixture()
        const young = await put('assets/young.png', await markedPicture(), 5)
        const plain = await put('assets/plain.png', await picture())
        const other = await put('assets/other.png', Buffer.from('RIFF....WEBP not really'))
        const foreign = await put('assets/foreign.png', await markedPicture(5, 'parameters'))
        await settle()
        expect(logRow(young)).toBeUndefined()
        expect(logRow(plain)).toMatchObject({ outcome: 'not-marked' })
        expect(logRow(other)).toMatchObject({ outcome: 'not-plain-png', detail: 'not a png' })
        expect(logRow(foreign)).toMatchObject({ outcome: 'not-marked' })
        for (const [key, id] of [['assets/young.png', young], ['assets/plain.png', plain], ['assets/other.png', other], ['assets/foreign.png', foreign]]) {
            expect(liveId(key)).toBe(id)
        }
    })

    it('honours other markers from the configuration', async () => {
        const { settle, put, logRow } = await fixture({ enabled: true, paceMs: 0, markers: ['parameters'] })
        const maid = await put('assets/maid.png', await markedPicture())
        const foreign = await put('assets/foreign.png', await markedPicture(5, 'parameters'))
        await settle()
        expect(logRow(maid)).toMatchObject({ outcome: 'not-marked' })
        expect(logRow(foreign)).toMatchObject({ outcome: 'converted' })
    })

    it('report mode records what it would do and changes nothing; switching on then converts', async () => {
        const { store, transcode, setConfig, settle, put, liveId, logRow, dir } = await fixture({ enabled: 'report', paceMs: 0 })
        const png = await markedPicture()
        const original = await put('assets/a.png', png)
        await settle()
        expect(logRow(original)).toMatchObject({ outcome: 'would-convert' })
        expect(liveId('assets/a.png')).toBe(original)
        expect((await store.get('assets/a.png')).equals(png)).toBe(true)
        expect(existsSync(path.join(dir, 'media-originals'))).toBe(false)
        // Nothing is examined twice while reporting.
        const before = logRow(original).at
        await settle()
        expect(logRow(original).at).toBe(before)
        setConfig({ enabled: true, paceMs: 0 })
        await settle()
        expect(logRow(original)).toMatchObject({ outcome: 'converted' })
        expect(isWebp(await store.get('assets/a.png'))).toBe(true)
        expect(existsSync(transcode.paths.wantPath)).toBe(true)
    })

    it('publishes nothing when the key was written again while its image was being encoded', async () => {
        const { store, settle, put, liveId, logRow, hooks } = await fixture()
        const original = await put('assets/a.png', await markedPicture())
        const newer = await markedPicture(7)
        hooks.beforeQueue = async () => { await store.put('assets/a.png', newer) }
        await settle()
        expect((await store.get('assets/a.png')).equals(newer)).toBe(true)
        expect(logRow(original)).toBeUndefined()
        expect(liveId('assets/a.png')).not.toBe(original)
    })

    it('records a failed read as an error and tries again only after the backoff', async () => {
        const { settle, put, logRow, file, db } = await fixture()
        const png = await markedPicture()
        const id = await put('assets/a.png', png)
        unlinkSync(file(id))
        await settle()
        expect(logRow(id)).toMatchObject({ outcome: 'error', attempts: 1 })
        expect(logRow(id).next_at).toBeGreaterThan(Date.now())
        await settle()
        expect(logRow(id).attempts).toBe(1)
        writeFileSync(file(id), png)
        db.prepare('UPDATE media_transcode_log SET next_at = ? WHERE id = ?').run(Date.now() - 1, id)
        await settle()
        expect(logRow(id)).toMatchObject({ outcome: 'converted', attempts: 0 })
    })

    it('takes a decision again when it was made under older checks', async () => {
        const { settle, put, logRow, db } = await fixture({ enabled: true, paceMs: 0, markers: ['nothing-has-this'] })
        const id = await put('assets/a.png', await markedPicture())
        await settle()
        expect(logRow(id)).toMatchObject({ outcome: 'not-marked' })
        const checks = logRow(id).checks
        // Marked as decided under older checks, with a detail only this test writes.
        db.prepare("UPDATE media_transcode_log SET checks = ?, detail = 'stale' WHERE id = ?").run(checks - 1, id)
        await settle()
        expect(logRow(id)).toMatchObject({ outcome: 'not-marked', checks, detail: null })
        // Decided under the current checks: left alone.
        db.prepare("UPDATE media_transcode_log SET detail = 'kept' WHERE id = ?").run(id)
        await settle()
        expect(logRow(id).detail).toBe('kept')
    })

    it('records an image that fails the picture comparison and leaves it as it is', async () => {
        const { settle, put, logRow, liveId } = await fixture({ enabled: true, paceMs: 0, maxDiff: 0, quality: 1 })
        const id = await put('assets/a.png', await markedPicture())
        await settle()
        expect(logRow(id)).toMatchObject({ outcome: 'failed-check' })
        expect(logRow(id).detail).toMatch(/mean/)
        expect(liveId('assets/a.png')).toBe(id)
    })
})

describe('media transcode: the encoder', () => {
    const stub = (body: string) => {
        const file = path.join(tmpdir(), `media-transcode-stub-${process.pid}-${Math.random().toString(16).slice(2)}.cjs`)
        writeFileSync(file, `const { parentPort } = require('node:worker_threads');\n${body}\n`)
        cleanup.push(async () => { await rm(file, { force: true }) })
        return file
    }

    it('waits and asks again when the encoder cannot start, recording nothing against the image', async () => {
        const workerPath = stub(`parentPort.on('message', () => parentPort.postMessage({ unavailable: 'wasm failed to load' }))`)
        const { transcode, put, logRow, logs } = await fixture({ enabled: true, paceMs: 0 }, { workerPath })
        const id = await put('assets/a.png', await markedPicture())
        expect(await transcode.pass()).toBe(600_000)
        expect(await transcode.pass()).toBe(600_000)
        expect(logRow(id)).toBeUndefined()
        expect(logs.filter(line => line.includes('encoder cannot start'))).toHaveLength(1)
    })

    it('abandons an encode that never answers and carries on with the next image', async () => {
        const workerPath = stub(`parentPort.on('message', () => {})`)
        const { settle, put, logRow } = await fixture({ enabled: true, paceMs: 0, itemTimeoutMinutes: 0.01 }, { workerPath })
        const first = await put('assets/a.png', await markedPicture(), 90)
        const second = await put('assets/b.png', await markedPicture(5), 60)
        await settle()
        expect(logRow(first)).toMatchObject({ outcome: 'error', attempts: 1 })
        expect(logRow(second)).toMatchObject({ outcome: 'error', attempts: 1 })
    })

    it('survives a worker that dies', async () => {
        const workerPath = stub(`parentPort.on('message', () => process.exit(3))`)
        const { settle, put, logRow } = await fixture({ enabled: true, paceMs: 0 }, { workerPath })
        const id = await put('assets/a.png', await markedPicture())
        await settle()
        expect(logRow(id)).toMatchObject({ outcome: 'error' })
        expect(logRow(id).detail).toMatch(/exited/)
    })

    it('stops promptly while it rests between images', async () => {
        const { transcode, put } = await fixture({ enabled: true, paceMs: 3_600_000 })
        await put('assets/a.png', await markedPicture())
        const running = transcode.pass()
        await new Promise(resolve => setTimeout(resolve, 1500))
        const started = Date.now()
        await transcode.stop()
        await running
        expect(Date.now() - started).toBeLessThan(5000)
    })
})

describe('media transcode: pinning and deleting originals', () => {
    async function converted(config: Record<string, any> = { enabled: true, paceMs: 0 }) {
        const context = await fixture(config)
        const png = await markedPicture()
        const original = await context.put('assets/a.png', png)
        await context.settle()
        return { ...context, png, original }
    }
    const cover = (context: any, name: string, lines: string[]) => {
        mkdirSync(context.transcode.paths.originalsDir, { recursive: true })
        writeFileSync(path.join(context.transcode.paths.originalsDir, name), lines.map(line => `${line}\n`).join(''))
    }
    const wantLines = (context: any) => readFileSync(context.transcode.paths.wantPath, 'utf-8').split('\n').filter(Boolean)
    const collectedLines = (context: any) => existsSync(context.transcode.paths.collectedDir)
        ? readdirSync(context.transcode.paths.collectedDir).flatMap(name => readFileSync(path.join(context.transcode.paths.collectedDir, name), 'utf-8').split('\n').filter(Boolean))
        : []

    it('asks for the replaced original to be pinned', async () => {
        const context = await converted()
        expect(wantLines(context)).toEqual([context.rel(context.original)])
    })

    it('deletes nothing that is not in a covered list, however old', async () => {
        const context = await converted()
        context.retireAge(context.original, 400)
        await context.transcode.housekeeping(context.transcode.readConfig())
        expect(existsSync(context.file(context.original))).toBe(true)
        expect(collectedLines(context)).toEqual([])
    })

    it('keeps a covered original until its retirement is old enough, then deletes it and tells the mirror', async () => {
        const context = await converted()
        const { transcode, original, db, rel, file } = context
        cover(context, 'pin-20261118T000000Z-abcdef12.covered', [rel(original), 'not/a/generation', '../../etc/passwd', ''])
        await transcode.housekeeping(transcode.readConfig())
        expect(existsSync(path.join(transcode.paths.originalsDir, 'pin-20261118T000000Z-abcdef12.covered'))).toBe(false)
        expect(db.prepare('SELECT path, manifest FROM media_originals').all()).toEqual([{ path: rel(original), manifest: 'pin-20261118T000000Z-abcdef12.covered' }])
        expect(existsSync(file(original))).toBe(true)
        expect(wantLines(context)).toEqual([])

        context.retireAge(original, 2)
        await transcode.housekeeping(transcode.readConfig())
        expect(existsSync(file(original))).toBe(true)

        context.retireAge(original, 4)
        await transcode.housekeeping(transcode.readConfig())
        expect(existsSync(file(original))).toBe(false)
        expect(db.prepare('SELECT count(*) n FROM asset_file_generations WHERE generationId = ?').get(original).n).toBe(0)
        const row = db.prepare('SELECT * FROM media_originals WHERE path = ?').get(rel(original))
        expect(row.deleted_at).toBeGreaterThan(0)
        expect(row.listed_at).toBeGreaterThan(0)
        expect(collectedLines(context)).toEqual([rel(original)])
        expect(isWebp(await context.store.get('assets/a.png'))).toBe(true)
        // The same deletion is not announced twice.
        await transcode.housekeeping(transcode.readConfig())
        expect(collectedLines(context)).toEqual([rel(original)])
    })

    it('announces a deletion again when the server stopped before the list was written', async () => {
        const context = await converted()
        const { transcode, original, db, rel } = context
        cover(context, 'pin-1.covered', [rel(original)])
        context.retireAge(original, 4)
        await transcode.housekeeping(transcode.readConfig())
        // As if the process had died after deleting and before listing.
        for (const name of readdirSync(transcode.paths.collectedDir)) unlinkSync(path.join(transcode.paths.collectedDir, name))
        db.prepare('UPDATE media_originals SET listed_at = NULL').run()
        await transcode.housekeeping(transcode.readConfig())
        expect(collectedLines(context)).toEqual([rel(original)])
    })

    it('does not delete while an export holds captured entries or a reader holds the scheduler', async () => {
        const context = await converted()
        const { transcode, original, store, rel, file } = context
        cover(context, 'pin-1.covered', [rel(original)])
        context.retireAge(original, 4)
        const captured = await store.capture()
        await transcode.housekeeping(transcode.readConfig())
        expect(existsSync(file(original))).toBe(true)
        await captured.dispose()
        const release = transcode.hold()
        await transcode.housekeeping(transcode.readConfig())
        expect(existsSync(file(original))).toBe(true)
        release()
        release()
        await transcode.housekeeping(transcode.readConfig())
        expect(existsSync(file(original))).toBe(false)
    })

    it('leaves a wanted file out of the list when it is not on disk', async () => {
        const context = await converted()
        unlinkSync(context.file(context.original))
        await context.transcode.housekeeping(context.transcode.readConfig())
        expect(wantLines(context)).toEqual([])
    })

    it('by default only wants originals it replaced; "all" adds every generation that was live once', async () => {
        const context = await converted()
        const { store, transcode, setConfig, liveId, original, rel, db } = context
        await store.put('assets/other.png', 'first')
        const replaced = liveId('assets/other.png')
        await store.put('assets/other.png', 'second')
        const prepared = await store.prepare('assets/pending.png', 'waiting for its publication')
        // Even a covered, long-retired generation is out of reach when it is not in scope.
        cover(context, 'pin-1.covered', [rel(replaced), rel(prepared.generationId)])
        context.retireAge(replaced, 400)
        context.retireAge(prepared.generationId, 400)
        await transcode.housekeeping(transcode.readConfig())
        expect(wantLines(context)).toEqual([rel(original)])
        expect(existsSync(context.file(replaced))).toBe(true)

        setConfig({ enabled: true, paceMs: 0, collect: 'all' })
        db.prepare('DELETE FROM media_originals').run()
        await transcode.housekeeping(transcode.readConfig())
        expect(wantLines(context).sort()).toEqual([rel(original), rel(replaced)].sort())

        cover(context, 'pin-2.covered', [rel(replaced), rel(prepared.generationId)])
        await transcode.housekeeping(transcode.readConfig())
        expect(existsSync(context.file(replaced))).toBe(false)
        // Prepared and never published: it may still be published, so it stays whatever the lists say.
        expect(existsSync(context.file(prepared.generationId))).toBe(true)
        await store.publishBatch([prepared])
        expect((await store.get('assets/pending.png')).toString()).toBe('waiting for its publication')
    })
})

describe('media transcode: configuration', () => {
    it('falls back per field and ignores what it does not know', () => {
        expect(normalizeConfig(null).enabled).toBe(false)
        expect(normalizeConfig('nonsense').ageDays).toBe(30)
        expect(normalizeConfig({ enabled: 'yes', ageDays: -1, quality: 500, markers: 'AssetMaid', collect: 'everything', future: 1 }))
            .toMatchObject({ enabled: false, ageDays: 30, quality: 90, markers: ['AssetMaid'], collect: 'transcoded' })
        expect(normalizeConfig({ enabled: 'report', ageDays: 0, markers: ['a', '', 3], collect: 'all', retentionDays: 0 }))
            .toMatchObject({ enabled: 'report', ageDays: 0, markers: ['a'], collect: 'all', retentionDays: 0 })
    })

    it('treats an unreadable configuration file as switched off', async () => {
        const { transcode, dir, put, logRow } = await fixture(null)
        writeFileSync(path.join(dir, 'media-transcode.json'), '{ not json')
        const id = await put('assets/a.png', await markedPicture())
        expect(await transcode.pass()).toBe(60_000)
        expect(logRow(id)).toBeUndefined()
    })
})
