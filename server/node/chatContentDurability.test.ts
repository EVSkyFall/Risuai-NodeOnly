// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest'
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

interface TestContext {
    server: ServerHandle
    client: RisuClient
    sessionId: string
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

async function boot(
    extraEnv: Record<string, string> = {},
    seedOpts: Parameters<typeof createSeedBackup>[0] = {},
): Promise<TestContext> {
    const server = await spawnServer({
        env: {
            POCKETRISU_CHUNK_THRESHOLD: '9999999999',
            RISU_TUNNEL_DISABLED: 'true',
            RISU_UPDATE_CHECK: 'false',
            ...extraEnv,
        },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const imported = await client.importBackup(createSeedBackup(seedOpts))
    expect(imported.ok).toBe(true)

    const sessionId = 'gate1-active-session'
    const sessionResponse = await client.fetch('/api/session', {
        method: 'POST',
        headers: { 'x-session-id': sessionId },
    })
    expect(sessionResponse.status).toBe(200)

    // Initialize fullChatStore before tests take SQLite locks or install triggers.
    const chatResponse = await client.fetch('/api/chat-content/test-char-0/0', {
        headers: { 'x-chat-id': 'chat-0-0' },
    })
    expect(chatResponse.status).toBe(200)

    return { server, client, sessionId }
}

function makeChat(text: string, id = 'chat-0-0') {
    return {
        id,
        name: 'Chat 0',
        message: [{ role: 'char', data: text }],
        lastDate: Date.now(),
        localLore: [],
        scriptstate: {},
        note: '',
    }
}

function makeCombinedChat(legacyText: string, strictText: string) {
    const chat = makeChat(legacyText)
    chat.message.push({ role: 'char', data: strictText })
    return chat
}

async function postChat(
    context: TestContext,
    chat: ReturnType<typeof makeChat>,
    options: { strict?: boolean; sessionId?: string; chatId?: string; charId?: string; chatIndex?: number } = {},
) {
    const charId = options.charId ?? 'test-char-0'
    const chatIndex = options.chatIndex ?? 0
    const headers: Record<string, string> = {
        'content-type': 'application/octet-stream',
        'x-chat-id': options.chatId ?? 'chat-0-0',
        'x-session-id': options.sessionId ?? context.sessionId,
    }
    if (options.strict) headers['x-strict-flush'] = '1'
    return context.client.fetch(`/api/chat-content/${charId}/${chatIndex}`, {
        method: 'POST',
        headers,
        body: new Uint8Array(encodeRisuSaveLegacy(chat)),
    })
}

function databasePath(server: ServerHandle) {
    return path.join(server.cwd, 'save', 'risuai.db')
}

async function readPersistedChat(server: ServerHandle, chaId = 'test-char-0') {
    const db = new Database(databasePath(server), { readonly: true })
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
    return persisted.characters.find((character: any) => character.chaId === chaId).chats[0]
}

function installFailureTrigger(server: ServerHandle, name: string, keyPredicate: string, message: string) {
    const db = new Database(databasePath(server))
    try {
        db.exec(`
            CREATE TRIGGER ${name}
            BEFORE INSERT ON kv
            WHEN ${keyPredicate}
            BEGIN
                SELECT RAISE(FAIL, '${message}');
            END;
        `)
    } finally {
        db.close()
    }
}

function dropTrigger(server: ServerHandle, name: string) {
    const db = new Database(databasePath(server))
    try {
        db.exec(`DROP TRIGGER ${name}`)
    } finally {
        db.close()
    }
}

function installCoreWriteAudit(server: ServerHandle) {
    const db = new Database(databasePath(server))
    try {
        db.exec(`
            CREATE TABLE gate1_core_write_audit (write_count INTEGER NOT NULL);
            INSERT INTO gate1_core_write_audit VALUES (0);
            CREATE TRIGGER gate1_count_core_writes
            AFTER INSERT ON kv
            WHEN NEW.key = 'database/database.bin'
            BEGIN
                UPDATE gate1_core_write_audit SET write_count = write_count + 1;
            END;
        `)
    } finally {
        db.close()
    }
}

function readCoreWriteCount(server: ServerHandle) {
    const db = new Database(databasePath(server), { readonly: true })
    try {
        const row = db.prepare('SELECT write_count FROM gate1_core_write_audit').get() as { write_count: number }
        return row.write_count
    } finally {
        db.close()
    }
}

describe('strict durable chat-content flush', { timeout: 30_000 }, () => {
    it('persists the submitted chat before returning the durable ACK', async () => {
        const context = await boot()
        const response = await postChat(context, makeChat('strict durable value'), { strict: true })

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ success: true, durable: true })
        const persistedChat = await readPersistedChat(context.server)
        expect(persistedChat.message[0].data).toBe('strict durable value')
    })

    it('returns a core persist failure for strict mode while legacy mode still returns 200', async () => {
        const context = await boot()
        installFailureTrigger(
            context.server,
            'gate1_fail_core_persist',
            "NEW.key = 'database/database.bin'",
            'injected core persist failure',
        )

        const strictResponse = await postChat(context, makeChat('strict rejected value'), { strict: true })
        expect(strictResponse.status).toBe(500)
        expect(await strictResponse.json()).toMatchObject({
            success: false,
            error: expect.stringContaining('injected core persist failure'),
            source: 'chat-content',
        })

        const legacyResponse = await postChat(context, makeChat('legacy acknowledged value'))
        expect(legacyResponse.status).toBe(200)
        expect(await legacyResponse.json()).toEqual({ success: true })

        await new Promise((resolve) => setTimeout(resolve, 5_500))
        const persistedChat = await readPersistedChat(context.server)
        expect(persistedChat.message[0].data).toBe('Message 0 in chat 0 of char 0')
    }, 30_000)

    it('rearms persistence after a failed strict write so combined dirty state reaches disk', async () => {
        const context = await boot()
        installFailureTrigger(
            context.server,
            'gate1_fail_then_retry_core_persist',
            "NEW.key = 'database/database.bin'",
            'injected retryable core persist failure',
        )

        const legacyResponse = await postChat(context, makeChat('legacy edit'))
        expect(legacyResponse.status).toBe(200)

        const strictResponse = await postChat(context, makeCombinedChat('legacy edit', 'strict payload'), {
            strict: true,
        })
        expect(strictResponse.status).toBe(500)
        expect(await strictResponse.json()).toMatchObject({
            success: false,
            error: expect.stringContaining('injected retryable core persist failure'),
            source: 'chat-content',
        })
        expect((await readPersistedChat(context.server)).message[0].data).toBe('Message 0 in chat 0 of char 0')

        dropTrigger(context.server, 'gate1_fail_then_retry_core_persist')
        await new Promise((resolve) => setTimeout(resolve, 5_500))

        const persistedChat = await readPersistedChat(context.server)
        expect(persistedChat.message.map((message: any) => message.data)).toEqual(['legacy edit', 'strict payload'])
    }, 30_000)

    it('retires the subsumed legacy debounce after a successful strict write', async () => {
        const context = await boot()
        installCoreWriteAudit(context.server)
        expect(readCoreWriteCount(context.server)).toBe(0)

        const legacyResponse = await postChat(context, makeChat('legacy edit'))
        expect(legacyResponse.status).toBe(200)

        const strictResponse = await postChat(context, makeCombinedChat('legacy edit', 'strict payload'), {
            strict: true,
        })
        expect(strictResponse.status).toBe(200)
        expect(await strictResponse.json()).toMatchObject({ success: true, durable: true })

        const persistedChat = await readPersistedChat(context.server)
        expect(persistedChat.message.map((message: any) => message.data)).toEqual(['legacy edit', 'strict payload'])
        expect(readCoreWriteCount(context.server)).toBe(1)

        await new Promise((resolve) => setTimeout(resolve, 5_500))
        expect(readCoreWriteCount(context.server)).toBe(1)
    }, 30_000)

    it('keeps the durable ACK when backup rotation fails and surfaces a warning', async () => {
        const context = await boot({ POCKETRISU_BACKUP_INTERVAL_MS: '0' })
        installFailureTrigger(
            context.server,
            'gate1_fail_backup_rotation',
            "NEW.key LIKE 'database/dbbackup-%'",
            'injected backup rotation failure',
        )

        const response = await postChat(context, makeChat('core write survives backup failure'), { strict: true })
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
            success: true,
            durable: true,
            backupWarning: {
                message: expect.stringContaining('injected backup rotation failure'),
                source: 'chat-content-backup',
            },
        })
        const persistedChat = await readPersistedChat(context.server)
        expect(persistedChat.message[0].data).toBe('core write survives backup failure')
    })

