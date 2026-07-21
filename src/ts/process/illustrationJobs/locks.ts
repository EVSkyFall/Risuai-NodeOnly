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

    // Web Locks serialize tabs in one browser/origin ONLY. Since 08d4f052 removed
    // the server's single-active-session model, NOTHING excludes concurrent
    // cross-browser/device writers — this lock is contention reduction, not a
    // cross-context fence. Multi-context safety is the MCV2 track's job
    // (server-authoritative CAS); until it lands, cross-browser illustration
    // writes are last-writer-wins (Gate 0 repros pin the races).
    return await lockManager.request(ILLUSTRATION_LEDGER_LOCK_NAME, callback)
}

// Gate 0 multi-context seam: run a ledger-lock body under an explicitly chosen
// lock domain instead of the module-global accessor. `accessor === undefined` is
// the production default and delegates verbatim to withIllustrationLedgerLock, so
// the default path (and its fail-closed-when-no-lock-manager semantics) is
// byte-identical to the pre-seam behavior. A test harness passes a per-context
// accessor so two store/coordinator "browsers" can hold two independent lock
// domains over one shared server store — the shape 08d4f052 made real.
export async function withIllustrationLedgerLockDomain<T>(
    accessor: IllustrationLockManagerAccessor | undefined,
    callback: () => T | Promise<T>,
): Promise<T> {
    if (!accessor) {
        return await withIllustrationLedgerLock(callback)
    }
    const lockManager = accessor()
    if (!lockManager) {
        throw new IllustrationLedgerUnavailableError()
    }
    return await lockManager.request(ILLUSTRATION_LEDGER_LOCK_NAME, callback)
}
