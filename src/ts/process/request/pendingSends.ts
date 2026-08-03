import { writable } from 'svelte/store'
import { getDatabase } from 'src/ts/storage/database.svelte'
import { authHeader } from './jobFetch'

// Resumable sends (design note §C): a send registers a per-chat tombstone on
// the server when it starts and clears it when it concludes. If the tab dies
// mid-pipeline, the tombstone survives; the next discovery pass evaluates it
// (jobRecovery.ts) and — when the response truly never made it — flags the
// chat here so the UI re-runs the send once when that chat is opened.
//
// The tombstone holds NO pipeline state. Everything the re-run needs is
// already durable: the user message in the chat data, hypa partials in
// hypaV3Data, and a fired main request in the job journal (which job recovery
// handles instead of a re-run). Registration is gated on the server-side
// requests toggle; all server calls are fire-and-forget and failure-tolerant
// (an unreachable/older server degrades to exactly the pre-C behavior).

/** Chats with an interrupted send that should re-run when opened.
 *  Keyed by real chat.id. Consumed one-shot via takeResumable. */
export const resumableSends = writable<Map<string, { generationId?: string }>>(new Map())

function enabled(): boolean {
    try {
        return getDatabase()?.nodeOnlyServerSideRequests === true
    } catch {
        return false
    }
}

// Per-chat operation chain: register/clear/claim for the same chat execute in
// call order. Without it a fast conclude's DELETE can overtake the send's
// register POST on the network, resurrecting a tombstone for a send that
// already ended (→ one spurious auto re-send at the next boot).
const opChains = new Map<string, Promise<unknown>>()
function chained<T>(chatId: string, op: () => Promise<T>, fallback: T): Promise<T> {
    const prev = opChains.get(chatId) ?? Promise.resolve()
    const next = prev.then(op, op).catch(() => fallback)
    opChains.set(chatId, next)
    // Prune once settled if still the tail — keeps the map bounded.
    void next.then(() => {
        if (opChains.get(chatId) === next) opChains.delete(chatId)
    })
    return next
}

export function registerPendingSend(chatId: string, generationId: string): void {
    if (!enabled()) return
    void chained(chatId, async () => {
        await fetch('/api/pending-sends', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...await authHeader() },
            body: JSON.stringify({ chatId, generationId }),
        })
    }, undefined)
}

/** Clear the tombstone (send concluded) and drop any local resume flag.
 *  NOT gated on the toggle: a record made before the toggle was switched off
 *  must still be clearable. */
export function clearPendingSend(chatId: string, generationId?: string | null): void {
    resumableSends.update((m) => {
        const current = m.get(chatId)
        if (!current || (current.generationId ?? undefined) !== (generationId ?? undefined)) return m
        const next = new Map(m)
        next.delete(chatId)
        return next
    })
    void chained(chatId, async () => {
        await fetch(`/api/pending-sends/${encodeURIComponent(chatId)}`, {
            method: 'DELETE',
            headers: { 'content-type': 'application/json', ...await authHeader() },
            body: JSON.stringify({ generationId: generationId ?? null }),
        })
    }, undefined)
}

/** Atomically take the tombstone before resuming: the server deletes it and
 *  reports whether THIS caller got it. At most one device/tab can win, so an
 *  interrupted send is re-run at most once even with several clients around.
 *  False on any failure (older server, network) — then do not resume. */
export function claimPendingSend(chatId: string, generationId?: string | null): Promise<boolean> {
    return chained(chatId, async () => {
        const res = await fetch(`/api/pending-sends/${encodeURIComponent(chatId)}/claim`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...await authHeader() },
            body: JSON.stringify({ generationId: generationId ?? null }),
        })
        if (!res.ok) return false
        return (await res.json())?.claimed === true
    }, false)
}

/** Restore a tombstone consumed by a claim only when no newer send owns this
 * chat. A plain registration would overwrite that newer generation. */
export function restorePendingSendIfAbsent(chatId: string, generationId?: string): Promise<boolean> {
    return chained(chatId, async () => {
        const res = await fetch(`/api/pending-sends/${encodeURIComponent(chatId)}/restore`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...await authHeader() },
            body: JSON.stringify({ generationId }),
        })
        if (!res.ok) return false
        return (await res.json())?.restored === true
    }, false)
}

export interface PendingSendRecord {
    chatId: string
    generationId?: string | null
    createdAt?: number
}

/** All pending-send records. [] when the endpoint is unreachable (older
 *  server) — discovery then becomes a no-op. */
export async function listPendingSends(): Promise<PendingSendRecord[]> {
    try {
        const res = await fetch('/api/pending-sends', { headers: await authHeader() })
        if (!res.ok) return []
        const parsed = await res.json()
        return Array.isArray(parsed?.pendingSends) ? parsed.pendingSends : []
    } catch {
        return []
    }
}

export function markResumable(chatId: string, generationId?: string): void {
    resumableSends.update((m) => {
        const next = new Map(m)
        next.set(chatId, { generationId })
        return next
    })
}

/** One-shot consume, preserving the generation id needed for a safe restore. */
export function takeResumable(chatId: string): { generationId?: string } | undefined {
    let taken: { generationId?: string } | undefined
    resumableSends.update((m) => {
        if (!m.has(chatId)) return m
        taken = m.get(chatId)
        const next = new Map(m)
        next.delete(chatId)
        return next
    })
    return taken
}

export interface ResumePendingSendOptions {
    chatId: string
    generationId?: string
    generationKey: string
    isRunnable: () => boolean
    endsOnUser: () => boolean
    beginGeneration: (generationKey: string, controller: AbortController) => void
    endGeneration: (generationKey: string) => void
    send: (signal: AbortSignal) => Promise<unknown>
    onError?: (error: unknown) => void
}

export type ResumePendingSendResult = 'resumed' | 'deferred' | 'concluded' | 'lost'

/** Claim and resume once. Raw chat ids remain confined to pending-send I/O;
 * generation-state callbacks receive the caller's explicit generation key. */
export async function resumePendingSend(options: ResumePendingSendOptions): Promise<ResumePendingSendResult> {
    const { chatId, generationId, generationKey } = options
    if (!options.isRunnable()) {
        markResumable(chatId, generationId)
        return 'deferred'
    }
    if (!options.endsOnUser()) {
        clearPendingSend(chatId, generationId)
        return 'concluded'
    }
    if (!await claimPendingSend(chatId, generationId)) return 'lost'

    if (!options.isRunnable()) {
        if (await restorePendingSendIfAbsent(chatId, generationId)) {
            markResumable(chatId, generationId)
            return 'deferred'
        }
        return 'lost'
    }
    if (!options.endsOnUser()) {
        clearPendingSend(chatId, generationId)
        return 'concluded'
    }

    const controller = new AbortController()
    let began = false
    try {
        options.beginGeneration(generationKey, controller)
        began = true
        await options.send(controller.signal)
    } catch (error) {
        options.onError?.(error)
    } finally {
        if (began) options.endGeneration(generationKey)
    }
    return 'resumed'
}
