'use strict';

// Server-authoritative atomic storage for the cross-context illustration
// subsystem (Gate 1a — REQUEST_..._MULTICONTEXT_COORDINATOR_CAPTURE_INTENT_V1).
//
// The whole server is a single Node process with one better-sqlite3 writer, so a
// synchronous db.transaction is a true global linearization point (see the
// 03-server scout §7/§11). This module owns three tables and the transactional
// operations over them; server.cjs owns only HTTP transport (auth, queue
// routing, typed-error mapping). Raw CAS is intentionally NOT exposed on the
// general plugin-storage surface — it is reached only through the dedicated
// /api/illustration/atomic endpoint by the host illustration core module.
//
// Design notes that pin the contract (review addendum findings #1/#2/#3/#16):
//  - #3 delete/recreate revision-ABA: rows are NEVER physically deleted. remove
//    writes a revisioned tombstone (revision+1, deleted=1, value=NULL); recreate
//    via cas continues the SAME revision counter. Because a row exists forever
//    after first touch, lazy legacy migration is one-shot by construction — an
//    imported-then-removed key can never be re-imported from the legacy source.
//  - #16 receipt binding: each operationKey is bound to a sha256 of the
//    canonical {op kind, key, expectedRevision, value-hash, guard}. Same key +
//    same binding replays the stored outcome idempotently; same key + different
//    binding is a typed ILLUS_RECEIPT_REUSE_MISMATCH.
//  - #2 guard strictness: when a guard component is supplied the server reads the
//    corresponding record FROM the same illustration_atomic table inside the same
//    transaction and validates it strictly (lease/fence identity, expiry,
//    draining, generation/mode). Any failure is a no-write 409 ILLUS_GUARD_STALE.
//  - #1 list op: bounded, cursor-based, key-ordered projection over the atomic
//    table only (no values, no lazy import).

const crypto = require('crypto');

const KEY_PREFIX = 'illustration:';
const LEGACY_KEY_PREFIX = 'illustration:v1:';
const VALUE_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB
const LIST_LIMIT_MAX = 200;
const BULK_READ_MAX = 256;

// Guard target keys (these records are created by later slices; S1 only reads
// them for guard validation, and its tests seed them through the atomic API).
const COORDINATOR_KEY = 'illustration:v2:coordinator';
const AGENT_MODE_KEY = 'illustration:v2:agentMode';
const INTENT_LIFECYCLE_PREFIX = 'illustration:v2:intent:lifecycle:';
const EXECUTION_PREFIX = 'illustration:v2:exec:';

class IllustrationAtomicError extends Error {
    constructor(httpStatus, code, message, extra) {
        super(message);
        this.name = 'IllustrationAtomicError';
        this.isIllustrationAtomicError = true;
        this.httpStatus = httpStatus;
        this.code = code;
        this.extra = extra || {};
    }
}

const badRequest = (message) => new IllustrationAtomicError(400, 'ILLUS_BAD_REQUEST', message);
const badKey = (message) => new IllustrationAtomicError(400, 'ILLUS_BAD_KEY', message);
const valueTooLarge = (size) =>
    new IllustrationAtomicError(413, 'ILLUS_VALUE_TOO_LARGE', 'illustration atomic value exceeds the size cap', {
        size,
        max: VALUE_MAX_BYTES,
    });
const conflict = (currentRevision, currentDeleted) =>
    new IllustrationAtomicError(409, 'ILLUS_ATOMIC_CONFLICT', 'illustration atomic revision conflict', {
        currentRevision,
        currentDeleted,
    });
const guardStale = (guard, reason) =>
    new IllustrationAtomicError(409, 'ILLUS_GUARD_STALE', 'illustration authority guard is stale', { guard, reason });
const receiptMismatch = (operationKey) =>
    new IllustrationAtomicError(
        409,
        'ILLUS_RECEIPT_REUSE_MISMATCH',
        'operationKey reused with a different binding',
        { operationKey },
    );

