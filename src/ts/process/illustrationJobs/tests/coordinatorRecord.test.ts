import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { InMemoryLockManager } from './inMemoryLockManager'

const harness = vi.hoisted(() => ({
    storageMap: new Map<string, Uint8Array>(),
    writes: [] as Array<{ draining: boolean; leaseId: string | null; version: number }>,
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: {
        async Init() {},
        async keys(prefix = '') {
            return [...harness.storageMap.keys()].filter((key) => key.startsWith(prefix))
        },
        async getItem(key: string) {
            return harness.storageMap.get(key) ?? null
        },
        async setItem(key: string, value: Uint8Array) {
            harness.storageMap.set(key, new Uint8Array(value))
            if (key === 'illustration:v1:coordinator') {
                harness.writes.push(JSON.parse(new TextDecoder().decode(value)))
            }
        },
        async removeItem(key: string) {
            harness.storageMap.delete(key)
        },
    },
}))

vi.mock('src/ts/parser/parser.svelte', () => ({
    hasher: vi.fn(async () => new Uint8Array(32)),
}))

const coordinatorModule = await import('../coordinatorRecord')
const featureModule = await import('../featureFlag')
const lockModule = await import('../locks')
const errorModule = await import('../errors')

const {
    COORDINATOR_LEASE_DURATION_MS,
    ORPHAN_TAKEOVER_COOLDOWN_MS,
    claimCoordinator,
    forceTakeoverCoordinator,
    getCoordinatorRecord,
    markCoordinatorDraining,
    releaseCoordinator,
    releaseCoordinatorFinal,
    setIllustrationFeatureEnabledWithCoordinatorDrain,
} = coordinatorModule
const { IllustrationFeatureDisabledError, setIllustrationFeatureEnabled } = featureModule
const {
    resetIllustrationLockManagerAccessorForTests,
    setIllustrationLockManagerAccessorForTests,
} = lockModule
const {
    IllustrationCoordinatorCooldownError,
    IllustrationCoordinatorDrainingError,
    IllustrationLedgerLeaseConflictError,
    IllustrationLedgerValidationError,
    IllustrationLedgerVersionConflictError,
} = errorModule

const BASE_TIME = Date.UTC(2026, 6, 15)
let lockManager: InMemoryLockManager

beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    harness.storageMap.clear()
    harness.writes.length = 0
    lockManager = new InMemoryLockManager()
    setIllustrationLockManagerAccessorForTests(() => lockManager)
    await setIllustrationFeatureEnabled(true)
})

afterEach(() => {
    resetIllustrationLockManagerAccessorForTests()
    vi.useRealTimers()
})

