import { hasher } from "../parser/parser.svelte";
import { forageStorage } from "../globalApi.svelte";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let initPromise: Promise<void> | null = null;

async function ensureStorageReady() {
    if (!initPromise) {
        initPromise = forageStorage.Init();
    }
    await initPromise;
}

function encodeKeyComponent(value: string) {
    return Buffer.from(value, "utf-8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function decodeKeyComponent(value: string) {
    const padded = value
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "=");
    return Buffer.from(padded, "base64").toString("utf-8");
}

export async function readPersistentJson<T>(storageKey: string): Promise<T | null> {
    await ensureStorageReady();
    const data = await forageStorage.getItem(storageKey);
    if (!data) {
        return null;
    }
    return JSON.parse(decoder.decode(data)) as T;
}

type BulkCapableStorage = {
    getItems?: (keys: string[]) => Promise<{ key: string; value: Uint8Array | null }[]>
}

/**
 * Read many storage keys in a single round trip and JSON-decode each value,
 * preserving one output slot per input key (including duplicate inputs).
 *
 * On Node storage this uses the existing bulk endpoint
 * (`forageStorage.getItems` / `POST /api/assets/bulk-read`) so a scan of N keys
 * costs one request rather than N per-record `/api/read`s. Storage backends
 * without a bulk API fall back to per-key reads.
 *
 * Semantics match `readPersistentJson` exactly per key: a key that is absent
 * from the response (or stored empty) decodes to `null`; corrupt bytes throw
 * from `JSON.parse`. The bulk correlation itself is fail-closed — an unrequested
 * key or a duplicate row in the response throws instead of being silently
 * dropped or letting a stray row shadow the wrong slot.
 */
export async function readManyPersistentJson<T>(
    storageKeys: readonly string[],
): Promise<(T | null)[]> {
    await ensureStorageReady();
    if (storageKeys.length === 0) {
        return [];
    }

    const bulkReader = (forageStorage as BulkCapableStorage).getItems;
    if (typeof bulkReader !== "function") {
        return await Promise.all(storageKeys.map((key) => readPersistentJson<T>(key)));
    }

    const uniqueKeys = [...new Set(storageKeys)];
    const rows = await bulkReader.call(forageStorage, uniqueKeys);
    const requested = new Set(uniqueKeys);
    const rowByKey = new Map<string, Uint8Array | null>();
    for (const row of rows) {
        if (!requested.has(row.key)) {
            throw new Error(`Bulk read returned an unrequested key: ${row.key}`);
        }
        if (rowByKey.has(row.key)) {
            throw new Error(`Bulk read returned a duplicate row for key: ${row.key}`);
        }
        rowByKey.set(row.key, row.value ?? null);
    }

    return storageKeys.map((key) => {
        const value = rowByKey.get(key);
        if (!value || value.length === 0) {
            return null;
        }
        return JSON.parse(decoder.decode(value)) as T;
    });
}

export async function writePersistentJson<T>(storageKey: string, value: T): Promise<void> {
    await ensureStorageReady();
    await forageStorage.setItem(storageKey, encoder.encode(JSON.stringify(value)));
}

export async function removePersistentKey(storageKey: string): Promise<void> {
    await ensureStorageReady();
    await forageStorage.removeItem(storageKey);
}

export async function listPersistentKeys(prefix = ""): Promise<string[]> {
    await ensureStorageReady();
    return await forageStorage.keys(prefix);
}

export async function clearPersistentPrefix(prefix: string): Promise<void> {
    const keys = await listPersistentKeys(prefix);
    await Promise.all(keys.map((key) => removePersistentKey(key)));
}

export async function makeHashedStorageKey(prefix: string, rawKey: string): Promise<string> {
    const hash = await hasher(encoder.encode(rawKey));
    return `${prefix}${hash}.json`;
}

export function makeEncodedStorageKey(prefix: string, rawKey: string): string {
    return `${prefix}${encodeKeyComponent(rawKey)}.json`;
}

export function decodeStorageKeyComponent(encodedKey: string): string {
    return decodeKeyComponent(encodedKey);
}

// Shared with the server's plugin-storage kv key scheme (no `.json` suffix).
export function encodeStorageKeyComponent(rawKey: string): string {
    return encodeKeyComponent(rawKey);
}
