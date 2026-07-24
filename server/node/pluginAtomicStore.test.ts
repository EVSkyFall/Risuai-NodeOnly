// @vitest-environment node

// Unit tests for the generic plugin atomic store module (server/node/
// pluginAtomicStore.cjs) over an in-process better-sqlite3 db — the
// chunkStore.test.ts / illustrationAtomicStore.test.ts pattern. Covers the
// internal helpers with no HTTP surface (monotonic counters, binding hash,
// backup export/import, restore purge) plus store-level restart persistence,
// without the cost/flake of spawning a server.

import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pkg from './pluginAtomicStore.cjs'

const { createPluginAtomicStore, KEY_PATTERN } = pkg as {
    createPluginAtomicStore: (db: any) => {
        execute: (body: any) => any
        bumpCounter: (name: string, delta?: number) => number
        readCounter: (name: string) => number
        readEpoch: () => number
        computeBindingHash: (input: any) => string
        purgeForRestore: () => number
        exportRows: () => any[]
        importRows: (payload: any) => number
    }
    KEY_PATTERN: RegExp
}

// Two distinct installation namespaces. The server validates key SHAPE only —
// it has no plugin identity of its own — so these are just well-formed prefixes.
const NS_A = 'p:11111111-1111-4111-8111-111111111111:'
const NS_B = 'p:22222222-2222-4222-8222-222222222222:'

function freshDb(file = ':memory:') {
    // Unlike the illustration store, the generic store has no kv dependency
    // (the lazy legacy import was dropped), so no kv table is needed here.
    return new Database(file)
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

describe('plugin atomic key shape', () => {
    it('accepts a namespaced key and rejects everything else', () => {
        expect(KEY_PATTERN.test(`${NS_A}jobs/1`)).toBe(true)
        expect(KEY_PATTERN.test('illustration:v2:x')).toBe(false)
        expect(KEY_PATTERN.test('p:not-a-uuid:x')).toBe(false)
        expect(KEY_PATTERN.test('p:11111111-1111-4111-8111-111111111111')).toBe(false)
    })

    it('execute rejects an unnamespaced key with a typed bad-key error', () => {
        const db = freshDb()
        const store = createPluginAtomicStore(db)
        try {
            expect(() => store.execute({
                protocolVersion: 1, op: 'cas', key: 'nope', expectedRevision: 0, value: enc({}), operationKey: 'x',
            })).toThrowError(expect.objectContaining({ code: 'PLUGIN_ATOMIC_BAD_KEY', httpStatus: 400 }))
        } finally {
            db.close()
        }
    })
})

describe('plugin atomic counters', () => {
    it('bumpCounter is monotonic and independent per name', () => {
        const db = freshDb()
        const store = createPluginAtomicStore(db)
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

    it('counters survive deletion of every plugin_atomic row', () => {
        const db = freshDb()
        const store = createPluginAtomicStore(db)
        try {
            store.execute({ protocolVersion: 1, op: 'cas', key: `${NS_A}c`, expectedRevision: 0, value: enc({ a: 1 }), operationKey: 'op' })
            store.bumpCounter('fence', 3)
            db.exec('DELETE FROM plugin_atomic')
            expect(store.readCounter('fence')).toBe(3)
            expect(store.bumpCounter('fence')).toBe(4)
        } finally {
            db.close()
        }
    })

    it('counters and revisions persist across a store restart (reopen same file)', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'plugin-atomic-'))
        tmpDirs.push(dir)
        const file = path.join(dir, 'store.db')

        const db1 = freshDb(file)
        const store1 = createPluginAtomicStore(db1)
        expect(store1.execute({ protocolVersion: 1, op: 'cas', key: `${NS_A}k`, expectedRevision: 0, value: enc({ v: 1 }), operationKey: 'k-1' })).toEqual({ applied: true, revision: 1 })
        expect(store1.bumpCounter('seq', 10)).toBe(10)
        db1.close()

        // Reopen the same file — a "restart" at the store layer.
        const db2 = freshDb(file)
        const store2 = createPluginAtomicStore(db2)
        try {
            expect(store2.readCounter('seq')).toBe(10)
            expect(store2.bumpCounter('seq')).toBe(11)
            const read = store2.execute({ protocolVersion: 1, op: 'read', key: `${NS_A}k` })
            expect(read.revision).toBe(1)
            // Revision continues; expectedRevision 0 would now conflict.
            expect(store2.execute({ protocolVersion: 1, op: 'cas', key: `${NS_A}k`, expectedRevision: 1, value: enc({ v: 2 }), operationKey: 'k-2' })).toEqual({ applied: true, revision: 2 })
        } finally {
            db2.close()
        }
    })
})

