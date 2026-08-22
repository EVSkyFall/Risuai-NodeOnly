import { IllustrationPromptV2ContractError } from './errors'
import { evaluateImagePromptLimits, measureImagePrompt } from './imagePromptMeasurement'
import {
    computeEnvelopeHash,
    serializeEnvelopeForTransport,
    validateEnvelopeAgainstTarget,
    type IllustrationPromptEnvelopeV2,
} from './promptEnvelopeV2'
import type {
    IllustrationPromptDispatchPolicy,
    IllustrationPromptMeasurementMode,
    IllustrationPromptTargetV2,
    IllustrationPromptTransportLimitUnit,
} from './promptContextV2'
import type { IllustrationPromptV1 } from './types'

// ---------------------------------------------------------------------------
// Provider-neutral measurement receipt V2 (request §6).
//
// A receipt is a side-effect-free measurement result bound to a specific target
// fingerprint + envelope hash + measurement revision. The executor consults
// `dispatchEligible` (NOT `modelVerdict`) and re-verifies the binding against the
// current target before any provider call. NovelAI-native produces exact V4 T5
// receipts and explicitly approximate V5 T5 receipts; non-model modes retain
// their separate eligibility policies.
// ---------------------------------------------------------------------------

export const PROMPT_MEASUREMENT_RECEIPT_SCHEMA_VERSION = 2 as const

export type IllustrationPromptMeasurementVerdict = 'within_limit' | 'over_limit' | 'unknown'

export type IllustrationPromptEligibilityBasis =
    | 'model-exact'
    | 'model-approximate'
    | 'provider-authoritative'
    | 'transport-only-explicit'
    | 'unmeasured-explicit'
    | 'over-limit'
    | 'policy-rejected'

export type IllustrationPromptMeasurementDimensionV2 = {
    scope: 'positive' | 'negative' | 'combined' | 'transport'
    unit: 'token' | 'utf8_byte' | 'utf16_code_unit' | 'unicode_scalar_value'
    measured: number | null
    limit: number | null
    verdict: IllustrationPromptMeasurementVerdict
}

export type IllustrationPromptMeasurementReceiptV2 = {
    schemaVersion: 2
    targetFingerprint: string
    envelopeHash: string
    measurementMode: IllustrationPromptMeasurementMode
    measurementRevision: string
    dimensions: IllustrationPromptMeasurementDimensionV2[]
    modelVerdict: IllustrationPromptMeasurementVerdict
    dispatchEligible: boolean
    eligibilityBasis: IllustrationPromptEligibilityBasis
}

export type DispatchEligibilityInput = {
    mode: IllustrationPromptMeasurementMode
    modelVerdict: IllustrationPromptMeasurementVerdict
    transportVerdict: IllustrationPromptMeasurementVerdict
    dispatchPolicy: IllustrationPromptDispatchPolicy
}

export type DispatchEligibilityResult = {
    dispatchEligible: boolean
    eligibilityBasis: IllustrationPromptEligibilityBasis
}

// The §6 eligibility table, implemented as a pure function. Invariants:
//  - bounded model measurements are ALWAYS ineligible when over limit.
//  - transport_only never sets modelVerdict to within_limit and is eligible ONLY
//    with an explicit allow-transport-only dispatch policy AND a passing transport
//    verdict; otherwise 'policy-rejected'/'over-limit'.
//  - unmeasured is eligible ONLY with an explicit allow-unmeasured policy.
//  - provider_reported is eligible ONLY when authoritative within-limit AND the
//    allow-provider-authoritative policy is set.
export function computeDispatchEligibility(
    input: DispatchEligibilityInput,
): DispatchEligibilityResult {
    switch (input.mode) {
        case 'model_exact':
            if (input.modelVerdict === 'over_limit') return { dispatchEligible: false, eligibilityBasis: 'over-limit' }
            if (input.modelVerdict === 'within_limit') return { dispatchEligible: true, eligibilityBasis: 'model-exact' }
            return { dispatchEligible: false, eligibilityBasis: 'policy-rejected' }
        case 'model_approximate':
            if (input.modelVerdict === 'over_limit') return { dispatchEligible: false, eligibilityBasis: 'over-limit' }
            if (input.modelVerdict === 'within_limit') return { dispatchEligible: true, eligibilityBasis: 'model-approximate' }
            return { dispatchEligible: false, eligibilityBasis: 'policy-rejected' }
        case 'provider_reported':
            if (input.modelVerdict === 'over_limit') return { dispatchEligible: false, eligibilityBasis: 'over-limit' }
            if (input.modelVerdict === 'within_limit'
                && input.dispatchPolicy === 'allow-provider-authoritative') {
                return { dispatchEligible: true, eligibilityBasis: 'provider-authoritative' }
            }
            return { dispatchEligible: false, eligibilityBasis: 'policy-rejected' }
        case 'transport_only':
            if (input.transportVerdict === 'over_limit') return { dispatchEligible: false, eligibilityBasis: 'over-limit' }
            if (input.dispatchPolicy === 'allow-transport-only') {
                return { dispatchEligible: true, eligibilityBasis: 'transport-only-explicit' }
            }
            return { dispatchEligible: false, eligibilityBasis: 'policy-rejected' }
        case 'unmeasured':
            if (input.dispatchPolicy === 'allow-unmeasured') {
                return { dispatchEligible: true, eligibilityBasis: 'unmeasured-explicit' }
            }
            return { dispatchEligible: false, eligibilityBasis: 'policy-rejected' }
        default:
            return { dispatchEligible: false, eligibilityBasis: 'policy-rejected' }
    }
}

