export function throwIfAborted(signal?: AbortSignal | null): void {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
}

// The factory lets us skip a guest hook when the generation has already stopped.
// Keep observing the guest promise after abort, without cancelling the guest.
export function raceAbort<T>(run: () => T | PromiseLike<T>, signal?: AbortSignal | null): Promise<T> {
    if (!signal) {
        try {
            return Promise.resolve(run())
        } catch (error) {
            return Promise.reject(error)
        }
    }
    return new Promise<T>((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener('abort', onAbort)
        const onAbort = () => {
            cleanup()
            reject(new DOMException('Aborted', 'AbortError'))
        }
        if (signal?.aborted) {
            onAbort()
            return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        let result: T | PromiseLike<T>
        try {
            result = run()
        } catch (error) {
            cleanup()
            reject(error)
            return
        }
        Promise.resolve(result).then(value => {
            cleanup()
            if (signal?.aborted) onAbort()
            else resolve(value)
        }, error => {
            cleanup()
            reject(error)
        })
    })
}
