import type { Database } from '../../storage/database.svelte'
import {
    IllustrationLedgerValidationError,
    IllustrationPromptTargetUnavailableError,
} from './errors'
import { IMAGE_PROMPT_TOKENIZER_ID, isNaiV4ImageModel } from './imagePromptMeasurement'
import { sha256Hex } from './sourceHash'

// ---------------------------------------------------------------------------
// Provider-neutral Illustration Prompt Target V2 (request §4).
//
// This module owns the versioned V2 CONTRACT SHAPES plus the first transport
// adapter (`novelai-native`, request §7.1). Slice D resolves only that adapter;
// the other three transportIds are declared in the union but resolve to a typed
// `prompt_target_unavailable` preparation failure until Slice E.
//
// The four axes (provider protocol / transport adapter / model-checkpoint family /
// tag profile) are NEVER inferred from one another (request §2). Core captures the
// transport from the current provider settings; the tag profile is a Plugin-owned
// OPAQUE ref that Core stores verbatim and never interprets.
// ---------------------------------------------------------------------------

export const PROMPT_TARGET_CONTRACT_VERSION = 2 as const

export type IllustrationPromptTransportId =
    | 'novelai-native'
    | 'nai-compatible-flat'
    | 'webui-flat'
    | 'comfyui-flat'

export type IllustrationPromptLayout = 'flat' | 'native-character-slots' | 'pipe-slots'

export type IllustrationPromptBindingMode =
    | 'request-pinned'
    | 'probe-and-revalidate'
    | 'workflow-pinned'
    | 'opaque-remote'

export type IllustrationPromptNegativeChannel = 'separate' | 'unsupported'

export type IllustrationPromptMeasurementMode =
    | 'model_exact'
    | 'provider_reported'
    | 'transport_only'
    | 'unmeasured'

export type IllustrationPromptDispatchPolicy =
    | 'require-model-within-limit'
    | 'allow-provider-authoritative'
    | 'allow-transport-only'
    | 'allow-unmeasured'

export type IllustrationPromptTransportLimitUnit =
    | 'utf8_byte'
    | 'utf16_code_unit'
    | 'unicode_scalar_value'

export type IllustrationPromptDocumentedTransportLimit = {
    unit: IllustrationPromptTransportLimitUnit
    positive: number | null
    negative: number | null
    combined: number | null
}

export type IllustrationPromptPipeSerialization = {
    revision: string
    separator: ' | '
    positive: 'base-then-subjects'
    negative: 'base-only' | 'base-then-subjects'
    rejectLiteralSeparator: true
}

export type IllustrationPromptSubjectSlots = {
    maxSubjects: number
    positive: 'empty' | 'exact-scene-subjects'
    negative: 'empty' | 'match-positive'
    allowEmptyPositive: boolean
    allowEmptyNegative: boolean
    pipeSerialization: null | IllustrationPromptPipeSerialization
}

export type IllustrationPromptMeasurementDescriptor = {
    mode: IllustrationPromptMeasurementMode
    revision: string
    tokenizerId: string | null
    documentedTransportLimit: null | IllustrationPromptDocumentedTransportLimit
    dispatchPolicy: IllustrationPromptDispatchPolicy
}

export type IllustrationPromptQueueDescriptor = {
    concurrencyKey: string
    policyRevision: string
    maxConcurrency: number
    priorityPolicy: 'interactive-first' | 'fifo'
}

export type IllustrationPromptTargetV2 = {
    schemaVersion: 2
    targetFingerprint: string
    providerId: string
    transportId: IllustrationPromptTransportId
    modelId: string | null
    checkpointFingerprint: string | null
    workflowFingerprint: string | null
    bindingRevision: string | null
    bindingMode: IllustrationPromptBindingMode
    acceptedLayouts: IllustrationPromptLayout[]
    negativeChannel: IllustrationPromptNegativeChannel
    textPreservation: 'exact'
    subjectSlots: IllustrationPromptSubjectSlots
    measurement: IllustrationPromptMeasurementDescriptor
    // Operational tuning: `policyRevision`/`maxConcurrency`/`priorityPolicy` are
    // deliberately EXCLUDED from the target fingerprint (request §4). Only the
    // immutable `concurrencyKey` participates in fingerprint identity.
    queue: IllustrationPromptQueueDescriptor
}

export type IllustrationTagProfileRefV1 = {
    id: string
    revision: string
}

export type IllustrationPromptContextV2 = {
    target: IllustrationPromptTargetV2
    tagProfile: IllustrationTagProfileRefV1
    profileConfigRevision: string
    assetCatalogDigest: string
}

// ---------------------------------------------------------------------------
// novelai-native adapter descriptor (request §7.1). These constants pin the
// live NAI V4 behavior byte-for-byte so the V2 target reproduces exactly what
// the existing V1 executor/stableDiff path already does.
// ---------------------------------------------------------------------------

