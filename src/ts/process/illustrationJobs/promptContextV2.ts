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

export type PromptTargetDatabase = Pick<
    Database,
    'sdProvider' | 'NAIImgUrl' | 'NAIImgModel' | 'webUiUrl' | 'comfyUiUrl' | 'comfyConfig'
>

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

// ---------------------------------------------------------------------------
// Explicit transport election (request §2/§7.2-7.4). The non-native transports
// are NEVER inferred from provider/URL shape — the Plugin sets a durable election
// via a validated RPC and Core resolves ONLY what the election names, cross-checked
// against the current provider protocol. Endpoints and credentials are read from
// the existing db fields BY NAME (never copied into the election), so the election
// stores no secrets (request §D5 / gap §4).
// ---------------------------------------------------------------------------

export const TRANSPORT_CONFIG_CONTRACT_VERSION = 1 as const
export const TRANSPORT_ONLY_MEASUREMENT_REVISION = 'transport-only/1'
export const UNMEASURED_MEASUREMENT_REVISION = 'unmeasured/1'
export const PROVIDER_REPORTED_MEASUREMENT_REVISION = 'provider-reported/1'
export const WEBUI_FLAT_QUEUE_POLICY_REVISION = 'webui-flat-queue/1'
export const COMFYUI_FLAT_QUEUE_POLICY_REVISION = 'comfyui-flat-queue/1'
export const NAI_COMPATIBLE_FLAT_QUEUE_POLICY_REVISION = 'nai-compatible-flat-queue/1'
export const MAX_TRANSPORT_SUBJECT_SLOTS = 32
export const MAX_TRANSPORT_CONCURRENCY = 32

// The user's explicit measurement election. transport_only / unmeasured carry the
// REQUIRED explicit opt-in literal so the eligibility is snapshotted into the target
// fingerprint and there is never an automatic opt-in (request §6).
export type IllustrationTransportMeasurementElection =
    | {
        mode: 'transport_only'
        unit: IllustrationPromptTransportLimitUnit
        positive: number | null
        negative: number | null
        combined: number | null
        allowTransportOnly: true
    }
    | { mode: 'provider_reported' }
    | { mode: 'unmeasured'; allowUnmeasured: true }

export type IllustrationNaiCompatibleFlatElection = {
    transportId: 'nai-compatible-flat'
    layout: 'flat' | 'pipe-slots'
    // Present iff layout === 'pipe-slots'.
    pipe?: {
        revision: string
        maxSubjects: number
        negative: 'base-only' | 'base-then-subjects'
    }
    measurement: IllustrationTransportMeasurementElection
    maxConcurrency: number
    priorityPolicy: 'interactive-first' | 'fifo'
}

export type IllustrationWebuiFlatElection = {
    transportId: 'webui-flat'
    binding:
        | { mode: 'request-pinned'; checkpoint: string }
        | { mode: 'probe-and-revalidate'; checkpointFingerprint: string }
    measurement: IllustrationTransportMeasurementElection
    maxConcurrency: number
    priorityPolicy: 'interactive-first' | 'fifo'
}

export type IllustrationComfyuiFlatElection = {
    transportId: 'comfyui-flat'
    workflowFingerprint: string
    positiveNode: { nodeId: string; inputName: string }
    negativeNode: { nodeId: string; inputName: string }
    modelBindingRevision: string
    measurement: IllustrationTransportMeasurementElection
    maxConcurrency: number
    priorityPolicy: 'interactive-first' | 'fifo'
}

export type IllustrationTransportElection =
    | IllustrationNaiCompatibleFlatElection
    | IllustrationWebuiFlatElection
    | IllustrationComfyuiFlatElection

export type IllustrationTransportConfigV1 = {
    schemaVersion: 1
    election: IllustrationTransportElection | null
}

export const EMPTY_TRANSPORT_CONFIG: IllustrationTransportConfigV1 = Object.freeze({
    schemaVersion: 1,
    election: null,
})