// Map a flat / native-character-slots envelope to the V1 structured prompt shape the
// existing NAI T5 measurement + novelai-native dispatch already consume. pipe-slots has
// no V1 mapping (it is serialized to flat transport text instead) and is rejected.
export function envelopeToPromptV1(envelope: IllustrationPromptEnvelopeV2): IllustrationPromptV1 {
    if (envelope.layout === 'flat') {
        return {
            schemaVersion: 1,
            layout: 'flat',
            basePositive: envelope.basePositive,
            characterPositives: [],
            baseNegative: envelope.baseNegative,
            characterNegatives: [],
        }
    }
    if (envelope.layout === 'native-character-slots') {
        return {
            schemaVersion: 1,
            layout: 'nai-v4-characters',
            basePositive: envelope.basePositive,
            characterPositives: [...envelope.subjectPositives],
            baseNegative: envelope.baseNegative,
            characterNegatives: [...envelope.subjectNegatives],
        }
    }
    // pipe-slots never reaches here: validateEnvelopeAgainstTarget rejects it first.
    throw new IllustrationPromptV2ContractError(
        'prompt_pipe_serialization_unsupported',
        'pipe-slots measurement is not implemented until Slice E',
    )
}

export type MeasurePromptEnvelopeReceiptInputV2 = {
    protocolVersion: 2
    target: IllustrationPromptTargetV2
    settingsFingerprint: string
    envelope: IllustrationPromptEnvelopeV2
}

// Produce a receipt for a compiled envelope against a resolved target. Bounded
// model modes delegate to the NAI measurement service, which re-verifies the
// settings fingerprint and the selected model-family profile.
export async function measurePromptEnvelopeReceiptV2(
    input: MeasurePromptEnvelopeReceiptInputV2,
): Promise<IllustrationPromptMeasurementReceiptV2> {
    if (!input || typeof input !== 'object' || input.protocolVersion !== 2) {
        throw new IllustrationPromptV2ContractError(
            'prompt_envelope_invalid',
            'measurement input protocolVersion must be 2',
        )
    }
    // Layout/negative-channel/cardinality gate before any tokenizer work.
    validateEnvelopeAgainstTarget(input.envelope, input.target)
    const envelopeHash = await computeEnvelopeHash(input.envelope)
    const { measurement } = input.target

    switch (measurement.mode) {
        case 'model_exact':
            return await measureBoundedModelReceipt(input, envelopeHash, 'model_exact')
        case 'model_approximate':
            return await measureBoundedModelReceipt(input, envelopeHash, 'model_approximate')
        case 'transport_only':
            return measureTransportOnlyReceipt(input, envelopeHash)
        case 'unmeasured':
            return buildNonMeasuringReceipt(input, envelopeHash, 'unmeasured', 'unknown')
        case 'provider_reported':
            // A side-effect-free measurement cannot obtain a provider's official
            // per-prompt count (that arrives only after a charged dispatch), so
            // Slice E ships no live provider_reported producer: modelVerdict stays
            // 'unknown' and the eligibility table renders it non-dispatchable rather
            // than faking an authoritative within-limit verdict (request §6 honesty).
            return buildNonMeasuringReceipt(input, envelopeHash, 'provider_reported', 'unknown')
        default:
            throw new IllustrationPromptV2ContractError(
                'prompt_measurement_mode_unsupported',
                `Unsupported measurement mode "${measurement.mode as string}"`,
            )
    }
}

