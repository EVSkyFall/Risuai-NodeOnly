import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Chat, Message } from '../../../storage/database.svelte'
import { buildRequestMarker } from '../controlNodes'
import { IllustrationLedgerTerminalCloseError } from '../errors'
import { toIllustrationV3RpcError } from '../v3Bridge'
import {
    createImagePromptMeasurementService,
    createImagePromptTokenizerLoader,
    setImagePromptMeasurementServiceForTests,
} from '../imagePromptMeasurement'
import { installImagePromptMeasurementTestService } from './imagePromptTestHarness'
import { InMemoryLockManager } from './inMemoryLockManager'

const harness = vi.hoisted(() => ({
    storageMap: new Map<string, Uint8Array>(),
    storageEvents: [] as string[],
    database: null as any,
    strictFailure: null as Error | null,
    storageHook: null as ((key: string) => void) | null,
    mutationHook: null as (() => void) | null,
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
        async setItem(key: string, value: Uint8Array) {
            harness.storageEvents.push(`storage:${key}`)
            harness.storageHook?.(key)
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

const coordinatorModule = await import('../coordinator')
const coordinatorRecordModule = await import('../coordinatorRecord')
const capturePolicyModule = await import('../capturePolicy')
const featureModule = await import('../featureFlag')
const illustrationEventsModule = await import('../illustrationEvents')
const lockModule = await import('../locks')
const operationLockModule = await import('../operationLock')
const storeModule = await import('../store')

const {
    cancelLedger,
    cancelTurnLedger,
    purgeAutomaticBacklog,
    registerTrustedTurn,
    requestCurrentVariant,
    submitPlanLedger,
    supplyPromptLedger,
} = coordinatorModule
const { writeDurableCaptureMode } = capturePolicyModule
const { claimCoordinator } = coordinatorRecordModule
const { IllustrationFeatureDisabledError, setIllustrationFeatureEnabled } = featureModule
const { subscribeIllustrationWakeHints } = illustrationEventsModule
const { resetIllustrationLockManagerAccessorForTests, setIllustrationLockManagerAccessorForTests } = lockModule
const {
    resetIllustrationOperationLockManagerAccessorForTests,
    setIllustrationOperationLockManagerAccessorForTests,
} = operationLockModule
const {
    illustrationJobStore,
    illustrationJobKey,
    illustrationManifestKey,
    illustrationTurnKey,
} = storeModule

const BASE_TIME = Date.UTC(2026, 0, 2)
let mutationEvents: string[]
let lockManager: InMemoryLockManager
let coordinatorProof: { coordinatorLeaseId: string; coordinatorFence: number }
let restoreImagePromptMeasurement = () => {}

async function refreshCoordinatorProof(): Promise<void> {
    const snapshot = await claimCoordinator({
        protocolVersion: 1,
        leaseId: 'test-coordinator',
        holderRuntimeId: 'test-runtime',
    })
    coordinatorProof = {
        coordinatorLeaseId: 'test-coordinator',
        coordinatorFence: snapshot.fence,
    }
}

function makeMessage(source: string): Message {
    let data = source
    const message = {
        role: 'char',
        chatId: 'message-1',
    } as Message
    Object.defineProperty(message, 'data', {
        enumerable: true,
        configurable: true,
        get: () => data,
        set: (value: string) => {
            mutationEvents.push('marker')
            harness.mutationHook?.()
            data = value
        },
    })
    return message
}

function installDatabase(source = 'A quiet scene.'): Chat {
    const chat: Chat = {
        id: 'conversation-1',
        name: 'chat',
        note: '',
        localLore: [],
        fmIndex: -1,
        message: [makeMessage(source)],
    }
    harness.database = {
        characters: [{ chaId: 'character-1', chats: [chat], chatPage: 0 }],
        sdProvider: 'novelai',
        NAIImgUrl: 'https://image.novelai.net/ai/generate-image',
        NAIImgModel: 'nai-diffusion-4-5-full',
        NAII2I: false,
        NAIImgConfig: {},
    }
    return chat
}

function registerInput(sourceVariantText = 'A quiet scene.') {
    return {
        chaId: 'character-1',
        conversationId: 'conversation-1',
        expectedMessageId: 'message-1',
        rootTurnId: 'root-turn-1',
        sourceVariantText,
    }
}

function decodeStored<T>(key: string): T | null {
    const value = harness.storageMap.get(key)
    return value ? JSON.parse(new TextDecoder().decode(value)) as T : null
}

async function registerAndClaim(source = 'A quiet scene.') {
    installDatabase(source)
    const registered = await registerTrustedTurn(registerInput(source))
    const claimed = await illustrationJobStore.claimTurn({
        ...coordinatorProof,
        turnId: registered.turnId,
        expectedVersion: registered.version,
        leaseId: 'planner-lease',
    })
    return { registered, claimed }
}

function submitInput(
    claimed: Awaited<ReturnType<typeof illustrationJobStore.claimTurn>>,
    offsets: number[],
) {
    return {
        ...coordinatorProof,
        turnId: claimed.turnId,
        expectedVersion: claimed.version,
        leaseId: 'planner-lease',
        fence: claimed.fence,
        idempotencyKey: `plan:${claimed.turnId}`,
        sourceRevisionHash: claimed.sourceRevisionHash!,
        slots: offsets.map((insertAfterUtf16, index) => ({
            sceneId: `scene-${index}`,
            insertAfterUtf16,
            scenePayload: { schemaVersion: 1, data: { description: `scene ${index}` } },
        })),
    }
}

beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    harness.storageMap.clear()
    harness.storageEvents.length = 0
    harness.strictFailure = null
    harness.storageHook = null
    harness.mutationHook = null
    harness.strictSave.mockReset()
    mutationEvents = []
    installDatabase()
    restoreImagePromptMeasurement = installImagePromptMeasurementTestService(() => harness.database)
    lockManager = new InMemoryLockManager()
    setIllustrationLockManagerAccessorForTests(() => lockManager)
    setIllustrationOperationLockManagerAccessorForTests(() => lockManager)
    await setIllustrationFeatureEnabled(true)
    await refreshCoordinatorProof()
    harness.storageEvents.length = 0
    harness.strictSave.mockImplementation(async () => {
        mutationEvents.push('strict')
        harness.storageEvents.push('strict')
        if (harness.strictFailure) throw harness.strictFailure
        return { success: true, durable: true }
    })
})

describe('submitPlanLedger', () => {
    // §20 Manifest/API + §7.3: prepared manifest -> records -> records_complete -> projection ACK.
    test('materializes all slots in one transform and advances records only after strict ACK', async () => {
        const { claimed } = await registerAndClaim('ABCD')
        harness.storageEvents.length = 0
        harness.strictSave.mockImplementation(async () => {
            harness.storageEvents.push('strict')
            const manifest = decodeStored<any>(illustrationManifestKey(claimed.turnId))
            expect(manifest.phase).toBe('records_complete')
            for (const entry of manifest.jobs) {
                expect(decodeStored<any>(illustrationJobKey(entry.jobId)).state).toBe('prepared')
            }
            return { success: true, durable: true }
        })

        const jobs = await submitPlanLedger(submitInput(claimed, [1, 3]))
        const manifest = await illustrationJobStore.getManifest(claimed.turnId)
        const turn = await illustrationJobStore.getTurn(claimed.turnId)
        const text = harness.database.characters[0].chats[0].message[0].data as string

        expect(jobs).toHaveLength(2)
        expect(jobs.every((job: any) => job.state === 'awaiting_prompt')).toBe(true)
        expect(manifest?.phase).toBe('projection_durable')
        expect(turn?.state).toBe('awaiting_prompt')
        expect(text).not.toContain('risu-illustration-request')
        expect(text.match(/<risu-illustration-slot /g)).toHaveLength(2)
        expect(text.startsWith('A<risu-illustration-slot')).toBe(true)
        expect(text.endsWith('</risu-illustration-slot>D')).toBe(true)

        const strictIndex = harness.storageEvents.indexOf('strict')
        const manifestWrites = harness.storageEvents
            .map((event, index) => event === `storage:${illustrationManifestKey(claimed.turnId)}` ? index : -1)
            .filter((index) => index >= 0)
        expect(manifestWrites).toHaveLength(3)
        expect(manifestWrites[1]).toBeLessThan(strictIndex)
        expect(strictIndex).toBeLessThan(manifestWrites[2])
    })

    // §20 Maximum jobs and placement validation happen before chat mutation/flush.
    test('rejects a sixteenth slot and invalid UTF-16 offsets before any chat write', async () => {
        const { claimed } = await registerAndClaim('A😀B')
        const markerText = harness.database.characters[0].chats[0].message[0].data
        harness.strictSave.mockClear()

        await expect(submitPlanLedger(submitInput(claimed, Array.from({ length: 16 }, (_, i) => i))))
            .rejects.toThrow('at most 15')
        await expect(submitPlanLedger(submitInput(claimed, [2])))
            .rejects.toThrow('surrogate_split')

        expect(harness.strictSave).not.toHaveBeenCalled()
        expect(harness.database.characters[0].chats[0].message[0].data).toBe(markerText)
        expect(await illustrationJobStore.getManifest(claimed.turnId)).toBeNull()
    })

    // §20 Target/edit: a changed normalized source becomes stale without chat write.
    test('marks a changed source stale before manifest or chat write', async () => {
        const { claimed } = await registerAndClaim('Original')
        const message = harness.database.characters[0].chats[0].message[0]
        message.data = `Edited${message.data.slice('Original'.length)}`
        harness.strictSave.mockClear()

        await expect(submitPlanLedger(submitInput(claimed, [1]))).rejects.toThrow('stale')

        expect((await illustrationJobStore.getTurn(claimed.turnId))?.state).toBe('stale')
        expect(await illustrationJobStore.getManifest(claimed.turnId)).toBeNull()
        expect(harness.strictSave).not.toHaveBeenCalled()
    })

    // §20 zero-scene Planner result removes the request marker durably and ends the turn.
    test('durably removes the marker and closes a zero-scene turn', async () => {
        const { claimed } = await registerAndClaim('No image needed.')
        harness.strictSave.mockClear()

        const jobs = await submitPlanLedger(submitInput(claimed, []))

        expect(jobs).toEqual([])
        expect(harness.strictSave).toHaveBeenCalledTimes(1)
        expect(harness.database.characters[0].chats[0].message[0].data).toBe('No image needed.')
        expect((await illustrationJobStore.getManifest(claimed.turnId))?.phase).toBe('projection_durable')
        expect((await illustrationJobStore.getTurn(claimed.turnId))?.state).toBe('no_scenes')
    })

    // §20 Manifest/API: a lost submitPlan response replays the durable projection.
    test('returns the existing jobs for an identical submitPlan replay', async () => {
        const { claimed } = await registerAndClaim('Replay plan')
        const input = submitInput(claimed, [6])
        const first = await submitPlanLedger(input)
        harness.strictSave.mockClear()

        const replay = await submitPlanLedger(input)

        expect(replay).toEqual(first)
        expect(await illustrationJobStore.listJobs({ turnId: claimed.turnId })).toHaveLength(1)
        expect(harness.strictSave).not.toHaveBeenCalled()
    })

    test('reconciles an identical replay after strict ACK but before projection_durable', async () => {
        const { claimed } = await registerAndClaim('Phase replay')
        const input = submitInput(claimed, [5])
        let manifestWrites = 0
        harness.storageHook = (key) => {
            if (key === illustrationManifestKey(claimed.turnId) && ++manifestWrites === 3) {
                throw new Error('crash before projection phase')
            }
        }
        await expect(submitPlanLedger(input)).rejects.toThrow('crash before projection phase')
        harness.storageHook = null

        const replay = await submitPlanLedger(input)

        expect(replay).toHaveLength(1)
        expect(replay[0].state).toBe('awaiting_prompt')
        expect((await illustrationJobStore.getManifest(claimed.turnId))?.phase)
            .toBe('projection_durable')
        expect((await illustrationJobStore.getTurn(claimed.turnId))?.state).toBe('awaiting_prompt')
    })

    test('serializes concurrent identical submitPlan calls into one projection flush', async () => {
        const { claimed } = await registerAndClaim('Concurrent plan')
        const input = submitInput(claimed, [5])
        harness.strictSave.mockClear()

        const [first, second] = await Promise.all([
            submitPlanLedger(input),
            submitPlanLedger(input),
        ])

        expect(second).toEqual(first)
        expect(harness.strictSave).toHaveBeenCalledTimes(1)
        expect(await illustrationJobStore.listJobs({ turnId: claimed.turnId })).toHaveLength(1)
    })

    // §8.3 materialization CAS: an edit during ledger writes is never overwritten.
    test('rechecks the source immediately before projection and preserves an intervening edit', async () => {
        const { claimed } = await registerAndClaim('Race source')
        const message = harness.database.characters[0].chats[0].message[0]
        let edited = false
        harness.storageHook = (key) => {
            if (!edited && key.startsWith('illustration:v1:job:')) {
                edited = true
                message.data = message.data.replace('Race source', 'User edit')
            }
        }
        harness.strictSave.mockClear()

        await expect(submitPlanLedger(submitInput(claimed, [4]))).rejects.toThrow('stale')

        expect(message.data).toContain('User edit')
        expect(message.data).not.toContain('risu-illustration-slot')
        expect(harness.strictSave).not.toHaveBeenCalled()
        expect((await illustrationJobStore.getTurn(claimed.turnId))?.state).toBe('stale')
        expect((await illustrationJobStore.listJobs({ turnId: claimed.turnId }))[0]?.state).toBe('stale')
    })

    // §5-3 / real-path 3+6: a framed marker (LF injected at capture) submits without
    // a source_text/hash mismatch, and the projection leaves no injected-LF residue.
    test('submits a framed-marker turn and materializes the canonical source without LF residue', async () => {
        const { claimed } = await registerAndClaim('Body with no trailing newline')
        expect(harness.database.characters[0].chats[0].message[0].data)
            .toMatch(/^Body with no trailing newline\n<!--risu-illustration-request:v1:[A-Za-z0-9_-]+-->$/)

        const jobs = await submitPlanLedger(submitInput(claimed, [4]))

        expect(jobs).toHaveLength(1)
        expect((await illustrationJobStore.getTurn(claimed.turnId))?.state).toBe('awaiting_prompt')
        const data = harness.database.characters[0].chats[0].message[0].data as string
        expect(data).not.toContain('risu-illustration-request')
        expect(data.match(/<risu-illustration-slot /g)).toHaveLength(1)
        expect(data.replace(/<risu-illustration-slot[\s\S]*?<\/risu-illustration-slot>/, ''))
            .toBe('Body with no trailing newline')
    })

    // §5-9 / real-path 9: a legacy adjacent-marker turn (durable source + marker with
    // no injected LF) still submits, restored via the marker-only candidate.
    test('keeps a legacy adjacent-marker turn submitting through the marker-only candidate', async () => {
        const { registered, claimed } = await registerAndClaim('Legacy adjacent body')
        const message = harness.database.characters[0].chats[0].message[0]
        // Rewrite to the pre-contract adjacent serialization: no injected LF.
        message.data = `Legacy adjacent body${buildRequestMarker(registered.target!.requestNonce)}`

        const jobs = await submitPlanLedger(submitInput(claimed, [6]))

        expect(jobs).toHaveLength(1)
        expect((await illustrationJobStore.getTurn(claimed.turnId))?.state).toBe('awaiting_prompt')
        expect(message.data).not.toContain('risu-illustration-request')
        expect(message.data.replace(/<risu-illustration-slot[\s\S]*?<\/risu-illustration-slot>/, ''))
            .toBe('Legacy adjacent body')
    })
})

describe('prompt handoff and cancellation', () => {
    async function createClaimedPromptJob(source = 'Prompt source') {
        const { claimed } = await registerAndClaim(source)
        const [projected] = await submitPlanLedger(submitInput(claimed, [source.length]))
        const job = await illustrationJobStore.claimJob({
            ...coordinatorProof,
            jobId: projected.jobId,
            expectedVersion: projected.version,
            leaseId: 'tagger-lease',
        })
        return job
    }

    function promptInput(job: Awaited<ReturnType<typeof illustrationJobStore.claimJob>>) {
        return {
            ...coordinatorProof,
            jobId: job.jobId,
            expectedVersion: job.version,
            leaseId: 'tagger-lease',
            fence: job.fence,
            idempotencyKey: `prompt:${job.jobId}`,
            positive: 'cinematic scene',
            negative: '',
        }
    }

    test('persists turn cancellation before best-effort strict marker removal', async () => {
        const { claimed } = await registerAndClaim('Cancelled source')
        const order: string[] = []
        harness.storageHook = (key) => {
            if (key === illustrationTurnKey(claimed.turnId)) order.push('ledger')
        }
        harness.mutationHook = () => order.push('marker')
        harness.strictSave.mockImplementation(async () => {
            order.push('strict')
            return { success: true, durable: true }
        })

        const cancelled = await cancelTurnLedger({
            turnId: claimed.turnId,
            expectedVersion: claimed.version,
        })
        expect(cancelled).toMatchObject({ state: 'cancelled' })
        expect(order).toEqual(['ledger', 'marker', 'strict'])
        expect((await illustrationJobStore.getTurn(claimed.turnId))?.leaseId).toBeNull()
        // §5 cancel priority 1 / real-path 7: source-aware cleanup restores the exact
        // captured source, dropping the injected line-boundary LF (no residue).
        expect(harness.database.characters[0].chats[0].message[0].data).toBe('Cancelled source')
    })

    // §5 cancel priority 2 / real-path 8: when the user edited the marked body so
    // neither restore candidate matches, cleanup removes ONLY the marker span and
    // preserves the edit and surrounding whitespace (the injected LF may remain).
    test('preserves a user edit and strips only the marker when the source no longer matches', async () => {
        const { claimed } = await registerAndClaim('Editable cancel source')
        const message = harness.database.characters[0].chats[0].message[0]
        expect(message.data).toMatch(/^Editable cancel source\n<!--risu-illustration-request:v1:[A-Za-z0-9_-]+-->$/)
        message.data = message.data.replace('Editable cancel source', 'User rewrote this\ttext')

        const cancelled = await cancelTurnLedger({
            turnId: claimed.turnId,
            expectedVersion: claimed.version,
        })

        expect(cancelled.state).toBe('cancelled')
        expect(message.data).toBe('User rewrote this\ttext\n')
        expect(message.data).not.toContain('risu-illustration-request')
    })

    test('does not roll back cancelled when strict marker removal fails', async () => {
        const { claimed } = await registerAndClaim('Cancelled flush failure')
        harness.strictSave.mockClear()
        harness.strictFailure = new Error('strict removal failed')
        const cancelled = await cancelTurnLedger({
            turnId: claimed.turnId,
            expectedVersion: claimed.version,
        })
        expect(cancelled.state).toBe('cancelled')
        expect((await illustrationJobStore.getTurn(claimed.turnId))?.state).toBe('cancelled')
        expect(harness.strictSave).toHaveBeenCalledTimes(1)
    })

    // §10.1 / §14: final prompts are validated and durable before queued.
    test('queues a durable positive prompt while allowing an empty negative prompt', async () => {
        const job = await createClaimedPromptJob()

        const queued = await supplyPromptLedger(promptInput(job))

        expect(queued).toMatchObject({
            state: 'queued',
            prompt: {
                schemaVersion: 1,
                layout: 'flat',
                basePositive: 'cinematic scene',
                characterPositives: [],
                baseNegative: '',
                characterNegatives: [],
            },
        })
    })

    // §20 Manifest/API: a lost supplyPrompt response replays the same queued write.
    test('returns the queued job for an identical supplyPrompt replay', async () => {
        const job = await createClaimedPromptJob()
        const input = promptInput(job)
        const first = await supplyPromptLedger(input)

        const replay = await supplyPromptLedger(input)

        expect(replay).toEqual(first)
        expect((await illustrationJobStore.getJob(job.jobId))?.version).toBe(first.version)
    })

    // Request §4 row 8: a pre-contract physical flat ACK replays without migration/measurement.
    test('replays a physical legacy string handoff byte-exactly across the upgrade boundary', async () => {
        const job = await createClaimedPromptJob()
        const input = promptInput(job)
        const accepted = await supplyPromptLedger(input)
        const key = illustrationJobKey(job.jobId)
        const physicalLegacy = decodeStored<any>(key)
        physicalLegacy.prompt = { positive: input.positive, negative: input.negative }
        harness.storageMap.set(key, new TextEncoder().encode(JSON.stringify(physicalLegacy)))

        restoreImagePromptMeasurement()
        restoreImagePromptMeasurement = setImagePromptMeasurementServiceForTests({
            resolveSettings: async () => { throw new Error('legacy replay must not measure') },
            measure: async () => { throw new Error('legacy replay must not measure') },
        })

        await expect(supplyPromptLedger(input)).resolves.toMatchObject({
            version: accepted.version,
            prompt: { positive: input.positive, negative: input.negative },
        })
        await expect(supplyPromptLedger({ ...input, positive: `${input.positive}!` }))
            .rejects.toThrow('conflicting patch data')
    })

    // Request §4 row 5: durable structure/order is the lost-ACK provenance identity.
    test('persists structured parts and rejects reordered replay as conflicting identity', async () => {
        const job = await createClaimedPromptJob()
        const { positive: _positive, negative: _negative, ...base } = promptInput(job)
        const prompt = {
            schemaVersion: 1 as const,
            layout: 'nai-v4-characters' as const,
            basePositive: 'base positive',
            characterPositives: ['source#1 Alice', 'target#2 Bob'],
            baseNegative: 'base negative',
            characterNegatives: ['negative Alice', 'negative Bob'],
        }
        const input = { ...base, prompt }
        const queued = await supplyPromptLedger(input)

        expect(decodeStored<any>(illustrationJobKey(job.jobId)).prompt).toEqual(prompt)
        await expect(supplyPromptLedger(input)).resolves.toEqual(queued)
        await expect(supplyPromptLedger({
            ...input,
            prompt: {
                ...prompt,
                characterPositives: [...prompt.characterPositives].reverse(),
            },
        })).rejects.toThrow('conflicting patch data')
        expect((await illustrationJobStore.getJob(job.jobId))?.prompt).toEqual(prompt)
    })

    // Request §4 rows 1-2: final combined over-limit rejects before the durable handoff.
    test('rejects an over-limit final V4 prompt with measured payload and no state change', async () => {
        const job = await createClaimedPromptJob()
        const before = await illustrationJobStore.getJob(job.jobId)
        restoreImagePromptMeasurement()
        restoreImagePromptMeasurement = installImagePromptMeasurementTestService(
            () => harness.database,
            (text) => text === 'cinematic scene' ? 513 : 0,
        )

        await expect(supplyPromptLedger(promptInput(job))).rejects.toMatchObject({
            code: 'image_prompt_over_limit',
            payload: {
                positiveTokens: 513,
                negativeTokens: 0,
                maxPositiveTokens: 512,
                maxNegativeTokens: 512,
                model: 'nai-diffusion-4-5-full',
            },
        })
        expect(await illustrationJobStore.getJob(job.jobId)).toEqual(before)
    })

    // Request §4 row 7: transient tokenizer failure is fail-closed but does not poison retry.
    test('keeps awaiting_prompt on tokenizer failure and accepts a later retry', async () => {
        const job = await createClaimedPromptJob()
        const loadModel = vi.fn()
            .mockRejectedValueOnce(new Error('asset temporarily unavailable'))
            .mockResolvedValue(new ArrayBuffer(0))
        restoreImagePromptMeasurement()
        restoreImagePromptMeasurement = setImagePromptMeasurementServiceForTests(
            createImagePromptMeasurementService({
                getDatabase: () => harness.database,
                tokenizerLoader: createImagePromptTokenizerLoader({
                    loadModel,
                    createTokenizer: async () => ({ encode: () => ({ length: 1 }) }),
                }),
            }),
        )

        await expect(supplyPromptLedger(promptInput(job)))
            .rejects.toMatchObject({ code: 'image_tokenizer_unavailable' })
        const unchanged = await illustrationJobStore.getJob(job.jobId)
        expect(unchanged?.state).toBe('awaiting_prompt')
        expect(unchanged?.prompt).toBeUndefined()
        await expect(supplyPromptLedger(promptInput(job))).resolves.toMatchObject({ state: 'queued' })
        expect(loadModel).toHaveBeenCalledTimes(2)
    })

    test('rejects blank or over-16-KiB UTF-8 prompts before any job write', async () => {
        const job = await createClaimedPromptJob()
        const before = await illustrationJobStore.getJob(job.jobId)

        await expect(supplyPromptLedger({ ...promptInput(job), positive: '   ' }))
            .rejects.toThrow('positive prompt')
        await expect(supplyPromptLedger({ ...promptInput(job), positive: '가'.repeat(5_462) }))
            .rejects.toThrow('16 KiB')
        await expect(supplyPromptLedger({ ...promptInput(job), negative: '가'.repeat(5_462) }))
            .rejects.toThrow('16 KiB')

        expect(await illustrationJobStore.getJob(job.jobId)).toEqual(before)
    })

    // §5-8 / §8.3: edit discovered at Tagger handoff stales before prompt persistence.
    test('stales an awaiting_prompt job when the source changed before handoff', async () => {
        const job = await createClaimedPromptJob('Editable source')
        const message = harness.database.characters[0].chats[0].message[0]
        message.data = message.data.replace('Editable source', 'Edited source')

        await expect(supplyPromptLedger(promptInput(job))).rejects.toThrow('stale')

        const stale = await illustrationJobStore.getJob(job.jobId)
        expect(stale?.state).toBe('stale')
        expect(stale?.prompt).toBeUndefined()
    })

    test('preserves cumulative Agent attempts when a retried prompt handoff closes stale', async () => {
        const job = await createClaimedPromptJob('Retry then edit source')
        const blocked = await illustrationJobStore.reportAgentFailure({
            protocolVersion: 1,
            kind: 'job',
            id: job.jobId,
            expectedVersion: job.version,
            leaseId: 'tagger-lease',
            fence: job.fence,
            ...coordinatorProof,
            idempotencyKey: 'failure:retry-then-edit',
            code: 'tagger_failed',
            retryable: true,
        })
        const retried = await illustrationJobStore.retryAgentFailure({
            protocolVersion: 1,
            kind: 'job',
            id: job.jobId,
            expectedVersion: blocked.version,
            confirmNewLlmCharge: true,
            ...coordinatorProof,
        })
        const reclaimed = await illustrationJobStore.claimJob({
            ...coordinatorProof,
            jobId: job.jobId,
            expectedVersion: retried.version,
            leaseId: 'tagger-lease',
        })
        const message = harness.database.characters[0].chats[0].message[0]
        message.data = message.data.replace('Retry then edit source', 'Edited after retry')

        await expect(supplyPromptLedger(promptInput(reclaimed))).rejects.toThrow('stale')
        expect(await illustrationJobStore.getJob(job.jobId)).toMatchObject({
            state: 'stale',
            agentAttemptCount: 1,
        })
    })

    // §10.3 queued cancel is immediate and needs no provider participation.
    test('cancels a queued job immediately', async () => {
        const claimed = await createClaimedPromptJob()
        const queued = await supplyPromptLedger(promptInput(claimed))

        const cancelled = await cancelLedger({
            jobId: queued.jobId,
            expectedVersion: queued.version,
        })

        expect(cancelled).toMatchObject({ state: 'cancelled', cancelRequestedAt: BASE_TIME })
    })
})

// Terminal Submit Diagnostics: a submitPlan that durably terminal-closes the turn for
// a stale/corrupt request must return a stable, secret-safe class code (distinct from
// generic request validation) and wake subscribers exactly once — only after the
// durable close actually completed.
describe('submitPlan terminal close diagnostics', () => {
    const SENTINEL = 'SENTINEL9QZX'

    function messageRecord(): Message {
        return harness.database.characters[0].chats[0].message[0]
    }

    function currentMarker(): string {
        const match = (messageRecord().data as string)
            .match(/<!--risu-illustration-request:v1:[A-Za-z0-9_-]+-->/)
        if (!match) throw new Error('expected an injected request marker')
        return match[0]
    }

    async function collectWake<T>(
        run: () => Promise<T>,
    ): Promise<{ error?: unknown; hints: Array<{ kind: string; turnId: string }> }> {
        const hints: Array<{ kind: string; turnId: string }> = []
        const unsubscribe = subscribeIllustrationWakeHints((hint) => { hints.push(hint) })
        let error: unknown
        try { await run() } catch (thrown) { error = thrown }
        for (let index = 0; index < 8; index += 1) await Promise.resolve()
        unsubscribe()
        return { error, hints }
    }

    // §3.1 / §3.9: a marker-missing stale close returns the stable turn_terminal_stale
    // class code through the REAL v3 bridge sanitization and leaves the turn durably
    // stale, while the internal marker reason stays on the record and is never echoed.
    test('stale close returns turn_terminal_stale and keeps the durable reason internal', async () => {
        const { claimed } = await registerAndClaim('A quiet scene.')
        messageRecord().data = 'A quiet scene.' // strip the request marker -> marker_missing

        let thrown: unknown
        await submitPlanLedger(submitInput(claimed, [1])).catch((error) => { thrown = error })

        expect(thrown).toBeInstanceOf(IllustrationLedgerTerminalCloseError)
        expect((thrown as IllustrationLedgerTerminalCloseError).code).toBe('turn_terminal_stale')
        const rpc = toIllustrationV3RpcError(thrown)
        expect(rpc.message)
            .toBe('[IJ:turn_terminal_stale] The illustration turn became stale before plan submission.')
        expect(rpc.payload).toBeUndefined()
        const turn = await illustrationJobStore.getTurn(claimed.turnId)
        expect(turn?.state).toBe('stale')
        expect(turn?.error?.code).toBe('marker_missing')
        expect(rpc.message).not.toContain('marker_missing')
    })

    // §3.2 / §3.3: a duplicate-marker corrupt close returns turn_terminal_corrupt and
    // the durable turn class is corrupt (state/code coherence).
    test('corrupt close returns turn_terminal_corrupt with a coherent durable state', async () => {
        const { claimed } = await registerAndClaim('Doubled marker.')
        messageRecord().data = `${messageRecord().data}${currentMarker()}` // same-nonce duplicate

        let thrown: unknown
        await submitPlanLedger(submitInput(claimed, [1])).catch((error) => { thrown = error })

        expect((thrown as IllustrationLedgerTerminalCloseError).code).toBe('turn_terminal_corrupt')
        expect(toIllustrationV3RpcError(thrown).message).toBe(
            '[IJ:turn_terminal_corrupt] The illustration turn was closed as corrupt before plan submission.',
        )
        const turn = await illustrationJobStore.getTurn(claimed.turnId)
        expect(turn?.state).toBe('corrupt')
        expect(turn?.error?.code).toBe('duplicate_marker')
    })

    // §3.11: a completed stale close emits exactly one turn_changed wake — the
    // normal-submit wake in submitPlanLedger is never reached because the close throws.
    test('emits exactly one turn_changed wake for a completed stale terminal close', async () => {
        const { claimed } = await registerAndClaim('Wake once.')
        messageRecord().data = 'Wake once.'

        const { error, hints } = await collectWake(() => submitPlanLedger(submitInput(claimed, [1])))

        expect((error as IllustrationLedgerTerminalCloseError).code).toBe('turn_terminal_stale')
        expect(hints.filter((hint) => hint.turnId === claimed.turnId && hint.kind === 'turn_changed'))
            .toHaveLength(1)
    })

    // §4 job-close: a source change discovered AFTER records exist closes the turn and
    // its eligible jobs to stale, returns turn_terminal_stale, and wakes exactly once.
    test('terminal-closes eligible jobs with the turn on a post-records source change', async () => {
        const { claimed } = await registerAndClaim('Race then close')
        const message = messageRecord()
        let edited = false
        harness.storageHook = (key) => {
            if (!edited && key.startsWith('illustration:v1:job:')) {
                edited = true
                message.data = message.data.replace('Race then close', 'User edit')
            }
        }

        const { error, hints } = await collectWake(() => submitPlanLedger(submitInput(claimed, [4])))
        harness.storageHook = null

        expect((error as IllustrationLedgerTerminalCloseError).code).toBe('turn_terminal_stale')
        expect((await illustrationJobStore.getTurn(claimed.turnId))?.state).toBe('stale')
        const jobs = await illustrationJobStore.listJobs({ turnId: claimed.turnId })
        expect(jobs.length).toBeGreaterThan(0)
        expect(jobs.every((job) => job.state === 'stale')).toBe(true)
        expect(hints.filter((hint) => hint.turnId === claimed.turnId && hint.kind === 'turn_changed'))
            .toHaveLength(1)
    })

    // §3.7 / §3.8: a terminal-closed turn is excluded from listPendingTurns and an
    // idempotent replay of the same plan neither reopens the turn nor creates new work.
    test('excludes a terminal-closed turn from the pending snapshot and never reopens on replay', async () => {
        const { claimed } = await registerAndClaim('Excluded turn.')
        messageRecord().data = 'Excluded turn.'
        const input = submitInput(claimed, [1])

        await expect(submitPlanLedger(input)).rejects.toBeInstanceOf(IllustrationLedgerTerminalCloseError)
        expect(await illustrationJobStore.listPendingTurns()).toHaveLength(0)

        harness.strictSave.mockClear()
        await expect(submitPlanLedger(input)).rejects.toBeDefined()
        expect(await illustrationJobStore.listJobs({ turnId: claimed.turnId })).toHaveLength(0)
        expect((await illustrationJobStore.getTurn(claimed.turnId))?.state).toBe('stale')
        expect(harness.strictSave).not.toHaveBeenCalled()
    })

    // §3.10 / §3.11: a storage failure BEFORE the durable close completes propagates the
    // original error (never a terminal-complete code) and emits NO wake.
    test('propagates the original error and emits no wake when the close write fails', async () => {
        const { claimed } = await registerAndClaim('Close write fails.')
        messageRecord().data = 'Close write fails.'
        const turnKey = illustrationTurnKey(claimed.turnId)
        harness.storageHook = (key) => {
            if (key === turnKey) throw new Error('forced close write failure')
        }

        const { error, hints } = await collectWake(() => submitPlanLedger(submitInput(claimed, [1])))
        harness.storageHook = null

        expect(error).toBeInstanceOf(Error)
        expect(error).not.toBeInstanceOf(IllustrationLedgerTerminalCloseError)
        expect((error as Error).message).toContain('forced close write failure')
        expect(toIllustrationV3RpcError(error).code).not.toContain('turn_terminal')
        expect(hints).toHaveLength(0)
        expect((await illustrationJobStore.getTurn(claimed.turnId))?.state).toBe('awaiting_plan')
        expect(await illustrationJobStore.listPendingTurns()).toHaveLength(1)
    })

    async function withConsoleCapture<T>(
        run: () => Promise<T>,
    ): Promise<{ result: T; logs: unknown[] }> {
        const logs: unknown[] = []
        const log = vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(...args) })
        const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => { logs.push(...args) })
        const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => { logs.push(...args) })
        try {
            const result = await run()
            return { result, logs }
        } finally {
            log.mockRestore()
            warn.mockRestore()
            errorSpy.mockRestore()
        }
    }

    // §4 secret sentinel (a): a sentinel planted in the durable source and a stray
    // marker nonce never appears in the sanitized error that crosses the sandbox, nor
    // in any log argument the completed terminal close makes.
    test('never leaks a secret sentinel through a completed stale terminal close', async () => {
        const source = `A ${SENTINEL} scene.`
        const { claimed } = await registerAndClaim(source)
        // A stray marker carrying the sentinel as its nonce (a different nonce than the
        // turn's) resolves as marker_missing -> stale close.
        messageRecord().data = `${source}<!--risu-illustration-request:v1:${SENTINEL}-->`

        const { result: thrown, logs } = await withConsoleCapture(async () => {
            let error: unknown
            await submitPlanLedger(submitInput(claimed, [1])).catch((e) => { error = e })
            return error
        })

        expect((thrown as IllustrationLedgerTerminalCloseError).code).toBe('turn_terminal_stale')
        const rpc = toIllustrationV3RpcError(thrown)
        expect((thrown as Error).message).not.toContain(SENTINEL)
        expect(rpc.message).not.toContain(SENTINEL)
        expect(JSON.stringify(rpc.payload ?? null)).not.toContain(SENTINEL)
        expect(logs.map((value) => JSON.stringify(value)).join('|')).not.toContain(SENTINEL)
    })

    // §4 secret sentinel (b): a forced internal exception carrying the sentinel is
    // sanitized at the v3 bridge boundary to a non-terminal code without echoing the
    // message or touching any log argument.
    test('sanitizes a forced internal exception carrying the sentinel', async () => {
        const source = `B ${SENTINEL} scene.`
        const { claimed } = await registerAndClaim(source)
        messageRecord().data = source // strip the marker -> marker_missing stale path
        const turnKey = illustrationTurnKey(claimed.turnId)
        harness.storageHook = (key) => {
            if (key === turnKey) throw new Error(`forced internal failure ${SENTINEL}`)
        }

        const { result: thrown, logs } = await withConsoleCapture(async () => {
            let error: unknown
            await submitPlanLedger(submitInput(claimed, [1])).catch((e) => { error = e })
            return error
        })
        harness.storageHook = null

        expect(thrown).not.toBeInstanceOf(IllustrationLedgerTerminalCloseError)
        const rpc = toIllustrationV3RpcError(thrown)
        expect(rpc.code).not.toContain('turn_terminal')
        expect(rpc.message).not.toContain(SENTINEL)
        expect(logs.map((value) => JSON.stringify(value)).join('|')).not.toContain(SENTINEL)
    })
})

