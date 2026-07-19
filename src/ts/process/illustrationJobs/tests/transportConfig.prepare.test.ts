import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { InMemoryLockManager } from './inMemoryLockManager'

const harness = vi.hoisted(() => ({
    storageMap: new Map<string, Uint8Array>(),
    database: null as any,
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
        },
        async removeItem(key: string) {
            harness.storageMap.delete(key)
        },
    },
}))

vi.mock('src/ts/parser/parser.svelte', () => ({ hasher: vi.fn(async () => new Uint8Array(32)) }))
vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => harness.database }))
vi.mock('src/ts/storage/chatStorage', () => ({
    ensureChatHydrated: vi.fn(),
    saveChatToServerStrict: vi.fn(),
}))

const coordinatorModule = await import('../coordinator')
const storeModule = await import('../store')
const lockModule = await import('../locks')

const { preparePromptContext, setTransportConfig, getTransportConfig } = coordinatorModule
const { illustrationJobStore } = storeModule
const {
    resetIllustrationLockManagerAccessorForTests,
    setIllustrationLockManagerAccessorForTests,
} = lockModule

function webuiDb() {
    return {
        sdProvider: 'webui',
        NAIImgUrl: 'https://image.novelai.net/ai/generate-image',
        NAIImgModel: 'nai-diffusion-4-5-full',
        webUiUrl: 'http://127.0.0.1:7860/',
        comfyUiUrl: 'http://localhost:8188',
        comfyConfig: { workflow: '{}', posNodeID: '6', posInputName: 'text', negNodeID: '7', negInputName: 'text', timeout: 30 },
    } as any
}

const REFS = {
    tagProfile: { id: 'sdxl-illustrious', revision: '1' },
    profileConfigRevision: 'cfg-1',
    assetCatalogDigest: 'cat-1',
}

const WEBUI_ELECTION = {
    schemaVersion: 1 as const,
    election: {
        transportId: 'webui-flat' as const,
        binding: { mode: 'request-pinned' as const, checkpoint: 'sdxl.safetensors' },
        measurement: {
            mode: 'transport_only' as const,
            unit: 'utf8_byte' as const,
            positive: 2000,
            negative: 2000,
            combined: null,
            allowTransportOnly: true as const,
        },
        maxConcurrency: 2,
        priorityPolicy: 'interactive-first' as const,
    },
}

let lockManager: InMemoryLockManager

beforeEach(() => {
    harness.storageMap.clear()
    harness.database = webuiDb()
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 0, 1))
    lockManager = new InMemoryLockManager()
    setIllustrationLockManagerAccessorForTests(() => lockManager)
})

afterEach(() => {
    resetIllustrationLockManagerAccessorForTests()
    vi.useRealTimers()
})

async function createTurn(turnId: string): Promise<number> {
    const created = await illustrationJobStore.createTurn({ turnId, idempotencyKey: `create:${turnId}` })
    return created.version
}

describe('durable transport election + prepare (request §D1/§D5)', () => {
    test('an empty election means no elected transport; webui prepare then fails closed', async () => {
        expect(await getTransportConfig()).toEqual({ schemaVersion: 1, election: null })
        const version = await createTurn('turn-noelect')
        await expect(preparePromptContext({ turnId: 'turn-noelect', expectedVersion: version, ...REFS }))
            .rejects.toMatchObject({ code: 'prompt_target_unavailable', transportId: 'webui-flat' })
    })

    test('setTransportConfig persists a valid election and prepare resolves webui-flat', async () => {
        const stored = await setTransportConfig(WEBUI_ELECTION)
        expect(stored.election).toMatchObject({ transportId: 'webui-flat' })
        // Round-trips through durable storage.
        expect(await getTransportConfig()).toEqual({ schemaVersion: 1, election: WEBUI_ELECTION.election })

        const version = await createTurn('turn-webui')
        const snapshot = await preparePromptContext({ turnId: 'turn-webui', expectedVersion: version, ...REFS })
        expect(snapshot.promptContext).toMatchObject({
            tagProfile: { id: 'sdxl-illustrious', revision: '1' },
            target: { transportId: 'webui-flat', providerId: 'webui', bindingMode: 'request-pinned' },
        })
        expect(snapshot.promptContext?.target.measurement.mode).toBe('transport_only')
        expect(snapshot.promptContext?.target.targetFingerprint).toMatch(/^[0-9a-f]{64}$/)
    })

    test('setTransportConfig strictly rejects a malformed election (validation_failed)', async () => {
        await expect(setTransportConfig({
            schemaVersion: 1,
            election: {
                transportId: 'webui-flat',
                binding: { mode: 'request-pinned', checkpoint: 'x' },
                // Missing the explicit transport_only opt-in.
                measurement: { mode: 'transport_only', unit: 'utf8_byte', positive: 1, negative: 1, combined: null },
                maxConcurrency: 1,
                priorityPolicy: 'fifo',
            },
        })).rejects.toMatchObject({ code: 'validation_failed' })
        // Nothing was persisted.
        expect(await getTransportConfig()).toEqual({ schemaVersion: 1, election: null })
    })
})
