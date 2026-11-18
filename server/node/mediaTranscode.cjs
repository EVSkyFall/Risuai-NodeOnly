'use strict';

// Converts old PNG assets to WebP while the server runs.
//
// Converting never waits for anything and never refuses: the PNG generation an asset had
// simply becomes a retired generation, still on disk. Deleting that file is the one step
// that cannot be undone, so it happens only when the backup side has confirmed that this
// exact file is in a pinned snapshot:
//
//   want.list            what this module would like to delete, one path per line (relative to save/)
//   pin-*.covered        written by the backup script: the lines of want.list that the snapshot it
//                        just made really holds; ingested here, then removed
//   collected/*.list     what this module has deleted, for a mirror of save/assets to follow
//
// A generation file is write-once and its name is never reused, so a path in a covered list is
// proof for the file on disk. Without the backup script nothing is ever deleted.
//
// Every database write and every deletion after startup runs inside the server's storage queue,
// because a backup import holds a transaction open on the shared connection for as long as it
// runs. (The tables are created at startup, before any request; a covered list is removed after
// its rows are committed.)

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { generationPath } = require('./assetFileIO.cjs');
const { CHECKS, isPng, pngFacts, hasMarker } = require('./mediaTranscodeCore.cjs');

const DAY_MS = 86_400_000;
const GENERATION_PATH = /^assets\/[0-9a-f]{2}\/[0-9a-f]{64}\.blob$/;
// Lists, pins and deletions are looked at this often while images are still being converted.
const HOUSEKEEPING_MS = 300_000;
const DEFAULTS = Object.freeze({
    enabled: false,          // false | true | "report" (examine and log, change nothing)
    ageDays: 30,
    quality: 90,
    maxDiff: 4,
    maxBlockDiff: 40,
    markers: ['AssetMaid'],  // an asset is converted only if a PNG text chunk keyword starts with one of these
    paceMs: 2000,            // rest after each encode
    sweepMinutes: 60,        // how often the catalog is searched again once nothing is left to do
    retentionDays: 3,        // a retired generation stays this long after its retirement
    collect: 'transcoded',   // which retired generations may be deleted: "transcoded" originals only, or "all"
    itemTimeoutMinutes: 10,  // an encode that takes longer is abandoned and tried again later
});

function numberIn(value, low, high, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high ? value : fallback;
}

// Unknown fields are ignored and unusable values fall back, so an old or hand-edited file never stops the server.
function normalizeConfig(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const markers = Array.isArray(source.markers) ? source.markers.filter(marker => typeof marker === 'string' && marker) : null;
    return {
        enabled: source.enabled === true || source.enabled === 'report' ? source.enabled : false,
        ageDays: numberIn(source.ageDays, 0, 36500, DEFAULTS.ageDays),
        quality: numberIn(source.quality, 1, 100, DEFAULTS.quality),
        maxDiff: numberIn(source.maxDiff, 0, 255, DEFAULTS.maxDiff),
        maxBlockDiff: numberIn(source.maxBlockDiff, 0, 255, DEFAULTS.maxBlockDiff),
        markers: markers || [...DEFAULTS.markers],
        paceMs: numberIn(source.paceMs, 0, 3_600_000, DEFAULTS.paceMs),
        sweepMinutes: numberIn(source.sweepMinutes, 0.01, 525_600, DEFAULTS.sweepMinutes),
        retentionDays: numberIn(source.retentionDays, 0, 36500, DEFAULTS.retentionDays),
        collect: source.collect === 'all' ? 'all' : 'transcoded',
        itemTimeoutMinutes: numberIn(source.itemTimeoutMinutes, 0.01, 525_600, DEFAULTS.itemTimeoutMinutes),
    };
}

// setTimeout fires after 1 ms when asked for more than about 24.8 days, so a long wait is a
// chain of short ones. Returns a function that cancels it.
function after(ms, action) {
    const end = Date.now() + ms;
    let timer = null;
    let cancelled = false;
    const step = () => {
        if (cancelled) return;
        const left = end - Date.now();
        if (left <= 0) return void action();
        timer = setTimeout(step, Math.min(left, DAY_MS));
        timer.unref?.();
    };
    timer = setTimeout(step, Math.min(Math.max(ms, 0), DAY_MS));
    timer.unref?.();
    return () => { cancelled = true; clearTimeout(timer); };
}

class EncoderUnavailable extends Error {}

