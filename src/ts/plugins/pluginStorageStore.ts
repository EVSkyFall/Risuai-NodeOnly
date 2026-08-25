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

const KV_PREFIX = "plugin-storage/";
const DEFAULT_CACHE_CAP = 64 * 1024 * 1024;
const SYNC_WRITE_ATTEMPTS = 3;
const SYNC_WRITE_BACKOFF_MS = 500;
const INDEX_STALE_MS = 30_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface CacheEntry {
    value: any;
    bytes: number;
}

let index = new Map<string, number>();
let initPromise: Promise<void> | null = null;
// Map insertion order doubles as LRU order: hits are re-inserted at the end,
// evictions pop from the front.
let cache = new Map<string, CacheEntry>();
let cacheBytes = 0;
let cacheCap = DEFAULT_CACHE_CAP;
// Once preloaded, the cache holds every key and must not evict — sync reads
// (V2) treat a miss as "no such key".
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

// Per-key write ordering: ONE mechanism for the async and the sync API.
// Every write becomes an intent appended to the key's FIFO; a single worker
// per key drains it. When the worker picks the next intent it collapses every
// queued intent for that key into the newest one (the others are superseded
// and never sent) and settles all their promises together with the survivor.
// Retries re-check the queue before each attempt so a superseded value is
// never sent after a newer one arrived.
type PendingOp = { op: "set"; bytes: Uint8Array } | { op: "remove" };
interface Intent {
    op: PendingOp;
    sync: boolean;
    // `superseded` tells an async caller a newer write won the collapse, so it
    // must not push its own (older) value into the cache/index.
    resolve: (superseded: boolean) => void;
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
    return KV_PREFIX + encodeStorageKeyComponent(key);
}

export function setCacheCap(bytes: number) {
    cacheCap = bytes;
    evict();
}

function evict() {
    if (preloaded) return;
    for (const [key, entry] of cache) {
        if (cacheBytes <= cacheCap) break;
        cache.delete(key);
        cacheBytes -= entry.bytes;
    }
}

// `bytes` is the UTF-8 encoded size, matching the index/server sizes.
function cacheSet(key: string, value: any, bytes: number) {
    const existing = cache.get(key);
    if (existing) {
        cache.delete(key);
        cacheBytes -= existing.bytes;
    }
    // A single value over the cap would only be evicted again — skip caching it.
    if (!preloaded && bytes > cacheCap) return;
    cache.set(key, { value, bytes });
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
    const res = await forageStorage.getPluginStorageIndex();
    const next = new Map<string, number>();
    for (const entry of res.entries ?? []) {
        if (typeof entry?.key === "string") next.set(entry.key, entry.size ?? 0);
    }
    // Writes still in flight are not on the server yet — keep them visible.
    for (const k of new Set([...queues.keys(), ...inflight.keys()])) {
        const op = pendingOp(k);
        if (!op) continue;
        if (op.op === "set") next.set(k, op.bytes.length);
        else next.delete(k);
    }
    index = next;
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
    if (refreshing) return refreshing;
    refreshing = (async () => {
        initPromise = null;
        await init();
        tombstones = new Set();
        for (const key of [...cache.keys()]) {
            if (!index.has(key) && !pendingOp(key)) cacheDelete(key);
        }
        if (preloaded) {
            preloadPromise = null;
            await preloadAll();
        }
    })().finally(() => {
        refreshing = null;
    });
    return refreshing;
}

function maybeRefreshInBackground() {
    if (!initPromise || refreshing) return;
    if (Date.now() - indexFetchedAt < INDEX_STALE_MS) return;
    void refreshIndex().catch((e) => console.warn("[pluginStorage] background index refresh failed", e));
}

