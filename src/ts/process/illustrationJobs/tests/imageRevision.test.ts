import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Chat } from '../../../storage/database.svelte'
import type { IllustrationJobRecordV1, IllustrationPromptV1 } from '../types'
import { installImagePromptMeasurementTestService } from './imagePromptTestHarness'
import { InMemoryLockManager } from './inMemoryLockManager'

// Harness mirrors executor.test.ts: an in-memory storage map plus mocked database,
// provider, inlay asset store, and strict chat save.
const harness = vi.hoisted(() => ({
    storageMap: new Map<string, Uint8Array>(),
    events: [] as string[],
    database: null as any,
    integrity: new Map<string, 'complete' | 'repairable' | 'missing'>(),
    provider: vi.fn(),
    writeInlay: vi.fn(),
    inspectInlay: vi.fn(),
    repairInlay: vi.fn(),
    strictSave: vi.fn(),
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
        async getItems(keys: string[]) {
            const results: { key: string; value: Uint8Array }[] = []
            for (const key of keys) {
                const value = harness.storageMap.get(key)
                if (value !== undefined) results.push({ key, value: new Uint8Array(value) })
            }
            return results
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
    ensureChatHydrated: vi.fn(async (chats: Chat[], index: number) => chats[index] ?? null),
    saveChatToServerStrict: harness.strictSave,
}))

vi.mock('src/ts/process/stableDiff', () => ({
    generateAIImageTyped: harness.provider,
}))

vi.mock('src/ts/process/files/inlays', () => ({
    writeInlayImage: harness.writeInlay,
    inspectInlayAssetIntegrity: harness.inspectInlay,
    repairInlayAssetRecords: harness.repairInlay,
}))

const coordinatorModule = await import('../coordinator')
const coordinatorRecordModule = await import('../coordinatorRecord')
const executorModule = await import('../executor')
const featureModule = await import('../featureFlag')
const lockModule = await import('../locks')
const operationLockModule = await import('../operationLock')
const revisionModule = await import('../revision')
const revisionLedgerModule = await import('../revisionLedger')
const recoveryModule = await import('../recovery')
const storeModule = await import('../store')
const settingsModule = await import('../settingsFingerprint')

const {
    createImageRevision,
    enqueueRevisionImage,
    getImageRevisionTarget,
    listImageReferences,
    listImageRevisions,
    restoreImageRevision,
} = revisionModule
const {
    readImageReference,
    readImageLineage,
    illustrationReferenceKey,
    illustrationLineageKey,
    prepareRestore,
    commitRestore,
    restoreBindingHash,
} = revisionLedgerModule
const {
    pokeExecutor,
    resetIllustrationWorkerLockManagerAccessorForTests,
    setIllustrationWorkerLockManagerAccessorForTests,
    startIllustrationExecutor,
    stopIllustrationExecutor,
} = executorModule
const { runIllustrationRecovery } = recoveryModule
const { setIllustrationFeatureEnabled } = featureModule
const { resetIllustrationLockManagerAccessorForTests, setIllustrationLockManagerAccessorForTests } = lockModule
const {
    resetIllustrationOperationLockManagerAccessorForTests,
    setIllustrationOperationLockManagerAccessorForTests,
} = operationLockModule
const { illustrationJobStore } = storeModule
const { computeNaiSettingsFingerprint } = settingsModule

const BASE_TIME = Date.UTC(2026, 1, 1)
let lockManager: InMemoryLockManager
let restoreMeasurement = () => {}

function installDatabase(messageData: string): { chat: Chat; message: any } {
    const message: any = { role: 'char', chatId: 'message-1', data: messageData }
    const chat: any = {
        id: 'conversation-1',
        name: 'chat',
        note: '',
        localLore: [],
        fmIndex: -1,
        message: [message],
    }
    harness.database = {
        characters: [{
            chaId: 'character-1',
            name: 'Character',
            image: '',
            newGenData: { negative: 'character-negative' },
            chats: [chat],
            chatPage: 0,
        }],
        sdProvider: 'novelai',
        NAIImgUrl: 'https://image.novelai.net/ai/generate-image',
        NAIImgModel: 'nai-diffusion-4-5-full',
        NAII2I: false,
        NAIImgConfig: {},
        inlayImageLossless: true,
    }
    return { chat, message }
}

function flatPrompt(basePositive: string, baseNegative = ''): IllustrationPromptV1 {
    return {
        schemaVersion: 1,
        layout: 'flat',
        basePositive,
        characterPositives: [],
        baseNegative,
        characterNegatives: [],
    }
}

// Seed a committed genesis job with its inlay already spliced into the chat, so the
// reference ledger backfills a genesis reference from it (no full pipeline needed).
async function seedGenesis(options: {
    genesisAssetId?: string
    source?: string
    prompt?: IllustrationPromptV1
} = {}): Promise<{
    jobId: string
    genesisAssetId: string
    prompt: IllustrationPromptV1
    fingerprint: string
    message: any
    chat: Chat
}> {
    const source = options.source ?? 'Genesis body'
    const genesisAssetId = options.genesisAssetId ?? 'asset:genesis000000000000000000000'
    const { chat, message } = installDatabase(`${source}\n{{inlay::${genesisAssetId}}}`)
    const fingerprint = await computeNaiSettingsFingerprint(harness.database)
    const prompt = options.prompt ?? flatPrompt('genesis positive', 'genesis negative')
    const now = Date.now()
    const jobId = 'genesisjob-1'
    const record: IllustrationJobRecordV1 = {
        schemaVersion: 1,
        turnId: 'genesis-turn',
        jobId,
        slotToken: 'genesis-slot',
        insertAfterUtf16: source.length,
        sceneId: 'scene-1',
        scenePayload: { schemaVersion: 1, data: { description: 'genesis scene' } },
        sourceRevisionHash: 'genesis-hash',
        slotOrdinal: 0,
        createdAt: now,
        state: 'committed',
        version: 6,
        leaseId: null,
        leaseExpiresAt: 0,
        fence: 0,
        workerEpoch: 0,
        updatedAt: now,
        idempotencyKey: 'genesis-commit',
        agentAttemptCount: 0,
        creationIdempotencyKey: 'genesis-create',
        target: {
            chaId: 'character-1',
            conversationId: 'conversation-1',
            expectedMessageId: 'message-1',
            rootTurnId: 'root-1',
            requestNonce: 'genesis-nonce',
            slotToken: 'genesis-slot',
            capturedSwipeHint: 0,
            sourceRevisionHash: 'genesis-hash',
        },
        prompt,
        settingsFingerprint: fingerprint,
        attemptId: 'genesis-attempt',
        assetId: genesisAssetId,
    }
    harness.storageMap.set(
        `illustration:v1:job:${jobId}`,
        new TextEncoder().encode(JSON.stringify(record)),
    )
    harness.integrity.set(genesisAssetId, 'complete')
    return { jobId, genesisAssetId, prompt, fingerprint, message, chat }
}

// Seed a committed V2 (envelope-identity) genesis job: it carries promptEnvelope +
// promptReceipt instead of a V1 `prompt`, mirroring the wellspring/nai-compatible-flat
// path where ALL committed images are V2. The prompt-identity is the receipt's
// envelopeHash (Sol #8).
async function seedGenesisV2(options: {
    genesisAssetId?: string
    source?: string
    envelopeHash?: string
} = {}): Promise<{
    jobId: string
    genesisAssetId: string
    envelopeHash: string
    fingerprint: string
}> {
    const source = options.source ?? 'Genesis V2 body'
    const genesisAssetId = options.genesisAssetId ?? 'asset:genesisv2000000000000000000000'
    const envelopeHash = options.envelopeHash
        ?? 'v2envelopehash000000000000000000000000000000000000000000000000aa'
    installDatabase(`${source}\n{{inlay::${genesisAssetId}}}`)
    const fingerprint = await computeNaiSettingsFingerprint(harness.database)
    const now = Date.now()
    const jobId = 'genesisjobv2-1'
    const record = {
        schemaVersion: 1,
        turnId: 'genesis-turn-v2',
        jobId,
        slotToken: 'genesis-slot-v2',
        insertAfterUtf16: source.length,
        sceneId: 'scene-1',
        scenePayload: { schemaVersion: 1, data: { description: 'genesis v2 scene' } },
        sourceRevisionHash: 'genesis-hash-v2',
        slotOrdinal: 0,
        createdAt: now,
        state: 'committed',
        version: 7,
        leaseId: null,
        leaseExpiresAt: 0,
        fence: 0,
        workerEpoch: 0,
        updatedAt: now,
        idempotencyKey: 'genesis-commit-v2',
        agentAttemptCount: 0,
        creationIdempotencyKey: 'genesis-create-v2',
        target: {
            chaId: 'character-1',
            conversationId: 'conversation-1',
            expectedMessageId: 'message-1',
            rootTurnId: 'root-v2',
            requestNonce: 'genesis-nonce-v2',
            slotToken: 'genesis-slot-v2',
            capturedSwipeHint: 0,
            sourceRevisionHash: 'genesis-hash-v2',
        },
        promptEnvelope: {
            schemaVersion: 2,
            tagProfileId: 'tp',
            tagProfileRevision: '1',
            profileConfigRevision: 'cfg',
            assetCatalogDigest: 'cat',
            layout: 'flat',
            basePositive: 'v2 base positive',
            subjectPositives: [],
            baseNegative: 'v2 base negative',
            subjectNegatives: [],
        },
        promptReceipt: {
            schemaVersion: 2,
            targetFingerprint: 'tfp-v2',
            envelopeHash,
            measurementMode: 'transport_only',
            measurementRevision: 'transport-only/1',
            dimensions: [],
            modelVerdict: 'within_limit',
            dispatchEligible: true,
            eligibilityBasis: 'transport_only',
        },
        settingsFingerprint: fingerprint,
        attemptId: 'genesis-attempt-v2',
        assetId: genesisAssetId,
    } as unknown as IllustrationJobRecordV1
    harness.storageMap.set(
        `illustration:v1:job:${jobId}`,
        new TextEncoder().encode(JSON.stringify(record)),
    )
    harness.integrity.set(genesisAssetId, 'complete')
    return { jobId, genesisAssetId, envelopeHash, fingerprint }
}

async function resolveReference(): Promise<{
    referenceId: string
    operationVersion: number
    lineageId: string
    lineageVersion: number
    sourceJobId: string
    currentAssetId: string
}> {
    const listed = await listImageReferences({
        protocolVersion: 1,
        conversationId: 'conversation-1',
        messageId: 'message-1',
        limit: 10,
    })
    expect(listed.items).toHaveLength(1)
    const item = listed.items[0]
    return {
        referenceId: item.referenceId,
        operationVersion: item.operationVersion,
        lineageId: item.lineageId,
        lineageVersion: item.lineageVersion,
        sourceJobId: item.sourceJobId,
        currentAssetId: item.currentAssetId,
    }
}

function occurrences(text: string, token: string): number {
    let count = 0
    let cursor = 0
    let idx = -1
    while ((idx = text.indexOf(token, cursor)) >= 0) {
        count += 1
        cursor = idx + token.length
    }
    return count
}

async function drainExecutor(): Promise<void> {
    await startIllustrationExecutor()
    await pokeExecutor()
}

beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    harness.storageMap.clear()
    harness.events.length = 0
    harness.integrity.clear()
    harness.provider.mockReset()
    harness.writeInlay.mockReset()
    harness.inspectInlay.mockReset()
    harness.repairInlay.mockReset()
    harness.strictSave.mockReset()
    installDatabase('placeholder')
    restoreMeasurement = installImagePromptMeasurementTestService(() => harness.database)
    lockManager = new InMemoryLockManager()
    setIllustrationLockManagerAccessorForTests(() => lockManager)
    setIllustrationOperationLockManagerAccessorForTests(() => lockManager)
    setIllustrationWorkerLockManagerAccessorForTests(() => lockManager)
    await setIllustrationFeatureEnabled(true)
    harness.provider.mockImplementation(async () => {
        harness.events.push('provider')
        return {
            result: { ok: true, bytesOrDataUrl: 'data:image/png;base64,AA==', providerStatus: 200 },
            compatibilityValue: 'data:image/png;base64,AA==',
        }
    })
    harness.writeInlay.mockImplementation(async (_image: unknown, options: { id: string }) => {
        harness.integrity.set(options.id, 'complete')
        return options.id
    })
    harness.inspectInlay.mockImplementation(async (id: string) => {
        const status = harness.integrity.get(id) ?? 'missing'
        return { status, hasAsset: status !== 'missing', hasInfo: status === 'complete', hasMeta: status === 'complete' }
    })
    harness.repairInlay.mockImplementation(async (id: string) => {
        harness.integrity.set(id, 'complete')
    })
    harness.strictSave.mockImplementation(async () => ({ success: true, durable: true }))
})

