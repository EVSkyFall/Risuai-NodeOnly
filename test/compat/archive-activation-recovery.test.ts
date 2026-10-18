import { test, expect } from 'vitest'
import { spawnServer } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { decodeBackup } from './helpers/decode.js'
import { decodeRisuDat } from './helpers/normalize.js'
const utils = require('../../server/node/utils.cjs')
const hex = (s: string) => Buffer.from(s).toString('hex')

test('renamed activation chat IDs survive restart before client save without changing snapshot character bodies', async () => {
    const owner = await spawnServer()
    let running = owner
    try {
        let client = await createClient(running.port, running.password)
        await client.importBackup(createSeedBackup({ characterCount: 2, messagesPerChat: 3 }))
        const read = async (key = 'database/database.bin') => {
            const res = await client.fetch('/api/read', { headers: { 'file-path': hex(key) } })
            expect(res.status).toBe(200)
            return utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await res.arrayBuffer())))
        }
        const write = async (db: any) => {
            const res = await client.fetch('/api/write', { method: 'POST', headers: { 'file-path': hex('database/database.bin'), 'content-type': 'application/octet-stream' }, body: new Uint8Array(utils.encodeRisuSaveLegacy(db)) })
            expect(res.status, await res.clone().text()).toBe(200)
        }
        const db = await read()
        const archivedId = db.characters[0].chaId
        const oldChatId = db.characters[0].chats[0].id
        const res = await client.fetch(`/api/characters/${archivedId}/archive`, { method: 'POST' })
        const stub = (await res.json() as any).stub
        const archiveKey = `archive/${archivedId}/${stub.archivedAt}`
        const original = (await read(archiveKey)).character
        db.characters.shift()
        db.characters[0].chats[0].id = oldChatId
        db.nodeOnlyArchivedCharacters = [stub]
        await write(db)
        const activate = async () => {
            const response = await client.fetch(`/api/characters/${archivedId}/activate`, { method: 'POST' })
            expect(response.status).toBe(200)
            return (await response.json() as any).character
        }
        const first = await activate(), second = await activate()
        expect(first.chats[0].id).not.toBe(oldChatId)
        expect(second.chats[0].id).not.toBe(first.chats[0].id)
        expect((await read(archiveKey)).character).toEqual(original)
        await running.stop()
        running = await spawnServer({ cwd: owner.cwd })
        client = await createClient(running.port, running.password)
        for (const activated of [first, second]) {
            const current = await read()
            current.characters = current.characters.filter((c: any) => c.chaId !== archivedId).concat(activated)
            current.nodeOnlyArchivedCharacters = []
            await write(current)
            const chatRes = await client.fetch(`/api/chat-content/${archivedId}/0`, { headers: { 'x-chat-id': activated.chats[0].id } })
            const chat = await utils.decodeRisuSave(Buffer.from(await chatRes.arrayBuffer()))
            expect(chat.message).toEqual(original.chats[0].message)
            expect(chat.id).toBe(activated.chats[0].id)
        }
        const entries = decodeBackup(await client.exportBackup())
        const exported = decodeRisuDat(entries.find(e => e.name === 'database.risudat')!.data) as any
        expect(exported.characters.find((c: any) => c.chaId === archivedId).chats[0].message).toEqual(original.chats[0].message)
    } finally {
        if (running !== owner) await running.stop()
        await owner.cleanup()
    }
}, 30000)