async function measureBoundedModelReceipt(
    input: MeasurePromptEnvelopeReceiptInputV2,
    envelopeHash: string,
    mode: 'model_exact' | 'model_approximate',
): Promise<IllustrationPromptMeasurementReceiptV2> {
    const { measurement } = input.target
    const measured = await measureImagePrompt({
        protocolVersion: 1,
        settingsFingerprint: input.settingsFingerprint,
        prompt: envelopeToPromptV1(input.envelope),
    })
    const limitEvaluation = evaluateImagePromptLimits(measured)
    const positiveVerdict: IllustrationPromptMeasurementVerdict = limitEvaluation.positiveWithinLimits
        ? 'within_limit'
        : 'over_limit'
    const negativeVerdict: IllustrationPromptMeasurementVerdict = limitEvaluation.negativeWithinLimits
        ? 'within_limit'
        : 'over_limit'
    const modelVerdict: IllustrationPromptMeasurementVerdict = limitEvaluation.withinLimits
        ? 'within_limit'
        : 'over_limit'

    const eligibility = computeDispatchEligibility({
        mode,
        modelVerdict,
        transportVerdict: 'unknown',
        dispatchPolicy: measurement.dispatchPolicy,
    })

    const dimensions: IllustrationPromptMeasurementDimensionV2[] = [
        {
            scope: 'positive',
            unit: 'token',
            measured: measured.positiveTokens,
            limit: measured.maxPositiveTokens,
            verdict: positiveVerdict,
        },
        {
            scope: 'negative',
            unit: 'token',
            measured: measured.negativeTokens,
            limit: measured.maxNegativeTokens,
            verdict: negativeVerdict,
        },
    ]
    if (limitEvaluation.pooled) {
        dimensions.push({
            scope: 'combined',
            unit: 'token',
            measured: limitEvaluation.combinedTokens,
            limit: limitEvaluation.combinedLimit,
            verdict: modelVerdict,
        })
    }

    return {
        schemaVersion: PROMPT_MEASUREMENT_RECEIPT_SCHEMA_VERSION,
        targetFingerprint: input.target.targetFingerprint,
        envelopeHash,
        measurementMode: mode,
        measurementRevision: measurement.revision,
        dimensions,
        modelVerdict,
        dispatchEligible: eligibility.dispatchEligible,
        eligibilityBasis: eligibility.eligibilityBasis,
    }
}

// Count code units per the DOCUMENTED transport unit. An astral scalar (e.g. U+10437
// '𐐷') distinguishes all three: 4 utf8 bytes, 2 utf16 code units, 1 scalar value —
// so we must never conflate them (request §6/§10-13). The count is over the exact
// serialized transport text; nothing is trimmed or normalized.
function countTransportUnit(text: string, unit: IllustrationPromptTransportLimitUnit): number {
    switch (unit) {
        case 'utf8_byte':
            return new TextEncoder().encode(text).byteLength
        case 'utf16_code_unit':
            return text.length
        case 'unicode_scalar_value':
            return [...text].length
    }
}

function transportDimensionVerdict(measured: number, limit: number | null): IllustrationPromptMeasurementVerdict {
    if (limit === null) return 'unknown'
    return measured <= limit ? 'within_limit' : 'over_limit'
}