afterEach(async () => {
    restoreMeasurement()
    await stopIllustrationExecutor()
    resetIllustrationWorkerLockManagerAccessorForTests()
    resetIllustrationLockManagerAccessorForTests()
    resetIllustrationOperationLockManagerAccessorForTests()
    vi.useRealTimers()
})

describe('Image Revision V1 — contract §7 acceptance', () => {
    // §7.1 committed parent immutability.
    test('committed parent is never mutated or reopened by a revision', async () => {
        const genesis = await seedGenesis()
        const ref = await resolveReference()
        const before = JSON.parse(new TextDecoder().decode(
            harness.storageMap.get(`illustration:v1:job:${genesis.jobId}`)!,
        ))
        await createImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'intent-1',
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion,
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'exact-prompt',
            disposition: 'replace',
            confirmNewImageCharge: true,
            confirmNewLlmCharge: false,
        })
        const after = JSON.parse(new TextDecoder().decode(
            harness.storageMap.get(`illustration:v1:job:${genesis.jobId}`)!,
        ))
        expect(after).toEqual(before)
        expect(after.state).toBe('committed')
    })

    // §7.2 exact-prompt byte/order preservation, new seed.
    test('exact-prompt copies the parent prompt verbatim and derives a new asset', async () => {
        const genesis = await seedGenesis({ prompt: {
            schemaVersion: 1,
            layout: 'nai-v4-characters',
            basePositive: 'base',
            characterPositives: ['a', 'b'],
            baseNegative: 'neg',
            characterNegatives: ['na', 'nb'],
        } })
        const ref = await resolveReference()
        const child = await createImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'intent-exact',
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion,
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'exact-prompt',
            disposition: 'replace',
            confirmNewImageCharge: true,
            confirmNewLlmCharge: false,
        })
        expect(child.state).toBe('queued')
        const record = await illustrationJobStore.getJob(child.jobId)
        expect(record?.prompt).toEqual(genesis.prompt)

        await drainExecutor()
        const committed = await illustrationJobStore.getJob(child.jobId)
        expect(committed?.state).toBe('committed')
        expect(committed?.assetId).toBeTruthy()
        expect(committed?.assetId).not.toBe(genesis.genesisAssetId)
        expect(harness.provider).toHaveBeenCalledTimes(1)
    })

    // §7.3 edited-prompt measurement + drift gate.
    test('edited-prompt validates measurement and fails closed on settings drift', async () => {
        await seedGenesis()
        const ref = await resolveReference()
        const child = await createImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'intent-edit',
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion,
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'edited-prompt',
            disposition: 'replace',
            editedPrompt: flatPrompt('edited positive', 'edited negative'),
            confirmNewImageCharge: true,
            confirmNewLlmCharge: false,
        })
        expect(child.state).toBe('queued')
        const record = await illustrationJobStore.getJob(child.jobId)
        expect(record?.prompt).toEqual(flatPrompt('edited positive', 'edited negative'))

        // Drift the settings so the measurement fingerprint no longer matches.
        harness.database.NAIImgModel = 'nai-diffusion-4-5-curated'
        await expect(createImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'intent-edit-drift',
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion + 1,
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'edited-prompt',
            disposition: 'replace',
            editedPrompt: flatPrompt('edited two'),
            confirmNewImageCharge: true,
            confirmNewLlmCharge: false,
        })).rejects.toThrow(/settings|fingerprint/i)
    })

    // §7.4 retag stops at prompt_ready with provider 0 until the image confirmation.
    test('retag runs the Tagger only, halts at prompt_ready, and dispatches after enqueue', async () => {
        await seedGenesis()
        const ref = await resolveReference()
        const child = await createImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'intent-retag',
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion,
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'retag',
            disposition: 'replace',
            confirmNewImageCharge: false,
            confirmNewLlmCharge: true,
        })
        expect(child.state).toBe('awaiting_prompt')
        expect(child.scenePayload).toEqual({ schemaVersion: 1, data: { description: 'genesis scene' } })

        // The Tagger claims the child and supplies a new prompt -> prompt_ready.
        const proof = await refreshCoordinatorProof()
        const claimed = await illustrationJobStore.claimJob({
            ...proof,
            jobId: child.jobId,
            expectedVersion: child.version,
            leaseId: 'tagger',
        })
        const supplied = await coordinatorSupplyPrompt({
            ...proof,
            jobId: child.jobId,
            expectedVersion: claimed.version,
            leaseId: 'tagger',
            fence: claimed.fence,
            idempotencyKey: 'retag-prompt',
            prompt: flatPrompt('retagged positive'),
        })
        expect(supplied.state).toBe('prompt_ready')
        await drainExecutor()
        expect(harness.provider).not.toHaveBeenCalled()

        const readyRecord = await illustrationJobStore.getJob(child.jobId)
        await enqueueRevisionImage({
            protocolVersion: 1,
            idempotencyKey: 'retag-enqueue',
            jobId: child.jobId,
            expectedVersion: readyRecord!.version,
            confirmNewImageCharge: true,
        })
        await drainExecutor()
        expect(harness.provider).toHaveBeenCalledTimes(1)
        expect((await illustrationJobStore.getJob(child.jobId))?.state).toBe('committed')
    })

    // §7.5 old image persists across provider failure (no reference change).
    test('a failed revision leaves the old image and reference untouched', async () => {
        const genesis = await seedGenesis()
        const ref = await resolveReference()
        harness.provider.mockImplementation(async () => {
            harness.events.push('provider')
            return { result: { ok: false, certainty: 'definite' }, compatibilityValue: null }
        })
        const child = await createImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'intent-fail',
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion,
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'exact-prompt',
            disposition: 'replace',
            confirmNewImageCharge: true,
            confirmNewLlmCharge: false,
        })
        await drainExecutor()
        expect((await illustrationJobStore.getJob(child.jobId))?.state).toBe('failed')
        const after = await readImageReference(ref.referenceId)
        expect(after?.currentAssetId).toBe(genesis.genesisAssetId)
        expect(after?.lineageVersion).toBe(1)
        expect(occurrences(harness.database.characters[0].chats[0].message[0].data,
            `{{inlay::${genesis.genesisAssetId}}}`)).toBe(1)
    })

    // §7.6 concurrent revision — only one operationVersion admission wins.
    test('two intents on the same operationVersion admit exactly one child', async () => {
        await seedGenesis()
        const ref = await resolveReference()
        const first = await createImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'intent-a',
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion,
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'exact-prompt',
            disposition: 'replace',
            confirmNewImageCharge: true,
            confirmNewLlmCharge: false,
        })
        expect(first.state).toBe('queued')
        await expect(createImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'intent-b',
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion, // stale — already consumed.
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'exact-prompt',
            disposition: 'replace',
            confirmNewImageCharge: true,
            confirmNewLlmCharge: false,
        })).rejects.toThrow(/version/i)
    })

    // §7.7 missing old-asset reference before provider -> stale, no charge.
    test('a revision whose old asset vanished is stale before dispatch', async () => {
        await seedGenesis()
        const ref = await resolveReference()
        const child = await createImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'intent-missing',
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion,
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'exact-prompt',
            disposition: 'replace',
            confirmNewImageCharge: true,
            confirmNewLlmCharge: false,
        })
        // The user deleted/edited away the old inlay before the pump ran.
        harness.database.characters[0].chats[0].message[0].data = 'Genesis body only'
        await drainExecutor()
        expect((await illustrationJobStore.getJob(child.jobId))?.state).toBe('stale')
        expect(harness.provider).not.toHaveBeenCalled()
    })

    // §7.8a replace swaps exactly one occurrence.
    test('replace swaps exactly one inlay occurrence', async () => {
        const genesis = await seedGenesis()
        const ref = await resolveReference()
        const child = await createImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'intent-replace',
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion,
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'exact-prompt',
            disposition: 'replace',
            confirmNewImageCharge: true,
            confirmNewLlmCharge: false,
        })
        await drainExecutor()
        const committed = await illustrationJobStore.getJob(child.jobId)
        const data = harness.database.characters[0].chats[0].message[0].data
        expect(occurrences(data, `{{inlay::${genesis.genesisAssetId}}}`)).toBe(0)
        expect(occurrences(data, `{{inlay::${committed!.assetId}}}`)).toBe(1)
        const after = await readImageReference(ref.referenceId)
        expect(after?.currentAssetId).toBe(committed!.assetId)
        expect(after?.lineageVersion).toBe(2)
    })

    // §7.8b retain leaves the source lineage untouched and forks exactly one new ref.
    test('retain forks a new reference/lineage and keeps the source unchanged', async () => {
        const genesis = await seedGenesis()
        const ref = await resolveReference()
        const child = await createImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'intent-retain',
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion,
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'exact-prompt',
            disposition: 'retain',
            confirmNewImageCharge: true,
            confirmNewLlmCharge: false,
        })
        await drainExecutor()
        const committed = await illustrationJobStore.getJob(child.jobId)
        const data = harness.database.characters[0].chats[0].message[0].data
        // Both images now present; original untouched.
        expect(occurrences(data, `{{inlay::${genesis.genesisAssetId}}}`)).toBe(1)
        expect(occurrences(data, `{{inlay::${committed!.assetId}}}`)).toBe(1)

        const source = await readImageReference(ref.referenceId)
        expect(source?.currentAssetId).toBe(genesis.genesisAssetId)
        expect(source?.lineageVersion).toBe(1)

        const references = await listImageReferences({
            protocolVersion: 1,
            conversationId: 'conversation-1',
            messageId: 'message-1',
            limit: 10,
        })
        expect(references.items).toHaveLength(2)
        const fork = references.items.find((item) => item.referenceId !== ref.referenceId)!
        expect(fork.currentAssetId).toBe(committed!.assetId)
        expect(fork.lineageId).not.toBe(ref.lineageId)
    })

    // §7.9 crash after flush before ledger -> recovery finalizes with no duplicate.
    test('commit crash recovery produces no duplicate image', async () => {
        const genesis = await seedGenesis()
        const ref = await resolveReference()
        const child = await createImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'intent-crash',
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion,
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'exact-prompt',
            disposition: 'replace',
            confirmNewImageCharge: true,
            confirmNewLlmCharge: false,
        })
        const newAssetId = await executorModule.deriveIllustrationAssetId(child.jobId, 'crash-attempt')
        // Drive to committing with the new asset, and simulate the flush that
        // happened just before the crash (old inlay already swapped for the new one).
        let record = await illustrationJobStore.getJob(child.jobId)
        record = await illustrationJobStore.transitionJob({
            jobId: child.jobId, expectedVersion: record!.version, to: 'generating',
            patch: { idempotencyKey: 'g', attemptId: 'crash-attempt', assetId: newAssetId, error: null },
        })
        record = await illustrationJobStore.transitionJob({
            jobId: child.jobId, expectedVersion: record.version, to: 'asset_writing', patch: { idempotencyKey: 'aw' },
        })
        record = await illustrationJobStore.transitionJob({
            jobId: child.jobId, expectedVersion: record.version, to: 'asset_ready', patch: { idempotencyKey: 'ar' },
        })
        record = await illustrationJobStore.transitionJob({
            jobId: child.jobId, expectedVersion: record.version, to: 'committing', patch: { idempotencyKey: 'c' },
        })
        harness.integrity.set(newAssetId, 'complete')
        harness.database.characters[0].chats[0].message[0].data =
            `Genesis body\n{{inlay::${newAssetId}}}`

        await runIllustrationRecovery()
        expect((await illustrationJobStore.getJob(child.jobId))?.state).toBe('committed')
        const data = harness.database.characters[0].chats[0].message[0].data
        expect(occurrences(data, `{{inlay::${newAssetId}}}`)).toBe(1)
        expect(occurrences(data, `{{inlay::${genesis.genesisAssetId}}}`)).toBe(0)
        const after = await readImageReference(ref.referenceId)
        expect(after?.currentAssetId).toBe(newAssetId)
        expect(after?.lineageVersion).toBe(2)
    })

    // §7.10 restore incurs no LLM/provider work.
    test('restore re-points the reference with no provider call', async () => {
        const genesis = await seedGenesis()
        const ref = await resolveReference()
        // First replace to create a second revision to restore FROM.
        const child = await createImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'intent-r1',
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion,
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'exact-prompt',
            disposition: 'replace',
            confirmNewImageCharge: true,
            confirmNewLlmCharge: false,
        })
        await drainExecutor()
        harness.provider.mockClear()
        const afterReplace = await readImageReference(ref.referenceId)!
        const lineage = await readImageLineage((await readImageReference(ref.referenceId))!.lineageId)
        const genesisRevision = lineage!.revisions.find((entry) => entry.mode === 'genesis')!

        const restored = await restoreImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'intent-restore',
            referenceId: ref.referenceId,
            expectedOperationVersion: afterReplace!.operationVersion,
            expectedLineageVersion: afterReplace!.lineageVersion,
            expectedCurrentAssetId: afterReplace!.currentAssetId,
            targetRevisionId: genesisRevision.revisionId,
            confirmNoCharge: true,
        })
        expect(harness.provider).not.toHaveBeenCalled()
        expect(restored.currentAssetId).toBe(genesis.genesisAssetId)
        const data = harness.database.characters[0].chats[0].message[0].data
        expect(occurrences(data, `{{inlay::${genesis.genesisAssetId}}}`)).toBe(1)
        expect(occurrences(data, `{{inlay::${(await illustrationJobStore.getJob(child.jobId))!.assetId}}}`)).toBe(0)
    })

    // §7.11 missing charge confirmation -> no LLM/provider work.
    test('missing charge confirmations reject before any work', async () => {
        await seedGenesis()
        const ref = await resolveReference()
        await expect(createImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'intent-noconfirm',
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion,
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'exact-prompt',
            disposition: 'replace',
            confirmNewImageCharge: false,
            confirmNewLlmCharge: false,
        })).rejects.toThrow(/confirm/i)
        await expect(createImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'intent-noretag-confirm',
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion,
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'retag',
            disposition: 'replace',
            confirmNewImageCharge: false,
            confirmNewLlmCharge: false,
        })).rejects.toThrow(/confirm/i)
        // The operationVersion was never consumed and no child exists.
        const after = await readImageReference(ref.referenceId)
        expect(after?.operationVersion).toBe(0)
    })

    // §7.12 idempotency + independent second fork.
    test('same key returns one child; a new nonce forks independently', async () => {
        await seedGenesis()
        const ref = await resolveReference()
        const args = {
            protocolVersion: 1 as const,
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion,
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'exact-prompt' as const,
            disposition: 'retain' as const,
            confirmNewImageCharge: true,
            confirmNewLlmCharge: false,
        }
        const a = await createImageRevision({ ...args, idempotencyKey: 'dup-key' })
        const b = await createImageRevision({ ...args, idempotencyKey: 'dup-key' })
        expect(b.jobId).toBe(a.jobId)
        await drainExecutor()
        expect(harness.provider).toHaveBeenCalledTimes(1)

        // A terminal retain, then a fresh nonce with the refreshed operationVersion
        // read straight off the (unchanged-lineage) genesis reference.
        const refreshed = await readImageReference(ref.referenceId)
        const second = await createImageRevision({
            ...args,
            idempotencyKey: 'fresh-nonce',
            expectedOperationVersion: refreshed!.operationVersion,
        })
        await drainExecutor()
        expect(second.jobId).not.toBe(a.jobId)
        const references = await listImageReferences({
            protocolVersion: 1,
            conversationId: 'conversation-1',
            messageId: 'message-1',
            limit: 10,
        })
        // genesis + two independent forks.
        expect(references.items).toHaveLength(3)
    })

    // §7.13 bounded pagination + strict private schema.
    test('list/get/restore projections enforce bounded pagination and strict input', async () => {
        await seedGenesis()
        const ref = await resolveReference()
        const target = await getImageRevisionTarget({ protocolVersion: 1, referenceId: ref.referenceId })
        expect(target.identity.referenceId).toBe(ref.referenceId)
        expect(target.chargeCertainty).toBe('charged')
        expect(target.providerDispatched).toBe(true)

        const revisions = await listImageRevisions({ protocolVersion: 1, referenceId: ref.referenceId, limit: 1 })
        expect(revisions.items).toHaveLength(1)
        expect(revisions.items[0].isCurrent).toBe(true)

        await expect(listImageRevisions({ protocolVersion: 1, referenceId: ref.referenceId, limit: 0 }))
            .rejects.toThrow(/limit/i)
        await expect(getImageRevisionTarget({ protocolVersion: 2 as 1, referenceId: ref.referenceId }))
            .rejects.toThrow(/protocolVersion/i)
    })

    // §7.14 retained lineage/asset survive terminal job pruning.
    test('retained lineage and asset restore survive terminal execution pruning', async () => {
        const genesis = await seedGenesis()
        const ref = await resolveReference()
        const child = await createImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'intent-prune',
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion,
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'exact-prompt',
            disposition: 'replace',
            confirmNewImageCharge: true,
            confirmNewLlmCharge: false,
        })
        await drainExecutor()
        const revisedRef = await readImageReference(ref.referenceId)

        // Prune every terminal job record (age them past the TTL).
        vi.setSystemTime(BASE_TIME + storeModule.TERMINAL_RECORD_TTL_MS + 1)
        await illustrationJobStore.pruneTerminalRecords({ olderThanMs: 0, maxDeletes: 1000 })
        expect(await illustrationJobStore.getJob(child.jobId)).toBeNull()
        expect(await illustrationJobStore.getJob(genesis.jobId)).toBeNull()

        // Lineage + reference + asset survive; restore to genesis still works.
        const lineage = await readImageLineage(revisedRef!.lineageId)
        const genesisRevision = lineage!.revisions.find((entry) => entry.mode === 'genesis')!
        const restored = await restoreImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'intent-restore-after-prune',
            referenceId: ref.referenceId,
            expectedOperationVersion: revisedRef!.operationVersion,
            expectedLineageVersion: revisedRef!.lineageVersion,
            expectedCurrentAssetId: revisedRef!.currentAssetId,
            targetRevisionId: genesisRevision.revisionId,
            confirmNoCharge: true,
        })
        expect(restored.currentAssetId).toBe(genesis.genesisAssetId)
    })

    // §4.2 / §7.6 fail-closed: a restore that loses its lineage CAS in the window
    // between its chat flush and its commit must NOT leave the chat showing the
    // restored asset while the ledger points elsewhere. On version conflict the
    // existing (ledger-authoritative) image keeps showing and no re-charge happens.
    test('a restore that loses its lineage CAS reverts the chat to the ledger (no divergence)', async () => {
        const genesis = await seedGenesis()
        const ref = await resolveReference()
        // Replace once so there is a non-genesis current asset plus a genesis revision
        // to restore back to.
        await createImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'intent-div-replace',
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion,
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'exact-prompt',
            disposition: 'replace',
            confirmNewImageCharge: true,
            confirmNewLlmCharge: false,
        })
        await drainExecutor()
        const afterReplace = await readImageReference(ref.referenceId)
        const lineage = await readImageLineage(afterReplace!.lineageId)
        const genesisRevision = lineage!.revisions.find((entry) => entry.mode === 'genesis')!

        // Simulate a concurrent replace/restore that bumps the lineage in the window
        // between the restore's chat flush and its commit CAS. It is injected on the
        // restore's own flush (the first strictSave after this point) exactly once.
        const CONCURRENT_ASSET = 'asset:concurrent0000000000000000000000'
        let injected = false
        harness.strictSave.mockImplementation(async () => {
            if (!injected) {
                injected = true
                const key = revisionLedgerModule.illustrationReferenceKey(ref.referenceId)
                const rec = JSON.parse(new TextDecoder().decode(harness.storageMap.get(key)!))
                rec.lineageVersion += 1
                rec.currentAssetId = CONCURRENT_ASSET
                rec.currentRevisionId = 'rev:concurrent'
                harness.storageMap.set(key, new TextEncoder().encode(JSON.stringify(rec)))
            }
            return { success: true, durable: true }
        })

        await expect(restoreImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'intent-div-restore',
            referenceId: ref.referenceId,
            expectedOperationVersion: afterReplace!.operationVersion,
            expectedLineageVersion: afterReplace!.lineageVersion,
            expectedCurrentAssetId: afterReplace!.currentAssetId,
            targetRevisionId: genesisRevision.revisionId,
            confirmNoCharge: true,
        })).rejects.toThrow(/lineage|CAS|version/i)

        // Fail-closed: the chat must display the ledger's authoritative current asset,
        // never the restored target while the ledger points elsewhere.
        const finalRef = await readImageReference(ref.referenceId)
        const data = harness.database.characters[0].chats[0].message[0].data
        expect(finalRef!.currentAssetId).toBe(CONCURRENT_ASSET)
        expect(occurrences(data, `{{inlay::${CONCURRENT_ASSET}}}`)).toBe(1)
        expect(occurrences(data, `{{inlay::${genesis.genesisAssetId}}}`)).toBe(0)
    })

    // §4 no-orphan-charge: a crash while sealing the admission's durability (before
    // the idempotency receipt is durable) must not leave an executable 'queued'
    // revision child that the pump would dispatch (an orphan provider charge).
    test('a crash before the receipt is durable does not dispatch an orphan child', async () => {
        await seedGenesis()
        const ref = await resolveReference()
        const globalApi = await import('src/ts/globalApi.svelte')
        const forage = globalApi.forageStorage
        const original = forage.setItem.bind(forage)
        const spy = vi.spyOn(forage, 'setItem').mockImplementation(
            async (key: string, value: Uint8Array, etag?: string) => {
                // Crash exactly when the durable idempotency receipt is being written.
                if (key.startsWith('illustration:v1:revintent:')) {
                    throw new Error('simulated crash before receipt durability')
                }
                return original(key, value, etag)
            },
        )
        await expect(createImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'intent-crash-receipt',
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion,
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'exact-prompt',
            disposition: 'replace',
            confirmNewImageCharge: true,
            confirmNewLlmCharge: false,
        })).rejects.toThrow()
        spy.mockRestore()

        // No durable receipt was written, so nothing should be dispatchable: the child
        // must be persisted only AFTER the receipt is durable.
        await drainExecutor()
        expect(harness.provider).not.toHaveBeenCalled()
        const jobKeys = [...harness.storageMap.keys()].filter((k) => k.startsWith('illustration:v1:job:'))
        const records = jobKeys.map((k) => JSON.parse(new TextDecoder().decode(harness.storageMap.get(k)!)))
        const queuedRevisionChildren = records.filter((r) => r.revision && r.state === 'queued')
        expect(queuedRevisionChildren).toHaveLength(0)
    })
})

