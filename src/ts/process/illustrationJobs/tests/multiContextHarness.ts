// Gate 0 multi-context test harness (request §4).
//
// PURPOSE
// -------
// Model the shape 08d4f052 made real: two independent browser writers over one
// shared, server-persisted illustration store. It exists so the five §4 races can
// be made to manifest deterministically as automated reproductions.
//
// WHAT IS ISOLATED PER "BROWSER" CONTEXT
//   - the IllustrationJobStore instance (constructed with its own injected lock
//     domain via the Gate 0 seam in store.ts)
//   - the lock manager (a dedicated InMemoryLockManager) + its accessor — so the
//     two contexts do NOT serialize against each other the way real Web Locks in
//     one browser would; this is exactly what makes cross-browser races reachable
//   - the store's pendingTurnMirror (a per-instance field; two store instances get
//     two mirrors, matching two browsers each caching the durable index separately)
//
// WHAT REMAINS SHARED (KNOWN LIMITATION — Codex design-review finding #23)
//   Two store instances + two injected lock managers in ONE vitest realm are NOT
//   two real browser processes. The following module-global state lives once per
//   JS realm and is therefore shared between the simulated browsers:
//     - the module-global lock accessors in locks.ts (`lockManagerAccessor`) and
//       operationLock.ts (`operationLockManagerAccessor`). Each context BYPASSES
//       them for the paths this harness drives (store mutations go through the
//       injected `ledgerLockAccessor`; claimCoordinator takes an explicit
//       lockDomain). But any code path that still calls the module-global
//       `withIllustrationLedgerLock` / `withIllustrationOperationLock` directly
//       (e.g. coordinator.ts materialize/operation-lock paths, executor.ts) would
//       share one domain across both contexts and is NOT faithfully isolated here.
//     - any module-level cache in store.ts / coordinatorRecord.ts (none today
//       beyond the per-instance mirror, but a future one would leak).
//     - the shared server store itself (SharedForageStore.map) — this one is
//       shared BY DESIGN: it stands in for the single Node server's KV, which is
//       the correct shape, not a leak.
//   Consequence: this harness reliably reproduces lost-update / dual-claim races
//   whose ONLY required ingredient is "two independent lock domains over one
//   shared store". It cannot prove the absence of a race that depends on genuine
//   realm isolation. That is accepted for S0 (Gate 0) — the job is to pin the
//   races RED, not to certify isolation.
//
// SEAM STABILITY (Codex finding #23b)
//   Repro tests must obtain EVERYTHING through the returned context objects
//   (`browserA` / `browserB`) and this module's `SharedForageStore` — never by
//   importing the production `illustrationJobStore` singleton or `claimCoordinator`
//   directly. A later slice can then swap in stronger isolation (separate workers,
//   real realms, a real spawned server) by reimplementing `createMultiBrowserHarness`
//   and `SharedForageStore` WITHOUT rewriting the reproductions.

import { IllustrationJobStore } from '../store'
import { InMemoryLockManager } from './inMemoryLockManager'
import { claimCoordinator as claimCoordinatorRecord } from '../coordinatorRecord'
import type { ClaimCoordinatorInput, ClaimCoordinatorResult } from '../coordinatorRecord'
import type { IllustrationLockManager, IllustrationLockManagerAccessor } from '../locks'

// A one-shot awaitable interleaving gate: pause the next get/set of a chosen key
// until the caller releases it. Lets a test force two contexts to genuinely race a
// read-modify-write with no real timers — the read/write ordering is driven purely
// by promise resolution, so it stays deterministic under vi.useFakeTimers().
export interface StorageGateHandle {
    // Resolves once the gated operation has entered the gate (read/written its
    // pre-image and parked). Await this before kicking off the racing context.
    readonly entered: Promise<void>
    // Let the parked operation proceed with its (already-computed) write/read.
    release(): void
}

interface ArmedGate {
    readonly enter: () => void
    readonly released: Promise<void>
}

/**
 * The single shared server-side KV stand-in. One Map, one bulk-read contract that
 * mirrors the Node `/api/assets/bulk-read` server behavior (missing keys omitted,
 * results correlated by key), plus per-key one-shot interleaving gates.
 *
 * A test wires this into the `src/ts/globalApi.svelte` forageStorage mock so BOTH
 * browser contexts' stores route through the one Map.
 */