function sha256Hex(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Deterministic canonicalization: recursively sort object keys so the binding
// hash is stable regardless of client key ordering.
function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        const out = {};
        for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
        return out;
    }
    return value;
}

function computeBindingHash({ kind, key, expectedRevision, valueHash, guard }) {
    const canonical = canonicalize({
        kind,
        key,
        expectedRevision,
        valueHash: valueHash === undefined ? null : valueHash,
        guard: guard === undefined ? null : guard,
    });
    return sha256Hex(Buffer.from(JSON.stringify(canonical), 'utf-8'));
}

// ── Input validation helpers ────────────────────────────────────────────────

function requireKey(key) {
    if (typeof key !== 'string' || !key.startsWith(KEY_PREFIX)) {
        throw badKey(`key must start with "${KEY_PREFIX}"`);
    }
    return key;
}

function requireRevision(value) {
    if (!Number.isInteger(value) || value < 0) {
        throw badRequest('expectedRevision must be a non-negative integer');
    }
    return value;
}

function requireOperationKey(value) {
    if (typeof value !== 'string' || value.length === 0) {
        throw badRequest('operationKey must be a non-empty string');
    }
    return value;
}

// The per-operation REQUIRED-guard matrix (which semantic op MUST carry which
// guard) belongs to the later semantic endpoints (coordinator/intent/execution
// slices). S1 provides only the mechanics: it validates STRICTLY whenever a
// guard is supplied, and otherwise performs a plain CAS.
function normalizeGuard(guard) {
    if (guard === undefined || guard === null) return null;
    if (typeof guard !== 'object' || Array.isArray(guard)) throw badRequest('guard must be an object');
    const out = {};
    if (guard.coordinator !== undefined) {
        const c = guard.coordinator;
        if (!c || typeof c.leaseId !== 'string' || !Number.isFinite(c.fence)) {
            throw badRequest('invalid coordinator guard');
        }
        out.coordinator = { leaseId: c.leaseId, fence: c.fence };
    }
    if (guard.intent !== undefined) {
        const i = guard.intent;
        if (!i || typeof i.intentId !== 'string' || typeof i.leaseId !== 'string' || !Number.isFinite(i.fence)) {
            throw badRequest('invalid intent guard');
        }
        out.intent = { intentId: i.intentId, leaseId: i.leaseId, fence: i.fence };
    }
    if (guard.execution !== undefined) {
        const e = guard.execution;
        if (!e || typeof e.executionId !== 'string' || !Number.isFinite(e.workFence)) {
            throw badRequest('invalid execution guard');
        }
        out.execution = { executionId: e.executionId, workFence: e.workFence };
    }
    if (guard.agentMode !== undefined) {
        const a = guard.agentMode;
        if (!a || !Number.isFinite(a.generation) || typeof a.mode !== 'string') {
            throw badRequest('invalid agentMode guard');
        }
        out.agentMode = { generation: a.generation, mode: a.mode };
    }
    return Object.keys(out).length ? out : null;
}

