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

vi.mock('src/ts/parser/parser.svelte', () => ({
    hasher: vi.fn(async () => new Uint8Array(32)),
}))

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => harness.database,
}))

vi.mock('src/ts/storage/chatStorage', () => ({
    ensureChatHydrated: vi.fn(),
    saveChatToServerStrict: vi.fn(),
}))

const coordinatorModule = await import('../coordinator')
const storeModule = await import('../store')
const lockModule = await import('../locks')
const promptContextModule = await import('../promptContextV2')

const { preparePromptContext } = coordinatorModule
const { illustrationJobStore, illustrationTurnKey } = storeModule
const { resolveNovelAiNativeTarget, targetFingerprintMatchesCurrentDb } = promptContextModule
const {
    resetIllustrationLockManagerAccessorForTests,
    setIllustrationLockManagerAccessorForTests,
} = lockModule

function naiDb(model = 'nai-diffusion-4-5-full') {
    return {
        sdProvider: 'novelai',
        NAIImgUrl: 'https://image.novelai.net/ai/generate-image',
        NAIImgModel: model,
        NAII2I: false,
        NAIImgConfig: {},
    } as any
}

function decodeTurn(turnId: string): any {
    const value = harness.storageMap.get(illustrationTurnKey(turnId))
    return value ? JSON.parse(new TextDecoder().decode(value)) : null
}

const REFS = {
    tagProfile: { id: 'nai-v4', revision: '1' },
    profileConfigRevision: 'cfg-1',
    assetCatalogDigest: 'cat-1',
}

let lockManager: InMemoryLockManager

beforeEach(() => {
    harness.storageMap.clear()
    harness.database = naiDb()
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

describe('preparePromptContext atomic capture (request §4/§10-5)', () => {
    test('captures target + opaque refs, CAS-bumps the turn, and rejects re-binding', async () => {
        const version = await createTurn('turn-prepare')
        const snapshot = await preparePromptContext({
            turnId: 'turn-prepare',
            expectedVersion: version,
            ...REFS,
        })
        expect(snapshot.version).toBe(version + 1)
        expect(snapshot.promptContext).toMatchObject({
            tagProfile: { id: 'nai-v4', revision: '1' },
            profileConfigRevision: 'cfg-1',
            assetCatalogDigest: 'cat-1',
            target: { transportId: 'novelai-native', providerId: 'novelai' },
        })
        expect(snapshot.promptContext?.target.targetFingerprint).toMatch(/^[0-9a-f]{64}$/)

        // Re-binding a prepared turn (correct version) is a stable rejection.
        await expect(preparePromptContext({
            turnId: 'turn-prepare',
            expectedVersion: snapshot.version,
            ...REFS,
        })).rejects.toMatchObject({ reason: 'prompt_context_already_bound' })

        // A stale expectedVersion is a CAS version conflict, not a rebind.
        await expect(preparePromptContext({
            turnId: 'turn-prepare',
            expectedVersion: version,
            ...REFS,
        })).rejects.toMatchObject({ code: 'version_conflict' })
    })

    test('an unresolvable provider fails closed before any durable write (Slice D scope)', async () => {
        harness.database = { sdProvider: 'webui', NAIImgUrl: '', NAIImgModel: '' }
        const version = await createTurn('turn-webui')
        await expect(preparePromptContext({
            turnId: 'turn-webui',
            expectedVersion: version,
            ...REFS,
        })).rejects.toMatchObject({ code: 'prompt_target_unavailable', transportId: 'webui-flat' })
        // No PromptContext was persisted.
        expect(decodeTurn('turn-webui')?.promptContext).toBeUndefined()
    })

    test('a non-V4 NovelAI model fails closed at prepare, before the Plugin LLM (request §6/§8)', async () => {
        // sdProvider='novelai' resolves an adapter, but the pinned model_exact/T5
        // measurement is honest only for V4. Preparing with a V3 model must reject
        // up-front — not persist a durable context claiming exact measurability that
        // only blows up later inside the measurement receipt (after LLM cost).
        harness.database = naiDb('nai-diffusion-3')
        const version = await createTurn('turn-nai-v3')
        await expect(preparePromptContext({
            turnId: 'turn-nai-v3',
            expectedVersion: version,
            ...REFS,
        })).rejects.toMatchObject({ code: 'prompt_target_unavailable', transportId: 'novelai-native' })
        // No PromptContext was persisted, and the turn version was NOT CAS-bumped.
        const persisted = decodeTurn('turn-nai-v3')
        expect(persisted?.promptContext).toBeUndefined()
        expect(persisted?.version).toBe(version)
    })
})

describe('durable PromptContext survives reload (request §10-21)', () => {
    test('round-trips through storage byte-for-byte and preserves target identity', async () => {
        const version = await createTurn('turn-reload')
        const snapshot = await preparePromptContext({
            turnId: 'turn-reload',
            expectedVersion: version,
            ...REFS,
        })

        // The raw persisted record carries the exact PromptContext...
        const persisted = decodeTurn('turn-reload')
        expect(persisted.promptContext).toEqual(snapshot.promptContext)
        // ...and a fresh read projects the identical context.
        const reloaded = await illustrationJobStore.getTurn('turn-reload')
        expect(reloaded?.promptContext).toEqual(snapshot.promptContext)

        // The captured fingerprint equals a fresh resolution of the same settings.
        const fresh = await resolveNovelAiNativeTarget(harness.database)
        expect(persisted.promptContext.target.targetFingerprint).toBe(fresh.targetFingerprint)
    })
})

describe('post-capture drift is detected, not silently reinterpreted (request §10-6)', () => {
    test('a model change makes the captured fingerprint no longer match the current settings', async () => {
        const version = await createTurn('turn-drift')
        const snapshot = await preparePromptContext({
            turnId: 'turn-drift',
            expectedVersion: version,
            ...REFS,
        })
        const captured = snapshot.promptContext!.target.targetFingerprint

        // The user changes the model after capture.
        harness.database = naiDb('nai-diffusion-4-full')
        expect(await targetFingerprintMatchesCurrentDb(harness.database, captured)).toBe(false)

        // The durable snapshot is NOT reinterpreted to the new target.
        const reloaded = await illustrationJobStore.getTurn('turn-drift')
        expect(reloaded?.promptContext?.target.targetFingerprint).toBe(captured)
    })
})
