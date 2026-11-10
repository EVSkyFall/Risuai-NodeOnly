// @vitest-environment node

// Chat saves are compare-and-swap on the chat's revision (multi-tab sync):
// a save replaces a stored chat only when it names the revision the server
// holds. These run the real server.cjs over real SQLite.

import { afterEach, describe, expect, it } from 'vitest'
import { spawnServer, type ServerHandle } from '../../test/compat/helpers/spawnServer.js'
import { createClient, type RisuClient } from '../../test/compat/helpers/client.js'
import { createSeedBackup } from '../../test/compat/helpers/seed.js'
import { chatRevisionOf } from '../../test/compat/helpers/chatRev.js'
import utils from './utils.cjs'
import revisions from './chatRevision.cjs'
import fingerprints from './chatFingerprint.cjs'

const { decodeRisuSave, encodeRisuSaveLegacy, normalizeJSON } = utils as {
    decodeRisuSave: (data: Buffer) => Promise<any>
    encodeRisuSaveLegacy: (data: unknown) => Buffer
    normalizeJSON: (data: unknown) => any
}
const { chatRevision } = revisions as { chatRevision: (chat: unknown) => string }
const { messageFingerprints, prefixFingerprint } = fingerprints as {
    messageFingerprints: (messages: unknown[]) => string[]
    prefixFingerprint: (fingerprints: string[], count: number) => string
}

const CHA = 'test-char-0'
const CHAT = 'chat-0-0'
const ENV = { POCKETRISU_CHUNK_THRESHOLD: '9999999999', RISU_TUNNEL_DISABLED: 'true', RISU_UPDATE_CHECK: 'false', RISU_MCP_API_KEY: 'test-mcp-key' }

const owners: ServerHandle[] = []
let running: ServerHandle | null = null

async function cleanup(server: ServerHandle) {
    for (let attempt = 0; ; attempt++) {
        try {
            await server.cleanup()
            return
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(code ?? '') || attempt === 3) throw error
            await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
        }
    }
}

afterEach(async () => {
    if (running) await running.stop().catch(() => {})
    running = null
    await Promise.all(owners.splice(0).map(cleanup))
})

async function boot(seed: Parameters<typeof createSeedBackup>[0] = {}) {
    const server = await spawnServer({ env: ENV })
    owners.push(server)
    running = server
    const client = await createClient(server.port, server.password)
    expect((await client.importBackup(createSeedBackup(seed))).ok).toBe(true)
    return { server, client }
}

/** Stop the server and start it again on the same data. */
async function restart(server: ServerHandle): Promise<{ server: ServerHandle, client: RisuClient }> {
    await (running ?? server).stop()
    const next = await spawnServer({ env: ENV, cwd: server.cwd })
    running = next
    return { server: next, client: await createClient(next.port, next.password) }
}

async function getChat(client: RisuClient, chatId = CHAT, headers: Record<string, string> = {}, index = 0) {
    const res = await client.fetch(`/api/chat-content/${CHA}/${index}`, { headers: { 'x-chat-id': chatId, ...headers } })
    const bytes = Buffer.from(await res.arrayBuffer())
    return {
        status: res.status,
        rev: res.headers.get('x-chat-rev'),
        chat: res.status === 200 ? await decodeRisuSave(bytes) : null,
        size: bytes.byteLength,
    }
}

