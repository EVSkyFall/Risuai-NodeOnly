import { IllustrationPromptV2ContractError } from './errors'
import {
    MAX_ILLUSTRATION_OPAQUE_REF_LENGTH,
    type IllustrationPromptContextV2,
    type IllustrationPromptLayout,
    type IllustrationPromptTargetV2,
} from './promptContextV2'
import { sha256Hex } from './sourceHash'

// ---------------------------------------------------------------------------
// Provider-neutral Illustration Prompt Envelope V2 (request §5).
//
// The envelope is the Plugin's FINAL compiled prompt. Core treats every tag
// string as an OPAQUE render token: it is never trimmed, Unicode-normalized,
// split, deduped, reordered, reweighted, filtered, or truncated (request §4/§5).
// Validation is structural + layout-aware only; a provider that cannot honor a
// structure or a negative channel fails closed BEFORE any LLM/provider call
// rather than silently flattening or dropping content.
// ---------------------------------------------------------------------------

export const PROMPT_ENVELOPE_SCHEMA_VERSION = 2 as const
export const MAX_ILLUSTRATION_ENVELOPE_BYTES = 16 * 1024
// A transport-agnostic structural ceiling on subject-slot count. The exact,
// transport-specific cap (e.g. novelai-native's 6) is enforced against the
// resolved target in validateEnvelopeAgainstTarget; this ceiling only rejects
// pathological arrays before that binding step. It never truncates.
export const MAX_ILLUSTRATION_ENVELOPE_SUBJECTS = 64

const PIPE_SEPARATOR = ' | '

export type IllustrationPromptEnvelopeV2 = {
    schemaVersion: 2
    tagProfileId: string
    tagProfileRevision: string
    profileConfigRevision: string
    assetCatalogDigest: string
    layout: IllustrationPromptLayout
    basePositive: string
    subjectPositives: string[]
    baseNegative: string
    subjectNegatives: string[]
}

const envelopeKeys = new Set<keyof IllustrationPromptEnvelopeV2>([
    'schemaVersion',
    'tagProfileId',
    'tagProfileRevision',
    'profileConfigRevision',
    'assetCatalogDigest',
    'layout',
    'basePositive',
    'subjectPositives',
    'baseNegative',
    'subjectNegatives',
])

const encoder = new TextEncoder()

function invalidEnvelope(message: string): never {
    throw new IllustrationPromptV2ContractError('prompt_envelope_invalid', message)
}

function utf8PartBytes(parts: readonly string[]): number {
    return parts.reduce((total, part) => total + encoder.encode(part).byteLength, 0)
}

// A bounded non-empty opaque envelope ref. Same bounds as prepare's opaque refs,
// but envelope-field failures uniformly carry 'prompt_envelope_invalid'. The
// value is stored verbatim — never trimmed or normalized.
function envelopeRef(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        invalidEnvelope(`${label} must be a non-empty string`)
    }
    if (value.length > MAX_ILLUSTRATION_OPAQUE_REF_LENGTH) {
        invalidEnvelope(`${label} must be at most ${MAX_ILLUSTRATION_OPAQUE_REF_LENGTH} code units`)
    }
    return value
}

// A dense array of plain string data properties (rejecting sparse arrays and
// getter/accessor entries), mirroring imagePrompt.ts's assertStringArray so an
// opaque tag can never be smuggled in via a lazily-evaluated accessor.
function assertDenseStringArray(value: unknown, label: string): asserts value is string[] {
    if (!Array.isArray(value)) invalidEnvelope(`${label} must be an array of strings`)
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index)
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') {
            invalidEnvelope(`${label} must be a dense array of strings`)
        }
    }
    if (value.length > MAX_ILLUSTRATION_ENVELOPE_SUBJECTS) {
        invalidEnvelope(`${label} may contain at most ${MAX_ILLUSTRATION_ENVELOPE_SUBJECTS} entries`)
    }
}

