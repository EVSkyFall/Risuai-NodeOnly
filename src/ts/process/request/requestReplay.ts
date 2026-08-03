import type { OpenAIChat } from '../index.svelte'
import type { MCPTool } from '../mcp/mcplib'

export interface MainRequestSnapshot {
    formated: OpenAIChat[]
    biasString: [string, number][]
    staticModel: string
    tools?: MCPTool[]
    forGenerationId: string
    capturedAt: number
}

// Two-phase slot: a snapshot is staged at dispatch and only committed once its
// generation actually produced a message. A failed attempt would otherwise
// re-key the slot to a generationId that never reaches the chat while the
// restored on-screen message keeps its old chatId — orphaning a still-valid
// snapshot. getReplayableSnapshot therefore reads only the committed slot.
let pending: MainRequestSnapshot | null = null
let committed: MainRequestSnapshot | null = null
let committedMessageChatId: string | null = null

export function stageMainRequestSnapshot(s: MainRequestSnapshot){
    pending = s
}

export function shouldStageMainRequestSnapshot(
    model: string,
    arg: { chatId?: string; previewBody?: boolean; continue?: boolean },
): boolean {
    // A continuation still produces replayable request bytes; only the
    // persisted message identity differs from this dispatch's generationId.
    return model === 'model' && !!arg.chatId && !arg.previewBody
}

// generationId gates the commit: preview sends pass through the same dispatch
// site without staging, and must not commit a stale pending left behind by an
// earlier failed send. Continue sends are staged and committed under the
// message chatId that remains in the chat.
export function commitMainRequestSnapshot(generationId: string, messageChatId = generationId){
    if(pending && pending.forGenerationId === generationId){
        committed = pending
        committedMessageChatId = messageChatId
    }
    pending = null
}

export function getReplayableSnapshot(messageChatId: string|undefined): MainRequestSnapshot | null {
    if(!messageChatId || !committed) return null
    return committedMessageChatId === messageChatId ? committed : null
}
