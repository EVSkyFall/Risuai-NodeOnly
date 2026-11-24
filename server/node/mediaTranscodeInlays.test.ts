import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import storeModule from './assetFileStore.cjs'
import transcodeModule from './mediaTranscode.cjs'
import { insert, isWebp, picture } from './mediaTranscodeTestKit'

const { createAssetFileStore } = storeModule
const { createMediaTranscode, normalizeConfig } = transcodeModule
const DAY = 86_400_000
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action() })

async function fixture(config: Record<string, any> | null = { enabled: true, paceMs: 0 }, options: Record<string, any> = {}) {
    const dir = await mkdtemp(path.join(tmpdir(), 'media-transcode-inlays-'))
    const db = new Database(path.join(dir, 'test.db'))
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL)')
    const logs: string[] = []
    const logger = { warn: (s: string) => logs.push(`warn ${s}`), info: (s: string) => logs.push(`info ${s}`) }
    const store = createAssetFileStore(db, { saveDir: dir, logger })
    let chain: Promise<any> = Promise.resolve()
    const hooks: { beforeQueue?: () => void | Promise<void> } = {}
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
    const inlayDir = path.join(dir, 'inlays')
    mkdirSync(inlayDir)
    const busy = new Set<string>()
    const forgotten: string[] = []
    const transcode = createMediaTranscode({
        db, saveDir: dir, store, queue, logger,
        inlays: {
            dir: inlayDir,
            inUse: (id: string) => busy.has(id),
            // The same name the server gives a thumbnail: <id>.<floor(mtimeMs)>-<size>.
            forgetThumbnail: (id: string, stat: any) => { forgotten.push(`${id}.${Math.floor(stat.mtimeMs)}-${stat.size}`) },
        },
        ...options,
    })
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
    const png = (id: string) => path.join(inlayDir, `${id}.png`)
    const webp = (id: string) => path.join(inlayDir, `${id}.webp`)
    const sidecarFile = (id: string) => path.join(inlayDir, `${id}.meta.json`)
    const sidecar = (id: string) => JSON.parse(readFileSync(sidecarFile(id), 'utf-8'))
    // An odd number of milliseconds and a fraction, so the modification time is not a whole millisecond.
    const setAge = (file: string, days: number) => { const when = (Date.now() - days * DAY) / 1000 + 0.0004567; utimesSync(file, when, when) }
    const putInlay = (id: string, bytes: Buffer, days = 60, meta: Record<string, any> | null = {}) => {
        writeFileSync(png(id), bytes)
        if (meta) writeFileSync(sidecarFile(id), JSON.stringify({ ext: 'png', name: `${id} picture`, type: 'image', height: 480, width: 640, ...meta }))
        setAge(png(id), days)
    }
    const payloads = (id: string) => readdirSync(inlayDir).filter(name => name.startsWith(`${id}.`) && !name.endsWith('.meta.json')).sort()
    const thumbName = (id: string) => { const stat = statSync(png(id)); return `${id}.${Math.floor(stat.mtimeMs)}-${stat.size}` }
    const logRow = (id: string) => db.prepare('SELECT * FROM media_transcode_log WHERE id = ?').get(`inlay/${id}`) as any
    const original = (bytes: Buffer) => `media-originals/inlays/${sha(bytes)}.png`
    const originalFile = (bytes: Buffer) => path.join(dir, original(bytes))
    const originalRow = (bytes: Buffer) => db.prepare('SELECT * FROM media_originals WHERE path = ?').get(original(bytes)) as any
    const ageWant = (bytes: Buffer, days: number) => db.prepare('UPDATE media_originals SET wanted_at = ? WHERE path = ?').run(Date.now() - days * DAY, original(bytes))
    const wantList = () => existsSync(transcode.paths.wantPath) ? readFileSync(transcode.paths.wantPath, 'utf-8').split('\n').filter(Boolean) : []
    const cover = (name: string, lines: string[]) => {
        mkdirSync(transcode.paths.originalsDir, { recursive: true })
        writeFileSync(path.join(transcode.paths.originalsDir, name), lines.map(line => `${line}\n`).join(''))
    }
    const housekeeping = () => transcode.housekeeping(transcode.readConfig())
    const staged = () => existsSync(transcode.paths.inlayStagingDir) ? readdirSync(transcode.paths.inlayStagingDir) : []
    // Runs passes until the scheduler says there is nothing left for now.
    const settle = async () => { for (let i = 0; i < 50; i++) if (await transcode.pass() !== 0) return; throw new Error('never settled') }
    return { dir, db, store, transcode, setConfig, inlayDir, busy, forgotten, png, webp, sidecarFile, sidecar, setAge, putInlay, payloads,
        thumbName, logRow, original, originalFile, originalRow, ageWant, wantList, cover, housekeeping, staged, settle, logs, hooks }
}