export class SharedForageStore {
    readonly map = new Map<string, Uint8Array>()
    private readonly setGates = new Map<string, ArmedGate>()
    private readonly getGates = new Map<string, ArmedGate>()

    /** Pause the next setItem(key) until the returned handle is released. */
    armNextSet(key: string): StorageGateHandle {
        return this.arm(this.setGates, key)
    }

    /** Pause the next getItem(key) until the returned handle is released. */
    armNextGet(key: string): StorageGateHandle {
        return this.arm(this.getGates, key)
    }

    private arm(gates: Map<string, ArmedGate>, key: string): StorageGateHandle {
        let enter!: () => void
        const entered = new Promise<void>((resolve) => {
            enter = resolve
        })
        let releaseResolve!: () => void
        const released = new Promise<void>((resolve) => {
            releaseResolve = resolve
        })
        gates.set(key, { enter, released })
        return { entered, release: () => releaseResolve() }
    }

    private async passGate(gates: Map<string, ArmedGate>, key: string): Promise<void> {
        const gate = gates.get(key)
        if (!gate) return
        gates.delete(key) // one-shot
        gate.enter()
        await gate.released
    }

    reset(): void {
        this.map.clear()
        this.setGates.clear()
        this.getGates.clear()
    }

    // ── forageStorage-compatible surface ──────────────────────────────────────
    async Init(): Promise<void> {}

    async keys(prefix = ''): Promise<string[]> {
        return [...this.map.keys()].filter((key) => key.startsWith(prefix))
    }

    async getItem(key: string): Promise<Uint8Array | null> {
        await this.passGate(this.getGates, key)
        return this.map.get(key) ?? null
    }

    async getItems(keys: string[]): Promise<{ key: string; value: Uint8Array }[]> {
        // Mirror the Node bulk-read server contract: missing keys are silently
        // omitted (no null placeholder); the caller correlates by the `key` field.
        const results: { key: string; value: Uint8Array }[] = []
        for (const key of keys) {
            const value = this.map.get(key)
            if (value !== undefined) results.push({ key, value: new Uint8Array(value) })
        }
        return results
    }

    async setItem(key: string, value: Uint8Array): Promise<void> {
        await this.passGate(this.setGates, key)
        this.map.set(key, new Uint8Array(value))
    }

    async removeItem(key: string): Promise<void> {
        this.map.delete(key)
    }
}

export interface BrowserContext {
    readonly name: string
    readonly store: IllustrationJobStore
    readonly lockManager: IllustrationLockManager
    readonly lockAccessor: IllustrationLockManagerAccessor
    /** claimCoordinator bound to THIS context's independent lock domain. */
    claimCoordinator(input: ClaimCoordinatorInput): Promise<ClaimCoordinatorResult>
    /** Drop this context's store's pendingTurnMirror (per-instance isolation). */
    resetPendingMirror(): void
}

export interface MultiBrowserHarness {
    readonly browserA: BrowserContext
    readonly browserB: BrowserContext
    /** Reset both contexts' per-instance pending mirrors. */
    reset(): void
}

function createBrowserContext(name: string): BrowserContext {
    const lockManager = new InMemoryLockManager()
    const lockAccessor: IllustrationLockManagerAccessor = () => lockManager
    const store = new IllustrationJobStore({ ledgerLockAccessor: lockAccessor })
    return {
        name,
        store,
        lockManager,
        lockAccessor,
        claimCoordinator: (input) => claimCoordinatorRecord(input, lockAccessor),
        resetPendingMirror: () => store.__resetPendingTurnIndexMirrorForTests(),
    }
}

/**
 * Build two independent browser contexts over one shared server store. The shared
 * store is the caller-owned `SharedForageStore` wired into the forageStorage mock;
 * both contexts reach it implicitly through that module mock, so nothing here needs
 * a direct reference to it.
 */
export function createMultiBrowserHarness(): MultiBrowserHarness {
    const browserA = createBrowserContext('browserA')
    const browserB = createBrowserContext('browserB')
    return {
        browserA,
        browserB,
        reset: () => {
            browserA.resetPendingMirror()
            browserB.resetPendingMirror()
        },
    }
}
