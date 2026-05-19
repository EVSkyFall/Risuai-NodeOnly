import {
    clearPersistentPrefix,
    decodeStorageKeyComponent,
    listPersistentKeys,
    makeEncodedStorageKey,
    readPersistentJson,
    removePersistentKey,
    writePersistentJson,
} from "../storage/persistentKv"

const CUSTOM_PREFIX = 'plugin-custom-storage/'
const BLOB_PREFIX = 'plugin-blob-storage/'
const FLUSH_DEBOUNCE_MS = 300

export class PluginCustomKvStorage {
    private cache = new Map<string, any>()
    private dirtyKeys = new Set<string>()
    private pendingDeletes = new Set<string>()
    private flushTimer: ReturnType<typeof setTimeout> | null = null
    private flushPromise: Promise<void> | null = null
    private initialized = false

    async init(legacyData?: Record<string, any>): Promise<void> {
        const serverKeys = await listPersistentKeys(CUSTOM_PREFIX)

        for (const fullKey of serverKeys) {
            const encoded = fullKey.slice(CUSTOM_PREFIX.length, -'.json'.length)
            const rawKey = decodeStorageKeyComponent(encoded)
            const value = await readPersistentJson<any>(fullKey)
            if (value !== null) {
                this.cache.set(rawKey, value)
            }
        }

        if (legacyData && typeof legacyData === 'object') {
            const legacyKeys = Object.keys(legacyData)
            if (legacyKeys.length > 0 && this.cache.size === 0) {
                for (const key of legacyKeys) {
                    this.cache.set(key, legacyData[key])
                    this.dirtyKeys.add(key)
                }
                await this.flush()
            }
        }

        this.initialized = true
    }

    getItem(key: string): any | null {
        return this.cache.get(key) ?? null
    }

    hasItem(key: string): boolean {
        return this.cache.has(key)
    }

    setItem(key: string, value: any): void {
        this.cache.set(key, value)
        this.dirtyKeys.add(key)
        this.pendingDeletes.delete(key)
        this.scheduleFlush()
    }

    removeItem(key: string): void {
        this.cache.delete(key)
        this.dirtyKeys.delete(key)
        this.pendingDeletes.add(key)
        this.scheduleFlush()
    }

    clear(): void {
        const allKeys = [...this.cache.keys()]
        this.cache.clear()
        this.dirtyKeys.clear()
        for (const key of allKeys) {
            this.pendingDeletes.add(key)
        }
        this.scheduleFlush()
    }

    keys(): string[] {
        return [...this.cache.keys()]
    }

    key(index: number): string | null {
        return this.keys()[index] ?? null
    }

    get length(): number {
        return this.cache.size
    }

    private scheduleFlush(): void {
        if (this.flushTimer !== null) return
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null
            this.flush()
        }, FLUSH_DEBOUNCE_MS)
    }

    async flush(): Promise<void> {
        if (this.flushPromise) {
            await this.flushPromise
        }

        if (this.dirtyKeys.size === 0 && this.pendingDeletes.size === 0) return

        const keysToWrite = [...this.dirtyKeys]
        const keysToDelete = [...this.pendingDeletes]
        this.dirtyKeys.clear()
        this.pendingDeletes.clear()

        this.flushPromise = (async () => {
            const results = await Promise.allSettled([
                ...keysToWrite.map(async (key) => {
                    const value = this.cache.get(key)
                    if (value !== undefined) {
                        await writePersistentJson(makeEncodedStorageKey(CUSTOM_PREFIX, key), value)
                    }
                    return { type: 'write' as const, key }
                }),
                ...keysToDelete.map(async (key) => {
                    await removePersistentKey(makeEncodedStorageKey(CUSTOM_PREFIX, key))
                    return { type: 'delete' as const, key }
                }),
            ])

            for (const result of results) {
                if (result.status === 'rejected') {
                    const val = (result as PromiseRejectedResult)
                    console.warn('[PluginCustomKvStorage] flush failed for key:', val.reason)
                }
                if (result.status === 'fulfilled') continue
                // Can't recover key identity from rejected promise easily,
                // so re-queue all failed ops in the next block
            }

            for (let i = 0; i < results.length; i++) {
                if (results[i].status === 'rejected') {
                    const idx = i
                    if (idx < keysToWrite.length) {
                        const key = keysToWrite[idx]
                        if (this.cache.has(key) && !this.pendingDeletes.has(key)) {
                            this.dirtyKeys.add(key)
                        }
                    } else {
                        const key = keysToDelete[idx - keysToWrite.length]
                        if (!this.cache.has(key) && !this.dirtyKeys.has(key)) {
                            this.pendingDeletes.add(key)
                        }
                    }
                }
            }

            if (this.dirtyKeys.size > 0 || this.pendingDeletes.size > 0) {
                this.scheduleFlush()
            }
        })()

        try {
            await this.flushPromise
        } finally {
            this.flushPromise = null
        }
    }

    async flushImmediate(): Promise<void> {
        if (this.flushTimer !== null) {
            clearTimeout(this.flushTimer)
            this.flushTimer = null
        }
        await this.flush()
    }
}


