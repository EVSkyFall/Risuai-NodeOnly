// Plugin "save" storage, served per key from the server kv.
//
// Historically every plugin value lived in `db.pluginCustomStorage`, so the
// whole set (hundreds of MB for long-term-memory plugins) sat in the reactive
// DB, in the patcher baseline and in every save's JSON copy — the main cause
// of mobile browser OOM. This module is the only client-side holder of those
// values now: an index of key → byte size fetched once at boot, and a
// byte-capped LRU of values read on demand via forageStorage.
//
// INVARIANT: values from this store must never be placed into getDatabase().
// `db.pluginCustomStorage` stays `{}` forever; the .bin encoder just serializes
// that empty object. Anything that copies a value back into the DB reintroduces
// the memory blow-up and the save-path cost this module exists to remove.
//
// Two access modes:
//   - async (V3 plugins, viewer): getItem/setItem/removeItem hit the server on
//     a cache miss. Writes are write-through: server first, then cache/index.
//   - sync (V2 plugins, whose API is synchronous): requires preloadAll() to
//     have filled the cache with every key (the LRU cap is lifted for that).
//     Writes update the cache at once and reach the server fire-and-forget
//     with a small retry; the user is alerted if the write is finally lost.
//   Both modes share one per-key write queue, so mixed sync/async writes to a
//   key land on the server in call order.

import { forageStorage } from "../globalApi.svelte";
import { alertError } from "../alert";
import { encodeStorageKeyComponent } from "../storage/persistentKv";

const KV_PREFIX = "plugin-custom-storage/";
const DEFAULT_CACHE_CAP = 64 * 1024 * 1024;
const SYNC_WRITE_ATTEMPTS = 3;
const SYNC_WRITE_BACKOFF_MS = 500;
const INDEX_STALE_MS = 30_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface CacheEntry {
    value: any;
    bytes: number;
    // Content hash of the serialized value, so a rewrite of an unchanged value
    // (V2 setDatabase() round trips re-send every key) is not uploaded again.
    hash: string;
}

