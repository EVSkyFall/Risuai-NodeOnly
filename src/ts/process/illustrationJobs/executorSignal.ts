let wakeListener: (() => void) | null = null

export function registerIllustrationExecutorWakeListener(listener: () => void): () => void {
    wakeListener = listener
    return () => {
        if (wakeListener === listener) wakeListener = null
    }
}

export function signalIllustrationExecutor(): void {
    wakeListener?.()
}
