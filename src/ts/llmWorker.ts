/**
 * Browser-as-worker bridge for /api/mcp/llm/call.
 *
 * Connects via WebSocket to the RisuAI server's /ws/llm-worker endpoint and
 * handles incoming MCP LLM requests by running them through RisuAI's existing
 * `requestChatDataMain` pipeline. This means MCP calls automatically inherit:
 *   - Provider routing (Anthropic / Vertex / OpenAI / Copilot / xcustom)
 *   - Auth resolution (incl. Vertex JWT signing in browser)
 *   - Model translation (Opus 4.7 adaptive coercion, Vertex publisher prefix)
 *   - Retry / streaming / multi-turn continuation
 *   - Tool use (when applicable)
 *
 * Without this, server.cjs would need to re-implement everything per provider.
 */

import { DBState } from "src/ts/stores.svelte"
import { getModelInfo } from "src/ts/model/modellist"
import { requestChatDataMain } from "src/ts/process/request/request"
import { forageStorage } from "src/ts/globalApi.svelte"
import type { ModelModeExtended } from "src/ts/process/request/shared"

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const inflight = new Map<string, AbortController>()

function scheduleReconnect(delayMs: number): void {
    if (reconnectTimer) return
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        startLLMWorker().catch(() => {})
    }, delayMs)
}

function send(payload: any): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(payload)) } catch {}
    }
}

export async function startLLMWorker(): Promise<void> {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
    try {
        const auth = await forageStorage.createAuth()
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
        const url = `${proto}//${location.host}/ws/llm-worker?risu-auth=${encodeURIComponent(auth)}`
        ws = new WebSocket(url)

        ws.onopen = () => {
            console.warn('[LLMWorker] connected')
        }

        ws.onmessage = (ev) => {
            let msg: any
            try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') } catch { return }
            if (!msg) return
            if (msg.type === 'llm-request') {
                handleLLMRequest(msg.reqId, msg.params).catch((e) => {
                    send({ type: 'error', reqId: msg.reqId, error: e?.message || String(e) })
                })
            } else if (msg.type === 'abort') {
                const ac = inflight.get(msg.reqId)
                if (ac) ac.abort()
            }
        }

        ws.onclose = () => {
            ws = null
            inflight.forEach((ac) => ac.abort())
            inflight.clear()
            console.warn('[LLMWorker] disconnected, reconnecting in 5s')
            scheduleReconnect(5000)
        }

        ws.onerror = () => { /* onclose follows */ }
    } catch (e: any) {
        console.warn('[LLMWorker] failed to start:', e?.message || e)
        scheduleReconnect(5000)
    }
}

async function handleLLMRequest(reqId: string, params: any): Promise<void> {
    const sendChunk = (data: any) => send({ type: 'chunk', reqId, data })
    const sendDone = (response: any) => send({ type: 'done', reqId, response })
    const sendError = (error: string) => send({ type: 'error', reqId, error })

    const abortController = new AbortController()
    inflight.set(reqId, abortController)

    try {
        const db = DBState.db
        const profile = params?.profile === 'aux' ? 'submodel' : 'model'
        const staticModel: string | undefined = params?.model || undefined
        // Resolve modelInfo just for the response shape decision (Anthropic vs OpenAI)
        const modelId = staticModel || (profile === 'submodel' ? db.subModel : db.aiModel)
        const modelInfo = getModelInfo(modelId)
        if (!modelInfo) {
            sendError(`Model not found: ${modelId}`)
            return
        }

        // Build OpenAIChat[] from MCP-style messages + system
        const formated: any[] = []
        if (params.system) {
            const sysText = typeof params.system === 'string'
                ? params.system
                : (Array.isArray(params.system) ? params.system.map((b: any) => b?.text || '').join('\n') : '')
            if (sysText) formated.push({ role: 'system', content: sysText })
        }
        for (const m of (params.messages || [])) {
            const content = typeof m.content === 'string'
                ? m.content
                : (Array.isArray(m.content)
                    ? m.content.map((b: any) => b?.text || (typeof b === 'string' ? b : '')).join('')
                    : String(m.content ?? ''))
            formated.push({ role: m.role, content })
        }

        const result = await requestChatDataMain({
            formated,
            bias: {},
            biasString: [],
            useStreaming: !!params.stream,
            isGroupChat: false,
            continue: false,
            chatId: `mcp-${reqId}`,
            imageResponse: false,
            previewBody: false,
            escape: false,
            rememberToolUsage: false,
            temperature: typeof params.temperature === 'number' ? params.temperature : undefined,
            maxTokens: typeof params.max_tokens === 'number' ? params.max_tokens : undefined,
            staticModel,
        } as any, profile as ModelModeExtended, abortController.signal)

        if (abortController.signal.aborted) return

        if (result.type === 'fail') {
            sendError(result.result || 'request failed')
            return
        }

        let finalText = ''
        if (result.type === 'streaming') {
            const reader = result.result.getReader()
            try {
                while (true) {
                    if (abortController.signal.aborted) {
                        try { await reader.cancel() } catch {}
                        break
                    }
                    const { done, value } = await reader.read()
                    if (done) break
                    const text = (value as any)?.["0"] ?? ''
                    finalText = text
                    if (params.stream) sendChunk({ delta: text })
                }
            } finally {
                try { reader.releaseLock?.() } catch {}
            }
        } else if (result.type === 'success') {
            finalText = result.result
        } else if (result.type === 'multiline') {
            finalText = (result.result as any[]).map(([_role, t]) => t).join('\n')
        }

        if (abortController.signal.aborted) return

        // Synthesize an Anthropic-shape response so existing MCP callers that
        // parse `.content[0].text` keep working.
        const responseModel = (result as any).model || modelInfo.internalID || modelId
        const response = {
            id: `msg_${reqId}`,
            type: 'message',
            role: 'assistant',
            model: responseModel,
            content: [{ type: 'text', text: finalText }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 0, output_tokens: 0 },
            // OpenAI-shape mirror for callers that parse .choices
            choices: [{
                index: 0,
                message: { role: 'assistant', content: finalText },
                finish_reason: 'stop',
            }],
        }
        sendDone(response)
    } catch (e: any) {
        if (!abortController.signal.aborted) {
            sendError(e?.message || String(e))
        }
    } finally {
        inflight.delete(reqId)
    }
}
