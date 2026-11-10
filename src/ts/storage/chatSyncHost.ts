import { get } from 'svelte/store'
import { language } from 'src/lang'
import { notifyInfo } from '../alert'
import { trackCharacterForSave } from '../globalApi.svelte'
import { safeStructuredClone } from '../polyfill'
import { chatGenKey, generationStates, isChatGenerating } from '../process/generationState'
import { selectedCharID } from '../stores.svelte'
import { getDatabase, loadTogglesFromChat } from './database.svelte'
import { chatGenerationsChanged, configureChatSyncHost, refreshChatFromServer } from './chatStorage'

// Connects chat sync (chatSync.ts, via chatStorage.ts) to the running app.

function openChatIds(): { chaId: string, chatId: string } | null {
    const char = getDatabase()?.characters?.[get(selectedCharID)]
    const chat = char?.chats?.[char.chatPage]
    if (!char?.chaId || !chat?.id || chat._placeholder) return null
    return { chaId: char.chaId, chatId: chat.id }
}

/** Check the chat on screen against the server (another tab may have saved it). */
export function refreshOpenChat(): void {
    const open = openChatIds()
    if (open) void refreshChatFromServer(open.chaId, open.chatId)
}

// A fork moved the chat on screen: `from` is the chat this tab was on, `to`
// the fork it is on now. Taken once by the chat screen, which keeps the text
// in the composer for the new chat (the composer is per chat).
let forkMove: { chaId: string, from: string, to: string } | null = null

export function takeForkMove(chaId: string, chatId: string): string | null {
    if (!forkMove || forkMove.chaId !== chaId || forkMove.to !== chatId) return null
    const from = forkMove.from
    forkMove = null
    return from
}

/** What the user asked for when a send-like action starts. */
export type SendKind = 'send' | 'continue' | 'reroll' | 'resend' | 'resume'

export interface SendGate {
    /** The action may go ahead. */
    run: boolean
    /** Not run because the message list changed under it (the user was told). */
    changed: boolean
    /** This tab's version went to a new chat, which is now the open one. */
    forked: boolean
}

/**
 * First step of every send-like action, before anything registers a
 * generation or touches the chat: bring the open chat up to date.
 *
 * A send with text simply goes out on the refreshed chat. Anything that acts
 * on the message the user was looking at (continue, reroll, resend, resume)
 * would hit a different message if the list changed, so it is dropped with a
 * notice and the user decides again on what is on screen now. A refresh that
 * fails changes nothing and never blocks.
 *
 * The action belongs to the chat it was started on: if the user opened another
 * chat while the refresh was under way, it does not run there. A fork is not
 * that: it moves this tab to the new chat, which is the same conversation.
 */
export async function refreshOpenChatBeforeSend(kind: SendKind): Promise<SendGate> {
    const open = openChatIds()
    if (!open) return { run: true, changed: false, forked: false }
    const result = await refreshChatFromServer(open.chaId, open.chatId)
    const expected = result.status === 'forked' && result.forkId ? result.forkId : open.chatId
    const now = openChatIds()
    if (!now || now.chaId !== open.chaId || now.chatId !== expected) return { run: false, changed: false, forked: false }
    if (kind !== 'send' && result.messagesChanged) {
        notifyInfo(language.chatRefreshedRetry)
        return { run: false, changed: true, forked: false }
    }
    return { run: true, changed: false, forked: expected !== open.chatId }
}

let started = false

export function initChatSyncHost(): void {
    if (started) return
    started = true

    configureChatSyncHost({
        findLive(chaId, chatId) {
            const char = getDatabase()?.characters?.find((c) => c?.chaId === chaId)
            if (!char || !Array.isArray(char.chats)) return null
            const index = char.chats.findIndex((c) => c?.id === chatId)
            if (index === -1) return null
            return {
                chats: char.chats,
                index,
                chat: char.chats[index],
                isOpen: char.chatPage === index,
                open: (next) => {
                    const from = char.chats[char.chatPage]?.id
                    const to = char.chats[next]?.id
                    const onScreen = getDatabase()?.characters?.[get(selectedCharID)] === char
                    if (onScreen && from && to && from !== to) forkMove = { chaId, from, to }
                    char.chatPage = next
                },
            }
        },
        isGenerating: (chatId) => isChatGenerating(chatGenKey(chatId)),
        snapshot: (chat) => safeStructuredClone(chat),
        // Function replacers: a chat name may contain `$`.
        forkName: (name) => language.chatForkName.replace('{}', () => name ?? ''),
        notifyForked: (name) => notifyInfo(language.chatForked.replace('{}', () => name)),
        trackCharacter: (chaId) => trackCharacterForSave(chaId),
        contentReplaced(chaId, chatId) {
            const char = getDatabase()?.characters?.[get(selectedCharID)]
            if (char?.chaId !== chaId) return
            const chat = char.chats?.[char.chatPage]
            if (chat?.id !== chatId) return
            // Same as opening the chat: its pinned toggles apply. Nothing of
            // the character is touched: that would be a change of this tab's
            // own and go out with the next database save.
            loadTogglesFromChat(chat)
        },
    })

    generationStates.subscribe(() => {
        chatGenerationsChanged()
        // A chat is not refreshed while it generates (a reattached server job
        // counts), so look again once the registry changed. In a new task: a
        // chained restart ends one entry and starts the next in the same one.
        setTimeout(refreshOpenChat, 0)
    })

    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') refreshOpenChat()
        })
    }
    if (typeof window !== 'undefined') {
        window.addEventListener('focus', () => refreshOpenChat())
    }
}
