// Gate 0 RED reproductions (request §4). Each repro asserts the DESIRED post-fix
// invariant so it FAILS today, and is wrapped in `test.fails` so the suite stays
// green while the race is red. When a later slice fixes the behavior, `.fails`
// starts erroring and that slice flips the repro into a normal test — enforced
// red -> green discipline.
//
// Everything two-browser is obtained through the harness context objects
// (browserA / browserB) and SharedForageStore — never by importing the production
// illustrationJobStore singleton or claimCoordinator directly — so a later slice
// can swap in stronger isolation without rewriting these reproductions
// (Codex design-review finding #23b). See multiContextHarness.ts for the explicit
// per-context-isolated vs realm-shared state ledger.
//
// Determinism: no real timers, no real sleeps. Interleaving is forced with the
// SharedForageStore's per-key one-shot gates (pure promise resolution) under
// vi.useFakeTimers()+vi.setSystemTime, so Date.now() is fixed.

import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { IllustrationV3BridgeDependencies } from '../v3Bridge'
import type { IllustrationCoordinatorRecordV1 } from '../types'

const mock = vi.hoisted(() => ({
    store: null as unknown as {
        Init(): Promise<void>
        keys(prefix?: string): Promise<string[]>
        getItem(key: string): Promise<Uint8Array | null>
        getItems(keys: string[]): Promise<{ key: string; value: Uint8Array }[]>
        setItem(key: string, value: Uint8Array): Promise<void>
        removeItem(key: string): Promise<void>
    },
}))

// One shared server-store stand-in for BOTH simulated browsers (the correct shape:
// one Node server KV, two independent client lock domains).
vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: {
        Init: () => mock.store.Init(),
        keys: (prefix?: string) => mock.store.keys(prefix ?? ''),
        getItem: (key: string) => mock.store.getItem(key),
        getItems: (keys: string[]) => mock.store.getItems(keys),
        setItem: (key: string, value: Uint8Array) => mock.store.setItem(key, value),
        removeItem: (key: string) => mock.store.removeItem(key),
    },
}))

vi.mock('src/ts/parser/parser.svelte', () => ({
    hasher: vi.fn(async () => new Uint8Array(32)),
}))

const harnessMod = await import('./multiContextHarness')
const featureMod = await import('../featureFlag')
const coordinatorRecordMod = await import('../coordinatorRecord')
const storeMod = await import('../store')
const v3BridgeMod = await import('../v3Bridge')

const { SharedForageStore, createMultiBrowserHarness } = harnessMod
const { setIllustrationFeatureEnabled } = featureMod
const { ILLUSTRATION_COORDINATOR_KEY } = coordinatorRecordMod
const { ILLUSTRATION_PENDING_TURNS_KEY } = storeMod
const { IllustrationV3HostLlmRegistry, toIllustrationV3RpcError } = v3BridgeMod

const BASE_TIME = Date.UTC(2026, 0, 1)
const sharedStore = new SharedForageStore()
mock.store = sharedStore

let harness: ReturnType<typeof createMultiBrowserHarness>

function decodeStored<T>(key: string): T | null {
    const value = sharedStore.map.get(key)
    return value ? (JSON.parse(new TextDecoder().decode(value)) as T) : null
}

beforeEach(async () => {
    sharedStore.reset()
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    harness = createMultiBrowserHarness()
    harness.reset()
    // Shared server-side feature flag (both browsers read it).
    await setIllustrationFeatureEnabled(true)
})

afterEach(() => {
    vi.useRealTimers()
})

// ── Repro 1 (request §4.1): dual coordinator claim ────────────────────────────
test.fails(
    'Repro 1 (dual claim): two lock domains claim the coordinator concurrently and both win',
    async () => {
        const { browserA, browserB } = harness
        const inputA = { protocolVersion: 1 as const, leaseId: 'lease-a', holderRuntimeId: 'runtime-a' }
        const inputB = { protocolVersion: 1 as const, leaseId: 'lease-b', holderRuntimeId: 'runtime-b' }

        // Park browserA's coordinator WRITE right after it read the absent record,
        // so browserB reads the same absent record and mints its own ownership first.
        const gate = sharedStore.armNextSet(ILLUSTRATION_COORDINATOR_KEY)
        const claimA = browserA.claimCoordinator(inputA)
        await gate.entered

        // browserB runs to completion under its OWN lock domain (no serialization
        // against A) and claims ownership from the still-absent record.
        const resultB = await browserB.claimCoordinator(inputB)

        // Release A's parked write: it overwrites with its own version-1 ownership.
        gate.release()
        const resultA = await claimA

        // DESIRED INVARIANT (server-authoritative CAS + fence, S1/S4): across the
        // whole server authority, exactly one caller owns the coordinator. Today
        // both in-memory-CAS claims independently succeed as owner.
        const owners = [resultA, resultB].filter((result) => result.ownedByCaller === true)
        expect(owners).toHaveLength(1)
    },
)

