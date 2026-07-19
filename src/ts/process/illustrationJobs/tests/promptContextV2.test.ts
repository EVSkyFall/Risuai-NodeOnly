import { describe, expect, test, vi } from 'vitest'
import {
    IllustrationLedgerValidationError,
    IllustrationPromptTargetUnavailableError,
} from '../errors'
import {
    NOVELAI_NATIVE_MEASUREMENT_REVISION,
    NOVELAI_NATIVE_QUEUE_POLICY_REVISION,
    resolveNovelAiNativeTarget,
    resolvePromptTargetV2,
    targetFingerprintMatchesCurrentDb,
    validateOpaquePromptRef,
    validateTagProfileRef,
    type PromptTargetDatabase,
} from '../promptContextV2'

// promptContextV2 pulls imagePromptMeasurement, which imports the DB module at
// load; the pure target logic never reads it, so a bare stub is enough.
vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => ({}) }))

function db(overrides: Partial<Record<string, unknown>> = {}): PromptTargetDatabase {
    return {
        sdProvider: 'novelai',
        NAIImgUrl: 'https://image.novelai.net/ai/generate-image',
        NAIImgModel: 'nai-diffusion-4-5-full',
        ...overrides,
    } as PromptTargetDatabase
}

describe('novelai-native target resolution (request §7.1)', () => {
    test('reproduces the live NAI V4 adapter descriptor byte-for-byte', async () => {
        const target = await resolveNovelAiNativeTarget(db())
        expect(target).toMatchObject({
            schemaVersion: 2,
            providerId: 'novelai',
            transportId: 'novelai-native',
            modelId: 'nai-diffusion-4-5-full',
            checkpointFingerprint: null,
            workflowFingerprint: null,
            bindingRevision: null,
            bindingMode: 'request-pinned',
            acceptedLayouts: ['flat', 'native-character-slots'],
            negativeChannel: 'separate',
            textPreservation: 'exact',
            subjectSlots: {
                maxSubjects: 6,
                positive: 'exact-scene-subjects',
                negative: 'match-positive',
                allowEmptyPositive: false,
                allowEmptyNegative: true,
                pipeSerialization: null,
            },
            measurement: {
                mode: 'model_exact',
                revision: NOVELAI_NATIVE_MEASUREMENT_REVISION,
                tokenizerId: 't5-spiece-v1',
                documentedTransportLimit: null,
                dispatchPolicy: 'require-model-within-limit',
            },
            queue: {
                concurrencyKey: 'novelai',
                policyRevision: NOVELAI_NATIVE_QUEUE_POLICY_REVISION,
                maxConcurrency: 1,
                priorityPolicy: 'interactive-first',
            },
        })
        expect(target.targetFingerprint).toMatch(/^[0-9a-f]{64}$/)
    })

    test('resolvePromptTargetV2 dispatches the novelai provider to novelai-native', async () => {
        const target = await resolvePromptTargetV2(db())
        expect(target.transportId).toBe('novelai-native')
    })
})

describe('novelai-native gates on an actually-measurable V4 model (request §6/§8)', () => {
    // The adapter pins model_exact/T5 measurement unconditionally, but exact T5
    // measurement only exists for NAI V4 models. A non-V4 NovelAI model must fail
    // closed at resolve/prepare rather than persist a descriptor claiming exact
    // measurability the model cannot honor (which would only surface post-LLM at
    // the measurement receipt).
    test.each([
        'nai-diffusion-3',
        'nai-diffusion-2',
        'nai-diffusion-furry-3',
        'safe-diffusion',
    ])('a non-V4 NovelAI model %s yields a typed target-unavailable failure', async (model) => {
        await expect(resolvePromptTargetV2(db({ NAIImgModel: model }))).rejects.toMatchObject({
            code: 'prompt_target_unavailable',
            transportId: 'novelai-native',
        })
    })

    test('every V4-family model still resolves to a model_exact novelai-native target', async () => {
        for (const model of [
            'nai-diffusion-4-full',
            'nai-diffusion-4-curated-preview',
            'nai-diffusion-4-5-full',
            'nai-diffusion-4-5-curated',
        ]) {
            const target = await resolvePromptTargetV2(db({ NAIImgModel: model }))
            expect(target.transportId).toBe('novelai-native')
            expect(target.measurement.mode).toBe('model_exact')
            expect(target.modelId).toBe(model)
        }
    })

    test('an unset model defaults to the V4.5 checkpoint and stays measurable', async () => {
        const target = await resolvePromptTargetV2(db({ NAIImgModel: undefined }))
        expect(target.transportId).toBe('novelai-native')
        expect(target.modelId).toBe('nai-diffusion-4-5-full')
    })
})

