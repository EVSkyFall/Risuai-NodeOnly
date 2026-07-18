import { get } from 'svelte/store'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase, type Chat, type Database, type Message } from 'src/ts/storage/database.svelte'
import { ensureChatHydrated } from 'src/ts/storage/chatStorage'
import { notifyError } from 'src/ts/alert'
import { language } from 'src/lang'
import { chatGenKey, endGeneration, generationStates, registerAbort, startGeneration } from 'src/ts/process/generationState'
import { clearStatus, endStatus, startStatus } from 'src/ts/status/requestStatus'
import { authHeader } from './jobFetch'
import { parseSseStream } from 'src/ts/preset/adapter/sse'
import { parseChatCompletion, parseChatStreamDelta } from 'src/ts/preset/adapter/openaiCompatible'
import { parseAnthropicMessage, parseAnthropicStreamDelta } from 'src/ts/preset/adapter/anthropicMessages'
import { parseGeminiResponse, parseGeminiStreamDelta } from 'src/ts/preset/adapter/googleGemini'
import { extractErrorMessage } from 'src/ts/preset/adapter/error'
import { formatReasoningParts } from 'src/ts/preset/adapter/reasoning'
import type { AdapterChatStreamDelta } from 'src/ts/preset/adapter/types'

// Bootstrap recovery for server-side model jobs (Stage 4 of
// .agent/notes/model-preset-server-side-requests.md, §3 "복귀" / §5 row 4).
//
// While a job runs, the server journals the provider's raw bytes even if this
// client disconnects (jobFetch.ts, Stage 3). On the next boot, discovery here
// picks the pieces back up:
//   - unclaimed terminal jobs (done/failed) → decode the journal with the
//     SAME pure client parsers a live run uses and slot the final text into
//     the originating chat (or its error into the ```risuerror``` pattern),
//   - still-running jobs → publish a 'background' request-status entry, hold
//     the per-chat send guard, and poll until terminal, then slot in the same
//     way.
//
// v1 scope decision: a reattached RUNNING job renders on completion
// (poll → slot-in), not live-into-the-bubble. The journal stream endpoint
// already supports replay+live tail, so a later polish can adopt live
// rendering without transport changes — but rebuilding the live write loop
// (index.svelte.ts) out-of-band is deliberately out of scope here.
//
// Recovered text is the RAW model output (reasoning-prefixed exactly like a
// live run would have saved). Live-generation extras — editoutput scripts,
// triggers, emotion detection, translate, TTS, auto-continue — are not
// replayed: they are live-pipeline behavior, and re-running them out of band
// could fire side effects on a chat the user is not even looking at.

export interface ModelJobRecord {
    id: string
    chatId: string
    generationId?: string | null
    adapterKind?: string | null
    streaming?: boolean
    status: 'running' | 'done' | 'failed' | 'aborted'
    upstreamStatus?: number | null
    error?: string
}

// Poll cadence for reattached running jobs: light backoff from 3s to 15s.
// The deadline outlives the server's max upstream timeout (1h) so we never
// abandon a job the server still considers live.
export const JOB_POLL_INITIAL_MS = 3000
export const JOB_POLL_MAX_MS = 15000
export const JOB_POLL_DEADLINE_MS = 65 * 60 * 1000

function statusEnabled(): boolean {
    try {
        return getDatabase()?.showRequestStatus !== false
    } catch {
        return false
    }
}

