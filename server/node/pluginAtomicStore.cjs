'use strict';

// Generic, plugin-scoped atomic storage — the illustration-agnostic Core
// primitive that replaces illustrationAtomicStore.cjs for every new caller
// (REQUEST_..._PURE_PLUGIN_PRIMITIVES_V1 §4). The illustration store stays
// exactly as it is; this module lives alongside it and owns its own tables.
//
// The whole server is a single Node process with one better-sqlite3 writer, so
// a synchronous db.transaction is a true global linearization point. This
// module owns three tables and the transactional operations over them;
// server.cjs owns only HTTP transport (auth, queue routing, typed-error
// mapping).
//
// Semantics carried over VERBATIM from the proven S1 engine:
//  - delete/recreate revision-ABA: rows are NEVER physically deleted. remove
//    writes a revisioned tombstone (revision+1, deleted=1, value=NULL);
//    recreate via cas continues the SAME revision counter, so a stale
//    expectedRevision 0 can never win over a recreated key.
//  - receipt binding: each operationKey is bound to a sha256 of the canonical
//    {op kind, key, expectedRevision, value-hash}. Same key + same binding
//    replays the stored outcome idempotently; same key + different binding is a
//    typed PLUGIN_ATOMIC_RECEIPT_MISMATCH.
//  - list: bounded, cursor-based, key-ordered projection (no values).
//
// Deliberately DROPPED from the illustration engine (request §11 / §4):
//  - the `illustration:` key prefix requirement — replaced by a namespace SHAPE
//    check (`p:<installId>:`). The server validates shape only; it has no
//    plugin identity of its own. Namespace ENFORCEMENT is host-side: the V3
//    surface takes plugin-relative keys and the host prepends the prefix, so a
//    plugin is structurally unable to express another plugin's namespace.
//  - the four illustration authority guards (coordinator/intent/execution/
//    agentMode). Guards return in a later slice as a generic mechanism.
//  - the lazy `illustration:v1:*` legacy-kv import. Dropping it makes
//    read/bulkRead PURE reads, so they no longer need the storage queue.
//
// ADDED here:
//  - `change_seq`: a monotonic per-row stamp driving the `changes` op — the
//    low-cost wake the request requires so plugins never need steady-state full
//    scans or keep-alive polling.
//  - `epoch`: a durable counter bumped whenever storage is wiped out from under
//    a plugin (backup import / snapshot restore). Cursors carry the epoch they
//    were minted in, so a plugin whose cursor predates a restore gets a typed
//    PLUGIN_ATOMIC_CURSOR_EXPIRED instead of silently missing changes.

const crypto = require('crypto');

// Namespace segment = the host's persisted plugin installation id (a
// crypto.randomUUID()). Shape only — the server never resolves it to a plugin.
const KEY_PATTERN = /^p:[0-9a-f-]{36}:/;
const VALUE_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB
const LIST_LIMIT_MAX = 200;
const BULK_READ_MAX = 256;
const CHANGES_LIMIT_MAX = 200;

const CHANGE_SEQ_COUNTER = 'change_seq';
const EPOCH_COUNTER = 'epoch';

// Backup archive entry name for the whole table (see server.cjs export/import).
const BACKUP_ENTRY_NAME = 'plugin_atomic/v1.json';

class PluginAtomicError extends Error {
    constructor(httpStatus, code, message, extra) {
        super(message);
        this.name = 'PluginAtomicError';
        this.isPluginAtomicError = true;
        this.httpStatus = httpStatus;
        this.code = code;
        this.extra = extra || {};
    }
}

const badRequest = (message) => new PluginAtomicError(400, 'PLUGIN_ATOMIC_BAD_REQUEST', message);
const badKey = (message) => new PluginAtomicError(400, 'PLUGIN_ATOMIC_BAD_KEY', message);
const valueTooLarge = (size) =>
    new PluginAtomicError(413, 'PLUGIN_ATOMIC_VALUE_TOO_LARGE', 'plugin atomic value exceeds the size cap', {
        size,
        max: VALUE_MAX_BYTES,
    });
