import type { Chat } from './database.svelte'
import { messageFingerprints, prefixFingerprint } from './chatFingerprint'
import type { ChatPostOptions, ChatPostOutcome, DurableChatSaveResult } from './nodeStorage'

// Chat delta sync — transfer only what changed for long chats.
//
// Loading: the browser keeps a copy of recently opened long chats in
// IndexedDB. Opening one sends the copy's message count and prefix
// fingerprint; the server returns only the messages after it when its own
// first messages fingerprint the same, otherwise the whole chat as before.
//
// Saving: the messages the server held after the last sync are remembered as
// fingerprints (memory only). A save sends only the messages after the
// longest unchanged prefix. The server splices them onto its stored chat
// ONLY after verifying that prefix against its own data; on mismatch it
// answers 409 and the full chat is sent. The remembered base only picks how
// much to send — the stored result always equals the client's chat, exactly
// like a full save.
//
// Nothing here puts a partial chat into memory: a chat is either assembled
// complete (verified prefix + fetched rest) or fetched whole.

export interface ChatDeltaTransport {
    enqueueChatSave?<T>(chaId: string, chatId: string, save: () => Promise<T>): Promise<T>
    fetchChatContentDelta(chaId: string, chatIndex: number, chatId: string, base: { count: number, fp: string } | null, baseRev?: string | null): Promise<{ chat: any, deltaBase: number | null, revision?: string | null } | { notModified: true, revision?: string | null } | null>
    saveChatContentDelta(chaId: string, chatIndex: number, chatId: string, chat: any, base: { count: number, fp: string } | null): Promise<'ok' | 'base-mismatch'>
    /** Revision-aware POST. Without it saves go through saveChatContentDelta and carry no revision. */
    postChatContent?(chaId: string, chatIndex: number, chatId: string, chat: any, options: ChatPostOptions): Promise<ChatPostOutcome>
}

export type ChatFetchResult =
    | { kind: 'ok', chat: Chat, revision: string | null }
    /** The server still holds the revision the caller named. */
    | { kind: 'same', revision: string | null }
    | { kind: 'missing' }

export type ChatSaveOutcome =
    | { status: 'ok', revision: string | null, durable?: DurableChatSaveResult }
    | { status: 'conflict', revision: string | null }

export interface ChatSaveOptions {
    baseRev?: string | null
    forkOf?: string
    strict?: boolean
    /** messageFingerprints(chat.message), when the caller already has them. */
    fingerprints?: string[]
}

export interface ChatCopyStore {
    get(key: string): Promise<Chat | null>
    put(key: string, chat: Chat): Promise<void>
}

// Only long chats are worth a local copy; short ones load fast anyway.
export const CACHE_MIN_MESSAGES = 40
export const CACHE_MAX_ENTRIES = 24

function chatCopyKey(chaId: string, chatId: string) {
    return `${chaId}|${chatId}`
}

function isUsableCopy(chat: any): chat is Chat {
    return !!chat && typeof chat === 'object' && Array.isArray(chat.message) && chat.message.length > 0 && !chat._placeholder
}

