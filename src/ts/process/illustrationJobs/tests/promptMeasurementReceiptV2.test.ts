import { describe, expect, test, vi } from 'vitest'
import {
    assertReceiptDispatchEligibleForTarget,
    computeDispatchEligibility,
    measurePromptEnvelopeReceiptV2,
} from '../promptMeasurementReceiptV2'
import {
    computeEnvelopeHash,
    parseIllustrationPromptEnvelopeV2,
    type IllustrationPromptEnvelopeV2,
} from '../promptEnvelopeV2'
import {
    resolveNovelAiNativeTarget,
    type IllustrationPromptTargetV2,
} from '../promptContextV2'
import { computeNaiSettingsFingerprint } from '../settingsFingerprint'
import { installImagePromptMeasurementTestService } from './imagePromptTestHarness'

vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => ({}) }))

function naiDb(model = 'nai-diffusion-4-5-full') {
    return {
        sdProvider: 'novelai',
        NAIImgUrl: 'https://image.novelai.net/ai/generate-image',
        NAIImgModel: model,
        NAII2I: false,
        NAIImgConfig: {},
    } as never
}

function flatEnvelope(
    overrides: Partial<IllustrationPromptEnvelopeV2> = {},
): IllustrationPromptEnvelopeV2 {
    return parseIllustrationPromptEnvelopeV2({
        schemaVersion: 2,
        tagProfileId: 'nai-v4',
        tagProfileRevision: '1',
        profileConfigRevision: 'cfg-1',
        assetCatalogDigest: 'cat-1',
        layout: 'flat',
        basePositive: 'masterpiece',
        subjectPositives: [],
        baseNegative: '',
        subjectNegatives: [],
        ...overrides,
    })
}

describe('dispatch eligibility table (request §6/§10-11/§10-12)', () => {
    test('model_exact is eligible only within limit; over-limit is always ineligible', () => {
        expect(computeDispatchEligibility({
            mode: 'model_exact',
            modelVerdict: 'within_limit',
            transportVerdict: 'unknown',
            dispatchPolicy: 'require-model-within-limit',
        })).toEqual({ dispatchEligible: true, eligibilityBasis: 'model-exact' })
        expect(computeDispatchEligibility({
            mode: 'model_exact',
            modelVerdict: 'over_limit',
            transportVerdict: 'unknown',
            dispatchPolicy: 'require-model-within-limit',
        })).toEqual({ dispatchEligible: false, eligibilityBasis: 'over-limit' })
    })

    test('provider_reported needs an authoritative within-limit AND the allow policy', () => {
        expect(computeDispatchEligibility({
            mode: 'provider_reported',
            modelVerdict: 'within_limit',
            transportVerdict: 'unknown',
            dispatchPolicy: 'allow-provider-authoritative',
        })).toEqual({ dispatchEligible: true, eligibilityBasis: 'provider-authoritative' })
        expect(computeDispatchEligibility({
            mode: 'provider_reported',
            modelVerdict: 'within_limit',
            transportVerdict: 'unknown',
            dispatchPolicy: 'require-model-within-limit',
        })).toEqual({ dispatchEligible: false, eligibilityBasis: 'policy-rejected' })
        expect(computeDispatchEligibility({
            mode: 'provider_reported',
            modelVerdict: 'over_limit',
            transportVerdict: 'unknown',
            dispatchPolicy: 'allow-provider-authoritative',
        })).toEqual({ dispatchEligible: false, eligibilityBasis: 'over-limit' })
    })

    test('transport_only cannot masquerade as model within_limit', () => {
        // Passing transport verdict + explicit policy -> eligible but NEVER model-exact.
        expect(computeDispatchEligibility({
            mode: 'transport_only',
            modelVerdict: 'unknown',
            transportVerdict: 'within_limit',
            dispatchPolicy: 'allow-transport-only',
        })).toEqual({ dispatchEligible: true, eligibilityBasis: 'transport-only-explicit' })
        // No explicit opt-in -> policy-rejected.
        expect(computeDispatchEligibility({
            mode: 'transport_only',
            modelVerdict: 'unknown',
            transportVerdict: 'within_limit',
            dispatchPolicy: 'require-model-within-limit',
        })).toEqual({ dispatchEligible: false, eligibilityBasis: 'policy-rejected' })
        // Over the documented transport limit -> ineligible.
        expect(computeDispatchEligibility({
            mode: 'transport_only',
            modelVerdict: 'unknown',
            transportVerdict: 'over_limit',
            dispatchPolicy: 'allow-transport-only',
        })).toEqual({ dispatchEligible: false, eligibilityBasis: 'over-limit' })
    })

    test('unmeasured is eligible only with an explicit allow-unmeasured policy', () => {
        expect(computeDispatchEligibility({
            mode: 'unmeasured',
            modelVerdict: 'unknown',
            transportVerdict: 'unknown',
            dispatchPolicy: 'allow-unmeasured',
        })).toEqual({ dispatchEligible: true, eligibilityBasis: 'unmeasured-explicit' })
        expect(computeDispatchEligibility({
            mode: 'unmeasured',
            modelVerdict: 'unknown',
            transportVerdict: 'unknown',
            dispatchPolicy: 'require-model-within-limit',
        })).toEqual({ dispatchEligible: false, eligibilityBasis: 'policy-rejected' })
    })
})

