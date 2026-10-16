import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import storeModule from './assetFileStore.cjs'
import transport from './assetFileTransport.cjs'

const { createAssetFileStore } = storeModule
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action() })

async function fixture(options: Record<string, any> = {}) {
    const dir = await mkdtemp(path.join(tmpdir(), 'asset-file-store-'))
    const db = new Database(path.join(dir, 'test.db'))
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL)')
    const logs: string[] = []
    const store = createAssetFileStore(db, { saveDir: dir, logger: { warn: (s: string) => logs.push(s) }, ...options })
    cleanup.push(async () => { await store.close(); db.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
    const seed = (key: string, value: string | Buffer, time = 123) => db.prepare('INSERT OR REPLACE INTO kv VALUES (?, ?, ?)').run(key, Buffer.from(value), time)
    return { dir, db, store, seed, logs }
}

async function bytes(stream: AsyncIterable<Buffer>) {
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk)
    return Buffer.concat(chunks)
}

describe('asset file store', () => {
    it('filters settings keys before staging excluded legacy assets', async () => {
        let writes = 0
        const { store, seed } = await fixture({ checkpoint: async (stage: string) => { if (stage === 'temp-write') writes++ } })
        seed('assets/excluded', Buffer.alloc(1024 * 1024))
        seed('assets/kept', 'icon')
        const entries = await store.capture('assets/', (key: string) => key === 'assets/kept')
        expect(entries.map((e: any) => e.key)).toEqual(['assets/kept'])
        expect(writes).toBe(0)
        expect((await store.stats()).assetFileBytes).toBe(0)
        expect(await readFile(entries[0].sourcePath, 'utf8')).toBe('icon')
        await entries.dispose()
    })

    it('captures mutable non-asset archive bytes before declaring their sizes', async () => {
        const { dir, store, seed, db } = await fixture()
        const sourcePath = path.join(dir, 'inlay.meta.json')
        await writeFile(sourcePath, 'original')
        seed('plugin/a', 'value')
        const captured = await store.captureEntries([
            { kind: 'sidecar', sourcePath, backupName: 'inlay_sidecar/a', size: 3 },
            { kind: 'kv', key: 'plugin/a', backupName: 'plugin/a', size: 3 },
        ])
        await writeFile(sourcePath, 'replacement')
        db.prepare('DELETE FROM kv WHERE key = ?').run('plugin/a')
        for (const [i, entry] of captured.entries()) {
            const encoded = await bytes(transport.backupEntryChunks(entry))
            const nameLength = encoded.readUInt32LE(0)
            expect(encoded.readUInt32LE(4 + nameLength)).toBe(entry.size)
            expect(encoded.subarray(8 + nameLength).toString()).toBe(i === 0 ? 'original' : 'value')
        }
        await captured.dispose()
    })

    it('preserves keys, zero bytes, case, unicode, prefixes and Windows-safe physical paths', async () => {
        const { store } = await fixture()
        const keys = ['assets/CON', 'assets/a?.PNG', 'assets/A?.PNG', 'assets/한글/../NUL:aux', 'assets/' + 'long'.repeat(200)]
        for (const [i, key] of keys.entries()) await store.put(key, Buffer.alloc(i, i))
        for (const [i, key] of keys.entries()) {
            expect(await store.get(key)).toEqual(Buffer.alloc(i, i))
            expect(await store.stat(key)).toMatchObject({ size: i })
        }
        expect((await store.list('assets/A')).map((r: any) => r.key).sort()).toEqual(['assets/A?.PNG', 'assets/a?.PNG'])
        for (const entry of await store.capture()) {
            expect(path.relative(store.root, entry.sourcePath).split(path.sep)).toEqual([
                entry.generationId.slice(0, 2), entry.generationId + '.blob',
            ])
            expect(entry.generationId).toMatch(/^[a-f0-9]{64}$/)
        }
        expect(/^[0-9a-fA-F]+$/.test(path.basename(store.root))).toBe(false)
    })

    it('worker migrates bytes, preserves timestamp and retires generations without unlinking', async () => {
        const { db, store, seed } = await fixture()
        seed('assets/a', 'old', 42)
        expect(await store.migrateOne('assets/a')).toBe(true)
        expect(await store.stat('assets/a')).toMatchObject({ size: 3, updated_at: 42 })
        const [old] = await store.capture()
        expect(db.prepare('SELECT * FROM kv').all()).toEqual([])
        await store.put('assets/a', Buffer.from('new'))
        await store.remove('assets/a')
        expect(await store.get('assets/a')).toBeNull()
        expect(await readFile(old.sourcePath, 'utf8')).toBe('old')
        expect(db.prepare('SELECT retired FROM asset_file_generations').all()).toEqual([{ retired: 1 }, { retired: 1 }])
        expect(await store.stats()).toEqual({ assetFileBytes: 6, fileSize: 0 })
    })

    it.each(['overwrite', 'delete', 'reinsert', 'import'])('does not publish stale migration after concurrent %s', async action => {
        let entered!: () => void, release!: () => void
        const reached = new Promise<void>(r => { entered = r })
        const resume = new Promise<void>(r => { release = r })
        const { store, db, seed } = await fixture({ checkpoint: async (stage: string) => {
            if (stage === 'pre-publish') { entered(); await resume }
        } })
        seed('assets/a', 'original', 99)
        const migrating = store.migrateOne('assets/a')
        await reached
        if (action === 'delete') await store.remove('assets/a')
        else if (action === 'reinsert') {
            db.prepare('DELETE FROM kv WHERE key = ?').run('assets/a')
            seed('assets/a', 'original', 99)
        } else if (action === 'import') {
            await store.withMigrationPaused(() => store.legacyBatch((writer: any) => { writer.clear(); writer.put('assets/a', Buffer.from('imported')) }))
        } else seed('assets/a', 'new', 99)
        release()
        expect(await migrating).toBe(false)
        expect((await store.get('assets/a'))?.toString() ?? null).toBe(action === 'delete' ? null : action === 'import' ? 'imported' : action === 'reinsert' ? 'original' : 'new')
    })

    it('invalidates already dispatched work across a gate even when the source is unchanged', async () => {
        let release!: () => void, reached!: () => void
        const wait = new Promise<void>(r => { release = r })
        const entered = new Promise<void>(r => { reached = r })
        const { store, seed } = await fixture({ checkpoint: async () => { reached(); await wait } })
        seed('assets/a', 'a')
        const migration = store.migrateOne('assets/a')
        await entered
        await store.withMigrationPaused(async () => { expect(await store.migrateOne('assets/a')).toBe(false) })
        release()
        expect(await migration).toBe(false)
        expect(await store.migrateOne('assets/a')).toBe(true)
    })

    it('falls back to KV and retires stale mapping; double failure keeps the original bytes', async () => {
        const { store, db, logs } = await fixture()
        await store.put('assets/a', Buffer.from('file'))
        const io = await import('node:fs/promises')
        const broken = createAssetFileStore(db, { saveDir: path.dirname(store.root), io: { ...io, mkdir: async () => { throw new Error('synthetic disk failure') } }, logger: { warn: (s: string) => logs.push(s) } })
        await broken.put('assets/a', Buffer.from('fallback'))
        expect((await store.get('assets/a')).toString()).toBe('fallback')
        expect(await store.stat('assets/a')).not.toHaveProperty('generationId')
        db.exec("CREATE TRIGGER fail_put BEFORE UPDATE ON kv BEGIN SELECT RAISE(ABORT, 'synthetic DB failure'); END")
        await expect(broken.put('assets/a', Buffer.from('lost'))).rejects.toThrow('synthetic DB failure')
        expect((await store.get('assets/a')).toString()).toBe('fallback')
        expect(logs.join('\n')).toContain('synthetic disk failure')
        db.exec('DROP TRIGGER fail_put')
        expect(await store.migrateOne('assets/a')).toBe(true)
        await broken.close()
    })

    it('keeps a legacy hex import from replacing an existing file mapping and rolls back failed imports', async () => {
        const { store } = await fixture()
        await store.put('assets/a', Buffer.from('current'))
        await store.legacyBatch((writer: any) => writer.put('assets/a', Buffer.from('old hex'), { ignoreExisting: true }))
        expect((await store.get('assets/a')).toString()).toBe('current')
        await expect(store.legacyBatch((writer: any) => { writer.clear(); writer.put('assets/b', Buffer.from('b')); throw new Error('abort') })).rejects.toThrow('abort')
        expect((await store.get('assets/a')).toString()).toBe('current')
        expect(await store.get('assets/b')).toBeNull()
    })

    it.each([0, 1, 2])('captures exact archive bytes with %i migrated assets, despite subsequent overwrite/import', async migrated => {
        const { store, seed } = await fixture()
        seed('assets/a.png', 'aaa'); seed('assets/b.webp', 'bbbbb')
        for (const key of ['assets/a.png', 'assets/b.webp'].slice(0, migrated)) await store.migrateOne(key)
        const captured = await store.capture()
        await store.put('assets/a.png', Buffer.from('much longer replacement'))
        await store.legacyBatch((writer: any) => { writer.clear(); writer.put('assets/b.webp', Buffer.from('changed')) })
        const output: Buffer[] = []
        for (const entry of captured) output.push(await bytes(transport.backupEntryChunks({ ...entry, backupName: path.basename(entry.key) })))
        const archive = Buffer.concat(output)
        expect(archive.length).toBe(captured.reduce((n: number, e: any) => n + 8 + Buffer.byteLength(path.basename(e.key)) + e.size, 0))
        const source = await readFile(new URL('./server.cjs', import.meta.url), 'utf8')
        const parserSource = source.slice(source.indexOf('async function parseBackupChunk('), source.indexOf('// ─── Shared backup import logic'))
        const parse = new Function('Buffer', parserSource + ';return parseBackupChunk')(Buffer)
        await store.legacyBatch((writer: any) => writer.clear())
        expect((await parse(archive, async (name: string, value: Buffer) => store.legacyBatch((writer: any) => writer.put('assets/' + name, value)))).length).toBe(0)
        expect((await store.get('assets/a.png')).toString()).toBe('aaa')
        expect((await store.get('assets/b.webp')).toString()).toBe('bbbbb')
    })

    it('keeps physical KV and logical asset totals separate through migration and retention', async () => {
        const { store, db, seed } = await fixture()
        seed('assets/a', 'aaa'); seed('assets/b', 'bbbbb')
        const kvBytes = () => db.prepare('SELECT coalesce(sum(length(value)),0) n FROM kv').get().n
        expect(kvBytes()).toBe(8)
        await store.migrateOne('assets/a')
        expect(kvBytes()).toBe(5)
        expect((await store.list()).reduce((n: number, e: any) => n + e.size, 0)).toBe(8)
        expect(await store.stats()).toEqual({ assetFileBytes: 3, fileSize: 3 })
        await store.put('assets/a', Buffer.from('xxxx'))
        expect(await store.stats()).toEqual({ assetFileBytes: 7, fileSize: 4 })
    })

    it('continues rescanning after a full pass and retries a failed asset without blocking others', async () => {
        let failing = true
        const { store, seed, db } = await fixture({ checkpoint: async (_: string, result: any) => {
            if (failing && result.key === 'assets/z') throw new Error('synthetic transient failure')
        } })
        seed('assets/z', 'retry'); seed('assets/y', 'works')
        store.start()
        await expect.poll(async () => (await store.stat('assets/y'))?.generationId).toBeTruthy()
        await expect.poll(() => db.prepare('SELECT attempts FROM asset_file_retries').get()?.attempts).toBe(1)
        failing = false
        seed('assets/a', 'late')
        await expect.poll(async () => (await store.stat('assets/a'))?.generationId, { timeout: 5000 }).toBeTruthy()
        await expect.poll(async () => (await store.stat('assets/z'))?.generationId, { timeout: 5000 }).toBeTruthy()
    })

    it.each(['temp-write', 'post-rename', 'pre-publish'])('survives actual process kill at %s and abandons the old generation', async stage => {
        const { dir, store, seed } = await fixture()
        seed('assets/crash', 'survives')
        const fixturePath = path.join(import.meta.dirname, 'fixtures', 'assetFileCrash.cjs')
        const child = fork(fixturePath, [dir, stage], { execArgv: ['--require', fixturePath], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
        cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done } })
        let stderr = ''
        child.stderr?.on('data', data => { stderr += data })
        const message: any = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(stderr) })])
        expect(message[0].stage).toBe(stage)
        const done = once(child, 'exit'); child.kill('SIGKILL'); await done
        const previous = (await readdir(store.root, { recursive: true })).filter(p => /\.(blob|tmp)$/.test(p))
        expect(previous.length).toBe(1)
        expect((await store.get('assets/crash')).toString()).toBe('survives')
        const recovery = fork(fixturePath, [dir, 'recover'], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
        const [recovered]: any = await once(recovery, 'message')
        expect(recovered.migrated).toBe(true)
        await once(recovery, 'exit')
        const next = (await readdir(store.root, { recursive: true })).filter(p => /\.(blob|tmp)$/.test(p))
        expect(next.length).toBe(2)
        expect(next).toEqual(expect.arrayContaining(previous))
        expect((await store.get('assets/crash')).toString()).toBe('survives')
    })
})