// Status publishing must never break recovery (same harmless-wrapper policy
// as request.ts's safeStatus).
function safeStatus(fn: () => void): void {
    try {
        fn()
    } catch (err) {
        console.warn('[ModelJobRecovery] status publish failed', err)
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

// --- journal decoding -------------------------------------------------------

function anthropicStreamErrorMessage(data: string): string {
    try {
        const parsed = JSON.parse(data) as { error?: { message?: unknown } }
        if (typeof parsed?.error?.message === 'string') return parsed.error.message
    } catch { /* fall through with default message */ }
    return 'Anthropic stream error'
}

// Replay a STREAMING journal (raw SSE bytes) through the same per-kind pure
// delta parsers a live run uses, accumulating text/reasoning exactly like
// presetStreamPump's buildChunk (reasoning-prefixed final text). Unknown kinds
// fall back to the OpenAI-compatible wire (the most common dialect).
export async function decodeStreamingJournal(
    kind: string | null | undefined,
    body: ReadableStream<Uint8Array>,
): Promise<string> {
    let fullText = ''
    let reasoningText = ''
    for await (const event of parseSseStream(body)) {
        let delta: AdapterChatStreamDelta | null = null
        if (kind === 'anthropic-messages') {
            // Same event handling as streamAnthropicChatRequest.
            if (event.event === 'ping') continue
            if (event.event === 'message_stop') break
            if (event.event === 'error') throw new Error(anthropicStreamErrorMessage(event.data))
            if (event.data.length === 0) continue
            delta = parseAnthropicStreamDelta(event.event, JSON.parse(event.data))
        } else if (kind === 'google-gemini') {
            if (event.data.length === 0) continue
            delta = parseGeminiStreamDelta(JSON.parse(event.data))
        } else {
            // Same event handling as streamChatRequest (openai-compatible).
            if (event.data === '[DONE]') break
            if (event.data.length === 0) continue
            delta = parseChatStreamDelta(JSON.parse(event.data))
        }
        if (!delta) continue
        if (delta.reasoningDelta) reasoningText += delta.reasoningDelta
        fullText += delta.textDelta
    }
    return (reasoningText.length > 0 ? formatReasoningParts([{ text: reasoningText }]) : '') + fullText
}

// Decode a NON-STREAMING journal (one JSON body) with the per-kind response
// parser, mirroring requestModelPreset's non-streaming return
// (formatPresetReasoning(reasoning) + text).
export function decodeJsonJournal(kind: string | null | undefined, text: string): string {
    const raw: unknown = JSON.parse(text)
    const response = kind === 'anthropic-messages' ? parseAnthropicMessage(raw)
        : kind === 'google-gemini' ? parseGeminiResponse(raw)
        : parseChatCompletion(raw)
    return formatReasoningParts(response.reasoning) + response.text
}

// --- chat lookup / slot-in --------------------------------------------------

type DbCharacter = Database['characters'][number]

interface LocatedChat {
    char: DbCharacter
    chat: Chat
}

// Find the job's originating chat by REAL chat.id across all characters.
// Placeholder chats (lazy loading) are hydrated first — both the idempotency
// scan and the insert need the real message array. A failed hydration throws
// so the job stays unclaimed and the next boot retries.
async function locateChat(chatId: string): Promise<LocatedChat | null> {
    const characters = getDatabase()?.characters ?? []
    for (const char of characters) {
        const idx = char?.chats?.findIndex((c) => c?.id === chatId) ?? -1
        if (idx === -1) continue
        let chat = char.chats[idx]
        if (chat._placeholder) {
            const hydrated = await ensureChatHydrated(char.chats, idx, char.chaId)
            if (!hydrated) throw new Error(`chat ${chatId} could not be hydrated`)
            chat = hydrated
        }
        if (!Array.isArray(chat.message)) chat.message = []
        return { char, chat }
    }
    return null
}

// Same out-of-band refresh other DB writes use (index.svelte.ts write loop).
function bumpReload(loc: LocatedChat): void {
    loc.char.reloadKeys = (loc.char.reloadKeys ?? 0) + 1
}

async function claimJob(jobId: string): Promise<void> {
    try {
        await fetch(`/api/model-jobs/${jobId}/claim`, { method: 'POST', headers: await authHeader() })
    } catch {
        // Best effort: a missed claim is covered by generationId idempotency
        // on the next discovery pass.
    }
}

// Message shape mirrors the live write path (index.svelte.ts streaming push):
// data/saying/time/generationInfo, message-level chatId = generationId.
function insertRecoveredMessage(loc: LocatedChat, job: ModelJobRecord, text: string): void {
    const message: Message = {
        role: 'char',
        data: text,
        time: Date.now(),
        chatId: job.generationId ?? uuidv4(),
        generationInfo: { generationId: job.generationId ?? undefined },
    }
    if (loc.char.chaId) message.saying = loc.char.chaId
    loc.chat.message.push(message)
    bumpReload(loc)
}

// Failed job → the existing ```risuerror``` inline pattern (mirrors the push
// branch of index.svelte.ts throwError, targeted at the job's chat instead of
// the selected one). ALWAYS pushed as a new 'char' message: at boot the last
// message is an unrelated completed reply, so appending would corrupt it. The
// generationInfo lets future idempotency scans match this insert. With
// inlayErrorResponse off, a toast naming the character.
function insertJobError(loc: LocatedChat, job: ModelJobRecord, error: string): void {
    if (!getDatabase()?.inlayErrorResponse) {
        const charName = (loc.char as { name?: string }).name || loc.chat.name || 'chat'
        notifyError(language.errors.backgroundGenerationFailed
            .replace('{char}', charName).replace('{error}', error), { source: 'model-job' })
        return
    }
    const message: Message = {
        role: 'char',
        data: `\`\`\`risuerror\n${error}\n\`\`\``,
        time: Date.now(),
    }
    if (loc.char.chaId) message.saying = loc.char.chaId
    if (job.generationId) message.generationInfo = { generationId: job.generationId }
    loc.chat.message.push(message)
    bumpReload(loc)
}

// Read a done job's journal and decode it to the final text. Non-2xx upstream
// means the provider answered with an HTTP error the recorder faithfully
// journaled — surface it as a failure, not a message. Throws (leaving the job
// unclaimed for the next boot) only when the journal itself is unreachable.
async function readJobResult(job: ModelJobRecord): Promise<{ ok: true, text: string } | { ok: false, error: string }> {
    const res = await fetch(`/api/model-jobs/${job.id}/stream`, { headers: await authHeader() })
    if (!res.ok || !res.body) {
        throw new Error(`model job journal unavailable (HTTP ${res.status})`)
    }
    const headerStatus = Number(res.headers.get('x-model-job-upstream-status'))
    const upstreamStatus = job.upstreamStatus ?? (Number.isFinite(headerStatus) ? headerStatus : null)
    if (upstreamStatus === null || upstreamStatus < 200 || upstreamStatus >= 300) {
        let bodyText = ''
        try {
            bodyText = await res.text()
        } catch { /* status alone is enough */ }
        return { ok: false, error: extractErrorMessage(bodyText) ?? `HTTP ${upstreamStatus ?? 'error'}` }
    }
    try {
        const text = job.streaming
            ? await decodeStreamingJournal(job.adapterKind, res.body)
            : decodeJsonJournal(job.adapterKind, await res.text())
        if (text.trim().length === 0) {
            return { ok: false, error: 'Recovered response was empty' }
        }
        return { ok: true, text }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
}

// Slot one terminal job into its chat. Idempotent (design §4 safety rule 2):
// if the chat already holds a message with this generationId — the live path
// saved it but its claim never landed — only the claim is (re)posted.
export async function recoverTerminalJob(job: ModelJobRecord): Promise<void> {
    const loc = await locateChat(job.chatId)
    if (!loc) {
        // Chat was deleted while the job ran — nothing to slot into.
        console.warn('[ModelJobRecovery] chat missing for job', job.id, '- claiming without slot-in')
        await claimJob(job.id)
        return
    }
    if (job.generationId && loc.chat.message.some((m) => m?.generationInfo?.generationId === job.generationId)) {
        await claimJob(job.id)
        return
    }
    if (job.status === 'failed') {
        insertJobError(loc, job, job.error ?? 'Model request failed')
        await claimJob(job.id)
        return
    }
    if (job.status !== 'done') return
    const result = await readJobResult(job)
    if (result.ok === true) {
        insertRecoveredMessage(loc, job, result.text)
    } else {
        insertJobError(loc, job, result.error)
    }
    await claimJob(job.id)
}

// --- running jobs -----------------------------------------------------------

// Reattach a job that is still running server-side: hold the per-chat send
// guard (client-side complement to the server's 409), publish a 'background'
// status entry, and poll until terminal → same slot-in as discovery.
export function attachRunningJob(job: ModelJobRecord): void {
    const genKey = chatGenKey(job.chatId)
    const registeredGenId = job.generationId ?? uuidv4()
    // 'background' kind: holds the per-chat send guard without flipping the
    // global doingChat (which would lock every send UI for up to the poll
    // deadline). Survives endAllGenerations cleanup writes for the same reason.
    let controller: AbortController | undefined
    if (!get(generationStates).has(genKey)) {
        startGeneration(genKey, registeredGenId, 'background')
        // Wire the Stop button: aborting DELETEs the job (server aborts the
        // upstream), stops the poll loop, and releases guard + status.
        controller = new AbortController()
        registerAbort(genKey, controller)
    }
    const statusId = statusEnabled() && job.generationId ? job.generationId : undefined
    if (statusId) {
        safeStatus(() => startStatus(statusId, {
            kind: 'main',
            label: job.adapterKind ?? 'model',
            chatId: job.chatId,
            phase: 'background',
            now: Date.now(),
        }))
    }
    void pollRunningJob(job, genKey, registeredGenId, statusId, controller?.signal)
}

async function pollRunningJob(
    job: ModelJobRecord,
    genKey: string,
    registeredGenId: string,
    statusId: string | undefined,
    abortSignal?: AbortSignal,
): Promise<void> {
    const deadline = Date.now() + JOB_POLL_DEADLINE_MS
    let interval = JOB_POLL_INITIAL_MS
    const finish = (outcome: 'done' | 'failed' | 'aborted', error?: string) => {
        // Only release the guard if it is still OUR registration (a completed
        // recovery must not end a generation the user started afterwards).
        if (get(generationStates).get(genKey)?.generationId === registeredGenId) {
            endGeneration(genKey)
        }
        if (statusId) {
            safeStatus(() => endStatus(statusId, outcome, { now: Date.now(), error }))
        }
    }
    abortSignal?.addEventListener('abort', () => {
        // Stop pressed on the reattached job: DELETE the job fire-and-forget
        // (abort must never hang on cleanup); the loop exit below stops the
        // polling.
        void (async () => {
            await fetch(`/api/model-jobs/${job.id}`, { method: 'DELETE', headers: await authHeader() })
        })().catch(() => {})
        finish('aborted')
    }, { once: true })
    while (Date.now() < deadline) {
        await sleep(interval)
        if (abortSignal?.aborted) return // finished by the abort listener
        interval = Math.min(JOB_POLL_MAX_MS, Math.round(interval * 1.5))
        let res: Response
        try {
            res = await fetch(`/api/model-jobs/${job.id}`, { headers: await authHeader() })
        } catch {
            continue // transient network failure — keep polling
        }
        if (res.status === 404) {
            // Job deleted out from under us (aborted/cleaned elsewhere).
            finish('aborted')
            return
        }
        if (!res.ok) continue
        let current: ModelJobRecord
        try {
            current = await res.json()
        } catch {
            continue
        }
        if (current.status === 'running') continue
        if (current.status !== 'aborted') {
            try {
                await recoverTerminalJob({ ...job, ...current })
            } catch (err) {
                console.warn('[ModelJobRecovery] slot-in after poll failed', job.id, err)
            }
        }
        finish(current.status, current.status === 'failed' ? current.error : undefined)
        return
    }
    // Deadline can only expire when the status endpoint was unreachable the
    // whole window — the job itself may well have finished fine. Give up
    // SILENTLY: no failure toast (the entry is dismissed outright), no claim,
    // so the next boot's discovery slots the result in.
    console.warn('[ModelJobRecovery] poll deadline exceeded for job', job.id, '- giving up (next boot recovers)')
    if (get(generationStates).get(genKey)?.generationId === registeredGenId) {
        endGeneration(genKey)
    }
    if (statusId) {
        safeStatus(() => clearStatus(statusId))
    }
}

// --- discovery entry point --------------------------------------------------

async function listJobs(filter: 'unclaimed' | 'active'): Promise<ModelJobRecord[]> {
    const res = await fetch(`/api/model-jobs?${filter}=1`, { headers: await authHeader() })
    if (!res.ok) return [] // older server without the job API — recovery is a no-op
    const parsed = await res.json()
    return Array.isArray(parsed?.jobs) ? parsed.jobs : []
}

let recoveryStarted = false

// Bootstrap hook (called fire-and-forget from bootstrap.ts loadData). Runs
// once, never throws, and is a no-op when the job API is unreachable or
// returns nothing. NOT gated on the nodeOnlyServerSideRequests toggle: jobs
// created before the toggle was switched off must still be recovered.
export async function recoverModelJobs(): Promise<void> {
    if (recoveryStarted) return
    recoveryStarted = true
    try {
        const [unclaimedJobs, activeJobs] = await Promise.all([listJobs('unclaimed'), listJobs('active')])
        // Sequential on purpose: slot-ins mutate the DB and a failure on one
        // job must not stop the rest.
        for (const job of unclaimedJobs) {
            try {
                await recoverTerminalJob(job)
            } catch (err) {
                console.warn('[ModelJobRecovery] recovery failed for job', job?.id, err)
            }
        }
        for (const job of activeJobs) {
            try {
                attachRunningJob(job)
            } catch (err) {
                console.warn('[ModelJobRecovery] reattach failed for job', job?.id, err)
            }
        }
    } catch (err) {
        console.warn('[ModelJobRecovery] discovery failed', err)
    }
}