function createMediaTranscode({ db, saveDir, store, queue, logger = console, now = Date.now,
    workerPath = path.join(__dirname, 'mediaTranscodeWorker.cjs') }) {
    const originalsDir = path.join(saveDir, 'media-originals');
    const collectedDir = path.join(originalsDir, 'collected');
    const wantPath = path.join(originalsDir, 'want.list');
    const configPath = path.join(saveDir, 'media-transcode.json');

    db.exec(`
        CREATE TABLE IF NOT EXISTS media_transcode_log (
            id TEXT PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL, outcome TEXT NOT NULL,
            result TEXT, detail TEXT, checks INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER, at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS media_transcode_log_result ON media_transcode_log(result) WHERE result IS NOT NULL;
        -- One row per original that a pinned snapshot holds. Rows stay after the file is deleted:
        -- they are the record of which pin has which original.
        CREATE TABLE IF NOT EXISTS media_originals (
            path TEXT PRIMARY KEY, covered_at INTEGER NOT NULL, manifest TEXT,
            deleted_at INTEGER, listed_at INTEGER
        );
    `);
    const generationRelPath = "'assets/' || substr(g.generationId, 1, 2) || '/' || g.generationId || '.blob'";
    const candidates = db.prepare(`
        SELECT g.generationId, g.key, g.size, g.updated_at FROM asset_file_generations g
        LEFT JOIN media_transcode_log l ON l.id = g.generationId
        WHERE g.retired = 0 AND g.updated_at <= @cutoff
            AND (g.updated_at, g.generationId) > (@afterTime, @afterId)
            AND NOT EXISTS (SELECT 1 FROM media_transcode_log made WHERE made.result = g.generationId)
            AND (l.id IS NULL OR l.checks < @checks
                OR (l.outcome = 'error' AND l.next_at <= @now)
                OR (l.outcome = 'would-convert' AND @live = 1))
        ORDER BY g.updated_at, g.generationId LIMIT 50`);
    const record = db.prepare(`
        INSERT INTO media_transcode_log (id, kind, key, outcome, result, detail, checks, attempts, next_at, at)
        VALUES (@id, @kind, @key, @outcome, @result, @detail, @checks, @attempts, @next_at, @at)
        ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, key = excluded.key, outcome = excluded.outcome,
            result = excluded.result, detail = excluded.detail, checks = excluded.checks,
            attempts = excluded.attempts, next_at = excluded.next_at, at = excluded.at`);
    const attemptsOf = db.prepare('SELECT attempts FROM media_transcode_log WHERE id = ?');
    // Retired generations that may be deleted one day, with whether a covered list names them.
    // "transcoded": the PNG generations this module replaced. "all": every generation that was
    // live once. A generation that was never live may still be waiting for its publication
    // (an import, a migration), however long that takes, so it is never in scope.
    const retiredInScope = db.prepare(`
        SELECT g.generationId, ${generationRelPath} AS path, r.retired_at, o.path AS covered
        FROM asset_file_generations g
        JOIN asset_file_retirements r ON r.generationId = g.generationId
        LEFT JOIN media_originals o ON o.path = ${generationRelPath}
        WHERE g.retired = 1 AND (
            EXISTS (SELECT 1 FROM media_transcode_log l WHERE l.id = g.generationId AND l.outcome = 'converted')
            OR (@all = 1 AND r.was_live = 1))`);
    const markDeleted = db.prepare('UPDATE media_originals SET deleted_at = ? WHERE path = ?');

    let running = false;
    let stopping = false;
    let cancelTick = null;
    let wake = null;
    let passPromise = null;
    let holds = 0;
    let worker = null;
    let pending = null;
    let cursor = { time: -1, id: '' };
    let lastHousekeeping = -Infinity;
    let encoderWarned = false;

    const info = (message) => (logger.info || logger.log || (() => {})).call(logger, `[Media transcode] ${message}`);
    const warn = (message) => logger.warn(`[Media transcode] ${message}`);
    // stop() ends a rest at once, and nothing rests once it has been called.
    const rest = (ms) => stopping ? Promise.resolve() : new Promise((resolve) => {
        const cancel = after(ms, resolve);
        wake = () => { cancel(); resolve(); };
    }).finally(() => { wake = null; });
    const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

    function readConfig() {
        try { return normalizeConfig(JSON.parse(fs.readFileSync(configPath, 'utf-8'))); }
        catch (error) {
            if (error.code !== 'ENOENT') warn(`${configPath} is unreadable, using defaults: ${error.message}`);
            return normalizeConfig(null);
        }
    }

    function encode(bytes, config) {
        return new Promise((resolve, reject) => {
            if (stopping) return reject(new Error('the server is stopping'));
            if (!worker) {
                const current = new Worker(workerPath);
                const failed = (error) => {
                    if (worker !== current) return;
                    worker = null;
                    const request = pending;
                    pending = null;
                    if (request) { request.cancelWatchdog(); request.reject(error); }
                };
                current.on('message', (message) => {
                    if (worker !== current) return;
                    const request = pending;
                    pending = null;
                    if (!request) return;
                    request.cancelWatchdog();
                    if (message.unavailable) request.reject(new EncoderUnavailable(message.unavailable));
                    else if (message.error) request.reject(new Error(message.error));
                    else request.resolve(message.webp ? { ...message, webp: Buffer.from(message.webp) } : message);
                });
                current.on('error', failed);
                current.on('exit', (code) => failed(new Error(`transcode worker exited (${code})`)));
                current.unref();
                worker = current;
            }
            const active = worker;
            // A stuck encode must not stop every later image: ending the worker fails this item
            // (it is tried again later with backoff) and the next item gets a fresh worker.
            const cancelWatchdog = after(config.itemTimeoutMinutes * 60_000, () => { void active.terminate(); });
            pending = { resolve, reject, cancelWatchdog };
            active.postMessage({ bytes: new Uint8Array(bytes), options: { quality: config.quality, maxDiff: config.maxDiff, maxBlockDiff: config.maxBlockDiff } });
        });
    }

    function decision(item, outcome, extra = {}) {
        return { id: item.generationId, kind: 'asset', key: item.key, outcome, result: null, detail: null, ...extra };
    }

    // Runs inside the storage queue. An error is tried again with linear backoff and no attempt limit.
    function writeDecisions(decisions) {
        if (!decisions.length) return;
        const at = now();
        db.transaction(() => {
            for (const entry of decisions) {
                const attempts = entry.outcome === 'error' ? (attemptsOf.get(entry.id)?.attempts || 0) + 1 : 0;
                record.run({ ...entry, checks: CHECKS, attempts, at,
                    next_at: entry.outcome === 'error' ? at + attempts * 3_600_000 : null });
            }
        })();
    }

    // Decisions that need no publication are collected in `cheap` and written in one go.
    // Returns true when an encode ran to its end.
    async function examineAsset(item, config, cheap) {
        const file = generationPath(store.root, item.generationId);
        let bytes;
        try {
            const handle = await fsp.open(file, 'r');
            try {
                const head = Buffer.alloc(8);
                const { bytesRead } = await handle.read(head, 0, 8, 0);
                if (bytesRead < 8 || !isPng(head)) { cheap.push(decision(item, 'not-plain-png', { detail: 'not a png' })); return false; }
                // The positioned read above left the handle at 0, so this reads the whole file.
                bytes = await handle.readFile();
            } finally { await handle.close(); }
        } catch (error) {
            cheap.push(decision(item, 'error', { detail: `read: ${error.message}` }));
            return false;
        }
        const facts = pngFacts(bytes);
        if (facts.reason) { cheap.push(decision(item, 'not-plain-png', { detail: facts.reason })); return false; }
        if (!hasMarker(facts.keywords, config.markers)) { cheap.push(decision(item, 'not-marked')); return false; }
        if (stopping) return false;

        let encoded;
        try { encoded = await encode(bytes, config); }
        catch (error) {
            if (error instanceof EncoderUnavailable) throw error;
            // An encode cut short by a shutdown says nothing about the image.
            if (stopping) return false;
            cheap.push(decision(item, 'error', { detail: `encode: ${error.message}` }));
            return true;
        }
        if (encoded.notSmaller) { cheap.push(decision(item, 'not-smaller')); return true; }
        if (encoded.skip) { cheap.push(decision(item, 'failed-check', { detail: encoded.skip })); return true; }
        const detail = JSON.stringify({ from: bytes.length, to: encoded.webp.length,
            diff: Number(Number(encoded.diff).toFixed(3)), blockDiff: Number(Number(encoded.blockDiff).toFixed(1)) });
        if (config.enabled !== true) {
            cheap.push(decision(item, 'would-convert', { detail }));
            return true;
        }

        // The slow file write stays outside the queue; registering and publishing it does not.
        let entry;
        try { entry = await store.writeDetached(item.key, encoded.webp); }
        catch (error) {
            await queue(() => {
                // A file that was written but failed its read-back is tracked, so it is not lost sight of.
                if (error.generation) { try { store.registerRetired({ key: item.key, ...error.generation }); } catch {} }
                writeDecisions([decision(item, 'error', { detail: `write: ${error.message}` })]);
            });
            return true;
        }
        try {
            // One transaction: the replaced original is only ever found again through its
            // "converted" row, so a publication without that row must not exist.
            await queue(() => db.transaction(() => {
                // When the key has moved on, its new generation is examined once it is old enough;
                // the generation written here stays registered, retired and unused.
                if (!store.publishIfCurrent(item.key, item.generationId, entry)) return;
                writeDecisions([decision(item, 'converted', { result: entry.generationId, detail })]);
            }).immediate());
        } catch (error) {
            // Nothing was committed, so the file written above belongs to no row.
            try { await queue(() => store.discardDetached(entry.generationId)); } catch {}
            throw error;
        }
        return true;
    }

    // One batch from the cursor on. Returns false when the catalog has nothing left.
    async function sweepAssets(config) {
        const batch = candidates.all({ cutoff: now() - config.ageDays * DAY_MS, afterTime: cursor.time, afterId: cursor.id,
            checks: CHECKS, now: now(), live: config.enabled === true ? 1 : 0 });
        if (!batch.length) return false;
        const cheap = [];
        try {
            for (const item of batch) {
                if (stopping || store.isPaused()) break;
                let encoded = false;
                try { encoded = await examineAsset(item, config, cheap); }
                catch (error) {
                    if (error instanceof EncoderUnavailable) throw error;
                    // Left without a decision, so the next search takes it up again.
                    warn(`${item.key}: ${error?.message || error}`);
                }
                if (stopping) break;
                cursor = { time: item.updated_at, id: item.generationId };
                if (config.enabled === true && now() - lastHousekeeping >= HOUSEKEEPING_MS) {
                    // Decisions first: the housekeeping below reads them.
                    if (cheap.length) await queue(() => writeDecisions(cheap.splice(0)));
                    await housekeeping(config);
                }
                if (encoded && config.paceMs > 0) await rest(config.paceMs);
                else await nextTurn();
            }
        } finally {
            if (cheap.length) await queue(() => writeDecisions(cheap));
        }
        return true;
    }

    async function ingestCovered() {
        let names;
        try { names = (await fsp.readdir(originalsDir)).filter(name => name.endsWith('.covered')).sort(); }
        catch (error) { if (error.code !== 'ENOENT') warn(`cannot list ${originalsDir}: ${error.message}`); return; }
        for (const name of names) {
            if (stopping) return;
            const file = path.join(originalsDir, name);
            let lines;
            try { lines = (await fsp.readFile(file, 'utf-8')).split('\n').map(line => line.replace(/\r$/, '')); }
            catch (error) { if (error.code !== 'ENOENT') warn(`cannot read ${file}: ${error.message}`); continue; }
            const paths = lines.filter(line => GENERATION_PATH.test(line));
            await queue(() => {
                const at = now();
                const insert = db.prepare('INSERT OR IGNORE INTO media_originals (path, covered_at, manifest) VALUES (?, ?, ?)');
                db.transaction(() => { for (const entry of paths) insert.run(entry, at, name); })();
            });
            await fsp.unlink(file).catch((error) => { if (error.code !== 'ENOENT') warn(`cannot remove ${file}: ${error.message}`); });
            info(`${name}: ${paths.length} originals are pinned`);
        }
    }

    async function writeAtomic(file, text) {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        const handle = await fsp.open(temp, 'wx');
        try { await handle.writeFile(text); await handle.sync(); }
        finally { await handle.close(); }
        await fsp.rename(temp, file);
    }

    // Files this module wants pinned: retired, in scope, not in a covered list yet, and present
    // on disk. Compared with the file itself, so a list someone else replaced is put right.
    async function writeWantList(config) {
        const rows = retiredInScope.all({ all: config.collect === 'all' ? 1 : 0 }).filter(row => !row.covered);
        const present = [];
        for (const row of rows) {
            try { if ((await fsp.stat(generationPath(store.root, row.generationId))).isFile()) present.push(row.path); }
            catch (error) { if (error.code !== 'ENOENT') warn(`cannot stat ${row.path}: ${error.message}`); }
        }
        const text = present.sort().map(entry => `${entry}\n`).join('');
        try {
            const current = await fsp.readFile(wantPath, 'utf-8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
            if (current !== text) await writeAtomic(wantPath, text);
        } catch (error) { warn(`cannot write ${wantPath}: ${error.message}`); }
    }

    async function collect(config) {
        const before = now() - config.retentionDays * DAY_MS;
        const due = retiredInScope.all({ all: config.collect === 'all' ? 1 : 0 })
            .filter(row => row.covered && row.retired_at <= before);
        let deleted = 0;
        for (let start = 0; start < due.length && !stopping; start += 200) {
            if (holds > 0 || store.isPaused()) break;
            const chunk = due.slice(start, start + 200);
            await queue(() => {
                if (holds > 0) return;
                for (const row of chunk) {
                    try {
                        // The deletion and its record commit together. If the record cannot be
                        // written the row comes back (its file may already be gone, which the next
                        // attempt tolerates), so a deletion is never left unannounced.
                        const done = db.transaction(() => {
                            if (!store.deleteRetired(row.generationId, before)) return false;
                            markDeleted.run(now(), row.path);
                            return true;
                        }).immediate();
                        if (done) deleted++;
                    } catch (error) { warn(`cannot delete ${row.path}: ${error.message}`); }
                }
            });
            await nextTurn();
        }
        if (deleted) info(`deleted ${deleted} pinned originals`);
    }

    // Tells the mirror which files are gone. Only completed deletions are listed, and a row is
    // marked listed after its list file is in place, so a crash in between lists it again.
    async function listCollected() {
        while (!stopping) {
            const rows = db.prepare(`SELECT path FROM media_originals
                WHERE deleted_at IS NOT NULL AND listed_at IS NULL ORDER BY path LIMIT 5000`).all();
            if (!rows.length) return;
            const file = path.join(collectedDir, `${new Date(now()).toISOString().replace(/[-:.]/g, '')}-${crypto.randomBytes(4).toString('hex')}.list`);
            try { await writeAtomic(file, rows.map(row => `${row.path}\n`).join('')); }
            catch (error) { warn(`cannot write ${file}: ${error.message}`); return; }
            await queue(() => {
                const mark = db.prepare('UPDATE media_originals SET listed_at = ? WHERE path = ? AND listed_at IS NULL');
                db.transaction(() => { for (const row of rows) mark.run(now(), row.path); })();
            });
        }
    }

    async function housekeeping(config) {
        lastHousekeeping = now();
        await ingestCovered();
        await collect(config);
        await listCollected();
        if (!stopping) await writeWantList(config);
    }

    // Returns how long to rest before the next pass.
    async function pass() {
        const config = readConfig();
        if (!config.enabled || store.isPaused()) return 60_000;
        const live = config.enabled === true;
        if (live && now() - lastHousekeeping >= HOUSEKEEPING_MS) await housekeeping(config);
        let more;
        try { more = await sweepAssets(config); }
        catch (error) {
            if (!(error instanceof EncoderUnavailable)) throw error;
            // Nothing is recorded against the image; the encoder is simply tried again later.
            if (!encoderWarned) { encoderWarned = true; warn(`the encoder cannot start, trying again every 10 minutes: ${error.message}`); }
            return 600_000;
        }
        encoderWarned = false;
        if (more) return 0;
        cursor = { time: -1, id: '' };
        if (live && !stopping) await housekeeping(config);
        return config.sweepMinutes * 60_000;
    }

    function start() {
        if (running) return;
        running = true;
        stopping = false;
        const tick = async () => {
            if (!running) return;
            let wait = 60_000;
            try { passPromise = pass(); wait = await passPromise; }
            catch (error) { warn(`pass failed: ${error?.stack || error}`); }
            finally { passPromise = null; }
            if (running) cancelTick = after(wait, tick);
        };
        cancelTick = after(0, tick);
    }

    async function stop() {
        running = false;
        stopping = true;
        cancelTick?.();
        wake?.();
        // Ends an encode in progress: nothing is recorded against its image, which is taken
        // up again after the next start. From here on encode() starts no worker.
        const request = pending;
        const current = worker;
        pending = null;
        worker = null;
        if (request) { request.cancelWatchdog(); request.reject(new Error('the server is stopping')); }
        if (current) await current.terminate();
        if (passPromise) await passPromise.catch(() => {});
    }

    // While held, nothing is deleted. A reader that listed files takes a hold until it has them.
    function hold() {
        holds++;
        let released = false;
        return () => { if (!released) { released = true; holds--; } };
    }

    return { start, stop, hold, pass, housekeeping, readConfig, paths: { originalsDir, collectedDir, wantPath, configPath } };
}

module.exports = { createMediaTranscode, normalizeConfig, DEFAULTS, after };
