import { afterEach, describe, expect, it } from 'vitest'
import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import { zipSync } from 'fflate'
import { spawnServer, type ServerHandle } from '../../test/compat/helpers/spawnServer.js'
import { createClient, type RisuClient } from '../../test/compat/helpers/client.js'
import { encodeBackup } from '../../test/compat/helpers/encode.js'
import utils from './utils.cjs'

const servers: ServerHandle[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.cleanup() })
const hex = (key: string) => Buffer.from(key).toString('hex')
const assets = [
    { key: 'assets/avatar.png', value: Buffer.from('avatar bytes') },
    { key: 'assets/module.webp', value: Buffer.from('module bytes') },
    { key: 'assets/persona.png', value: Buffer.from('persona bytes') },
]
const database = {
    characters: [{ chaId: 'test-char', name: 'test', image: assets[0].key, chats: [] }],
    modules: [{ id: 'test-module', name: 'module', assets: [['image', assets[1].key, 'webp']] }],
    personas: [{ name: 'test', icon: assets[2].key }],
    botPresets: [], characterOrder: [],
}
const dbBytes = Buffer.from(utils.encodeRisuSaveLegacy(database))

function decodeArchive(data: Buffer) {
    const entries = new Map<string, Buffer>()
    let offset = 0
    while (offset < data.length) {
        const nameLength = data.readUInt32LE(offset); offset += 4
        const name = data.subarray(offset, offset + nameLength).toString(); offset += nameLength
        const length = data.readUInt32LE(offset); offset += 4
        entries.set(name, data.subarray(offset, offset + length)); offset += length
    }
    expect(offset).toBe(data.length)
    return entries
}

