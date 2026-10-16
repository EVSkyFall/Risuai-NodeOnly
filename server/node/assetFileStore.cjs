'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { tmpdir } = require('node:os');
const { Readable } = require('node:stream');
const { Worker } = require('node:worker_threads');
const { generationPath, writeGeneration } = require('./assetFileIO.cjs');

function createAssetFileStore(db, options) {
    const root = path.join(options.saveDir, 'assets');
    const logger = options.logger || console;
    const checkpoint = options.checkpoint || (async () => {});
    function cleanupImportStaging() {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'asset_import_*'").all();
        for (const { name } of tables) db.exec(`DROP TABLE "${name.replaceAll('"', '""')}"`);
    }
    cleanupImportStaging();
    db.exec(`
        CREATE TABLE IF NOT EXISTS asset_file_generations (
            generationId TEXT PRIMARY KEY, key TEXT NOT NULL, size INTEGER NOT NULL,
            sha256 TEXT NOT NULL, updated_at INTEGER NOT NULL, retired INTEGER NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX IF NOT EXISTS asset_file_live_key
            ON asset_file_generations(key) WHERE retired = 0;
        CREATE TABLE IF NOT EXISTS asset_file_timestamps (key TEXT PRIMARY KEY, updated_at INTEGER NOT NULL);
        INSERT INTO asset_file_timestamps SELECT key, max(updated_at) FROM (
            SELECT key, updated_at FROM asset_file_generations UNION ALL
            SELECT key, updated_at FROM kv WHERE substr(key, 1, 7) = 'assets/'
        ) GROUP BY key HAVING 1 ON CONFLICT(key) DO UPDATE SET updated_at = max(updated_at, excluded.updated_at);
        CREATE TABLE IF NOT EXISTS asset_file_revisions (key TEXT PRIMARY KEY, revision TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS asset_file_retries (
            key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL, error TEXT NOT NULL
        );
        INSERT OR IGNORE INTO asset_file_revisions
            SELECT key, lower(hex(randomblob(32))) FROM kv WHERE substr(key, 1, 7) = 'assets/';
    `);
    // Revisions cover old/raw import writers too, including delete/reinsert with identical timestamps.
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
        const row = event === 'DELETE' ? 'OLD' : 'NEW';
        db.exec(`CREATE TRIGGER IF NOT EXISTS asset_file_kv_${event.toLowerCase()}
            AFTER ${event} ON kv WHEN substr(${row}.key, 1, 7) = 'assets/' BEGIN
                INSERT INTO asset_file_revisions(key, revision) VALUES (${row}.key, lower(hex(randomblob(32))))
                    ON CONFLICT(key) DO UPDATE SET revision = excluded.revision;
                UPDATE asset_file_generations SET retired = 1 WHERE key = ${row}.key AND retired = 0;
            END;`);
    }
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
        const row = event === 'DELETE' ? 'OLD' : 'NEW';
        db.exec(`CREATE TRIGGER IF NOT EXISTS asset_file_time_${event.toLowerCase()}
            AFTER ${event} ON kv WHEN substr(${row}.key, 1, 7) = 'assets/' BEGIN
                INSERT INTO asset_file_timestamps VALUES (${row}.key, ${row}.updated_at)
                    ON CONFLICT(key) DO UPDATE SET updated_at = max(updated_at, excluded.updated_at);
            END;`);
    }
    const live = db.prepare('SELECT * FROM asset_file_generations WHERE key = ? AND retired = 0');
    const legacy = db.prepare('SELECT key, length(value) size, updated_at FROM kv WHERE key = ?');
    const readLegacy = db.prepare('SELECT value FROM kv WHERE key = ?');
    const retire = db.prepare('UPDATE asset_file_generations SET retired = 1 WHERE key = ? AND retired = 0');
    const erase = db.prepare('DELETE FROM kv WHERE key = ?');
    const revision = db.prepare('SELECT revision FROM asset_file_revisions WHERE key = ?');
    const bump = db.prepare(`INSERT INTO asset_file_revisions VALUES (?, lower(hex(randomblob(32))))
        ON CONFLICT(key) DO UPDATE SET revision = excluded.revision`);
    const insert = db.prepare(`INSERT INTO asset_file_generations
        (generationId, key, size, sha256, updated_at) VALUES (@generationId, @key, @size, @sha256, @updated_at)
        ON CONFLICT(generationId) DO UPDATE SET retired = 0, updated_at = excluded.updated_at`);
    const setLegacy = db.prepare(`INSERT INTO kv(key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value,
            updated_at = MAX(excluded.updated_at, kv.updated_at + 1)`);
    let pauseDepth = 0;
    let epoch = 0;
    let cursor = '';
    let running = false;
    let timer;
    let worker;
    let pending;
    let cycle;
    let workerQueue = Promise.resolve();
    let workerJobs = 0;
    const migrations = new Set();
    const captures = new Set();
    const rememberTime = db.prepare(`INSERT INTO asset_file_timestamps VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET updated_at = max(updated_at, excluded.updated_at)`);
    const timestamp = db.prepare('SELECT updated_at FROM asset_file_timestamps WHERE key = ?');
    function nextTime(key, now = Date.now()) {
        return Math.max(now, (timestamp.get(key)?.updated_at || 0) + 1);
    }
    function registerRetired(entry) {
        if (!entry?.generationId) return;
        db.prepare(`INSERT OR IGNORE INTO asset_file_generations
            (generationId, key, size, sha256, updated_at, retired) VALUES (?, ?, ?, ?, ?, 1)`)
            .run(entry.generationId, entry.key, entry.size, entry.sha256, Date.now());
    }

    function warn(key, error) {
        logger.warn(`[Asset files] ${key}: ${error?.stack || error}`);
    }

    function paused() {
        return pauseDepth > 0 || !!options.isPaused?.();
    }

    function metadata(key) {
        return live.get(key) || legacy.get(key) || null;
    }

    function publish(key, prepared) {
        const updated_at = nextTime(key);
        rememberTime.run(key, updated_at);
        if (prepared.error) {
            // If SQLite also fails, its exception propagates and the transaction restores the old mapping.
            setLegacy.run(key, prepared.value, updated_at);
        } else {
            retire.run(key);
            erase.run(key);
            bump.run(key);
            insert.run({ key, ...prepared, updated_at });
        }
        db.prepare('DELETE FROM asset_file_retries WHERE key = ?').run(key);
    }

    async function prepare(key, value) {
        const bytes = Buffer.from(value);
        let entry;
        try {
            entry = { key, ...await writeGeneration(root, bytes, options) };
            registerRetired(entry);
            return entry;
        } catch (error) {
            entry ||= { key, ...error.generation };
            try { registerRetired(entry); }
            catch (registrationError) { warn(`${key} generation ${entry.generationId}`, registrationError); }
            warn(key, error);
            return { key, value: bytes, error };
        }
    }

    async function put(key, value) {
        const prepared = await prepare(key, value);
        await checkpoint('pre-publish', prepared);
        db.transaction(() => publish(key, prepared))();
    }

    async function publishBatch(prepared, otherWrites = () => {}, beforeWrites = () => {}) {
        db.transaction(() => {
            beforeWrites();
            for (const entry of prepared) publish(entry.key, entry);
            otherWrites();
        })();
    }

    function removeKey(key) {
        retire.run(key);
        erase.run(key);
        bump.run(key);
        db.prepare('DELETE FROM asset_file_retries WHERE key = ?').run(key);
    }

    async function remove(key) {
        db.transaction(() => removeKey(key))();
    }

    // The importer owns its existing transaction/batch boundaries. Its callback stays synchronous.
    async function legacyBatch(action) { return legacyBatchSync(action); }

    function legacyBatchSync(action) {
        return db.transaction(() => action({
            remove: removeKey,
            put(key, value, { ignoreExisting = false, updated_at = Date.now() } = {}) {
                if (ignoreExisting) {
                    const current = metadata(key);
                    if (current && !current.generationId) return;
                    if (current) {
                        try { fs.statSync(generationPath(root, current.generationId)); return; }
                        catch (error) {
                            if (error.code !== 'ENOENT') throw error;
                            warn(`${key} generation ${current.generationId}`, error);
                        }
                    }
                }
                setLegacy.run(key, value, nextTime(key, updated_at));
            },
            clear() {
                db.prepare('UPDATE asset_file_generations SET retired = 1 WHERE retired = 0').run();
                db.prepare("DELETE FROM kv WHERE substr(key, 1, 7) = 'assets/'").run();
                db.prepare('UPDATE asset_file_revisions SET revision = lower(hex(randomblob(32)))').run();
                db.prepare('DELETE FROM asset_file_retries').run();
            },
        }))();
    }

    async function list(prefix = 'assets/') {
        const escaped = prefix.replace(/[\\%_]/g, '\\$&');
        const rows = db.prepare(`SELECT key, size, updated_at, generationId FROM asset_file_generations
            WHERE retired = 0 AND key LIKE ? ESCAPE '\\'
            UNION ALL SELECT key, length(value) size, updated_at, NULL generationId FROM kv
            WHERE substr(key, 1, 7) = 'assets/' AND key LIKE ? ESCAPE '\\' AND key NOT IN
                (SELECT key FROM asset_file_generations WHERE retired = 0)`).all(`${escaped}%`, `${escaped}%`);
        return rows;
    }

    async function generationStat(entry) {
        try {
            const disk = await fsp.stat(generationPath(root, entry.generationId));
            if (disk.size !== entry.size) warn(`${entry.key} generation ${entry.generationId}`,
                `size mismatch: catalog ${entry.size}, disk ${disk.size}`);
            return { ...entry, size: disk.size };
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            warn(`${entry.key} generation ${entry.generationId}`, error);
            return null;
        }
    }

    async function captureEntries(sources) {
        let directory;
        const entries = [];
        const dispose = async () => {
            if (directory) await fsp.rm(directory, { recursive: true, force: true });
            captures.delete(dispose);
        };
        captures.add(dispose);
        try {
            for (const source of sources) {
                if (source.kind === 'asset') {
                    const entry = await generationStat(source);
                    if (entry) entries.push(entry);
                    continue;
                }
                if (source.kind === 'spool' || source.kind === 'buffer') {
                    entries.push(source.kind === 'buffer'
                        ? { ...source, buffer: Buffer.from(source.buffer), size: source.buffer.length } : source);
                    continue;
                }
                directory ||= await fsp.mkdtemp(path.join(tmpdir(), 'risu-export-'));
                const sourcePath = path.join(directory, String(entries.length));
                if (source.kind === 'kv') {
                    let entry = await runWorker({ type: 'capture', key: source.key, sourcePath });
                    if (entry?.kind === 'asset') entry = await generationStat(entry);
                    if (entry) entries.push({ ...source, ...entry });
                } else {
                    try { await fsp.copyFile(source.sourcePath, sourcePath); }
                    catch (error) {
                        if (error.code !== 'ENOENT') throw error;
                        warn(source.key || source.backupName || source.sourcePath, error);
                        continue;
                    }
                    entries.push({ ...source, kind: 'spool', sourcePath, size: (await fsp.stat(sourcePath)).size });
                }
            }
            entries.dispose = dispose;
            return entries;
        } catch (error) {
            await dispose();
            throw error;
        }
    }

    async function capture(prefix = 'assets/', include = () => true) {
        const rows = await list(prefix);
        return captureEntries(rows.filter(row => include(row.key)).map(row => row.generationId
            ? { ...row, kind: 'asset', sourcePath: generationPath(root, row.generationId) }
            : { ...row, kind: 'kv' }));
    }

    async function stat(key) {
        const entry = metadata(key);
        return entry?.generationId ? generationStat(entry) : entry;
    }

    async function open(key) {
        const row = live.get(key);
        if (row) {
            let handle;
            try {
                handle = await fsp.open(generationPath(root, row.generationId), 'r');
                const { size } = await handle.stat();
                return { ...row, size, stream: handle.createReadStream() };
            } catch (error) {
                if (handle) await handle.close();
                if (error.code !== 'ENOENT') throw error;
                warn(`${key} generation ${row.generationId}`, error);
                return null;
            }
        }
        const value = readLegacy.get(key)?.value;
        if (value === undefined) return null;
        return { ...legacy.get(key), stream: Readable.from([value]) };
    }

    async function get(key) {
        const entry = await open(key);
        if (!entry) return null;
        const chunks = [];
        try {
            for await (const chunk of entry.stream) chunks.push(chunk);
            return Buffer.concat(chunks);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            warn(`${key} generation ${entry.generationId}`, error);
            return null;
        }
    }

    async function stats() {
        return db.prepare(`SELECT coalesce(sum(size), 0) assetFileBytes,
            coalesce(sum(CASE WHEN retired = 0 THEN size ELSE 0 END), 0) fileSize
            FROM asset_file_generations`).get();
    }

    function pauseMigration() {
        pauseDepth++;
        epoch++;
        return () => { pauseDepth--; cursor = ''; };
    }

    async function withMigrationPaused(action) {
        const resume = pauseMigration();
        try { if (workerJobs) await workerQueue; return await action(); }
        finally { resume(); }
    }

    function dispatchWorker(message) {
        if (!worker) {
            const current = new Worker(path.join(__dirname, 'assetFileWorker.cjs'), {
                workerData: { dbPath: options.dbPath || db.name, root },
            });
            worker = current;
            current.on('message', message => {
                if (worker !== current) return;
                const request = pending;
                pending = null;
                if (!request) return;
                try {
                    if (message.type === 'migrate') registerRetired(message.result || message.error?.generation);
                    if (message.error) request.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
                    else request.resolve(message.result);
                } catch (error) { request.reject(error); }
            });
            async function failed(error) {
                if (worker !== current) return;
                worker = null;
                const request = pending;
                pending = null;
                if (request) {
                    const { key, generationId } = request.message;
                    if (generationId) {
                        try {
                            const target = generationPath(root, generationId);
                            const { size } = await fsp.stat(target);
                            const hash = crypto.createHash('sha256');
                            for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
                            registerRetired({ key, generationId, size, sha256: hash.digest('hex') });
                        } catch (registrationError) {
                            if (registrationError.code !== 'ENOENT') warn(`${key} generation ${generationId}`, registrationError);
                        }
                    }
                    request.reject(error);
                }
            }
            current.on('error', failed);
            current.on('exit', code => failed(new Error(`Asset migration worker exited (${code})`)));
        }
        return new Promise((resolve, reject) => {
            if (message.type === 'migrate') {
                message.generationId = crypto.randomBytes(32).toString('hex');
                db.prepare(`INSERT OR IGNORE INTO asset_file_revisions VALUES (?, lower(hex(randomblob(32))))`).run(message.key);
            }
            pending = { resolve, reject, message };
            worker.postMessage(message);
        });
    }

    function runWorker(message) {
        workerJobs++;
        const run = workerQueue.then(() => dispatchWorker(message));
        workerQueue = run.then(() => { workerJobs--; }, () => { workerJobs--; });
        return run;
    }

    function migrateOne(key) {
        const run = migrate(key);
        migrations.add(run);
        run.then(() => migrations.delete(run), () => migrations.delete(run));
        return run;
    }

    async function migrate(key) {
        if (paused()) return false;
        const sourceEpoch = epoch;
        const result = await runWorker({ type: 'migrate', key });
        if (!result) return false;
        await checkpoint('pre-publish', result);
        return db.transaction(() => {
            if (paused() || epoch !== sourceEpoch || revision.get(key)?.revision !== result.sourceRevision) return false;
            const source = legacy.get(key);
            if (!source) return false;
            retire.run(key);
            erase.run(key);
            db.prepare('UPDATE asset_file_generations SET retired = 0, updated_at = ? WHERE generationId = ?')
                .run(source.updated_at, result.generationId);
            db.prepare('DELETE FROM asset_file_retries WHERE key = ?').run(key);
            return true;
        })();
    }

    async function step() {
        if (paused()) { cursor = ''; return false; }
        const row = db.prepare(`SELECT kv.key FROM kv LEFT JOIN asset_file_retries r ON r.key = kv.key
            WHERE substr(kv.key, 1, 7) = 'assets/' AND kv.key > ? AND (r.next_at IS NULL OR r.next_at <= ?)
            ORDER BY kv.key LIMIT 1`).get(cursor, Date.now());
        if (!row) { cursor = ''; return false; }
        cursor = row.key;
        try { await migrateOne(row.key); }
        catch (error) {
            warn(row.key, error);
            const attempts = (db.prepare('SELECT attempts FROM asset_file_retries WHERE key = ?').get(row.key)?.attempts || 0) + 1;
            // Linear backoff has no attempt limit; other keys continue on the next turn.
            db.prepare(`INSERT OR REPLACE INTO asset_file_retries VALUES (?, ?, ?, ?)`)
                .run(row.key, attempts, Date.now() + attempts * 1000, String(error.message || error));
        }
        return true;
    }

    function start() {
        if (running) return;
        running = true;
        const tick = async () => {
            if (!running) return;
            let more = false;
            try { cycle = step(); more = await cycle; }
            catch (error) { warn('migration', error); }
            finally { cycle = null; }
            if (running) {
                timer = setTimeout(tick, more ? 0 : 1000);
                timer.unref?.();
            }
        };
        void tick();
    }

    async function close() {
        running = false;
        clearTimeout(timer);
        if (cycle) await cycle;
        await Promise.allSettled([...migrations]);
        await workerQueue;
        if (worker) await worker.terminate();
        for (const dispose of [...captures]) await dispose();
    }

    return { root, put, prepare, publishBatch, legacyBatch, legacyBatchSync, remove, list, capture, captureEntries, stat, open, get,
        stats, cleanupImportStaging, pauseMigration, withMigrationPaused, migrateOne, start, close };
}

module.exports = { createAssetFileStore };