// Two independent FNV-1a passes over the serialized value.
function contentHash(text: string): string {
    let a = 0x811c9dc5, b = 0x01000193;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        a = Math.imul(a ^ c, 0x01000193);
        b = Math.imul(b ^ c, 0x2f0b4a3d) + 0x9e3779b9;
    }
    return `${text.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
}

// Content hash of the value the server holds for each key we have seen this
// session. Kept apart from the value LRU so unchanged-write detection still
// works for values that were evicted or never fit the cap (a full-store
// snapshot handed to a V3 plugin and written straight back).
let knownHashes = new Map<string, string>();

// Only an acknowledged value with no pending intent may skip an async write.
function serverHasValue(key: string, hash: string): boolean {
    const pending = pendingOp(key);
    if (pending) return false;
    return !tombstones.has(key) && knownHashes.get(key) === hash;
}

let index = new Map<string, number>();
let revisions = new Map<string, number | null>();
let indexGeneration = 0;
let writeSequence = 0;
let acknowledgementSequence = 0;
let latestWrites = new Map<string, number>();
let acknowledgedWrites = new Map<string, { acknowledgement: number; size: number | null }>();
let workerPromises = new Map<string, Promise<void>>();
let initPromise: Promise<void> | null = null;
// Map insertion order doubles as LRU order: hits are re-inserted at the end,
// evictions pop from the front.
let cache = new Map<string, CacheEntry>();
let cacheBytes = 0;
let cacheCap = DEFAULT_CACHE_CAP;
// V2 must retain successfully loaded keys even when another key fails to load.
let syncCacheEnabled = false;
let preloaded = false;
let preloadPromise: Promise<void> | null = null;
// Keys this store removed in this session. A read of a tombstoned key skips
// the server round-trip; any other index miss is still read from the server
// so keys written by another device become visible without a reload.
let tombstones = new Set<string>();
// When the index was last fetched; keys()/length() refresh it in the
// background once it is older than INDEX_STALE_MS.
let indexFetchedAt = 0;
let refreshing: Promise<void> | null = null;
// Keys whose stored value did not parse. They stay in the server index, so
// without this the preload top-up would re-fetch them on every refresh.
let unparseable = new Set<string>();
let unresolved = new Set<string>();

// Per-key write ordering: ONE mechanism for the async and the sync API.
// Every write becomes an intent appended to the key's FIFO; a single worker
// per key drains it. When the worker picks the next intent it collapses every
// queued intent for that key into the newest one (the others are superseded
// and never sent) and settles all their promises together with the survivor.
// Retries re-check the queue before each attempt so a superseded value is
// never sent after a newer one arrived.
type PendingOp = { op: "set"; bytes: Uint8Array; hash: string } | { op: "remove" };
interface Intent {
    token: number;
    op: PendingOp;
    sync: boolean;
    // `superseded` tells an async caller a newer write won the collapse, so it
    // must not push its own (older) value into the cache/index.
    resolve: (result: { superseded: boolean; token: number }) => void;
    reject: (e: unknown) => void;
}
let queues = new Map<string, Intent[]>();
let inflight = new Map<string, PendingOp>();
let workers = new Set<string>();

// The op that will be on the server once the key's pending writes drain.
function pendingOp(key: string): PendingOp | undefined {
    const q = queues.get(key);
    return q?.length ? q[q.length - 1].op : inflight.get(key);
}

export function kvKeyFor(key: string): string {
    return KV_PREFIX + encodeStorageKeyComponent(key) + ".json";
}

export function setCacheCap(bytes: number) {
    cacheCap = bytes;
    evict();
}

function evict() {
    if (syncCacheEnabled) return;
    for (const [key, entry] of cache) {
        if (cacheBytes <= cacheCap) break;
        cache.delete(key);
        cacheBytes -= entry.bytes;
    }
}

// `bytes` is the UTF-8 encoded size, matching the index/server sizes.
function cacheSet(key: string, value: any, bytes: number, hash: string) {
    const existing = cache.get(key);
    if (existing) {
        cache.delete(key);
        cacheBytes -= existing.bytes;
    }
    // A single value over the cap would only be evicted again — skip caching it.
    if (!syncCacheEnabled && bytes > cacheCap) return;
    cache.set(key, { value, bytes, hash });
    cacheBytes += bytes;
    evict();
}

function cacheDelete(key: string) {
    const existing = cache.get(key);
    if (!existing) return;
    cache.delete(key);
    cacheBytes -= existing.bytes;
}

function cacheGet(key: string): CacheEntry | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    // Refresh LRU position.
    cache.delete(key);
    cache.set(key, entry);
    return entry;
}

async function fetchIndex() {
    await forageStorage.Init();
    const readSequence = acknowledgementSequence;
    const res = await forageStorage.getPluginStorageIndex();
    const hasRevisions = (res.entries ?? []).some((entry) => entry.updatedAt != null);
    const next = new Map<string, number>();
    const nextRevisions = new Map<string, number | null>();
    for (const entry of res.entries ?? []) {
        if (typeof entry?.key === "string") {
            next.set(entry.key, entry.size ?? 0);
            nextRevisions.set(entry.key, entry.updatedAt ?? null);
            const changed = revisions.get(entry.key) !== (entry.updatedAt ?? null);
            // Legacy servers cannot distinguish an unchanged value from a remote edit.
            if ((!hasRevisions || changed) && !pendingOp(entry.key)
                && (acknowledgedWrites.get(entry.key)?.acknowledgement ?? 0) <= readSequence) {
                cacheDelete(entry.key);
                knownHashes.delete(entry.key);
                unparseable.delete(entry.key);
                if (syncCacheEnabled) unresolved.add(entry.key);
            }
        }
    }
    // An index request may predate a write whose ACK already arrived.
    for (const [key, write] of acknowledgedWrites) {
        if (write.acknowledgement <= readSequence) continue;
        if (write.size === null) next.delete(key);
        else next.set(key, write.size);
    }
    // Writes still in flight are not on the server yet — keep them visible.
    for (const k of new Set([...queues.keys(), ...inflight.keys()])) {
        const op = pendingOp(k);
        if (!op) continue;
        if (op.op === "set") next.set(k, op.bytes.length);
        else next.delete(k);
    }
    index = next;
    revisions = nextRevisions;
    indexGeneration++;
    indexFetchedAt = Date.now();
}

// Fetch the index once. Safe to call repeatedly; a failed fetch is retried on
// the next call so a transient boot error doesn't disable plugin storage.
export function init(): Promise<void> {
    if (!initPromise) {
        initPromise = fetchIndex().catch((e) => {
            initPromise = null;
            throw e;
        });
    }
    return initPromise;
}

// Re-fetch the index (viewer refresh, or another device changed keys). Cached
// values for keys that vanished are dropped; a preloaded (V2) cache is topped
// up so sync reads keep seeing every key.
//
// Key enumeration is eventually consistent across devices: keys() reads the
// local index, which is refreshed here on demand (viewer open) and in the
// background by keys()/length() when older than INDEX_STALE_MS.
export async function refreshIndex(): Promise<void> {
    if (refreshing) await refreshing;
    revisions.clear();
    return refreshIndexInternal();
}

async function refreshIndexInternal(): Promise<void> {
    if (refreshing) return refreshing;
    refreshing = (async () => {
        initPromise = null;
        await init();
        tombstones = new Set();
        for (const key of [...cache.keys()]) {
            if (!index.has(key) && !pendingOp(key)) cacheDelete(key);
        }
        for (const key of [...knownHashes.keys()]) {
            if (!index.has(key) && !pendingOp(key)) knownHashes.delete(key);
        }
        // A corrupt row removed (and possibly recreated) elsewhere gets read again.
        for (const key of [...unparseable]) {
            if (!index.has(key)) unparseable.delete(key);
        }
        for (const key of [...unresolved]) {
            if (!index.has(key)) unresolved.delete(key);
        }
        if (syncCacheEnabled) {
            // Top up only the keys the fresh index has that the cache does
            // not (written by another device). Never re-run the bulk preload
            // stream here: this refresh fires every INDEX_STALE_MS while a V2
            // plugin enumerates keys, and re-streaming the whole store each
            // time saturated remote links for minutes (v1.11.1 regression).
            await topUpMissing();
        }
    })().finally(() => {
        refreshing = null;
    });
    return refreshing;
}

function maybeRefreshInBackground() {
    if (!initPromise || refreshing) return;
    if (Date.now() - indexFetchedAt < INDEX_STALE_MS) return;
    void refreshIndexInternal().catch((e) => console.warn("[pluginStorage] background index refresh failed", e));
}

export async function getItem(key: string): Promise<any | null> {
    await init();
    const hit = cacheGet(key);
    // A write still on its way to the server is what the caller expects to
    // read back (upstream's setItem was synchronous). Async setItem only
    // updates the cache after the server confirms, so a cached copy may be
    // older than the pending write; the sync path caches at once, and then
    // the hashes match and the cached object is served as-is.
    const pending = pendingOp(key);
    if (pending) {
        if (pending.op === "remove") return null;
        if (hit && hit.hash === pending.hash) return hit.value;
        try {
            return JSON.parse(decoder.decode(pending.bytes));
        } catch (e) {
            console.warn(`[pluginStorage] unparseable pending value for "${key}"`, e);
            return null;
        }
    }
    if (hit) return hit.value;
    // Removed by this store in this session → the server has nothing. Any
    // other index miss is read anyway: a miss is cheap and the key may have
    // been written by another device since the index was fetched.
    if (tombstones.has(key)) return null;
    const readToken = latestWrites.get(key);
    const readGeneration = indexGeneration;
    const data = await forageStorage.getItem(kvKeyFor(key));
    if (latestWrites.get(key) !== readToken || indexGeneration !== readGeneration) return getItem(key);
    if (!data || data.length === 0) {
        unresolved.delete(key);
        index.delete(key);
        knownHashes.delete(key);
        return null;
    }
    let value: any;
    const text = decoder.decode(data);
    try {
        value = JSON.parse(text);
    } catch (e) {
        console.warn(`[pluginStorage] unparseable value for "${key}" — treating as missing`, e);
        unresolved.delete(key);
        index.delete(key);
        unparseable.add(key);
        return null;
    }
    unparseable.delete(key);
    unresolved.delete(key);
    index.set(key, data.length);
    knownHashes.set(key, contentHash(text));
    cacheSet(key, value, data.length, contentHash(text));
    return value;
}

function performOp(key: string, op: PendingOp): Promise<void> {
    return op.op === "set"
        ? forageStorage.setItem(kvKeyFor(key), op.bytes).then(() => {})
        : forageStorage.removeItem(kvKeyFor(key));
}

// Drains the key's FIFO. Each round collapses everything queued so far into
// the newest intent; each attempt (including retries) first checks whether
// newer intents arrived and, if so, hands the current batch back to be
// collapsed into them.
async function worker(key: string) {
    for (;;) {
        const queue = queues.get(key);
        if (!queue?.length) break;
        const batch = queue.splice(0);
        const intent = batch[batch.length - 1];
        // Async callers see failures at once (they can react); fire-and-forget
        // sync writes are retried, as the plugin has no way to notice.
        const attempts = batch.some((b) => b.sync) ? SYNC_WRITE_ATTEMPTS : 1;
        let attempt = 1;
        for (;;) {
            if (queue.length) {
                queue.unshift(...batch);
                break;
            }
            inflight.set(key, intent.op);
            try {
                await performOp(key, intent.op);
                inflight.delete(key);
                acknowledgedWrites.set(key, { acknowledgement: ++acknowledgementSequence,
                    size: intent.op.op === 'set' ? intent.op.bytes.length : null });
                if (intent.op.op === "set") knownHashes.set(key, intent.op.hash);
                else knownHashes.delete(key);
                unresolved.delete(key);
                for (const b of batch) b.resolve({ superseded: b !== intent, token: b.token });
                break;
            } catch (e) {
                if (attempt >= attempts) {
                    inflight.delete(key);
                    knownHashes.delete(key);
                    if (intent.op.op === "remove" && latestWrites.get(key) === intent.token) tombstones.delete(key);
                    const name = intent.op.op === "set" ? "write" : "remove";
                    console.error(`[pluginStorage] ${name} "${key}" failed after ${attempt} attempts`, e);
                    if (batch.some((b) => b.sync)) {
                        alertError(`Plugin storage ${name} failed for "${key}": ${e instanceof Error ? e.message : String(e)}`);
                    }
                    for (const b of batch) b.reject(e);
                    break;
                }
                await new Promise((r) => setTimeout(r, SYNC_WRITE_BACKOFF_MS * attempt));
                attempt++;
            }
        }
    }
    queues.delete(key);
    workers.delete(key);
}

// Append an intent to the key's FIFO; resolves with `superseded` once the
// server holds this write or a newer one for the key.
function enqueue(key: string, op: PendingOp, sync: boolean): Promise<{ superseded: boolean; token: number }> {
    return new Promise((resolve, reject) => {
        let queue = queues.get(key);
        if (!queue) queues.set(key, (queue = []));
        const token = ++writeSequence;
        latestWrites.set(key, token);
        queue.push({ op, sync, token, resolve, reject });
        if (!workers.has(key)) {
            workers.add(key);
            const running = worker(key).finally(() => {
                if (workerPromises.get(key) === running) workerPromises.delete(key);
            });
            workerPromises.set(key, running);
        }
    });
}

export async function setItem(key: string, value: any): Promise<void> {
    // The old DB-field storage dropped undefined on JSON serialization, i.e.
    // it was effectively a removal.
    if (value === undefined) return removeItem(key);
    await init();
    const json = JSON.stringify(value);
    const bytes = encoder.encode(json);
    const hash = contentHash(json);
    if (serverHasValue(key, hash)) {
        // Unchanged content: refresh the cached object only, no upload.
        cacheSet(key, value, bytes.length, hash);
        return;
    }
    // Server first: the cache must never claim a value the server never got.
    const { superseded, token } = await enqueue(key, { op: "set", bytes, hash }, false);
    if (superseded || latestWrites.get(key) !== token) return;
    unparseable.delete(key);
    index.set(key, bytes.length);
    tombstones.delete(key);
    cacheSet(key, value, bytes.length, hash);
}

export async function removeItem(key: string): Promise<void> {
    await init();
    if (index.has(key) || !tombstones.has(key) || pendingOp(key)) {
        const { superseded, token } = await enqueue(key, { op: "remove" }, false);
        if (superseded || latestWrites.get(key) !== token) return;
    }
    index.delete(key);
    tombstones.add(key);
    cacheDelete(key);
    knownHashes.delete(key);
}

export async function clear(): Promise<void> {
    await init();
    for (const key of [...index.keys()]) {
        await removeItem(key);
    }
}

export function keys(): string[] {
    maybeRefreshInBackground();
    return [...index.keys()];
}

export function key(i: number): string | null {
    return keys()[i] ?? null;
}

export function length(): number {
    maybeRefreshInBackground();
    return index.size;
}

// Sum of every stored value's size (from the index; pending writes included).
export function totalBytes(): number {
    let total = 0;
    for (const bytes of index.values()) total += bytes;
    return total;
}

export function size(key: string): number | undefined {
    return index.get(key);
}

export function has(key: string): boolean {
    return index.has(key) && !unresolved.has(key);
}

export function isPreloaded(): boolean {
    return preloaded;
}

// Load every value into the cache so the synchronous V2 API can be served.
// This is the pre-lazy memory footprint (one copy), only paid when a V2
// plugin is enabled.
// One streamed response for the whole store; falls back to per-key reads if
// the bulk endpoint fails (older server, transport error mid-stream).
async function preloadBulk(): Promise<void> {
    const sequence = writeSequence;
    const readGeneration = indexGeneration;
    const pendingKeys = new Set([...queues.keys(), ...inflight.keys()]);
    await forageStorage.getPluginStorageAll((key, text) => {
        if (indexGeneration !== readGeneration || pendingKeys.has(key) || (latestWrites.get(key) ?? 0) > sequence) return;
        ingestStreamed(key, text);
    });
}

// One entry of the streamed store into index/cache. Returns the parsed value,
// or undefined when it was not taken: local state wins (a cached value, a
// pending write or a removal made in this session is newer than what the
// server streams), and unparseable text counts as missing.
function ingestStreamed(key: string, text: string): any | undefined {
    if (cache.has(key) || pendingOp(key) || tombstones.has(key)) return undefined;
    let value: any;
    try {
        value = JSON.parse(text);
    } catch (e) {
        console.warn(`[pluginStorage] unparseable value for "${key}" — treating as missing`, e);
        unresolved.delete(key);
        index.delete(key);
        unparseable.add(key);
        return undefined;
    }
    unparseable.delete(key);
    unresolved.delete(key);
    const bytes = encoder.encode(text).length;
    index.set(key, bytes);
    knownHashes.set(key, contentHash(text));
    cacheSet(key, value, bytes, contentHash(text));
    return value;
}

// Fetch every indexed key the cache is missing, a few at a time. Used to
// finish the first preload after the bulk stream and to top up after an
// index refresh — both only ever pay for keys that are actually missing.
async function topUpMissing(): Promise<void> {
    const pending = [...index.keys()].filter((k) => !cache.has(k) && !unparseable.has(k));
    if (pending.length) preloaded = false;
    for (const key of pending) unresolved.add(key);
    const CONCURRENCY = 8;
    for (let i = 0; i < pending.length; i += CONCURRENCY) {
        const chunk = pending.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(chunk.map((k) => getItem(k)));
        results.forEach((result, j) => {
            const key = chunk[j];
            if (result.status === 'fulfilled' || cache.has(key) || pendingOp(key)) unresolved.delete(key);
        });
    }
    preloaded = unresolved.size === 0;
    if (!preloaded) {
        preloadPromise = null;
        throw new Error(`Plugin storage could not load ${unresolved.size} key(s)`);
    }
}

export function preloadAll(): Promise<void> {
    if (!preloadPromise) {
        preloadPromise = (async () => {
            syncCacheEnabled = true;
            await init();
            try {
                await preloadBulk();
            } catch (e) {
                console.warn('[pluginStorage] bulk preload failed, reading keys one by one', e);
            }
            await topUpMissing();
        })().catch((e) => {
            preloadPromise = null;
            preloaded = false;
            throw e;
        });
    }
    return preloadPromise;
}

// One-off full copy of the store as a plain object, for writers that must
// embed every plugin value (client-assembled backups). Does not touch
// `preloaded` or the LRU cap — values are read through the normal path and
// may be evicted again afterwards.
export async function snapshotAll(): Promise<Record<string, any>> {
    await refreshIndex();
    const sequence = writeSequence;
    const readGeneration = indexGeneration;
    const pendingKeys = new Set([...queues.keys(), ...inflight.keys()]);
    const out: Record<string, any> = {};
    // defineProperty so a stored "__proto__" key stays an own property (same
    // as the server's readAll).
    const put = (k: string, v: any) => {
        const pending = pendingOp(k);
        if (v === undefined || pending?.op === 'remove' || (v === null && !index.has(k) && pending?.op !== 'set')) return;
        Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
    };
    // One streamed response, like the V2 preload: thousands of keys over a
    // remote link would otherwise mean thousands of round trips per snapshot.
    try {
        await forageStorage.getPluginStorageAll((key, text) => {
            if (indexGeneration !== readGeneration || pendingKeys.has(key) || (latestWrites.get(key) ?? 0) > sequence) return;
            put(key, ingestStreamed(key, text));
        });
    } catch (e) {
        console.warn('[pluginStorage] bulk snapshot failed, reading keys one by one', e);
    }
    // Refreshes and local writes supersede rows already received as well.
    for (const key of Object.keys(out)) {
        if (indexGeneration !== readGeneration || (latestWrites.get(key) ?? 0) > sequence) delete out[key];
    }
    // Whatever the stream did not fill (values already cached, pending
    // writes, or everything after a failed stream) comes through the normal
    // read path.
    const keys = new Set([...index.keys(), ...queues.keys(), ...inflight.keys()]);
    const rest = [...keys].filter((k) => !Object.prototype.hasOwnProperty.call(out, k));
    const CONCURRENCY = 8;
    for (let i = 0; i < rest.length; i += CONCURRENCY) {
        const chunk = rest.slice(i, i + CONCURRENCY);
        const values = await Promise.all(chunk.map((k) => getItem(k)));
        chunk.forEach((k, j) => put(k, values[j]));
    }
    return out;
}

// ── sync API (V2 plugins; valid only after preloadAll) ─────────────────────

export function getItemSync(key: string): any | null {
    if (unresolved.has(key)) return undefined;
    const hit = cacheGet(key);
    if (hit) return hit.value;
    if (!preloaded && index.has(key)) {
        console.warn(`[pluginStorage] sync read of "${key}" before preload — returning null`);
    }
    return null;
}

// Fire-and-forget: the user is alerted by the worker on final failure.
function enqueueSync(key: string, op: PendingOp) {
    enqueue(key, op, true).catch(() => {});
}

export function setItemSync(key: string, value: any): void {
    if (unresolved.has(key)) {
        alertError(`Plugin storage write skipped for "${key}": its stored value could not be loaded. Refresh storage and retry.`);
        return;
    }
    if (value === undefined) return removeItemSync(key);
    const json = JSON.stringify(value);
    const bytes = encoder.encode(json);
    const hash = contentHash(json);
    const pending = pendingOp(key);
    if (serverHasValue(key, hash) || (pending?.op === "set" && pending.hash === hash)) {
        cacheSet(key, value, bytes.length, hash);
        return;
    }
    unparseable.delete(key);
    index.set(key, bytes.length);
    tombstones.delete(key);
    cacheSet(key, value, bytes.length, hash);
    enqueueSync(key, { op: "set", bytes, hash });
}

export function removeItemSync(key: string): void {
    const alreadyRemoved = tombstones.has(key) && !pendingOp(key);
    const existed = index.delete(key);
    cacheDelete(key);
    knownHashes.delete(key);
    tombstones.add(key);
    if (!alreadyRemoved || existed || pendingOp(key)) {
        enqueueSync(key, { op: "remove" });
    }
}

export function clearSync(): void {
    for (const key of [...index.keys()]) removeItemSync(key);
}

export async function flushImmediate(): Promise<void> {
    while (workerPromises.size) await Promise.all([...workerPromises.values()]);
}

// Test-only: drop all in-memory state.
export function _resetForTests() {
    index = new Map();
    revisions = new Map();
    indexGeneration = 0;
    latestWrites = new Map();
    acknowledgedWrites = new Map();
    workerPromises = new Map();
    writeSequence = 0;
    acknowledgementSequence = 0;
    initPromise = null;
    cache = new Map();
    cacheBytes = 0;
    knownHashes = new Map();
    cacheCap = DEFAULT_CACHE_CAP;
    syncCacheEnabled = false;
    preloaded = false;
    preloadPromise = null;
    tombstones = new Set();
    unparseable = new Set();
    unresolved = new Set();
    indexFetchedAt = 0;
    refreshing = null;
    queues = new Map();
    inflight = new Map();
    workers = new Set();
}
