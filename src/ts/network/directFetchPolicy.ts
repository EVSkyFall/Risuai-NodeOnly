const DIRECT_FETCH_FAILURE_TTL_MS = 5 * 60_000
const MAX_DIRECT_FETCH_FAILURES = 64

const directFetchFailures = new Map<string, number>()

function getRecordableOrigin(url: string): string | null {
    try {
        const origin = new URL(url).origin
        // Same-origin failures are real outages; proxying through the same origin would prove nothing.
        if (globalThis.location?.origin === origin) {
            return null
        }
        return origin
    }
    catch {
        return null
    }
}

export function shouldSkipDirectFetch(url: string, now: number): boolean {
    const origin = getRecordableOrigin(url)
    if (!origin) {
        return false
    }

    const failedAt = directFetchFailures.get(origin)
    if (failedAt === undefined) {
        return false
    }

    if (now - failedAt < DIRECT_FETCH_FAILURE_TTL_MS) {
        return true
    }

    // Expiring failures lets direct access recover after the server enables CORS mid-session.
    directFetchFailures.delete(origin)
    return false
}

export function recordDirectFetchFailure(url: string, now: number): void {
    const origin = getRecordableOrigin(url)
    if (!origin) {
        return
    }

    directFetchFailures.delete(origin)
    // Keep hostile or accidental origin churn from growing hot-path state without limit.
    if (directFetchFailures.size >= MAX_DIRECT_FETCH_FAILURES) {
        const oldestOrigin = directFetchFailures.keys().next().value
        if (oldestOrigin !== undefined) {
            directFetchFailures.delete(oldestOrigin)
        }
    }
    directFetchFailures.set(origin, now)
}

export function recordDirectFetchSuccess(url: string): void {
    const origin = getRecordableOrigin(url)
    if (origin) {
        directFetchFailures.delete(origin)
    }
}

export function resetDirectFetchPolicyForTests(): void {
    directFetchFailures.clear()
}