describe('novelai-native model_exact receipt (request §6)', () => {
    test('produces an eligible within-limit receipt bound to fingerprint + envelope hash', async () => {
        const db = naiDb()
        const restore = installImagePromptMeasurementTestService(() => db)
        try {
            const target = await resolveNovelAiNativeTarget(db)
            const envelope = flatEnvelope({ basePositive: 'x' })
            const receipt = await measurePromptEnvelopeReceiptV2({
                protocolVersion: 2,
                target,
                settingsFingerprint: await computeNaiSettingsFingerprint(db),
                envelope,
            })
            expect(receipt).toMatchObject({
                schemaVersion: 2,
                targetFingerprint: target.targetFingerprint,
                envelopeHash: await computeEnvelopeHash(envelope),
                measurementMode: 'model_exact',
                measurementRevision: target.measurement.revision,
                modelVerdict: 'within_limit',
                dispatchEligible: true,
                eligibilityBasis: 'model-exact',
            })
            expect(receipt.dimensions).toEqual([
                { scope: 'positive', unit: 'token', measured: 1, limit: 512, verdict: 'within_limit' },
                { scope: 'negative', unit: 'token', measured: 0, limit: 512, verdict: 'within_limit' },
            ])
        } finally {
            restore()
        }
    })

    test('over-limit is ineligible with an over-limit basis', async () => {
        const db = naiDb()
        const restore = installImagePromptMeasurementTestService(
            () => db,
            (text) => (text === 'huge' ? 513 : 0),
        )
        try {
            const target = await resolveNovelAiNativeTarget(db)
            const receipt = await measurePromptEnvelopeReceiptV2({
                protocolVersion: 2,
                target,
                settingsFingerprint: await computeNaiSettingsFingerprint(db),
                envelope: flatEnvelope({ basePositive: 'huge' }),
            })
            expect(receipt.modelVerdict).toBe('over_limit')
            expect(receipt.dispatchEligible).toBe(false)
            expect(receipt.eligibilityBasis).toBe('over-limit')
            expect(receipt.dimensions[0]).toMatchObject({ measured: 513, verdict: 'over_limit' })
        } finally {
            restore()
        }
    })

    test('non-model_exact measurement modes are not producible this slice', async () => {
        const db = naiDb()
        const restore = installImagePromptMeasurementTestService(() => db)
        try {
            const base = await resolveNovelAiNativeTarget(db)
            const transportOnlyTarget: IllustrationPromptTargetV2 = {
                ...base,
                measurement: { ...base.measurement, mode: 'transport_only' },
            }
            await expect(measurePromptEnvelopeReceiptV2({
                protocolVersion: 2,
                target: transportOnlyTarget,
                settingsFingerprint: await computeNaiSettingsFingerprint(db),
                envelope: flatEnvelope({ basePositive: 'x' }),
            })).rejects.toMatchObject({ code: 'prompt_measurement_mode_unsupported' })
        } finally {
            restore()
        }
    })
})

describe('receipt binding guard (request §6/§10-10)', () => {
    test('rejects cross-target, cross-envelope, revision drift, and ineligible receipts', async () => {
        const db = naiDb()
        const restore = installImagePromptMeasurementTestService(
            () => db,
            (text) => (text === 'huge' ? 513 : (text.length === 0 ? 0 : 1)),
        )
        try {
            const targetA = await resolveNovelAiNativeTarget(db)
            const targetB = await resolveNovelAiNativeTarget(naiDb('nai-diffusion-4-full'))
            const settingsFingerprint = await computeNaiSettingsFingerprint(db)

            const envelopeA = flatEnvelope({ basePositive: 'x' })
            const hashA = await computeEnvelopeHash(envelopeA)
            const receiptA = await measurePromptEnvelopeReceiptV2({
                protocolVersion: 2, target: targetA, settingsFingerprint, envelope: envelopeA,
            })

            // Correct binding + eligible: no throw.
            expect(() => assertReceiptDispatchEligibleForTarget(receiptA, targetA, hashA)).not.toThrow()
            // Cross-target reuse.
            expect(() => assertReceiptDispatchEligibleForTarget(receiptA, targetB, hashA))
                .toThrowError(expect.objectContaining({ code: 'prompt_receipt_binding_mismatch' }))
            // Cross-envelope reuse.
            expect(() => assertReceiptDispatchEligibleForTarget(receiptA, targetA, 'deadbeef'))
                .toThrowError(expect.objectContaining({ code: 'prompt_receipt_binding_mismatch' }))
            // Measurement-revision drift.
            const revisionDrift: IllustrationPromptTargetV2 = {
                ...targetA,
                measurement: { ...targetA.measurement, revision: 'novelai-native-t5-spiece-v1/999' },
            }
            expect(() => assertReceiptDispatchEligibleForTarget(receiptA, revisionDrift, hashA))
                .toThrowError(expect.objectContaining({ code: 'prompt_receipt_binding_mismatch' }))

            // A correctly-bound but ineligible (over-limit) receipt is refused.
            const envelopeOver = flatEnvelope({ basePositive: 'huge' })
            const hashOver = await computeEnvelopeHash(envelopeOver)
            const receiptOver = await measurePromptEnvelopeReceiptV2({
                protocolVersion: 2, target: targetA, settingsFingerprint, envelope: envelopeOver,
            })
            expect(() => assertReceiptDispatchEligibleForTarget(receiptOver, targetA, hashOver))
                .toThrowError(expect.objectContaining({ code: 'prompt_dispatch_ineligible' }))
        } finally {
            restore()
        }
    })
})
