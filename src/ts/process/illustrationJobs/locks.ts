import { IllustrationLedgerUnavailableError } from './errors'

export const ILLUSTRATION_LEDGER_LOCK_NAME = 'risu-illustration-ledger'
export const ILLUSTRATION_WORKER_LOCK_NAME = 'risu-illustration-worker'

export interface IllustrationLockManager {
    request<T>(name: string, callback: () => T | Promise<T>): Promise<T>
}

export type IllustrationLockManagerAccessor = () => IllustrationLockManager | undefined

function defaultLockManagerAccessor(): IllustrationLockManager | undefined {
    if (typeof navigator === 'undefined' || !navigator.locks?.request) {
        return undefined
    }
    return {
        request: async <T>(name: string, callback: () => T | Promise<T>): Promise<T> =>
            await navigator.locks.request(name, async () => await callback()),
    }
}

let lockManagerAccessor: IllustrationLockManagerAccessor = defaultLockManagerAccessor

export function setIllustrationLockManagerAccessorForTests(
    accessor: IllustrationLockManagerAccessor,
): () => void {
    const previous = lockManagerAccessor
    lockManagerAccessor = accessor
    return () => {
        lockManagerAccessor = previous
    }
}

export function resetIllustrationLockManagerAccessorForTests(): void {
    lockManagerAccessor = defaultLockManagerAccessor
}

export async function withIllustrationLedgerLock<T>(callback: () => T | Promise<T>): Promise<T> {
    const lockManager = lockManagerAccessor()
    if (!lockManager) {
        throw new IllustrationLedgerUnavailableError()
    }

    // Web Locks serialize tabs in one browser/origin. Cross-device writers are
    // excluded by the server's single-active-session model, not by this lock.
    return await lockManager.request(ILLUSTRATION_LEDGER_LOCK_NAME, callback)
}