export function parseIllustrationPromptEnvelopeV2(value: unknown): IllustrationPromptEnvelopeV2 {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        invalidEnvelope('envelope must be an object')
    }
    const input = value as Record<string, unknown>
    const inputKeys = Object.keys(input)
    if (
        inputKeys.length !== envelopeKeys.size
        || inputKeys.some((key) => !envelopeKeys.has(key as keyof IllustrationPromptEnvelopeV2))
        || [...envelopeKeys].some((key) => !Object.hasOwn(input, key))
    ) {
        invalidEnvelope('envelope must contain exactly the IllustrationPromptEnvelopeV2 fields')
    }
    for (const key of envelopeKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
            invalidEnvelope('envelope fields must be plain data properties')
        }
    }
    if (input.schemaVersion !== PROMPT_ENVELOPE_SCHEMA_VERSION) {
        invalidEnvelope('envelope.schemaVersion must be 2')
    }
    // Opaque bounded non-empty refs. Core stores them verbatim and never parses them.
    const tagProfileId = envelopeRef(input.tagProfileId, 'envelope.tagProfileId')
    const tagProfileRevision = envelopeRef(input.tagProfileRevision, 'envelope.tagProfileRevision')
    const profileConfigRevision = envelopeRef(input.profileConfigRevision, 'envelope.profileConfigRevision')
    const assetCatalogDigest = envelopeRef(input.assetCatalogDigest, 'envelope.assetCatalogDigest')

    if (
        input.layout !== 'flat'
        && input.layout !== 'native-character-slots'
        && input.layout !== 'pipe-slots'
    ) {
        invalidEnvelope('envelope.layout is invalid')
    }
    if (typeof input.basePositive !== 'string') invalidEnvelope('envelope.basePositive must be a string')
    if (typeof input.baseNegative !== 'string') invalidEnvelope('envelope.baseNegative must be a string')
    assertDenseStringArray(input.subjectPositives, 'envelope.subjectPositives')
    assertDenseStringArray(input.subjectNegatives, 'envelope.subjectNegatives')

    if (input.layout === 'flat'
        && (input.subjectPositives.length !== 0 || input.subjectNegatives.length !== 0)) {
        invalidEnvelope('flat envelopes require empty subject arrays')
    }
    if (input.subjectPositives.length !== input.subjectNegatives.length) {
        invalidEnvelope('positive and negative subject arrays must have equal cardinality')
    }

    // Byte caps are applied per side over the base + every subject caption. This
    // is a rejection ceiling, never a truncation (request §4).
    const envelope: IllustrationPromptEnvelopeV2 = {
        schemaVersion: PROMPT_ENVELOPE_SCHEMA_VERSION,
        tagProfileId,
        tagProfileRevision,
        profileConfigRevision,
        assetCatalogDigest,
        layout: input.layout,
        basePositive: input.basePositive,
        subjectPositives: [...input.subjectPositives],
        baseNegative: input.baseNegative,
        subjectNegatives: [...input.subjectNegatives],
    }
    if (utf8PartBytes([envelope.basePositive, ...envelope.subjectPositives]) > MAX_ILLUSTRATION_ENVELOPE_BYTES) {
        invalidEnvelope('positive envelope parts must total at most 16 KiB UTF-8')
    }
    if (utf8PartBytes([envelope.baseNegative, ...envelope.subjectNegatives]) > MAX_ILLUSTRATION_ENVELOPE_BYTES) {
        invalidEnvelope('negative envelope parts must total at most 16 KiB UTF-8')
    }
    return envelope
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

// The envelope hash covers every string, array order, profile/config/catalog ref,
// and layout (request §5). Array order is preserved by canonicalJson (only object
// keys are sorted), so a subject reordering yields a different hash.
export async function computeEnvelopeHash(envelope: IllustrationPromptEnvelopeV2): Promise<string> {
    return sha256Hex(canonicalJson(envelope))
}

// The envelope's opaque refs must match the turn's prepared PromptContext snapshot
// (request §4: every job/envelope ref must equal the captured snapshot).
export function assertEnvelopeMatchesContext(
    envelope: IllustrationPromptEnvelopeV2,
    context: IllustrationPromptContextV2,
): void {
    if (
        envelope.tagProfileId !== context.tagProfile.id
        || envelope.tagProfileRevision !== context.tagProfile.revision
        || envelope.profileConfigRevision !== context.profileConfigRevision
        || envelope.assetCatalogDigest !== context.assetCatalogDigest
    ) {
        throw new IllustrationPromptV2ContractError(
            'prompt_envelope_invalid',
            'The envelope profile/config/catalog refs do not match the prepared prompt context',
        )
    }
}

// A part carrying the literal pipe separator would be ambiguous once Core joins
// with ' | '. The Plugin rejects this with position info and Core repeats the
// exact check immediately before serialization (request §5). We never modify the
// text — we reject it.
export function assertNoLiteralSeparatorConflict(
    parts: readonly string[],
    label: string,
): void {
    for (let index = 0; index < parts.length; index += 1) {
        const at = parts[index].indexOf('|')
        if (at !== -1) {
            throw new IllustrationPromptV2ContractError(
                'prompt_pipe_conflict',
                `${label}[${index}] contains a literal pipe at code-unit offset ${at}, which collides with the "${PIPE_SEPARATOR}" separator`,
            )
        }
    }
}

