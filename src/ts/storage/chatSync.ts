import type { Chat } from './database.svelte'
import type { ChatFetchResult, ChatSaveOptions, ChatSaveOutcome } from './chatDeltaSync'
import type { DurableChatSaveResult } from './nodeStorage'
import { chatFingerprints, sameFingerprintList } from './chatFingerprint'
import { reissueMessageIdsWithMap } from '../chatClone'

// Chat content sync between tabs and devices.
//
// The server replaces a stored chat only for a save that names the revision
// it holds (compare-and-swap, POST /api/chat-content). This module is the
// client half: it remembers, per chat, which server revision this tab's copy
// is built on, sends that with every save, and settles a refused save without
// dropping anything:
//
//   - the server still holds what this tab last synced (or one of this tab's
//     own earlier attempts whose answer was lost) -> save again on top of it;
//   - the server already holds exactly this content   -> nothing to send;
//   - this tab has no changes of its own              -> take the server's copy;
//   - both changed                                    -> this tab's version
//     is saved as a separate chat (a fork) and the original takes the
//     server's copy. Nothing is merged.
//
// While a generation is writing into the chat, live state is left alone (the
// send pipeline addresses messages by index): the fork then only exists on the
// server ("diverted" saves) and the swap in this tab happens once the
// generation is over.
//
// Everything that reads or changes a chat's sync state runs in that chat's
// save queue, so saves, refreshes and conflict handling never interleave.

export interface LiveChat {
    /** The character's live chat list. */
    chats: Chat[]
    index: number
    chat: Chat
    /** Whether this is the chat the character has open. */
    isOpen: boolean
    /** Make the chat at `index` the one the character has open. */
    open(index: number): void
}

export interface ChatSyncEnv {
    enqueue<T>(chaId: string, chatId: string, run: () => Promise<T>): Promise<T>
    fetchChat(chaId: string, chatIndex: number, chatId: string, baseRev?: string | null): Promise<ChatFetchResult>
    postChat(chaId: string, chatIndex: number, chatId: string, chat: Chat, options: ChatSaveOptions): Promise<ChatSaveOutcome>
    /** The chat in live state, by ids. Null when the character or chat is not listed. */
    findLive(chaId: string, chatId: string): LiveChat | null
    /** A generation (live or background) is registered in this tab for the chat. */
    isGenerating(chatId: string): boolean
    /** A plain deep copy of a live chat. */
    snapshot(chat: Chat): Chat
    /** A placeholder for a chat whose content has to be loaded from the server again. */
    placeholderOf(chat: Chat): Chat
    newId(): string
    forkName(name: string): string
    notifyForked(name: string): void
    /** Include the character in the next database save (its chat list changed). */
    trackCharacter(chaId: string): void
    /**
     * Runs `replace`, which puts server content into a live chat. The host
     * keeps this from being taken for an edit by the user (it must not start
     * a save).
     */
    replaceLive(chaId: string, chatId: string, replace: () => void): void
    /** Server content replaced the live content of a chat. */
    contentReplaced(chaId: string, chatId: string): void
    schedule(run: () => void, delayMs: number): void
    sleep(delayMs: number): Promise<void>
}

export class ChatSyncError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'ChatSyncError'
    }
}

export interface RefreshResult {
    /**
     * unchanged: the server holds what this tab holds (or the chat is not on the server yet).
     * updated:   server content replaced this tab's copy.
     * forked:    both sides had changed; this tab's version now lives in a new chat.
     * skipped:   not checked (chat not loaded here, or a generation is running).
     */
    status: 'unchanged' | 'updated' | 'forked' | 'skipped'
    /** The list of messages the user is looking at changed. */
    messagesChanged: boolean
    /** With 'forked': the id of the chat this tab's version went to, once it is in the chat list. */
    forkId?: string
}