// ── Repro 3 (request §4.3): pending-turn index lost update ─────────────────────
test.fails(
    'Repro 3 (pending index lost update): concurrent turn appends discard one entry',
    async () => {
        const { browserA, browserB } = harness

        // Seed a pre-existing pending index so both appends take the mirror-delta
        // read-modify-write path rather than the self-healing full rebuild-from-scan
        // path (which would re-derive both turns from their separate turn keys).
        await browserA.store.createTurn({ turnId: 'seed-turn', idempotencyKey: 'create:seed' })
        // Drop both per-instance mirrors so each re-reads the durable index fresh.
        harness.reset()

        // Park browserA's pendingTurns WRITE after it read [seed-turn].
        const gate = sharedStore.armNextSet(ILLUSTRATION_PENDING_TURNS_KEY)
        const createA = browserA.store.createTurn({ turnId: 'turn-a', idempotencyKey: 'create:a' })
        await gate.entered

        // browserB appends under its own lock domain. It reads the durable index that
        // still shows only [seed-turn] (A's write is parked), so it never sees turn-a.
        await browserB.store.createTurn({ turnId: 'turn-b', idempotencyKey: 'create:b' })

        // Release A: it overwrites the whole index with [seed-turn, turn-a],
        // discarding browserB's turn-b (whole-list overwrite, no CAS).
        gate.release()
        await createA

        // DESIRED INVARIANT (pendingTurns CAS loop, S2): both appends survive.
        const durable = decodeStored<{ schemaVersion: 1; turnIds: string[] }>(ILLUSTRATION_PENDING_TURNS_KEY)
        expect(durable?.turnIds ?? []).toEqual(expect.arrayContaining(['turn-a', 'turn-b']))
    },
)

// ── Repro 2 (request §4.2 support): Core-owned heartbeat module ────────────────
test.fails(
    'Repro 2 (heartbeat absence): a Core-owned coordinator heartbeat module exists',
    async () => {
        // DESIRED (S4): src/ts/process/illustrationJobs/coordinatorHeartbeat.ts exists
        // and exports a startable Core-owned heartbeat, so a healthy owner does not
        // depend on the plugin's 15s reconcile cadence to keep its lease. Today the
        // module is absent, so the dynamic import rejects. The variable specifier +
        // @vite-ignore keeps Vite from failing the whole file at transform time on the
        // currently-missing module; the rejection surfaces at runtime as intended.
        const specifier = '../coordinatorHeartbeat'
        const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>
        expect(typeof mod.startCoordinatorHeartbeat).toBe('function')
    },
)

// ── Repro 5 (request §4.5): standby enqueue ────────────────────────────────────
test.fails(
    'Repro 5a (standby enqueue): an any-tab enqueue surface exists',
    () => {
        // DESIRED (S6): a non-owner (standby) context can register the current variant
        // via a durable, ownership-free enqueue surface — no coordinator claim. Probe
        // is a feature-detect; the exact surface name/location is finalized in S6
        // (provisional: an enqueueCurrentVariantIntent method reachable from the store
        // context). Today no such surface exists.
        const probe = harness.browserB.store as unknown as Record<string, unknown>
        expect(typeof probe.enqueueCurrentVariantIntent).toBe('function')
    },
)

test(
    'Repro 5b (legacy-pin): a non-owner requestCurrentVariant path is rejected with coordinator_required',
    async () => {
        // LEGACY-PIN — must hold forever in legacy mode. The ownership gate for manual
        // capture lives at the host-registry runOwned layer (v3Bridge requireOwnerLocked),
        // which _ijRequestCurrentVariant is wrapped in: a standby (non-owner) runtime is
        // rejected with [IJ:coordinator_required]. Pinning the CURRENT behavior ensures a
        // later slice's any-tab enqueue does NOT silently relax the legacy owner-gate.
        const now = BASE_TIME
        const ownerCoordinator: IllustrationCoordinatorRecordV1 = {
            version: 1,
            fence: 1,
            leaseId: 'owner-lease',
            holderRuntimeId: 'owner-runtime',
            expiresAt: now + 5_000,
            draining: false,
            updatedAt: now,
        }
        // Minimal deps: runOwned's requireOwnerLocked only reads now/isFeatureEnabled/
        // getCoordinatorRecord and the registered-runtimes set. Cast the partial to the
        // full deps type; the untouched fields are never reached on this gate path.
        const deps = {
            now: () => now,
            isFeatureEnabled: async () => true,
            getCoordinatorRecord: async () => ownerCoordinator,
        } as unknown as IllustrationV3BridgeDependencies

        const registry = new IllustrationV3HostLlmRegistry(deps)
        registry.registerRuntime('standby-runtime')

        const error = await registry
            .runOwned('standby-runtime', {}, async () => 'should-not-run')
            .then(() => null)
            .catch((caught: unknown) => caught)

        // The operation never ran, and the internal gate carries the typed code…
        expect((error as { code?: string } | null)?.code).toBe('coordinator_required')
        // …which the RPC boundary (toIllustrationV3RpcError, used by every _ij* method)
        // encodes as the [IJ:coordinator_required] wire message the plugin observes.
        expect(toIllustrationV3RpcError(error).message).toContain('[IJ:coordinator_required]')
    },
)
