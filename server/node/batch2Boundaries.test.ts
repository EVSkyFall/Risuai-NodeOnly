import { afterAll, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { spawnServer, type ServerHandle } from '../../test/compat/helpers/spawnServer.js'
import { createClient, type RisuClient } from '../../test/compat/helpers/client.js'
import { createSeedBackup } from '../../test/compat/helpers/seed.js'
import utils from './utils.cjs'

const servers: ServerHandle[] = []
afterAll(async () => { for (const server of servers) await server.cleanup() })
const hex = (key: string) => Buffer.from(key).toString('hex')
const customKey = 'plugin-custom-storage/dGVzdA.json'
const blobKey = 'plugin-blob-storage/dGVzdA.json'

async function boot() {
    const server = await spawnServer({ env: { POCKETRISU_BACKUP_INTERVAL_MS: '0', RISU_TUNNEL_DISABLED: 'true', RISU_UPDATE_CHECK: 'false' } })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    expect((await client.importBackup(createSeedBackup())).ok).toBe(true)
    return client
}
async function write(client: RisuClient, key: string, value: Buffer) {
    return client.fetch('/api/write', { method: 'POST', headers: { 'file-path': hex(key), 'content-type': 'application/octet-stream' }, body: value })
}
async function read(client: RisuClient, key: string) {
    const response = await client.fetch('/api/read', { headers: { 'file-path': hex(key) } })
    expect(response.status).toBe(200)
    return Buffer.from(await response.arrayBuffer())
}
async function readDb(client: RisuClient) {
    return utils.normalizeJSON(await utils.decodeRisuSave(await read(client, 'database/database.bin')))
}

test.each(['empty', 'corrupt'])('restore HTTP validates an explicit %s companion before replacement', async (kind) => {
    const client = await boot()
    const original = await readDb(client)
    const snapshot = { ...original, language: 'snapshot' }
    expect((await write(client, 'database/dbbackup-123.bin', utils.encodeRisuSaveLegacy(snapshot))).status).toBe(200)
    expect((await write(client, customKey, Buffer.from('"live-custom"'))).status).toBe(200)
    expect((await write(client, blobKey, Buffer.from('"live-blob"'))).status).toBe(200)
    const value = Buffer.from('"snapshot-custom"')
    const hash = createHash('sha256').update(value).digest('hex')
    const companion = { v: 2, entries: kind === 'empty' ? [] : [['dGVzdA.json', hash]] }
    if (kind === 'corrupt') {
        expect((await write(client, `plugin-storage-blob/${hash}`, Buffer.from('"corrupt"'))).status).toBe(200)
    }
    expect((await write(client, 'plugin-storage-snapshot/123', Buffer.from(JSON.stringify(companion)))).status).toBe(200)
    const response = await client.fetch('/api/db/snapshots/restore', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'database/dbbackup-123.bin' }),
    })
    if (kind === 'empty') {
        expect(response.status).toBe(200)
        expect((await read(client, customKey)).length).toBe(0)
        expect((await readDb(client)).language).toBe('snapshot')
    } else {
        expect(response.status).toBe(500)
        expect((await read(client, customKey)).toString()).toBe('"live-custom"')
        expect((await readDb(client)).language).toBe(original.language)
    }
    expect((await read(client, blobKey)).toString()).toBe('"live-blob"')
})

test('patch and full-write HTTP reject empty arrays beside descriptors for all owner shapes', async () => {
    const client = await boot()
    const db = await readDb(client)
    const items = [['asset', 'assets/example.png', 'png']]
    db.modules = [{ id: 'module', name: 'Module', assets: items }]
    db.characters[0].additionalAssets = items
    db.personas = [{ id: 'persona', name: 'Persona', embeddedModule: { assets: items } }]
    expect((await write(client, 'database/database.bin', utils.encodeRisuSaveLegacy(db))).status).toBe(200)
    const canonical = await readDb(client)
    const expectedHash = utils.calculateHash(canonical).toString(16)
    for (const arrayPath of ['/modules/0/assets', '/characters/0/additionalAssets', '/personas/0/embeddedModule/assets']) {
        const response = await client.fetch('/api/patch', {
            method: 'POST', headers: { 'content-type': 'application/json', 'file-path': hex('database/database.bin') },
            body: JSON.stringify({ expectedHash, patch: [{ op: 'add', path: arrayPath, value: [] }] }),
        })
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code: 'ASSET_MANIFEST_GUARD_REJECTED' })
        const full = structuredClone(canonical)
        const parts = arrayPath.slice(1).split('/')
        let owner = full
        for (const part of parts.slice(0, -1)) owner = owner[part]
        owner[parts.at(-1)] = []
        const rejected = await write(client, 'database/database.bin', utils.encodeRisuSaveLegacy(full))
        expect(rejected.status).toBe(409)
        expect(await readDb(client)).toEqual(canonical)
    }
    const cleared = structuredClone(canonical)
    cleared.modules[0].assets = []
    delete cleared.modules[0].assetManifest
    expect((await write(client, 'database/database.bin', utils.encodeRisuSaveLegacy(cleared))).status).toBe(200)
    expect((await readDb(client)).modules[0]).toMatchObject({ assets: [] })
})

test('same-clock same-size KV updates advance numeric revision across independent writer processes', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-revision-'))
    const modulePath = fileURLToPath(new URL('./db.cjs', import.meta.url))
    const run = (value: string) => {
        const script = `Date.now = () => 1000; const kv = require(${JSON.stringify(modulePath)});
            kv.kvSet('plugin-custom-storage/dGVzdA.json', Buffer.from(${JSON.stringify(value)}));
            console.log(JSON.stringify({ revision: kv.kvGetUpdatedAt('plugin-custom-storage/dGVzdA.json'), size: kv.kvSize('plugin-custom-storage/dGVzdA.json') })); kv.db.close();`
        const result = spawnSync(process.execPath, ['-e', script], { cwd: temp, encoding: 'utf8', timeout: 15000 })
        expect(result.status, result.stderr).toBe(0)
        return JSON.parse(result.stdout.trim().split('\n').at(-1))
    }
    try {
        const first = run('"old"')
        const second = run('"new"')
        expect(second.size).toBe(first.size)
        expect(second.revision).toBe(first.revision + 1)
        expect(typeof second.revision).toBe('number')
    } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})
