import { describe, expect, test, vi } from 'vitest'
import { parseIllustrationPromptEnvelopeV2, type IllustrationPromptEnvelopeV2 } from '../promptEnvelopeV2'
import { measurePromptEnvelopeReceiptV2 } from '../promptMeasurementReceiptV2'
import {
    resolveWebuiFlatTarget,
    type IllustrationPromptTransportLimitUnit,
    type IllustrationWebuiFlatElection,
    type PromptTargetDatabase,
} from '../promptContextV2'

vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => ({}) }))

const WEBUI_DB = {
    sdProvider: 'webui',
    webUiUrl: 'http://127.0.0.1:7860/',
} as unknown as PromptTargetDatabase

// U+10437 '𐐷': 4 UTF-8 bytes, 2 UTF-16 code units, 1 Unicode scalar value.
const ASTRAL = '𐐷'

function flatEnvelope(overrides: Partial<IllustrationPromptEnvelopeV2> = {}): IllustrationPromptEnvelopeV2 {
    return parseIllustrationPromptEnvelopeV2({
        schemaVersion: 2,
        tagProfileId: 'sdxl-illustrious',
        tagProfileRevision: '1',
        profileConfigRevision: 'cfg-1',
        assetCatalogDigest: 'cat-1',
        layout: 'flat',
        basePositive: ASTRAL,
        subjectPositives: [],
        baseNegative: '',
        subjectNegatives: [],
        ...overrides,
    })
}

function webuiTransportOnlyElection(
    unit: IllustrationPromptTransportLimitUnit,
    positive: number | null,
): IllustrationWebuiFlatElection {
    return {
        transportId: 'webui-flat',
        binding: { mode: 'request-pinned', checkpoint: 'ckpt' },
        measurement: { mode: 'transport_only', unit, positive, negative: null, combined: null, allowTransportOnly: true },
        maxConcurrency: 1,
        priorityPolicy: 'fifo',
    }
}

describe('transport_only measurement distinguishes UTF-8 / UTF-16 / scalar units (request §6/§10-13)', () => {
    test('the SAME astral input measures 4 / 2 / 1 under the three units', async () => {
        const cases: Array<[IllustrationPromptTransportLimitUnit, number]> = [
            ['utf8_byte', 4],
            ['utf16_code_unit', 2],
            ['unicode_scalar_value', 1],
        ]
        for (const [unit, expected] of cases) {
            const target = await resolveWebuiFlatTarget(WEBUI_DB, webuiTransportOnlyElection(unit, null))
            const receipt = await measurePromptEnvelopeReceiptV2({
                protocolVersion: 2, target, settingsFingerprint: 'sf', envelope: flatEnvelope(),
            })
            const positive = receipt.dimensions.find((d) => d.scope === 'positive')!
            expect(positive.unit).toBe(unit)
            expect(positive.measured).toBe(expected)
            // transport_only NEVER promotes to a model within_limit verdict (§12).
            expect(receipt.modelVerdict).toBe('unknown')
        }
    })

    test('within the documented byte limit + allow-transport-only => dispatch eligible', async () => {
        const target = await resolveWebuiFlatTarget(WEBUI_DB, webuiTransportOnlyElection('utf8_byte', 10))
        const receipt = await measurePromptEnvelopeReceiptV2({
            protocolVersion: 2, target, settingsFingerprint: 'sf', envelope: flatEnvelope(),
        })
        expect(receipt.dispatchEligible).toBe(true)
        expect(receipt.eligibilityBasis).toBe('transport-only-explicit')
    })

    test('over the documented byte limit is refused even with allow-transport-only (§10-11)', async () => {
        // 4 UTF-8 bytes over a limit of 3.
        const target = await resolveWebuiFlatTarget(WEBUI_DB, webuiTransportOnlyElection('utf8_byte', 3))
        const receipt = await measurePromptEnvelopeReceiptV2({
            protocolVersion: 2, target, settingsFingerprint: 'sf', envelope: flatEnvelope(),
        })
        const positive = receipt.dimensions.find((d) => d.scope === 'positive')!
        expect(positive.verdict).toBe('over_limit')
        expect(receipt.dispatchEligible).toBe(false)
        expect(receipt.eligibilityBasis).toBe('over-limit')
    })
})

describe('unmeasured / provider_reported honesty (request §6/§10-11)', () => {
    test('unmeasured is dispatchable only via the explicit snapshotted opt-in, with empty dimensions', async () => {
        const target = await resolveWebuiFlatTarget(WEBUI_DB, {
            transportId: 'webui-flat',
            binding: { mode: 'request-pinned', checkpoint: 'ckpt' },
            measurement: { mode: 'unmeasured', allowUnmeasured: true },
            maxConcurrency: 1,
            priorityPolicy: 'fifo',
        })
        const receipt = await measurePromptEnvelopeReceiptV2({
            protocolVersion: 2, target, settingsFingerprint: 'sf', envelope: flatEnvelope(),
        })
        expect(receipt.measurementMode).toBe('unmeasured')
        expect(receipt.dimensions).toEqual([])
        expect(receipt.modelVerdict).toBe('unknown')
        expect(receipt).toMatchObject({ dispatchEligible: true, eligibilityBasis: 'unmeasured-explicit' })
    })

    test('provider_reported produces an HONEST non-dispatchable receipt (no faked within-limit)', async () => {
        const target = await resolveWebuiFlatTarget(WEBUI_DB, {
            transportId: 'webui-flat',
            binding: { mode: 'request-pinned', checkpoint: 'ckpt' },
            measurement: { mode: 'provider_reported' },
            maxConcurrency: 1,
            priorityPolicy: 'fifo',
        })
        const receipt = await measurePromptEnvelopeReceiptV2({
            protocolVersion: 2, target, settingsFingerprint: 'sf', envelope: flatEnvelope(),
        })
        expect(receipt.measurementMode).toBe('provider_reported')
        expect(receipt.modelVerdict).toBe('unknown')
        expect(receipt.dispatchEligible).toBe(false)
        expect(receipt.eligibilityBasis).toBe('policy-rejected')
    })
})
