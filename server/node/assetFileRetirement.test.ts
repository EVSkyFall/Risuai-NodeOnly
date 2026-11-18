import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import storeModule from './assetFileStore.cjs'
import io from './assetFileIO.cjs'

const { createAssetFileStore } = storeModule
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action() })

async function fixture(prepareDb: (db: any) => void = () => {}) {
    const dir = await mkdtemp(path.join(tmpdir(), 'asset-retirement-'))
    const db = new Database(path.join(dir, 'test.db'))
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL)')
    prepareDb(db)
    const store = createAssetFileStore(db, { saveDir: dir, logger: { warn: () => {} } })
    cleanup.push(async () => { await store.close(); db.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
    const liveId = (key: string) => db.prepare('SELECT generationId FROM asset_file_generations WHERE key = ? AND retired = 0').get(key)?.generationId
    const retiredAt = (id: string) => db.prepare('SELECT retired_at FROM asset_file_retirements WHERE generationId = ?').get(id)?.retired_at
    const file = (id: string) => io.generationPath(store.root, id)
    return { dir, db, store, liveId, retiredAt, file }
}

describe('asset generation retirement times', () => {
    it('stamps a generation when a newer one replaces it and when its key is removed', async () => {
        const { store, liveId, retiredAt } = await fixture()
        const before = Date.now() - 1000
        await store.put('assets/a.png', 'one')
        const first = liveId('assets/a.png')
        expect(retiredAt(first)).toBeUndefined()
        await store.put('assets/a.png', 'two')
        const second = liveId('assets/a.png')
        expect(second).not.toBe(first)
        expect(retiredAt(first)).toBeGreaterThanOrEqual(before)
        expect(retiredAt(second)).toBeUndefined()
        await store.remove('assets/a.png')
        expect(retiredAt(second)).toBeGreaterThanOrEqual(before)
    })

    it('stamps generations retired by a kv write and by an import clearing everything', async () => {
        const { store, db, liveId, retiredAt } = await fixture()
        await store.put('assets/a.png', 'one')
        await store.put('assets/b.png', 'two')
        const a = liveId('assets/a.png')
        const b = liveId('assets/b.png')
        // A raw kv write (old import code) retires the file generation through the kv trigger.
        db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('assets/a.png', Buffer.from('legacy'), 5)
        expect(liveId('assets/a.png')).toBeUndefined()
        expect(retiredAt(a)).toBeGreaterThan(0)
        store.legacyBatchSync((batch: any) => batch.clear())
        expect(retiredAt(b)).toBeGreaterThan(0)
    })

    it('stamps a prepared generation and clears the stamp once it is published', async () => {
        const { store, liveId, retiredAt } = await fixture()
        const prepared = await store.prepare('assets/a.png', 'bytes')
        expect(retiredAt(prepared.generationId)).toBeGreaterThan(0)
        await store.publishBatch([prepared])
        expect(liveId('assets/a.png')).toBe(prepared.generationId)
        expect(retiredAt(prepared.generationId)).toBeUndefined()
    })

    it('leaves a migrated generation unstamped', async () => {
        const { store, db, liveId, retiredAt } = await fixture()
        db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('assets/m.png', Buffer.from('legacy'), 5)
        expect(await store.migrateOne('assets/m.png')).toBe(true)
        expect(retiredAt(liveId('assets/m.png'))).toBeUndefined()
    })

    it('stamps rows that were retired before the times were recorded', async () => {
        const { db, retiredAt } = await fixture((raw) => {
            raw.exec(`CREATE TABLE asset_file_generations (
                generationId TEXT PRIMARY KEY, key TEXT NOT NULL, size INTEGER NOT NULL,
                sha256 TEXT NOT NULL, updated_at INTEGER NOT NULL, retired INTEGER NOT NULL DEFAULT 0)`)
            raw.prepare('INSERT INTO asset_file_generations VALUES (?, ?, 1, ?, 5, 1)').run('old-retired', 'assets/x.png', 'h')
            raw.prepare('INSERT INTO asset_file_generations VALUES (?, ?, 1, ?, 5, 0)').run('old-live', 'assets/x.png', 'h')
        })
        expect(retiredAt('old-retired')).toBeGreaterThan(Date.now() - 60_000)
        expect(retiredAt('old-live')).toBeUndefined()
        expect(db.prepare('SELECT count(*) n FROM asset_file_retirements').get().n).toBe(1)
        expect(db.prepare('SELECT was_live FROM asset_file_retirements').get().was_live).toBe(0)
    })

    it('stamps old rows only when the table first appears, not on every start', async () => {
        const { dir, db, retiredAt } = await fixture()
        // As if a row had lost its stamp while the server was down.
        db.prepare('INSERT INTO asset_file_generations VALUES (?, ?, 1, ?, 5, 0)').run('late', 'assets/y.png', 'h')
        db.prepare('UPDATE asset_file_generations SET retired = 1 WHERE generationId = ?').run('late')
        db.prepare('DELETE FROM asset_file_retirements').run()
        const again = createAssetFileStore(db, { saveDir: dir, logger: { warn: () => {} } })
        cleanup.push(async () => { await again.close() })
        expect(retiredAt('late')).toBeUndefined()
        // Without a stamp it is simply never deleted.
        expect(again.deleteRetired('late', Date.now() + 86_400_000)).toBe(false)
    })
})

describe('publishIfCurrent', () => {
    it('replaces the generation it was derived from and keeps the old file', async () => {
        const { store, db, liveId, retiredAt, file } = await fixture()
        await store.put('assets/a.png', 'png bytes')
        const source = liveId('assets/a.png')
        const entry = await store.writeDetached('assets/a.png', 'webp bytes')
        expect(db.prepare('SELECT count(*) n FROM asset_file_generations WHERE generationId = ?').get(entry.generationId).n).toBe(0)
        expect(store.publishIfCurrent('assets/a.png', source, entry)).toBe(true)
        expect(liveId('assets/a.png')).toBe(entry.generationId)
        expect((await store.get('assets/a.png')).toString()).toBe('webp bytes')
        expect(retiredAt(source)).toBeGreaterThan(0)
        expect(existsSync(file(source))).toBe(true)
        expect(db.prepare("SELECT count(*) n FROM kv WHERE key = 'assets/a.png'").get().n).toBe(0)
    })

    it('publishes nothing when the key moved on, and leaves the newer bytes live', async () => {
        const { store, db, liveId, file } = await fixture()
        await store.put('assets/a.png', 'png bytes')
        const source = liveId('assets/a.png')
        const entry = await store.writeDetached('assets/a.png', 'stale webp')
        await store.put('assets/a.png', 'newer png')
        const newer = liveId('assets/a.png')
        expect(store.publishIfCurrent('assets/a.png', source, entry)).toBe(false)
        expect(liveId('assets/a.png')).toBe(newer)
        expect((await store.get('assets/a.png')).toString()).toBe('newer png')
        // Nothing was registered for the unused file; the caller removes it.
        expect(db.prepare('SELECT count(*) n FROM asset_file_generations WHERE generationId = ?').get(entry.generationId).n).toBe(0)
        expect(existsSync(file(entry.generationId))).toBe(true)
        expect(store.discardDetached(entry.generationId)).toBe(true)
        expect(existsSync(file(entry.generationId))).toBe(false)
        // A generation the catalog knows is never discarded this way.
        expect(store.discardDetached(newer)).toBe(false)
        expect(existsSync(file(newer))).toBe(true)
    })

    it('publishes nothing for a key that was removed', async () => {
        const { store, liveId } = await fixture()
        await store.put('assets/a.png', 'png bytes')
        const source = liveId('assets/a.png')
        const entry = await store.writeDetached('assets/a.png', 'webp')
        await store.remove('assets/a.png')
        expect(store.publishIfCurrent('assets/a.png', source, entry)).toBe(false)
        expect(await store.get('assets/a.png')).toBeNull()
    })
})

describe('deleteRetired', () => {
    async function retiredFixture() {
        const context = await fixture()
        await context.store.put('assets/a.png', 'one')
        const first = context.liveId('assets/a.png')
        await context.store.put('assets/a.png', 'two')
        return { ...context, first, second: context.liveId('assets/a.png') }
    }

    it('keeps a generation retired after the given time, deletes one retired before it', async () => {
        const { store, db, first, retiredAt, file } = await retiredFixture()
        const stamp = retiredAt(first)
        expect(store.deleteRetired(first, stamp - 1)).toBe(false)
        expect(existsSync(file(first))).toBe(true)
        expect(store.deleteRetired(first, stamp)).toBe(true)
        expect(existsSync(file(first))).toBe(false)
        expect(db.prepare('SELECT count(*) n FROM asset_file_generations WHERE generationId = ?').get(first).n).toBe(0)
        expect(retiredAt(first)).toBeUndefined()
        expect((await store.get('assets/a.png')).toString()).toBe('two')
    })

    it('never deletes a live generation or an unknown one', async () => {
        const { store, second, file } = await retiredFixture()
        expect(store.deleteRetired(second, Date.now() + 86_400_000)).toBe(false)
        expect(existsSync(file(second))).toBe(true)
        expect(store.deleteRetired('f'.repeat(64), Date.now() + 86_400_000)).toBe(false)
    })

    it('never calls a retirement without a recorded time old enough', async () => {
        const { store, db, first, file } = await retiredFixture()
        db.prepare('DELETE FROM asset_file_retirements WHERE generationId = ?').run(first)
        expect(store.deleteRetired(first, Date.now() + 86_400_000)).toBe(false)
        expect(existsSync(file(first))).toBe(true)
    })

    it('clears the row of a generation whose file is already gone', async () => {
        const { store, db, first, file } = await retiredFixture()
        await unlink(file(first))
        expect(store.deleteRetired(first, Date.now() + 86_400_000)).toBe(true)
        expect(db.prepare('SELECT count(*) n FROM asset_file_generations WHERE generationId = ?').get(first).n).toBe(0)
    })

    it('waits while an export holds captured entries or an import has paused the store', async () => {
        const { store, first, file } = await retiredFixture()
        const captured = await store.capture()
        expect(store.deleteRetired(first, Date.now() + 86_400_000)).toBe(false)
        await captured.dispose()
        const resume = store.pauseMigration()
        expect(store.deleteRetired(first, Date.now() + 86_400_000)).toBe(false)
        resume()
        expect(existsSync(file(first))).toBe(true)
        expect(store.deleteRetired(first, Date.now() + 86_400_000)).toBe(true)
    })

    it('records whether a retired generation was ever live', async () => {
        const { store, db, first } = await retiredFixture()
        const prepared = await store.prepare('assets/b.png', 'never published')
        const wasLive = (id: string) => db.prepare('SELECT was_live FROM asset_file_retirements WHERE generationId = ?').get(id)?.was_live
        expect(wasLive(first)).toBe(1)
        expect(wasLive(prepared.generationId)).toBe(0)
        // Published and replaced later, it counts as having been live.
        await store.publishBatch([prepared])
        expect(wasLive(prepared.generationId)).toBeUndefined()
        await store.put('assets/b.png', 'replacement')
        expect(wasLive(prepared.generationId)).toBe(1)
    })
})
