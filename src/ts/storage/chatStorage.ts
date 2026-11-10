import { forageStorage } from "../globalApi.svelte"
import { type Chat, type ChatStub, type ChatOrStub, isChatStub } from "./database.svelte"
import type { DurableChatSaveResult } from "./nodeStorage"
import { tick } from "svelte"
import { writable } from "svelte/store"
import { v4 } from "uuid"
import { createChatDeltaSync, indexedDbChatCopies } from "./chatDeltaSync"
import { ChatSyncError, createChatSync, type LiveChat, type RefreshResult } from "./chatSync"

// ── Stub ↔ Placeholder conversion ───────────────────────────────────────────

/**
 * Convert a ChatStub to a placeholder Chat with safe empty defaults.
 * The placeholder passes all Chat type checks so existing code works unchanged.
 * `_placeholder: true` marks it for hydration and dirty-tracking suppression.
 *
 * Key presence is preserved (mirroring chatToStub) so an explicit null from
 * the server — meaning "user cleared this field" — survives the placeholder
 * round-trip. Otherwise the next chatToStub call would emit a "remove" patch
 * op and the server merge would fall back to a stale fullChat value.
 */
export function stubToPlaceholder(stub: ChatStub): Chat {
    const placeholder: Chat = {
        message: [],
        note: '',
        name: stub.name,
        localLore: [],
        id: stub.id,
        fmIndex: -1,
        _placeholder: true,
    }
    if ('lastDate' in stub) placeholder.lastDate = stub.lastDate
    if ('folderId' in stub) placeholder.folderId = stub.folderId
    if ('modules' in stub) placeholder.modules = stub.modules
    return placeholder
}

/**
 * Convert a Chat (or placeholder) to a ChatStub for database.bin encoding.
 *
 * Key presence is preserved even when the value is null/undefined so the
 * stub round-trip distinguishes "user cleared" from "field absent". The
 * server merge layer relies on `in` semantics — see mergeChatStubWithFullChat.
 */
export function chatToStub(chat: Chat | ChatStub): ChatStub {
    if (isChatStub(chat)) return chat
    const stub: ChatStub = {
        id: chat.id ?? '',
        name: chat.name ?? '',
        _stub: true,
    }
    if ('lastDate' in chat) stub.lastDate = chat.lastDate
    if ('folderId' in chat) stub.folderId = chat.folderId
    if ('modules' in chat) stub.modules = chat.modules
    return stub
}

/**
 * Replace all ChatStubs in a character's chats array with placeholder Chats.
 * Call this once after decoding database.bin so runtime code only sees Chat objects.
 *
 * Self-healing for hybrid corruption: if a chat carries the `_stub: true`
 * flag *and* a real message array (legacy v1.4.x disk corruption), strip the
 * flag and keep the Chat as-is. Converting it to a placeholder would call
 * stubToPlaceholder, which resets `message` to `[]` — the corruption would
 * become real data loss the moment the user sees the chat list.
 */
export function convertStubsToPlaceholders(chats: ChatOrStub[]): Chat[] {
    return chats.map(c => {
        if (!c) return c as Chat
        if ((c as any)._stub === true && Array.isArray((c as any).message)) {
            const { _stub: _drop, ...rest } = c as any
            return rest as Chat
        }
        return isChatStub(c) ? stubToPlaceholder(c) : (c as Chat)
    })
}

/**
 * Restore the runtime chat-shape invariant on characters merged from a raw
 * server decode (the save loop's rebase path). Boot applies
 * convertStubsToPlaceholders exactly once (bootstrap.ts); a mid-session rebase
 * that skips it injects raw `_stub` entries into live UI state, where every
 * Chat consumer reads `message.length` and crashes — and a raw stub flowing
 * back through the per-chat save path poisons the server's fullChatStore with
 * a message-less entry, after which the stub-loss guard aborts every
 * database.bin persist until restart (2026-07-21 multi-browser incident).
 *
 * EVERY locally hydrated full chat is grafted back over its converted
 * placeholder slot (matched by chat id) — not just the currently open one —
 * so this browser's hydrated view survives the rebase intact: the open chat
 * keeps rendering, and previously opened chats keep the local copy until
 * they re-hydrate. That deliberately prefers the local copy over a possibly
 * newer server copy for off-screen chats, matching the documented
 * no-live-sync / per-chat last-writer-wins model. Mutates mergedCharacters
 * in place; localCharacters is read-only.
 */
