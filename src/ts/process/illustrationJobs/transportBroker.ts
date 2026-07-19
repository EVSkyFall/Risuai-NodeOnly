// ---------------------------------------------------------------------------
// Provider-wide illustration concurrency broker (request §8).
//
// A single broker instance serializes provider dispatch by CONCURRENCY KEY. The only
// wired acquirer today is the V2 background executor (processQueuedV2Job); the queue
// is process-wide across those executor dispatches rather than executor-internal.
// Distinct keys never serialize against each other, so different backends run in
// parallel; jobs on the same key honor that key's user-set maxConcurrency. The
// interactive-first priority machinery below (and the 'interactive' BrokerPriority)
// is in place for the eventual interactive stableDiff wiring, but that wiring was
// deliberately deferred: no interactive image request acquires against this broker
// yet, so today every acquirer is a 'background' executor dispatch. The CURRENT
// policy for a key is applied per acquire (request §4: queue tuning is mutable and
// never part of the target fingerprint), so a maxConcurrency/priority change alone
// never invalidates an in-flight target.
//
// This module owns no target/prompt state — it is a pure gate. Certainty and text
// preservation live in the transport dispatch layer.
// ---------------------------------------------------------------------------

export type BrokerPriority = 'interactive' | 'background'

export type BrokerQueuePolicy = {
    maxConcurrency: number
    priorityPolicy: 'interactive-first' | 'fifo'
}

export type BrokerRelease = () => void

type Waiter = {
    priority: BrokerPriority
    seq: number
    resolve: (release: BrokerRelease) => void
}

type KeyState = {
    active: number
    policy: BrokerQueuePolicy
    waiters: Waiter[]
}

function normalizePolicy(policy: BrokerQueuePolicy): BrokerQueuePolicy {
    const maxConcurrency = Number.isSafeInteger(policy.maxConcurrency) && policy.maxConcurrency >= 1
        ? policy.maxConcurrency
        : 1
    const priorityPolicy = policy.priorityPolicy === 'fifo' ? 'fifo' : 'interactive-first'
    return { maxConcurrency, priorityPolicy }
}

export class ProviderConcurrencyBroker {
    private readonly keys = new Map<string, KeyState>()
    private seqCounter = 0

    private stateFor(concurrencyKey: string, policy: BrokerQueuePolicy): KeyState {
        const normalized = normalizePolicy(policy)
        const existing = this.keys.get(concurrencyKey)
        if (existing) {
            // The current policy for this key always wins (request §4).
            existing.policy = normalized
            // A maxConcurrency raise must hand the newly-available capacity to any
            // already-queued waiters BEFORE the calling acquire()'s fast-path admit.
            // Otherwise a later (e.g. background) acquirer takes the freed slot ahead
            // of earlier-queued (e.g. interactive) waiters — a priority inversion and
            // §8 interactive-first starvation violation — and the extra slots would
            // otherwise sit idle until an unrelated release() finally pumps (capacity
            // underuse). The waiters.length guard keeps a brand-new/idle key from being
            // deleted mid-acquire by pump()'s empty-key cleanup.
            if (existing.waiters.length > 0) {
                this.pump(concurrencyKey, existing)
            }
            return existing
        }
        const created: KeyState = { active: 0, policy: normalized, waiters: [] }
        this.keys.set(concurrencyKey, created)
        return created
    }

    // Acquire a dispatch slot for `concurrencyKey`. Resolves with an idempotent
    // release fn once a slot is available. Interactive callers on an interactive-first
    // key jump the queue ahead of background callers.
    acquire(
        concurrencyKey: string,
        policy: BrokerQueuePolicy,
        priority: BrokerPriority,
    ): Promise<BrokerRelease> {
        const state = this.stateFor(concurrencyKey, policy)
        if (state.active < state.policy.maxConcurrency) {
            state.active += 1
            return Promise.resolve(this.makeRelease(concurrencyKey))
        }
        return new Promise<BrokerRelease>((resolve) => {
            state.waiters.push({ priority, seq: this.seqCounter++, resolve })
        })
    }

    private makeRelease(concurrencyKey: string): BrokerRelease {
        let released = false
        return () => {
            if (released) return
            released = true
            this.release(concurrencyKey)
        }
    }

    private release(concurrencyKey: string): void {
        const state = this.keys.get(concurrencyKey)
        if (!state) return
        state.active = Math.max(0, state.active - 1)
        this.pump(concurrencyKey, state)
    }

    private pump(concurrencyKey: string, state: KeyState): void {
        while (state.active < state.policy.maxConcurrency && state.waiters.length > 0) {
            const index = this.selectWaiterIndex(state)
            const [waiter] = state.waiters.splice(index, 1)
            state.active += 1
            waiter.resolve(this.makeRelease(concurrencyKey))
        }
        if (state.active === 0 && state.waiters.length === 0) {
            this.keys.delete(concurrencyKey)
        }
    }

    private selectWaiterIndex(state: KeyState): number {
        if (state.policy.priorityPolicy === 'fifo') {
            // Pure arrival order.
            let bestIndex = 0
            for (let i = 1; i < state.waiters.length; i += 1) {
                if (state.waiters[i].seq < state.waiters[bestIndex].seq) bestIndex = i
            }
            return bestIndex
        }
        // interactive-first: any interactive waiter outranks every background waiter;
        // ties broken by arrival order so no interactive request is starved.
        let bestIndex = 0
        for (let i = 1; i < state.waiters.length; i += 1) {
            const candidate = state.waiters[i]
            const best = state.waiters[bestIndex]
            const candidateRank = candidate.priority === 'interactive' ? 0 : 1
            const bestRank = best.priority === 'interactive' ? 0 : 1
            if (candidateRank < bestRank || (candidateRank === bestRank && candidate.seq < best.seq)) {
                bestIndex = i
            }
        }
        return bestIndex
    }

    // Test/diagnostic introspection.
    activeCount(concurrencyKey: string): number {
        return this.keys.get(concurrencyKey)?.active ?? 0
    }

    waitingCount(concurrencyKey: string): number {
        return this.keys.get(concurrencyKey)?.waiters.length ?? 0
    }
}

// The process-wide broker for V2 executor dispatch. A single instance is what makes
// the queue provider/target-WIDE rather than executor-internal (request §8). The
// interactive stableDiff paths are NOT yet wired to it (deferred); until they are,
// the V2 background executor is its sole acquirer.
export const illustrationTransportBroker = new ProviderConcurrencyBroker()
