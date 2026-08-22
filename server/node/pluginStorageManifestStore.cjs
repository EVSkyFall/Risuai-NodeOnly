'use strict';

const crypto = require('crypto');
const zlib = require('zlib');

const FORMAT_VERSION = 1;
const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function assertStorage(storage) {
    if (!storage || typeof storage !== 'object' || Array.isArray(storage)) {
        throw new Error('Plugin storage must be an object');
    }
}

function encodeValue(value) {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error('Plugin storage values must be JSON serializable');
    const raw = Buffer.from(json, 'utf8');
    return {
        hash: sha256(raw),
        raw,
        payload: zlib.deflateRawSync(raw, { level: 3 }),
    };
}

function createPluginStorageManifestStore(db, options = {}) {
    const maxCacheBytes = Number.isFinite(options.maxCacheBytes)
        ? Math.max(0, options.maxCacheBytes)
        : DEFAULT_CACHE_BYTES;

    db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_storage_values (
        value_hash TEXT PRIMARY KEY,
        raw_bytes  INTEGER NOT NULL,
        payload    BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plugin_storage_snapshots (
        snapshot_id    TEXT PRIMARY KEY,
        format_version INTEGER NOT NULL,
        item_count     INTEGER NOT NULL,
        content_hash   TEXT NOT NULL,
        map_raw_bytes  INTEGER NOT NULL,
        map_payload    BLOB NOT NULL,
        created_at     INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plugin_storage_live (
        singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
        snapshot_id  TEXT NOT NULL,
        updated_at   INTEGER NOT NULL,
        FOREIGN KEY(snapshot_id) REFERENCES plugin_storage_snapshots(snapshot_id)
      );
    `);

    const getValueStmt = db.prepare('SELECT value_hash, raw_bytes, payload FROM plugin_storage_values WHERE value_hash = ?');
    const putValueStmt = db.prepare(`
      INSERT OR IGNORE INTO plugin_storage_values(value_hash, raw_bytes, payload, created_at)
      VALUES (?, ?, ?, ?)
    `);
    const getSnapshotStmt = db.prepare(`
      SELECT snapshot_id, format_version, item_count, content_hash, map_raw_bytes, map_payload, created_at
      FROM plugin_storage_snapshots WHERE snapshot_id = ?
    `);
    const putSnapshotStmt = db.prepare(`
      INSERT OR IGNORE INTO plugin_storage_snapshots
        (snapshot_id, format_version, item_count, content_hash, map_raw_bytes, map_payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const setLiveStmt = db.prepare(`
      INSERT INTO plugin_storage_live(singleton_id, snapshot_id, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(singleton_id) DO UPDATE SET snapshot_id = excluded.snapshot_id, updated_at = excluded.updated_at
    `);
    const getLiveStmt = db.prepare(`
      SELECT s.snapshot_id, s.item_count, s.content_hash, s.map_raw_bytes, l.updated_at
      FROM plugin_storage_live l JOIN plugin_storage_snapshots s ON s.snapshot_id = l.snapshot_id
      WHERE l.singleton_id = 1
    `);

    const valueCache = new Map();
    let cacheBytes = 0;

    function cacheValue(hash, value, rawBytes) {
        if (maxCacheBytes <= 0 || rawBytes > maxCacheBytes) return;
        const old = valueCache.get(hash);
        if (old) cacheBytes -= old.rawBytes;
        valueCache.delete(hash);
        valueCache.set(hash, { value, rawBytes });
        cacheBytes += rawBytes;
        while (cacheBytes > maxCacheBytes && valueCache.size) {
            const oldestHash = valueCache.keys().next().value;
            const oldest = valueCache.get(oldestHash);
            valueCache.delete(oldestHash);
            cacheBytes -= oldest.rawBytes;
        }
    }

    function loadValue(hash) {
        const cached = valueCache.get(hash);
        if (cached) {
            valueCache.delete(hash);
            valueCache.set(hash, cached);
            return cached.value;
        }
        const row = getValueStmt.get(hash);
        if (!row) throw new Error(`Plugin storage value is missing: ${hash}`);
        const raw = zlib.inflateRawSync(row.payload);
        if (raw.length !== row.raw_bytes || sha256(raw) !== hash) {
            throw new Error(`Plugin storage value checksum mismatch: ${hash}`);
        }
        const value = JSON.parse(raw.toString('utf8'));
        cacheValue(hash, value, raw.length);
        return value;
    }

    function loadMap(snapshotId) {
        const row = getSnapshotStmt.get(snapshotId);
        if (!row) throw new Error(`Plugin storage snapshot is missing: ${snapshotId}`);
        if (row.format_version !== FORMAT_VERSION) {
            throw new Error(`Unsupported plugin storage snapshot version: ${row.format_version}`);
        }
        const raw = zlib.inflateRawSync(row.map_payload);
        const hash = sha256(raw);
        if (raw.length !== row.map_raw_bytes || hash !== row.content_hash || hash !== row.snapshot_id) {
            throw new Error(`Plugin storage snapshot checksum mismatch: ${snapshotId}`);
        }
        const entries = JSON.parse(raw.toString('utf8'));
        if (!Array.isArray(entries) || entries.length !== row.item_count) {
            throw new Error(`Plugin storage snapshot metadata mismatch: ${snapshotId}`);
        }
        for (const entry of entries) {
            if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') {
                throw new Error(`Plugin storage snapshot map is invalid: ${snapshotId}`);
            }
        }
        return entries;
    }

    const storeMapTx = db.transaction((entries, activate) => {
        const raw = Buffer.from(JSON.stringify(entries), 'utf8');
        const contentHash = sha256(raw);
        const now = Date.now();
        putSnapshotStmt.run(
            contentHash,
            FORMAT_VERSION,
            entries.length,
            contentHash,
            raw.length,
            zlib.deflateRawSync(raw, { level: 3 }),
            now,
        );
        if (activate) setLiveStmt.run(contentHash, now);
        return {
            id: contentHash,
            version: FORMAT_VERSION,
            count: entries.length,
            sha256: contentHash,
        };
    });

    const putSnapshotTx = db.transaction((storage, activate) => {
        assertStorage(storage);
        const entries = [];
        const now = Date.now();
        for (const key of Object.keys(storage)) {
            const encoded = encodeValue(storage[key]);
            putValueStmt.run(encoded.hash, encoded.raw.length, encoded.payload, now);
            entries.push([key, encoded.hash]);
        }
        return storeMapTx.immediate(entries, activate);
    });

    function putSnapshot(storage, { activate = true } = {}) {
        return putSnapshotTx.immediate(storage, activate);
    }

    function loadSnapshot(snapshotId) {
        const out = {};
        for (const [key, hash] of loadMap(snapshotId)) out[key] = loadValue(hash);
        return out;
    }

    function getIndex(snapshotId) {
        return loadMap(snapshotId).map(([key, hash]) => {
            const row = getValueStmt.get(hash);
            if (!row) throw new Error(`Plugin storage value is missing: ${hash}`);
            return { key, sha256: hash, bytes: row.raw_bytes };
        });
    }

    function loadSubset(snapshotId, keys) {
        const wanted = new Set((keys || []).map(String));
        const out = {};
        for (const [key, hash] of loadMap(snapshotId)) {
            if (wanted.has(key)) out[key] = loadValue(hash);
        }
        return out;
    }

    const applyTx = db.transaction((baseSnapshotId, values, loadedKeys, activate) => {
        assertStorage(values);
        const loaded = new Set((loadedKeys || []).map(String));
        const valueKeys = Object.keys(values);
        for (const key of valueKeys) loaded.add(key);

        const next = [];
        const existing = new Set();
        for (const [key, oldHash] of loadMap(baseSnapshotId)) {
            if (!loaded.has(key)) {
                next.push([key, oldHash]);
                existing.add(key);
                continue;
            }
            if (!Object.hasOwn(values, key)) continue;
            const encoded = encodeValue(values[key]);
            putValueStmt.run(encoded.hash, encoded.raw.length, encoded.payload, Date.now());
            next.push([key, encoded.hash]);
            existing.add(key);
        }
        for (const key of valueKeys) {
            if (existing.has(key)) continue;
            const encoded = encodeValue(values[key]);
            putValueStmt.run(encoded.hash, encoded.raw.length, encoded.payload, Date.now());
            next.push([key, encoded.hash]);
        }
        return storeMapTx.immediate(next, activate);
    });

    function applyLoadedValues(baseSnapshotId, values, loadedKeys, { activate = true } = {}) {
        return applyTx.immediate(baseSnapshotId, values, loadedKeys, activate);
    }

    function getLiveDescriptor() {
        const row = getLiveStmt.get();
        return row ? {
            id: row.snapshot_id,
            version: FORMAT_VERSION,
            count: row.item_count,
            sha256: row.content_hash,
        } : null;
    }

    function verifySnapshot(snapshotId) {
        try {
            const entries = loadMap(snapshotId);
            for (const [, hash] of entries) loadValue(hash);
            return { ok: true, count: entries.length, sha256: snapshotId };
        } catch (error) {
            return { ok: false, error: String(error?.message || error) };
        }
    }

    function stats() {
        const snapshots = db.prepare('SELECT COUNT(*) count, COALESCE(SUM(map_raw_bytes), 0) raw FROM plugin_storage_snapshots').get();
        const values = db.prepare('SELECT COUNT(*) count, COALESCE(SUM(raw_bytes), 0) raw, COALESCE(SUM(length(payload)), 0) stored FROM plugin_storage_values').get();
        return {
            snapshots: snapshots.count,
            snapshotMapRawBytes: snapshots.raw,
            values: values.count,
            valueRawBytes: values.raw,
            valueStoredBytes: values.stored,
            cacheEntries: valueCache.size,
            cacheBytes,
        };
    }

    return {
        putSnapshot,
        loadSnapshot,
        getIndex,
        loadSubset,
        applyLoadedValues,
        getLiveDescriptor,
        verifySnapshot,
        stats,
    };
}

module.exports = { createPluginStorageManifestStore, FORMAT_VERSION };