export function restoreChatShapeAfterRebase(
    mergedCharacters: { chaId?: string; chats?: ChatOrStub[] }[],
    localCharacters: { chaId?: string; chats?: ChatOrStub[] }[],
): void {
    const localByChaId = new Map<string, { chaId?: string; chats?: ChatOrStub[] }>()
    for (const char of localCharacters ?? []) {
        if (char?.chaId) localByChaId.set(char.chaId, char)
    }
    for (const char of mergedCharacters ?? []) {
        if (!char || !Array.isArray(char.chats)) continue
        char.chats = convertStubsToPlaceholders(char.chats)
        // Before local chats are grafted in: whatever is a full chat here came
        // from the server.
        noteInlineChats([char])
        const localChar = char.chaId ? localByChaId.get(char.chaId) : undefined
        if (!localChar || !Array.isArray(localChar.chats)) continue
        for (let i = 0; i < char.chats.length; i++) {
            const slot = char.chats[i] as Chat | undefined
            if (!slot || slot._placeholder !== true || !slot.id) continue
            const localFull = localChar.chats.find((c) =>
                c
                && (c as Chat).id === slot.id
                && (c as Chat)._placeholder !== true
                && (c as any)._stub !== true
                && Array.isArray((c as Chat).message))
            if (localFull) {
                const hydratedChat = localFull as Chat
                hydratedChat.isStreaming = false
                char.chats[i] = hydratedChat
            }
        }
    }
}

// Classify a chat slot by shape. Used by the chat-data guard's diagnostic
// dump to surface hybrid corruption (the `_stub: true` + message pattern that
// caused widespread chat data loss in v1.4.x).
export type ChatShape = 'stub' | 'placeholder' | 'hybrid' | 'full' | 'empty' | 'neither'

export function classifyChat(c: any): ChatShape {
    if (!c) return 'empty'
    const isStub = c._stub === true
    const isPh = c._placeholder === true
    const hasMessage = Array.isArray(c.message)
    if (isStub && hasMessage) return 'hybrid'
    if (isStub) return 'stub'
    if (isPh) return 'placeholder'
    if (hasMessage) return 'full'
    return 'neither'
}

// ── Hydration state ──────────────────────────────────────────────────────────

function chatKey(chaId: string, chatId: string): string {
    return `${chaId}/${chatId}`
}

/** Hydration in progress — suppress dirty tracking */
export const hydrationInFlight = new Set<string>()

/** Hydration just applied to memory — suppress until next tick */
export const hydrationJustApplied = new Set<string>()

/** Track in-flight hydration promises to avoid duplicate fetches */
const hydrationPromises = new Map<string, Promise<Chat | null>>()

// ── Server fetch/save ───────────────────────────────────────────────────────

export async function fetchChatFromServer(chaId: string, chatIndex: number, chatId: string): Promise<Chat | null> {
    const storage = forageStorage.realStorage
    return storage.fetchChatContent(chaId, chatIndex, chatId)
}

// Opening and saving go through delta sync (chatDeltaSync.ts): only what
// changed crosses the wire for long chats. Exports and backups keep using
// fetchChatFromServer above, which always transfers the whole chat.
const chatDeltaSync = createChatDeltaSync({
    enqueueChatSave: (chaId, chatId, save) => forageStorage.realStorage.enqueueChatSave(chaId, chatId, save),
    fetchChatContentDelta: (chaId, chatIndex, chatId, base, baseRev) => forageStorage.realStorage.fetchChatContentDelta(chaId, chatIndex, chatId, base, baseRev),
    saveChatContentDelta: (chaId, chatIndex, chatId, chat, base) => forageStorage.realStorage.saveChatContentDeltaUnqueued(chaId, chatIndex, chatId, chat, base),
    postChatContent: (chaId, chatIndex, chatId, chat, options) => forageStorage.realStorage.postChatContent(chaId, chatIndex, chatId, chat, options),
}, indexedDbChatCopies)

// ── Sync between tabs (chatSync.ts) ──────────────────────────────────────────

/**
 * What chat sync needs from the running app: the live database, the
 * generation registry and the notices. Set once at boot (chatSyncHost.ts).
 * Until then (and in unit tests of this module) saves still carry their
 * revision; a conflict that would need live state is left for the next save.
 */
