import { beforeEach, describe, expect, test, vi } from 'vitest'

const { storageMap } = vi.hoisted(() => ({
    storageMap: new Map<string, Uint8Array>(),
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: {
        async Init() {},
        async getItem(key: string) {
            return storageMap.get(key) ?? null
        },
        async setItem(key: string, value: Uint8Array) {
            storageMap.set(key, new Uint8Array(value))
        },
    },
}))

vi.mock('src/ts/parser/parser.svelte', () => ({
    hasher: vi.fn(async () => new Uint8Array(32)),
}))

const {
    ILLUSTRATION_FEATURE_FLAG_KEY,
    isIllustrationFeatureEnabled,
    setIllustrationFeatureEnabled,
} = await import('../featureFlag')

beforeEach(() => {
    storageMap.clear()
})

describe('illustration feature flag', () => {
    // §20 / §22: agentic capture and worker default OFF until Gate 4 enables them.
    test('defaults off and persists explicit changes', async () => {
        await expect(isIllustrationFeatureEnabled()).resolves.toBe(false)

        await expect(setIllustrationFeatureEnabled(true)).resolves.toBe(true)
        await expect(isIllustrationFeatureEnabled()).resolves.toBe(true)

        await expect(setIllustrationFeatureEnabled(false)).resolves.toBe(false)
        await expect(isIllustrationFeatureEnabled()).resolves.toBe(false)
    })

    test('fails closed for malformed persisted values', async () => {
        storageMap.set(
            ILLUSTRATION_FEATURE_FLAG_KEY,
            new TextEncoder().encode(JSON.stringify({ enabled: true })),
        )

        await expect(isIllustrationFeatureEnabled()).resolves.toBe(false)
    })
})
