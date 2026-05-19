/**
 * OpenAI Batch API tracker.
 *
 * OpenAI Batch API: 50% cost discount, 24h completion window.
 * Flow: JSONL upload → batch create → poll status → download results.
 *
 * Same persistent-tracker pattern as claudeBatchTracker.ts:
 *  1. Persists pending batches to IndexedDB.
 *  2. Tags placeholder chat message with generationInfo.batchId.
 *  3. Single global poller (30s interval after 60s warm-up).
 *  4. Resumes on app load — tab close safe.
 */

import { fetchNative } from "src/ts/globalApi.svelte"
import { getDatabase } from "src/ts/storage/database.svelte"
import { readPersistentJson, writePersistentJson } from "src/ts/storage/persistentKv"
import { v4 } from "uuid"

interface PendingBatch {
    batchId: string
    customId: string
    apiKey: string
    submittedAt: number
}

const STORAGE_KEY = 'openai_batch_pending.json'
const INITIAL_DELAY_MS = 60_000
const POLL_INTERVAL_MS = 30_000
const ABANDON_AGE_MS = 25 * 60 * 60 * 1000

let pendingBatches: PendingBatch[] = []
let pollerTimer: ReturnType<typeof setTimeout> | null = null
let loaded = false
let loadPromise: Promise<void> | null = null

const activeStreams = new Map<string, { controller: any, cleanup?: () => void }>()

export function registerBatchStream(batchId: string, controller: any, cleanup?: () => void): void {
    activeStreams.set(batchId, { controller, cleanup })
}

export function unregisterBatchStream(batchId: string): void {
    activeStreams.delete(batchId)
}

async function loadPending(): Promise<void> {
    if (loaded) return
    if (!loadPromise) {
        loadPromise = (async () => {
            try {
                const data = await readPersistentJson<PendingBatch[]>(STORAGE_KEY)
                if (Array.isArray(data)) pendingBatches = data
            } catch {}
            loaded = true
        })()
    }
    return loadPromise
}

async function savePending(): Promise<void> {
    try { await writePersistentJson(STORAGE_KEY, pendingBatches) } catch {}
}

function ensurePoller(): void {
    if (pollerTimer || pendingBatches.length === 0) return
    pollerTimer = setTimeout(() => { pollerTimer = null; void pollAllAndReschedule() }, INITIAL_DELAY_MS)
}

async function pollAllAndReschedule(): Promise<void> {
    await pollAll()
    if (pendingBatches.length > 0) {
        pollerTimer = setTimeout(() => { pollerTimer = null; void pollAllAndReschedule() }, POLL_INTERVAL_MS)
    }
}

async function pollAll(): Promise<void> {
    const now = Date.now()
    const expired = pendingBatches.filter(b => now - b.submittedAt > ABANDON_AGE_MS)
    if (expired.length > 0) {
        for (const b of expired) {
            console.warn(`[OpenAIBatch] abandoning ${b.batchId} after ${Math.round((now - b.submittedAt) / 60000)}min`)
            await applyResult(b.batchId, '[Batch abandoned: tracker timeout]')
        }
        pendingBatches = pendingBatches.filter(b => now - b.submittedAt <= ABANDON_AGE_MS)
        await savePending()
    }

    const snapshot = [...pendingBatches]
    let mutated = false
    for (const b of snapshot) {
        try {
            const headers = { "Authorization": `Bearer ${b.apiKey}` }
            const statusRes = await fetchNative(`https://api.openai.com/v1/batches/${b.batchId}`, {
                method: 'GET', headers
            } as any)
            if ((statusRes as any).status !== 200) continue
            const batch = await (statusRes as any).json()

            if (batch.status === 'completed' && batch.output_file_id) {
                const fileRes = await fetchNative(`https://api.openai.com/v1/files/${batch.output_file_id}/content`, {
                    method: 'GET', headers
                } as any)
                if ((fileRes as any).status !== 200) continue
                const text = await (fileRes as any).text()
                const lines = text.split('\n').filter((l: string) => l.trim())
                const result = lines.map((l: string) => { try { return JSON.parse(l) } catch { return null } })
                    .find((o: any) => o?.custom_id === b.customId)

                const formatted = formatResult(result)
                await applyResult(b.batchId, formatted)
                pendingBatches = pendingBatches.filter(x => x.batchId !== b.batchId)
                mutated = true
                console.warn(`[OpenAIBatch] completed ${b.batchId} (${Math.round((now - b.submittedAt) / 1000)}s)`)
            } else if (batch.status === 'failed' || batch.status === 'cancelled' || batch.status === 'expired') {
                const msg = batch.errors?.data?.[0]?.message ?? batch.status
                await applyResult(b.batchId, `[Batch ${batch.status}] ${msg}`)
                pendingBatches = pendingBatches.filter(x => x.batchId !== b.batchId)
                mutated = true
            }
        } catch (e: any) {
            console.warn(`[OpenAIBatch] poll error for ${b.batchId}:`, e?.message || e)
        }
    }
    if (mutated) await savePending()
}

