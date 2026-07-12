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

export function stageMainRequestSnapshot(s: MainRequestSnapshot){
    pending = s
}

// generationId gates the commit: preview/continue sends pass through the same
// dispatch site without staging, and must not commit a stale pending left
// behind by an earlier failed send.
export function commitMainRequestSnapshot(generationId: string){
    if(pending && pending.forGenerationId === generationId){
        committed = pending
    }
    pending = null
}

export function getReplayableSnapshot(generationId: string|undefined): MainRequestSnapshot | null {
    if(!generationId || !committed) return null
    return committed.forGenerationId === generationId ? committed : null
}
