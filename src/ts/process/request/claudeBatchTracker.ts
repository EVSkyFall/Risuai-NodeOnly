/**
 * Claude Message Batches API tracker.
 *
 * The Anthropic Message Batches API runs asynchronously (1h typical, 24h hard
 * cap) at 50% cost. The original integration polled inside the streaming
 * controller — which dies when the browser tab closes, orphaning any in-flight
 * batch and losing the result forever.
 *
 * This tracker fixes that by:
 *  1. Persisting every submitted batch to IndexedDB (via persistentKv).
 *  2. Tagging the placeholder chat message with `generationInfo.batchId`.
 *  3. Running a single global poller (30s after a 60s warm-up) that applies
 *     completed results to the matching message slot via direct DB mutation —
 *     no streaming controller required.
 *  4. Resuming all pending batches on app load, so closing the tab is safe:
 *     reopen and the tracker picks up where it left off.
 */

import { fetchNative } from "src/ts/globalApi.svelte"
import { getDatabase } from "src/ts/storage/database.svelte"
import { readPersistentJson, writePersistentJson } from "src/ts/storage/persistentKv"
import { v4 } from "uuid"

interface PendingBatch {
    batchId: string
    statusUrl: string
    resultsUrl: string
    cancelUrl: string
    headers: Record<string, string>
    submittedAt: number
    customId: string
}

const STORAGE_KEY = 'claude_batch_pending.json'
const INITIAL_DELAY_MS = 60_000          // wait 1 minute before first poll
const POLL_INTERVAL_MS = 30_000          // then poll every 30s
const MAX_AGE_MS = 24 * 60 * 60 * 1000   // batches expire at 24h regardless of poll
const ABANDON_AGE_MS = MAX_AGE_MS + 60 * 60 * 1000 // give up tracking after 25h

let pendingBatches: PendingBatch[] = []
let pollerTimer: ReturnType<typeof setTimeout> | null = null
let loaded = false
let loadPromise: Promise<void> | null = null

async function loadPending(): Promise<void> {
    if (loaded) return
    if (!loadPromise) {
        loadPromise = (async () => {
            try {
                const data = await readPersistentJson<PendingBatch[]>(STORAGE_KEY)
                if (Array.isArray(data)) pendingBatches = data
            } catch (_e) { /* silent */ }
            loaded = true
        })()
    }
    return loadPromise
}

async function savePending(): Promise<void> {
    try {
        await writePersistentJson(STORAGE_KEY, pendingBatches)
    } catch (_e) { /* silent */ }
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
    // Drop abandoned batches first (safety net for ones we missed for >25h)
    const now = Date.now()
    const expired = pendingBatches.filter(b => now - b.submittedAt > ABANDON_AGE_MS)
    if (expired.length > 0) {
        for (const b of expired) {
            console.warn(`[ClaudeBatch] abandoning batch ${b.batchId} after ${Math.round((now - b.submittedAt) / 60000)}min`)
            await applyResultToMessage(b.batchId, '[Batch abandoned: tracker timeout]')
        }
        pendingBatches = pendingBatches.filter(b => now - b.submittedAt <= ABANDON_AGE_MS)
        await savePending()
    }

    const snapshot = [...pendingBatches]
    let mutated = false
    for (const b of snapshot) {
        try {
            const statusRes = await fetchNative(b.statusUrl, {
                method: 'GET',
                headers: b.headers,
                interceptor: 'anthropic_batching_status' as any,
            } as any)
            if ((statusRes as any).status !== 200) continue
            const status = await (statusRes as any).json()
            if (status?.processing_status !== 'ended') continue

            // Fetch results (jsonl)
            const resultsRes = await fetchNative(b.resultsUrl, {
                method: 'GET',
                headers: b.headers,
                interceptor: 'anthropic_batching_results' as any,
            } as any)
            if ((resultsRes as any).status !== 200) {
                console.warn(`[ClaudeBatch] results fetch failed for ${b.batchId}: ${(resultsRes as any).status}`)
                continue
            }
            const text = await (resultsRes as any).text()
            const lines = text.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0)
            const resultObj = lines.map((l: string) => { try { return JSON.parse(l) } catch { return null } })
                                   .find((o: any) => o?.custom_id === b.customId) ?? null
            const formatted = formatBatchResult(resultObj?.result)

            await applyResultToMessage(b.batchId, formatted)
            pendingBatches = pendingBatches.filter(x => x.batchId !== b.batchId)
            mutated = true
            console.warn(`[ClaudeBatch] completed ${b.batchId} (${Math.round((now - b.submittedAt) / 1000)}s)`)
        } catch (e: any) {
            console.warn(`[ClaudeBatch] poll error for ${b.batchId}:`, e?.message || e)
        }
    }
    if (mutated) await savePending()
}