interface SyncState {
    /** Server revision this tab's copy is built on. Null: not known. */
    rev: string | null
    /** Fingerprint of the content at that revision. Null: not known. */
    fp: string | null
    /** Fingerprints of saves sent since then whose answer never arrived. */
    pending: Set<string>
    /** Send on the next save even if the content equals `fp`. */
    resend?: boolean
}

interface Divert {
    chaId: string
    chatId: string
    targetId: string
    name: string
    /** Original message id -> id in the fork. Only grows. */
    idMap: Map<string, string>
    rev: string | null
    /** The server acknowledged at least one save of the fork. */
    posted: boolean
    /** Fingerprint of the original's content at the last acknowledged save. */
    lastFp: string | null
    /** Fingerprints of fork saves sent since the last acknowledged one. */
    attempts: Set<string>
    retryDelay: number
}

const NOT_OWNED = new Set(['id', 'name', 'lastDate', 'folderId', 'modules', 'isStreaming', '_placeholder', '_stub'])
const FINALISE_RETRY_MAX_MS = 60_000
const REPEATED_CONFLICT_PAUSE_MAX_MS = 30_000

function isRealChat(chat: Chat | null | undefined): chat is Chat {
    return !!chat && chat._placeholder !== true && (chat as { _stub?: boolean })._stub !== true && Array.isArray(chat.message)
}

/** Replace what a chat-content save owns in `target` with `source`'s, in place. */
export function replaceOwnedContent(target: Chat, source: Chat): void {
    const to = target as unknown as Record<string, unknown>
    const from = source as unknown as Record<string, unknown>
    for (const key of Object.keys(to)) {
        if (!NOT_OWNED.has(key) && !(key in from)) delete to[key]
    }
    for (const key of Object.keys(from)) {
        if (!NOT_OWNED.has(key)) to[key] = from[key]
    }
}