describe('media transcode: converting inlays', () => {
    it('turns an old PNG inlay into a WebP, keeps the sidecar, and quarantines the original', async () => {
        const f = await fixture()
        const bytes = await picture()
        f.putInlay('a', bytes, 60, { custom: 'kept' })
        const thumbnail = f.thumbName('a')
        await f.settle()
        expect(readdirSync(f.inlayDir).sort()).toEqual(['.staging', 'a.meta.json', 'a.webp'])
        expect(f.staged()).toEqual([])
        const converted = readFileSync(f.webp('a'))
        expect(isWebp(converted)).toBe(true)
        expect(converted.length).toBeLessThan(bytes.length)
        expect(f.sidecar('a')).toEqual({ ext: 'webp', name: 'a picture', type: 'image', height: 480, width: 640, custom: 'kept' })
        expect(readFileSync(f.originalFile(bytes)).equals(bytes)).toBe(true)
        expect(readdirSync(f.transcode.paths.quarantineStagingDir)).toEqual([])
        expect(f.wantList()).toEqual([f.original(bytes)])
        const row = f.logRow('a')
        expect(row).toMatchObject({ kind: 'inlay', key: 'a', outcome: 'converted', result: null })
        expect(JSON.parse(row.detail)).toMatchObject({ from: bytes.length, to: converted.length, original: sha(bytes) })
        expect(f.originalRow(bytes)).toMatchObject({ generationId: sha(bytes), covered_at: null, deleted_at: null })
        expect(f.forgotten).toEqual([thumbnail])
        // Nothing is left to do, and a second search does nothing.
        await f.settle()
        expect(f.logRow('a').at).toBe(row.at)
        expect(readFileSync(f.webp('a')).equals(converted)).toBe(true)
        expect(f.logs.filter(line => line.startsWith('warn'))).toEqual([])
    })

    it('leaves alone what is young, a plugin inlay, not an image, without a usable sidecar, or oddly named', async () => {
        const f = await fixture()
        const bytes = await picture()
        f.putInlay('young', bytes, 5)
        f.putInlay('plugin-inlay-abc', bytes)
        f.putInlay('movie', bytes, 60, { type: 'video' })
        f.putInlay('bare', bytes, 60, null)
        f.putInlay('elsewhere', bytes, 60, { ext: 'jpg' })
        f.putInlay('selfnamed', bytes, 60, { ext: 'meta.json' })
        f.putInlay('listed', bytes, 60, null); writeFileSync(f.sidecarFile('listed'), '[1,2]')
        f.putInlay('broken', bytes, 60, null); writeFileSync(f.sidecarFile('broken'), '{not json')
        writeFileSync(path.join(f.inlayDir, '.png'), bytes); f.setAge(path.join(f.inlayDir, '.png'), 60)
        mkdirSync(path.join(f.inlayDir, 'folder.png'))
        await f.settle()
        for (const id of ['young', 'plugin-inlay-abc', 'movie', 'bare', 'elsewhere', 'selfnamed', 'listed', 'broken']) {
            expect(f.payloads(id), id).toEqual([`${id}.png`])
            expect(readFileSync(f.png(id)).equals(bytes), id).toBe(true)
            expect(f.logRow(id), id).toBeUndefined()
        }
        expect(existsSync(path.join(f.inlayDir, '.png'))).toBe(true)
        expect(existsSync(f.transcode.paths.quarantineDir)).toBe(false)
        expect(f.db.prepare('SELECT count(*) n FROM media_originals').get()).toEqual({ n: 0 })
        expect(f.logs.filter(line => line.startsWith('warn'))).toEqual([])
    })

    it('only reports while either switch says "report", does nothing while one says off, and converts when both are on', async () => {
        const bytes = await picture()
        for (const config of [{ enabled: 'report' }, { enabled: true, inlays: 'report' }]) {
            const f = await fixture({ ...config, paceMs: 0 })
            f.putInlay('a', bytes)
            await f.settle()
            expect(f.logRow('a')).toMatchObject({ outcome: 'would-convert' })
            expect(f.payloads('a')).toEqual(['a.png'])
            expect(f.sidecar('a').ext).toBe('png')
            // Nothing was staged or quarantined. (With assets live, media-originals itself exists for their want list.)
            expect(existsSync(f.transcode.paths.originalsDir)).toBe(config.enabled === true)
            expect(existsSync(f.transcode.paths.quarantineDir)).toBe(false)
            expect(existsSync(f.transcode.paths.inlayStagingDir)).toBe(false)
            const at = f.logRow('a').at
            await f.settle()
            expect(f.logRow('a').at).toBe(at)
            f.setConfig({ enabled: true, paceMs: 0 })
            await f.settle()
            expect(f.logRow('a')).toMatchObject({ outcome: 'converted' })
            expect(f.payloads('a')).toEqual(['a.webp'])
        }
        for (const config of [{ enabled: true, inlays: false }, { enabled: 'report', inlays: false }, { enabled: false, inlays: true }, null]) {
            const f = await fixture(config && { ...config, paceMs: 0 })
            f.putInlay('a', bytes)
            await f.settle()
            expect(f.logRow('a')).toBeUndefined()
            expect(f.payloads('a')).toEqual(['a.png'])
        }
    })

    it('remembers a decision for the same file and settings, and takes it again when either changes', async () => {
        const f = await fixture({ enabled: true, paceMs: 0, maxDiff: 0, quality: 1 })
        const bytes = await picture()
        f.putInlay('poor', bytes)
        f.putInlay('profiled', insert(bytes, 'gAMA', Buffer.from([0, 0, 0xb1, 0x8f])))
        await f.settle()
        const poor = f.logRow('poor'), profiled = f.logRow('profiled')
        expect(poor).toMatchObject({ outcome: 'failed-check' })
        expect(poor.basis).toMatch(/^\d+-\d+ 1\/0\/40$/)
        expect(profiled).toMatchObject({ outcome: 'not-plain-png' })
        expect(f.payloads('poor')).toEqual(['poor.png'])
        await new Promise(resolve => setTimeout(resolve, 5))
        await f.settle()
        expect(f.logRow('poor').at).toBe(poor.at)
        expect(f.logRow('profiled').at).toBe(profiled.at)
        // Other settings: the encode is tried again. The PNG that is not plain stays what it is.
        f.setConfig({ enabled: true, paceMs: 0 })
        await f.settle()
        expect(f.logRow('poor')).toMatchObject({ outcome: 'converted' })
        expect(f.logRow('profiled')).toMatchObject({ outcome: 'not-plain-png' })
        expect(f.logRow('profiled').at).not.toBe(profiled.at)
        // Another file under the same id is looked at afresh.
        f.putInlay('profiled', bytes, 45)
        await f.settle()
        expect(f.logRow('profiled')).toMatchObject({ outcome: 'converted' })
    })

    it('remembers that an image would not get smaller', async () => {
        const workerPath = path.join(tmpdir(), `media-transcode-notsmaller-${process.pid}-${Math.random().toString(16).slice(2)}.cjs`)
        writeFileSync(workerPath, "require('node:worker_threads').parentPort.on('message', function () { this.postMessage({ notSmaller: true }); });")
        cleanup.push(() => rm(workerPath, { force: true }))
        const f = await fixture({ enabled: true, paceMs: 0 }, { workerPath })
        f.putInlay('a', await picture())
        await f.settle()
        const row = f.logRow('a')
        expect(row).toMatchObject({ outcome: 'not-smaller' })
        await new Promise(resolve => setTimeout(resolve, 5))
        await f.settle()
        expect(f.logRow('a').at).toBe(row.at)
        expect(f.payloads('a')).toEqual(['a.png'])
    })
})