function formatBatchResult(result: any): string {
    if (!result) return '[Batch result missing]'
    if (result.type === 'succeeded') {
        const contents = result.message?.content ?? []
        let out = ''
        let inThinking = false
        for (const c of contents) {
            if (c.type === 'text') {
                if (inThinking) { out += '</Thoughts>\n\n'; inThinking = false }
                out += c.text ?? ''
            } else if (c.type === 'thinking') {
                if (!inThinking) { out += '<Thoughts>\n'; inThinking = true }
                out += c.thinking ?? ''
            } else if (c.type === 'redacted_thinking') {
                if (!inThinking) { out += '<Thoughts>\n'; inThinking = true }
                out += '\n{{redacted_thinking}}\n'
            }
        }
        if (inThinking) out += '</Thoughts>\n\n'
        return out || '[Empty response]'
    }
    if (result.type === 'errored') {
        const err = result.error
        const msg = err?.error?.message ?? JSON.stringify(err)
        return `[Batch error] ${msg}`
    }
    if (result.type === 'canceled') return '[Batch cancelled]'
    if (result.type === 'expired') return '[Batch expired (24h limit reached before processing started)]'
    return `[Unknown batch result type: ${result.type}]`
}

/**
 * Walk all chats across all characters to find the message tagged with this
 * batchId, then replace its content with the result text and clear the tag.
 */
async function applyResultToMessage(batchId: string, text: string): Promise<void> {
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
                    return
                }
            }
        }
    }
    console.warn(`[ClaudeBatch] could not find message slot for batchId ${batchId}`)
}

/**
 * Submit a single Messages request as a batch and persist the metadata for
 * tracking. Returns the batchId so the caller can tag its placeholder message
 * via `generationInfo.batchId`.
 */
export async function submitClaudeBatch(
    replacerURL: string,
    body: any,
    headers: Record<string, string>,
    abortSignal?: AbortSignal,
): Promise<{ batchId: string, customId: string }> {
    await loadPending()
    const customId = v4().replace(/-/g, '').substring(0, 60) // satisfy ^[a-zA-Z0-9_-]{1,64}$
    const submitRes = await fetchNative(replacerURL + '/batches', {
        body: JSON.stringify({
            requests: [{ custom_id: customId, params: body }],
        }),
        method: 'POST',
        headers,
        signal: abortSignal,
        interceptor: 'anthropic_batching' as any,
    } as any)
    if ((submitRes as any).status !== 200) {
        const errText = await (submitRes as any).text().catch(() => '')
        throw new Error(`Batch submit failed (${(submitRes as any).status}): ${errText}`)
    }
    const r = await (submitRes as any).json()
    if (!r?.id) throw new Error('Batch submit returned no id')

    const batch: PendingBatch = {
        batchId: r.id,
        statusUrl: replacerURL + `/batches/${r.id}`,
        resultsUrl: replacerURL + `/batches/${r.id}/results`,
        cancelUrl: replacerURL + `/batches/${r.id}/cancel`,
        headers,
        submittedAt: Date.now(),
        customId,
    }
    pendingBatches.push(batch)
    await savePending()
    ensurePoller()

    return { batchId: r.id, customId }
}

export async function cancelClaudeBatch(batchId: string): Promise<void> {
    await loadPending()
    const b = pendingBatches.find(x => x.batchId === batchId)
    if (!b) return
    try {
        await fetchNative(b.cancelUrl, { method: 'POST', headers: b.headers, body: '{}' })
    } catch (_e) { /* silent */ }
    pendingBatches = pendingBatches.filter(x => x.batchId !== batchId)
    await savePending()
}

/**
 * Called once at app boot to resume any batches that survived a tab close.
 */
export async function resumeClaudeBatches(): Promise<void> {
    await loadPending()
    if (pendingBatches.length === 0) return
    console.warn(`[ClaudeBatch] resuming ${pendingBatches.length} pending batch(es) on app load`)
    ensurePoller()
}

export function getPendingBatchCount(): number {
    return pendingBatches.length
}
