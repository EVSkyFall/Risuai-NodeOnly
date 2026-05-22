import { notifyError } from "src/ts/alert"
import { toast } from "svelte-sonner"
import { importPlugin } from "../plugins.svelte"
import { hotReloading } from "src/ts/stores.svelte"
import { sleep } from "src/ts/util"

const IDB_NAME = 'risuai-dev-hotreload'
const IDB_STORE = 'handles'
const IDB_KEY = 'plugin-file'

let activeAbort: AbortController | null = null

async function openHandleDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1)
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(IDB_STORE)) {
                req.result.createObjectStore(IDB_STORE)
            }
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
    })
}

async function persistHandle(handle: FileSystemFileHandle): Promise<void> {
    const db = await openHandleDb()
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(handle, IDB_KEY)
    await new Promise<void>((res, rej) => {
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
    })
    db.close()
}

async function loadPersistedHandle(): Promise<FileSystemFileHandle | null> {
    let db: IDBDatabase
    try {
        db = await openHandleDb()
    } catch {
        return null
    }
    try {
        const tx = db.transaction(IDB_STORE, 'readonly')
        const handle = await new Promise<FileSystemFileHandle | undefined>((res, rej) => {
            const req = tx.objectStore(IDB_STORE).get(IDB_KEY)
            req.onsuccess = () => res(req.result)
            req.onerror = () => rej(req.error)
        })
        db.close()
        return handle ?? null
    } catch {
        db.close()
        return null
    }
}

async function clearPersistedHandle(): Promise<void> {
    try {
        const db = await openHandleDb()
        const tx = db.transaction(IDB_STORE, 'readwrite')
        tx.objectStore(IDB_STORE).delete(IDB_KEY)
        await new Promise<void>((res, rej) => {
            tx.oncomplete = () => res()
            tx.onerror = () => rej(tx.error)
        })
        db.close()
    } catch { /* best-effort */ }
}

function startPolling(fileHandle: FileSystemFileHandle, signal: AbortSignal) {
    let lastModified = 0;

    (async () => {
        while (!signal.aborted) {
            try {
                const file = await fileHandle.getFile()
                if (file.lastModified !== lastModified) {
                    console.warn("[HotReload] Detected change, reloading...")
                    lastModified = file.lastModified
                    const content = await file.text()
                    await importPlugin(content, {
                        isHotReload: true,
                        isUpdate: true,
                        isTypescript: file.name.endsWith(".ts")
                    })
                }
            } catch (e) {
                if (signal.aborted) break
                console.error("[HotReload] Error reading file:", e)
            }
            await sleep(500)
        }
    })()
}

export async function hotReloadPluginFiles() {
    if (!('showOpenFilePicker' in window)) {
        notifyError("Your browser does not support the File System Access API, which is required for hot-reloading plugin files.")
        return
    }

    let fileHandle: FileSystemFileHandle
    try {
        [fileHandle] = await (window as any).showOpenFilePicker({
            types: [
                {
                    description: "JavaScript or TypeScript Plugin File",
                    accept: {
                        "text/typescript": [".ts"],
                        "application/javascript": [".js"]
                    }
                }
            ]
        })
    } catch {
        return
    }

    if (activeAbort) activeAbort.abort()
    activeAbort = new AbortController()

    await persistHandle(fileHandle)
    startPolling(fileHandle, activeAbort.signal)
}

export async function resumeHotReload(): Promise<boolean> {
    const handle = await loadPersistedHandle()
    if (!handle) return false

    const perm = await (handle as any).queryPermission({ mode: 'read' })
    if (perm === 'granted') {
        if (activeAbort) activeAbort.abort()
        activeAbort = new AbortController()
        startPolling(handle, activeAbort.signal)
        return true
    }

    toast.info(`Hot reload paused — ${handle.name}`, {
        action: {
            label: 'Resume',
            onClick: async () => {
                const granted = await (handle as any).requestPermission({ mode: 'read' })
                if (granted === 'granted') {
                    if (activeAbort) activeAbort.abort()
                    activeAbort = new AbortController()
                    startPolling(handle, activeAbort.signal)
                    hotReloading.push(handle.name)
                    toast.success(`Hot reload resumed — ${handle.name}`)
                }
            }
        },
        duration: 15000,
    })
    return false
}

export async function requestResumeHotReload(): Promise<boolean> {
    const handle = await loadPersistedHandle()
    if (!handle) return false

    const perm = await (handle as any).requestPermission({ mode: 'read' })
    if (perm === 'granted') {
        if (activeAbort) activeAbort.abort()
        activeAbort = new AbortController()
        startPolling(handle, activeAbort.signal)
        return true
    }
    return false
}

export async function stopHotReload() {
    if (activeAbort) {
        activeAbort.abort()
        activeAbort = null
    }
    await clearPersistedHandle()
}

export function isHotReloadActive(): boolean {
    return activeAbort !== null && !activeAbort.signal.aborted
}

export async function hasPersistedHandle(): Promise<boolean> {
    const handle = await loadPersistedHandle()
    return handle !== null
}