describe('Cluster C — revision ledger integrity', () => {
    // C-1: a transient index READ failure must abort the add, never overwrite the
    // durable reference index with a single-id list (which would vanish references).
    test('C-1: an index read IO failure aborts add-to-index and never clobbers the index', async () => {
        await seedGenesis()
        const first = await resolveReference()
        const indexKey = revisionLedgerModule.ILLUSTRATION_REFERENCE_INDEX_KEY
        const beforeRaw = harness.storageMap.get(indexKey)!
        const before = JSON.parse(new TextDecoder().decode(beforeRaw))
        expect(before.referenceIds).toContain(first.referenceId)

        // A second committed genesis job in the same message -> a fresh list backfills
        // a new reference and calls addToIndex, which reads the index first.
        const rawA = JSON.parse(new TextDecoder().decode(
            harness.storageMap.get('illustration:v1:job:genesisjob-1')!,
        ))
        const jobB = { ...rawA, jobId: 'genesisjob-2', assetId: 'asset:second00000000000000000000000000' }
        harness.storageMap.set(
            'illustration:v1:job:genesisjob-2',
            new TextEncoder().encode(JSON.stringify(jobB)),
        )
        harness.integrity.set(jobB.assetId, 'complete')

        const globalApi = await import('src/ts/globalApi.svelte')
        const forage = globalApi.forageStorage
        const original = forage.getItem.bind(forage)
        let thrown = false
        const spy = vi.spyOn(forage, 'getItem').mockImplementation(async (key: string) => {
            if (key === indexKey && !thrown) {
                thrown = true
                throw new Error('simulated index read IO failure')
            }
            return original(key)
        })

        await expect(listImageReferences({
            protocolVersion: 1,
            conversationId: 'conversation-1',
            messageId: 'message-1',
            limit: 10,
        })).rejects.toThrow(/simulated index read/)
        spy.mockRestore()

        // The durable index still holds the original reference; it was NOT overwritten
        // with a single-id list.
        const after = JSON.parse(new TextDecoder().decode(harness.storageMap.get(indexKey)!))
        expect(after.referenceIds).toContain(first.referenceId)
    })

    // C-2: a THROWN commitRestore (durable storage failure) must revert the chat swap
    // back to the ledger's authoritative asset before propagating — no chat/ledger
    // divergence.
    test('C-2: a thrown commitRestore reverts the chat to the authoritative asset', async () => {
        const genesis = await seedGenesis()
        const ref = await resolveReference()
        await createImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'c2-replace',
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion,
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'exact-prompt',
            disposition: 'replace',
            confirmNewImageCharge: true,
            confirmNewLlmCharge: false,
        })
        await drainExecutor()
        const replaced = await illustrationJobStore.getJob(
            (await revisionLedgerModule.readImageReference(ref.referenceId))!.sourceJobId,
        )
        const afterReplace = await readImageReference(ref.referenceId)
        const replaceAsset = afterReplace!.currentAssetId
        expect(replaceAsset).not.toBe(genesis.genesisAssetId)
        const lineage = await readImageLineage(afterReplace!.lineageId)
        const genesisRevision = lineage!.revisions.find((entry) => entry.mode === 'genesis')!

        // Make the restore's ledger reference write throw once (durable failure). The
        // reference does NOT commit, so the authoritative asset stays the replace asset.
        const globalApi = await import('src/ts/globalApi.svelte')
        const forage = globalApi.forageStorage
        const original = forage.setItem.bind(forage)
        const refKey = revisionLedgerModule.illustrationReferenceKey(ref.referenceId)
        let armed = true
        const spy = vi.spyOn(forage, 'setItem').mockImplementation(
            async (key: string, value: Uint8Array, etag?: string) => {
                if (key === refKey && armed) {
                    armed = false
                    throw new Error('simulated ledger reference write failure')
                }
                return original(key, value, etag)
            },
        )

        await expect(restoreImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'c2-restore',
            referenceId: ref.referenceId,
            expectedOperationVersion: afterReplace!.operationVersion,
            expectedLineageVersion: afterReplace!.lineageVersion,
            expectedCurrentAssetId: afterReplace!.currentAssetId,
            targetRevisionId: genesisRevision.revisionId,
            confirmNoCharge: true,
        })).rejects.toThrow(/simulated ledger reference write failure/)
        spy.mockRestore()

        // Fail-closed: chat reverted to the authoritative (replace) asset, not left on
        // the restored genesis asset.
        const data = harness.database.characters[0].chats[0].message[0].data
        expect(occurrences(data, `{{inlay::${replaceAsset}}}`)).toBe(1)
        expect(occurrences(data, `{{inlay::${genesis.genesisAssetId}}}`)).toBe(0)
        const finalRef = await readImageReference(ref.referenceId)
        expect(finalRef!.currentAssetId).toBe(replaceAsset)
        expect(replaced).toBeTruthy()
    })

    // C-3: a restore whose reference committed but whose receipt write failed must, on
    // same-key retry, recognize its already-committed state, backfill the receipt, and
    // succeed with no double version bump.
    test('C-3: torn restore (reference committed, receipt lost) retries idempotently', async () => {
        const genesis = await seedGenesis()
        const ref = await resolveReference()
        await createImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'c3-replace',
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion,
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'exact-prompt',
            disposition: 'replace',
            confirmNewImageCharge: true,
            confirmNewLlmCharge: false,
        })
        await drainExecutor()
        const afterReplace = await readImageReference(ref.referenceId)
        const lineage = await readImageLineage(afterReplace!.lineageId)
        const genesisRevision = lineage!.revisions.find((entry) => entry.mode === 'genesis')!

        // Make the restore's receipt (revintent) write throw once; the reference commit
        // has already landed by then.
        const globalApi = await import('src/ts/globalApi.svelte')
        const forage = globalApi.forageStorage
        const original = forage.setItem.bind(forage)
        let armed = true
        const spy = vi.spyOn(forage, 'setItem').mockImplementation(
            async (key: string, value: Uint8Array, etag?: string) => {
                if (key.startsWith('illustration:v1:revintent:') && armed) {
                    armed = false
                    throw new Error('simulated receipt write failure')
                }
                return original(key, value, etag)
            },
        )
        const restoreArgs = {
            protocolVersion: 1 as const,
            idempotencyKey: 'c3-restore',
            referenceId: ref.referenceId,
            expectedOperationVersion: afterReplace!.operationVersion,
            expectedLineageVersion: afterReplace!.lineageVersion,
            expectedCurrentAssetId: afterReplace!.currentAssetId,
            targetRevisionId: genesisRevision.revisionId,
            confirmNoCharge: true as const,
        }
        await expect(restoreImageRevision(restoreArgs)).rejects.toThrow()
        spy.mockRestore()

        const committedRef = await readImageReference(ref.referenceId)
        const opAfterFirst = committedRef!.operationVersion

        // Same-key retry: no receipt exists, the CAS would conflict, but the restore is
        // already committed -> idempotent success, receipt backfilled, no extra bump.
        const retried = await restoreImageRevision(restoreArgs)
        expect(retried.currentAssetId).toBe(genesis.genesisAssetId)
        const finalRef = await readImageReference(ref.referenceId)
        expect(finalRef!.operationVersion).toBe(opAfterFirst)
        expect(finalRef!.currentAssetId).toBe(genesis.genesisAssetId)
        expect(harness.provider).not.toHaveBeenCalledTimes(2)
    })

    // C-4: an admission whose receipt persisted but whose child-job write failed must,
    // on same-key retry, re-materialize the child instead of throwing corrupt forever.
    test('C-4: torn admission (receipt durable, child lost) re-materializes the child', async () => {
        await seedGenesis()
        const ref = await resolveReference()
        const globalApi = await import('src/ts/globalApi.svelte')
        const forage = globalApi.forageStorage
        const original = forage.setItem.bind(forage)
        let armed = true
        const spy = vi.spyOn(forage, 'setItem').mockImplementation(
            async (key: string, value: Uint8Array, etag?: string) => {
                // Crash exactly on the child job write (after the receipt is durable).
                if (key.startsWith('illustration:v1:job:') && armed) {
                    armed = false
                    throw new Error('simulated child write failure')
                }
                return original(key, value, etag)
            },
        )
        const admitArgs = {
            protocolVersion: 1 as const,
            idempotencyKey: 'c4-key',
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion,
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'exact-prompt' as const,
            disposition: 'replace' as const,
            confirmNewImageCharge: true,
            confirmNewLlmCharge: false,
        }
        await expect(createImageRevision(admitArgs)).rejects.toThrow(/simulated child write failure/)
        spy.mockRestore()

        // Same-key retry re-materializes the durable-receipt child.
        const retried = await createImageRevision(admitArgs)
        expect(retried.state).toBe('queued')
        const record = await illustrationJobStore.getJob(retried.jobId)
        expect(record).toBeTruthy()
        expect(record!.revision?.referenceId).toBe(ref.referenceId)

        // The re-materialized child dispatches exactly once and commits.
        await drainExecutor()
        expect(harness.provider).toHaveBeenCalledTimes(1)
        expect((await illustrationJobStore.getJob(retried.jobId))?.state).toBe('committed')
    })

    // C-5: a replace whose lineage append landed but whose reference CAS failed must,
    // on recovery re-run, NOT duplicate the lineage entry.
    test('C-5: replace commit dedups the lineage entry on replay', async () => {
        const genesis = await seedGenesis()
        const ref = await resolveReference()
        const lineageBefore = await readImageLineage(ref.lineageId)
        const genesisRevision = lineageBefore!.revisions.find((entry) => entry.mode === 'genesis')!

        const dupRevisionId = 'rev:c5-dup'
        const newAssetId = 'asset:c5new000000000000000000000000000'
        const childPrompt = flatPrompt('c5 positive', 'c5 negative')
        const promptHash = await revisionLedgerModule.promptHashFor(childPrompt)

        // Simulate the torn state: the lineage append already landed (recovery re-run),
        // but the reference CAS has NOT (reference still at genesis / lineageVersion 1).
        const lineageKey = revisionLedgerModule.illustrationLineageKey(ref.lineageId)
        const rawLineage = JSON.parse(new TextDecoder().decode(harness.storageMap.get(lineageKey)!))
        rawLineage.revisions.push({
            revisionId: dupRevisionId,
            parentRevisionId: genesisRevision.revisionId,
            jobId: 'c5-child',
            assetId: newAssetId,
            prompt: childPrompt,
            promptHash,
            mode: 'exact-prompt',
            disposition: 'replace',
            chargeCertainty: 'charged',
            createdAt: Date.now(),
        })
        harness.storageMap.set(lineageKey, new TextEncoder().encode(JSON.stringify(rawLineage)))

        const revision: any = {
            referenceId: ref.referenceId,
            lineageId: ref.lineageId,
            parentRevisionId: genesisRevision.revisionId,
            revisionId: dupRevisionId,
            mode: 'exact-prompt',
            disposition: 'replace',
            admittedOperationVersion: 1,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            promptHash,
        }
        const result = await revisionLedgerModule.commitReplaceReference({
            revision,
            childJobId: 'c5-child',
            newAssetId,
            childPrompt,
            chargeCertainty: 'charged',
        })
        expect(result.applied).toBe(true)

        const lineageAfter = await readImageLineage(ref.lineageId)
        const dupCount = lineageAfter!.revisions.filter((e) => e.revisionId === dupRevisionId).length
        expect(dupCount).toBe(1)
        const finalRef = await readImageReference(ref.referenceId)
        expect(finalRef!.currentRevisionId).toBe(dupRevisionId)
        expect(finalRef!.currentAssetId).toBe(newAssetId)
        expect(finalRef!.lineageVersion).toBe(2)
        expect(genesis.genesisAssetId).toBeTruthy()
    })

    // C-6: compaction beyond the live cap must archive slim stubs so an evicted
    // revision stays restorable, while the live window stays bounded.
    test('C-6: compaction archives evicted revisions and keeps them restorable', async () => {
        const genesis = await seedGenesis()
        const ref = await resolveReference()

        // Pad the live lineage up to the cap (genesis + 199 synthetic = 200), reference
        // untouched so the next replace's CAS still matches.
        const lineageKey = revisionLedgerModule.illustrationLineageKey(ref.lineageId)
        const rawLineage = JSON.parse(new TextDecoder().decode(harness.storageMap.get(lineageKey)!))
        const genesisRevisionId = rawLineage.revisions[0].revisionId
        for (let i = 0; i < 199; i += 1) {
            rawLineage.revisions.push({
                revisionId: `rev:pad-${i}`,
                parentRevisionId: genesisRevisionId,
                jobId: `pad-${i}`,
                assetId: `asset:pad-${i}`,
                prompt: flatPrompt(`pad ${i}`),
                promptHash: `hash-pad-${i}`,
                mode: 'exact-prompt',
                disposition: 'replace',
                chargeCertainty: 'charged',
                createdAt: BASE_TIME + i + 1,
            })
        }
        expect(rawLineage.revisions.length).toBe(200)
        harness.storageMap.set(lineageKey, new TextEncoder().encode(JSON.stringify(rawLineage)))

        // One real replace appends the 201st entry -> compaction evicts genesis (oldest
        // by array order) into the archive.
        await createImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'c6-replace',
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion,
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'exact-prompt',
            disposition: 'replace',
            confirmNewImageCharge: true,
            confirmNewLlmCharge: false,
        })
        await drainExecutor()

        const afterReplace = await readImageReference(ref.referenceId)
        const newAsset = afterReplace!.currentAssetId
        expect(newAsset).not.toBe(genesis.genesisAssetId)
        const compacted = await readImageLineage(afterReplace!.lineageId)
        // Live window bounded; genesis no longer live but archived as a slim stub.
        expect(compacted!.revisions.length).toBe(200)
        expect(compacted!.revisions.some((e) => e.revisionId === genesisRevisionId)).toBe(false)
        expect(compacted!.archivedRevisions?.some((s: any) => s.revisionId === genesisRevisionId)).toBe(true)

        // The evicted genesis revision is still restorable via its archived stub.
        const restored = await restoreImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'c6-restore',
            referenceId: ref.referenceId,
            expectedOperationVersion: afterReplace!.operationVersion,
            expectedLineageVersion: afterReplace!.lineageVersion,
            expectedCurrentAssetId: afterReplace!.currentAssetId,
            targetRevisionId: genesisRevisionId,
            confirmNoCharge: true,
        })
        expect(restored.currentAssetId).toBe(genesis.genesisAssetId)
        const data = harness.database.characters[0].chats[0].message[0].data
        expect(occurrences(data, `{{inlay::${genesis.genesisAssetId}}}`)).toBe(1)
        expect(occurrences(data, `{{inlay::${newAsset}}}`)).toBe(0)
    })
})

