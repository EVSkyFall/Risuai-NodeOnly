import { IllustrationLedgerUnavailableError } from './errors'
import type { IllustrationLockManager, IllustrationLockManagerAccessor } from './locks'

function defaultOperationLockManagerAccessor(): IllustrationLockManager | undefined {
    if (typeof navigator === 'undefined' || !navigator.locks?.request) return undefined
    return {
        request: async <T>(name: string, callback: () => T | Promise<T>): Promise<T> =>
            await navigator.locks.request(name, async () => await callback()),
    }
}

let operationLockManagerAccessor: IllustrationLockManagerAccessor = defaultOperationLockManagerAccessor

export function setIllustrationOperationLockManagerAccessorForTests(
    accessor: IllustrationLockManagerAccessor,
): () => void {
    const previous = operationLockManagerAccessor
    operationLockManagerAccessor = accessor
    return () => {
        operationLockManagerAccessor = previous
    }
}

export function resetIllustrationOperationLockManagerAccessorForTests(): void {
    operationLockManagerAccessor = defaultOperationLockManagerAccessor
}

export async function withIllustrationOperationLock<T>(
    name: string,
    callback: () => T | Promise<T>,
): Promise<T> {
    const manager = operationLockManagerAccessor()
    if (!manager) throw new IllustrationLedgerUnavailableError()
    return await manager.request(name, callback)
}