function invalidTransportConfig(message: string): never {
    throw new IllustrationLedgerValidationError(`transportConfig ${message}`)
}

function boundedRef(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        invalidTransportConfig(`${label} must be a non-empty string`)
    }
    if ((value as string).length > MAX_ILLUSTRATION_OPAQUE_REF_LENGTH) {
        invalidTransportConfig(`${label} must be at most ${MAX_ILLUSTRATION_OPAQUE_REF_LENGTH} code units`)
    }
    return value as string
}

function boundedCount(value: unknown, label: string, max: number): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
        invalidTransportConfig(`${label} must be an integer in [0, ${max}]`)
    }
    return value as number
}

function optionalLimit(value: unknown, label: string): number | null {
    if (value === null) return null
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        invalidTransportConfig(`${label} must be null or a non-negative integer`)
    }
    return value as number
}

function parseMeasurementElection(value: unknown): IllustrationTransportMeasurementElection {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        invalidTransportConfig('measurement must be an object')
    }
    const input = value as Record<string, unknown>
    if (input.mode === 'transport_only') {
        if (
            input.unit !== 'utf8_byte'
            && input.unit !== 'utf16_code_unit'
            && input.unit !== 'unicode_scalar_value'
        ) {
            invalidTransportConfig('measurement.unit must be a documented transport unit')
        }
        // The explicit opt-in must be literally present (request §6: no auto opt-in).
        if (input.allowTransportOnly !== true) {
            invalidTransportConfig('transport_only measurement requires allowTransportOnly:true')
        }
        return {
            mode: 'transport_only',
            unit: input.unit,
            positive: optionalLimit(input.positive, 'measurement.positive'),
            negative: optionalLimit(input.negative, 'measurement.negative'),
            combined: optionalLimit(input.combined, 'measurement.combined'),
            allowTransportOnly: true,
        }
    }
    if (input.mode === 'provider_reported') {
        return { mode: 'provider_reported' }
    }
    if (input.mode === 'unmeasured') {
        if (input.allowUnmeasured !== true) {
            invalidTransportConfig('unmeasured measurement requires allowUnmeasured:true')
        }
        return { mode: 'unmeasured', allowUnmeasured: true }
    }
    invalidTransportConfig('measurement.mode is not a non-native transport mode')
}

function parsePriorityPolicy(value: unknown): 'interactive-first' | 'fifo' {
    if (value !== 'interactive-first' && value !== 'fifo') {
        invalidTransportConfig('priorityPolicy must be "interactive-first" or "fifo"')
    }
    return value
}