describe('D-4: committed V2 (envelope-identity) images are revision-eligible (Sol #8)', () => {
    test('a committed V2 job backfills a genesis reference + lineage keyed by the receipt envelopeHash', async () => {
        const g = await seedGenesisV2()
        const listed = await listImageReferences({
            protocolVersion: 1,
            conversationId: 'conversation-1',
            messageId: 'message-1',
            limit: 10,
        })
        expect(listed.items).toHaveLength(1)
        const reference = await readImageReference(listed.items[0].referenceId)
        expect(reference).toBeTruthy()
        // Envelope-identity: NO fabricated V1 prompt; identity is the receipt envelopeHash.
        expect(reference?.currentPrompt).toBeUndefined()
        expect(reference?.currentPromptHash).toBe(g.envelopeHash)
        expect(reference?.currentAssetId).toBe(g.genesisAssetId)
        const lineage = await readImageLineage(reference!.lineageId)
        expect(lineage?.revisions).toHaveLength(1)
        expect(lineage?.revisions[0].prompt).toBeUndefined()
        expect(lineage?.revisions[0].promptHash).toBe(g.envelopeHash)
        expect(lineage?.revisions[0].assetId).toBe(g.genesisAssetId)
        expect(lineage?.revisions[0].mode).toBe('genesis')
    })

    test('getImageRevisionTarget on a V2 reference returns the envelopeHash identity, no fabricated prompt', async () => {
        const g = await seedGenesisV2()
        const ref = await resolveReference()
        const target = await getImageRevisionTarget({ protocolVersion: 1, referenceId: ref.referenceId })
        expect(target.promptHash).toBe(g.envelopeHash)
        expect(target.prompt).toBeUndefined()
    })

    test('retag on an envelope-identity reference is a typed validation rejection (documented follow-up, provider 0)', async () => {
        await seedGenesisV2()
        const ref = await resolveReference()
        await expect(createImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'v2-retag',
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion,
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'retag',
            disposition: 'replace',
            confirmNewImageCharge: false,
            confirmNewLlmCharge: true,
        })).rejects.toMatchObject({ code: 'validation_failed' })
        // The admission CAS was never consumed and no provider ran.
        const after = await readImageReference(ref.referenceId)
        expect(after?.operationVersion).toBe(ref.operationVersion)
        expect(harness.provider).not.toHaveBeenCalled()
    })

    test('an exact-prompt/edited-prompt revision on a V2 reference is a typed validation rejection (documented follow-up)', async () => {
        await seedGenesisV2()
        const ref = await resolveReference()
        await expect(createImageRevision({
            protocolVersion: 1,
            idempotencyKey: 'v2-exact',
            referenceId: ref.referenceId,
            expectedOperationVersion: ref.operationVersion,
            sourceJobId: ref.sourceJobId,
            expectedLineageVersion: ref.lineageVersion,
            expectedCurrentAssetId: ref.currentAssetId,
            mode: 'exact-prompt',
            disposition: 'replace',
            confirmNewImageCharge: true,
            confirmNewLlmCharge: false,
        })).rejects.toMatchObject({ code: 'validation_failed' })
    })

    test('restore across two V2 (envelope-identity) revisions re-points the reference asset with no fabricated prompt', async () => {
        const g = await seedGenesisV2()
        const ref0 = await resolveReference()
        // Simulate a SECOND committed V2 revision (the V2 revision-child pipeline is a
        // documented joint follow-up): append a second envelope-identity entry to the
        // lineage and advance the reference to it, directly in storage.
        const reference = await readImageReference(ref0.referenceId)
        const lineage = await readImageLineage(ref0.lineageId)
        const genesisEntry = lineage!.revisions[0]
        const asset2 = 'asset:v2rev2000000000000000000000000'
        const rev2Hash = 'v2envelopehash2222222222222222222222222222222222222222222222bb00'
        const secondEntry = {
            revisionId: 'rev:v2:second',
            parentRevisionId: genesisEntry.revisionId,
            jobId: 'genesisjobv2-1',
            assetId: asset2,
            promptHash: rev2Hash,
            mode: 'replace' as const,
            disposition: 'replace' as const,
            chargeCertainty: 'charged' as const,
            createdAt: Date.now(),
        }
        const nextLineage = {
            ...lineage!,
            revisions: [...lineage!.revisions, secondEntry],
            updatedAt: Date.now(),
        }
        const nextReference = {
            ...reference!,
            operationVersion: reference!.operationVersion + 1,
            lineageVersion: reference!.lineageVersion + 1,
            currentAssetId: asset2,
            currentRevisionId: secondEntry.revisionId,
            currentPromptHash: rev2Hash,
            updatedAt: Date.now(),
        }
        // currentPrompt intentionally stays absent (envelope-identity).
        delete (nextReference as { currentPrompt?: unknown }).currentPrompt
        harness.storageMap.set(
            illustrationLineageKey(reference!.lineageId),
            new TextEncoder().encode(JSON.stringify(nextLineage)),
        )
        harness.storageMap.set(
            illustrationReferenceKey(reference!.referenceId),
            new TextEncoder().encode(JSON.stringify(nextReference)),
        )
        harness.integrity.set(asset2, 'complete')

        // Restore back to the genesis revision at the ledger level (prepareRestore +
        // commitRestore is the restore code path; it must handle the absent V1 prompt).
        const prepared = await prepareRestore({
            referenceId: reference!.referenceId,
            expectedOperationVersion: nextReference.operationVersion,
            expectedLineageVersion: nextReference.lineageVersion,
            expectedCurrentAssetId: asset2,
            targetRevisionId: genesisEntry.revisionId,
        })
        expect(prepared.targetEntry.prompt).toBeUndefined()
        expect(prepared.targetEntry.assetId).toBe(g.genesisAssetId)
        const bindingHash = await restoreBindingHash({
            referenceId: reference!.referenceId,
            expectedOperationVersion: nextReference.operationVersion,
            expectedLineageVersion: nextReference.lineageVersion,
            expectedCurrentAssetId: asset2,
            targetRevisionId: genesisEntry.revisionId,
        })
        const committed = await commitRestore({
            referenceId: reference!.referenceId,
            expectedOperationVersion: nextReference.operationVersion,
            expectedLineageVersion: nextReference.lineageVersion,
            targetEntry: prepared.targetEntry,
            idempotencyKey: 'v2-restore',
            bindingHash,
        })
        expect(committed.applied).toBe(true)
        const restored = await readImageReference(reference!.referenceId)
        expect(restored?.currentAssetId).toBe(g.genesisAssetId)
        expect(restored?.currentRevisionId).toBe(genesisEntry.revisionId)
        expect(restored?.currentPromptHash).toBe(g.envelopeHash)
        expect(restored?.currentPrompt).toBeUndefined()
    })
})

// --- coordinator supplyPrompt helper (retag Tagger) -------------------------
async function refreshCoordinatorProof(): Promise<{ coordinatorLeaseId: string; coordinatorFence: number }> {
    const snapshot = await coordinatorRecordModule.claimCoordinator({
        protocolVersion: 1,
        leaseId: 'test-coordinator',
        holderRuntimeId: 'test-runtime',
    })
    return { coordinatorLeaseId: 'test-coordinator', coordinatorFence: snapshot.fence }
}
async function coordinatorSupplyPrompt(input: any): Promise<IllustrationJobRecordV1> {
    return await coordinatorModule.supplyPromptLedger(input)
}