describe('media transcode: inlays, staying out of the way', () => {
    it('does not touch an inlay something else depends on, and converts it once it is free', async () => {
        const f = await fixture()
        const bytes = await picture()
        f.putInlay('a', bytes)
        f.busy.add('a')
        await f.settle()
        expect(f.payloads('a')).toEqual(['a.png'])
        expect(f.logRow('a')).toBeUndefined()
        expect(existsSync(f.transcode.paths.quarantineDir)).toBe(false)
        f.busy.delete('a')
        // It became busy between the encode and the switch: nothing is switched.
        f.hooks.beforeQueue = () => { f.busy.add('a') }
        await f.transcode.pass()
        expect(f.payloads('a')).toEqual(['a.png'])
        expect(f.sidecar('a').ext).toBe('png')
        expect(f.logRow('a')).toBeUndefined()
        expect(f.staged()).toEqual([])
        f.busy.delete('a')
        await f.settle()
        expect(f.payloads('a')).toEqual(['a.webp'])
    })

    it('gives up a switch when the PNG or its sidecar changed in the meantime', async () => {
        const f = await fixture()
        const first = await picture(640, 480, 3), second = await picture(640, 480, 5)
        f.putInlay('a', first)
        f.hooks.beforeQueue = () => { f.putInlay('a', second, 45) }
        await f.transcode.pass()
        expect(f.payloads('a')).toEqual(['a.png'])
        expect(readFileSync(f.png('a')).equals(second)).toBe(true)
        expect(f.logRow('a')).toBeUndefined()
        expect(f.staged()).toEqual([])
        await f.settle()
        expect(f.payloads('a')).toEqual(['a.webp'])
        expect(JSON.parse(f.logRow('a').detail).original).toBe(sha(second))
        // The copy of the first picture that was already in quarantine is wanted too, so it does not stay there for good.
        expect(f.wantList().sort()).toEqual([f.original(first), f.original(second)].sort())

        f.putInlay('b', first)
        f.hooks.beforeQueue = () => { writeFileSync(f.sidecarFile('b'), JSON.stringify({ ...f.sidecar('b'), name: 'renamed' })) }
        await f.transcode.pass()
        expect(f.payloads('b')).toEqual(['b.png'])
        expect(f.sidecar('b')).toMatchObject({ ext: 'png', name: 'renamed' })
        await f.settle()
        expect(f.sidecar('b')).toMatchObject({ ext: 'webp', name: 'renamed' })
    })

    it('switches and deletes nothing while a hold is active', async () => {
        const f = await fixture()
        const done = await picture(640, 480, 3), waiting = await picture(640, 480, 5)
        f.putInlay('done', done)
        await f.settle()
        f.cover('pin-1.covered', [f.original(done)])
        await f.housekeeping()
        f.ageWant(done, 4)
        f.putInlay('waiting', waiting)
        const release = f.transcode.hold()
        await f.settle()
        await f.housekeeping()
        expect(f.payloads('waiting')).toEqual(['waiting.png'])
        expect(f.logRow('waiting')).toBeUndefined()
        expect(existsSync(f.originalFile(done))).toBe(true)
        release()
        await f.settle()
        expect(f.payloads('waiting')).toEqual(['waiting.webp'])
        expect(existsSync(f.originalFile(done))).toBe(false)
    })

    it('does nothing while an import has paused the asset store', async () => {
        const f = await fixture()
        f.putInlay('a', await picture())
        const resume = f.store.pauseMigration()
        expect(await f.transcode.pass()).toBe(60_000)
        expect(f.payloads('a')).toEqual(['a.png'])
        expect(f.logRow('a')).toBeUndefined()
        resume()
        await f.settle()
        expect(f.payloads('a')).toEqual(['a.webp'])
    })
})