describe('plugin atomic binding hash', () => {
    it('is deterministic regardless of nested key order', () => {
        const db = freshDb()
        const store = createPluginAtomicStore(db)
        try {
            const a = store.computeBindingHash({
                kind: 'cas', key: `${NS_A}x`, expectedRevision: 0, valueHash: 'abc',
            })
            const b = store.computeBindingHash({
                expectedRevision: 0, valueHash: 'abc', key: `${NS_A}x`, kind: 'cas',
            })
            expect(a).toBe(b)
            const c = store.computeBindingHash({ kind: 'cas', key: `${NS_A}x`, expectedRevision: 0, valueHash: 'zzz' })
            expect(c).not.toBe(a)
        } finally {
            db.close()
        }
    })
})

describe('plugin atomic changes feed', () => {
    it('is append-ordered, bounded, and namespace-scoped by prefix', () => {
        const db = freshDb()
        const store = createPluginAtomicStore(db)
        try {
            for (const k of ['a', 'b', 'c']) {
                store.execute({ protocolVersion: 1, op: 'cas', key: `${NS_A}${k}`, expectedRevision: 0, value: enc({ k }), operationKey: `seed-${k}` })
            }
            store.execute({ protocolVersion: 1, op: 'cas', key: `${NS_B}z`, expectedRevision: 0, value: enc({}), operationKey: 'seed-z' })

            const page1 = store.execute({ protocolVersion: 1, op: 'changes', prefix: NS_A, limit: 2 })
            expect(page1.changedKeys).toEqual([`${NS_A}a`, `${NS_A}b`])
            expect(page1.epoch).toBe(0)

            const page2 = store.execute({ protocolVersion: 1, op: 'changes', prefix: NS_A, limit: 2, afterCursor: page1.cursor })
            expect(page2.changedKeys).toEqual([`${NS_A}c`])

            const idle = store.execute({ protocolVersion: 1, op: 'changes', prefix: NS_A, limit: 2, afterCursor: page2.cursor })
            expect(idle.changedKeys).toEqual([])
            expect(idle.cursor).toBe(page2.cursor)

            // Re-touching an existing key re-emits it at the END of the feed.
            store.execute({ protocolVersion: 1, op: 'cas', key: `${NS_A}a`, expectedRevision: 1, value: enc({ k: 'a2' }), operationKey: 'bump-a' })
            const page3 = store.execute({ protocolVersion: 1, op: 'changes', prefix: NS_A, limit: 10, afterCursor: idle.cursor })
            expect(page3.changedKeys).toEqual([`${NS_A}a`])

            // Another namespace's writes never leak into a scoped feed.
            const other = store.execute({ protocolVersion: 1, op: 'changes', prefix: NS_B, limit: 10 })
            expect(other.changedKeys).toEqual([`${NS_B}z`])
        } finally {
            db.close()
        }
    })

    it('rejects a cursor minted before the current storage epoch', () => {
        const db = freshDb()
        const store = createPluginAtomicStore(db)
        try {
            store.execute({ protocolVersion: 1, op: 'cas', key: `${NS_A}a`, expectedRevision: 0, value: enc({}), operationKey: 'e-1' })
            const before = store.execute({ protocolVersion: 1, op: 'changes', prefix: NS_A, limit: 10 })
            expect(store.purgeForRestore()).toBe(1)
            expect(() => store.execute({ protocolVersion: 1, op: 'changes', prefix: NS_A, limit: 10, afterCursor: before.cursor }))
                .toThrowError(expect.objectContaining({ code: 'PLUGIN_ATOMIC_CURSOR_EXPIRED' }))
            // A fresh (cursorless) poll works and reports the new epoch.
            expect(store.execute({ protocolVersion: 1, op: 'changes', prefix: NS_A, limit: 10 }).epoch).toBe(1)
        } finally {
            db.close()
        }
    })
})