async function boot(migrated = 3) {
    const preload = path.join(import.meta.dirname, 'fixtures', 'assetFileTestControl.cjs')
    const server = await spawnServer({
        env: { RISU_TUNNEL_DISABLED: 'true', RISU_UPDATE_CHECK: 'false', NODE_OPTIONS: `--require "${preload.replaceAll(String.fromCharCode(92), "/")}"`, ASSET_TEST_MIGRATED: String(migrated) },
        seedSave: async saveDir => {
            await writeFile(path.join(saveDir, hex('database/database.bin')), dbBytes)
            for (const entry of assets) await writeFile(path.join(saveDir, hex(entry.key)), entry.value)
        },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const query = (sql: string) => {
        const db = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
        try { return db.prepare(sql).get() as any } finally { db.close() }
    }
    await expect.poll(() => query('SELECT count(*) n FROM asset_file_generations WHERE retired = 0').n).toBe(migrated)
    return { server, client, query }
}

async function readKey(client: RisuClient, key: string) {
    const response = await client.fetch('/api/read', { headers: { 'file-path': hex(key) } })
    expect(response.status).toBe(200)
    return Buffer.from(await response.arrayBuffer())
}

async function put(client: RisuClient, key: string, value: Buffer) {
    const response = await client.fetch('/api/write', { method: 'POST', headers: { 'file-path': hex(key), 'content-type': 'application/octet-stream' }, body: new Uint8Array(value) })
    expect(response.status).toBe(200)
}

describe('asset file HTTP integration', () => {
    it('degrades missing generations per item and exports actual disk sizes over HTTP and server save', async () => {
        const { client, server, query } = await boot()
        const missing = query("SELECT * FROM asset_file_generations WHERE key = 'assets/avatar.png' AND retired = 0")
        const damaged = query("SELECT * FROM asset_file_generations WHERE key = 'assets/module.webp' AND retired = 0")
        const filename = (id: string) => path.join(server.cwd, 'save/assets', id.slice(0, 2), id + '.blob')
        await unlink(filename(missing.generationId))
        await writeFile(filename(damaged.generationId), 'short')
        expect(await readKey(client, assets[0].key)).toEqual(Buffer.alloc(0))
        const session = await client.fetch('/api/session', { method: 'POST' })
        const cookie = session.headers.get('set-cookie')!.split(';')[0]
        const absent = await client.fetch('/api/asset/' + hex(assets[0].key), { headers: { cookie, 'if-none-match': `"${missing.updated_at}"` } })
        expect(absent.status).toBe(404)
        const bulk = await client.fetch('/api/assets/bulk-read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(assets.map(e => e.key)) })
        expect(bulk.status).toBe(200)
        expect(await bulk.json()).toEqual([
            { key: assets[1].key, value: Buffer.from('short').toString('base64') },
            { key: assets[2].key, value: assets[2].value.toString('base64') },
        ])
        const exported = await client.fetch('/api/backup/export')
        expect(exported.status).toBe(200)
        const bytes = Buffer.from(await exported.arrayBuffer())
        expect(Number(exported.headers.get('content-length'))).toBe(bytes.length)
        const archive = decodeArchive(bytes)
        expect(archive.has('avatar.png')).toBe(false); expect(archive.get('module.webp')?.toString()).toBe('short')
        expect(archive.get('persona.png')).toEqual(assets[2].value)
        const saved = await client.fetch('/api/backup/server/save', { method: 'POST' })
        expect(saved.status).toBe(200)
        expect((await saved.text()).trim().split('\n').map(line => JSON.parse(line)).some(p => p.type === 'done')).toBe(true)
        const name = (await readdir(path.join(server.cwd, 'backups'))).find(file => /^risu-backup-.*\.bin$/.test(file))!
        const diskArchive = decodeArchive(await readFile(path.join(server.cwd, 'backups', name)))
        expect(diskArchive.has('avatar.png')).toBe(false); expect(diskArchive.get('module.webp')?.toString()).toBe('short')
        expect(diskArchive.get('persona.png')).toEqual(assets[2].value)
        expect(query(`SELECT retired FROM asset_file_generations WHERE generationId = '${missing.generationId}'`).retired).toBe(0)
    })

    it.each(['backup', 'folder'])('orders an in-flight file write before %s world replacement', async kind => {
        const { client, server } = await boot()
        const saveDir = path.join(server.cwd, 'save')
        await writeFile(path.join(saveDir, 'hold-write'), '')
        const writing = put(client, assets[0].key, Buffer.from('in-flight old world'))
        await expect.poll(async () => (await readdir(saveDir)).includes('write-held')).toBe(true)
        const replaced = Buffer.from('imported world')
        let importing: Promise<any>
        if (kind === 'backup') {
            importing = client.importBackup(encodeBackup([{ name: 'database.risudat', data: dbBytes }, { name: 'avatar.png', data: replaced }]))
        } else {
            const folder = path.join(server.cwd, 'replacement')
            await mkdir(folder)
            await writeFile(path.join(folder, hex('database/database.bin')), dbBytes)
            await writeFile(path.join(folder, hex(assets[0].key)), replaced)
            importing = client.fetch('/api/migrate/save-folder/execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: folder }) }).then(response => response.json())
        }
        let completed = false
        importing.then(() => { completed = true })
        await new Promise(resolve => setTimeout(resolve, 100))
        expect(completed).toBe(false)
        await writeFile(path.join(saveDir, 'release-write'), '')
        await writing
        expect((await importing).ok).toBe(true)
        expect(await readKey(client, assets[0].key)).toEqual(replaced)
    })

    it.each([0, 1, 3])('roundtrips native/upstream/settings and server save with %i migrated assets', async migrated => {
        const { client, server, query } = await boot(migrated)
        for (const entry of assets) expect(await readKey(client, entry.key)).toEqual(entry.value)
        const stats = await (await client.fetch('/api/db/stats')).json()
        expect(stats.prefixes['assets/']).toMatchObject({ count: 3, totalSize: assets.reduce((n, e) => n + e.value.length, 0) })
        expect(stats.kvTotalBytes).toBe(query('SELECT sum(length(value)) n FROM kv').n)
        expect(stats.assetFileBytes).toBe(assets.slice(0, migrated).reduce((n, e) => n + e.value.length, 0))
        expect(stats.prefixes['assets/'].fileSize).toBe(stats.assetFileBytes)

        const exports = new Map<string, Buffer>()
        for (const mode of ['', '?target=upstream', '?mode=settings', '?mode=settings&moduleAssets=0']) {
            const response = await client.fetch('/api/backup/export' + mode)
            expect(response.status).toBe(200)
            const archive = Buffer.from(await response.arrayBuffer())
            expect(Number(response.headers.get('content-length'))).toBe(archive.length)
            const entries = decodeArchive(archive)
            const selected = mode.includes('settings') ? assets.slice(mode.includes('moduleAssets=0') ? 2 : 1) : assets
            for (const entry of selected) expect(entries.get(path.basename(entry.key))).toEqual(entry.value)
            for (const entry of assets.filter(e => !selected.includes(e))) expect(entries.has(path.basename(entry.key))).toBe(false)
            exports.set(mode, archive)
        }
        for (const [mode, archive] of exports) {
            expect((await client.importBackup(archive)).ok).toBe(true)
            const selected = mode.includes('settings') ? assets.slice(mode.includes('moduleAssets=0') ? 2 : 1) : assets
            for (const entry of selected) expect(await readKey(client, entry.key)).toEqual(entry.value)
        }
        expect((await client.importBackup(exports.get('')!)).ok).toBe(true)
        const saved = await client.fetch('/api/backup/server/save', { method: 'POST' })
        expect(saved.status).toBe(200)
        const progress = (await saved.text()).trim().split('\n').map(line => JSON.parse(line))
        const result = progress.find(p => p.type === 'done')
        expect(result).toBeTruthy()
        const backupFiles = await readdir(path.join(server.cwd, 'backups'))
        const name = backupFiles.find(file => /^risu-backup-.*\.bin$/.test(file))!
        const diskArchive = decodeArchive(await readFile(path.join(server.cwd, 'backups', name)))
        for (const entry of assets) expect(diskArchive.get(path.basename(entry.key))).toEqual(entry.value)
        await put(client, assets[0].key, Buffer.from('changed'))
        const restored = await client.fetch('/api/backup/server/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filename: name }) })
        expect(await restored.text()).toContain('"ok":true')
        for (const entry of assets) expect(await readKey(client, entry.key)).toEqual(entry.value)
    })

    it('preserves HTTP read/write/list, MIME/ETag, both bulk formats, patch and snapshot asset semantics', async () => {
        const { client } = await boot()
        const key = 'assets/custom.png'
        await put(client, key, Buffer.from('first'))
        const session = await client.fetch('/api/session', { method: 'POST' })
        const cookie = session.headers.get('set-cookie')!.split(';')[0]
        const first = await client.fetch('/api/asset/' + hex(key), { headers: { cookie } })
        expect(first.headers.get('content-type')).toContain('image/png')
        expect(await first.text()).toBe('first')
        const etag = first.headers.get('etag')!
        expect((await client.fetch('/api/asset/' + hex(key), { headers: { cookie, 'if-none-match': etag } })).status).toBe(304)
        await put(client, key, Buffer.from('replacement'))
        const next = await client.fetch('/api/asset/' + hex(key), { headers: { cookie, 'if-none-match': etag } })
        expect(next.status).toBe(200); expect(await next.text()).toBe('replacement')
        for (const prefix of ['', 'assets/', 'assets/cus']) {
            const list = await (await client.fetch('/api/list', { headers: { 'key-prefix': prefix } })).json()
            expect(list.content.filter((k: string) => k === key)).toEqual([key])
        }
        const bulk = [{ key, value: Buffer.from('bulk').toString('base64') }, { key: 'assets/empty', value: '' }]
        expect((await client.fetch('/api/assets/bulk-write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bulk) })).status).toBe(200)
        for (const accept of ['application/json', 'application/octet-stream']) {
            const response = await client.fetch('/api/assets/bulk-read', { method: 'POST', headers: { 'content-type': 'application/json', accept }, body: JSON.stringify(bulk.map(e => e.key)) })
            expect(response.status).toBe(200)
            if (accept === 'application/json') expect(await response.json()).toEqual(bulk)
            else {
                const bytes = Buffer.from(await response.arrayBuffer())
                expect(bytes.readUInt32BE(0)).toBe(2)
                let offset = 4
                for (const entry of bulk) {
                    const keyLength = bytes.readUInt32BE(offset); offset += 4
                    expect(bytes.subarray(offset, offset + keyLength).toString()).toBe(entry.key); offset += keyLength
                    const length = bytes.readUInt32BE(offset); offset += 4
                    expect(bytes.subarray(offset, offset + length).toString('base64')).toBe(entry.value); offset += length
                }
                expect(offset).toBe(bytes.length)
            }
        }
        const patchKey = 'assets/patch.bin'
        await put(client, patchKey, Buffer.from(utils.encodeRisuSaveLegacy({ value: 'old' })))
        const patch = await client.fetch('/api/patch', { method: 'POST', headers: { 'content-type': 'application/json', 'file-path': hex(patchKey) }, body: JSON.stringify({ expectedHash: utils.calculateHash({ value: 'old' }).toString(16), patch: [{ op: 'replace', path: '/value', value: 'patched' }] }) })
        expect(patch.status).toBe(200)
        expect((await utils.decodeRisuSave(await readKey(client, patchKey))).value).toBe('patched')
        expect((await client.fetch('/api/db/snapshots?key=' + encodeURIComponent(key), { method: 'DELETE' })).status).toBe(400)
        expect((await readKey(client, key)).toString()).toBe('bulk')
        await put(client, 'database/database.bin', dbBytes)
        const snapshots = await (await client.fetch('/api/db/snapshots')).json()
        expect(snapshots.snapshots.length).toBeGreaterThan(0)
        {
            const snapshotKey = snapshots.snapshots[0].key
            expect((await client.fetch('/api/db/snapshots/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: snapshotKey }) })).status).toBe(200)
            expect((await readKey(client, key)).toString()).toBe('bulk')
        }
    })

    it('replaces file mappings through directory and ZIP save-folder imports, and excludes assets directory from scanner', async () => {
        const { client, server } = await boot()
        const folder = path.join(server.cwd, 'legacy-import')
        await mkdir(folder)
        await mkdir(path.join(folder, 'assets'))
        const entries = [ { key: 'database/database.bin', value: dbBytes }, { key: assets[0].key, value: Buffer.from('folder replacement') } ]
        for (const entry of entries) await writeFile(path.join(folder, hex(entry.key)), entry.value)
        const scan = await client.fetch('/api/migrate/save-folder/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: folder }) })
        expect((await scan.json()).count).toBe(2)
        const imported = await client.fetch('/api/migrate/save-folder/execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: folder }) })
        expect(imported.status).toBe(200)
        expect(await readKey(client, assets[0].key)).toEqual(entries[1].value)
        expect(await readKey(client, assets[1].key)).toEqual(Buffer.alloc(0))
        const zip = zipSync(Object.fromEntries(entries.map(e => [hex(e.key), new Uint8Array(e.key.startsWith('assets/') ? Buffer.from('ZIP replacement') : e.value)])))
        const uploaded = await client.fetch('/api/migrate/save-folder/upload', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: zip })
        expect(uploaded.status).toBe(200)
        expect((await readKey(client, assets[0].key)).toString()).toBe('ZIP replacement')
    })
})