export function createChatDeltaSync(transport: ChatDeltaTransport, copies: ChatCopyStore) {
    const serverFingerprints = new Map<string, string[]>()

    async function fetchChat(chaId: string, chatIndex: number, chatId: string): Promise<Chat | null> {
        const result = await fetchChatRev(chaId, chatIndex, chatId)
        return result.kind === 'ok' ? result.chat : null
    }

    // The chat with the revision the server holds it under. With `baseRev`,
    // an unchanged chat comes back as 'same' and nothing is transferred.
    async function fetchChatRev(chaId: string, chatIndex: number, chatId: string, baseRev?: string | null): Promise<ChatFetchResult> {
        const key = chatCopyKey(chaId, chatId)
        let copy: Chat | null = null
        // A check against a known revision is expected to answer "unchanged":
        // reading and fingerprinting the local copy first would cost more
        // than the body it could save.
        if (!baseRev) {
            try {
                const stored = await copies.get(key)
                if (isUsableCopy(stored)) copy = stored
            } catch {
                copy = null
            }
        }
        const copyFingerprints = copy ? messageFingerprints(copy.message) : null
        const base = copy && copyFingerprints
            ? { count: copy.message.length, fp: prefixFingerprint(copyFingerprints, copy.message.length) }
            : null

        const result = await transport.fetchChatContentDelta(chaId, chatIndex, chatId, base, baseRev ?? null)
        if (!result) return { kind: 'missing' }
        if ('notModified' in result) return { kind: 'same', revision: result.revision ?? null }

        let full: Chat = result.chat
        let fingerprints: string[]
        if (result.deltaBase !== null && copy && copyFingerprints && result.deltaBase === copy.message.length) {
            full = { ...result.chat, message: copy.message.concat(result.chat.message) }
            fingerprints = copyFingerprints.concat(messageFingerprints(result.chat.message))
        } else {
            fingerprints = messageFingerprints(full.message ?? [])
        }
        serverFingerprints.set(key, fingerprints)

        if ((full.message?.length ?? 0) >= CACHE_MIN_MESSAGES) {
            // Clone now, while `full` is still a plain object (it becomes
            // reactive state once the caller applies it).
            let snapshot: Chat | null = null
            try {
                snapshot = structuredClone(full)
            } catch {
                snapshot = null
            }
            if (snapshot) void copies.put(key, snapshot).catch(() => {})
        }
        return { kind: 'ok', chat: full, revision: result.revision ?? null }
    }

    // Saves of one chat run one at a time, in call order: autosave, job
    // recovery and plugin writes all save through here, and a slower earlier
    // request finishing last would replace the newer chat on the server.
    // With nothing in flight a save starts at once, so its content is taken
    // at the call as before.
    const saveQueues = new Map<string, Promise<void>>()

    function saveChat(chaId: string, chatIndex: number, chatId: string, chat: Chat): Promise<void> {
        if (transport.enqueueChatSave) return transport.enqueueChatSave(chaId, chatId, () => saveChatNow(chaId, chatIndex, chatId, chat))
        const key = chatCopyKey(chaId, chatId)
        const previous = saveQueues.get(key)
        const run = previous
            ? previous.then(() => saveChatNow(chaId, chatIndex, chatId, chat))
            : saveChatNow(chaId, chatIndex, chatId, chat)
        const settled = run.then(() => {}, () => {})
        saveQueues.set(key, settled)
        void settled.then(() => {
            if (saveQueues.get(key) === settled) saveQueues.delete(key)
        })
        return run
    }

    async function saveChatNow(chaId: string, chatIndex: number, chatId: string, chat: Chat): Promise<void> {
        const outcome = await postChat(chaId, chatIndex, chatId, chat)
        if (outcome.status === 'conflict') throw new Error('saveChatContent error: 409')
    }

    async function post(chaId: string, chatIndex: number, chatId: string, body: any, base: { count: number, fp: string } | null, options: ChatSaveOptions): Promise<ChatPostOutcome> {
        if (transport.postChatContent) {
            return transport.postChatContent(chaId, chatIndex, chatId, body, {
                deltaBase: base,
                baseRev: options.baseRev ?? null,
                forkOf: options.forkOf,
                strict: options.strict,
            })
        }
        const legacy = await transport.saveChatContentDelta(chaId, chatIndex, chatId, body, base)
        return legacy === 'ok' ? { status: 'ok', revision: null } : { status: 'base-mismatch' }
    }

    // One save, not queued: the caller holds the chat's queue slot. A revision
    // conflict is returned, not thrown, and leaves the remembered server
    // fingerprints as they were.
    async function postChat(chaId: string, chatIndex: number, chatId: string, chat: Chat, options: ChatSaveOptions = {}): Promise<ChatSaveOutcome> {
        const key = chatCopyKey(chaId, chatId)
        const messages = chat.message ?? []
        // Fingerprints, delta body and encoding are all taken synchronously
        // below, so they describe the same chat content even if it keeps
        // changing (streaming) while the request is in flight.
        const fingerprints = options.fingerprints ?? messageFingerprints(messages)
        const known = serverFingerprints.get(key)
        let shared = 0
        if (known) {
            const max = Math.min(known.length, fingerprints.length)
            while (shared < max && known[shared] === fingerprints[shared]) shared++
        }
        if (shared > 0) {
            const delta = { ...chat, message: messages.slice(shared) }
            const outcome = await post(chaId, chatIndex, chatId, delta, {
                count: shared,
                fp: prefixFingerprint(fingerprints, shared),
            }, options)
            if (outcome.status === 'ok') {
                serverFingerprints.set(key, fingerprints)
                return outcome
            }
            if (outcome.status === 'conflict') return outcome
            // The delta prefix did not verify (a server-side write under the
            // same revision is not possible, but a base remembered from a
            // different copy is): fall through to a full save.
        }
        const outcome = await post(chaId, chatIndex, chatId, chat, null, options)
        if (outcome.status === 'conflict') return outcome
        serverFingerprints.set(key, fingerprints)
        return outcome.status === 'ok' ? outcome : { status: 'ok', revision: null }
    }

    return { fetchChat, fetchChatRev, saveChat, postChat }
}

// ── IndexedDB copy store ────────────────────────────────────────────────────

const DB_NAME = 'pocketrisu-chat-copies'
const STORE = 'chats'

let dbPromise: Promise<IDBDatabase> | null = null

function openCopyDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB unavailable'))
            return
        }
        const request = indexedDB.open(DB_NAME, 1)
        request.onupgradeneeded = () => {
            const db = request.result
            if (!db.objectStoreNames.contains(STORE)) {
                const store = db.createObjectStore(STORE, { keyPath: 'key' })
                store.createIndex('usedAt', 'usedAt')
            }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
    dbPromise.catch(() => { dbPromise = null })
    return dbPromise
}

function done(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
    })
}

export const indexedDbChatCopies: ChatCopyStore = {
    async get(key) {
        const db = await openCopyDb()
        const tx = db.transaction(STORE, 'readwrite')
        const store = tx.objectStore(STORE)
        const record = await new Promise<any>((resolve, reject) => {
            const request = store.get(key)
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        if (record) store.put({ ...record, usedAt: Date.now() })
        await done(tx)
        return record?.chat ?? null
    },
    async put(key, chat) {
        const db = await openCopyDb()
        const tx = db.transaction(STORE, 'readwrite')
        const store = tx.objectStore(STORE)
        store.put({ key, chat, usedAt: Date.now() })
        // Evict least recently used copies beyond the cap.
        const countRequest = store.count()
        countRequest.onsuccess = () => {
            let excess = countRequest.result - CACHE_MAX_ENTRIES
            if (excess <= 0) return
            const cursorRequest = store.index('usedAt').openCursor()
            cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result
                if (!cursor || excess <= 0) return
                if (cursor.primaryKey !== key) {
                    cursor.delete()
                    excess--
                }
                cursor.continue()
            }
        }
        await done(tx)
    },
}
