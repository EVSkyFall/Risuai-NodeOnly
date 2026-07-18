import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { InMemoryLockManager } from './inMemoryLockManager'

const { storageMap, storageControl } = vi.hoisted(() => ({
    storageMap: new Map<string, Uint8Array>(),
    storageControl: { failGetKey: null as string | null },
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: {
        async Init() {},
        async keys(prefix = '') {
            return [...storageMap.keys()].filter((key) => key.startsWith(prefix))
        },
        async getItem(key: string) {
            if (storageControl.failGetKey === key) throw new Error('injected read failure')
            return storageMap.get(key) ?? null
        },
        async setItem(key: string, value: Uint8Array) {
            storageMap.set(key, new Uint8Array(value))
        },
        async removeItem(key: string) {
            storageMap.delete(key)
        },
    },
}))

vi.mock('src/ts/parser/parser.svelte', () => ({
    hasher: vi.fn(async () => new Uint8Array(32)),
}))

const capturePolicyModule = await import('../capturePolicy')
const lockModule = await import('../locks')
const errorModule = await import('../errors')

const {
    ILLUSTRATION_CAPTURE_POLICY_KEY,
    getCapturePolicy,
    isAutomaticCaptureAdmitted,
    readDurableCaptureMode,
    setCaptureMode,
    writeDurableCaptureMode,
} = capturePolicyModule
const {
    resetIllustrationLockManagerAccessorForTests,
    setIllustrationLockManagerAccessorForTests,
} = lockModule
const { IllustrationLedgerUnavailableError, IllustrationLedgerValidationError } = errorModule

function encode(value: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(value))
}

let lockManager: InMemoryLockManager

beforeEach(() => {
    storageMap.clear()
    storageControl.failGetKey = null
    lockManager = new InMemoryLockManager()
    setIllustrationLockManagerAccessorForTests(() => lockManager)
})

afterEach(() => {
    resetIllustrationLockManagerAccessorForTests()
})

describe('capture policy V1 durable mode', () => {
    // Acceptance 9: reload restores read-only, missing record -> manual default.
    test('defaults to manual when the policy record is absent', async () => {
        expect(await readDurableCaptureMode()).toBe('manual')
        expect(await getCapturePolicy()).toEqual({
            protocolVersion: 1,
            capturePolicyContractVersion: 1,
            mode: 'manual',
        })
        expect(await isAutomaticCaptureAdmitted()).toBe(false)
    })

    test('persists and restores the mode across a reload (durable round-trip)', async () => {
        expect(await setCaptureMode({ protocolVersion: 1, mode: 'automatic' }))
            .toEqual({ protocolVersion: 1, mode: 'automatic' })
        expect(await readDurableCaptureMode()).toBe('automatic')
        expect(await isAutomaticCaptureAdmitted()).toBe(true)
        expect(await getCapturePolicy()).toEqual({
            protocolVersion: 1,
            capturePolicyContractVersion: 1,
            mode: 'automatic',
        })

        await writeDurableCaptureMode('manual')
        expect(await readDurableCaptureMode()).toBe('manual')
        expect(await isAutomaticCaptureAdmitted()).toBe(false)
    })

    // Acceptance 9: an invalid record decodes as the manual default, so no
    // automatic cost work is ever admitted from a malformed policy.
    test('an invalid stored record decodes as the manual default', async () => {
        const invalidRecords: unknown[] = [
            { protocolVersion: 2, mode: 'automatic' },
            { protocolVersion: 1, mode: 'weird' },
            { mode: 'automatic' },
            [1, 2, 3],
            'automatic',
            42,
        ]
        for (const invalid of invalidRecords) {
            storageMap.set(ILLUSTRATION_CAPTURE_POLICY_KEY, encode(invalid))
            expect(await readDurableCaptureMode()).toBe('manual')
            expect(await isAutomaticCaptureAdmitted()).toBe(false)
            expect((await getCapturePolicy()).mode).toBe('manual')
        }
    })

    // Acceptance 9: if the read itself FAILS (not merely absent), the RPC surfaces
    // the error and admission is fail-closed (zero cost), never a manual guess.
    test('a read failure surfaces to callers and fails admission closed', async () => {
        storageControl.failGetKey = ILLUSTRATION_CAPTURE_POLICY_KEY
        await expect(getCapturePolicy()).rejects.toThrow()
        await expect(readDurableCaptureMode()).rejects.toThrow()
        expect(await isAutomaticCaptureAdmitted()).toBe(false)
    })

    test('rejects an unknown mode and a non-1 protocol version', async () => {
        await expect(setCaptureMode({ protocolVersion: 1, mode: 'weird' as never }))
            .rejects.toBeInstanceOf(IllustrationLedgerValidationError)
        await expect(setCaptureMode({ protocolVersion: 2 as never, mode: 'manual' }))
            .rejects.toBeInstanceOf(IllustrationLedgerValidationError)
        await expect(writeDurableCaptureMode('weird' as never))
            .rejects.toBeInstanceOf(IllustrationLedgerValidationError)
        // A rejected write leaves the durable default intact.
        expect(await readDurableCaptureMode()).toBe('manual')
    })

    test('fails admission closed and reports unavailable when the lock manager is missing', async () => {
        setIllustrationLockManagerAccessorForTests(() => undefined)
        expect(await isAutomaticCaptureAdmitted()).toBe(false)
        await expect(readDurableCaptureMode()).rejects.toBeInstanceOf(IllustrationLedgerUnavailableError)
        await expect(getCapturePolicy()).rejects.toBeInstanceOf(IllustrationLedgerUnavailableError)
    })
})