describe('global Agent coordinator record', () => {
    test('claims, renews without a fence bump, rejects a rival without bearer leakage, and expires at 60s', async () => {
        const first = await claimCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-a',
            holderRuntimeId: 'runtime-a',
        })
        expect(first).toEqual({
            protocolVersion: 1,
            version: 1,
            fence: 1,
            expiresAt: BASE_TIME + COORDINATOR_LEASE_DURATION_MS,
            ownedByCaller: true,
            draining: false,
        })

        vi.advanceTimersByTime(1_000)
        const renewed = await claimCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-a',
            holderRuntimeId: 'runtime-a',
            expectedVersion: first.version,
            fence: first.fence,
        })
        expect(renewed).toMatchObject({ version: 2, fence: 1, ownedByCaller: true })
        expect(renewed.expiresAt).toBe(BASE_TIME + 1_000 + COORDINATOR_LEASE_DURATION_MS)

        const rival = await claimCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-b',
            holderRuntimeId: 'runtime-b',
        })
        expect(rival).toMatchObject({ version: 2, fence: 1, ownedByCaller: false })
        expect(rival).not.toHaveProperty('leaseId')

        vi.advanceTimersByTime(COORDINATOR_LEASE_DURATION_MS)
        await expect(claimCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-b',
            holderRuntimeId: 'runtime-b',
            expectedVersion: renewed.version,
            fence: renewed.fence,
        })).rejects.toBeInstanceOf(IllustrationCoordinatorCooldownError)
        vi.advanceTimersByTime(ORPHAN_TAKEOVER_COOLDOWN_MS)
        const takeover = await claimCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-b',
            holderRuntimeId: 'runtime-b',
            expectedVersion: renewed.version,
            fence: renewed.fence,
        })
        expect(takeover).toMatchObject({ version: 3, fence: 2, ownedByCaller: true, draining: false })
    })

    test('durably marks draining before final release and a fresh owner clears it', async () => {
        const claimed = await claimCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-a',
            holderRuntimeId: 'runtime-a',
        })
        await releaseCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-a',
            expectedVersion: claimed.version,
            fence: claimed.fence,
            drain: true,
        })
        const draining = (await getCoordinatorRecord())!
        expect(draining).toMatchObject({
            version: 2,
            fence: 1,
            leaseId: 'coordinator-a',
            draining: true,
        })
        expect(harness.writes.at(-1)).toMatchObject({
            version: 2,
            leaseId: 'coordinator-a',
            draining: true,
        })

        await expect(releaseCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-a',
            expectedVersion: draining.version,
            fence: draining.fence,
            drain: false,
        })).rejects.toBeInstanceOf(IllustrationCoordinatorDrainingError)

        await releaseCoordinatorFinal({
            protocolVersion: 1,
            leaseId: 'coordinator-a',
            expectedVersion: draining.version,
            fence: draining.fence,
        })
        const released = (await getCoordinatorRecord())!
        expect(released).toMatchObject({ leaseId: null, draining: true, version: 3 })
        expect(harness.writes.slice(-2)).toEqual([
            expect.objectContaining({ leaseId: 'coordinator-a', draining: true, version: 2 }),
            expect.objectContaining({ leaseId: null, draining: true, version: 3 }),
        ])

        const fresh = await claimCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-b',
            holderRuntimeId: 'runtime-b',
            expectedVersion: released.version,
            fence: released.fence,
        })
        expect(fresh).toMatchObject({ version: 4, fence: 2, ownedByCaller: true, draining: false })
    })

    test('clears ownership immediately for a valid non-draining release', async () => {
        const claimed = await claimCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-a',
            holderRuntimeId: 'runtime-a',
        })
        await releaseCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-a',
            expectedVersion: claimed.version,
            fence: claimed.fence,
            drain: false,
        })
        expect(await getCoordinatorRecord()).toMatchObject({
            version: 2,
            leaseId: null,
            holderRuntimeId: null,
            expiresAt: 0,
            draining: false,
        })
        const released = (await getCoordinatorRecord())!
        await expect(claimCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-b',
            holderRuntimeId: 'runtime-b',
            expectedVersion: released.version,
            fence: released.fence,
        })).resolves.toMatchObject({ ownedByCaller: true, fence: 2 })
    })

    test('rejects claims while OFF and atomically drains the latest owner across a renew race', async () => {
        await setIllustrationFeatureEnabled(false)
        await expect(claimCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-a',
            holderRuntimeId: 'runtime-a',
        })).rejects.toBeInstanceOf(IllustrationFeatureDisabledError)
        expect(await getCoordinatorRecord()).toBeNull()

        await setIllustrationFeatureEnabled(true)
        const claimed = await claimCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-a',
            holderRuntimeId: 'runtime-a',
        })
        const renewing = claimCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-a',
            holderRuntimeId: 'runtime-a',
            expectedVersion: claimed.version,
            fence: claimed.fence,
        })
        const disabling = setIllustrationFeatureEnabledWithCoordinatorDrain(false)
        await expect(renewing).resolves.toMatchObject({ ownedByCaller: true })
        await expect(disabling).resolves.toMatchObject({
            featureEnabled: false,
            coordinator: expect.objectContaining({ draining: true }),
        })
        expect(await getCoordinatorRecord()).toMatchObject({
            leaseId: 'coordinator-a',
            draining: true,
            version: claimed.version + 2,
        })
    })

    test('preserves draining on same-owner renewal and clears it only on an expired takeover', async () => {
        const claimed = await claimCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-a',
            holderRuntimeId: 'runtime-a',
        })
        const draining = await markCoordinatorDraining({
            protocolVersion: 1,
            leaseId: 'coordinator-a',
            expectedVersion: claimed.version,
            fence: claimed.fence,
        })
        const renewed = await claimCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-a',
            holderRuntimeId: 'runtime-a',
            expectedVersion: draining.version,
            fence: draining.fence,
        })
        expect(renewed).toMatchObject({ fence: 1, ownedByCaller: true, draining: true })

        vi.advanceTimersByTime(COORDINATOR_LEASE_DURATION_MS)
        await expect(claimCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-b',
            holderRuntimeId: 'runtime-b',
            expectedVersion: renewed.version,
            fence: renewed.fence,
        })).rejects.toBeInstanceOf(IllustrationCoordinatorCooldownError)
        vi.advanceTimersByTime(ORPHAN_TAKEOVER_COOLDOWN_MS)
        const takeover = await claimCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-b',
            holderRuntimeId: 'runtime-b',
            expectedVersion: renewed.version,
            fence: renewed.fence,
        })
        expect(takeover).toMatchObject({ fence: 2, ownedByCaller: true, draining: false })
    })
})