function parseTransportElection(value: unknown): IllustrationTransportElection {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        invalidTransportConfig('election must be an object')
    }
    const input = value as Record<string, unknown>
    const measurement = parseMeasurementElection(input.measurement)
    const maxConcurrency = boundedCount(input.maxConcurrency, 'maxConcurrency', MAX_TRANSPORT_CONCURRENCY)
    if (maxConcurrency < 1) invalidTransportConfig('maxConcurrency must be at least 1')
    const priorityPolicy = parsePriorityPolicy(input.priorityPolicy)

    if (input.transportId === 'nai-compatible-flat') {
        if (input.layout !== 'flat' && input.layout !== 'pipe-slots') {
            invalidTransportConfig('nai-compatible-flat layout must be "flat" or "pipe-slots"')
        }
        let pipe: IllustrationNaiCompatibleFlatElection['pipe']
        if (input.layout === 'pipe-slots') {
            const raw = input.pipe
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                invalidTransportConfig('pipe-slots layout requires a pipe descriptor')
            }
            const pipeInput = raw as Record<string, unknown>
            if (pipeInput.negative !== 'base-only' && pipeInput.negative !== 'base-then-subjects') {
                invalidTransportConfig('pipe.negative must be "base-only" or "base-then-subjects"')
            }
            pipe = {
                revision: boundedRef(pipeInput.revision, 'pipe.revision'),
                maxSubjects: boundedCount(pipeInput.maxSubjects, 'pipe.maxSubjects', MAX_TRANSPORT_SUBJECT_SLOTS),
                negative: pipeInput.negative,
            }
        } else if (input.pipe !== undefined) {
            invalidTransportConfig('flat layout must not carry a pipe descriptor')
        }
        return { transportId: 'nai-compatible-flat', layout: input.layout, pipe, measurement, maxConcurrency, priorityPolicy }
    }

    if (input.transportId === 'webui-flat') {
        const binding = input.binding
        if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
            invalidTransportConfig('webui-flat requires a binding')
        }
        const bindingInput = binding as Record<string, unknown>
        if (bindingInput.mode === 'request-pinned') {
            return {
                transportId: 'webui-flat',
                binding: { mode: 'request-pinned', checkpoint: boundedRef(bindingInput.checkpoint, 'binding.checkpoint') },
                measurement,
                maxConcurrency,
                priorityPolicy,
            }
        }
        if (bindingInput.mode === 'probe-and-revalidate') {
            return {
                transportId: 'webui-flat',
                binding: {
                    mode: 'probe-and-revalidate',
                    checkpointFingerprint: boundedRef(bindingInput.checkpointFingerprint, 'binding.checkpointFingerprint'),
                },
                measurement,
                maxConcurrency,
                priorityPolicy,
            }
        }
        // A plain user label is NOT a checkpoint proof (request §7.3): neither
        // binding mode is provable -> the election itself is invalid.
        invalidTransportConfig('webui-flat binding.mode must be "request-pinned" or "probe-and-revalidate"')
    }

    if (input.transportId === 'comfyui-flat') {
        const parseNode = (raw: unknown, label: string) => {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                invalidTransportConfig(`${label} must be an object`)
            }
            const node = raw as Record<string, unknown>
            return {
                nodeId: boundedRef(node.nodeId, `${label}.nodeId`),
                inputName: boundedRef(node.inputName, `${label}.inputName`),
            }
        }
        return {
            transportId: 'comfyui-flat',
            workflowFingerprint: boundedRef(input.workflowFingerprint, 'workflowFingerprint'),
            positiveNode: parseNode(input.positiveNode, 'positiveNode'),
            negativeNode: parseNode(input.negativeNode, 'negativeNode'),
            modelBindingRevision: boundedRef(input.modelBindingRevision, 'modelBindingRevision'),
            measurement,
            maxConcurrency,
            priorityPolicy,
        }
    }

    invalidTransportConfig('election.transportId is not a supported non-native transport')
}

export function parseTransportConfig(value: unknown): IllustrationTransportConfigV1 {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        invalidTransportConfig('must be an object')
    }
    const input = value as Record<string, unknown>
    if (input.schemaVersion !== TRANSPORT_CONFIG_CONTRACT_VERSION) {
        invalidTransportConfig('schemaVersion must be 1')
    }
    if (input.election === null || input.election === undefined) {
        return { schemaVersion: 1, election: null }
    }
    return { schemaVersion: 1, election: parseTransportElection(input.election) }
}

// A non-native transport election, when present, is authoritative. It never
// silently infers a transport from the provider; instead it validates that the
// current provider protocol is COMPATIBLE with the elected NAI-shaped/webui/comfy
// transport (request §2). An incompatible provider fails closed.
function requireCompatibleProvider(
    transportId: IllustrationPromptTransportId,
    provider: string,
): void {
    const compatible =
        (transportId === 'nai-compatible-flat' && provider === 'novelai')
        || (transportId === 'webui-flat' && provider === 'webui')
        || (transportId === 'comfyui-flat' && (provider === 'comfy' || provider === 'comfyui'))
    if (!compatible) {
        throw new IllustrationPromptTargetUnavailableError(
            transportId,
            `the elected transport is not compatible with the current provider "${provider.length > 0 ? provider : 'unset'}"`,
        )
    }
}