function createIllustrationAtomicStore(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS illustration_atomic (
            key        TEXT    PRIMARY KEY,
            revision   INTEGER NOT NULL,
            value      BLOB,
            deleted    INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS illustration_receipts (
            operation_key     TEXT    PRIMARY KEY,
            op_kind           TEXT    NOT NULL,
            binding_hash      TEXT    NOT NULL,
            key               TEXT    NOT NULL,
            applied           INTEGER NOT NULL,
            resulting_revision INTEGER,
            created_at        INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS illustration_counters (
            name  TEXT    PRIMARY KEY,
            value INTEGER NOT NULL
        );
    `);

    const selRow = db.prepare('SELECT key, revision, value, deleted, updated_at FROM illustration_atomic WHERE key = ?');
    const upsertRow = db.prepare(
        `INSERT INTO illustration_atomic (key, revision, value, deleted, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
             revision = excluded.revision,
             value = excluded.value,
             deleted = excluded.deleted,
             updated_at = excluded.updated_at`,
    );
    const insImportRow = db.prepare(
        'INSERT INTO illustration_atomic (key, revision, value, deleted, updated_at) VALUES (?, 1, ?, 0, ?)',
    );
    // Legacy illustration:v1:* values live in the kv table and are never chunked
    // (only database/database.bin is chunked, db.cjs:120), so a direct row read
    // reproduces the exact bytes.
    const selKvValue = db.prepare('SELECT value FROM kv WHERE key = ?');

    const selReceipt = db.prepare(
        'SELECT operation_key, op_kind, binding_hash, key, applied, resulting_revision, created_at FROM illustration_receipts WHERE operation_key = ?',
    );
    const insReceipt = db.prepare(
        `INSERT INTO illustration_receipts (operation_key, op_kind, binding_hash, key, applied, resulting_revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const selList = db.prepare(
        `SELECT key, revision, deleted FROM illustration_atomic
         WHERE key LIKE ? ESCAPE '\\' AND key > ?
         ORDER BY key ASC LIMIT ?`,
    );

    const upsertCounter = db.prepare(
        'INSERT INTO illustration_counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = value + excluded.value',
    );
    const selCounter = db.prepare('SELECT value FROM illustration_counters WHERE name = ?');

    // ── Guard validation (strict, same transaction as the target write) ─────
    function readGuardRecord(key) {
        const row = selRow.get(key);
        if (!row || row.deleted || row.value == null) return null;
        try {
            return JSON.parse(Buffer.from(row.value).toString('utf-8'));
        } catch {
            return null;
        }
    }

    function validateGuard(guard, now) {
        if (!guard) return;
        if (guard.coordinator) {
            const rec = readGuardRecord(COORDINATOR_KEY);
            if (!rec) throw guardStale('coordinator', 'absent');
            if (rec.leaseId !== guard.coordinator.leaseId) throw guardStale('coordinator', 'lease_mismatch');
            if (rec.fence !== guard.coordinator.fence) throw guardStale('coordinator', 'fence_mismatch');
            if (rec.draining === true) throw guardStale('coordinator', 'draining');
            if (!(typeof rec.expiresAt === 'number' && rec.expiresAt > now)) throw guardStale('coordinator', 'expired');
        }
        if (guard.intent) {
            const rec = readGuardRecord(`${INTENT_LIFECYCLE_PREFIX}${guard.intent.intentId}`);
            if (!rec) throw guardStale('intent', 'absent');
            const claim = rec.claim;
            if (!claim) throw guardStale('intent', 'unclaimed');
            if (claim.leaseId !== guard.intent.leaseId) throw guardStale('intent', 'lease_mismatch');
            if (claim.fence !== guard.intent.fence) throw guardStale('intent', 'fence_mismatch');
            if (!(typeof claim.expiresAt === 'number' && claim.expiresAt > now)) throw guardStale('intent', 'expired');
        }
        if (guard.execution) {
            const rec = readGuardRecord(`${EXECUTION_PREFIX}${guard.execution.executionId}`);
            if (!rec) throw guardStale('execution', 'absent');
            if (rec.workFence !== guard.execution.workFence) throw guardStale('execution', 'fence_mismatch');
        }
        if (guard.agentMode) {
            const rec = readGuardRecord(AGENT_MODE_KEY);
            if (!rec) throw guardStale('agentMode', 'absent');
            if (rec.generation !== guard.agentMode.generation) throw guardStale('agentMode', 'generation_mismatch');
            if (rec.mode !== guard.agentMode.mode) throw guardStale('agentMode', 'mode_mismatch');
        }
    }

    // ── read / bulkRead (lazy legacy import) ────────────────────────────────
    function readOrImport(key) {
        const existing = selRow.get(key);
        if (existing) return existing;
        // Import at most once per key ever: the row we insert here persists (as a
        // live row now, or as a tombstone once removed), so this branch can never
        // run again for the same key.
        if (key.startsWith(LEGACY_KEY_PREFIX)) {
            const legacy = selKvValue.get(key);
            if (legacy && legacy.value != null) {
                const now = Date.now();
                insImportRow.run(key, legacy.value, now);
                return { key, revision: 1, value: legacy.value, deleted: 0, updated_at: now };
            }
        }
        return null;
    }

    function rowToRecord(key, row) {
        if (!row) return { key, revision: 0, value: null, deleted: false };
        return {
            key,
            revision: row.revision,
            value: row.value != null ? Buffer.from(row.value).toString('base64') : null,
            deleted: !!row.deleted,
        };
    }

    const readTx = db.transaction((key) => readOrImport(key));
    const bulkReadTx = db.transaction((keys) => keys.map((k) => readOrImport(k)));

    function doRead(body) {
        const key = requireKey(body.key);
        const row = readTx(key);
        return rowToRecord(key, row);
    }

    function doBulkRead(body) {
        const keys = body.keys;
        if (!Array.isArray(keys)) throw badRequest('keys must be an array');
        if (keys.length > BULK_READ_MAX) throw badRequest(`keys exceeds the cap of ${BULK_READ_MAX}`);
        for (const k of keys) requireKey(k);
        const rows = bulkReadTx(keys);
        return { items: keys.map((k, i) => rowToRecord(k, rows[i])) };
    }

    // ── list (projection only; no values, no lazy import) ───────────────────
    function doList(body) {
        const prefix = body.prefix;
        if (typeof prefix !== 'string' || !prefix.startsWith(KEY_PREFIX)) {
            throw badKey(`prefix must start with "${KEY_PREFIX}"`);
        }
        let limit = body.limit;
        if (!Number.isInteger(limit) || limit < 1) throw badRequest('limit must be a positive integer');
        if (limit > LIST_LIMIT_MAX) limit = LIST_LIMIT_MAX;
        const cursor = body.cursor === undefined || body.cursor === null ? '' : body.cursor;
        if (typeof cursor !== 'string') throw badRequest('cursor must be a string');
        const escaped = prefix.replace(/[\\%_]/g, '\\$&');
        const rows = selList.all(`${escaped}%`, cursor, limit);
        const items = rows.map((r) => ({ key: r.key, revision: r.revision, deleted: !!r.deleted }));
        const nextCursor = rows.length === limit ? rows[rows.length - 1].key : null;
        return { items, nextCursor };
    }

    // ── cas ─────────────────────────────────────────────────────────────────
    const casTx = db.transaction((params) => {
        const { key, expectedRevision, valueBuf, operationKey, bindingHash, guard } = params;
        const receipt = selReceipt.get(operationKey);
        if (receipt) {
            if (receipt.binding_hash !== bindingHash) throw receiptMismatch(operationKey);
            return { applied: !!receipt.applied, revision: receipt.resulting_revision };
        }
        validateGuard(guard, Date.now());
        const row = selRow.get(key);
        const currentRevision = row ? row.revision : 0;
        const currentDeleted = row ? !!row.deleted : false;
        if (expectedRevision !== currentRevision) throw conflict(currentRevision, currentDeleted);
        const nextRevision = currentRevision + 1;
        const now = Date.now();
        upsertRow.run(key, nextRevision, valueBuf, 0, now);
        insReceipt.run(operationKey, 'cas', bindingHash, key, 1, nextRevision, now);
        return { applied: true, revision: nextRevision };
    });

    function doCas(body) {
        const key = requireKey(body.key);
        const expectedRevision = requireRevision(body.expectedRevision);
        const operationKey = requireOperationKey(body.operationKey);
        if (typeof body.value !== 'string') throw badRequest('value must be a base64 string');
        const valueBuf = Buffer.from(body.value, 'base64');
        if (valueBuf.length > VALUE_MAX_BYTES) throw valueTooLarge(valueBuf.length);
        const guard = normalizeGuard(body.guard);
        const bindingHash = computeBindingHash({
            kind: 'cas',
            key,
            expectedRevision,
            valueHash: sha256Hex(valueBuf),
            guard,
        });
        return casTx({ key, expectedRevision, valueBuf, operationKey, bindingHash, guard });
    }

    // ── remove (revisioned tombstone) ───────────────────────────────────────
    const removeTx = db.transaction((params) => {
        const { key, expectedRevision, operationKey, bindingHash, guard } = params;
        const receipt = selReceipt.get(operationKey);
        if (receipt) {
            if (receipt.binding_hash !== bindingHash) throw receiptMismatch(operationKey);
            return { applied: !!receipt.applied, revision: receipt.resulting_revision };
        }
        validateGuard(guard, Date.now());
        const row = selRow.get(key);
        const currentRevision = row ? row.revision : 0;
        const currentDeleted = row ? !!row.deleted : false;
        if (expectedRevision !== currentRevision) throw conflict(currentRevision, currentDeleted);
        const nextRevision = currentRevision + 1;
        const now = Date.now();
        upsertRow.run(key, nextRevision, null, 1, now);
        insReceipt.run(operationKey, 'remove', bindingHash, key, 1, nextRevision, now);
        return { applied: true, revision: nextRevision };
    });

    function doRemove(body) {
        const key = requireKey(body.key);
        const expectedRevision = requireRevision(body.expectedRevision);
        const operationKey = requireOperationKey(body.operationKey);
        const guard = normalizeGuard(body.guard);
        const bindingHash = computeBindingHash({
            kind: 'remove',
            key,
            expectedRevision,
            valueHash: null,
            guard,
        });
        return removeTx({ key, expectedRevision, operationKey, bindingHash, guard });
    }

    // ── receipt lookup ──────────────────────────────────────────────────────
    function doReceipt(body) {
        const operationKey = requireOperationKey(body.operationKey);
        const row = selReceipt.get(operationKey);
        if (!row) return { receipt: null };
        return {
            receipt: { applied: !!row.applied, key: row.key, resultingRevision: row.resulting_revision },
        };
    }

    // ── monotonic counters (consumed by later slices; S1 exposes the helper) ─
    const bumpCounterTx = db.transaction((name, delta) => {
        upsertCounter.run(name, delta);
        return selCounter.get(name).value;
    });

    function bumpCounter(name, delta = 1) {
        if (typeof name !== 'string' || name.length === 0) throw badRequest('counter name must be a non-empty string');
        if (!Number.isInteger(delta)) throw badRequest('counter delta must be an integer');
        return bumpCounterTx(name, delta);
    }

    function readCounter(name) {
        const row = selCounter.get(name);
        return row ? row.value : 0;
    }

    // Single dispatcher. Throws IllustrationAtomicError; callers map to HTTP.
    function execute(body) {
        if (!body || typeof body !== 'object') throw badRequest('request body must be an object');
        if (body.protocolVersion !== 1) throw badRequest('protocolVersion must be 1');
        switch (body.op) {
            case 'read':
                return doRead(body);
            case 'bulkRead':
                return doBulkRead(body);
            case 'list':
                return doList(body);
            case 'cas':
                return doCas(body);
            case 'remove':
                return doRemove(body);
            case 'receipt':
                return doReceipt(body);
            default:
                throw badRequest(`unknown op: ${String(body.op)}`);
        }
    }

    return { execute, bumpCounter, readCounter, computeBindingHash };
}

// Ops that may write (cas/remove mutate; read/bulkRead may lazily import a
// legacy value). server.cjs routes these through queueStorageOperation.
const MUTATING_OPS = new Set(['read', 'bulkRead', 'cas', 'remove']);

module.exports = {
    createIllustrationAtomicStore,
    IllustrationAtomicError,
    MUTATING_OPS,
    VALUE_MAX_BYTES,
    LIST_LIMIT_MAX,
    BULK_READ_MAX,
};
