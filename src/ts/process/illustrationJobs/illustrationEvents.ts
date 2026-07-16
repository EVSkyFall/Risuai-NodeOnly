export type IllustrationWakeHintV1 = {
    protocolVersion: 1
    sequence: number
    kind: 'turn_changed' | 'job_changed'
    turnId: string
    jobId?: string
}

export type IllustrationWakeHintListener = (
    hint: IllustrationWakeHintV1,
) => unknown | PromiseLike<unknown>

const wakeHintListeners = new Set<IllustrationWakeHintListener>()
let wakeHintSequence = 0

export function subscribeIllustrationWakeHints(
    listener: IllustrationWakeHintListener,
): () => void {
    wakeHintListeners.add(listener)
    return () => wakeHintListeners.delete(listener)
}

export function emitIllustrationWakeHint(
    kind: IllustrationWakeHintV1['kind'],
    turnId: string,
    jobId?: string,
): IllustrationWakeHintV1 {
    const hint: IllustrationWakeHintV1 = Object.freeze({
        protocolVersion: 1,
        sequence: ++wakeHintSequence,
        kind,
        turnId,
        ...(jobId === undefined ? {} : { jobId }),
    })
    for (const listener of [...wakeHintListeners]) {
        queueMicrotask(() => {
            if (!wakeHintListeners.has(listener)) return
            try {
                void Promise.resolve(listener(hint)).catch(() => {})
            } catch {
                // Wake hints are optional. A listener must never affect durable work.
            }
        })
    }
    return hint
}
