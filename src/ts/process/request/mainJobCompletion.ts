import type { Chat } from 'src/ts/storage/database.svelte'
import { saveChatToServerStrict } from 'src/ts/storage/chatStorage'
import type { JobClaimHandle } from './jobFetch'
import { clearPendingSend } from './pendingSends'

export interface MainJobCompletionContext {
    generationId: string
    chatId: string
    handles: JobClaimHandle[]
    locate: () => { chaId: string, chatIndex: number, chat: Chat } | undefined
}

export async function prepareMainJobContinuation(context: MainJobCompletionContext): Promise<void> {
    const target = context.locate()
    const message = target?.chat.message.find((m) => m.generationInfo?.generationId === context.generationId)
    if (!target || !message) throw new Error('Continuation message is unavailable')
    message.generationInfo.completed = false
    message.generationInfo.continuePrefix = message.data
    // The target slot and prefix must survive a crash even before the first
    // streamed partial save, otherwise the new generation looks like an insert.
    await saveChatToServerStrict(target.chaId, target.chatIndex, context.chatId, target.chat)
}

/** One send owns these handles, including transport retries of that send. */
export function createMainJobCompletion(context: MainJobCompletionContext): () => Promise<boolean> {
    let completion: Promise<boolean> | undefined
    return () => completion ??= (async () => {
        const target = context.locate()
        const message = target?.chat.message.find((m) => m.generationInfo?.generationId === context.generationId)
        if (message?.generationInfo) {
            // Postprocessing completion applies to direct/fallback sends too.
            // Only a strict ACK proves durability when concluding recovery.
            message.generationInfo.completed = true
            delete message.generationInfo.continuePrefix
        }
        if (context.handles.length === 0) {
            return clearPendingSend(context.chatId, context.generationId)
        }
        if (!target || target.chat._placeholder || !message) return false
        try {
            await saveChatToServerStrict(target.chaId, target.chatIndex, context.chatId, target.chat)
        } catch {
            for (const handle of context.handles) {
                if (await handle.ownsClaim()) await handle.release()
            }
            return false
        }
        if (!await clearPendingSend(context.chatId, context.generationId)) return false
        const claims = await Promise.all(context.handles.map((handle) => handle.claim()))
        return claims.every(Boolean)
    })()
}