function requireEndpoint(
    raw: unknown,
    transportId: IllustrationPromptTransportId,
    requireHttps: boolean,
): string {
    if (typeof raw !== 'string' || raw.length === 0) {
        throw new IllustrationPromptTargetUnavailableError(transportId, 'no endpoint URL is configured')
    }
    let url: URL
    try {
        url = new URL(raw)
    } catch {
        throw new IllustrationPromptTargetUnavailableError(transportId, 'the configured endpoint is not a valid URL')
    }
    if (requireHttps ? url.protocol !== 'https:' : url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new IllustrationPromptTargetUnavailableError(
            transportId,
            requireHttps ? 'the endpoint must be an https URL' : 'the endpoint must be an http(s) URL',
        )
    }
    return raw
}

function measurementDescriptorFromElection(
    election: IllustrationTransportMeasurementElection,
): IllustrationPromptMeasurementDescriptor {
    switch (election.mode) {
        case 'transport_only':
            return {
                mode: 'transport_only',
                revision: TRANSPORT_ONLY_MEASUREMENT_REVISION,
                tokenizerId: null,
                documentedTransportLimit: {
                    unit: election.unit,
                    positive: election.positive,
                    negative: election.negative,
                    combined: election.combined,
                },
                dispatchPolicy: 'allow-transport-only',
            }
        case 'provider_reported':
            return {
                mode: 'provider_reported',
                revision: PROVIDER_REPORTED_MEASUREMENT_REVISION,
                tokenizerId: null,
                documentedTransportLimit: null,
                dispatchPolicy: 'allow-provider-authoritative',
            }
        case 'unmeasured':
            return {
                mode: 'unmeasured',
                revision: UNMEASURED_MEASUREMENT_REVISION,
                tokenizerId: null,
                documentedTransportLimit: null,
                dispatchPolicy: 'allow-unmeasured',
            }
    }
}

function electionAllowFlags(
    election: IllustrationTransportMeasurementElection,
): { allowTransportOnly: boolean; allowUnmeasured: boolean } {
    return {
        allowTransportOnly: election.mode === 'transport_only',
        allowUnmeasured: election.mode === 'unmeasured',
    }
}

// Distinct concurrency keys never serialize against each other (request §8); the
// key is stable per transport+endpoint so two targets on the same backend share a
// queue while different backends run in parallel. It participates in the target
// fingerprint (endpoint identity), but the mutable maxConcurrency/priorityPolicy
// do not (request §4/§20).
function transportConcurrencyKey(
    transportId: IllustrationPromptTransportId,
    endpoint: string,
): string {
    return `${transportId}:${endpoint}`
}

async function finalizeTarget(
    descriptor: PromptTargetExecutionDescriptor,
    queue: { policyRevision: string; maxConcurrency: number; priorityPolicy: 'interactive-first' | 'fifo' },
): Promise<IllustrationPromptTargetV2> {
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
        subjectSlots: {
            ...descriptor.subjectSlots,
            pipeSerialization: descriptor.subjectSlots.pipeSerialization
                ? { ...descriptor.subjectSlots.pipeSerialization }
                : null,
        },
        measurement: {
            ...descriptor.measurement,
            documentedTransportLimit: descriptor.measurement.documentedTransportLimit
                ? { ...descriptor.measurement.documentedTransportLimit }
                : null,
        },
        queue: {
            concurrencyKey: descriptor.concurrencyKey,
            policyRevision: queue.policyRevision,
            maxConcurrency: queue.maxConcurrency,
            priorityPolicy: queue.priorityPolicy,
        },
    }
}

