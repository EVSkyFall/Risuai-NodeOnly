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
//
// Nothing here looks at the whole catalog in one go: the search walks it in slices and the
// originals are tracked in a table of their own, so the work per step stays the same however
// large the catalog and its history grow.
//
// Inlays (save/inlays/<id>.png with a sidecar <id>.meta.json) are converted the same way, with
// one difference: an inlay has no generations, so its PNG is first copied to
// save/media-originals/inlays/<sha256 of its bytes>.png. That copy is what the want list
// names and what is deleted once pinned. Its name is its content, so here too a path in a
// covered list is proof for the bytes on disk. The live files are then switched in one
// synchronous step inside the storage queue; whatever a crash leaves of that step is a state
// the next search finishes (see examineInlay).

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { Worker } = require('node:worker_threads');
const { generationPath } = require('./assetFileIO.cjs');
const { CHECKS, isPng, pngFacts, hasMarker } = require('./mediaTranscodeCore.cjs');

const DAY_MS = 86_400_000;
// The one path a generation has: its directory is the first two characters of its id.
const GENERATION_PATH = /^assets\/([0-9a-f]{2})\/\1[0-9a-f]{62}\.blob$/;
// The one path a quarantined inlay original has: it is named after the hash of its bytes.
const INLAY_ORIGINAL_PATH = /^media-originals\/inlays\/([0-9a-f]{64})\.png$/;
// Lists, pins and deletions are looked at this often while images are still being converted.
const HOUSEKEEPING_MS = 300_000;
// Decisions about an inlay's bytes that hold until the file or the encode settings change.
const SETTLED = new Set(['not-plain-png', 'failed-check', 'not-smaller']);
const DEFAULTS = Object.freeze({
    enabled: false,          // false | true | "report" (examine and log, change nothing)
    // Inlays follow `enabled`; false leaves them alone, "report" only examines them. Originals
    // that are already in quarantine go on to be pinned and deleted either way, as long as
    // `enabled` is true: they are no longer inlays.
    inlays: true,
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
    const markers = Array.isArray(source.markers) ? source.markers.filter(marker => typeof marker === 'string' && marker) : [];
    return {
        enabled: source.enabled === true || source.enabled === 'report' ? source.enabled : false,
        inlays: source.inlays === false || source.inlays === 'report' ? source.inlays : true,
        ageDays: numberIn(source.ageDays, 0, 36500, DEFAULTS.ageDays),
        quality: numberIn(source.quality, 1, 100, DEFAULTS.quality),
        maxDiff: numberIn(source.maxDiff, 0, 255, DEFAULTS.maxDiff),
        maxBlockDiff: numberIn(source.maxBlockDiff, 0, 255, DEFAULTS.maxBlockDiff),
        // A list without a usable marker would mark nothing; that is a mistake, not a wish.
        markers: markers.length ? markers : [...DEFAULTS.markers],
        paceMs: numberIn(source.paceMs, 0, 3_600_000, DEFAULTS.paceMs),
        sweepMinutes: numberIn(source.sweepMinutes, 0.01, 525_600, DEFAULTS.sweepMinutes),
        retentionDays: numberIn(source.retentionDays, 0, 36500, DEFAULTS.retentionDays),
        collect: source.collect === 'all' ? 'all' : 'transcoded',
        itemTimeoutMinutes: numberIn(source.itemTimeoutMinutes, 0.01, 525_600, DEFAULTS.itemTimeoutMinutes),
    };
}

// setTimeout fires after 1 ms when asked for more than about 24.8 days, so a long wait is a
// chain of short ones, measured on the monotonic clock so that a corrected wall clock neither
// shortens nor stretches it. Returns a function that cancels it.
function after(ms, action) {
    const end = performance.now() + ms;
    let timer = null;
    let cancelled = false;
    const step = () => {
        if (cancelled) return;
        const left = end - performance.now();
        if (left <= 0) return void action();
        timer = setTimeout(step, Math.min(left, DAY_MS));
        timer.unref?.();
    };
    timer = setTimeout(step, Math.min(Math.max(ms, 0), DAY_MS));
    timer.unref?.();
    return () => { cancelled = true; clearTimeout(timer); };
}

class EncoderUnavailable extends Error {}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
// The extension a sidecar names, read the way the server reads it.
const sidecarExt = (value) => (typeof value === 'string' ? value.trim().toLowerCase().replace(/^\.+/, '').replace(/[\/\\\0]/g, '') : '') || 'bin';
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;

async function writeSynced(file, data) {
    const handle = await fsp.open(file, 'wx');
    try { await handle.writeFile(data); await handle.sync(); }
    finally { await handle.close(); }
}

// Makes a rename in this directory durable where the platform allows a directory to be synced.
async function syncDirectory(dir) {
    try {
        const handle = await fsp.open(dir, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
    } catch { /* not supported here */ }
}

// `inlays` is { dir, inUse(id), forgetThumbnail(id, stat) }: the inlay directory, whether
// something else (a Comfy job) depends on the inlay's bytes right now, and a way to drop the
// thumbnail of the payload that was replaced. Without it inlays are not looked at.
function createMediaTranscode({ db, saveDir, store, queue, logger = console, now = Date.now,
    workerPath = path.join(__dirname, 'mediaTranscodeWorker.cjs'), sliceSize = 2000, inlays = null }) {
    const originalsDir = path.join(saveDir, 'media-originals');
    const collectedDir = path.join(originalsDir, 'collected');
    const wantPath = path.join(originalsDir, 'want.list');
    const configPath = path.join(saveDir, 'media-transcode.json');
    const quarantineDir = path.join(originalsDir, 'inlays');
    // Where this module completes its files before they are renamed into place: a quarantine
    // copy, and the new payload and sidecar of an inlay. Nothing is ever prepared inside the
    // inlay directory itself, because an import replaces that directory as a whole.
    const stagingDir = path.join(originalsDir, 'staging');
    // Used only inside the storage queue, and only when the inlay directory turns out to lie
    // on another file system than the staging directory (see moveIn). Inlay listings look at
    // files only, never at subfolders.
    const inlayStagingDir = inlays ? path.join(inlays.dir, '.staging') : null;

    db.exec(`
        -- One row per examined generation. basis is what the decision rested on (the markers
        -- for "not-marked"; the encode settings and the markers for the outcome of an encode),
        -- so it is taken again when the configuration changes.
        CREATE TABLE IF NOT EXISTS media_transcode_log (
            id TEXT PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL, outcome TEXT NOT NULL,
            result TEXT, detail TEXT, basis TEXT, checks INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER, at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS media_transcode_log_result ON media_transcode_log(result) WHERE result IS NOT NULL;
        -- One row per original this module wants to delete, from the moment it wants to. Rows
        -- stay after the deletion: they are the record of which pin has which original.
        CREATE TABLE IF NOT EXISTS media_originals (
            path TEXT PRIMARY KEY, generationId TEXT NOT NULL, wanted_at INTEGER NOT NULL,
            covered_at INTEGER, manifest TEXT, deleted_at INTEGER, listed_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS media_originals_open ON media_originals(path) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS media_originals_unlisted ON media_originals(path)
            WHERE deleted_at IS NOT NULL AND listed_at IS NULL;
    `);
    // Where the slice that starts after the cursor ends: its last row, or nothing when fewer
    // rows than a slice are left.
    const sliceEnd = db.prepare(`
        SELECT updated_at AS time, generationId AS id FROM asset_file_generations
        WHERE retired = 0 AND updated_at <= @cutoff AND (updated_at, generationId) > (@afterTime, @afterId)
        ORDER BY updated_at, generationId LIMIT 1 OFFSET ${Math.max(1, Math.floor(sliceSize)) - 1}`);
    // The upper bound is a plain term so that it ends the index range: inside a slice its end
    // (which the cutoff already limited), in the last, short slice the cutoff itself.
    const candidatesUpTo = (bound) => db.prepare(`
        SELECT g.generationId, g.key, g.size, g.updated_at FROM asset_file_generations g
        LEFT JOIN media_transcode_log l ON l.id = g.generationId
        WHERE g.retired = 0
            AND (g.updated_at, g.generationId) > (@afterTime, @afterId)
            AND ${bound}
            AND NOT EXISTS (SELECT 1 FROM media_transcode_log made WHERE made.result = g.generationId)
            AND (l.id IS NULL OR l.checks < @checks
                OR (l.outcome = 'error' AND l.next_at <= @now)
                OR (l.outcome = 'would-convert' AND @live = 1)
                OR (l.outcome = 'not-marked' AND l.basis IS NOT @markersBasis)
                OR (l.outcome IN ('failed-check', 'not-smaller', 'would-convert') AND l.basis IS NOT @encodeBasis))
        ORDER BY g.updated_at, g.generationId LIMIT 50`);
    const candidatesInSlice = candidatesUpTo('(g.updated_at, g.generationId) <= (@endTime, @endId)');
    const candidatesToCutoff = candidatesUpTo('g.updated_at <= @cutoff');
    const record = db.prepare(`
        INSERT INTO media_transcode_log (id, kind, key, outcome, result, detail, basis, checks, attempts, next_at, at)
        VALUES (@id, @kind, @key, @outcome, @result, @detail, @basis, @checks, @attempts, @next_at, @at)
        ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, key = excluded.key, outcome = excluded.outcome,
            result = excluded.result, detail = excluded.detail, basis = excluded.basis, checks = excluded.checks,
            attempts = excluded.attempts, next_at = excluded.next_at, at = excluded.at`);
    const attemptsOf = db.prepare('SELECT attempts FROM media_transcode_log WHERE id = ?');
    const wantOriginal = db.prepare('INSERT OR IGNORE INTO media_originals (path, generationId, wanted_at) VALUES (?, ?, ?)');
    // For "all": the retired generations that were live once. A generation that was never live
    // may still be waiting for its publication (an import, a migration), however long that
    // takes, so it is never wanted.
    const retiredPage = db.prepare(`SELECT generationId FROM asset_file_retirements
        WHERE was_live = 1 AND generationId > @after ORDER BY generationId LIMIT 1000`);
    const coverOriginal = db.prepare(`
        INSERT INTO media_originals (path, generationId, wanted_at, covered_at, manifest)
        VALUES (@path, @generationId, @at, @at, @manifest)
        ON CONFLICT(path) DO UPDATE SET covered_at = excluded.covered_at, manifest = excluded.manifest
            WHERE media_originals.covered_at IS NULL`);
    // The originals not deleted yet, a page at a time, with what the catalog says about each.
    const openOriginals = db.prepare(`
        SELECT o.path, o.generationId, o.wanted_at, o.covered_at, g.retired, r.retired_at, r.was_live,
            EXISTS (SELECT 1 FROM media_transcode_log l WHERE l.id = o.generationId AND l.outcome = 'converted') AS transcoded
        FROM media_originals o
        LEFT JOIN asset_file_generations g ON g.generationId = o.generationId
        LEFT JOIN asset_file_retirements r ON r.generationId = o.generationId
        WHERE o.deleted_at IS NULL AND o.path > @after
        ORDER BY o.path LIMIT 1000`);
    const markDeleted = db.prepare('UPDATE media_originals SET deleted_at = ? WHERE path = ? AND deleted_at IS NULL');
    const forgetOriginal = db.prepare('DELETE FROM media_originals WHERE path = ? AND deleted_at IS NULL');
    const unlisted = db.prepare(`SELECT path FROM media_originals
        WHERE deleted_at IS NOT NULL AND listed_at IS NULL ORDER BY path LIMIT 5000`);
    const markListed = db.prepare('UPDATE media_originals SET listed_at = ? WHERE path = ? AND listed_at IS NULL');
    const inlayLog = db.prepare('SELECT outcome, basis, checks, next_at FROM media_transcode_log WHERE id = ?');
    // A conversion wants the quarantined original from now on, so the retention starts again
    // even when an earlier conversion of the same bytes already wanted it. A pin counts only
    // for the file it saw: a row that had been closed by a deletion has to be pinned again
    // (and so has a file that is written anew: see quarantine).
    const wantQuarantined = db.prepare(`
        INSERT INTO media_originals (path, generationId, wanted_at) VALUES (@path, @sha, @at)
        ON CONFLICT(path) DO UPDATE SET wanted_at = excluded.wanted_at,
            covered_at = CASE WHEN media_originals.deleted_at IS NULL THEN media_originals.covered_at END,
            manifest = CASE WHEN media_originals.deleted_at IS NULL THEN media_originals.manifest END,
            deleted_at = NULL, listed_at = NULL`);
    const knownOriginal = db.prepare('SELECT 1 FROM media_originals WHERE path = ?');
    const forgetPin = db.prepare('UPDATE media_originals SET covered_at = NULL, manifest = NULL WHERE path = ?');
    // For a file found in quarantine without an open row: an open row is left as it is.
    const adoptQuarantined = db.prepare(`
        INSERT INTO media_originals (path, generationId, wanted_at) VALUES (@path, @sha, @at)
        ON CONFLICT(path) DO UPDATE SET wanted_at = excluded.wanted_at, covered_at = NULL, manifest = NULL,
            deleted_at = NULL, listed_at = NULL
            WHERE media_originals.deleted_at IS NOT NULL`);
    const hasOpenOriginal = db.prepare('SELECT 1 FROM media_originals WHERE path = ? AND deleted_at IS NULL');
    const quarantinedDue = db.prepare(`SELECT 1 FROM media_originals
        WHERE path = ? AND deleted_at IS NULL AND covered_at IS NOT NULL AND wanted_at <= ?`);
    // Inlays have no mirror, so a deleted quarantine file is nobody's to follow: it counts as listed.
    const markDeletedUnlisted = db.prepare('UPDATE media_originals SET deleted_at = @at, listed_at = @at WHERE path = @path AND deleted_at IS NULL');

    let running = false;
    let stopping = false;
    let cancelTick = null;
    let wake = null;
    let passPromise = null;
    let holds = 0;
    let worker = null;
    let pending = null;
    let cursor = { time: -1, id: '' };
    let adoptCursor = '';
    let lastHousekeeping = -Infinity;
    let encoderWarned = false;
    // The ids of the PNG inlays found by the current walk of the inlay directory, and how far
    // the search has got with them. null: the next search walks the directory again.
    let inlayIds = null;
    let inlayIndex = 0;
    const oddQuarantine = new Set();

    const info = (message) => (logger.info || logger.log || (() => {})).call(logger, `[Media transcode] ${message}`);
    const warn = (message) => logger.warn(`[Media transcode] ${message}`);
    // stop() ends a rest at once, and nothing rests once it has been called.
    const rest = (ms) => stopping ? Promise.resolve() : new Promise((resolve) => {
        const cancel = after(ms, resolve);
        wake = () => { cancel(); resolve(); };
    }).finally(() => { wake = null; });
    const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
    // An import is running or waiting for the queue: everything here waits for it to finish.
    const idle = () => stopping || store.isPaused();

    function readConfig() {
        try { return normalizeConfig(JSON.parse(fs.readFileSync(configPath, 'utf-8'))); }
        catch (error) {
            if (error.code !== 'ENOENT') warn(`${configPath} is unreadable, using defaults: ${error.message}`);
            return normalizeConfig(null);
        }
    }
    const markersBasis = (config) => JSON.stringify([...config.markers].sort());
    // An encode is only reached by a marked image, so its outcome rests on the markers as well.
    const encodeBasis = (config) => `${config.quality}/${config.maxDiff}/${config.maxBlockDiff} ${markersBasis(config)}`;

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
            const request = { resolve, reject, cancelWatchdog: null };
            // A stuck encode must not stop every later image: this item fails (it is tried again
            // later with backoff) and the next one gets a fresh worker. The worker is let go of
            // before it is ended, so an answer that still arrives is not taken for the next image's.
            request.cancelWatchdog = after(config.itemTimeoutMinutes * 60_000, () => {
                if (worker === active) worker = null;
                if (pending === request) { pending = null; request.reject(new Error(`no answer from the encoder in ${config.itemTimeoutMinutes} minutes`)); }
                void active.terminate();
            });
            pending = request;
            active.postMessage({ bytes: new Uint8Array(bytes), options: { quality: config.quality, maxDiff: config.maxDiff, maxBlockDiff: config.maxBlockDiff } });
        });
    }

    function decision(item, outcome, extra = {}) {
        return { id: item.generationId, kind: 'asset', key: item.key, outcome, result: null, detail: null, basis: null, ...extra };
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
        if (!hasMarker(facts.keywords, config.markers)) { cheap.push(decision(item, 'not-marked', { basis: markersBasis(config) })); return false; }
        if (idle()) return false;

        let encoded;
        try { encoded = await encode(bytes, config); }
        catch (error) {
            if (error instanceof EncoderUnavailable) throw error;
            // An encode cut short by a shutdown says nothing about the image.
            if (stopping) return false;
            cheap.push(decision(item, 'error', { detail: `encode: ${error.message}` }));
            return true;
        }
        const basis = encodeBasis(config);
        if (encoded.notSmaller) { cheap.push(decision(item, 'not-smaller', { basis })); return true; }
        if (encoded.skip) { cheap.push(decision(item, 'failed-check', { detail: encoded.skip, basis })); return true; }
        const detail = JSON.stringify({ from: bytes.length, to: encoded.webp.length,
            diff: Number(Number(encoded.diff).toFixed(3)), blockDiff: Number(Number(encoded.blockDiff).toFixed(1)) });
        if (config.enabled !== true) {
            cheap.push(decision(item, 'would-convert', { detail, basis }));
            return true;
        }
        // Nothing was decided about the image: it is encoded again when the server is free.
        if (idle()) return false;

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
        let published = false;
        try {
            await queue(() => {
                if (idle()) return;
                // One transaction: the publication, its decision and the wish to delete the
                // original it replaced. None of the three may exist without the others.
                published = db.transaction(() => {
                    if (!store.publishIfCurrent(item.key, item.generationId, entry)) return false;
                    writeDecisions([decision(item, 'converted', { result: entry.generationId, detail })]);
                    wantOriginal.run(`assets/${item.generationId.slice(0, 2)}/${item.generationId}.blob`, item.generationId, now());
                    return true;
                }).immediate();
            });
        } finally {
            // Not published (the key moved on, the server is stopping or an import has come
            // in, or the transaction failed): the file written above belongs to no row. The
            // key's generation is examined again by a later search.
            if (!published) { try { await queue(() => store.discardDetached(entry.generationId)); } catch {} }
        }
        return true;
    }

    // One step of the search from the cursor on: at most one slice of the catalog is looked at,
    // and at most 50 images of it are examined. Returns false when the catalog has nothing left.
    async function sweepAssets(config) {
        const from = { afterTime: cursor.time, afterId: cursor.id };
        const cutoff = now() - config.ageDays * DAY_MS;
        const end = sliceEnd.get({ ...from, cutoff });
        const terms = { ...from, checks: CHECKS, now: now(), live: config.enabled === true ? 1 : 0,
            markersBasis: markersBasis(config), encodeBasis: encodeBasis(config) };
        const batch = end
            ? candidatesInSlice.all({ ...terms, endTime: end.time, endId: end.id })
            : candidatesToCutoff.all({ ...terms, cutoff });
        if (!batch.length) {
            // Nothing to examine in this slice: on to the next one, or done.
            if (end) cursor = end;
            return !!end;
        }
        const cheap = [];
        try {
            for (const item of batch) {
                if (idle()) break;
                let encoded = false;
                try { encoded = await examineAsset(item, config, cheap); }
                catch (error) {
                    if (error instanceof EncoderUnavailable) throw error;
                    // Left without a decision, so the next search takes it up again.
                    warn(`${item.key}: ${error?.message || error}`);
                }
                // Interrupted (stopping, or an import came in): the cursor stays, so this image is
                // looked at again when the search goes on.
                if (idle()) break;
                cursor = { time: item.updated_at, id: item.generationId };
                if (config.enabled === true && now() - lastHousekeeping >= HOUSEKEEPING_MS) {
                    // Decisions first: the housekeeping reads them.
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

    const inlayDecision = (id, outcome, extra = {}) => (
        { id: `inlay/${id}`, kind: 'inlay', key: id, outcome, result: null, detail: null, basis: null, ...extra });
    const quarantinePath = (hash) => `media-originals/inlays/${hash}.png`;
    const removeQuietly = (file) => fsp.unlink(file).catch(() => {});

    // Reads a PNG inlay through one handle. Returns null when it is not the file `seen`
    // describes any more or changed while it was read: a later search sees what is there then.
    async function readInlayPng(file, seen) {
        let handle;
        try { handle = await fsp.open(file, 'r'); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        try {
            const before = await handle.stat({ bigint: true });
            if (!sameFile(seen, before)) return null;
            const bytes = await handle.readFile();
            const after = await handle.stat({ bigint: true });
            return sameFile(before, after) && BigInt(bytes.length) === after.size ? bytes : null;
        } finally { await handle.close(); }
    }

    // Puts the original's bytes into quarantine under the hash of its content. A file already
    // there is kept only if it really has that content. Returns false when that could not be
    // done for now (an import or a shutdown came in between).
    async function quarantine(bytes, hash) {
        const target = path.join(quarantineDir, `${hash}.png`);
        const current = await fsp.readFile(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if (current && sha256(current) === hash) return true;
        // The file is written anew. A pin that saw whatever was there before (or nothing) says
        // nothing about these bytes, so a row for this path loses its pin first. In that order:
        // were the file replaced first, a crash in between would leave it covered by the old pin.
        if (knownOriginal.get(quarantinePath(hash))) {
            let cleared = false;
            await queue(() => { if (idle()) return; forgetPin.run(quarantinePath(hash)); cleared = true; });
            if (!cleared) return false;
        }
        await fsp.mkdir(quarantineDir, { recursive: true });
        await fsp.mkdir(stagingDir, { recursive: true });
        const temp = path.join(stagingDir, `${hash}.${crypto.randomBytes(6).toString('hex')}.tmp`);
        try {
            await writeSynced(temp, bytes);
            await fsp.rename(temp, target);
        } finally { await removeQuietly(temp); }
        await syncDirectory(quarantineDir);
        return true;
    }

    // The checks every change to a live inlay starts with, inside the storage queue and with no
    // await before the change: nothing else is running, the PNG is still the file that was read
    // and the sidecar still the text that was read. Returns the PNG's plain stat, or null.
    function stillAsRead(id, seen, sidecarText) {
        if (idle() || holds > 0 || inlays.inUse(id)) return null;
        const file = path.join(inlays.dir, `${id}.png`);
        try {
            const current = fs.lstatSync(file, { bigint: true });
            if (!current.isFile() || !sameFile(seen, current)) return null;
            if (fs.readFileSync(path.join(inlays.dir, `${id}.meta.json`), 'utf-8') !== sidecarText) return null;
            return fs.statSync(file);
        } catch { return null; }
    }

    function forgetThumbnail(id, stat) {
        try { inlays.forgetThumbnail?.(id, stat); } catch { /* a thumbnail left behind is only a small file */ }
    }

    // Inside the storage queue: puts a staged file under its name in the inlay directory.
    // Normally that is one rename. If the inlay directory lies on another file system, the
    // file is first copied into that directory's own subfolder and renamed from there, so what
    // appears under the name is a complete file either way.
    function moveIn(staged, target) {
        try { fs.renameSync(staged, target); return; }
        catch (error) { if (error.code !== 'EXDEV') throw error; }
        fs.mkdirSync(inlayStagingDir, { recursive: true });
        const near = path.join(inlayStagingDir, path.basename(staged));
        fs.copyFileSync(staged, near);
        const descriptor = fs.openSync(near, 'r+');
        try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
        fs.renameSync(near, target);
    }

    // The PNG is not the payload its sidecar names, and that payload exists: a switch was cut
    // short after the sidecar went in. Readers already get the other file, so the PNG only
    // has to leave, through quarantine like any original.
    async function finishSwitch(id, seen, sidecarText, payload) {
        try {
            const other = await fsp.stat(payload, { bigint: true });
            // The same file under another spelling of its name is not another payload.
            if (!other.isFile() || (other.dev === seen.dev && other.ino === seen.ino)) return;
        } catch { return; }
        if (inlays.inUse(id)) return;
        const bytes = await readInlayPng(path.join(inlays.dir, `${id}.png`), seen);
        if (!bytes || idle()) return;
        const hash = sha256(bytes);
        if (!await quarantine(bytes, hash)) return;
        let done = false;
        await queue(() => {
            const stat = stillAsRead(id, seen, sidecarText);
            if (!stat) return;
            try {
                const other = fs.statSync(payload, { bigint: true });
                if (!other.isFile() || (other.dev === seen.dev && other.ino === seen.ino)) return;
            } catch { return; }
            wantQuarantined.run({ path: quarantinePath(hash), sha: hash, at: now() });
            fs.unlinkSync(path.join(inlays.dir, `${id}.png`));
            forgetThumbnail(id, stat);
            done = true;
        });
        if (done) info(`inlay ${id}: removed the PNG an interrupted conversion left behind`);
    }

    // One inlay. What a crash can leave of the switch at the end, and what this does about it:
    //   <id>.png, sidecar "png"                  nothing happened (or only the database step): converted again
    //   <id>.png + <id>.webp, sidecar "png"      converted again; the rename replaces the stray WebP
    //   <id>.png + <id>.webp, sidecar "webp"     finishSwitch
    //   <id>.webp, sidecar "webp"                done; no PNG, so it is not a candidate
    // Returns true when an encode ran to its end.
    async function examineInlay(id, config, live, cheap) {
        const file = path.join(inlays.dir, `${id}.png`);
        let seen;
        try { seen = await fsp.lstat(file, { bigint: true }); } catch { return false; }
        if (!seen.isFile()) return false;
        if (seen.mtimeNs > BigInt(Math.floor(now() - config.ageDays * DAY_MS)) * 1_000_000n) return false;
        let sidecarText, sidecar;
        try {
            sidecarText = await fsp.readFile(path.join(inlays.dir, `${id}.meta.json`), 'utf-8');
            sidecar = JSON.parse(sidecarText);
        } catch { return false; }
        if (!sidecar || typeof sidecar !== 'object' || Array.isArray(sidecar)) return false;
        if ((typeof sidecar.type === 'string' ? sidecar.type : 'image') !== 'image') return false;
        const ext = sidecarExt(sidecar.ext);
        if (ext !== 'png') {
            // "meta.json" would make the sidecar itself pass for the other payload.
            if (live && ext !== 'meta.json') await finishSwitch(id, seen, sidecarText, path.join(inlays.dir, `${id}.${ext}`));
            return false;
        }

        // A decision holds for this very file under these settings, and no longer.
        const basis = `${seen.mtimeNs}-${seen.size} ${config.quality}/${config.maxDiff}/${config.maxBlockDiff}`;
        const prior = inlayLog.get(`inlay/${id}`);
        if (prior && prior.checks >= CHECKS && prior.basis === basis) {
            if (prior.outcome === 'error' ? prior.next_at > now()
                // A "converted" row never holds a PNG back: if the PNG is still the payload, the switch did not happen.
                : SETTLED.has(prior.outcome) || (prior.outcome === 'would-convert' && !live)) return false;
        }
        if (inlays.inUse(id)) return false;

        let bytes;
        try { bytes = await readInlayPng(file, seen); }
        catch (error) {
            cheap.push(inlayDecision(id, 'error', { detail: `read: ${error.message}`, basis }));
            return false;
        }
        if (!bytes) return false;
        const facts = isPng(bytes) ? pngFacts(bytes) : { reason: 'not a png' };
        if (facts.reason) { cheap.push(inlayDecision(id, 'not-plain-png', { detail: facts.reason, basis })); return false; }
        if (idle()) return false;

        let encoded;
        try { encoded = await encode(bytes, config); }
        catch (error) {
            if (error instanceof EncoderUnavailable) throw error;
            if (stopping) return false;
            cheap.push(inlayDecision(id, 'error', { detail: `encode: ${error.message}`, basis }));
            return true;
        }
        if (encoded.notSmaller) { cheap.push(inlayDecision(id, 'not-smaller', { basis })); return true; }
        if (encoded.skip) { cheap.push(inlayDecision(id, 'failed-check', { detail: encoded.skip, basis })); return true; }
        const hash = sha256(bytes);
        const detail = JSON.stringify({ from: bytes.length, to: encoded.webp.length,
            diff: Number(Number(encoded.diff).toFixed(3)), blockDiff: Number(Number(encoded.blockDiff).toFixed(1)), original: hash });
        if (!live) { cheap.push(inlayDecision(id, 'would-convert', { detail, basis })); return true; }
        if (idle()) return false;

        // Everything slow happens here, outside the queue and outside the inlay directory.
        const token = crypto.randomBytes(8).toString('hex');
        const stagedWebp = path.join(stagingDir, `${token}.webp`);
        const stagedSidecar = path.join(stagingDir, `${token}.json`);
        try {
            try {
                if (!await quarantine(bytes, hash)) return false;
                await fsp.mkdir(stagingDir, { recursive: true });
                await writeSynced(stagedWebp, encoded.webp);
                // Every field the sidecar has is kept; only the extension changes.
                await writeSynced(stagedSidecar, JSON.stringify({ ...sidecar, ext: 'webp' }));
            } catch (error) {
                // Interrupted by a shutdown or an import: nothing is held against the image.
                if (idle()) return false;
                cheap.push(inlayDecision(id, 'error', { detail: `stage: ${error.message}`, basis }));
                return true;
            }
            if (idle()) return false;
            await queue(() => {
                const stat = stillAsRead(id, seen, sidecarText);
                if (!stat || !fs.existsSync(stagedWebp) || !fs.existsSync(stagedSidecar)) return;
                // The record and the wish to delete the original come first: if the process dies
                // after them the PNG is still the payload and is simply converted again, while a
                // switch without them would leave an original nobody asks to have pinned.
                db.transaction(() => {
                    writeDecisions([inlayDecision(id, 'converted', { detail, basis })]);
                    wantQuarantined.run({ path: quarantinePath(hash), sha: hash, at: now() });
                }).immediate();
                moveIn(stagedWebp, path.join(inlays.dir, `${id}.webp`));
                moveIn(stagedSidecar, path.join(inlays.dir, `${id}.meta.json`));
                fs.unlinkSync(file);
                forgetThumbnail(id, stat);
            });
        } catch (error) {
            // The switch stopped part-way. Whatever it left is one of the states above.
            warn(`inlay ${id}: ${error?.message || error}`);
        } finally {
            await removeQuietly(stagedWebp);
            await removeQuietly(stagedSidecar);
        }
        return true;
    }

    // The ids of the PNG files in the inlay directory. The directory is read to its end and
    // closed before anything is examined, so no handle on it is held across an encode.
    async function listPngInlays() {
        const ids = [];
        let dir;
        try { dir = await fsp.opendir(inlays.dir, { bufferSize: 256 }); }
        catch (error) { if (error.code !== 'ENOENT') warn(`cannot read ${inlays.dir}: ${error.message}`); return ids; }
        try {
            for await (const entry of dir) {
                // An import is about to replace this directory: let go of it at once. What was
                // not seen is seen by the next walk.
                if (idle()) break;
                if (!entry.isFile() || !entry.name.endsWith('.png')) continue;
                const id = entry.name.slice(0, -4);
                // Plugin inlays are verified byte for byte by the plugin layer and stay as they are.
                if (id && id !== '.' && id !== '..' && !id.startsWith('plugin-inlay-')) ids.push(id);
            }
        } catch (error) { warn(`cannot read ${inlays.dir}: ${error.message}`); }
        return ids;
    }

    // Temporary files a crash left behind. A day is far longer than any step here takes.
    async function sweepStaging() {
        for (const dir of [stagingDir, inlayStagingDir]) {
            let names;
            try { names = await fsp.readdir(dir); } catch { continue; }
            for (const name of names) {
                const file = path.join(dir, name);
                try { if (now() - (await fsp.stat(file)).mtimeMs > DAY_MS) await fsp.unlink(file); } catch { /* gone, or busy */ }
            }
        }
    }

    // One step of the inlay search: goes on from where the last step stopped and returns after
    // at most 50 encodes. Returns true while ids of the current walk are left.
    async function sweepInlays(config, live) {
        if (!inlayIds) {
            if (live) await sweepStaging();
            inlayIds = await listPngInlays();
            inlayIndex = 0;
        }
        const cheap = [];
        try {
            for (let encodes = 0; inlayIndex < inlayIds.length && encodes < 50;) {
                if (idle()) break;
                const id = inlayIds[inlayIndex];
                let encoded = false;
                try { encoded = await examineInlay(id, config, live, cheap); }
                catch (error) {
                    if (error instanceof EncoderUnavailable) throw error;
                    warn(`inlay ${id}: ${error?.message || error}`);
                }
                // Interrupted: the index stays, so this inlay is looked at again.
                if (idle()) break;
                inlayIndex++;
                if (encoded) encodes++;
                if (live && now() - lastHousekeeping >= HOUSEKEEPING_MS) {
                    if (cheap.length) await queue(() => writeDecisions(cheap.splice(0)));
                    await housekeeping(config);
                }
                if (encoded && config.paceMs > 0) await rest(config.paceMs);
                else await nextTurn();
            }
        } finally {
            if (cheap.length) await queue(() => writeDecisions(cheap));
        }
        if (inlayIndex < inlayIds.length) return true;
        inlayIds = null;
        return false;
    }

    // Whatever lies in quarantine is wanted, whoever put it there and whatever happened to the
    // process since, as long as it is what its name says. So nothing stays there unpinned.
    async function adoptQuarantine() {
        let names;
        try { names = await fsp.readdir(quarantineDir); }
        catch (error) { if (error.code !== 'ENOENT') warn(`cannot list ${quarantineDir}: ${error.message}`); return; }
        for (const name of names) {
            if (idle()) return;
            const entry = quarantinePath(name.slice(0, -4));
            const match = name.endsWith('.png') && INLAY_ORIGINAL_PATH.exec(entry);
            if (!match || hasOpenOriginal.get(entry)) continue;
            let bytes;
            try {
                // A regular file only: the backup side does not pin anything else.
                if (!(await fsp.lstat(path.join(quarantineDir, name))).isFile()) continue;
                bytes = await fsp.readFile(path.join(quarantineDir, name));
            } catch { continue; }
            if (sha256(bytes) !== match[1]) {
                // Not an original this module wrote. It is neither pinned under a name it does not deserve nor deleted.
                if (!oddQuarantine.has(name)) { oddQuarantine.add(name); warn(`${entry} does not have the content its name says; left alone`); }
                continue;
            }
            await queue(() => { if (!idle()) adoptQuarantined.run({ path: entry, sha: match[1], at: now() }); });
            await nextTurn();
        }
    }

    async function ingestCovered() {
        let names;
        try { names = (await fsp.readdir(originalsDir)).filter(name => name.endsWith('.covered')).sort(); }
        catch (error) { if (error.code !== 'ENOENT') warn(`cannot list ${originalsDir}: ${error.message}`); return; }
        for (const name of names) {
            if (idle()) return;
            const file = path.join(originalsDir, name);
            let lines;
            try { lines = (await fsp.readFile(file, 'utf-8')).split('\n').map(line => line.replace(/\r$/, '')); }
            catch (error) { if (error.code !== 'ENOENT') warn(`cannot read ${file}: ${error.message}`); continue; }
            // Only the two exact shapes this module writes into want.list count.
            const paths = [];
            for (const line of lines) {
                if (GENERATION_PATH.test(line)) paths.push({ path: line, generationId: line.slice(10, 74) });
                else { const original = INLAY_ORIGINAL_PATH.exec(line); if (original) paths.push({ path: line, generationId: original[1] }); }
            }
            if (idle()) return;
            await queue(() => {
                const at = now();
                db.transaction(() => {
                    for (const entry of paths) coverOriginal.run({ ...entry, at, manifest: name });
                })();
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

    // Sorts the originals not deleted yet into: still to be pinned, ready to be deleted, and
    // unknown (neither a catalog row nor a file). Out of scope or not retired: left alone.
    async function survey(config) {
        const all = config.collect === 'all';
        const before = now() - config.retentionDays * DAY_MS;
        const want = [], due = [], gone = [];
        // Whether the file is there. Anything but "no such file" counts as there: an original is
        // never written off because it could not be looked at.
        const isPresent = async (row, file = generationPath(store.root, row.generationId)) => {
            try { return (await fsp.stat(file)).isFile(); }
            catch (error) {
                if (error.code === 'ENOENT') return false;
                warn(`cannot stat ${row.path}: ${error.message}`);
                return true;
            }
        };
        for (let after = ''; !idle();) {
            const rows = openOriginals.all({ after });
            for (const row of rows) {
                if (idle()) break;
                if (INLAY_ORIGINAL_PATH.test(row.path)) {
                    // A quarantined inlay original: its retention counts from when it was last wanted.
                    // Pinned and past its retention comes first, also when the file is already
                    // gone (a deletion whose record was lost), so that the row keeps its pin.
                    if (row.covered_at !== null && row.wanted_at <= before) due.push(row);
                    else if (!await isPresent(row, path.join(saveDir, row.path))) gone.push(row);
                    else if (row.covered_at === null) want.push(row);
                    continue;
                }
                if (row.retired === null) { if (!await isPresent(row)) gone.push(row); continue; }
                if (row.retired !== 1 || !(row.transcoded === 1 || (all && row.was_live === 1))) continue;
                if (row.covered_at === null) { if (await isPresent(row)) want.push(row); }
                else if (typeof row.retired_at === 'number' && row.retired_at <= before) due.push(row);
            }
            if (rows.length < 1000) break;
            after = rows[rows.length - 1].path;
            await nextTurn();
        }
        return { want, due, gone, before, complete: !idle() };
    }

    async function collect({ due, gone, before }) {
        let deleted = 0;
        for (let start = 0; start < due.length; start += 200) {
            if (idle() || holds > 0) break;
            const chunk = due.slice(start, start + 200);
            await queue(() => {
                for (const row of chunk) {
                    if (idle() || holds > 0) return;
                    try {
                        // The deletion and its record commit together. If the record cannot be
                        // written the row comes back (its file may already be gone, which the next
                        // attempt tolerates), so a deletion is never left unannounced.
                        const done = db.transaction(() => {
                            if (INLAY_ORIGINAL_PATH.test(row.path)) {
                                // Looked up again here: the row may have been wanted anew since the survey.
                                if (!quarantinedDue.get(row.path, before)) return false;
                                try { fs.unlinkSync(path.join(saveDir, row.path)); }
                                catch (error) { if (error.code !== 'ENOENT') throw error; }
                                markDeletedUnlisted.run({ at: now(), path: row.path });
                                return true;
                            }
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
        // Nothing here deleted these, so nothing is announced: a mirror must not follow a file
        // that merely is not there (after a restore its copy may be the only one at hand).
        if (gone.length && !idle()) await queue(() => db.transaction(() => { for (const row of gone) forgetOriginal.run(row.path); })());
        if (deleted) info(`deleted ${deleted} pinned originals`);
    }

    // "all": wants every retired generation that was live once. A thousand at a time, and at
    // most twenty thousand per round, continuing where the last round ended, so a large
    // backlog (an import, pins that do not arrive) is neither scanned in one go nor over and over.
    async function adoptRetired() {
        for (let pages = 0; pages < 20 && !idle(); pages++) {
            const rows = retiredPage.all({ after: adoptCursor });
            if (rows.length) {
                await queue(() => {
                    const at = now();
                    db.transaction(() => {
                        for (const row of rows) wantOriginal.run(`assets/${row.generationId.slice(0, 2)}/${row.generationId}.blob`, row.generationId, at);
                    })();
                });
            }
            if (rows.length < 1000) { adoptCursor = ''; return; }
            adoptCursor = rows[rows.length - 1].generationId;
            await nextTurn();
        }
    }

    // Tells the mirror which files are gone. Only completed deletions are listed, and a row is
    // marked listed after its list file is in place, so a crash in between lists it again.
    async function listCollected() {
        while (!idle()) {
            const rows = unlisted.all();
            if (!rows.length) return;
            const file = path.join(collectedDir, `${new Date(now()).toISOString().replace(/[-:.]/g, '')}-${crypto.randomBytes(4).toString('hex')}.list`);
            try { await writeAtomic(file, rows.map(row => `${row.path}\n`).join('')); }
            catch (error) { warn(`cannot write ${file}: ${error.message}`); return; }
            await queue(() => db.transaction(() => { for (const row of rows) markListed.run(now(), row.path); })());
        }
    }

    // What this module wants pinned. Compared with the file itself, so a list someone else
    // replaced is put right.
    async function writeWantList({ want }) {
        const text = want.map(row => row.path).sort().map(entry => `${entry}\n`).join('');
        try {
            const current = await fsp.readFile(wantPath, 'utf-8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
            if (current !== text && !idle()) await writeAtomic(wantPath, text);
        } catch (error) { warn(`cannot write ${wantPath}: ${error.message}`); }
    }

    async function housekeeping(config) {
        lastHousekeeping = now();
        if (idle()) return;
        await ingestCovered();
        if (idle()) return;
        if (config.collect === 'all') await adoptRetired();
        if (inlays && !idle()) await adoptQuarantine();
        const found = await survey(config);
        // A survey cut short knows only part of what is wanted; a list written from it would be short.
        if (idle() || !found.complete) return;
        await collect(found);
        await listCollected();
        // Deleting changes nothing about what is still wanted, so the survey above still holds.
        if (!idle()) await writeWantList(found);
    }

    // Returns how long to rest before the next pass.
    async function pass() {
        const config = readConfig();
        if (!config.enabled || idle()) return 60_000;
        const live = config.enabled === true;
        // Also before the first search, so pins and deletions move even while the encoder cannot start.
        if (live && now() - lastHousekeeping >= HOUSEKEEPING_MS) await housekeeping(config);
        // Inlays follow once the asset search has nothing left: live only when both switches say
        // so, examined without changes when either says "report".
        const inlaysOn = inlays && config.inlays !== false;
        if (!inlaysOn) inlayIds = null;
        let more;
        try {
            more = await sweepAssets(config);
            if (!more && inlaysOn && !idle()) more = await sweepInlays(config, live && config.inlays === true);
        }
        catch (error) {
            if (!(error instanceof EncoderUnavailable)) throw error;
            // Nothing is recorded against the image; the encoder is simply tried again later.
            if (!encoderWarned) { encoderWarned = true; warn(`the encoder cannot start, trying again every 10 minutes: ${error.message}`); }
            return 600_000;
        }
        encoderWarned = false;
        if (more) return 0;
        if (idle()) return 60_000;
        cursor = { time: -1, id: '' };
        if (live) await housekeeping(config);
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

    // From its first line on nothing new is started: no encode, no publication, no deletion,
    // no list. What is already inside the storage queue finishes (a few statements).
    async function stop() {
        running = false;
        stopping = true;
        cancelTick?.();
        wake?.();
        // Ends an encode in progress: nothing is recorded against its image, which is taken
        // up again after the next start.
        const request = pending;
        const current = worker;
        pending = null;
        worker = null;
        if (request) { request.cancelWatchdog(); request.reject(new Error('the server is stopping')); }
        if (current) await current.terminate();
        if (passPromise) await passPromise.catch(() => {});
    }

    // While held, nothing is deleted and no inlay is switched. A reader that listed files takes
    // a hold until it has them; so does a writer that rewrites inlays outside the storage queue.
    function hold() {
        holds++;
        let released = false;
        return () => { if (!released) { released = true; holds--; } };
    }

    return { start, stop, hold, pass, housekeeping, readConfig,
        paths: { originalsDir, collectedDir, wantPath, configPath, quarantineDir, stagingDir, inlayStagingDir } };
}

module.exports = { createMediaTranscode, normalizeConfig, DEFAULTS, after };