export function createChatSync(env: ChatSyncEnv) {
    const states = new Map<string, SyncState>()
    const diverts = new Map<string, Divert>()
    const pluginReads = new Map<string, { rev: string | null, fp: string }>()
    const refreshes = new Map<string, Promise<RefreshResult>>()
    /** Per chat: the id its last completed fork went to. */
    const lastForkIds = new Map<string, string>()

    const keyOf = (chaId: string, chatId: string) => `${chaId}|${chatId}`

    function setSynced(key: string, rev: string | null, fp: string | null) {
        states.set(key, { rev, fp, pending: new Set() })
    }

    function ensureMessageIds(chat: Chat) {
        for (const message of chat.message) {
            if (message && !message.chatId) message.chatId = env.newId()
        }
    }

    function hydratedLive(chaId: string, chatId: string): LiveChat | null {
        const live = env.findLive(chaId, chatId)
        return live && isRealChat(live.chat) ? live : null
    }

    function newDivert(chaId: string, chatId: string, name: string): Divert {
        return {
            chaId,
            chatId,
            targetId: env.newId(),
            name: env.forkName(name),
            idMap: new Map(),
            rev: null,
            posted: false,
            lastFp: null,
            attempts: new Set(),
            retryDelay: 0,
        }
    }

    function buildFork(chat: Chat, divert: Divert): Chat {
        const copy = env.snapshot(chat)
        copy.id = divert.targetId
        copy.name = divert.name
        copy.isStreaming = false
        delete copy._placeholder
        return reissueMessageIdsWithMap(copy, divert.idMap)
    }

    // ── Server content into live state ──────────────────────────────────────

    function applyServerContent(chaId: string, chatId: string, live: LiveChat, server: Chat, revision: string | null, fp: string) {
        env.replaceLive(chaId, chatId, () => replaceOwnedContent(live.chat, server))
        setSynced(keyOf(chaId, chatId), revision, fp)
        env.contentReplaced(chaId, chatId)
    }

    // ── Saving ──────────────────────────────────────────────────────────────

    async function saveNow(
        chaId: string, chatIndex: number, chatId: string, passed: Chat,
        options: { strict: boolean, replace?: boolean },
    ): Promise<DurableChatSaveResult | undefined> {
        const key = keyOf(chaId, chatId)
        const strict = options.strict
        let lastConflict: string | null | undefined
        let pause = 0
        for (;;) {
            const live = hydratedLive(chaId, chatId)
            const content = live ? live.chat : passed
            if (!isRealChat(content)) {
                if (strict) throw new ChatSyncError(`chat ${chatId} is not loaded`)
                return undefined
            }
            const index = live ? live.index : chatIndex

            if (live && diverts.has(key)) return saveDiverted(chaId, chatId, strict)

            ensureMessageIds(content)
            const fps = chatFingerprints(content)
            const state = states.get(key) ?? { rev: null, fp: null, pending: new Set<string>() }
            if (!strict && !state.resend && state.fp === fps.content) return undefined
            state.pending.add(fps.content)
            states.set(key, state)

            // `content` is live and may change while the request is under way.
            // The body is encoded at the call, so `fps` describes what is
            // sent; a second request (the whole chat after a refused delta
            // prefix) is therefore not made from in there but by going round
            // again, with fingerprints taken anew.
            const outcome = await env.postChat(chaId, index, chatId, content, {
                baseRev: state.rev,
                strict,
                fingerprints: fps.messages,
                fullOnMismatch: false,
            })
            if (outcome.status === 'base-mismatch') continue
            if (outcome.status === 'ok') {
                setSynced(key, outcome.revision, fps.content)
                if (strict && !outcome.durable) throw new ChatSyncError('no durable acknowledgement')
                return outcome.durable
            }

            // Without the revision the server holds there is nothing to
            // settle the refusal with.
            if (outcome.revision === null) {
                throw new ChatSyncError(`chat ${chatId}: the server refused the save without naming its revision`)
            }
            // The same refusal for the same base twice in a row: another
            // writer is flipping the chat between two contents exactly in
            // step with this save. Keep going, but not in a tight loop.
            const conflictMark = `${state.rev ?? ''}>${outcome.revision}`
            if (conflictMark === lastConflict) {
                pause = Math.min(pause > 0 ? pause * 2 : 250, REPEATED_CONFLICT_PAUSE_MAX_MS)
                console.warn(`[chatSync] chat ${chatId}: the same save conflict again, trying again in ${pause} ms`)
                await env.sleep(pause)
            } else {
                pause = 0
            }
            lastConflict = conflictMark

            const next = await resolveConflict(chaId, chatIndex, chatId, passed, options)
            if (next !== 'again') return next.durable
        }
    }

    // Decides what a refused save means. Returns 'again' when the save should
    // simply be sent again (the sync state was corrected), or the result of
    // whatever settled it.
    async function resolveConflict(
        chaId: string, chatIndex: number, chatId: string, passed: Chat,
        options: { strict: boolean, replace?: boolean },
    ): Promise<'again' | { durable: DurableChatSaveResult | undefined }> {
        const key = keyOf(chaId, chatId)
        const strict = options.strict
        const before = env.findLive(chaId, chatId)
        const fetched = await env.fetchChat(chaId, before ? before.index : chatIndex, chatId)
        if (fetched.kind !== 'ok') {
            // The server no longer holds the chat: there is no revision to build on.
            setSynced(key, null, null)
            return 'again'
        }
        const server = fetched.chat
        const serverFp = chatFingerprints(server).content
        const state = states.get(key)

        // The server holds what this tab last synced, or a save of this tab
        // whose answer was lost: nobody else wrote.
        if ((state?.fp && serverFp === state.fp) || state?.pending.has(serverFp)) {
            setSynced(key, fetched.revision, serverFp)
            return 'again'
        }

        const live = hydratedLive(chaId, chatId)
        const content = live ? live.chat : passed
        const localFp = chatFingerprints(content).content

        // The server already holds this content.
        if (serverFp === localFp) {
            setSynced(key, fetched.revision, serverFp)
            return strict ? 'again' : { durable: undefined }
        }

        // A caller that replaces a chat this tab never loaded (a plugin
        // writing a whole chat) means to overwrite it.
        if (options.replace && !state?.fp) {
            states.set(key, { rev: fetched.revision, fp: null, pending: state?.pending ?? new Set() })
            return 'again'
        }

        if (!live) {
            // Not listed or not loaded here any more: there is no live chat to
            // update and nothing to fork from.
            if (strict) throw new ChatSyncError(`chat ${chatId} changed on the server and is not loaded here`)
            return { durable: undefined }
        }

        const ownChanges = !(state?.fp && localFp === state.fp)
        if (env.isGenerating(chatId)) {
            // Live state stays as it is until the generation is over.
            diverts.set(key, newDivert(chaId, chatId, live.chat.name))
            return 'again'
        }
        if (!ownChanges) {
            applyServerContent(chaId, chatId, live, server, fetched.revision, serverFp)
            return strict ? 'again' : { durable: undefined }
        }
        return { durable: await forkNow(chaId, chatId, { chat: server, revision: fetched.revision }, strict, live.chat.name) }
    }

    // Fork right away. The fork's id is registered first and stays registered
    // if this attempt fails, so a save that reached the server but whose
    // answer was lost is recognised on the next attempt instead of being
    // repeated under a second id.
    async function forkNow(
        chaId: string, chatId: string,
        server: { chat: Chat, revision: string | null },
        strict: boolean, name: string,
    ): Promise<DurableChatSaveResult | undefined> {
        const key = keyOf(chaId, chatId)
        const divert = diverts.get(key) ?? newDivert(chaId, chatId, name)
        diverts.set(key, divert)
        try {
            return await fork(chaId, chatId, server, strict, divert)
        } catch (error) {
            scheduleFinalise(chaId, chatId, 1000)
            throw error
        }
    }

    // A fork save was refused: someone else wrote to the fork's id. If it is
    // this tab's own earlier attempt, build on it; otherwise use a new id.
    async function divertAfterConflict(chaId: string, chatId: string, divert: Divert, name: string): Promise<Divert> {
        try {
            const fetched = await env.fetchChat(chaId, 0, divert.targetId)
            if (fetched.kind === 'ok' && divert.attempts.has(chatFingerprints(fetched.chat).content)) {
                divert.rev = fetched.revision
                divert.posted = true
                divert.attempts.clear()
                return divert
            }
        } catch {
            // fall through: a new id always works
        }
        const fresh = newDivert(chaId, chatId, name)
        fresh.name = divert.name
        if (diverts.get(keyOf(chaId, chatId)) === divert) diverts.set(keyOf(chaId, chatId), fresh)
        return fresh
    }

    async function postFork(chaId: string, chatId: string, live: LiveChat, divert: Divert, strict: boolean): Promise<{ divert: Divert, outcome: Extract<ChatSaveOutcome, { status: 'ok' }>, forkChat: Chat, sourceFp: string }> {
        for (;;) {
            ensureMessageIds(live.chat)
            const sourceFp = chatFingerprints(live.chat).content
            const forkChat = buildFork(live.chat, divert)
            if (!strict && divert.posted && divert.lastFp === sourceFp) {
                // The server already holds the fork of exactly this content.
                return { divert, outcome: { status: 'ok', revision: divert.rev }, forkChat, sourceFp }
            }
            divert.attempts.add(chatFingerprints(forkChat).content)
            const outcome = await env.postChat(chaId, live.chats.length, divert.targetId, forkChat, {
                baseRev: divert.rev,
                forkOf: divert.posted ? undefined : chatId,
                strict,
            })
            if (outcome.status === 'ok') {
                if (strict && !outcome.durable) throw new ChatSyncError('no durable acknowledgement')
                divert.rev = outcome.revision
                divert.posted = true
                divert.lastFp = sourceFp
                divert.attempts.clear()
                return { divert, outcome, forkChat, sourceFp }
            }
            // (forkChat is a copy, so a refused delta prefix is followed by
            // the whole chat inside postChat; 'base-mismatch' does not occur.)
            divert = await divertAfterConflict(chaId, chatId, divert, live.chat.name)
            const again = hydratedLive(chaId, chatId)
            if (!again) throw new ChatSyncError(`chat ${chatId} is no longer loaded`)
            live = again
        }
    }

    // Saves of a chat whose fork is not in live state yet go to the fork.
    async function saveDiverted(chaId: string, chatId: string, strict: boolean): Promise<DurableChatSaveResult | undefined> {
        const key = keyOf(chaId, chatId)
        const live = hydratedLive(chaId, chatId)
        const divert = diverts.get(key)
        if (!live || !divert) throw new ChatSyncError(`chat ${chatId} is no longer loaded`)
        if (!strict && divert.posted && divert.lastFp === chatFingerprints(live.chat).content) {
            scheduleFinalise(chaId, chatId, 0)
            return undefined
        }
        const posted = await postFork(chaId, chatId, live, divert, strict)
        scheduleFinalise(chaId, chatId, 0)
        return posted.outcome.durable
    }

    // This tab's version of `chatId` becomes a separate chat and the original
    // takes the server's copy. `server` is what the server holds for the
    // original when the caller already has it.
    async function fork(
        chaId: string, chatId: string,
        server: { chat: Chat, revision: string | null } | null,
        strict: boolean, divert: Divert,
    ): Promise<DurableChatSaveResult | undefined> {
        const key = keyOf(chaId, chatId)
        let durable: DurableChatSaveResult | undefined
        // The fork may already be open here (it is listed on the server, so a
        // database rebase can bring it in). With changes of its own in it,
        // this pass's content needs an id of its own, decided before anything
        // is posted so the content does not land under two ids.
        const forkSlotChanged = (chats: Chat[]): boolean => {
            const slot = chats.find((chat) => chat?.id === divert.targetId)
            if (!isRealChat(slot)) return false
            const state = states.get(keyOf(chaId, divert.targetId))
            return !state?.fp || chatFingerprints(slot).content !== state.fp
        }
        const freshTarget = (name: string) => {
            const fresh = newDivert(chaId, chatId, name)
            if (diverts.get(key) === divert) diverts.set(key, fresh)
            divert = fresh
        }
        for (;;) {
            const live = hydratedLive(chaId, chatId)
            if (!live) throw new ChatSyncError(`chat ${chatId} is no longer loaded`)
            if (forkSlotChanged(live.chats)) freshTarget(live.chat.name)
            const posted = await postFork(chaId, chatId, live, divert, strict)
            divert = posted.divert
            durable = posted.outcome.durable ?? durable

            let original: { chat: Chat, revision: string | null } | null = server
            if (!original) {
                try {
                    const fetched = await env.fetchChat(chaId, live.index, chatId)
                    if (fetched.kind === 'ok') original = { chat: fetched.chat, revision: fetched.revision }
                } catch {
                    original = null
                }
            }

            // From here to the end of the pass nothing awaits: what is checked
            // is what gets replaced.
            const now = hydratedLive(chaId, chatId)
            if (!now) throw new ChatSyncError(`chat ${chatId} is no longer loaded`)
            if (env.isGenerating(chatId)) {
                // A generation started meanwhile; swap when it is over.
                diverts.set(key, divert)
                return durable
            }
            if (chatFingerprints(now.chat).content !== posted.sourceFp) continue

            const forkKey = keyOf(chaId, divert.targetId)
            const forkChat = posted.forkChat
            const forkFp = chatFingerprints(forkChat).content
            let forkIndex = now.chats.findIndex((chat) => chat?.id === divert.targetId)
            if (forkSlotChanged(now.chats)) {
                // Changed in the fork while this pass was posting.
                freshTarget(now.chat.name)
                continue
            }
            if (forkIndex === -1) {
                now.chats.push(forkChat)
                forkIndex = now.chats.length - 1
            } else {
                now.chats[forkIndex] = forkChat
            }
            setSynced(forkKey, divert.rev, forkFp)

            // Open the fork first: what replaces the original below must not
            // be taken for the chat the user is in.
            if (now.isOpen) now.open(forkIndex)
            if (original) {
                applyServerContent(chaId, chatId, now, original.chat, original.revision, chatFingerprints(original.chat).content)
            } else {
                now.chats[now.index] = env.placeholderOf(now.chat)
                states.delete(key)
            }
            diverts.delete(key)
            lastForkIds.set(key, divert.targetId)
            env.trackCharacter(chaId)
            env.notifyForked(divert.name)
            return durable
        }
    }

    // ── Diverted chats: swap once no generation is running ──────────────────

    function scheduleFinalise(chaId: string, chatId: string, delayMs: number) {
        env.schedule(() => { void finalise(chaId, chatId) }, delayMs)
    }

    async function finalise(chaId: string, chatId: string) {
        const key = keyOf(chaId, chatId)
        if (!diverts.has(key) || env.isGenerating(chatId)) return
        try {
            await env.enqueue(chaId, chatId, async () => {
                const divert = diverts.get(key)
                if (!divert || env.isGenerating(chatId)) return
                if (!hydratedLive(chaId, chatId)) {
                    diverts.delete(key)
                    return
                }
                await fork(chaId, chatId, null, false, divert)
            })
        } catch (error) {
            const divert = diverts.get(key)
            if (!divert) return
            console.warn(`[chatSync] could not finish the fork of ${chatId}, trying again:`, error)
            divert.retryDelay = Math.min(divert.retryDelay > 0 ? divert.retryDelay * 2 : 1000, FINALISE_RETRY_MAX_MS)
            scheduleFinalise(chaId, chatId, divert.retryDelay)
        }
    }

    /** Call when the set of running generations changed. */
    function generationsChanged() {
        for (const divert of diverts.values()) {
            if (!env.isGenerating(divert.chatId)) scheduleFinalise(divert.chaId, divert.chatId, 0)
        }
    }

    // ── Refresh ─────────────────────────────────────────────────────────────

    async function refreshNow(chaId: string, chatId: string): Promise<RefreshResult> {
        const key = keyOf(chaId, chatId)
        const skipped: RefreshResult = { status: 'skipped', messagesChanged: false }
        const unchanged: RefreshResult = { status: 'unchanged', messagesChanged: false }
        const live = hydratedLive(chaId, chatId)
        if (!live || env.isGenerating(chatId) || diverts.has(key)) return skipped

        const fetched = await env.fetchChat(chaId, live.index, chatId, states.get(key)?.rev ?? null)
        if (fetched.kind !== 'ok') return unchanged
        const server = fetched.chat
        const serverFps = chatFingerprints(server)

        // Nothing awaits between these checks and the replacement.
        const now = hydratedLive(chaId, chatId)
        if (!now || env.isGenerating(chatId) || diverts.has(key)) return skipped
        const state = states.get(key)
        const localFps = chatFingerprints(now.chat)
        if (serverFps.content === localFps.content) {
            setSynced(key, fetched.revision, serverFps.content)
            return unchanged
        }
        if (state?.fp && localFps.content === state.fp) {
            const messagesChanged = !sameFingerprintList(serverFps.bare, localFps.bare)
            applyServerContent(chaId, chatId, now, server, fetched.revision, serverFps.content)
            return { status: 'updated', messagesChanged }
        }
        if ((state?.fp && serverFps.content === state.fp) || state?.pending.has(serverFps.content)) {
            // Only this tab changed; its save follows on its own.
            setSynced(key, fetched.revision, serverFps.content)
            return unchanged
        }
        await forkNow(chaId, chatId, { chat: server, revision: fetched.revision }, false, now.chat.name)
        // Set when the fork is in the chat list; a generation that started
        // meanwhile leaves the swap for later and this tab on the original.
        return { status: 'forked', messagesChanged: false, forkId: diverts.has(key) ? undefined : lastForkIds.get(key) }
    }

    return {
        /**
         * Save a chat. Resolves when the server holds this tab's content for
         * it (possibly under a fork). With `strict`, resolves only on a
         * durable acknowledgement of a save made by this call.
         * `replace`: the content is meant to replace a chat this tab never loaded.
         */
        save(
            chaId: string, chatIndex: number, chatId: string, chat: Chat,
            options: { strict: boolean, replace?: boolean },
        ): Promise<DurableChatSaveResult | undefined> {
            return env.enqueue(chaId, chatId, () => saveNow(chaId, chatIndex, chatId, chat, options))
        },

        /**
         * Bring a loaded chat up to date with the server. Never throws: a
         * failed check leaves the chat as it is. Concurrent calls share one check.
         */
        refresh(chaId: string, chatId: string): Promise<RefreshResult> {
            const key = keyOf(chaId, chatId)
            const running = refreshes.get(key)
            if (running) return running
            // Inside an async function: a host that cannot queue yet (storage
            // not initialised) must not make this throw either.
            const run = (async () => env.enqueue(chaId, chatId, () => refreshNow(chaId, chatId)))()
                .catch((error): RefreshResult => {
                    console.warn(`[chatSync] refresh of ${chatId} failed:`, error)
                    return { status: 'skipped', messagesChanged: false }
                })
                .finally(() => { if (refreshes.get(key) === run) refreshes.delete(key) })
            refreshes.set(key, run)
            return run
        },

        /** Live content of the chat was set from server content at `revision`. */
        noteServerContent(chaId: string, chatId: string, chat: Chat, revision: string | null) {
            setSynced(keyOf(chaId, chatId), revision, chatFingerprints(chat).content)
        },

        /** A chat that arrived with its content inside the database: known content, unknown revision. */
        noteInlineContent(chaId: string, chatId: string, chat: Chat) {
            const key = keyOf(chaId, chatId)
            if (!states.has(key) && isRealChat(chat)) setSynced(key, null, chatFingerprints(chat).content)
        },

        /** A plugin read a chat that is not loaded here; only adoptPluginRead uses this. */
        notePluginRead(chaId: string, chatId: string, chat: Chat, revision: string | null) {
            pluginReads.set(keyOf(chaId, chatId), { rev: revision, fp: chatFingerprints(chat).content })
        },

        /**
         * A plugin is about to replace a chat that is not loaded here: its
         * write builds on what it last read. Returns false when it never read
         * it. Whatever this tab remembered of the chat from an earlier time
         * it was loaded is dropped either way.
         */
        adoptPluginRead(chaId: string, chatId: string): boolean {
            const key = keyOf(chaId, chatId)
            const read = pluginReads.get(key)
            pluginReads.delete(key)
            states.delete(key)
            if (!read) return false
            setSynced(key, read.rev, read.fp)
            return true
        },

        /**
         * The server may not hold this chat any more (it was removed from the
         * chat list elsewhere while this tab keeps it): the next save sends it
         * even if nothing changed here. What this tab last synced stays as the
         * base, so a body the server does still hold is not taken for someone
         * else's change.
         */
        resendOnNextSave(chaId: string, chatId: string) {
            const state = states.get(keyOf(chaId, chatId))
            if (state) state.resend = true
        },

        /** A plugin read that will not be used as a base any more. */
        dropPluginRead(chaId: string, chatId: string) {
            pluginReads.delete(keyOf(chaId, chatId))
        },

        generationsChanged,

        /** Whether this tab's copy differs from what it last synced (test and diagnostics aid). */
        isDirty(chaId: string, chatId: string): boolean {
            const live = hydratedLive(chaId, chatId)
            if (!live) return false
            return states.get(keyOf(chaId, chatId))?.fp !== chatFingerprints(live.chat).content
        },

        isDiverted(chaId: string, chatId: string): boolean {
            return diverts.has(keyOf(chaId, chatId))
        },
    }
}

export type ChatSync = ReturnType<typeof createChatSync>