function postChat(client: RisuClient, chat: any, headers: Record<string, string> = {}, index = 0) {
    return client.fetch(`/api/chat-content/${CHA}/${index}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-chat-id': chat.id, ...headers },
        body: new Uint8Array(encodeRisuSaveLegacy(chat)),
    })
}

async function readDatabase(client: RisuClient) {
    const res = await client.fetch('/api/read', { headers: { 'file-path': Buffer.from('database/database.bin').toString('hex') } })
    expect(res.status).toBe(200)
    return { db: await decodeRisuSave(Buffer.from(await res.arrayBuffer())), etag: res.headers.get('x-db-etag') ?? res.headers.get('etag') }
}

describe('chat revision', () => {
    const chat = () => ({
        id: 'c', name: 'Chat', lastDate: 1, folderId: 'f', modules: ['m'],
        note: 'note', localLore: [], scriptstate: { $a: 1 },
        message: [{ role: 'user', data: 'hello', chatId: 'm1' }],
    })

    it('ignores what the database stub owns and the runtime flags', () => {
        const base = chatRevision(chat())
        expect(chatRevision({ ...chat(), id: 'other', name: 'renamed', lastDate: 99, folderId: null, modules: [] })).toBe(base)
        expect(chatRevision({ ...chat(), isStreaming: true, _placeholder: true, _stub: true })).toBe(base)
    })

    it('changes with any owned content, including a cleared field', () => {
        const base = chatRevision(chat())
        expect(chatRevision({ ...chat(), note: '' })).not.toBe(base)
        expect(chatRevision({ ...chat(), scriptstate: {} })).not.toBe(base)
        expect(chatRevision({ ...chat(), message: [{ role: 'user', data: 'hello', chatId: 'other id' }] })).not.toBe(base)
        expect(chatRevision({ ...chat(), message: [] })).not.toBe(base)
    })

    it('treats an absent field and a null field alike', () => {
        expect(chatRevision({ ...chat(), sdData: null, bindedPersona: undefined })).toBe(chatRevision(chat()))
    })

    it('is the same before and after the normalisation a restart applies', () => {
        const rich = { ...chat(), at: new Date('2026-01-02T03:04:05.000Z'), blob: new Uint8Array([1, 2, 3]), nested: { when: new Date(0) } }
        expect(chatRevision(normalizeJSON(rich))).toBe(chatRevision(rich))
    })
})

describe('chat-content compare-and-swap', { timeout: 60_000 }, () => {
    it('GET names the revision and answers 204 to a caller that already holds it', async () => {
        const { client } = await boot()
        const first = await getChat(client)
        expect(first.status).toBe(200)
        expect(first.rev).toMatch(/^[0-9a-f]{64}$/)
        const same = await getChat(client, CHAT, { 'x-chat-base-rev': first.rev! })
        expect(same.status).toBe(204)
        expect(same.rev).toBe(first.rev)
        expect(same.size).toBe(0)
        const other = await getChat(client, CHAT, { 'x-chat-base-rev': 'something else' })
        expect(other.status).toBe(200)
        expect(other.chat.message).toEqual(first.chat.message)
    })

    it('refuses a save without the current revision and leaves the stored chat alone', async () => {
        const { client } = await boot()
        const before = await getChat(client)
        const mine = { ...before.chat, message: [{ role: 'user', data: 'overwrite attempt' }] }

        const noBase = await postChat(client, mine)
        expect(noBase.status).toBe(409)
        expect(noBase.headers.get('x-chat-rev')).toBe(before.rev)
        expect(await noBase.json()).toMatchObject({ success: false, code: 'CHAT_REV_CONFLICT', revision: before.rev })

        const stale = await postChat(client, mine, { 'x-chat-base-rev': 'f'.repeat(64) })
        expect(stale.status).toBe(409)
        const strictStale = await postChat(client, mine, { 'x-chat-base-rev': 'f'.repeat(64), 'x-strict-flush': '1' })
        expect(strictStale.status).toBe(409)
        expect((await strictStale.json()).code).toBe('CHAT_REV_CONFLICT')

        // A delta with a prefix that verifies is still refused on the revision.
        const fps = messageFingerprints(before.chat.message)
        const delta = await postChat(client, { ...before.chat, message: [{ role: 'user', data: 'tail' }] }, {
            'x-chat-base-count': String(fps.length),
            'x-chat-base-fp': prefixFingerprint(fps, fps.length),
            'x-chat-base-rev': 'f'.repeat(64),
        })
        expect(delta.status).toBe(409)
        expect((await delta.json()).code).toBe('CHAT_REV_CONFLICT')

        const after = await getChat(client)
        expect(after.rev).toBe(before.rev)
        expect(after.chat.message).toEqual(before.chat.message)
    })

    it('accepts a save on the current revision and hands back the new one', async () => {
        const { client } = await boot()
        const before = await getChat(client)
        const next = { ...before.chat, message: [...before.chat.message, { role: 'user', data: 'third' }] }
        const saved = await postChat(client, next, { 'x-chat-base-rev': before.rev! })
        expect(saved.status).toBe(200)
        const body = await saved.json()
        expect(body.revision).toMatch(/^[0-9a-f]{64}$/)
        expect(body.revision).not.toBe(before.rev)
        expect(saved.headers.get('x-chat-rev')).toBe(body.revision)
        const after = await getChat(client)
        expect(after.rev).toBe(body.revision)
        expect(after.chat.message).toHaveLength(3)

        // The second tab still holds the old revision: its save is refused.
        const second = await postChat(client, { ...before.chat, message: [{ role: 'user', data: 'stale tab' }] }, { 'x-chat-base-rev': before.rev! })
        expect(second.status).toBe(409)
        expect((await getChat(client)).chat.message).toHaveLength(3)

        // Only a runtime flag differs: same revision.
        const streaming = await postChat(client, { ...next, isStreaming: true }, { 'x-chat-base-rev': body.revision })
        expect(streaming.status).toBe(200)
        expect((await streaming.json()).revision).toBe(body.revision)
    })

    it('accepts a chat id the server does not hold yet without a base', async () => {
        const { client } = await boot()
        const res = await postChat(client, { id: 'brand-new', name: 'New', message: [{ role: 'user', data: 'first' }], note: '', localLore: [] }, {}, 1)
        expect(res.status).toBe(200)
        expect((await res.json()).revision).toMatch(/^[0-9a-f]{64}$/)
    })

    it('keeps the revision across a restart, also for a chat carrying a Date and binary data', async () => {
        const { server, client } = await boot()
        const before = await getChat(client)
        const rich = { ...before.chat, stamped: new Date('2026-05-06T07:08:09.000Z'), blob: new Uint8Array([9, 8, 7]) }
        const saved = await postChat(client, rich, { 'x-chat-base-rev': before.rev!, 'x-strict-flush': '1' })
        expect(saved.status).toBe(200)
        const revision = (await saved.json()).revision
        expect((await getChat(client)).rev).toBe(revision)

        const again = await restart(server)
        expect(await chatRevisionOf(again.client, CHA, 0, CHAT)).toBe(revision)
        // The base a tab held before the restart still works after it.
        const next = await postChat(again.client, { ...before.chat, message: [...before.chat.message, { role: 'user', data: 'after restart' }] }, { 'x-chat-base-rev': revision })
        expect(next.status).toBe(200)
    })

    it('lists a forked chat itself, at the end, durably', async () => {
        const { server, client } = await boot({ chatsPerCharacter: 2 })
        const original = await getChat(client)
        const etagBefore = (await readDatabase(client)).etag
        const fork = { ...original.chat, id: 'fork-1', name: 'Chat 0 (diverged)', message: [...original.chat.message, { role: 'user', data: 'only in the fork' }] }
        const saved = await postChat(client, fork, { 'x-chat-fork-of': CHAT, 'x-strict-flush': '1' }, 2)
        expect(saved.status).toBe(200)
        expect(await saved.json()).toMatchObject({ success: true, durable: true })

        const listed = await readDatabase(client)
        const chats = listed.db.characters.find((c: any) => c.chaId === CHA).chats
        expect(chats.map((c: any) => c.id)).toEqual(['chat-0-0', 'chat-0-1', 'fork-1'])
        expect(chats[2]).toMatchObject({ id: 'fork-1', name: 'Chat 0 (diverged)' })
        expect(chats[2].message).toBeUndefined()
        // A tab holding the old database must not be able to write the list back without the fork.
        expect(listed.etag).not.toBe(etagBefore)

        // Sending it again changes nothing in the list.
        const revision = await chatRevisionOf(client, CHA, 2, 'fork-1')
        expect((await postChat(client, fork, { 'x-chat-fork-of': CHAT, 'x-chat-base-rev': revision! }, 2)).status).toBe(200)
        expect((await readDatabase(client)).db.characters[0].chats).toHaveLength(3)

        const again = await restart(server)
        const afterRestart = await readDatabase(again.client)
        expect(afterRestart.db.characters.find((c: any) => c.chaId === CHA).chats.map((c: any) => c.id)).toEqual(['chat-0-0', 'chat-0-1', 'fork-1'])
        const body = await getChat(again.client, 'fork-1', {}, 2)
        expect(body.status).toBe(200)
        expect(body.chat.message.at(-1).data).toBe('only in the fork')
        expect((await getChat(again.client)).chat.message).toEqual(original.chat.message)
    })

    it('a cold MCP read before the first chat save does not bring old messages back', async () => {
        const first = await boot()
        // Start from disk with nothing cached, and let the MCP be the first reader.
        const { server, client } = await restart(first.server)
        const mcp = (body: unknown) => client.fetch('/api/mcp/chats/get', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-mcp-key': 'test-mcp-key' },
            body: JSON.stringify(body),
        })
        const cold = await mcp({ id: CHA, count: 20 })
        expect(cold.status).toBe(200)
        const coldBody = await cold.json()
        expect(coldBody.total).toBe(2)
        expect(coldBody.messages.map((m: any) => m.data)).toContain('Message 0 in chat 0 of char 0')

        const before = await getChat(client)
        const next = { ...before.chat, message: [...before.chat.message, { role: 'user', data: 'saved after the MCP read' }] }
        const saved = await postChat(client, next, { 'x-chat-base-rev': before.rev!, 'x-strict-flush': '1' })
        expect(saved.status).toBe(200)

        const warm = await (await mcp({ id: CHA, count: 20 })).json()
        expect(warm.total).toBe(3)
        expect(warm.messages[0].data).toBe('saved after the MCP read')

        const again = await restart(server)
        const after = await getChat(again.client)
        expect(after.chat.message).toHaveLength(3)
        expect(after.chat.message.at(-1).data).toBe('saved after the MCP read')
    })
})