export async function resolveNaiCompatibleFlatTarget(
    db: PromptTargetDatabase,
    election: IllustrationNaiCompatibleFlatElection,
): Promise<IllustrationPromptTargetV2> {
    const endpoint = requireEndpoint(db.NAIImgUrl ?? DEFAULT_NAI_ENDPOINT, 'nai-compatible-flat', true)
    const pipeSerialization: IllustrationPromptPipeSerialization | null =
        election.layout === 'pipe-slots' && election.pipe
            ? {
                revision: election.pipe.revision,
                separator: ' | ',
                positive: 'base-then-subjects',
                negative: election.pipe.negative,
                rejectLiteralSeparator: true,
            }
            : null
    const subjectSlots: IllustrationPromptSubjectSlots =
        election.layout === 'pipe-slots' && election.pipe
            ? {
                maxSubjects: election.pipe.maxSubjects,
                positive: 'exact-scene-subjects',
                negative: election.pipe.negative === 'base-then-subjects' ? 'match-positive' : 'empty',
                allowEmptyPositive: false,
                allowEmptyNegative: true,
                pipeSerialization,
            }
            : {
                maxSubjects: 0,
                positive: 'empty',
                negative: 'empty',
                allowEmptyPositive: false,
                allowEmptyNegative: true,
                pipeSerialization: null,
            }
    const flags = electionAllowFlags(election.measurement)
    const descriptor: PromptTargetExecutionDescriptor = {
        schemaVersion: 2,
        providerId: 'novelai',
        transportId: 'nai-compatible-flat',
        endpoint,
        modelId: db.NAIImgModel ?? DEFAULT_NAI_MODEL,
        checkpointFingerprint: null,
        workflowFingerprint: null,
        bindingMode: 'opaque-remote',
        bindingRevision: null,
        acceptedLayouts: [election.layout],
        negativeChannel: 'separate',
        textPreservation: 'exact',
        subjectSlots,
        measurement: measurementDescriptorFromElection(election.measurement),
        allowTransportOnly: flags.allowTransportOnly,
        allowUnmeasured: flags.allowUnmeasured,
        concurrencyKey: transportConcurrencyKey('nai-compatible-flat', endpoint),
    }
    return await finalizeTarget(descriptor, {
        policyRevision: NAI_COMPATIBLE_FLAT_QUEUE_POLICY_REVISION,
        maxConcurrency: election.maxConcurrency,
        priorityPolicy: election.priorityPolicy,
    })
}

const FLAT_SUBJECT_SLOTS: IllustrationPromptSubjectSlots = Object.freeze({
    maxSubjects: 0,
    positive: 'empty',
    negative: 'empty',
    allowEmptyPositive: false,
    allowEmptyNegative: true,
    pipeSerialization: null,
})

export async function resolveWebuiFlatTarget(
    db: PromptTargetDatabase,
    election: IllustrationWebuiFlatElection,
): Promise<IllustrationPromptTargetV2> {
    const endpoint = requireEndpoint(db.webUiUrl, 'webui-flat', false)
    const checkpointFingerprint =
        election.binding.mode === 'request-pinned'
            ? await sha256Hex(`webui-request-pinned:${election.binding.checkpoint}`)
            : election.binding.checkpointFingerprint
    const flags = electionAllowFlags(election.measurement)
    const descriptor: PromptTargetExecutionDescriptor = {
        schemaVersion: 2,
        providerId: 'webui',
        transportId: 'webui-flat',
        endpoint,
        modelId: null,
        checkpointFingerprint,
        workflowFingerprint: null,
        bindingMode: election.binding.mode,
        bindingRevision: null,
        acceptedLayouts: ['flat'],
        negativeChannel: 'separate',
        textPreservation: 'exact',
        subjectSlots: { ...FLAT_SUBJECT_SLOTS },
        measurement: measurementDescriptorFromElection(election.measurement),
        allowTransportOnly: flags.allowTransportOnly,
        allowUnmeasured: flags.allowUnmeasured,
        concurrencyKey: transportConcurrencyKey('webui-flat', endpoint),
    }
    return await finalizeTarget(descriptor, {
        policyRevision: WEBUI_FLAT_QUEUE_POLICY_REVISION,
        maxConcurrency: election.maxConcurrency,
        priorityPolicy: election.priorityPolicy,
    })
}

