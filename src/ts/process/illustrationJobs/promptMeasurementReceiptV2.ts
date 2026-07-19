import { IllustrationPromptV2ContractError } from './errors'
import { measureImagePrompt } from './imagePromptMeasurement'
import {
    computeEnvelopeHash,
    validateEnvelopeAgainstTarget,
    type IllustrationPromptEnvelopeV2,
} from './promptEnvelopeV2'
import type {
    IllustrationPromptDispatchPolicy,
    IllustrationPromptMeasurementMode,
    IllustrationPromptTargetV2,
} from './promptContextV2'
import type { IllustrationPromptV1 } from './types'

// ---------------------------------------------------------------------------
// Provider-neutral measurement receipt V2 (request §6).
//
// A receipt is a side-effect-free measurement result bound to a specific target
// fingerprint + envelope hash + measurement revision. The executor consults
// `dispatchEligible` (NOT `modelVerdict`) and re-verifies the binding against the
// current target before any provider call. Slice D can PRODUCE only 'model_exact'
// receipts (reusing the existing NAI V4 T5 machinery, unchanged budgets); the
// other three modes are typed and their eligibility table is implemented, but no
// live producer exists for them yet.
// ---------------------------------------------------------------------------

export const PROMPT_MEASUREMENT_RECEIPT_SCHEMA_VERSION = 2 as const

export type IllustrationPromptMeasurementVerdict = 'within_limit' | 'over_limit' | 'unknown'

export type IllustrationPromptEligibilityBasis =
    | 'model-exact'
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
//  - model_exact over-limit is ALWAYS ineligible ('over-limit').
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

function envelopeToPromptV1(envelope: IllustrationPromptEnvelopeV2): IllustrationPromptV1 {
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

// Produce a receipt for a compiled envelope against a resolved target. Slice D
// implements the 'model_exact' path only, delegating token counting to the
// existing NAI V4 T5 service (which re-verifies the settings fingerprint and the
// NovelAI V4 model gate). Other modes fail closed with a typed error.
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

    if (measurement.mode !== 'model_exact') {
        throw new IllustrationPromptV2ContractError(
            'prompt_measurement_mode_unsupported',
            `Slice D can only produce model_exact receipts; target requested "${measurement.mode}"`,
        )
    }

    const measured = await measureImagePrompt({
        protocolVersion: 1,
        settingsFingerprint: input.settingsFingerprint,
        prompt: envelopeToPromptV1(input.envelope),
    })
    const positiveVerdict: IllustrationPromptMeasurementVerdict =
        measured.positiveTokens <= measured.maxPositiveTokens ? 'within_limit' : 'over_limit'
    const negativeVerdict: IllustrationPromptMeasurementVerdict =
        measured.negativeTokens <= measured.maxNegativeTokens ? 'within_limit' : 'over_limit'
    const modelVerdict: IllustrationPromptMeasurementVerdict =
        positiveVerdict === 'within_limit' && negativeVerdict === 'within_limit'
            ? 'within_limit'
            : 'over_limit'

    const eligibility = computeDispatchEligibility({
        mode: 'model_exact',
        modelVerdict,
        transportVerdict: 'unknown',
        dispatchPolicy: measurement.dispatchPolicy,
    })

    return {
        schemaVersion: PROMPT_MEASUREMENT_RECEIPT_SCHEMA_VERSION,
        targetFingerprint: input.target.targetFingerprint,
        envelopeHash,
        measurementMode: 'model_exact',
        measurementRevision: measurement.revision,
        dimensions: [
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
        ],
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
