import { forageStorage } from 'src/ts/globalApi.svelte'

// Server-side model-preset requests — job-based fetchImpl (Stage 3 of
// .agent/notes/model-preset-server-side-requests.md).
//
// Instead of the browser fetching the provider directly (makeProxiedFetch),
// the client creates a server job (POST /api/model-jobs) and reads the
// provider's raw bytes back through the job's journal stream
// (GET /api/model-jobs/:id/stream). The server keeps consuming the upstream
// even if this client disconnects, so a dropped connection never kills the
// generation — Stage 4's discovery recovers it from the journal.
//
// The returned function is `typeof fetch`-compatible so it drops into the
// adapters' `options.fetchImpl` seam unchanged: the adapter sees a faithful
// provider Response (mirrored upstream status + content-type, byte-identical
// body). Works for streaming and non-streaming alike (non-streaming adapters
// just await response.json(), which drains the same wrapped stream).

/** Job creation was refused with 409 — this chat already has a running job.
 *  Must NOT fall back to the direct path (would double-generate). */
export class ModelJobBusyError extends Error {
    constructor() {
        super('This chat is already generating in the background')
        this.name = 'ModelJobBusyError'
    }
}

/** Safety rule 1 (끊김 ≠ 완료): the journal stream ended but the server says
 *  the job is still running — the tail connection was lost, NOT the
 *  generation. The message must not be saved as complete; the job keeps
 *  running server-side and discovery (Stage 4) recovers it. */
export class ModelJobConnectionLostError extends Error {
    constructor() {
        super('model job connection lost — generation continues in background')
        this.name = 'ModelJobConnectionLostError'
    }
}

export interface JobFetchOptions {
    /** Real chat.id (server enforces one running job per chat on this key). */
    realChatId: string
    /** Per-request generationId (idempotency key for Stage 4 slot-in). */
    generationId: string
    adapterKind: string
    streaming: boolean
    /** Upstream request timeout, forwarded to the server job. */
    timeoutMs?: number
    /** Used when job creation fails for infra reasons (network error / 404 /
     *  5xx — older or misbehaving server): the request transparently falls
     *  back to the direct proxied path. NOT used after the job exists. */
    fallbackFetch: typeof fetch
}

// Same auth mechanism the /proxy2 path uses (fetchViaProxy2). Shared with
// jobRecovery.ts (all /api/model-jobs endpoints expect it).
export async function authHeader(): Promise<Record<string, string>> {
    return { 'risu-auth': await forageStorage.createAuth() }
}

export function makeJobFetch(opts: JobFetchOptions): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString()
        const signal = init?.signal ?? undefined

        // 1. Create the job. Infra failures fall back to the direct path;
        //    409 (chat already generating) must surface, never fall back.
        let created: Response
        try {
            created = await fetch('/api/model-jobs', {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...await authHeader() },
                body: JSON.stringify({
                    targetUrl: url,
                    method: init?.method ?? 'POST',
                    headers: (init?.headers as Record<string, string>) ?? {},
                    body: typeof init?.body === 'string' ? init.body : undefined,
                    chatId: opts.realChatId,
                    generationId: opts.generationId,
                    adapterKind: opts.adapterKind,
                    streaming: opts.streaming,
                    timeoutMs: opts.timeoutMs,
                }),
                signal,
            })
        } catch (err) {
            if (signal?.aborted) throw err
            console.warn('[ModelJob] job creation failed, falling back to direct request path', err)
            return opts.fallbackFetch(input, init)
        }
        if (created.status === 409) {
            throw new ModelJobBusyError()
        }
        if (!created.ok) {
            console.warn('[ModelJob] job creation rejected (', created.status, '), falling back to direct request path')
            return opts.fallbackFetch(input, init)
        }
        const jobId: string = (await created.json()).jobId

        // Abort propagation: aborting the request DELETEs the job (server
        // aborts the upstream) and cancels the local stream fetch (same
        // signal). Fire-and-forget — abort must never hang on cleanup.
        const abortJob = () => {
            void (async () => {
                await fetch(`/api/model-jobs/${jobId}`, { method: 'DELETE', headers: await authHeader() })
            })().catch(() => {})
        }
        signal?.addEventListener('abort', abortJob, { once: true })
        const detach = () => signal?.removeEventListener('abort', abortJob)

        // 2. Attach to the journal stream (replay from byte 0 + live tail).
        let streamRes: Response
        try {
            streamRes = await fetch(`/api/model-jobs/${jobId}/stream`, { headers: await authHeader(), signal })
        } catch (err) {
            detach()
            throw err
        }
        const upstreamStatus = streamRes.headers.get('x-model-job-upstream-status')
        if (!streamRes.ok || upstreamStatus === null || !streamRes.body) {
            // Upstream never connected (or the stream endpoint failed) —
            // behave like a fetch network failure so the adapters' existing
            // network-error handling applies unchanged.
            detach()
            throw new TypeError('model job upstream connection failed')
        }

        // 3. Wrap the body: an ended HTTP stream does NOT prove completion
        //    (safety rule 1). On end, confirm with the job record and only
        //    close cleanly when the server says 'done'.
        const reader = streamRes.body.getReader()
        const wrapped = new ReadableStream<Uint8Array>({
            async pull(controller) {
                const { done, value } = await reader.read()
                if (!done) {
                    controller.enqueue(value)
                    return
                }
                detach()
                if (signal?.aborted) {
                    // Local abort raced the stream end — surface the abort.
                    throw new DOMException('The operation was aborted.', 'AbortError')
                }
                let job: { status?: string, error?: string } | null = null
                try {
                    const res = await fetch(`/api/model-jobs/${jobId}`, { headers: await authHeader() })
                    if (res.ok) job = await res.json()
                } catch {
                    // Status check unreachable — indistinguishable from a lost
                    // tail; fall through to connection-lost below.
                }
                if (job?.status === 'done') {
                    controller.close()
                    // Claim fire-and-forget: marks the job as collected so
                    // Stage 4's discovery skips it. The tiny crash window
                    // before the claim lands is covered by genId idempotency.
                    void (async () => {
                        await fetch(`/api/model-jobs/${jobId}/claim`, { method: 'POST', headers: await authHeader() })
                    })().catch(() => {})
                } else if (job?.status === 'failed' || job?.status === 'aborted') {
                    if (job.status === 'failed') {
                        // The user sees this failure live — claim it so the
                        // next boot's discovery doesn't insert a duplicate
                        // error into the chat. ('aborted' is excluded from the
                        // unclaimed list; nothing to do.)
                        void (async () => {
                            await fetch(`/api/model-jobs/${jobId}/claim`, { method: 'POST', headers: await authHeader() })
                        })().catch(() => {})
                    }
                    controller.error(new Error(job.error ?? `model job ${job.status}`))
                } else {
                    // Still 'running' (or status unknown): the connection was
                    // lost mid-tail. Error the stream so the normal error path
                    // reports it instead of saving a truncated message. NO
                    // retry here — the job is still running (a retry would
                    // 409); Stage 4's discovery recovers the response.
                    controller.error(new ModelJobConnectionLostError())
                }
            },
            cancel(reason) {
                detach()
                return reader.cancel(reason)
            },
        })
        return new Response(wrapped, {
            status: Number(upstreamStatus),
            headers: { 'content-type': streamRes.headers.get('content-type') ?? 'application/octet-stream' },
        })
    }) as typeof fetch
}