export interface ChatSyncHost {
    findLive(chaId: string, chatId: string): LiveChat | null
    isGenerating(chatId: string): boolean
    snapshot(chat: Chat): Chat
    forkName(name: string): string
    notifyForked(name: string): void
    trackCharacter(chaId: string): void
    contentReplaced(chaId: string, chatId: string): void
}

let chatSyncHost: ChatSyncHost = {
    findLive: () => null,
    isGenerating: () => false,
    snapshot: (chat) => structuredClone(chat),
    forkName: (name) => name,
    notifyForked: () => {},
    trackCharacter: () => {},
    contentReplaced: () => {},
}

export function configureChatSyncHost(host: ChatSyncHost): void {
    chatSyncHost = host
}

const chatSync = createChatSync({
    enqueue: (chaId, chatId, run) => forageStorage.realStorage.enqueueChatSave(chaId, chatId, run),
    fetchChat: (chaId, chatIndex, chatId, baseRev) => chatDeltaSync.fetchChatRev(chaId, chatIndex, chatId, baseRev),
    postChat: (chaId, chatIndex, chatId, chat, options) => chatDeltaSync.postChat(chaId, chatIndex, chatId, chat, options),
    findLive: (chaId, chatId) => chatSyncHost.findLive(chaId, chatId),
    isGenerating: (chatId) => chatSyncHost.isGenerating(chatId),
    snapshot: (chat) => chatSyncHost.snapshot(chat),
    placeholderOf: (chat) => stubToPlaceholder(chatToStub(chat)),
    newId: () => v4(),
    forkName: (name) => chatSyncHost.forkName(name),
    notifyForked: (name) => chatSyncHost.notifyForked(name),
    trackCharacter: (chaId) => chatSyncHost.trackCharacter(chaId),
    contentReplaced: (chaId, chatId) => chatSyncHost.contentReplaced(chaId, chatId),
    schedule: (run, delayMs) => { setTimeout(run, delayMs) },
})

export async function saveChatToServer(chaId: string, chatIndex: number, chatId: string, chat: Chat): Promise<void> {
    await chatSync.save(chaId, chatIndex, chatId, chat, { strict: false })
}

export async function saveChatToServerStrict(
    chaId: string,
    chatIndex: number,
    chatId: string,
    chat: Chat,
): Promise<DurableChatSaveResult> {
    await forageStorage.Init()
    const durable = await chatSync.save(chaId, chatIndex, chatId, chat, { strict: true })
    if (!durable) throw new ChatSyncError('no durable acknowledgement')
    return durable
}

/**
 * Bring a loaded chat up to date with what another tab or device saved.
 * Never throws and never fails anything: on any problem the chat stays as it is.
 */
export function refreshChatFromServer(chaId: string, chatId: string): Promise<RefreshResult> {
    return chatSync.refresh(chaId, chatId)
}

/** The set of running generations changed (a fork waiting for one may finish). */
export function chatGenerationsChanged(): void {
    chatSync.generationsChanged()
}

/**
 * Chats that arrived with their content inside the database instead of as
 * stubs: their content is the server's, at a revision this tab does not know.
 */
export function noteInlineChats(characters: { chaId?: string; chats?: ChatOrStub[] }[]): void {
    for (const char of characters ?? []) {
        if (!char?.chaId || !Array.isArray(char.chats)) continue
        for (const chat of char.chats) {
            const full = chat as Chat | undefined
            if (!full?.id || full._placeholder === true || (full as any)._stub === true || !Array.isArray(full.message)) continue
            chatSync.noteInlineContent(char.chaId, full.id, full)
        }
    }
}

/**
 * A plugin reads a chat that is not loaded in this tab. The copy is handed
 * out without entering the app; what it was read at is kept for the plugin's
 * own write-back only (savePluginChat).
 */
export async function fetchChatForPlugin(chaId: string, chatIndex: number, chatId: string): Promise<Chat | null> {
    const result = await forageStorage.realStorage.fetchChatContentWithRevision(chaId, chatIndex, chatId)
    if (!result) return null
    chatSync.notePluginRead(chaId, chatId, result.chat, result.revision)
    return result.chat
}

/**
 * Save a chat a plugin put into a slot that is not the open chat.
 * `wasLoaded`: the slot held a loaded chat before the plugin replaced it; then
 * this tab's own sync state is the base. Otherwise the base is the plugin's
 * last read, and a chat it never read is replaced outright.
 */