afterEach(() => {
    restoreImagePromptMeasurement()
    resetIllustrationLockManagerAccessorForTests()
    resetIllustrationOperationLockManagerAccessorForTests()
    vi.useRealTimers()
})

describe('registerTrustedTurn', () => {
    // §20 Crash/storage/cancel + §6.2: ledger first, marker, strict ACK, awaiting_plan.
    test('persists the prepared ledger before marker mutation and advances only after strict ACK', async () => {
        const hints: Array<{ kind: string; turnId: string }> = []
        const unsubscribe = subscribeIllustrationWakeHints((hint) => hints.push(hint))
        const turn = await registerTrustedTurn(registerInput())
        await Promise.resolve()
        unsubscribe()

        expect(harness.storageEvents[0]).toBe(`storage:${illustrationTurnKey(turn.turnId)}`)
        expect(mutationEvents).toEqual(['marker', 'strict'])
        expect(harness.strictSave).toHaveBeenCalledTimes(1)
        expect(turn).toMatchObject({ state: 'awaiting_plan', sourceTextUtf16: 'A quiet scene.' })
        // §5-1: the request marker begins on its own line (a single injected LF),
        // never fused to the body's last code unit.
        expect(harness.database.characters[0].chats[0].message[0].data)
            .toMatch(/^A quiet scene\.\n<!--risu-illustration-request:v1:[A-Za-z0-9_-]+-->$/)
        expect(hints).toContainEqual(expect.objectContaining({
            kind: 'turn_changed',
            turnId: turn.turnId,
        }))
    })

    // §5-1 / followup §2: a body ending in a closing ``` fence gets the marker on
    // its own line, so markdown-it closes the fence instead of swallowing it.
    test('frames the request marker on its own line after a closing code fence', async () => {
        const source = '```html\n<b>x</b>\n```'
        installDatabase(source)
        const turn = await registerTrustedTurn(registerInput(source))

        expect(turn.sourceTextUtf16).toBe(source)
        const data = harness.database.characters[0].chats[0].message[0].data as string
        expect(data.startsWith(`${source}\n`)).toBe(true)
        expect(data).toMatch(/```\n<!--risu-illustration-request:v1:[A-Za-z0-9_-]+-->$/)
    })

    test('leaves blocked_capture after strict failure without retrying the marker', async () => {
        harness.strictFailure = new Error('durable write rejected')

        await expect(registerTrustedTurn(registerInput())).rejects.toThrow('durable write rejected')

        const [turn] = await illustrationJobStore.listTurns()
        expect(turn.state).toBe('blocked_capture')
        expect(harness.strictSave).toHaveBeenCalledTimes(1)
        expect(mutationEvents).toEqual(['marker', 'strict'])
        expect((harness.database.characters[0].chats[0].message[0].data.match(/risu-illustration-request/g) ?? []))
            .toHaveLength(1)

        harness.strictFailure = null
        harness.strictSave.mockClear()
        const replay = await registerTrustedTurn(registerInput())

        expect(replay.state).toBe('blocked_capture')
        expect(harness.strictSave).not.toHaveBeenCalled()
        expect((harness.database.characters[0].chats[0].message[0].data.match(/risu-illustration-request/g) ?? []))
            .toHaveLength(1)
    })

    test('blocks capture without mutating any swipe when the active variant changes during ledger creation', async () => {
        const message = {
            role: 'char',
            chatId: 'message-1',
            data: 'Swipe A',
            swipes: ['Swipe A', 'Swipe B', 'Swipe C'],
            swipeId: 0,
        } as Message
        harness.database.characters[0].chats[0].message = [message]
        const originalSwipes = [...message.swipes!]
        let changed = false
        harness.storageHook = (key) => {
            if (!changed && key.startsWith('illustration:v1:turn:')) {
                changed = true
                message.swipeId = 1
                message.data = message.swipes![1]
            }
        }

        await expect(registerTrustedTurn(registerInput('Swipe A')))
            .rejects.toThrow('changed before capture')

        const [turn] = await illustrationJobStore.listTurns()
        expect(turn).toMatchObject({
            state: 'blocked_capture',
            error: { code: 'capture_variant_raced' },
        })
        expect(message.data).toBe('Swipe B')
        expect(message.swipes).toEqual(originalSwipes)
        expect([message.data, ...message.swipes!].join('\n')).not.toContain('risu-illustration-request')
        expect(harness.strictSave).not.toHaveBeenCalled()
    })

    test('uses requestKey idempotency under concurrent registration', async () => {
        const [first, second] = await Promise.all([
            registerTrustedTurn(registerInput()),
            registerTrustedTurn(registerInput()),
        ])

        expect(second).toEqual(first)
        expect(await illustrationJobStore.listTurns()).toHaveLength(1)
        expect(harness.strictSave).toHaveBeenCalledTimes(1)
        expect((harness.database.characters[0].chats[0].message[0].data.match(/risu-illustration-request/g) ?? []))
            .toHaveLength(1)
    })

    test('returns the existing turn on a sequential registration replay', async () => {
        const first = await registerTrustedTurn(registerInput())
        harness.strictSave.mockClear()

        const replay = await registerTrustedTurn(registerInput())

        expect(replay).toEqual(first)
        expect(harness.strictSave).not.toHaveBeenCalled()
        expect((harness.database.characters[0].chats[0].message[0].data.match(/risu-illustration-request/g) ?? []))
            .toHaveLength(1)
    })

    // §20 feature flag OFF means capture is refused before any ledger/chat write.
    test('refuses registration while the feature is off', async () => {
        await setIllustrationFeatureEnabled(false)
        harness.storageEvents.length = 0

        await expect(registerTrustedTurn(registerInput()))
            .rejects.toBeInstanceOf(IllustrationFeatureDisabledError)
        expect(harness.storageEvents).toHaveLength(0)
        expect(harness.strictSave).not.toHaveBeenCalled()
        expect(mutationEvents).toHaveLength(0)
    })

    // Acceptance 6: with the mode-enforcing flag, the admission-time policy recheck
    // decides. Manual (or unset default) suppresses; automatic admits.
    test('admits an enforced automatic capture only under an automatic policy', async () => {
        await writeDurableCaptureMode('automatic')
        const turn = await registerTrustedTurn({
            ...registerInput(),
            origin: 'automatic',
            enforceCaptureMode: true,
        })
        expect(turn).not.toBeNull()
        expect(turn!.state).toBe('awaiting_plan')
        expect(turn!.origin).toBe('automatic')
        expect(await illustrationJobStore.listTurns()).toHaveLength(1)
    })

    test('suppresses an enforced automatic capture under manual mode with zero residue', async () => {
        await writeDurableCaptureMode('manual')
        harness.storageEvents.length = 0
        mutationEvents.length = 0

        const result = await registerTrustedTurn({
            ...registerInput(),
            origin: 'automatic',
            enforceCaptureMode: true,
        })

        expect(result).toBeNull()
        expect(await illustrationJobStore.listTurns()).toHaveLength(0)
        expect(harness.strictSave).not.toHaveBeenCalled()
        // No turn record and no marker mutation were written.
        expect(harness.storageEvents).toHaveLength(0)
        expect(mutationEvents).toHaveLength(0)
        expect(harness.database.characters[0].chats[0].message[0].data).toBe('A quiet scene.')
    })

    test('the unset default policy (manual) suppresses an enforced automatic capture', async () => {
        const result = await registerTrustedTurn({
            ...registerInput(),
            origin: 'automatic',
            enforceCaptureMode: true,
        })
        expect(result).toBeNull()
        expect(await illustrationJobStore.listTurns()).toHaveLength(0)
    })

    test('a non-enforcing caller captures regardless of the manual policy', async () => {
        await writeDurableCaptureMode('manual')
        const turn = await registerTrustedTurn(registerInput())
        expect(turn).not.toBeNull()
        expect(turn!.state).toBe('awaiting_plan')
        // The default origin is 'automatic' for callers that do not specify one.
        expect(turn!.origin).toBe('automatic')
    })

    test('an already-admitted turn is returned even after the mode switches to manual', async () => {
        await writeDurableCaptureMode('automatic')
        const first = await registerTrustedTurn({
            ...registerInput(),
            origin: 'automatic',
            enforceCaptureMode: true,
        })
        expect(first).not.toBeNull()
        await writeDurableCaptureMode('manual')
        const replay = await registerTrustedTurn({
            ...registerInput(),
            origin: 'automatic',
            enforceCaptureMode: true,
        })
        expect(replay).toEqual(first)
        expect(await illustrationJobStore.listTurns()).toHaveLength(1)
    })
})

describe('requestCurrentVariant (manual capture)', () => {
    function currentVariantInput(overrides: Record<string, unknown> = {}) {
        return {
            protocolVersion: 1 as const,
            characterIndex: 0,
            chatIndex: 0,
            messageIndex: 0,
            expectedMessageId: 'message-1' as string | undefined,
            expectedSwipeIndex: null as number | null,
            expectedSourceTextUtf16: 'A quiet scene.',
            ...overrides,
        }
    }

    // Acceptance 2: the selected variant is captured as exactly one manual turn.
    test('captures the selected active variant as a single manual-origin turn', async () => {
        const snapshot = await requestCurrentVariant(currentVariantInput())
        expect(snapshot.state).toBe('awaiting_plan')
        expect(snapshot.origin).toBe('manual')
        expect(await illustrationJobStore.listTurns()).toHaveLength(1)
        expect(harness.database.characters[0].chats[0].message[0].data)
            .toMatch(/^A quiet scene\.\n<!--risu-illustration-request:v1:[A-Za-z0-9_-]+-->$/)
    })

    // Acceptance 2 (swipe selection): capturing a chosen past swipe writes exactly
    // one turn carrying that swipe's text, mutating only the selected swipe.
    test('captures a selected past swipe among many with exactly one turn', async () => {
        const message = {
            role: 'char',
            chatId: 'message-1',
            data: 'Swipe B',
            swipes: ['Swipe A', 'Swipe B', 'Swipe C'],
            swipeId: 1,
        } as Message
        harness.database.characters[0].chats[0].message = [message]

        const snapshot = await requestCurrentVariant(currentVariantInput({
            expectedSwipeIndex: 1,
            expectedSourceTextUtf16: 'Swipe B',
        }))

        expect(snapshot.origin).toBe('manual')
        expect(await illustrationJobStore.listTurns()).toHaveLength(1)
        expect(message.swipes![1]).toMatch(/^Swipe B\n<!--risu-illustration-request:v1:[A-Za-z0-9_-]+-->$/)
        expect(message.swipes![0]).toBe('Swipe A')
        expect(message.swipes![2]).toBe('Swipe C')
    })

    // Acceptance 3: any selection mismatch fails validation and leaves zero residue.
    test.each([
        ['source text', { expectedSourceTextUtf16: 'a different body' }],
        ['message identity', { expectedMessageId: 'other-message' }],
        ['active swipe', { expectedSwipeIndex: 4 }],
        ['message index', { messageIndex: 9 }],
    ])('fails with %s mismatch and no residue', async (_label, overrides) => {
        harness.storageEvents.length = 0
        mutationEvents.length = 0
        await expect(requestCurrentVariant(currentVariantInput(overrides)))
            .rejects.toThrow(/selection changed/)
        expect(await illustrationJobStore.listTurns()).toHaveLength(0)
        expect(harness.strictSave).not.toHaveBeenCalled()
        expect(mutationEvents).toHaveLength(0)
        expect(harness.database.characters[0].chats[0].message[0].data).toBe('A quiet scene.')
    })

    // Acceptance 4: double click / reload re-request of the same selected variant
    // resolves to the same single turn (content-addressed manual identity that
    // survives the injected marker).
    test('double click and reload of the same variant return the same single turn', async () => {
        const first = await requestCurrentVariant(currentVariantInput())
        harness.strictSave.mockClear()

        // A reload re-request: the Plugin re-reads the now-marked live text.
        const markedText = harness.database.characters[0].chats[0].message[0].data
        const second = await requestCurrentVariant(currentVariantInput({
            expectedSourceTextUtf16: markedText,
        }))

        expect(second.turnId).toBe(first.turnId)
        expect(await illustrationJobStore.listTurns()).toHaveLength(1)
        expect(harness.strictSave).not.toHaveBeenCalled()
    })

    // §3.1: greeting-style variants whose conversation/message ids do not yet exist
    // are minted safely by Core on a confirmed match.
    test('mints identity for a greeting-style variant lacking a conversation and message id', async () => {
        const chat = harness.database.characters[0].chats[0]
        delete chat.id
        delete chat.message[0].chatId

        const snapshot = await requestCurrentVariant(currentVariantInput({ expectedMessageId: undefined }))

        expect(snapshot.state).toBe('awaiting_plan')
        expect(snapshot.origin).toBe('manual')
        expect(typeof chat.id).toBe('string')
        expect(typeof chat.message[0].chatId).toBe('string')
    })
})

describe('purgeAutomaticBacklog', () => {
    async function makePendingTurn(turnId: string, origin: 'manual' | 'automatic'): Promise<void> {
        await illustrationJobStore.createTurn({
            turnId,
            idempotencyKey: `capture:${turnId}`,
            origin,
            target: {
                chaId: 'character-1',
                conversationId: 'conversation-1',
                expectedMessageId: 'message-1',
                rootTurnId: turnId,
                requestNonce: `nonce-${turnId}`,
            },
            sourceTextUtf16: 'x',
            sourceRevisionHash: `hash-${turnId}`,
            settingsFingerprint: 'fp',
        })
        const turn = await illustrationJobStore.getTurn(turnId)
        await illustrationJobStore.updateTurn({
            turnId,
            expectedVersion: turn!.version,
            mutate: (draft) => { draft.state = 'awaiting_plan' },
        })
    }

    // Acceptance 7 / §3.2: a bounded purge cancels only automatic-origin pending
    // turns and never touches manual-origin turns.
    test('cancels only automatic-origin pending turns up to the bound', async () => {
        for (let index = 0; index < 3; index += 1) await makePendingTurn(`auto-${index}`, 'automatic')
        await makePendingTurn('manual-0', 'manual')

        const result = await purgeAutomaticBacklog({ protocolVersion: 1, confirm: true, maxTurns: 2 })
        expect(result).toEqual({ protocolVersion: 1, scanned: 3, purged: 2, remaining: true })

        const pending = await illustrationJobStore.listPendingTurns()
        expect(pending.filter((turn) => turn.origin === 'manual')).toHaveLength(1)
        expect(pending.filter((turn) => turn.origin === 'automatic')).toHaveLength(1)
    })

    test('drains the whole automatic backlog when the bound is generous', async () => {
        for (let index = 0; index < 3; index += 1) await makePendingTurn(`auto-${index}`, 'automatic')
        await makePendingTurn('manual-0', 'manual')

        const result = await purgeAutomaticBacklog({ protocolVersion: 1, confirm: true, maxTurns: 50 })
        expect(result).toEqual({ protocolVersion: 1, scanned: 3, purged: 3, remaining: false })

        const pending = await illustrationJobStore.listPendingTurns()
        expect(pending.map((turn) => turn.origin)).toEqual(['manual'])
    })

    test('requires confirmation and a positive bound', async () => {
        await makePendingTurn('auto-0', 'automatic')
        await expect(purgeAutomaticBacklog({ protocolVersion: 1, confirm: false as never, maxTurns: 5 }))
            .rejects.toThrow(/confirm/)
        await expect(purgeAutomaticBacklog({ protocolVersion: 1, confirm: true, maxTurns: 0 }))
            .rejects.toThrow(/maxTurns/)
        // Nothing was cancelled.
        expect(await illustrationJobStore.listPendingTurns()).toHaveLength(1)
    })
})
