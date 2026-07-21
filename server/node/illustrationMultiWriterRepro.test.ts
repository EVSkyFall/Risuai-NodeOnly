// @vitest-environment node

// Gate 0 RED reproduction — request §4.4: two writers append illustration request
// markers to DIFFERENT messages of the SAME chat concurrently, and the second
// (stale) full-chat save wipes the first writer's marker. This exercises the REAL
// spawned server.cjs over real SQLite (chatContentDurability.test.ts pattern): the
// strict chat-content endpoint replaces the whole chat object with no per-message /
// per-marker reconciliation (server.cjs:5527, unconditional full replace), so a
// stale full-object save silently discards another writer's marker.
//
// The desired invariant (targeted marker patch, S3) is that both markers survive.
// It does NOT hold today, so this is a `test.fails`. Kept lean: ONE spawned server,
// both writes inside one test, to limit spawn-contention flake.

import { afterEach, expect, test } from 'vitest'
import Database from 'better-sqlite3'
import path from 'node:path'
import { spawnServer, type ServerHandle } from '../../test/compat/helpers/spawnServer.js'
import { createClient, type RisuClient } from '../../test/compat/helpers/client.js'
import { createSeedBackup } from '../../test/compat/helpers/seed.js'
import utils from './utils.cjs'

const { decodeRisuSave, encodeRisuSaveLegacy } = utils as {
    decodeRisuSave: (data: Buffer) => Promise<any>
    encodeRisuSaveLegacy: (data: unknown) => Buffer
}

// Real illustration request marker grammar (controlNodes.ts REQUEST_MARKER_PREFIX).
const MARKER_A = '<!--risu-illustration-request:v1:NONCEA-->'
const MARKER_B = '<!--risu-illustration-request:v1:NONCEB-->'

interface TestContext {
    server: ServerHandle
    client: RisuClient
}

const servers: ServerHandle[] = []

async function cleanupServer(server: ServerHandle) {
    let lastError: unknown
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            await server.cleanup()
            return
        } catch (error) {
            lastError = error
            const code = (error as NodeJS.ErrnoException).code
            if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(code ?? '') || attempt === 3) throw error
            await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
        }
    }
    throw lastError
}

afterEach(async () => {
    await Promise.all(servers.splice(0).map(cleanupServer))
})

async function boot(): Promise<TestContext> {
    const server = await spawnServer({
        env: {
            POCKETRISU_CHUNK_THRESHOLD: '9999999999',
            RISU_TUNNEL_DISABLED: 'true',
            RISU_UPDATE_CHECK: 'false',
        },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const imported = await client.importBackup(createSeedBackup())
    expect(imported.ok).toBe(true)

    // Initialize fullChatStore for the target chat before writes.
    const chatResponse = await client.fetch('/api/chat-content/test-char-0/0', {
        headers: { 'x-chat-id': 'chat-0-0' },
    })
    expect(chatResponse.status).toBe(200)
    return { server, client }
}

// Two char messages so each writer can mark a DIFFERENT message.
function makeTwoMessageChat(m1: string, m2: string) {
    return {
        id: 'chat-0-0',
        name: 'Chat 0',
        message: [
            { role: 'char', data: m1 },
            { role: 'char', data: m2 },
        ],
        lastDate: Date.now(),
        localLore: [],
        scriptstate: {},
        note: '',
    }
}

async function strictSave(context: TestContext, chat: ReturnType<typeof makeTwoMessageChat>, sessionId: string) {
    const registered = await context.client.fetch('/api/session', {
        method: 'POST',
        headers: { 'x-session-id': sessionId },
    })
    expect(registered.status).toBe(200)
    return context.client.fetch('/api/chat-content/test-char-0/0', {
        method: 'POST',
        headers: {
            'content-type': 'application/octet-stream',
            'x-chat-id': 'chat-0-0',
            'x-session-id': sessionId,
            'x-strict-flush': '1',
        },
        body: new Uint8Array(encodeRisuSaveLegacy(chat)),
    })
}

async function readPersistedChat(server: ServerHandle) {
    const db = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
    let raw: Buffer
    try {
        const row = db.prepare("SELECT value FROM kv WHERE key = 'database/database.bin'").get() as
            | { value: Buffer }
            | undefined
        if (!row) throw new Error('Persisted database row is missing')
        raw = Buffer.from(row.value)
    } finally {
        db.close()
    }
    const persisted = await decodeRisuSave(raw)
    return persisted.characters.find((character: any) => character.chaId === 'test-char-0').chats[0]
}

test.fails(
    'Repro 4 (marker LWW wipe): a stale full-chat save wipes another writer\'s illustration marker',
    { timeout: 30_000 },
    async () => {
        const context = await boot()

        // Both writers start from the same base (M1, M2 plain).
        const M1_BASE = 'Message one plain text'
        const M2_BASE = 'Message two plain text'

        // Session A marks message 1 (appends MARKER_A at a line boundary) and saves.
        const chatA = makeTwoMessageChat(`${M1_BASE}\n${MARKER_A}`, M2_BASE)
        const respA = await strictSave(context, chatA, 'illus-session-a')
        expect(respA.status).toBe(200)
        expect(await respA.json()).toMatchObject({ success: true, durable: true })

        // Session B holds a STALE copy (no MARKER_A), marks message 2, and full-saves.
        // This replaces the whole chat object, discarding session A's marker on M1.
        const chatBStale = makeTwoMessageChat(M1_BASE, `${M2_BASE}\n${MARKER_B}`)
        const respB = await strictSave(context, chatBStale, 'illus-session-b')
        expect(respB.status).toBe(200)
        expect(await respB.json()).toMatchObject({ success: true, durable: true })

        // DESIRED INVARIANT (targeted marker patch, S3): both markers survive on
        // their respective messages. Today MARKER_A is wiped by B's full replace.
        const persisted = await readPersistedChat(context.server)
        const allText = persisted.message.map((message: any) => message.data).join('\n')
        expect(allText).toContain(MARKER_A)
        expect(allText).toContain(MARKER_B)
    },
)
