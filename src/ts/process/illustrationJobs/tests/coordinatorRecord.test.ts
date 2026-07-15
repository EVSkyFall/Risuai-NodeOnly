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
const lockModule = await import('../locks')
const errorModule = await import('../errors')

const {
    COORDINATOR_LEASE_DURATION_MS,
    claimCoordinator,
    getCoordinatorRecord,
    markCoordinatorDraining,
    releaseCoordinator,
    releaseCoordinatorFinal,
} = coordinatorModule
const {
    resetIllustrationLockManagerAccessorForTests,
    setIllustrationLockManagerAccessorForTests,
} = lockModule
const { IllustrationCoordinatorDrainingError } = errorModule

const BASE_TIME = Date.UTC(2026, 6, 15)
let lockManager: InMemoryLockManager

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    harness.storageMap.clear()
    harness.writes.length = 0
    lockManager = new InMemoryLockManager()
    setIllustrationLockManagerAccessorForTests(() => lockManager)
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