export const NOVELAI_NATIVE_MAX_SUBJECTS = 6
export const NOVELAI_NATIVE_MEASUREMENT_REVISION = 'novelai-native-t5-spiece-v1/1'
export const NOVELAI_NATIVE_QUEUE_POLICY_REVISION = 'novelai-native-queue/1'
export const NOVELAI_NATIVE_CONCURRENCY_KEY = 'novelai'
const DEFAULT_NAI_ENDPOINT = 'https://image.novelai.net/ai/generate-image'
const DEFAULT_NAI_MODEL = 'nai-diffusion-4-5-full'

export const NOVELAI_NATIVE_SUBJECT_SLOTS: IllustrationPromptSubjectSlots = Object.freeze({
    maxSubjects: NOVELAI_NATIVE_MAX_SUBJECTS,
    positive: 'exact-scene-subjects',
    negative: 'match-positive',
    allowEmptyPositive: false,
    allowEmptyNegative: true,
    pipeSerialization: null,
})

export const NOVELAI_NATIVE_MEASUREMENT: IllustrationPromptMeasurementDescriptor = Object.freeze({
    mode: 'model_exact',
    revision: NOVELAI_NATIVE_MEASUREMENT_REVISION,
    tokenizerId: IMAGE_PROMPT_TOKENIZER_ID,
    documentedTransportLimit: null,
    dispatchPolicy: 'require-model-within-limit',
})

// A resolvable non-NAI provider must NOT be inferred to be a compatible transport
// (request §2 forbidden inferences). Slice D maps only 'novelai' to a real target.
function intendedTransportForProvider(provider: string): IllustrationPromptTransportId | null {
    switch (provider) {
        case 'novelai':
            return 'novelai-native'
        case 'webui':
            return 'webui-flat'
        case 'comfy':
        case 'comfyui':
            return 'comfyui-flat'
        default:
            return null
    }
}

export type PromptTargetDatabase = Pick<Database, 'sdProvider' | 'NAIImgUrl' | 'NAIImgModel'>