function formatResult(result: any): string {
    if (!result) return '[Batch result missing]'
    if (result.response?.status_code === 200) {
        const body = result.response.body
        const content = body?.choices?.[0]?.message?.content ?? ''
        const reasoning = body?.choices?.[0]?.message?.reasoning_content ?? ''
        if (reasoning) return `<Thoughts>\n${reasoning}\n</Thoughts>\n${content}`
        return content || '[Empty response]'
    }
    if (result.error) return `[Batch error] ${JSON.stringify(result.error)}`
    return `[Batch response: HTTP ${result.response?.status_code ?? 'unknown'}]`
}

async function applyResult(batchId: string, text: string): Promise<void> {
    const subscriber = activeStreams.get(batchId)
    if (subscriber) {
        try {
            subscriber.controller.enqueue({ "0": text })
            subscriber.controller.close()
            activeStreams.delete(batchId)
            try { subscriber.cleanup?.() } catch {}
            return
        } catch {
            activeStreams.delete(batchId)
        }
    }

    const db = getDatabase()
    const chars = (db as any).characters
    if (!chars) return
    for (const charId in chars) {
        const char = chars[charId]
        const chats = char?.chats
        if (!Array.isArray(chats)) continue
        for (const chat of chats) {
            const msgs = chat?.message
            if (!Array.isArray(msgs)) continue
            for (const msg of msgs) {
                if (msg?.generationInfo?.batchId === batchId) {
                    msg.data = text
                    delete msg.generationInfo.batchId
                    try {
                        const [triggers, dbMod] = await Promise.all([
                            import("src/ts/process/triggers"),
                            import("src/ts/storage/database.svelte"),
                        ])
                        const result = await triggers.runTrigger(char, 'output', { chat })
                        if (result?.chat) {
                            const normalized = (dbMod as any).normalizeChat?.(result.chat) ?? result.chat
                            Object.assign(chat, normalized)
                        }
                    } catch {}
                    return
                }
            }
        }
    }
}

/**
 * Submit a single chat request as an OpenAI batch.
 * Returns a batchId that tags the placeholder message.
 */
export async function submitOpenAIBatch(
    body: Record<string, any>,
    apiKey: string,
): Promise<{ batchId: string, placeholderStream: ReadableStream }> {
    await loadPending()

    const customId = `risu-${v4()}`
    const batchId = customId

    // Build JSONL (single line)
    const jsonlLine = JSON.stringify({
        custom_id: customId,
        method: "POST",
        url: "/v1/chat/completions",
        body: { ...body, stream: false }
    })

    const headers = { "Authorization": `Bearer ${apiKey}` }

    // Upload file via manual multipart (fetchNative doesn't support FormData)
    const boundary = '----RisuBatch' + Date.now().toString(36)
    const multipartBody =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="batch_input.jsonl"\r\n` +
        `Content-Type: application/jsonl\r\n\r\n` +
        jsonlLine + `\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="purpose"\r\n\r\n` +
        `batch\r\n` +
        `--${boundary}--\r\n`

    const uploadRes = await fetchNative('https://api.openai.com/v1/files', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: multipartBody,
    } as any)
    const uploadData = await (uploadRes as any).json()
    if (!uploadData?.id) {
        throw new Error(`File upload failed: ${JSON.stringify(uploadData)}`)
    }

    // Create batch
    const batchRes = await fetchNative('https://api.openai.com/v1/batches', {
        method: 'POST',
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
            input_file_id: uploadData.id,
            endpoint: "/v1/chat/completions",
            completion_window: "24h",
        }),
    } as any)
    const batchData = await (batchRes as any).json()
    if (!batchData?.id) {
        throw new Error(`Batch creation failed: ${JSON.stringify(batchData)}`)
    }

    // Track
    const pending: PendingBatch = {
        batchId: batchData.id,
        customId,
        apiKey,
        submittedAt: Date.now(),
    }
    pendingBatches.push(pending)
    await savePending()
    ensurePoller()

    // Placeholder stream (stays open until batch completes or tab closes)
    const realBatchId = batchData.id
    const placeholderStream = new ReadableStream({
        start(controller) {
            const placeholder = `[배치 처리 �� — ID ${realBatchId.substring(0, 18)}… ⏳]\n` +
                `[OpenAI Batch API. 응답 도착 시 자동 갱신됩니다. 탭을 닫아도 결과는 저장됩니다.]`
            try { controller.enqueue({ "0": placeholder }) } catch {}
            registerBatchStream(realBatchId, controller, () => unregisterBatchStream(realBatchId))
        }
    })

    return { batchId: realBatchId, placeholderStream }
}

export async function initOpenAIBatchTracker(): Promise<void> {
    await loadPending()
    ensurePoller()
}