export async function resolveComfyuiFlatTarget(
    db: PromptTargetDatabase,
    election: IllustrationComfyuiFlatElection,
): Promise<IllustrationPromptTargetV2> {
    const endpoint = requireEndpoint(db.comfyUiUrl, 'comfyui-flat', false)
    const flags = electionAllowFlags(election.measurement)
    const descriptor: PromptTargetExecutionDescriptor = {
        schemaVersion: 2,
        providerId: db.sdProvider ?? 'comfyui',
        transportId: 'comfyui-flat',
        endpoint,
        modelId: null,
        checkpointFingerprint: null,
        workflowFingerprint: election.workflowFingerprint,
        bindingMode: 'workflow-pinned',
        bindingRevision: election.modelBindingRevision,
        acceptedLayouts: ['flat'],
        negativeChannel: 'separate',
        textPreservation: 'exact',
        subjectSlots: { ...FLAT_SUBJECT_SLOTS },
        measurement: measurementDescriptorFromElection(election.measurement),
        allowTransportOnly: flags.allowTransportOnly,
        allowUnmeasured: flags.allowUnmeasured,
        concurrencyKey: transportConcurrencyKey('comfyui-flat', endpoint),
    }
    return await finalizeTarget(descriptor, {
        policyRevision: COMFYUI_FLAT_QUEUE_POLICY_REVISION,
        maxConcurrency: election.maxConcurrency,
        priorityPolicy: election.priorityPolicy,
    })
}

async function resolveElectedTarget(
    db: PromptTargetDatabase,
    election: IllustrationTransportElection,
): Promise<IllustrationPromptTargetV2> {
    const provider = db.sdProvider ?? ''
    requireCompatibleProvider(election.transportId, provider)
    switch (election.transportId) {
        case 'nai-compatible-flat':
            return await resolveNaiCompatibleFlatTarget(db, election)
        case 'webui-flat':
            return await resolveWebuiFlatTarget(db, election)
        case 'comfyui-flat':
            return await resolveComfyuiFlatTarget(db, election)
    }
}

// Resolve the durable target for the CURRENTLY configured provider. A non-native
// transport election (when present) is authoritative and never inferred; without
// an election only 'novelai' + a V4 model resolves (novelai-native). Everything
// else fails closed with a typed preparation failure (request §2/§4/§7).
export async function resolvePromptTargetV2(
    db: PromptTargetDatabase,
    transportConfig: IllustrationTransportConfigV1 | null = null,
): Promise<IllustrationPromptTargetV2> {
    const election = transportConfig?.election ?? null
    if (election) return await resolveElectedTarget(db, election)

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
            'this transport requires an explicit Plugin transport election before it can resolve',
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

// Re-resolve the target from the CURRENT database + transport config and confirm
// its fingerprint still matches the value captured at prepare time. Used before any
// provider dispatch so a post-capture endpoint/model/checkpoint/workflow change (or
// a dropped/altered election) fails closed (request §4/§10-6/§10-7). Any resolution
// failure (unavailable transport, incompatible provider) is a definite mismatch,
// never a silent pass. Queue tuning alone never changes the fingerprint (§20).
export async function targetFingerprintMatchesCurrentDb(
    db: PromptTargetDatabase,
    expectedFingerprint: string,
    transportConfig: IllustrationTransportConfigV1 | null = null,
): Promise<boolean> {
    let current: IllustrationPromptTargetV2
    try {
        current = await resolvePromptTargetV2(db, transportConfig)
    } catch {
        return false
    }
    return current.targetFingerprint === expectedFingerprint
}
