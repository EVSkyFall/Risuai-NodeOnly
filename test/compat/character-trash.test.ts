/**
 * Trash = deactivated + `trashedAt` marker on the stub. Covers: the marker
 * exporting as upstream's `trashTime` (so any importer files the character
 * under its own trash), the trash count in stats, and the permanent-delete
 * endpoint (rows gone; refused for an active character).
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { Packr } from 'msgpackr'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'
import { decodeBackup } from './helpers/decode.js'
import { decodeRisuDat } from './helpers/normalize.js'

const utils = require('../../server/node/utils.cjs') as typeof import('../../server/node/utils.cjs')

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
const encodeDb = (data: unknown) => Buffer.concat([MAGIC_RAW, packr.encode(data)])
const hex = (s: string) => Buffer.from(s, 'utf-8').toString('hex')
const DB_KEY_HEX = hex('database/database.bin')

const TRASH = 'trash-a'
const KEEP = 'keep-b'

function buildBackup(): Buffer {
  const mkChat = (id: string) => ({
    id, name: `Chat ${id}`, lastDate: Date.now(), localLore: [], scriptstate: {}, note: '',
    message: [{ role: 'user', data: 'hello' }, { role: 'char', data: 'hi there' }],
  })
  const characters = [
    { chaId: TRASH, type: 'character', name: 'Trash Me', desc: '', firstMessage: 'hi', image: '', chats: [mkChat('t-chat-0')], chatPage: 0, lastInteraction: 1000 },
    { chaId: KEEP, type: 'character', name: 'Kept', desc: '', firstMessage: 'yo', image: '', chats: [mkChat('k-chat-0')], chatPage: 0, lastInteraction: 2000 },
  ]
  const database = {
    characters,
    characterOrder: [TRASH, KEEP],
    apiType: 'openai', mainPrompt: '', jailbreak: '', globalNote: '',
    temperature: 80, maxContext: 4000, maxResponse: 300, frequencyPenalty: 70, PresensePenalty: 70,
    personas: [{ name: 'Default', icon: '', personaPrompt: '' }],
    botPresets: [], botPresetsId: 0, moduleIntergration: [], selectedCharacter: 0,
  }
  return encodeBackup([{ name: 'database.risudat', data: encodeDb(database) }])
}

let srv: ServerHandle
let client: RisuClient

beforeAll(async () => {
  srv = await spawnServer()
  client = await createClient(srv.port, srv.password)
  const imported = await client.importBackup(buildBackup())
  expect(imported.ok).toBe(true)
})
afterAll(async () => { await srv?.cleanup() })

async function readDb() {
  const res = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
  expect(res.status).toBe(200)
  const db = utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await res.arrayBuffer()))) as any
  return { db, hash: utils.calculateHash(db).toString(16) }
}

function sendPatch(patch: unknown[], expectedHash: string) {
  return client.fetch('/api/patch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
    body: JSON.stringify({ patch, expectedHash }),
  })
}

async function stats() {
  const res = await client.fetch('/api/db/stats')
  expect(res.status).toBe(200)
  return await res.json() as any
}

async function exportDb() {
  const bin = await client.exportBackup()
  const entries = decodeBackup(bin)
  const dbEntry = entries.find((e) => e.name === 'database.risudat')
  expect(dbEntry).toBeTruthy()
  return decodeRisuDat(dbEntry!.data) as any
}

const TRASHED_AT = 1_700_000_000_000

describe('character trash (deactivated + marker)', () => {
  test('a trashed stub exports as a character with trashTime', async () => {
    const res = await client.fetch(`/api/characters/${TRASH}/archive`, { method: 'POST' })
    expect(res.status).toBe(200)
    const stub = (await res.json() as any).stub
    const before = await readDb()
    const idx = before.db.characters.findIndex((c: any) => c.chaId === TRASH)
    const patched = await sendPatch([
      { op: 'remove', path: `/characters/${idx}` },
      { op: 'add', path: '/nodeOnlyArchivedCharacters', value: [{ ...stub, trashedAt: TRASHED_AT }] },
    ], before.hash)
    expect(patched.status).toBe(200)

    const exported = await exportDb()
    expect(exported.nodeOnlyArchivedCharacters).toBeUndefined()
    const trashed = exported.characters.find((c: any) => c.chaId === TRASH)
    expect(trashed).toBeTruthy()
    expect(trashed.trashTime).toBe(TRASHED_AT)
    expect(trashed.chats[0].message).toHaveLength(2)
    const kept = exported.characters.find((c: any) => c.chaId === KEEP)
    expect(kept.trashTime).toBeUndefined()

    const s = await stats()
    expect(s.trashed).toMatchObject({ available: true, count: 1 })
    expect(s.prefixes['archive/'].count).toBe(1)
  })

  test('permanent delete retains referenced rows until the stub and snapshots release them', async () => {
    const refused = await client.fetch(`/api/characters/${KEEP}/archive`, { method: 'DELETE' })
    expect(refused.status).toBe(409)
    expect((await refused.json() as any).code).toBe('ARCHIVE_ALREADY_ACTIVE')

    const del = await client.fetch(`/api/characters/${TRASH}/archive`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(await del.json()).toMatchObject({ ok: true, deleted: 0, metas: 0 })

    const s = await stats()
    expect(s.prefixes['archive/'].count).toBe(1)
    expect(s.prefixes['archive-meta/'].count).toBe(1)

    const exp = await client.fetch('/api/backup/export')
    expect(exp.status).toBe(200)
    await exp.arrayBuffer()

    const before = await readDb()
    expect((await sendPatch([{ op: 'remove', path: '/nodeOnlyArchivedCharacters' }], before.hash)).status).toBe(200)
    const snapshots = await (await client.fetch('/api/db/snapshots')).json() as any
    for (const snapshot of snapshots.snapshots) {
      expect((await client.fetch(`/api/db/snapshots?key=${encodeURIComponent(snapshot.key)}`, { method: 'DELETE' })).status).toBe(200)
    }
    const released = await client.fetch(`/api/characters/${TRASH}/archive`, { method: 'DELETE' })
    expect(await released.json()).toMatchObject({ ok: true, deleted: 1, metas: 1 })
    expect((await stats()).prefixes['archive/'].count).toBe(0)
  })
})
