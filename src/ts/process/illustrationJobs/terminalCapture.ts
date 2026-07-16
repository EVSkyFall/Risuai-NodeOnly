import type { Chat, Message } from '../../storage/database.svelte'
import { v4 } from 'uuid'
import { isIllustrationFeatureEnabled } from './featureFlag'

export type IllustrationRootTurnOutcome = 'normal' | 'continuing' | 'aborted' | 'failed'

export type IllustrationRootTurnContext = {
    outcome: 'normal'
    chaId: string
    chat: Chat
    message: Message
    rootTurnId: string
} | {
    outcome: Exclude<IllustrationRootTurnOutcome, 'normal'>
    rootTurnId: string
}

const inFlightRootTurnIds = new Set<string>()
// Session-local fast path only: durable exactly-once rests on the ledger's
// requestKey idempotency, so bounding this set cannot cause duplicate work.
const DONE_ROOT_TURN_CAP = 256
const doneRootTurnIds = new Set<string>()

function rememberDoneRootTurn(rootTurnId: string): void {
    doneRootTurnIds.add(rootTurnId)
    if (doneRootTurnIds.size > DONE_ROOT_TURN_CAP) {
        const oldest = doneRootTurnIds.values().next().value
        if (oldest !== undefined) doneRootTurnIds.delete(oldest)
    }
}

export function finalizeIllustrationRootTurn(context: IllustrationRootTurnContext): void {
    if (context.outcome !== 'normal') return
    if (!context.rootTurnId || inFlightRootTurnIds.has(context.rootTurnId)
        || doneRootTurnIds.has(context.rootTurnId)) return

    const { chaId, chat, message, rootTurnId } = context
    const sourceVariantText = message.data

    void (async () => {
        try {
            if (!(await isIllustrationFeatureEnabled())) return
            if (inFlightRootTurnIds.has(rootTurnId) || doneRootTurnIds.has(rootTurnId)) return
            inFlightRootTurnIds.add(rootTurnId)
            try {
                const conversationId = chat.id ?? (chat.id = v4())
                const expectedMessageId = message.chatId ?? (message.chatId = v4())
                const { registerTrustedTurn } = await import('./coordinator')
                await registerTrustedTurn({
                    chaId,
                    conversationId,
                    expectedMessageId,
                    rootTurnId,
                    sourceVariantText,
                })
                rememberDoneRootTurn(rootTurnId)
            } finally {
                inFlightRootTurnIds.delete(rootTurnId)
            }
        } catch {
            console.warn('[illustration] terminal capture failed')
        }
    })()
}