    it('accepts a write from a non-active session after a newer session registers', async () => {
        const context = await boot()

        // A second browser/tab registers a newer session. Under the old
        // single-writer lock this deactivated the first session (423 on its
        // next write). With the lock removed, the original session must keep
        // writing and its content must persist durably.
        const newerSession = await context.client.fetch('/api/session', {
            method: 'POST',
            headers: { 'x-session-id': 'gate1-newer-session' },
        })
        expect(newerSession.status).toBe(200)

        const response = await postChat(context, makeChat('older writer still allowed'), {
            strict: true,
            sessionId: context.sessionId,
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ success: true, durable: true })

        const persistedChat = await readPersistedChat(context.server)
        expect(persistedChat.message[0].data).toBe('older writer still allowed')
    })

    it('persists interleaved writes from two distinct sessions to different chats', async () => {
        const context = await boot({}, { characterCount: 2 })

        // Two browsers each register their own session id.
        for (const id of ['gate1-session-a', 'gate1-session-b']) {
            const reg = await context.client.fetch('/api/session', {
                method: 'POST',
                headers: { 'x-session-id': id },
            })
            expect(reg.status).toBe(200)
        }

        // Concurrent strict writes to different chats. Under the old lock, at
        // most one session id matched the active writer, so the other got 423.
        // Now both must succeed durably; the server serializes them.
        const [respA, respB] = await Promise.all([
            postChat(context, makeChat('from session A', 'chat-0-0'), {
                strict: true,
                sessionId: 'gate1-session-a',
                charId: 'test-char-0',
                chatIndex: 0,
                chatId: 'chat-0-0',
            }),
            postChat(context, makeChat('from session B', 'chat-1-0'), {
                strict: true,
                sessionId: 'gate1-session-b',
                charId: 'test-char-1',
                chatIndex: 0,
                chatId: 'chat-1-0',
            }),
        ])

        expect(respA.status).toBe(200)
        expect(respB.status).toBe(200)
        expect(await respA.json()).toMatchObject({ success: true, durable: true })
        expect(await respB.json()).toMatchObject({ success: true, durable: true })

        expect((await readPersistedChat(context.server, 'test-char-0')).message[0].data).toBe('from session A')
        expect((await readPersistedChat(context.server, 'test-char-1')).message[0].data).toBe('from session B')
    }, 30_000)

    it('rejects a strict request whose Chat.id differs from x-chat-id', async () => {
        const context = await boot()
        const response = await postChat(context, makeChat('wrong chat', 'different-chat-id'), { strict: true })

        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({
            success: false,
            error: expect.stringContaining('Chat ID mismatch'),
            source: 'chat-content-validation',
        })
    })

    it('returns the legacy 200 before a disk write can occur', async () => {
        const context = await boot()
        const lockDb = new Database(databasePath(context.server))
        try {
            lockDb.exec('BEGIN IMMEDIATE')
            const response = await Promise.race([
                postChat(context, makeChat('still only in memory')),
                new Promise<never>((_, reject) => {
                    setTimeout(() => reject(new Error('legacy response waited for disk')), 2_000)
                }),
            ])

            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({ success: true })
            const persistedChat = await readPersistedChat(context.server)
            expect(persistedChat.message[0].data).toBe('Message 0 in chat 0 of char 0')
        } finally {
            lockDb.exec('ROLLBACK')
            lockDb.close()
        }

        const cleanupResponse = await postChat(context, makeChat('still only in memory'), { strict: true })
        expect(cleanupResponse.status).toBe(200)
    })
})
