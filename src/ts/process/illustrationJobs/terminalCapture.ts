import type { Chat, Message } from '../../storage/database.svelte'
import { v4 } from 'uuid'
import { isAutomaticCaptureAdmitted } from './capturePolicy'
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
            // Fast-path capture-policy gate: in manual (or unknown/broken) mode the
            // automatic finalization path does NOTHING — no id mint, no ledger
            // record, no marker, no LLM/provider work. Only an explicit 'automatic'
            // policy proceeds. registerTrustedTurn re-checks at admission to close
            // the mode-switch race; this check keeps the common case free of any
            // id-minting side effect.
            if (!(await isAutomaticCaptureAdmitted())) return
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
                    origin: 'automatic',
                    enforceCaptureMode: true,
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