const conflict = (currentRevision, currentDeleted) =>
    new PluginAtomicError(409, 'PLUGIN_ATOMIC_CONFLICT', 'plugin atomic revision conflict', {
        currentRevision,
        currentDeleted,
    });
const receiptMismatch = (operationKey) =>
    new PluginAtomicError(
        409,
        'PLUGIN_ATOMIC_RECEIPT_MISMATCH',
        'operationKey reused with a different binding',
        { operationKey },
    );
const cursorExpired = (epoch) =>
    new PluginAtomicError(
        409,
        'PLUGIN_ATOMIC_CURSOR_EXPIRED',
        'change cursor predates the current storage epoch',
        { epoch },
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

function computeBindingHash({ kind, key, expectedRevision, valueHash }) {
    const canonical = canonicalize({
        kind,
        key,
        expectedRevision,
        valueHash: valueHash === undefined ? null : valueHash,
    });
    return sha256Hex(Buffer.from(JSON.stringify(canonical), 'utf-8'));
}

// ── Input validation helpers ────────────────────────────────────────────────

function requireKey(key) {
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
        throw badKey('key must be namespaced as "p:<installId>:<key>"');
    }
    return key;
}

function requirePrefix(prefix) {
    if (typeof prefix !== 'string' || !KEY_PATTERN.test(prefix)) {
        throw badKey('prefix must be namespaced as "p:<installId>:"');
    }
    return prefix;
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

function requireLimit(value, max) {
    if (!Number.isInteger(value) || value < 1) throw badRequest('limit must be a positive integer');
    return value > max ? max : value;
}

function escapeLike(value) {
    return value.replace(/[\\%_]/g, '\\$&');
}

function createPluginAtomicStore(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS plugin_atomic (
            key        TEXT    PRIMARY KEY,
            revision   INTEGER NOT NULL,
            value      BLOB,
            deleted    INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            change_seq INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS plugin_atomic_change_seq ON plugin_atomic (change_seq);
        CREATE TABLE IF NOT EXISTS plugin_atomic_receipts (
            operation_key      TEXT    PRIMARY KEY,
            op_kind            TEXT    NOT NULL,
            binding_hash       TEXT    NOT NULL,
            key                TEXT    NOT NULL,
            applied            INTEGER NOT NULL,
            resulting_revision INTEGER,
            created_at         INTEGER NOT NULL,
            -- Reserved for the conditional-paid-execution slice so it needs no
            -- schema migration later. Unused (always NULL) in this slice:
            --   lifecycle      admitted/in_progress/succeeded/definite_failure/ambiguous
            --   result_locator opaque pointer to the durable result (e.g. an inlay assetId)
            --   result_hash    digest binding the receipt to that durable result
            lifecycle          TEXT,
            result_locator     TEXT,
            result_hash        TEXT
        );
        CREATE TABLE IF NOT EXISTS plugin_atomic_counters (
            name  TEXT    PRIMARY KEY,
            value INTEGER NOT NULL
        );
    `);

    const selRow = db.prepare('SELECT key, revision, value, deleted, updated_at, change_seq FROM plugin_atomic WHERE key = ?');
    const upsertRow = db.prepare(
        `INSERT INTO plugin_atomic (key, revision, value, deleted, updated_at, change_seq)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
             revision = excluded.revision,
             value = excluded.value,
             deleted = excluded.deleted,
             updated_at = excluded.updated_at,
             change_seq = excluded.change_seq`,
    );

    const selReceipt = db.prepare(
        'SELECT operation_key, op_kind, binding_hash, key, applied, resulting_revision, created_at FROM plugin_atomic_receipts WHERE operation_key = ?',
    );
    const insReceipt = db.prepare(
        `INSERT INTO plugin_atomic_receipts (operation_key, op_kind, binding_hash, key, applied, resulting_revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const selList = db.prepare(
        `SELECT key, revision, deleted FROM plugin_atomic
         WHERE key LIKE ? ESCAPE '\\' AND key > ?
         ORDER BY key ASC LIMIT ?`,
    );

    const selChanges = db.prepare(
        `SELECT key, change_seq FROM plugin_atomic
         WHERE key LIKE ? ESCAPE '\\' AND change_seq > ?
         ORDER BY change_seq ASC LIMIT ?`,
    );

    const upsertCounter = db.prepare(
        'INSERT INTO plugin_atomic_counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = value + excluded.value',
    );
    const setCounter = db.prepare(
        'INSERT INTO plugin_atomic_counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
    );
    const selCounter = db.prepare('SELECT value FROM plugin_atomic_counters WHERE name = ?');

    const selAllRows = db.prepare('SELECT key, revision, value, deleted, updated_at, change_seq FROM plugin_atomic ORDER BY key ASC');
    const delAllRows = db.prepare('DELETE FROM plugin_atomic');
    const delAllReceipts = db.prepare('DELETE FROM plugin_atomic_receipts');
    const countRows = db.prepare('SELECT COUNT(*) AS c FROM plugin_atomic');

    function readCounterRaw(name) {
        const row = selCounter.get(name);
        return row ? row.value : 0;
    }

    // Bumped inside the caller's transaction — never on its own — so the row
    // stamp and the counter can never disagree after a crash.
    function nextChangeSeq() {
        upsertCounter.run(CHANGE_SEQ_COUNTER, 1);
        return readCounterRaw(CHANGE_SEQ_COUNTER);
    }

    // ── Cursors ─────────────────────────────────────────────────────────────
    // "<epoch>:<seq>". The epoch pins the cursor to the storage generation it
    // was minted in: after a backup import or snapshot restore the epoch moves,
    // so an old cursor is rejected loudly instead of resuming against data that
    // no longer relates to it.
    function encodeCursor(epoch, seq) {
        return `${epoch}:${seq}`;
    }

    function decodeCursor(cursor, epoch) {
        if (cursor === undefined || cursor === null || cursor === '') return 0;
        if (typeof cursor !== 'string') throw badRequest('afterCursor must be a string');
        const match = /^(\d+):(\d+)$/.exec(cursor);
        if (!match) throw badRequest('afterCursor is malformed');
        if (Number(match[1]) !== epoch) throw cursorExpired(epoch);
        return Number(match[2]);
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

    // ── read / bulkRead (PURE reads — no import, no write) ───────────────────
    // Unlike the illustration store (whose lazy legacy import made reads
    // mutating), these touch nothing, so server.cjs keeps them off the storage
    // queue entirely.
    function doRead(body) {
        const key = requireKey(body.key);
        return rowToRecord(key, selRow.get(key));
    }

    function doBulkRead(body) {
        const keys = body.keys;
        if (!Array.isArray(keys)) throw badRequest('keys must be an array');
        if (keys.length > BULK_READ_MAX) throw badRequest(`keys exceeds the cap of ${BULK_READ_MAX}`);
        for (const k of keys) requireKey(k);
        return { items: keys.map((k) => rowToRecord(k, selRow.get(k))) };
    }

    // ── list (projection only; no values) ───────────────────────────────────
    function doList(body) {
        const prefix = requirePrefix(body.prefix);
        const limit = requireLimit(body.limit, LIST_LIMIT_MAX);
        const cursor = body.cursor === undefined || body.cursor === null ? '' : body.cursor;
        if (typeof cursor !== 'string') throw badRequest('cursor must be a string');
        const rows = selList.all(`${escapeLike(prefix)}%`, cursor, limit);
        const items = rows.map((r) => ({ key: r.key, revision: r.revision, deleted: !!r.deleted }));
        const nextCursor = rows.length === limit ? rows[rows.length - 1].key : null;
        return { items, nextCursor };
    }

    // ── changes (bounded wake cursor) ───────────────────────────────────────
    // One row per key: a key written twice appears once, at its newest seq.
    // That is correct for a wake — the request's contract is explicit that the
    // event is a hint and the record snapshot is the truth.
    function doChanges(body) {
        const epoch = readCounterRaw(EPOCH_COUNTER);
        // A namespaced prefix is REQUIRED: an unscoped feed would leak every
        // plugin's key names to whichever plugin polled first.
        const prefix = requirePrefix(body.prefix);
        const limit = requireLimit(body.limit, CHANGES_LIMIT_MAX);
        const after = decodeCursor(body.afterCursor, epoch);
        const rows = selChanges.all(`${escapeLike(prefix)}%`, after, limit);
        const lastSeq = rows.length ? rows[rows.length - 1].change_seq : after;
        return {
            cursor: encodeCursor(epoch, lastSeq),
            changedKeys: rows.map((r) => r.key),
            epoch,
        };
    }

    // ── cas ─────────────────────────────────────────────────────────────────
    const casTx = db.transaction((params) => {
        const { key, expectedRevision, valueBuf, operationKey, bindingHash } = params;
        const receipt = selReceipt.get(operationKey);
        if (receipt) {
            if (receipt.binding_hash !== bindingHash) throw receiptMismatch(operationKey);
            return { applied: !!receipt.applied, revision: receipt.resulting_revision };
        }
        const row = selRow.get(key);
        const currentRevision = row ? row.revision : 0;
        const currentDeleted = row ? !!row.deleted : false;
        if (expectedRevision !== currentRevision) throw conflict(currentRevision, currentDeleted);
        const nextRevision = currentRevision + 1;
        const now = Date.now();
        upsertRow.run(key, nextRevision, valueBuf, 0, now, nextChangeSeq());
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
        const bindingHash = computeBindingHash({
            kind: 'cas',
            key,
            expectedRevision,
            valueHash: sha256Hex(valueBuf),
        });
        return casTx({ key, expectedRevision, valueBuf, operationKey, bindingHash });
    }

    // ── remove (revisioned tombstone) ───────────────────────────────────────
    const removeTx = db.transaction((params) => {
        const { key, expectedRevision, operationKey, bindingHash } = params;
        const receipt = selReceipt.get(operationKey);
        if (receipt) {
            if (receipt.binding_hash !== bindingHash) throw receiptMismatch(operationKey);
            return { applied: !!receipt.applied, revision: receipt.resulting_revision };
        }
        const row = selRow.get(key);
        const currentRevision = row ? row.revision : 0;
        const currentDeleted = row ? !!row.deleted : false;
        if (expectedRevision !== currentRevision) throw conflict(currentRevision, currentDeleted);
        const nextRevision = currentRevision + 1;
        const now = Date.now();
        upsertRow.run(key, nextRevision, null, 1, now, nextChangeSeq());
        insReceipt.run(operationKey, 'remove', bindingHash, key, 1, nextRevision, now);
        return { applied: true, revision: nextRevision };
    });

    function doRemove(body) {
        const key = requireKey(body.key);
        const expectedRevision = requireRevision(body.expectedRevision);
        const operationKey = requireOperationKey(body.operationKey);
        const bindingHash = computeBindingHash({
            kind: 'remove',
            key,
            expectedRevision,
            valueHash: null,
        });
        return removeTx({ key, expectedRevision, operationKey, bindingHash });
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

    // ── monotonic counters ──────────────────────────────────────────────────
    const bumpCounterTx = db.transaction((name, delta) => {
        upsertCounter.run(name, delta);
        return readCounterRaw(name);
    });

    function bumpCounter(name, delta = 1) {
        if (typeof name !== 'string' || name.length === 0) throw badRequest('counter name must be a non-empty string');
        if (!Number.isInteger(delta)) throw badRequest('counter delta must be an integer');
        return bumpCounterTx(name, delta);
    }

    function readCounter(name) {
        return readCounterRaw(name);
    }

    function readEpoch() {
        return readCounterRaw(EPOCH_COUNTER);
    }

    // ── Backup / restore wiring ─────────────────────────────────────────────
    // Called by every path that swaps the database blob out from under live
    // storage. Without this a rewound chat blob is silently paired with
    // forward-moving plugin storage. Nested inside an explicit BEGIN (the
    // backup-import path) better-sqlite3 turns this into a SAVEPOINT, so it is
    // safe to call from inside or outside a transaction.
    const purgeForRestoreTx = db.transaction(() => {
        const purged = countRows.get().c;
        delAllRows.run();
        delAllReceipts.run();
        // change_seq stays monotonic on purpose: it must never hand out a
        // sequence number a live client already observed. The epoch bump is
        // what invalidates outstanding cursors.
        upsertCounter.run(EPOCH_COUNTER, 1);
        return purged;
    });

    function purgeForRestore() {
        return purgeForRestoreTx();
    }

    function exportRows() {
        return selAllRows.all().map((row) => ({
            key: row.key,
            revision: row.revision,
            value: row.value != null ? Buffer.from(row.value).toString('base64') : null,
            deleted: row.deleted ? 1 : 0,
            updatedAt: row.updated_at,
            changeSeq: row.change_seq,
        }));
    }

    // Accepts either the bare row array or the versioned envelope written into
    // the backup archive. Returns the number of rows restored.
    const importRowsTx = db.transaction((rows) => {
        let maxSeq = readCounterRaw(CHANGE_SEQ_COUNTER);
        for (const row of rows) {
            const key = requireKey(row.key);
            const revision = requireRevision(row.revision);
            const changeSeq = Number.isInteger(row.changeSeq) && row.changeSeq > 0 ? row.changeSeq : 1;
            const value = typeof row.value === 'string' ? Buffer.from(row.value, 'base64') : null;
            upsertRow.run(
                key,
                revision,
                value,
                row.deleted ? 1 : 0,
                Number.isInteger(row.updatedAt) ? row.updatedAt : Date.now(),
                changeSeq,
            );
            if (changeSeq > maxSeq) maxSeq = changeSeq;
        }
        // Keep the counter ahead of every restored stamp so the next write is
        // ordered AFTER everything the backup carried.
        setCounter.run(CHANGE_SEQ_COUNTER, maxSeq);
        return rows.length;
    });

    function importRows(payload) {
        const rows = Array.isArray(payload) ? payload : payload && Array.isArray(payload.rows) ? payload.rows : null;
        if (!rows) throw badRequest('plugin_atomic backup payload must be an array or {rows: []}');
        return importRowsTx(rows);
    }

    // Single dispatcher. Throws PluginAtomicError; callers map to HTTP.
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
            case 'changes':
                return doChanges(body);
            default:
                throw badRequest(`unknown op: ${String(body.op)}`);
        }
    }

    return {
        execute,
        bumpCounter,
        readCounter,
        readEpoch,
        computeBindingHash,
        purgeForRestore,
        exportRows,
        importRows,
    };
}

// Only cas/remove write. read/bulkRead/list/receipt/changes are pure reads and
// must NOT go through queueStorageOperation — this is the deliberate difference
// from the illustration store, whose read path needed the queue only because of
// its lazy legacy import.
const MUTATING_OPS = new Set(['cas', 'remove']);

module.exports = {
    createPluginAtomicStore,
    PluginAtomicError,
    MUTATING_OPS,
    KEY_PATTERN,
    VALUE_MAX_BYTES,
    LIST_LIMIT_MAX,
    BULK_READ_MAX,
    CHANGES_LIMIT_MAX,
    BACKUP_ENTRY_NAME,
};