export async function getItem(key: string): Promise<any | null> {
    await init();
    const hit = cacheGet(key);
    if (hit) return hit.value;
    // Removed by this store in this session → the server has nothing. Any
    // other index miss is read anyway: a miss is cheap and the key may have
    // been written by another device since the index was fetched.
    if (tombstones.has(key)) return null;
    const data = await forageStorage.getItem(kvKeyFor(key));
    if (!data || data.length === 0) {
        index.delete(key);
        return null;
    }
    let value: any;
    try {
        value = JSON.parse(decoder.decode(data));
    } catch (e) {
        console.warn(`[pluginStorage] unparseable value for "${key}" — treating as missing`, e);
        index.delete(key);
        return null;
    }
    index.set(key, data.length);
    cacheSet(key, value, data.length);
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
                for (const b of batch) b.resolve(b !== intent);
                break;
            } catch (e) {
                inflight.delete(key);
                if (attempt >= attempts) {
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
function enqueue(key: string, op: PendingOp, sync: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
        let queue = queues.get(key);
        if (!queue) queues.set(key, (queue = []));
        queue.push({ op, sync, resolve, reject });
        if (!workers.has(key)) {
            workers.add(key);
            void worker(key);
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
    // Server first: the cache must never claim a value the server never got.
    const superseded = await enqueue(key, { op: "set", bytes }, false);
    if (superseded) return; // a newer write already owns cache/index
    index.set(key, bytes.length);
    tombstones.delete(key);
    cacheSet(key, value, bytes.length);
}

export async function removeItem(key: string): Promise<void> {
    await init();
    if (index.has(key) || !tombstones.has(key)) {
        const superseded = await enqueue(key, { op: "remove" }, false);
        if (superseded) return;
    }
    index.delete(key);
    tombstones.add(key);
    cacheDelete(key);
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

export function size(key: string): number | undefined {
    return index.get(key);
}

export function has(key: string): boolean {
    return index.has(key);
}

export function isPreloaded(): boolean {
    return preloaded;
}

// Load every value into the cache so the synchronous V2 API can be served.
// This is the pre-lazy memory footprint (one copy), only paid when a V2
// plugin is enabled.
export function preloadAll(): Promise<void> {
    if (!preloadPromise) {
        preloadPromise = (async () => {
            await init();
            preloaded = true;
            const pending = [...index.keys()].filter((k) => !cache.has(k));
            const CONCURRENCY = 8;
            for (let i = 0; i < pending.length; i += CONCURRENCY) {
                await Promise.all(pending.slice(i, i + CONCURRENCY).map((k) => getItem(k)));
            }
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
    const out: Record<string, any> = {};
    const all = [...index.keys()];
    const CONCURRENCY = 8;
    for (let i = 0; i < all.length; i += CONCURRENCY) {
        const chunk = all.slice(i, i + CONCURRENCY);
        const values = await Promise.all(chunk.map((k) => getItem(k)));
        chunk.forEach((k, j) => {
            if (values[j] === null || values[j] === undefined) return;
            // defineProperty so a stored "__proto__" key stays an own property
            // (same as the server's readAll).
            Object.defineProperty(out, k, {
                value: values[j], enumerable: true, writable: true, configurable: true,
            });
        });
    }
    return out;
}

// ── sync API (V2 plugins; valid only after preloadAll) ─────────────────────

export function getItemSync(key: string): any | null {
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
    if (value === undefined) return removeItemSync(key);
    const json = JSON.stringify(value);
    const bytes = encoder.encode(json);
    index.set(key, bytes.length);
    tombstones.delete(key);
    cacheSet(key, value, bytes.length);
    enqueueSync(key, { op: "set", bytes });
}

export function removeItemSync(key: string): void {
    const existed = index.delete(key);
    cacheDelete(key);
    tombstones.add(key);
    if (existed || pendingOp(key)) {
        enqueueSync(key, { op: "remove" });
    }
}

export function clearSync(): void {
    for (const key of [...index.keys()]) removeItemSync(key);
}

// Test-only: drop all in-memory state.
export function _resetForTests() {
    index = new Map();
    initPromise = null;
    cache = new Map();
    cacheBytes = 0;
    cacheCap = DEFAULT_CACHE_CAP;
    preloaded = false;
    preloadPromise = null;
    tombstones = new Set();
    indexFetchedAt = 0;
    refreshing = null;
    queues = new Map();
    inflight = new Map();
    workers = new Set();
}