function measureTransportOnlyReceipt(
    input: MeasurePromptEnvelopeReceiptInputV2,
    envelopeHash: string,
): IllustrationPromptMeasurementReceiptV2 {
    const { measurement } = input.target
    const limit = measurement.documentedTransportLimit
    if (!limit) {
        throw new IllustrationPromptV2ContractError(
            'prompt_measurement_mode_unsupported',
            'transport_only measurement requires a documentedTransportLimit',
        )
    }
    const serialized = serializeEnvelopeForTransport(input.envelope, input.target)
    const positiveMeasured = countTransportUnit(serialized.positive, limit.unit)
    const negativeMeasured = countTransportUnit(serialized.negative, limit.unit)
    // Combined budget is the sum of the independently-transported parts, so a lone
    // surrogate at a part boundary can never be silently coalesced across parts.
    const combinedMeasured = positiveMeasured + negativeMeasured

    const positiveVerdict = transportDimensionVerdict(positiveMeasured, limit.positive)
    const negativeVerdict = transportDimensionVerdict(negativeMeasured, limit.negative)
    const combinedVerdict = transportDimensionVerdict(combinedMeasured, limit.combined)

    const anyOver = positiveVerdict === 'over_limit'
        || negativeVerdict === 'over_limit'
        || combinedVerdict === 'over_limit'
    const anyKnown = limit.positive !== null || limit.negative !== null || limit.combined !== null
    const transportVerdict: IllustrationPromptMeasurementVerdict =
        anyOver ? 'over_limit' : anyKnown ? 'within_limit' : 'unknown'

    const eligibility = computeDispatchEligibility({
        mode: 'transport_only',
        // transport_only NEVER sets modelVerdict to within/over (request §6).
        modelVerdict: 'unknown',
        transportVerdict,
        dispatchPolicy: measurement.dispatchPolicy,
    })

    return {
        schemaVersion: PROMPT_MEASUREMENT_RECEIPT_SCHEMA_VERSION,
        targetFingerprint: input.target.targetFingerprint,
        envelopeHash,
        measurementMode: 'transport_only',
        measurementRevision: measurement.revision,
        dimensions: [
            { scope: 'positive', unit: limit.unit, measured: positiveMeasured, limit: limit.positive, verdict: positiveVerdict },
            { scope: 'negative', unit: limit.unit, measured: negativeMeasured, limit: limit.negative, verdict: negativeVerdict },
            { scope: 'combined', unit: limit.unit, measured: combinedMeasured, limit: limit.combined, verdict: combinedVerdict },
        ],
        modelVerdict: 'unknown',
        dispatchEligible: eligibility.dispatchEligible,
        eligibilityBasis: eligibility.eligibilityBasis,
    }
}

// unmeasured / provider_reported: no enforceable measurement is produced. Dimensions
// stay empty (nothing was measured) and modelVerdict is 'unknown' — never dressed up
// as a completed measurement (request §6). Eligibility falls entirely to the target's
// explicit dispatch policy.
function buildNonMeasuringReceipt(
    input: MeasurePromptEnvelopeReceiptInputV2,
    envelopeHash: string,
    mode: 'unmeasured' | 'provider_reported',
    modelVerdict: IllustrationPromptMeasurementVerdict,
): IllustrationPromptMeasurementReceiptV2 {
    const { measurement } = input.target
    const eligibility = computeDispatchEligibility({
        mode,
        modelVerdict,
        transportVerdict: 'unknown',
        dispatchPolicy: measurement.dispatchPolicy,
    })
    return {
        schemaVersion: PROMPT_MEASUREMENT_RECEIPT_SCHEMA_VERSION,
        targetFingerprint: input.target.targetFingerprint,
        envelopeHash,
        measurementMode: mode,
        measurementRevision: measurement.revision,
        dimensions: [],
        modelVerdict,
        dispatchEligible: eligibility.dispatchEligible,
        eligibilityBasis: eligibility.eligibilityBasis,
    }
}

function bindingMismatch(detail: string): never {
    throw new IllustrationPromptV2ContractError('prompt_receipt_binding_mismatch', detail)
}

// The dispatch-time guard: a receipt is honored ONLY if it was produced for this
// exact target fingerprint, this exact envelope hash, and this measurement
// revision/mode (request §6/§10-10 — cross-target/cross-envelope reuse rejects).
// Callers consult dispatchEligible, never modelVerdict.
export function assertReceiptDispatchEligibleForTarget(
    receipt: IllustrationPromptMeasurementReceiptV2,
    target: IllustrationPromptTargetV2,
    envelopeHash: string,
): void {
    if (receipt.targetFingerprint !== target.targetFingerprint) {
        bindingMismatch('The measurement receipt was produced for a different target fingerprint')
    }
    if (receipt.envelopeHash !== envelopeHash) {
        bindingMismatch('The measurement receipt was produced for a different envelope')
    }
    if (receipt.measurementRevision !== target.measurement.revision) {
        bindingMismatch('The measurement receipt was produced under a different measurement revision')
    }
    if (receipt.measurementMode !== target.measurement.mode) {
        bindingMismatch('The measurement receipt mode does not match the target measurement mode')
    }
    if (!receipt.dispatchEligible) {
        throw new IllustrationPromptV2ContractError(
            'prompt_dispatch_ineligible',
            `The measurement receipt is not dispatch-eligible (basis: ${receipt.eligibilityBasis})`,
        )
    }
}
