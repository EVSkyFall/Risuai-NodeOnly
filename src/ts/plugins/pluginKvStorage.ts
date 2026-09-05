import * as pluginStorageStore from "./pluginStorageStore"
import {
    decodeStorageKeyComponent,
    listPersistentKeys,
    makeEncodedStorageKey,
    readPersistentJson,
    removePersistentKey,
    writePersistentJson,
} from "../storage/persistentKv"

const BLOB_PREFIX = 'plugin-blob-storage/'

// Compatibility facade: all custom values use the single lazy store and server namespace.
export class PluginCustomKvStorage {
    async init(_legacyData?: Record<string, any>): Promise<void> { await pluginStorageStore.init() }
    getItem(key: string): any | null { return pluginStorageStore.getItemSync(key) }
    hasItem(key: string): boolean { return pluginStorageStore.has(key) }
    setItem(key: string, value: any): void { pluginStorageStore.setItemSync(key, value) }
    removeItem(key: string): void { pluginStorageStore.removeItemSync(key) }
    clear(): void { pluginStorageStore.clearSync() }
    keys(): string[] { return pluginStorageStore.keys() }
    key(index: number): string | null { return pluginStorageStore.key(index) }
    get length(): number { return pluginStorageStore.length() }
    async flush(): Promise<void> { await pluginStorageStore.flushImmediate() }
    async flushImmediate(): Promise<void> { await pluginStorageStore.flushImmediate() }
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