describe('plugin atomic backup wiring', () => {
    it('purgeForRestore wipes records and receipts and bumps the epoch', () => {
        const db = freshDb()
        const store = createPluginAtomicStore(db)
        try {
            store.execute({ protocolVersion: 1, op: 'cas', key: `${NS_A}a`, expectedRevision: 0, value: enc({ v: 1 }), operationKey: 'p-1' })
            expect(store.execute({ protocolVersion: 1, op: 'receipt', operationKey: 'p-1' }).receipt).not.toBeNull()
            expect(store.readEpoch()).toBe(0)

            expect(store.purgeForRestore()).toBe(1)

            expect(store.readEpoch()).toBe(1)
            expect(store.execute({ protocolVersion: 1, op: 'read', key: `${NS_A}a` })).toEqual({ key: `${NS_A}a`, revision: 0, value: null, deleted: false })
            expect(store.execute({ protocolVersion: 1, op: 'receipt', operationKey: 'p-1' }).receipt).toBeNull()
        } finally {
            db.close()
        }
    })

    it('exportRows/importRows round-trips revisions, tombstones and the change counter', () => {
        const src = freshDb()
        const srcStore = createPluginAtomicStore(src)
        srcStore.execute({ protocolVersion: 1, op: 'cas', key: `${NS_A}live`, expectedRevision: 0, value: enc({ v: 1 }), operationKey: 'x-1' })
        srcStore.execute({ protocolVersion: 1, op: 'cas', key: `${NS_A}live`, expectedRevision: 1, value: enc({ v: 2 }), operationKey: 'x-2' })
        srcStore.execute({ protocolVersion: 1, op: 'cas', key: `${NS_A}gone`, expectedRevision: 0, value: enc({ v: 1 }), operationKey: 'x-3' })
        srcStore.execute({ protocolVersion: 1, op: 'remove', key: `${NS_A}gone`, expectedRevision: 1, operationKey: 'x-4' })
        const payload = srcStore.exportRows()
        src.close()

        const dst = freshDb()
        const dstStore = createPluginAtomicStore(dst)
        try {
            expect(dstStore.importRows(payload)).toBe(2)
            expect(dstStore.execute({ protocolVersion: 1, op: 'read', key: `${NS_A}live` }).revision).toBe(2)
            expect(dstStore.execute({ protocolVersion: 1, op: 'read', key: `${NS_A}gone` })).toMatchObject({ revision: 2, value: null, deleted: true })
            // The change counter advanced past the restored rows, so the next
            // write is ordered AFTER everything the backup carried.
            const seen = dstStore.execute({ protocolVersion: 1, op: 'changes', prefix: NS_A, limit: 10 })
            dstStore.execute({ protocolVersion: 1, op: 'cas', key: `${NS_A}fresh`, expectedRevision: 0, value: enc({}), operationKey: 'y-1' })
            const after = dstStore.execute({ protocolVersion: 1, op: 'changes', prefix: NS_A, limit: 10, afterCursor: seen.cursor })
            expect(after.changedKeys).toEqual([`${NS_A}fresh`])
        } finally {
            dst.close()
        }
    })
})
