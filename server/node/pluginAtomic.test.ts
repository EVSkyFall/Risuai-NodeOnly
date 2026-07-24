// @vitest-environment node

// Generic plugin-scoped atomic storage contract (POST /api/plugin/atomic),
// exercised over the REAL spawned server.cjs + real SQLite — ported from
// illustrationAtomic.test.ts (chatContentDurability.test.ts pattern). One
// spawned server for the sequential main describe; extra spawns only for the
// SIGKILL restart-monotonicity case and the backup/snapshot restore cases.
// Each test namespaces its own keys so the shared server stays isolated.
//
// The server validates key SHAPE only (`p:<uuid>:`); it has no plugin identity
// of its own. Namespace ENFORCEMENT is host-side (see
// src/ts/process/pluginPrimitives/pluginAtomic.ts) and is covered by that
// module's unit test.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import path from 'node:path'
import { spawnServer, type ServerHandle } from '../../test/compat/helpers/spawnServer.js'
import { createClient, type RisuClient } from '../../test/compat/helpers/client.js'
import { createSeedBackup } from '../../test/compat/helpers/seed.js'

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

async function boot(cwd?: string): Promise<ServerHandle> {
    const server = await spawnServer({
        cwd,
        env: {
            POCKETRISU_CHUNK_THRESHOLD: '9999999999',
            RISU_TUNNEL_DISABLED: 'true',
            RISU_UPDATE_CHECK: 'false',
        },
    })
    servers.push(server)
    return server
}

function enc(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString('base64')
}

function dec(base64: string | null): unknown {
    if (base64 === null || base64 === undefined) return null
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'))
}

interface AtomicResult {
    status: number
    body: any
}

