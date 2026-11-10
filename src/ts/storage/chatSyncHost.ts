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

/** What the user asked for when a send-like action starts. */
export type SendKind = 'send' | 'continue' | 'reroll' | 'resend' | 'resume'

/**
 * First step of every send-like action, before anything registers a
 * generation or touches the chat: bring the open chat up to date.
 *
 * Returns false when the action must not run. A send with text simply goes
 * out on the refreshed chat. Anything that acts on the message the user was
 * looking at (continue, reroll, resend, resume) would hit a different message
 * if the list changed, so it is dropped with a notice and the user decides
 * again on what is on screen now. A refresh that fails changes nothing and
 * never blocks.
 */
export async function refreshOpenChatBeforeSend(kind: SendKind): Promise<boolean> {
    const open = openChatIds()
    if (!open) return true
    const result = await refreshChatFromServer(open.chaId, open.chatId)
    if (kind === 'send' || !result.messagesChanged) return true
    notifyInfo(language.chatRefreshedRetry)
    return false
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
                open: (next) => { char.chatPage = next },
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
            // Same as opening the chat: its pinned toggles apply, and views
            // that render outside the reactive graph redraw.
            loadTogglesFromChat(chat)
            char.reloadKeys = (char.reloadKeys ?? 0) + 1
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