describe('media transcode: inlay originals', () => {
    it('deletes an original only after a receipt names its exact path and the retention has passed', async () => {
        const f = await fixture()
        const pinned = await picture(640, 480, 3), unpinned = await picture(640, 480, 5)
        f.putInlay('pinned', pinned)
        f.putInlay('unpinned', unpinned)
        await f.settle()
        const hash = sha(unpinned)
        f.cover('pin-20261124T000000Z-abcdef01.covered', [
            f.original(pinned),
            `media-originals/inlays/../inlays/${hash}.png`,
            `media-originals/inlays/${hash.toUpperCase()}.png`,
            `media-originals/inlays/${hash}.png `,
            `media-originals/staging/${hash}.png`,
            `media-originals/inlays/sub/${hash}.png`,
            `inlays/${hash}.png`,
            `media-originals/inlays/${hash}.webp`,
        ])
        await f.housekeeping()
        expect(f.originalRow(pinned)).toMatchObject({ manifest: 'pin-20261124T000000Z-abcdef01.covered' })
        expect(f.originalRow(pinned).covered_at).not.toBeNull()
        expect(f.originalRow(unpinned).covered_at).toBeNull()
        expect(f.db.prepare('SELECT count(*) n FROM media_originals').get()).toEqual({ n: 2 })
        expect(f.wantList()).toEqual([f.original(unpinned)])
        // Pinned, but not yet three days.
        expect(existsSync(f.originalFile(pinned))).toBe(true)
        f.ageWant(pinned, 4)
        f.ageWant(unpinned, 40)
        await f.housekeeping()
        expect(existsSync(f.originalFile(pinned))).toBe(false)
        expect(existsSync(f.originalFile(unpinned))).toBe(true)
        const row = f.originalRow(pinned)
        expect(row.deleted_at).not.toBeNull()
        expect(row.listed_at).toBe(row.deleted_at)
        expect(row.manifest).toBe('pin-20261124T000000Z-abcdef01.covered')
        // Inlays have no mirror: nothing is announced.
        expect(existsSync(f.transcode.paths.collectedDir) ? readdirSync(f.transcode.paths.collectedDir) : []).toEqual([])
        // The inlays themselves are untouched by all this.
        expect(f.payloads('pinned')).toEqual(['pinned.webp'])
        expect(f.payloads('unpinned')).toEqual(['unpinned.webp'])
    })

    it('keeps following an original after its inlay was removed', async () => {
        const f = await fixture()
        const bytes = await picture()
        f.putInlay('a', bytes)
        await f.settle()
        unlinkSync(f.webp('a')); unlinkSync(f.sidecarFile('a'))
        f.cover('pin-1.covered', [f.original(bytes)])
        await f.housekeeping()
        f.ageWant(bytes, 4)
        await f.housekeeping()
        expect(existsSync(f.originalFile(bytes))).toBe(false)
        expect(f.originalRow(bytes).deleted_at).not.toBeNull()
    })

    it('wants whatever lies in quarantine under its true name, and leaves alone what does not', async () => {
        const f = await fixture()
        const stray = await picture(640, 480, 3), wrong = await picture(640, 480, 5)
        mkdirSync(f.transcode.paths.quarantineDir, { recursive: true })
        writeFileSync(f.originalFile(stray), stray)
        const misnamed = path.join(f.transcode.paths.quarantineDir, `${'0'.repeat(64)}.png`)
        writeFileSync(misnamed, wrong)
        writeFileSync(path.join(f.transcode.paths.quarantineDir, 'notes.txt'), 'not an original')
        await f.housekeeping()
        await f.housekeeping()
        expect(f.wantList()).toEqual([f.original(stray)])
        expect(f.db.prepare('SELECT count(*) n FROM media_originals').get()).toEqual({ n: 1 })
        expect(readFileSync(misnamed).equals(wrong)).toBe(true)
        expect(f.logs.filter(line => line.includes('does not have the content its name says'))).toHaveLength(1)
    })

    it('asks for a new pin when the same bytes come back after their original was deleted', async () => {
        const f = await fixture()
        const bytes = await picture()
        f.putInlay('a', bytes)
        await f.settle()
        f.cover('pin-1.covered', [f.original(bytes)])
        await f.housekeeping()
        f.ageWant(bytes, 4)
        await f.housekeeping()
        expect(existsSync(f.originalFile(bytes))).toBe(false)
        // The same picture under another id, a month later.
        f.putInlay('b', bytes)
        await f.settle()
        expect(f.payloads('b')).toEqual(['b.webp'])
        expect(existsSync(f.originalFile(bytes))).toBe(true)
        expect(f.originalRow(bytes)).toMatchObject({ covered_at: null, manifest: null, deleted_at: null, listed_at: null })
        expect(f.wantList()).toEqual([f.original(bytes)])
        // Also when the file reappears without a conversion (a switch that never got to its record).
        f.cover('pin-2.covered', [f.original(bytes)])
        await f.housekeeping()
        f.ageWant(bytes, 4)
        await f.housekeeping()
        expect(f.originalRow(bytes).deleted_at).not.toBeNull()
        writeFileSync(f.originalFile(bytes), bytes)
        await f.housekeeping()
        expect(f.originalRow(bytes)).toMatchObject({ covered_at: null, deleted_at: null })
        expect(f.wantList()).toEqual([f.original(bytes)])
    })

    it('starts the retention again when the same bytes are converted while their original is still there', async () => {
        const f = await fixture()
        const bytes = await picture()
        f.putInlay('a', bytes)
        await f.settle()
        f.cover('pin-1.covered', [f.original(bytes)])
        await f.housekeeping()
        // Pinned long ago and due, but before the housekeeping gets to it the same picture is converted under another id.
        f.ageWant(bytes, 4)
        f.putInlay('b', bytes)
        await f.settle()
        expect(f.payloads('b')).toEqual(['b.webp'])
        expect(existsSync(f.originalFile(bytes))).toBe(true)
        const row = f.originalRow(bytes)
        expect(row.covered_at).not.toBeNull()
        expect(row.deleted_at).toBeNull()
        expect(Date.now() - row.wanted_at).toBeLessThan(60_000)
    })

    it('records a deletion whose record was lost, and forgets an unpinned original that vanished', async () => {
        const f = await fixture()
        const pinned = await picture(640, 480, 3), unpinned = await picture(640, 480, 5)
        f.putInlay('pinned', pinned)
        f.putInlay('unpinned', unpinned)
        await f.settle()
        f.cover('pin-1.covered', [f.original(pinned)])
        await f.housekeeping()
        f.ageWant(pinned, 4)
        unlinkSync(f.originalFile(pinned))
        unlinkSync(f.originalFile(unpinned))
        await f.housekeeping()
        expect(f.originalRow(pinned)).toMatchObject({ manifest: 'pin-1.covered' })
        expect(f.originalRow(pinned).deleted_at).not.toBeNull()
        expect(f.originalRow(unpinned)).toBeUndefined()
        expect(f.wantList()).toEqual([])
    })
})