async function atomic(client: RisuClient, body: unknown): Promise<AtomicResult> {
    const res = await client.fetch('/api/plugin/atomic', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
}

const V1 = 1
const NS = 'p:33333333-3333-4333-8333-333333333333:'
const NS_OTHER = 'p:44444444-4444-4444-8444-444444444444:'

describe('plugin atomic storage (single server)', { timeout: 30_000 }, () => {
    let server: ServerHandle
    let client: RisuClient

    beforeEach(async () => {
        server = await boot()
        client = await createClient(server.port, server.password)
    })

    it('cas creates over an absent key and read returns the value', async () => {
        const key = `${NS}create:a`
        const created = await atomic(client, {
            protocolVersion: V1, op: 'cas', key, expectedRevision: 0, value: enc({ hello: 'world' }), operationKey: 'op-create-1',
        })
        expect(created.status).toBe(200)
        expect(created.body).toEqual({ applied: true, revision: 1 })

        const read = await atomic(client, { protocolVersion: V1, op: 'read', key })
        expect(read.status).toBe(200)
        expect(read.body.revision).toBe(1)
        expect(read.body.deleted).toBe(false)
        expect(dec(read.body.value)).toEqual({ hello: 'world' })
    })

    it('cas conflict returns currentRevision; loser rereads and retries', async () => {
        const key = `${NS}conflict:a`
        const first = await atomic(client, {
            protocolVersion: V1, op: 'cas', key, expectedRevision: 0, value: enc({ n: 1 }), operationKey: 'cf-1',
        })
        expect(first.body).toEqual({ applied: true, revision: 1 })

        const stale = await atomic(client, {
            protocolVersion: V1, op: 'cas', key, expectedRevision: 0, value: enc({ n: 2 }), operationKey: 'cf-2',
        })
        expect(stale.status).toBe(409)
        expect(stale.body.code).toBe('PLUGIN_ATOMIC_CONFLICT')
        expect(stale.body.currentRevision).toBe(1)
        expect(stale.body.currentDeleted).toBe(false)

        const reread = await atomic(client, { protocolVersion: V1, op: 'read', key })
        expect(reread.body.revision).toBe(1)
        const retry = await atomic(client, {
            protocolVersion: V1, op: 'cas', key, expectedRevision: 1, value: enc({ n: 2 }), operationKey: 'cf-3',
        })
        expect(retry.body).toEqual({ applied: true, revision: 2 })
    })

    it('two concurrent same-key cas from two sessions: exactly one applies', async () => {
        const clientA = await createClient(server.port, server.password)
        const clientB = await createClient(server.port, server.password)
        const key = `${NS}race:a`

        const [a, b] = await Promise.all([
            atomic(clientA, {
                protocolVersion: V1, op: 'cas', key, expectedRevision: 0, value: enc({ w: 'A' }), operationKey: 'race-a',
            }),
            atomic(clientB, {
                protocolVersion: V1, op: 'cas', key, expectedRevision: 0, value: enc({ w: 'B' }), operationKey: 'race-b',
            }),
        ])

        const statuses = [a.status, b.status].sort()
        expect(statuses).toEqual([200, 409])
        const winner = a.status === 200 ? a : b
        const loser = a.status === 200 ? b : a
        expect(winner.body).toEqual({ applied: true, revision: 1 })
        expect(loser.body.code).toBe('PLUGIN_ATOMIC_CONFLICT')
        expect(loser.body.currentRevision).toBe(1)
    })

    it('remove tombstones with a continuing revision; recreate continues, ABA is closed', async () => {
        const key = `${NS}aba:a`
        await atomic(client, {
            protocolVersion: V1, op: 'cas', key, expectedRevision: 0, value: enc({ v: 1 }), operationKey: 'aba-1',
        })
        const removed = await atomic(client, {
            protocolVersion: V1, op: 'remove', key, expectedRevision: 1, operationKey: 'aba-2',
        })
        expect(removed.body).toEqual({ applied: true, revision: 2 })

        const read = await atomic(client, { protocolVersion: V1, op: 'read', key })
        expect(read.body).toMatchObject({ revision: 2, value: null, deleted: true })

        // Recreate over the tombstone: revision CONTINUES (does not reset to 1).
        const recreated = await atomic(client, {
            protocolVersion: V1, op: 'cas', key, expectedRevision: 2, value: enc({ v: 3 }), operationKey: 'aba-3',
        })
        expect(recreated.body).toEqual({ applied: true, revision: 3 })

        // Recreating with expectedRevision 0 is a conflict (ABA closed).
        const aba = await atomic(client, {
            protocolVersion: V1, op: 'cas', key, expectedRevision: 0, value: enc({ v: 4 }), operationKey: 'aba-4',
        })
        expect(aba.status).toBe(409)
        expect(aba.body.currentRevision).toBe(3)
    })

    it('receipts: replay is idempotent; different binding mismatches; receipt is durable', async () => {
        const key = `${NS}receipt:a`
        const first = await atomic(client, {
            protocolVersion: V1, op: 'cas', key, expectedRevision: 0, value: enc({ v: 1 }), operationKey: 'rc-1',
        })
        expect(first.body).toEqual({ applied: true, revision: 1 })

        // Same operationKey + same binding → same result, no double apply.
        const replay = await atomic(client, {
            protocolVersion: V1, op: 'cas', key, expectedRevision: 0, value: enc({ v: 1 }), operationKey: 'rc-1',
        })
        expect(replay.body).toEqual({ applied: true, revision: 1 })
        const afterReplay = await atomic(client, { protocolVersion: V1, op: 'read', key })
        expect(afterReplay.body.revision).toBe(1)

        // Same operationKey + DIFFERENT binding → typed mismatch, no write.
        const mismatch = await atomic(client, {
            protocolVersion: V1, op: 'cas', key, expectedRevision: 0, value: enc({ v: 999 }), operationKey: 'rc-1',
        })
        expect(mismatch.status).toBe(409)
        expect(mismatch.body.code).toBe('PLUGIN_ATOMIC_RECEIPT_MISMATCH')
        expect(dec((await atomic(client, { protocolVersion: V1, op: 'read', key })).body.value)).toEqual({ v: 1 })

        // Advance the record with a different operationKey, then confirm rc-1's
        // receipt is still durably resolvable.
        await atomic(client, {
            protocolVersion: V1, op: 'cas', key, expectedRevision: 1, value: enc({ v: 2 }), operationKey: 'rc-2',
        })
        const receipt = await atomic(client, { protocolVersion: V1, op: 'receipt', operationKey: 'rc-1' })
        expect(receipt.body.receipt).toEqual({ applied: true, key, resultingRevision: 1 })

        const missing = await atomic(client, { protocolVersion: V1, op: 'receipt', operationKey: 'never-existed' })
        expect(missing.body.receipt).toBeNull()
    })

    it('list is bounded, cursor-paged, key-ordered, and includes tombstones', async () => {
        const prefix = `${NS}list:`
        const suffixes = ['a', 'b', 'c', 'd', 'e']
        for (const s of suffixes) {
            await atomic(client, {
                protocolVersion: V1, op: 'cas', key: `${prefix}${s}`, expectedRevision: 0, value: enc({ s }),
                operationKey: `list-${s}`,
            })
        }
        await atomic(client, {
            protocolVersion: V1, op: 'remove', key: `${prefix}c`, expectedRevision: 1, operationKey: 'list-rm-c',
        })

        const page1 = await atomic(client, { protocolVersion: V1, op: 'list', prefix, limit: 3 })
        expect(page1.body.items.map((i: any) => i.key)).toEqual([`${prefix}a`, `${prefix}b`, `${prefix}c`])
        expect(page1.body.nextCursor).toBe(`${prefix}c`)
        expect(page1.body.items.find((i: any) => i.key === `${prefix}c`).deleted).toBe(true)
        // The projection carries no values.
        expect(page1.body.items[0].value).toBeUndefined()

        const page2 = await atomic(client, { protocolVersion: V1, op: 'list', prefix, limit: 3, cursor: page1.body.nextCursor })
        expect(page2.body.items.map((i: any) => i.key)).toEqual([`${prefix}d`, `${prefix}e`])
        expect(page2.body.nextCursor).toBeNull()
    })

    it('bulkRead returns one record per input key, absent → revision 0', async () => {
        await atomic(client, {
            protocolVersion: V1, op: 'cas', key: `${NS}bulk:x`, expectedRevision: 0, value: enc({ x: 1 }),
            operationKey: 'bulk-x',
        })
        const res = await atomic(client, {
            protocolVersion: V1, op: 'bulkRead', keys: [`${NS}bulk:x`, `${NS}bulk:absent`],
        })
        expect(res.body.items).toHaveLength(2)
        expect(res.body.items[0]).toMatchObject({ key: `${NS}bulk:x`, revision: 1 })
        expect(dec(res.body.items[0].value)).toEqual({ x: 1 })
        expect(res.body.items[1]).toEqual({ key: `${NS}bulk:absent`, revision: 0, value: null, deleted: false })
    })

    it('changes is an append-ordered bounded wake cursor scoped by prefix', async () => {
        const prefix = `${NS}chg:`
        for (const k of ['a', 'b', 'c']) {
            await atomic(client, {
                protocolVersion: V1, op: 'cas', key: `${prefix}${k}`, expectedRevision: 0, value: enc({ k }), operationKey: `chg-${k}`,
            })
        }
        await atomic(client, {
            protocolVersion: V1, op: 'cas', key: `${NS_OTHER}chg:zzz`, expectedRevision: 0, value: enc({}), operationKey: 'chg-other',
        })

        const page1 = await atomic(client, { protocolVersion: V1, op: 'changes', prefix, limit: 2 })
        expect(page1.status).toBe(200)
        expect(page1.body.changedKeys).toEqual([`${prefix}a`, `${prefix}b`])
        expect(typeof page1.body.cursor).toBe('string')
        expect(page1.body.epoch).toBe(0)

        const page2 = await atomic(client, { protocolVersion: V1, op: 'changes', prefix, limit: 2, afterCursor: page1.body.cursor })
        expect(page2.body.changedKeys).toEqual([`${prefix}c`])

        // Idle poll: no new work, cursor stands still (no keep-alive storm).
        const idle = await atomic(client, { protocolVersion: V1, op: 'changes', prefix, limit: 2, afterCursor: page2.body.cursor })
        expect(idle.body.changedKeys).toEqual([])
        expect(idle.body.cursor).toBe(page2.body.cursor)

        // A tombstone is a change too, and re-emits at the end of the feed.
        await atomic(client, { protocolVersion: V1, op: 'remove', key: `${prefix}a`, expectedRevision: 1, operationKey: 'chg-rm-a' })
        const page3 = await atomic(client, { protocolVersion: V1, op: 'changes', prefix, limit: 10, afterCursor: idle.body.cursor })
        expect(page3.body.changedKeys).toEqual([`${prefix}a`])

        // Another namespace's writes never appear in a scoped feed.
        const other = await atomic(client, { protocolVersion: V1, op: 'changes', prefix: `${NS_OTHER}chg:`, limit: 10 })
        expect(other.body.changedKeys).toEqual([`${NS_OTHER}chg:zzz`])
    })

    it('rejects a bad key shape, an oversized value, and malformed bodies', async () => {
        const badKey = await atomic(client, {
            protocolVersion: V1, op: 'cas', key: 'illustration:v2:x', expectedRevision: 0, value: enc({}), operationKey: 'v-badkey',
        })
        expect(badKey.status).toBe(400)
        expect(badKey.body.code).toBe('PLUGIN_ATOMIC_BAD_KEY')

        const badNamespace = await atomic(client, {
            protocolVersion: V1, op: 'cas', key: 'p:not-a-uuid:x', expectedRevision: 0, value: enc({}), operationKey: 'v-badns',
        })
        expect(badNamespace.status).toBe(400)
        expect(badNamespace.body.code).toBe('PLUGIN_ATOMIC_BAD_KEY')

        // 'A' * 24_000_000 base64 decodes to 18 MB > 16 MiB cap.
        const oversized = await atomic(client, {
            protocolVersion: V1, op: 'cas', key: `${NS}big`, expectedRevision: 0,
            value: 'A'.repeat(24_000_000), operationKey: 'v-big',
        })
        expect(oversized.status).toBe(413)
        expect(oversized.body.code).toBe('PLUGIN_ATOMIC_VALUE_TOO_LARGE')

        const missingRevision = await atomic(client, {
            protocolVersion: V1, op: 'cas', key: `${NS}malformed`, value: enc({}), operationKey: 'v-mal',
        })
        expect(missingRevision.status).toBe(400)
        expect(missingRevision.body.code).toBe('PLUGIN_ATOMIC_BAD_REQUEST')

        const unknownOp = await atomic(client, { protocolVersion: V1, op: 'frobnicate' })
        expect(unknownOp.status).toBe(400)
        expect(unknownOp.body.code).toBe('PLUGIN_ATOMIC_BAD_REQUEST')

        const wrongProtocol = await atomic(client, { protocolVersion: 2, op: 'read', key: `${NS}x` })
        expect(wrongProtocol.status).toBe(400)
        expect(wrongProtocol.body.code).toBe('PLUGIN_ATOMIC_BAD_REQUEST')
    })

    it('requires auth', async () => {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/plugin/atomic`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ protocolVersion: V1, op: 'read', key: `${NS}x` }),
        })
        expect(res.status).toBe(400)
        expect((await res.json()).error).toBe('No auth header')
    })
})

describe('plugin atomic storage (restart monotonicity)', { timeout: 30_000 }, () => {
    it('preserves revisions across a SIGKILL restart; the counters table persists', async () => {
        const first = await boot()
        const clientA = await createClient(first.port, first.password)
        const key = `${NS}restart:a`

        expect((await atomic(clientA, {
            protocolVersion: V1, op: 'cas', key, expectedRevision: 0, value: enc({ v: 1 }), operationKey: 'r-1',
        })).body).toEqual({ applied: true, revision: 1 })
        expect((await atomic(clientA, {
            protocolVersion: V1, op: 'cas', key, expectedRevision: 1, value: enc({ v: 2 }), operationKey: 'r-2',
        })).body).toEqual({ applied: true, revision: 2 })
        const beforeCursor = (await atomic(clientA, { protocolVersion: V1, op: 'changes', prefix: NS, limit: 10 })).body.cursor

        const dbPath = path.join(first.cwd, 'save', 'risuai.db')
        const seedDb = new Database(dbPath)
        try {
            seedDb.prepare('INSERT INTO plugin_atomic_counters (name, value) VALUES (?, ?)').run('gate-b1-restart', 9)
        } finally {
            seedDb.close()
        }

        await first.stop('SIGKILL')

        const second = await boot(first.cwd)
        const clientB = await createClient(second.port, second.password)

        const read = await atomic(clientB, { protocolVersion: V1, op: 'read', key })
        expect(read.body.revision).toBe(2)
        expect((await atomic(clientB, {
            protocolVersion: V1, op: 'cas', key, expectedRevision: 2, value: enc({ v: 3 }), operationKey: 'r-3',
        })).body).toEqual({ applied: true, revision: 3 })

        // The change cursor survives the crash: it still resolves (same epoch)
        // and reports only the post-crash write.
        const after = await atomic(clientB, { protocolVersion: V1, op: 'changes', prefix: NS, limit: 10, afterCursor: beforeCursor })
        expect(after.status).toBe(200)
        expect(after.body.changedKeys).toEqual([key])

        const counterDb = new Database(path.join(second.cwd, 'save', 'risuai.db'), { readonly: true })
        try {
            const row = counterDb.prepare('SELECT value FROM plugin_atomic_counters WHERE name = ?').get('gate-b1-restart') as
                | { value: number }
                | undefined
            expect(row?.value).toBe(9)
        } finally {
            counterDb.close()
        }
    })
})

describe('plugin atomic storage (backup / restore wiring)', { timeout: 60_000 }, () => {
    it('backup export carries plugin_atomic; import restores it and bumps the epoch', async () => {
        const server = await boot()
        const client = await createClient(server.port, server.password)

        // A valid database.risudat must exist for import to accept the archive.
        await client.importBackup(createSeedBackup())

        const key = `${NS}backup:a`
        await atomic(client, { protocolVersion: V1, op: 'cas', key, expectedRevision: 0, value: enc({ v: 1 }), operationKey: 'bk-1' })
        await atomic(client, { protocolVersion: V1, op: 'cas', key, expectedRevision: 1, value: enc({ v: 2 }), operationKey: 'bk-2' })
        // The seed import above already bumped the epoch once, so capture it
        // rather than assuming 0.
        const before = await atomic(client, { protocolVersion: V1, op: 'changes', prefix: NS, limit: 10 })
        const epochBefore = before.body.epoch as number
        expect(epochBefore).toBeGreaterThanOrEqual(1)

        const archive = await client.exportBackup()
        const result = await client.importBackup(archive)
        expect(result.ok).toBe(true)

        // Rows survive the wipe → restore round trip with revisions intact.
        const read = await atomic(client, { protocolVersion: V1, op: 'read', key })
        expect(read.body.revision).toBe(2)
        expect(dec(read.body.value)).toEqual({ v: 2 })

        // ...but the epoch moved, so a pre-import cursor is explicitly expired
        // rather than silently missing changes.
        const expired = await atomic(client, { protocolVersion: V1, op: 'changes', prefix: NS, limit: 10, afterCursor: before.body.cursor })
        expect(expired.status).toBe(409)
        expect(expired.body.code).toBe('PLUGIN_ATOMIC_CURSOR_EXPIRED')

        const fresh = await atomic(client, { protocolVersion: V1, op: 'changes', prefix: NS, limit: 10 })
        expect(fresh.body.epoch).toBeGreaterThan(epochBefore)
        expect(fresh.body.changedKeys).toEqual([key])
    })

    it('snapshot restore purges plugin_atomic and bumps the epoch', async () => {
        const server = await boot()
        const client = await createClient(server.port, server.password)
        await client.importBackup(createSeedBackup())

        // Plant a snapshot deterministically: copy the live db blob to a
        // dbbackup-* key. createBackupAndRotate is interval-throttled and
        // already fired during the seed import, so writing the key directly is
        // the only reliable way to have a restorable snapshot in a test.
        const dbRes = await client.fetch('/api/read', {
            headers: { 'file-path': Buffer.from('database/database.bin', 'utf-8').toString('hex') },
        })
        const dbBytes = Buffer.from(await dbRes.arrayBuffer())
        expect(dbBytes.length).toBeGreaterThan(0)
        const snapshotKey = 'database/dbbackup-10000000.bin'
        await client.fetch('/api/write', {
            method: 'POST',
            headers: {
                'content-type': 'application/octet-stream',
                'file-path': Buffer.from(snapshotKey, 'utf-8').toString('hex'),
            },
            body: new Uint8Array(dbBytes),
        })

        const listed = await (await client.fetch('/api/db/snapshots')).json() as { snapshots: { key: string }[] }
        expect(listed.snapshots.map((s) => s.key)).toContain(snapshotKey)

        const key = `${NS}snapshot:a`
        await atomic(client, { protocolVersion: V1, op: 'cas', key, expectedRevision: 0, value: enc({ v: 1 }), operationKey: 'sn-1' })
        const before = await atomic(client, { protocolVersion: V1, op: 'changes', prefix: NS, limit: 10 })

        const restore = await client.fetch('/api/db/snapshots/restore', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: snapshotKey }),
        })
        expect(restore.status).toBe(200)

        // A rewound chat blob must never be paired with forward-moving storage.
        const read = await atomic(client, { protocolVersion: V1, op: 'read', key })
        expect(read.body).toEqual({ key, revision: 0, value: null, deleted: false })
        const expired = await atomic(client, { protocolVersion: V1, op: 'changes', prefix: NS, limit: 10, afterCursor: before.body.cursor })
        expect(expired.status).toBe(409)
        expect(expired.body.code).toBe('PLUGIN_ATOMIC_CURSOR_EXPIRED')
    })
})