export class PluginBlobKvStorage {
    private cache = new Map<string, string>()
    private migrated = false

    async init(): Promise<void> {
        await this.migrateFromIdb()
        this.migrated = true
    }

    async getItem(key: string): Promise<string | null> {
        if (this.cache.has(key)) {
            return this.cache.get(key)!
        }
        const value = await readPersistentJson<string>(makeEncodedStorageKey(BLOB_PREFIX, key))
        if (value !== null) {
            this.cache.set(key, value)
        }
        return value
    }

    async setItem(key: string, value: string): Promise<void> {
        this.cache.set(key, value)
        await writePersistentJson(makeEncodedStorageKey(BLOB_PREFIX, key), value)
    }

    async removeItem(key: string): Promise<void> {
        this.cache.delete(key)
        await removePersistentKey(makeEncodedStorageKey(BLOB_PREFIX, key))
    }

    async keys(): Promise<string[]> {
        const storageKeys = await listPersistentKeys(BLOB_PREFIX)
        return storageKeys.map(k => {
            const encoded = k.slice(BLOB_PREFIX.length, -'.json'.length)
            return decodeStorageKeyComponent(encoded)
        })
    }

    private async migrateFromIdb(): Promise<void> {
        const markerKey = '_meta/plugin-blob-migrated.json'
        const marker = await readPersistentJson<boolean>(markerKey)
        if (marker) return

        if (typeof indexedDB === 'undefined') return

        const BLOB_DB_NAME = 'risuai-plugin-blobs'
        const BLOB_STORE_NAME = 'blobs'

        let idb: IDBDatabase
        try {
            idb = await new Promise<IDBDatabase>((resolve, reject) => {
                const req = indexedDB.open(BLOB_DB_NAME, 1)
                req.onupgradeneeded = () => {
                    if (!req.result.objectStoreNames.contains(BLOB_STORE_NAME)) {
                        req.result.createObjectStore(BLOB_STORE_NAME)
                    }
                }
                req.onsuccess = () => resolve(req.result)
                req.onerror = () => reject(req.error)
            })
        } catch {
            return
        }

        try {
            const tx = idb.transaction(BLOB_STORE_NAME, 'readonly')
            const store = tx.objectStore(BLOB_STORE_NAME)
            const allKeys = await new Promise<IDBValidKey[]>((resolve, reject) => {
                const req = store.getAllKeys()
                req.onsuccess = () => resolve(req.result)
                req.onerror = () => reject(req.error)
            })

            for (const idbKey of allKeys) {
                const key = String(idbKey)
                const value = await new Promise<any>((resolve, reject) => {
                    const readTx = idb.transaction(BLOB_STORE_NAME, 'readonly')
                    const readStore = readTx.objectStore(BLOB_STORE_NAME)
                    const req = readStore.get(idbKey)
                    req.onsuccess = () => resolve(req.result)
                    req.onerror = () => reject(req.error)
                })

                if (value !== undefined) {
                    await writePersistentJson(makeEncodedStorageKey(BLOB_PREFIX, key), value)
                    this.cache.set(key, value)

                    const delTx = idb.transaction(BLOB_STORE_NAME, 'readwrite')
                    const delStore = delTx.objectStore(BLOB_STORE_NAME)
                    await new Promise<void>((resolve, reject) => {
                        const req = delStore.delete(idbKey)
                        req.onsuccess = () => resolve()
                        req.onerror = () => reject(req.error)
                    })
                }
            }

            idb.close()

            try {
                await new Promise<void>((resolve, reject) => {
                    const req = indexedDB.deleteDatabase(BLOB_DB_NAME)
                    req.onsuccess = () => resolve()
                    req.onerror = () => reject(req.error)
                })
            } catch { /* non-critical */ }
        } catch (e) {
            idb.close()
            console.warn('[PluginBlobKvStorage] IDB migration incomplete:', e)
            return
        }

        await writePersistentJson(markerKey, true)
    }
}


export const pluginCustomKv = new PluginCustomKvStorage()
export const pluginBlobKv = new PluginBlobKvStorage()

export async function initPluginKvStorage(legacyPluginCustomStorage?: Record<string, any>): Promise<void> {
    await pluginCustomKv.init(legacyPluginCustomStorage)
    await pluginBlobKv.init()
}