// The canonical execution descriptor that the target fingerprint hashes. It
// intentionally carries `endpoint` (a dispatch identity) even though the public
// IllustrationPromptTargetV2 omits the raw URL, and it OMITS the mutable queue
// tuning (policyRevision/maxConcurrency/priorityPolicy), credentials, and any
// display metadata (request §4 inclusion/exclusion lists).
type PromptTargetExecutionDescriptor = {
    schemaVersion: 2
    providerId: string
    transportId: IllustrationPromptTransportId
    endpoint: string
    modelId: string | null
    checkpointFingerprint: string | null
    workflowFingerprint: string | null
    bindingMode: IllustrationPromptBindingMode
    bindingRevision: string | null
    acceptedLayouts: IllustrationPromptLayout[]
    negativeChannel: IllustrationPromptNegativeChannel
    textPreservation: 'exact'
    subjectSlots: IllustrationPromptSubjectSlots
    measurement: IllustrationPromptMeasurementDescriptor
    allowTransportOnly: boolean
    allowUnmeasured: boolean
    concurrencyKey: string
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
        .join(',')}}`
}

export async function computeTargetFingerprint(
    descriptor: PromptTargetExecutionDescriptor,
): Promise<string> {
    return sha256Hex(canonicalJson(descriptor))
}

function novelAiNativeExecutionDescriptor(
    db: PromptTargetDatabase,
): PromptTargetExecutionDescriptor {
    return {
        schemaVersion: 2,
        providerId: 'novelai',
        transportId: 'novelai-native',
        endpoint: db.NAIImgUrl ?? DEFAULT_NAI_ENDPOINT,
        modelId: db.NAIImgModel ?? DEFAULT_NAI_MODEL,
        checkpointFingerprint: null,
        workflowFingerprint: null,
        bindingMode: 'request-pinned',
        bindingRevision: null,
        acceptedLayouts: ['flat', 'native-character-slots'],
        negativeChannel: 'separate',
        textPreservation: 'exact',
        subjectSlots: NOVELAI_NATIVE_SUBJECT_SLOTS,
        measurement: NOVELAI_NATIVE_MEASUREMENT,
        // novelai-native never opts into transport-only/unmeasured dispatch: the
        // T5 model_exact gate is authoritative (request §6).
        allowTransportOnly: false,
        allowUnmeasured: false,
        concurrencyKey: NOVELAI_NATIVE_CONCURRENCY_KEY,
    }
}

export async function resolveNovelAiNativeTarget(
    db: PromptTargetDatabase,
): Promise<IllustrationPromptTargetV2> {
    const descriptor = novelAiNativeExecutionDescriptor(db)
    const targetFingerprint = await computeTargetFingerprint(descriptor)
    return {
        schemaVersion: 2,
        targetFingerprint,
        providerId: descriptor.providerId,
        transportId: descriptor.transportId,
        modelId: descriptor.modelId,
        checkpointFingerprint: descriptor.checkpointFingerprint,
        workflowFingerprint: descriptor.workflowFingerprint,
        bindingRevision: descriptor.bindingRevision,
        bindingMode: descriptor.bindingMode,
        acceptedLayouts: [...descriptor.acceptedLayouts],
        negativeChannel: descriptor.negativeChannel,
        textPreservation: descriptor.textPreservation,
        subjectSlots: { ...descriptor.subjectSlots },
        measurement: { ...descriptor.measurement },
        queue: {
            concurrencyKey: descriptor.concurrencyKey,
            policyRevision: NOVELAI_NATIVE_QUEUE_POLICY_REVISION,
            maxConcurrency: 1,
            priorityPolicy: 'interactive-first',
        },
    }
}

// The novelai-native adapter pins `model_exact`/T5 measurement UNCONDITIONALLY
// (NOVELAI_NATIVE_MEASUREMENT), but imagePromptMeasurement only performs that exact
// T5 measurement for NAI V4-family models (isNaiV4ImageModel). A non-V4 NovelAI
// model (e.g. 'nai-diffusion-3') therefore has no honest measurable adapter in
// Slice D. The effective model mirrors canonicalizeNaiSettings' default so the gate
// agrees with what measurement will actually see.
function novelAiNativeModelIsMeasurable(db: PromptTargetDatabase): boolean {
    return isNaiV4ImageModel(db.NAIImgModel ?? DEFAULT_NAI_MODEL)
}

// Resolve the durable target for the CURRENTLY configured provider. Slice D only
// resolves 'novelai' + a V4 model -> novelai-native; every other provider yields a
// typed preparation failure (request §4/§7: the other transports arrive in Slice E).
export async function resolvePromptTargetV2(
    db: PromptTargetDatabase,
): Promise<IllustrationPromptTargetV2> {
    const provider = db.sdProvider ?? ''
    if (provider === 'novelai') {
        // Fail closed BEFORE any durable capture rather than pinning a descriptor
        // that dishonestly claims exact T5 measurability the model cannot honor.
        // This keeps the unmeasurable-model rejection at the pre-LLM prepare gate
        // (request §6 honest measurement descriptor; §8 mismatch => Plugin LLM 0회)
        // instead of deferring it to the post-LLM measurement receipt.
        if (!novelAiNativeModelIsMeasurable(db)) {
            throw new IllustrationPromptTargetUnavailableError(
                'novelai-native',
                'novelai-native provides exact NAI T5 measurement only for NovelAI V4 models; '
                    + 'this NovelAI model has no measurable transport adapter until a later slice',
            )
        }
        return await resolveNovelAiNativeTarget(db)
    }

    const intended = intendedTransportForProvider(provider)
    if (intended) {
        throw new IllustrationPromptTargetUnavailableError(
            intended,
            'this transport adapter is not implemented until Slice E',
        )
    }
    throw new IllustrationPromptTargetUnavailableError(
        provider.length > 0 ? provider : 'unset-provider',
        'no provider-neutral illustration transport adapter is available for this provider',
    )
}

// ---------------------------------------------------------------------------
// Opaque Plugin-owned ref validation (request §3/§4). Core validates ONLY that
// these are bounded non-empty strings; it never parses, normalizes, or otherwise
// interprets their meaning — that is Plugin-owned.
// ---------------------------------------------------------------------------

export const MAX_ILLUSTRATION_OPAQUE_REF_LENGTH = 1024

export function validateOpaquePromptRef(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new IllustrationLedgerValidationError(`${label} must be a non-empty string`)
    }
    if (value.length > MAX_ILLUSTRATION_OPAQUE_REF_LENGTH) {
        throw new IllustrationLedgerValidationError(
            `${label} must be at most ${MAX_ILLUSTRATION_OPAQUE_REF_LENGTH} code units`,
        )
    }
    return value
}

export function validateTagProfileRef(value: unknown): IllustrationTagProfileRefV1 {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new IllustrationLedgerValidationError('tagProfile must be an object')
    }
    const input = value as Record<string, unknown>
    const keys = Object.keys(input)
    if (keys.length !== 2 || !Object.hasOwn(input, 'id') || !Object.hasOwn(input, 'revision')) {
        throw new IllustrationLedgerValidationError('tagProfile must contain exactly { id, revision }')
    }
    return {
        id: validateOpaquePromptRef(input.id, 'tagProfile.id'),
        revision: validateOpaquePromptRef(input.revision, 'tagProfile.revision'),
    }
}

// Re-resolve the target from the CURRENT database and confirm its fingerprint
// still matches the value captured at prepare time. Used before any provider
// dispatch so a post-capture endpoint/model change fails closed (request §4/§10-6).
export async function targetFingerprintMatchesCurrentDb(
    db: PromptTargetDatabase,
    expectedFingerprint: string,
): Promise<boolean> {
    const provider = db.sdProvider ?? ''
    // A provider change that no longer resolves any target is, by definition, a
    // fingerprint mismatch — never a silent pass.
    if (provider !== 'novelai') return false
    // A NovelAI model that dropped out of the V4 family no longer resolves a valid
    // novelai-native target (only V4 honors the pinned T5 model_exact measurement):
    // a definite mismatch, never a silent pass.
    if (!novelAiNativeModelIsMeasurable(db)) return false
    const current = await resolveNovelAiNativeTarget(db)
    return current.targetFingerprint === expectedFingerprint
}