describe('Coordinator Recovery Status V2 (§5)', () => {
    async function claimOwner(leaseId = 'coordinator-a', holderRuntimeId = 'runtime-a') {
        return await claimCoordinator({ protocolVersion: 1, leaseId, holderRuntimeId })
    }

    test('waitStatus surfaces a live foreign lease as typed leased data with a finite expiresAt', async () => {
        const owner = await claimOwner()

        // Default path: a live foreign lease is a non-owner snapshot (unchanged, no state).
        const legacy = await claimCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-b',
            holderRuntimeId: 'runtime-b',
        })
        expect(legacy).toMatchObject({ ownedByCaller: false, expiresAt: owner.expiresAt })
        expect(legacy).not.toHaveProperty('state')

        // Opt-in path: the same standby is typed DATA with the exact live lease expiry.
        const wait = await claimCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-b',
            holderRuntimeId: 'runtime-b',
            waitStatus: true,
        })
        expect(wait).toEqual({
            protocolVersion: 1,
            ownedByCaller: false,
            state: 'leased',
            expiresAt: owner.expiresAt,
            retryAt: null,
            canForceTakeover: false,
        })
    })

    test('waitStatus distinguishes a draining live foreign lease', async () => {
        const owner = await claimOwner()
        await markCoordinatorDraining({
            protocolVersion: 1,
            leaseId: 'coordinator-a',
            expectedVersion: owner.version,
            fence: owner.fence,
        })
        const drainingOwner = (await getCoordinatorRecord())!
        const wait = await claimCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-b',
            holderRuntimeId: 'runtime-b',
            waitStatus: true,
        })
        expect(wait).toEqual({
            protocolVersion: 1,
            ownedByCaller: false,
            state: 'draining',
            expiresAt: drainingOwner.expiresAt,
            retryAt: null,
            canForceTakeover: false,
        })
    })

    test('waitStatus preserves the exact orphan-cooldown retryAt where the default path throws', async () => {
        const owner = await claimOwner()
        vi.advanceTimersByTime(COORDINATOR_LEASE_DURATION_MS)
        const retryAt = owner.expiresAt + ORPHAN_TAKEOVER_COOLDOWN_MS

        // Default path: the retryAt lives only on the private Error and is lost at the RPC.
        await expect(claimCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-b',
            holderRuntimeId: 'runtime-b',
        })).rejects.toBeInstanceOf(IllustrationCoordinatorCooldownError)

        // Opt-in path: the exact bounded retryAt survives as data.
        const wait = await claimCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-b',
            holderRuntimeId: 'runtime-b',
            waitStatus: true,
        })
        expect(wait).toEqual({
            protocolVersion: 1,
            ownedByCaller: false,
            state: 'orphan-cooldown',
            expiresAt: null,
            retryAt,
            canForceTakeover: true,
        })
    })

    test('waitStatus must be a boolean', async () => {
        await claimOwner()
        await expect(claimCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-b',
            holderRuntimeId: 'runtime-b',
            waitStatus: 'yes' as unknown as boolean,
        })).rejects.toBeInstanceOf(IllustrationLedgerValidationError)
    })

    test('forceTakeoverCoordinator rejects a live owner, an unexpired lease, and stale versions', async () => {
        const owner = await claimOwner()

        // A live owner is never force-takeover-eligible.
        await expect(forceTakeoverCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-b',
            holderRuntimeId: 'runtime-b',
            confirmRisk: true,
            expectedVersion: owner.version,
        })).rejects.toBeInstanceOf(IllustrationLedgerLeaseConflictError)

        // confirmRisk is mandatory — never automatic.
        await expect(forceTakeoverCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-b',
            holderRuntimeId: 'runtime-b',
            confirmRisk: false as unknown as true,
            expectedVersion: owner.version,
        })).rejects.toBeInstanceOf(IllustrationLedgerValidationError)

        vi.advanceTimersByTime(COORDINATOR_LEASE_DURATION_MS)
        await expect(forceTakeoverCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-b',
            holderRuntimeId: 'runtime-b',
            confirmRisk: true,
            expectedVersion: owner.version + 5,
        })).rejects.toBeInstanceOf(IllustrationLedgerVersionConflictError)
    })

    test('forceTakeoverCoordinator CAS-takes an expired orphan, bypassing the cooldown', async () => {
        const owner = await claimOwner()
        vi.advanceTimersByTime(COORDINATOR_LEASE_DURATION_MS)
        const now = BASE_TIME + COORDINATOR_LEASE_DURATION_MS
        const taken = await forceTakeoverCoordinator({
            protocolVersion: 1,
            leaseId: 'coordinator-b',
            holderRuntimeId: 'runtime-b',
            confirmRisk: true,
            expectedVersion: owner.version,
            fence: owner.fence,
        })
        expect(taken).toEqual({
            protocolVersion: 1,
            version: owner.version + 1,
            fence: owner.fence + 1,
            expiresAt: now + COORDINATOR_LEASE_DURATION_MS,
            ownedByCaller: true,
            draining: false,
        })
        expect(await getCoordinatorRecord()).toMatchObject({
            leaseId: 'coordinator-b',
            holderRuntimeId: 'runtime-b',
            draining: false,
        })
    })

    test('concurrent force takeovers of an expired orphan admit exactly one winner', async () => {
        const owner = await claimOwner()
        vi.advanceTimersByTime(COORDINATOR_LEASE_DURATION_MS)
        const attempts = await Promise.allSettled([
            forceTakeoverCoordinator({
                protocolVersion: 1,
                leaseId: 'coordinator-b',
                holderRuntimeId: 'runtime-b',
                confirmRisk: true,
                expectedVersion: owner.version,
            }),
            forceTakeoverCoordinator({
                protocolVersion: 1,
                leaseId: 'coordinator-c',
                holderRuntimeId: 'runtime-c',
                confirmRisk: true,
                expectedVersion: owner.version,
            }),
        ])
        const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled')
        const rejected = attempts.filter((attempt) => attempt.status === 'rejected')
        expect(fulfilled).toHaveLength(1)
        expect(rejected).toHaveLength(1)
        expect((rejected[0] as PromiseRejectedResult).reason)
            .toBeInstanceOf(IllustrationLedgerVersionConflictError)
    })
})
