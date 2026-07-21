// @vitest-environment node

// Gate 1a — server-authoritative illustration atomic storage contract, exercised
// over the REAL spawned server.cjs + real SQLite (chatContentDurability.test.ts
// pattern). One spawned server for the sequential main describe; a SECOND spawn
// only for the SIGKILL restart-monotonicity case. Each test namespaces its own
// keys so the shared server stays isolated.
//
// Acceptance mapping (request §11.1): 11.1.1/2 → cas conflict + reread; 11.1.1
// (two lock domains) → concurrent two-client cas; 11.1.3 → list keeps both;
// 11.1.4 → restart monotonicity; 11.1.5 → receipt replay/durability; guard →
// §5.1 owner-only-mutation + §11.1.9 TOCTOU no-write.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import path from 'node:path'
import { spawnServer, type ServerHandle } from '../../test/compat/helpers/spawnServer.js'
import { createClient, type RisuClient } from '../../test/compat/helpers/client.js'

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
    const res = await client.fetch('/api/illustration/atomic', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
}

const V1 = 1

describe('illustration atomic storage (single server)', { timeout: 30_000 }, () => {
    let server: ServerHandle
    let client: RisuClient

    beforeEach(async () => {
        server = await boot()
        client = await createClient(server.port, server.password)
    })

    it('cas creates over an absent key and read returns the value (§11.1)', async () => {
        const key = 'illustration:v2:create:a'
        const created = await atomic(client, {
            protocolVersion: V1,
            op: 'cas',
            key,
            expectedRevision: 0,
            value: enc({ hello: 'world' }),
            operationKey: 'op-create-1',
        })
        expect(created.status).toBe(200)
        expect(created.body).toEqual({ applied: true, revision: 1 })

        const read = await atomic(client, { protocolVersion: V1, op: 'read', key })
        expect(read.status).toBe(200)
        expect(read.body.revision).toBe(1)
        expect(read.body.deleted).toBe(false)
        expect(dec(read.body.value)).toEqual({ hello: 'world' })
    })

    it('cas conflict returns currentRevision; loser rereads and retries (§11.1.1/2)', async () => {
        const key = 'illustration:v2:conflict:a'
        const first = await atomic(client, {
            protocolVersion: V1, op: 'cas', key, expectedRevision: 0, value: enc({ n: 1 }), operationKey: 'cf-1',
        })
        expect(first.body).toEqual({ applied: true, revision: 1 })

        const stale = await atomic(client, {
            protocolVersion: V1, op: 'cas', key, expectedRevision: 0, value: enc({ n: 2 }), operationKey: 'cf-2',
        })
        expect(stale.status).toBe(409)
        expect(stale.body.code).toBe('ILLUS_ATOMIC_CONFLICT')
        expect(stale.body.currentRevision).toBe(1)
        expect(stale.body.currentDeleted).toBe(false)

        // Loser rereads and retries with the fresh revision.
        const reread = await atomic(client, { protocolVersion: V1, op: 'read', key })
        expect(reread.body.revision).toBe(1)
        const retry = await atomic(client, {
            protocolVersion: V1, op: 'cas', key, expectedRevision: 1, value: enc({ n: 2 }), operationKey: 'cf-3',
        })
        expect(retry.body).toEqual({ applied: true, revision: 2 })
    })

    it('two concurrent same-key cas from two clients: exactly one applies (§11.1.1)', async () => {
        const clientA = await createClient(server.port, server.password)
        const clientB = await createClient(server.port, server.password)
        const key = 'illustration:v2:race:a'

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
        expect(loser.body.code).toBe('ILLUS_ATOMIC_CONFLICT')
        expect(loser.body.currentRevision).toBe(1)
    })

    it('remove tombstones with a continuing revision; recreate continues, ABA is closed (§11.1)', async () => {
        const key = 'illustration:v2:aba:a'
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

    it('receipts: replay is idempotent; different payload mismatches; receipt is durable (§11.1.5)', async () => {
        const key = 'illustration:v2:receipt:a'
        const first = await atomic(client, {
            protocolVersion: V1, op: 'cas', key, expectedRevision: 0, value: enc({ v: 1 }), operationKey: 'rc-1',
        })
        expect(first.body).toEqual({ applied: true, revision: 1 })

        // Same operationKey + same payload → same result, no double apply.
        const replay = await atomic(client, {
            protocolVersion: V1, op: 'cas', key, expectedRevision: 0, value: enc({ v: 1 }), operationKey: 'rc-1',
        })
        expect(replay.body).toEqual({ applied: true, revision: 1 })
        const afterReplay = await atomic(client, { protocolVersion: V1, op: 'read', key })
        expect(afterReplay.body.revision).toBe(1)

        // Same operationKey + DIFFERENT payload → typed mismatch, no write.
        const mismatch = await atomic(client, {
            protocolVersion: V1, op: 'cas', key, expectedRevision: 0, value: enc({ v: 999 }), operationKey: 'rc-1',
        })
        expect(mismatch.status).toBe(409)
        expect(mismatch.body.code).toBe('ILLUS_RECEIPT_REUSE_MISMATCH')
        expect(dec((await atomic(client, { protocolVersion: V1, op: 'read', key })).body.value)).toEqual({ v: 1 })

        // Advance the record with a different operationKey, then confirm rc-1's
        // receipt is still durably resolvable (§11.1.5 "후속 revision 진행 뒤에도").
        await atomic(client, {
            protocolVersion: V1, op: 'cas', key, expectedRevision: 1, value: enc({ v: 2 }), operationKey: 'rc-2',
        })
        const receipt = await atomic(client, { protocolVersion: V1, op: 'receipt', operationKey: 'rc-1' })
        expect(receipt.body.receipt).toEqual({ applied: true, key, resultingRevision: 1 })

        const missing = await atomic(client, { protocolVersion: V1, op: 'receipt', operationKey: 'never-existed' })
        expect(missing.body.receipt).toBeNull()
    })

    it('guards validate strictly in the same boundary and never write on failure (§5.1/§11.1.9)', async () => {
        const now = Date.now()
        // Seed the coordinator guard-target record through the atomic API itself.
        await atomic(client, {
            protocolVersion: V1, op: 'cas', key: 'illustration:v2:coordinator', expectedRevision: 0,
            value: enc({ leaseId: 'L1', fence: 7, expiresAt: now + 600_000, draining: false }),
            operationKey: 'coord-seed-1',
        })

        const target = 'illustration:v2:guard:target'
        // Matching lease + fence → success.
        const ok = await atomic(client, {
            protocolVersion: V1, op: 'cas', key: target, expectedRevision: 0, value: enc({ ok: 1 }),
            operationKey: 'g-ok-1', guard: { coordinator: { leaseId: 'L1', fence: 7 } },
        })
        expect(ok.body).toEqual({ applied: true, revision: 1 })

        // Wrong fence → stale, no write (target stays at revision 1).
        const wrongFence = await atomic(client, {
            protocolVersion: V1, op: 'cas', key: target, expectedRevision: 1, value: enc({ ok: 2 }),
            operationKey: 'g-badfence', guard: { coordinator: { leaseId: 'L1', fence: 8 } },
        })
        expect(wrongFence.status).toBe(409)
        expect(wrongFence.body).toMatchObject({ code: 'ILLUS_GUARD_STALE', guard: 'coordinator', reason: 'fence_mismatch' })

        // Expired lease → stale.
        await atomic(client, {
            protocolVersion: V1, op: 'cas', key: 'illustration:v2:coordinator', expectedRevision: 1,
            value: enc({ leaseId: 'L1', fence: 7, expiresAt: now - 1000, draining: false }), operationKey: 'coord-seed-2',
        })
        const expired = await atomic(client, {
            protocolVersion: V1, op: 'cas', key: target, expectedRevision: 1, value: enc({ ok: 3 }),
            operationKey: 'g-expired', guard: { coordinator: { leaseId: 'L1', fence: 7 } },
        })
        expect(expired.body).toMatchObject({ code: 'ILLUS_GUARD_STALE', reason: 'expired' })

        // Draining → stale.
        await atomic(client, {
            protocolVersion: V1, op: 'cas', key: 'illustration:v2:coordinator', expectedRevision: 2,
            value: enc({ leaseId: 'L1', fence: 7, expiresAt: now + 600_000, draining: true }), operationKey: 'coord-seed-3',
        })
        const draining = await atomic(client, {
            protocolVersion: V1, op: 'cas', key: target, expectedRevision: 1, value: enc({ ok: 4 }),
            operationKey: 'g-draining', guard: { coordinator: { leaseId: 'L1', fence: 7 } },
        })
        expect(draining.body).toMatchObject({ code: 'ILLUS_GUARD_STALE', reason: 'draining' })

        // agentMode mismatch → stale (absent + wrong generation/mode).
        await atomic(client, {
            protocolVersion: V1, op: 'cas', key: 'illustration:v2:agentMode', expectedRevision: 0,
            value: enc({ generation: 1, mode: 'capture-intent-v1' }), operationKey: 'mode-seed-1',
        })
        const modeStale = await atomic(client, {
            protocolVersion: V1, op: 'cas', key: target, expectedRevision: 1, value: enc({ ok: 5 }),
            operationKey: 'g-mode', guard: { agentMode: { generation: 2, mode: 'capture-intent-v1' } },
        })
        expect(modeStale.body).toMatchObject({ code: 'ILLUS_GUARD_STALE', guard: 'agentMode', reason: 'generation_mismatch' })

        // Every guard failure wrote nothing: target is still at revision 1.
        const finalTarget = await atomic(client, { protocolVersion: V1, op: 'read', key: target })
        expect(finalTarget.body.revision).toBe(1)
        expect(dec(finalTarget.body.value)).toEqual({ ok: 1 })
    })

    it('validates intent and execution guards strictly (nested claim / workFence)', async () => {
        const now = Date.now()
        // Seed an intent lifecycle record (guard reads its nested claim) and an
        // execution record through the atomic API.
        await atomic(client, {
            protocolVersion: V1, op: 'cas', key: 'illustration:v2:intent:lifecycle:INT1', expectedRevision: 0,
            value: enc({ state: 'claimed', claim: { leaseId: 'IL', fence: 3, expiresAt: now + 600_000 } }),
            operationKey: 'intent-seed',
        })
        await atomic(client, {
            protocolVersion: V1, op: 'cas', key: 'illustration:v2:exec:EX1', expectedRevision: 0,
            value: enc({ state: 'dispatched', workFence: 11 }), operationKey: 'exec-seed',
        })

        const target = 'illustration:v2:guard2:target'
        // Both guards satisfied → success.
        const ok = await atomic(client, {
            protocolVersion: V1, op: 'cas', key: target, expectedRevision: 0, value: enc({ ok: 1 }), operationKey: 'g2-ok',
            guard: { intent: { intentId: 'INT1', leaseId: 'IL', fence: 3 }, execution: { executionId: 'EX1', workFence: 11 } },
        })
        expect(ok.body).toEqual({ applied: true, revision: 1 })

        // Wrong intent fence → stale, no write.
        const badIntent = await atomic(client, {
            protocolVersion: V1, op: 'cas', key: target, expectedRevision: 1, value: enc({ ok: 2 }), operationKey: 'g2-intent',
            guard: { intent: { intentId: 'INT1', leaseId: 'IL', fence: 4 } },
        })
        expect(badIntent.body).toMatchObject({ code: 'ILLUS_GUARD_STALE', guard: 'intent', reason: 'fence_mismatch' })

        // Wrong execution workFence → stale.
        const badExec = await atomic(client, {
            protocolVersion: V1, op: 'cas', key: target, expectedRevision: 1, value: enc({ ok: 3 }), operationKey: 'g2-exec',
            guard: { execution: { executionId: 'EX1', workFence: 99 } },
        })
        expect(badExec.body).toMatchObject({ code: 'ILLUS_GUARD_STALE', guard: 'execution', reason: 'fence_mismatch' })

        // Absent execution record → stale (absent).
        const absentExec = await atomic(client, {
            protocolVersion: V1, op: 'cas', key: target, expectedRevision: 1, value: enc({ ok: 4 }), operationKey: 'g2-absent',
            guard: { execution: { executionId: 'MISSING', workFence: 1 } },
        })
        expect(absentExec.body).toMatchObject({ code: 'ILLUS_GUARD_STALE', guard: 'execution', reason: 'absent' })

        expect((await atomic(client, { protocolVersion: V1, op: 'read', key: target })).body.revision).toBe(1)
    })

    it('lazily imports a legacy illustration:v1 key exactly once (§8.1 reconcile)', async () => {
        const key = 'illustration:v1:legacy:sample'
        const legacyValue = Buffer.from(JSON.stringify({ legacy: true, n: 42 }), 'utf-8')
        // Plant the legacy value directly in the kv table via /api/write.
        const write = await client.fetch('/api/write', {
            method: 'POST',
            headers: {
                'content-type': 'application/octet-stream',
                'file-path': Buffer.from(key, 'utf-8').toString('hex'),
            },
            body: new Uint8Array(legacyValue),
        })
        expect(write.status).toBe(200)

        // First atomic read imports it as revision 1.
        const imported = await atomic(client, { protocolVersion: V1, op: 'read', key })
        expect(imported.body.revision).toBe(1)
        expect(imported.body.deleted).toBe(false)
        expect(dec(imported.body.value)).toEqual({ legacy: true, n: 42 })

        // Remove it (tombstone) and confirm it is NOT re-imported from kv.
        const removed = await atomic(client, {
            protocolVersion: V1, op: 'remove', key, expectedRevision: 1, operationKey: 'legacy-rm',
        })
        expect(removed.body).toEqual({ applied: true, revision: 2 })
        const afterRemove = await atomic(client, { protocolVersion: V1, op: 'read', key })
        expect(afterRemove.body).toMatchObject({ revision: 2, value: null, deleted: true })
    })

    it('list is bounded, cursor-paged, key-ordered, and includes tombstones (§11.1.3)', async () => {
        const prefix = 'illustration:v2:list:'
        const suffixes = ['a', 'b', 'c', 'd', 'e']
        for (const s of suffixes) {
            await atomic(client, {
                protocolVersion: V1, op: 'cas', key: `${prefix}${s}`, expectedRevision: 0, value: enc({ s }),
                operationKey: `list-${s}`,
            })
        }
        // Tombstone one entry — it must still appear in the projection.
        await atomic(client, {
            protocolVersion: V1, op: 'remove', key: `${prefix}c`, expectedRevision: 1, operationKey: 'list-rm-c',
        })

        const page1 = await atomic(client, { protocolVersion: V1, op: 'list', prefix, limit: 3 })
        expect(page1.body.items.map((i: any) => i.key)).toEqual([`${prefix}a`, `${prefix}b`, `${prefix}c`])
        expect(page1.body.nextCursor).toBe(`${prefix}c`)
        expect(page1.body.items.find((i: any) => i.key === `${prefix}c`).deleted).toBe(true)

        const page2 = await atomic(client, { protocolVersion: V1, op: 'list', prefix, limit: 3, cursor: page1.body.nextCursor })
        expect(page2.body.items.map((i: any) => i.key)).toEqual([`${prefix}d`, `${prefix}e`])
        expect(page2.body.nextCursor).toBeNull()
    })

    it('bulkRead returns one record per input key, absent → revision 0 (§5.2 bulk)', async () => {
        await atomic(client, {
            protocolVersion: V1, op: 'cas', key: 'illustration:v2:bulk:x', expectedRevision: 0, value: enc({ x: 1 }),
            operationKey: 'bulk-x',
        })
        const res = await atomic(client, {
            protocolVersion: V1, op: 'bulkRead', keys: ['illustration:v2:bulk:x', 'illustration:v2:bulk:absent'],
        })
        expect(res.body.items).toHaveLength(2)
        expect(res.body.items[0]).toMatchObject({ key: 'illustration:v2:bulk:x', revision: 1 })
        expect(dec(res.body.items[0].value)).toEqual({ x: 1 })
        expect(res.body.items[1]).toEqual({ key: 'illustration:v2:bulk:absent', revision: 0, value: null, deleted: false })
    })

    it('rejects a bad key prefix, an oversized value, and malformed bodies (validation)', async () => {
        const badKey = await atomic(client, {
            protocolVersion: V1, op: 'cas', key: 'not-illustration:x', expectedRevision: 0, value: enc({}), operationKey: 'v-badkey',
        })
        expect(badKey.status).toBe(400)
        expect(badKey.body.code).toBe('ILLUS_BAD_KEY')

        // 'A' * 24_000_000 base64 decodes to 18 MB > 16 MiB cap.
        const oversized = await atomic(client, {
            protocolVersion: V1, op: 'cas', key: 'illustration:v2:big', expectedRevision: 0,
            value: 'A'.repeat(24_000_000), operationKey: 'v-big',
        })
        expect(oversized.status).toBe(413)
        expect(oversized.body.code).toBe('ILLUS_VALUE_TOO_LARGE')

        const missingRevision = await atomic(client, {
            protocolVersion: V1, op: 'cas', key: 'illustration:v2:malformed', value: enc({}), operationKey: 'v-mal',
        })
        expect(missingRevision.status).toBe(400)
        expect(missingRevision.body.code).toBe('ILLUS_BAD_REQUEST')

        const unknownOp = await atomic(client, { protocolVersion: V1, op: 'frobnicate' })
        expect(unknownOp.status).toBe(400)
        expect(unknownOp.body.code).toBe('ILLUS_BAD_REQUEST')

        const wrongProtocol = await atomic(client, { protocolVersion: 2, op: 'read', key: 'illustration:v2:x' })
        expect(wrongProtocol.status).toBe(400)
        expect(wrongProtocol.body.code).toBe('ILLUS_BAD_REQUEST')
    })
})

describe('illustration atomic storage (restart monotonicity)', { timeout: 30_000 }, () => {
    it('preserves revisions across a SIGKILL restart; the counters table persists (§11.1.4)', async () => {
        const first = await boot()
        const clientA = await createClient(first.port, first.password)
        const key = 'illustration:v2:restart:a'

        expect((await atomic(clientA, {
            protocolVersion: V1, op: 'cas', key, expectedRevision: 0, value: enc({ v: 1 }), operationKey: 'r-1',
        })).body).toEqual({ applied: true, revision: 1 })
        expect((await atomic(clientA, {
            protocolVersion: V1, op: 'cas', key, expectedRevision: 1, value: enc({ v: 2 }), operationKey: 'r-2',
        })).body).toEqual({ applied: true, revision: 2 })

        // A later slice bumps monotonic counters; write one directly (through a
        // second connection while the server runs — same pattern the durability
        // suite uses for trigger injection) to prove it survives the crash.
        const dbPath = path.join(first.cwd, 'save', 'risuai.db')
        const seedDb = new Database(dbPath)
        try {
            seedDb.prepare('INSERT INTO illustration_counters (name, value) VALUES (?, ?)').run('gate1-restart', 9)
        } finally {
            seedDb.close()
        }

        await first.stop('SIGKILL')

        const second = await boot(first.cwd)
        const clientB = await createClient(second.port, second.password)

        // Revision persisted; a fresh cas continues the counter (no reset).
        const read = await atomic(clientB, { protocolVersion: V1, op: 'read', key })
        expect(read.body.revision).toBe(2)
        expect((await atomic(clientB, {
            protocolVersion: V1, op: 'cas', key, expectedRevision: 2, value: enc({ v: 3 }), operationKey: 'r-3',
        })).body).toEqual({ applied: true, revision: 3 })

        const counterDb = new Database(path.join(second.cwd, 'save', 'risuai.db'), { readonly: true })
        try {
            const row = counterDb.prepare('SELECT value FROM illustration_counters WHERE name = ?').get('gate1-restart') as
                | { value: number }
                | undefined
            expect(row?.value).toBe(9)
        } finally {
            counterDb.close()
        }
    })
})
