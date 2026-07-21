// @vitest-environment node

// Unit tests for the illustration atomic store module (server/node/
// illustrationAtomicStore.cjs) over an in-process better-sqlite3 db — the
// chunkStore.test.ts pattern. Covers the internal monotonic-counter helper
// (which has no HTTP surface in S1) and store-level restart persistence, plus a
// couple of core-logic invariants, without the cost/flake of spawning a server.

import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pkg from './illustrationAtomicStore.cjs'

const { createIllustrationAtomicStore } = pkg as {
    createIllustrationAtomicStore: (db: any) => {
        execute: (body: any) => any
        bumpCounter: (name: string, delta?: number) => number
        readCounter: (name: string) => number
        computeBindingHash: (input: any) => string
    }
}

// db.cjs owns the kv table; the store creates only its own three tables. Mirror
// the kv schema so lazy-migration's prepared statement resolves.
function freshDb(file = ':memory:') {
    const db = new Database(file)
    db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)')
    return db
}

function enc(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString('base64')
}

const tmpDirs: string[] = []
afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
        try {
            rmSync(dir, { recursive: true, force: true })
        } catch {
            // best effort
        }
    }
})

describe('illustration atomic counters', () => {
    it('bumpCounter is monotonic and independent per name', () => {
        const db = freshDb()
        const store = createIllustrationAtomicStore(db)
        try {
            expect(store.readCounter('x')).toBe(0)
            expect(store.bumpCounter('x')).toBe(1)
            expect(store.bumpCounter('x')).toBe(2)
            expect(store.bumpCounter('x', 5)).toBe(7)
            expect(store.bumpCounter('y')).toBe(1)
            expect(store.readCounter('x')).toBe(7)
            expect(store.readCounter('y')).toBe(1)
        } finally {
            db.close()
        }
    })

    it('counters survive deletion of every illustration_atomic row', () => {
        const db = freshDb()
        const store = createIllustrationAtomicStore(db)
        try {
            store.execute({ protocolVersion: 1, op: 'cas', key: 'illustration:v2:c', expectedRevision: 0, value: enc({ a: 1 }), operationKey: 'op' })
            store.bumpCounter('fence', 3)
            db.exec('DELETE FROM illustration_atomic')
            expect(store.readCounter('fence')).toBe(3)
            expect(store.bumpCounter('fence')).toBe(4)
        } finally {
            db.close()
        }
    })

    it('counters and revisions persist across a store restart (reopen same file)', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'illus-atomic-'))
        tmpDirs.push(dir)
        const file = path.join(dir, 'store.db')

        const db1 = freshDb(file)
        const store1 = createIllustrationAtomicStore(db1)
        expect(store1.execute({ protocolVersion: 1, op: 'cas', key: 'illustration:v2:k', expectedRevision: 0, value: enc({ v: 1 }), operationKey: 'k-1' })).toEqual({ applied: true, revision: 1 })
        expect(store1.bumpCounter('seq', 10)).toBe(10)
        db1.close()

        // Reopen the same file — a "restart" at the store layer.
        const db2 = freshDb(file)
        const store2 = createIllustrationAtomicStore(db2)
        try {
            expect(store2.readCounter('seq')).toBe(10)
            expect(store2.bumpCounter('seq')).toBe(11)
            const read = store2.execute({ protocolVersion: 1, op: 'read', key: 'illustration:v2:k' })
            expect(read.revision).toBe(1)
            // Revision continues; expectedRevision 0 would now conflict.
            expect(store2.execute({ protocolVersion: 1, op: 'cas', key: 'illustration:v2:k', expectedRevision: 1, value: enc({ v: 2 }), operationKey: 'k-2' })).toEqual({ applied: true, revision: 2 })
        } finally {
            db2.close()
        }
    })
})

describe('illustration atomic binding hash', () => {
    it('is deterministic regardless of guard key order', () => {
        const db = freshDb()
        const store = createIllustrationAtomicStore(db)
        try {
            const a = store.computeBindingHash({
                kind: 'cas', key: 'illustration:v2:x', expectedRevision: 0, valueHash: 'abc',
                guard: { coordinator: { leaseId: 'L', fence: 1 }, agentMode: { generation: 2, mode: 'm' } },
            })
            const b = store.computeBindingHash({
                kind: 'cas', key: 'illustration:v2:x', expectedRevision: 0, valueHash: 'abc',
                guard: { agentMode: { mode: 'm', generation: 2 }, coordinator: { fence: 1, leaseId: 'L' } },
            })
            expect(a).toBe(b)
            // A different value hash changes the binding.
            const c = store.computeBindingHash({ kind: 'cas', key: 'illustration:v2:x', expectedRevision: 0, valueHash: 'zzz', guard: null })
            expect(c).not.toBe(a)
        } finally {
            db.close()
        }
    })
})