describe('target fingerprint identity (request §4/§10-6/§10-20)', () => {
    test('changes when the model or endpoint identity changes', async () => {
        const base = (await resolveNovelAiNativeTarget(db())).targetFingerprint
        const modelChanged = (await resolveNovelAiNativeTarget(
            db({ NAIImgModel: 'nai-diffusion-4-full' }),
        )).targetFingerprint
        const endpointChanged = (await resolveNovelAiNativeTarget(
            db({ NAIImgUrl: 'https://proxy.example.test/nai' }),
        )).targetFingerprint
        expect(modelChanged).not.toBe(base)
        expect(endpointChanged).not.toBe(base)
    })

    test('is stable across operational settings that are not target identity', async () => {
        // Generation/config/queue-style operational settings are NOT part of the
        // prompt-target fingerprint (request §4 excludes queue tuning; §10-20). The
        // resolver only reads provider/endpoint/model identity, so unrelated DB
        // fields cannot shift the fingerprint.
        const base = (await resolveNovelAiNativeTarget(db())).targetFingerprint
        const withOperationalNoise = (await resolveNovelAiNativeTarget(
            db({ NAIImgConfig: { width: 832, steps: 40 }, NAII2I: true } as never),
        )).targetFingerprint
        expect(withOperationalNoise).toBe(base)
    })
})

describe('post-capture drift detection (request §10-6)', () => {
    test('matches an unchanged provider target and rejects endpoint/model/provider drift', async () => {
        const captured = (await resolveNovelAiNativeTarget(db())).targetFingerprint
        expect(await targetFingerprintMatchesCurrentDb(db(), captured)).toBe(true)
        expect(await targetFingerprintMatchesCurrentDb(
            db({ NAIImgModel: 'nai-diffusion-4-full' }),
            captured,
        )).toBe(false)
        expect(await targetFingerprintMatchesCurrentDb(
            db({ NAIImgUrl: 'https://proxy.example.test/nai' }),
            captured,
        )).toBe(false)
        // A provider switch no longer resolves any target: a definite mismatch,
        // never a silent pass.
        expect(await targetFingerprintMatchesCurrentDb(
            db({ sdProvider: 'webui' }),
            captured,
        )).toBe(false)
        // A post-capture switch to a non-V4 NovelAI model likewise resolves no
        // valid novelai-native target: a definite mismatch, never a silent pass.
        expect(await targetFingerprintMatchesCurrentDb(
            db({ NAIImgModel: 'nai-diffusion-3' }),
            captured,
        )).toBe(false)
    })
})

describe('unresolved transports fail closed (Slice D scope)', () => {
    const cases: Array<[string, string]> = [
        ['webui', 'webui-flat'],
        ['comfy', 'comfyui-flat'],
        ['comfyui', 'comfyui-flat'],
    ]
    test.each(cases)('provider %s yields a typed target-unavailable failure', async (provider, transportId) => {
        await expect(resolvePromptTargetV2(db({ sdProvider: provider }))).rejects.toMatchObject({
            code: 'prompt_target_unavailable',
            transportId,
        })
    })

    test('an unmapped or unset provider is also unavailable, never inferred', async () => {
        await expect(resolvePromptTargetV2(db({ sdProvider: 'dalle' })))
            .rejects.toBeInstanceOf(IllustrationPromptTargetUnavailableError)
        await expect(resolvePromptTargetV2(db({ sdProvider: '' })))
            .rejects.toMatchObject({ code: 'prompt_target_unavailable', transportId: 'unset-provider' })
    })
})

describe('opaque Plugin-owned ref validation (request §3/§4)', () => {
    test('accepts bounded non-empty strings and rejects everything else', () => {
        expect(validateOpaquePromptRef('sdxl-illustrious', 'ref')).toBe('sdxl-illustrious')
        // Opaque means Core never trims or normalizes: a weird-but-nonempty value survives.
        expect(validateOpaquePromptRef('  spaced  ', 'ref')).toBe('  spaced  ')
        expect(() => validateOpaquePromptRef('', 'ref'))
            .toThrowError(IllustrationLedgerValidationError)
        expect(() => validateOpaquePromptRef('x'.repeat(1025), 'ref'))
            .toThrowError(IllustrationLedgerValidationError)
        expect(() => validateOpaquePromptRef(42, 'ref'))
            .toThrowError(IllustrationLedgerValidationError)
    })

    test('validateTagProfileRef requires exactly { id, revision } opaque strings', () => {
        expect(validateTagProfileRef({ id: 'nai-v4', revision: '1' }))
            .toEqual({ id: 'nai-v4', revision: '1' })
        expect(() => validateTagProfileRef({ id: 'nai-v4' }))
            .toThrowError(IllustrationLedgerValidationError)
        expect(() => validateTagProfileRef({ id: 'nai-v4', revision: '1', extra: true }))
            .toThrowError(IllustrationLedgerValidationError)
        expect(() => validateTagProfileRef({ id: '', revision: '1' }))
            .toThrowError(IllustrationLedgerValidationError)
    })
})