// Bind a parsed envelope to a resolved target: layout acceptance, subject
// cardinality/max, empty-slot policy, and negative-channel support. Every failure
// is a definite pre-dispatch rejection (request §5/§8). pipe-slots is validated
// but its serialization is deferred to Slice E, so an accepted pipe layout still
// fails closed here.
export function validateEnvelopeAgainstTarget(
    envelope: IllustrationPromptEnvelopeV2,
    target: IllustrationPromptTargetV2,
): void {
    if (!target.acceptedLayouts.includes(envelope.layout)) {
        throw new IllustrationPromptV2ContractError(
            'prompt_layout_unsupported',
            `Target transport "${target.transportId}" does not accept the "${envelope.layout}" layout`,
        )
    }

    const hasNegativeContent = envelope.baseNegative.length > 0
        || envelope.subjectNegatives.some((part) => part.length > 0)
    if (target.negativeChannel === 'unsupported' && hasNegativeContent) {
        throw new IllustrationPromptV2ContractError(
            'prompt_negative_channel_unsupported',
            `Target transport "${target.transportId}" has no negative channel; negative content must be rejected before dispatch`,
        )
    }

    const slots = target.subjectSlots
    if (envelope.subjectPositives.length > slots.maxSubjects) {
        invalidEnvelope(
            `Target transport "${target.transportId}" accepts at most ${slots.maxSubjects} subjects`,
        )
    }
    if (!slots.allowEmptyPositive && envelope.basePositive.length === 0) {
        invalidEnvelope('Target requires a non-empty base positive prompt')
    }
    if (!slots.allowEmptyNegative && envelope.baseNegative.length === 0) {
        invalidEnvelope('Target requires a non-empty base negative prompt')
    }

    if (envelope.layout === 'pipe-slots') {
        const pipe = slots.pipeSerialization
        if (!pipe) {
            // A target that accepts the pipe-slots layout but declares no pipe
            // serialization contract cannot serialize it — fail closed.
            throw new IllustrationPromptV2ContractError(
                'prompt_pipe_serialization_unsupported',
                `Target transport "${target.transportId}" accepts pipe-slots but declares no pipe serialization contract`,
            )
        }
        // Repeat the literal-separator conflict check Core owes before serializing
        // (request §5): Plugin rejected it earlier, Core re-validates with position.
        assertNoLiteralSeparatorConflict(
            [envelope.basePositive, ...envelope.subjectPositives],
            'positive',
        )
        if (pipe.negative === 'base-only') {
            // base-only negative serialization only emits baseNegative. Subject-level
            // negative CONTENT would be silently dropped, so reject it instead of
            // dropping (request §4: no silent drop).
            for (let index = 0; index < envelope.subjectNegatives.length; index += 1) {
                if (envelope.subjectNegatives[index].length > 0) {
                    throw new IllustrationPromptV2ContractError(
                        'prompt_negative_channel_unsupported',
                        `Target transport "${target.transportId}" serializes a base-only negative; subjectNegatives[${index}] carries content that would be dropped`,
                    )
                }
            }
            assertNoLiteralSeparatorConflict([envelope.baseNegative], 'negative')
        } else {
            assertNoLiteralSeparatorConflict(
                [envelope.baseNegative, ...envelope.subjectNegatives],
                'negative',
            )
        }
    }
}

// The exact pipe join contract (request §5): positive is base-then-subjects; the
// negative follows the target's declared mode. Every part is code-unit exact —
// we never trim, reorder, or normalize; a literal separator inside any part has
// already been rejected by validateEnvelopeAgainstTarget/assertNoLiteralSeparatorConflict.
function joinPipe(parts: readonly string[]): string {
    return parts.join(PIPE_SEPARATOR)
}

export type SerializedTransportText = {
    positive: string
    negative: string
}

// Serialize a validated envelope into the exact positive/negative transport text
// for a flat or pipe-slots target. Call validateEnvelopeAgainstTarget first — this
// re-runs the literal-separator guard defensively but assumes cardinality/layout
// were already enforced. native-character-slots has no flat text serialization
// (its structured captions are transported directly), so it is rejected here.
export function serializeEnvelopeForTransport(
    envelope: IllustrationPromptEnvelopeV2,
    target: IllustrationPromptTargetV2,
): SerializedTransportText {
    if (envelope.layout === 'flat') {
        return { positive: envelope.basePositive, negative: envelope.baseNegative }
    }
    if (envelope.layout === 'pipe-slots') {
        const pipe = target.subjectSlots.pipeSerialization
        if (!pipe) {
            throw new IllustrationPromptV2ContractError(
                'prompt_pipe_serialization_unsupported',
                `Target transport "${target.transportId}" declares no pipe serialization contract`,
            )
        }
        const positiveParts = [envelope.basePositive, ...envelope.subjectPositives]
        assertNoLiteralSeparatorConflict(positiveParts, 'positive')
        const positive = joinPipe(positiveParts)
        let negative: string
        if (pipe.negative === 'base-only') {
            assertNoLiteralSeparatorConflict([envelope.baseNegative], 'negative')
            negative = envelope.baseNegative
        } else {
            const negativeParts = [envelope.baseNegative, ...envelope.subjectNegatives]
            assertNoLiteralSeparatorConflict(negativeParts, 'negative')
            negative = joinPipe(negativeParts)
        }
        return { positive, negative }
    }
    throw new IllustrationPromptV2ContractError(
        'prompt_layout_unsupported',
        `The "${envelope.layout}" layout has no flat/pipe text serialization`,
    )
}