export async function savePluginChat(chaId: string, chatIndex: number, chatId: string, chat: Chat, wasLoaded: boolean): Promise<void> {
    const hasBase = wasLoaded || chatSync.adoptPluginRead(chaId, chatId)
    await chatSync.save(chaId, chatIndex, chatId, chat, { strict: false, replace: !hasBase })
}

// ── Hydration ───────────────────────────────────────────────────────────────

/**
 * Check if a specific chat is currently being hydrated (for dirty tracking suppression).
 */
export function isHydrating(chaId: string, chatId: string): boolean {
    const key = chatKey(chaId, chatId)
    return hydrationInFlight.has(key) || hydrationJustApplied.has(key)
}

/**
 * Chats whose last hydration failed, keyed `chaId/chatId`: 'missing' when the
 * server holds no body (404), 'error' for any other failure. The chat screen
 * shows this instead of "loading" forever. A missing body is left as a
 * placeholder, never replaced by an empty chat: an empty save could overwrite
 * messages another device or a backup still holds.
 */
export type ChatLoadFailure = 'missing' | 'error'
export const chatLoadFailures = writable<ReadonlyMap<string, ChatLoadFailure>>(new Map())

function setChatLoadFailure(key: string, failure: ChatLoadFailure | null): void {
    chatLoadFailures.update(failures => {
        if ((failures.get(key) ?? null) === failure) return failures
        const next = new Map(failures)
        if (failure) next.set(key, failure)
        else next.delete(key)
        return next
    })
}

/**
 * Hydrate a placeholder Chat in-place on the character's chats array.
 * If the slot is already a real Chat (not placeholder), returns it as-is.
 * Returns the hydrated Chat, or null if fetch failed.
 */
export async function ensureChatHydrated(
    chats: Chat[],
    index: number,
    chaId: string,
): Promise<Chat | null> {
    const slot = chats[index]
    if (!slot) return null
    if (!slot._placeholder) return slot

    const chatId = slot.id
    if (!chatId) return null
    const key = chatKey(chaId, chatId)

    // Deduplicate concurrent hydration for the same chat
    const existing = hydrationPromises.get(key)
    if (existing) return existing

    const promise = (async () => {
        hydrationInFlight.add(key)
        setChatLoadFailure(key, null)
        try {
            let full: Chat | null
            let revision: string | null = null
            try {
                const fetched = await chatDeltaSync.fetchChatRev(chaId, index, chatId)
                full = fetched.kind === 'ok' ? fetched.chat : null
                if (fetched.kind === 'ok') revision = fetched.revision
            } catch (error) {
                setChatLoadFailure(key, 'error')
                throw error
            }
            if (!full) {
                console.error(`[chatStorage] hydrate failed: chat not found on server (${key})`)
                setChatLoadFailure(key, 'missing')
                return null
            }

            // Clear stale streaming flags: if the app died mid-stream after a
            // save, the server copy can carry isStreaming=true forever.
            // (setDatabase does the same for chats present at boot.)
            full.isStreaming = false

            const currentIndex = chats.findIndex(chat => chat?.id === chatId)
            if (currentIndex === -1) {
                console.warn(`[chatStorage] hydrate skipped: chat removed before apply (${key})`)
                return null
            }

            const currentSlot = chats[currentIndex]
            if (!currentSlot?._placeholder) {
                return currentSlot
            }

            // Yield one frame so loading overlay dismissal paints before heavy DOM work
            await new Promise<void>(r => requestAnimationFrame(() => r()))

            // Apply to memory — mark JustApplied to suppress the reactive write-back
            hydrationJustApplied.add(key)
            chatSync.noteServerContent(chaId, chatId, full, revision)
            chats[currentIndex] = full

            // Wait one tick so Svelte reactivity settles before allowing dirty tracking
            await tick()
            hydrationJustApplied.delete(key)

            return full
        } finally {
            hydrationInFlight.delete(key)
            hydrationPromises.delete(key)
        }
    })()

    hydrationPromises.set(key, promise)
    return promise
}

/**
 * Convenience: ensure the current active chat for a character is hydrated.
 */
export async function ensureCurrentChatReady(
    chats: Chat[],
    chatPage: number,
    chaId: string,
): Promise<Chat | null> {
    return ensureChatHydrated(chats, chatPage, chaId)
}