describe('media transcode: what an interrupted switch leaves behind', () => {
    it('converts again when only the record of the switch was written', async () => {
        const f = await fixture()
        const bytes = await picture()
        f.putInlay('a', bytes)
        const stat = statSync(f.png('a'), { bigint: true })
        f.db.prepare(`INSERT INTO media_transcode_log (id, kind, key, outcome, basis, checks, at)
            VALUES ('inlay/a', 'inlay', 'a', 'converted', ?, 1, 1)`).run(`${stat.mtimeNs}-${stat.size} 90/4/40`)
        await f.settle()
        expect(f.payloads('a')).toEqual(['a.webp'])
        expect(f.sidecar('a').ext).toBe('webp')
        expect(f.logRow('a').at).not.toBe(1)
    })

    it('replaces a stray WebP when the sidecar still names the PNG', async () => {
        const f = await fixture()
        const bytes = await picture()
        f.putInlay('a', bytes)
        writeFileSync(f.webp('a'), 'left over')
        await f.settle()
        expect(f.payloads('a')).toEqual(['a.webp'])
        expect(isWebp(readFileSync(f.webp('a')))).toBe(true)
        expect(f.sidecar('a').ext).toBe('webp')
        expect(readFileSync(f.originalFile(bytes)).equals(bytes)).toBe(true)
    })

    it('removes the PNG through quarantine when the sidecar already names the WebP', async () => {
        const f = await fixture()
        const bytes = await picture()
        f.putInlay('a', bytes, 60, { ext: 'webp' })
        writeFileSync(f.webp('a'), 'the new payload')
        const thumbnail = f.thumbName('a')
        await f.settle()
        expect(f.payloads('a')).toEqual(['a.webp'])
        expect(readFileSync(f.webp('a'), 'utf-8')).toBe('the new payload')
        expect(f.sidecar('a').ext).toBe('webp')
        expect(readFileSync(f.originalFile(bytes)).equals(bytes)).toBe(true)
        expect(f.wantList()).toEqual([f.original(bytes)])
        expect(f.forgotten).toEqual([thumbnail])
    })

    it('leaves that PNG where it is in report mode, under a hold, and while the inlay is in use', async () => {
        const bytes = await picture()
        const report = await fixture({ enabled: true, inlays: 'report', paceMs: 0 })
        report.putInlay('a', bytes, 60, { ext: 'webp' })
        writeFileSync(report.webp('a'), 'the new payload')
        await report.settle()
        expect(report.payloads('a')).toEqual(['a.png', 'a.webp'])
        expect(existsSync(report.transcode.paths.quarantineDir)).toBe(false)

        const f = await fixture()
        f.putInlay('a', bytes, 60, { ext: 'webp' })
        writeFileSync(f.webp('a'), 'the new payload')
        const release = f.transcode.hold()
        await f.settle()
        expect(f.payloads('a')).toEqual(['a.png', 'a.webp'])
        release()
        f.busy.add('a')
        await f.settle()
        expect(f.payloads('a')).toEqual(['a.png', 'a.webp'])
        f.busy.delete('a')
        await f.settle()
        expect(f.payloads('a')).toEqual(['a.webp'])
    })
})

describe('media transcode: inlay configuration', () => {
    it('follows `enabled` unless told otherwise', () => {
        expect(normalizeConfig({}).inlays).toBe(true)
        expect(normalizeConfig({ inlays: false }).inlays).toBe(false)
        expect(normalizeConfig({ inlays: 'report' }).inlays).toBe('report')
        expect(normalizeConfig({ inlays: 'yes' }).inlays).toBe(true)
        expect(normalizeConfig({ inlays: null }).inlays).toBe(true)
    })
})
