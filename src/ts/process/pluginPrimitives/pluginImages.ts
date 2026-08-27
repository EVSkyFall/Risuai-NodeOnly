// Generic, illustration-agnostic image surface for V3 plugins.
//
// This is the one primitive a pure plugin genuinely cannot build for itself:
// everything else it needs (plugin-scoped atomic storage, the configured LLM,
// chat read/write) already has a generic V3 API, but there is no way for a
// plugin to run the user's configured image provider and land the result as a
// native inlay. Both halves live in the core already — `generateAIImageTyped`
// and `writeInlayImage` — so this module is a boundary, not a new subsystem.
//
// It deliberately owns no illustration concepts: no jobs, no coordinator, no
// markers, no scheduling. A caller hands over a finished prompt and gets back
// an inlay asset id.
//
// Paid operations answer with a status envelope rather than throwing. The
// sandbox boundary only carries `err.message`, and a plugin must be able to
// tell "the provider definitely did not run" from "we cannot tell whether it
// ran" without parsing prose — the second case must never be auto-retried.

import { getDatabase } from 'src/ts/storage/database.svelte'
import type { character } from 'src/ts/storage/database.svelte'
import { getCurrentCharacter } from 'src/ts/storage/database.svelte'
import { generateAIImageTyped, type ImageGenerationAttempt, type ImageGenerationResult } from '../stableDiff'
import {
    getInlayAsset,
    getInlayAssetBlobFromStorage,
    getInlayInfosBatch,
    removeInlayAsset,
    writeInlayImage,
    writeInlayImageBytes,
} from '../files/inlays'
import type { PluginAtomicSandboxApi } from './pluginAtomic'
import { INSTALL_ID_PATTERN } from 'src/ts/plugins/pluginInstallId'
import { parseIllustrationPromptV1 } from '../illustrationJobs/imagePrompt'
import {
    evaluateImagePromptLimits,
    isNaiV5ImageModel,
    measureImagePrompt,
} from '../illustrationJobs/imagePromptMeasurement'
import {
    canonicalizeNaiSettings,
    computeCanonicalNaiSettingsFingerprint,
} from '../illustrationJobs/settingsFingerprint'
import type { IllustrationPromptV1 } from '../illustrationJobs/types'

// ── wire types ──────────────────────────────────────────────────────────────

export interface PluginImagePromptCharacter {
    name?: string
    positive: string
    negative?: string
    center?: { x: number; y: number }
}

export interface PluginImagePromptInput {
    layout: 'flat' | 'nai-v4-characters'
    positive: string
    negative?: string
    dialect?: string
    characters?: PluginImagePromptCharacter[]
}

export interface PluginImageMeasurement {
    /** False when no exact tokenizer exists for the configured provider. */
    exact: boolean
    /** Effective measured units; V5 reports the pooled count. Null only when unavailable. */
    units: number | null
    /** Effective budget; V5 reports the pooled limit. Null when no budget is known. */
    limit: number | null
    withinLimits: boolean
    accepted: boolean
    /** Opaque digest of the image configuration this measurement was taken against. */
    configRevision: string
    provider: string
    model: string
    /**
     * Whether the configured provider's dispatch actually consumes per-character
     * captions. Everything else silently drops them, which would send a picture
     * with no subjects in it, so callers must ask before choosing that shape.
     */
    supportsRegional: boolean
    tokenizer: string | null
    detail: {
        positiveTokens: number | null
        negativeTokens: number | null
        maxPositiveTokens: number | null
        maxNegativeTokens: number | null
    }
    /** Present only when `exact` is false: why exact measurement was unavailable. */
    reason?: string
}

export interface PluginImageGenerateInput {
    operationKey: string
    prompt: PluginImagePromptInput
    expectedConfigRevision?: string
    seed?: number
    output: {
        kind: 'inlay'
        assetId: string
        metadata?: Record<string, unknown>
    }
}

export type PluginImageGenerateResult =
    | {
        status: 'succeeded'
        result: {
            assetId: string
            inlayToken: string
            provider: string
            model: string
            configRevision: string
            seedSupported: boolean
            seedUsed: number | null
        }
    }
    | { status: 'precondition_failed'; error: string; code: string }
    | { status: 'definite_failure'; error: string; code: string }
    | { status: 'ambiguous'; error: string; code: string }

export interface PluginInlayRemoveInput {
    operationKey: string
    assetId: string
}

export type PluginInlayRemoveResult =
    | { status: 'succeeded' }
    | { status: 'definite_failure'; error: string; code: string }

export interface PluginInlayReadInput {
    assetId: string
}

// Reading is free and local, but it answers with the same envelope family as
// the rest of this surface so a sandbox caller handles one shape, not two.
export type PluginInlayReadResult =
    | {
        status: 'succeeded'
        result: {
            assetId: string
            /** Always a browser-ready data: URL, whatever shape storage held. */
            dataUrl: string
            ext: string
            name: string
            width?: number
            height?: number
        }
    }
    | { status: 'definite_failure'; error: string; code: string }

export interface PluginInlayPutImageInput {
    operationKey: string
    dataUrl: string
}

export type PluginInlayMediaKind = 'image' | 'video' | 'audio'

export type PluginInlayPutMediaInput = PluginInlayPutImageInput

export type PluginInlayPutImageResult =
    | { status: 'succeeded'; result: { assetId: string } }
    | { status: 'precondition_failed'; code: string; error: string }
    | { status: 'definite_failure'; code: string; error: string }
    | { status: 'ambiguous'; code: string; error: string }

export type PluginInlayPutMediaResult = PluginInlayPutImageResult

export class PluginImageError extends Error {
    readonly code: string
    constructor(code: string, message: string) {
        super(message)
        this.name = 'PluginImageError'
        this.code = code
    }
}

// ── configuration fingerprint ───────────────────────────────────────────────
// A change to any of these between `measurePrompt` and `generateToInlay` means
// the measurement no longer describes the request that would be sent.
//
// Credentials are excluded on purpose. Rotating an API key changes neither the
// prompt nor the model, so it must not invalidate a measurement that is still
// accurate — and a fence that trips on key rotation would strand paid work.
const IMAGE_CONFIG_KEYS = Object.freeze([
    'sdProvider',
    'webUiUrl', 'sdConfig', 'sdSteps', 'sdCFG',
    'NAIImgConfig', 'NAIImgModel', 'NAIImgUrl', 'NAII2I',
    'comfyConfig', 'comfyUiUrl',
    'dallEQuality',
    'stabilityModel', 'stabllityStyle',
    'falModel', 'falLora', 'falLoraScale',
    'ImagenModel', 'ImagenAspectRatio', 'ImagenImageSize', 'ImagenPersonGeneration',
    'openaiCompatImage', 'wavespeedImage',
] as const)

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize)
    if (value && typeof value === 'object') {
        const source = value as Record<string, unknown>
        const out: Record<string, unknown> = {}
        for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key])
        return out
    }
    return value
}

async function sha256Hex(text: string): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256BytesHex(bytes: Uint8Array): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource)
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

// Only these dispatch branches read illustrationPrompt.characterPositives.
// Legacy 'comfy' writes into a single configured node and never sees them.
const REGIONAL_PROVIDERS = Object.freeze(new Set(['novelai', 'comfyui']))

/** Which model string identifies the configured provider's model, if any. */
function configuredModel(db: Record<string, any>): string {
    switch (db.sdProvider) {
        case 'novelai': return String(db.NAIImgModel ?? '')
        case 'stability': return String(db.stabilityModel ?? '')
        case 'fal': return String(db.falModel ?? '')
        case 'Imagen': return String(db.ImagenModel ?? '')
        case 'openai-compat': return String(db.openaiCompatImage?.model ?? '')
        case 'wavespeed': return String(db.wavespeedImage?.model ?? '')
        default: return ''
    }
}

// ── prompt translation ──────────────────────────────────────────────────────

function toIllustrationPrompt(input: PluginImagePromptInput): IllustrationPromptV1 {
    if (!input || typeof input !== 'object') {
        throw new PluginImageError('image_prompt_invalid', 'prompt must be an object')
    }
    const characters = Array.isArray(input.characters) ? input.characters : []
    // Per-character placement is regional prompting. It is forwarded, never
    // dropped: silently discarding a placement would change the picture that
    // was asked for. When no character carries one the field is omitted
    // entirely, so an unplaced request stays byte-identical to before.
    const placed = characters.some((character) => (
        character && typeof character === 'object' && character.center !== undefined && character.center !== null
    ))
    const named = characters.some((character) => (
        character && typeof character === 'object' && Object.hasOwn(character, 'name')
    ))
    return parseIllustrationPromptV1({
        schemaVersion: 1,
        layout: input.layout,
        basePositive: String(input.positive ?? ''),
        baseNegative: String(input.negative ?? ''),
        characterPositives: characters.map((character) => String(character?.positive ?? '')),
        characterNegatives: characters.map((character) => String(character?.negative ?? '')),
        ...(named
            ? { characterNames: characters.map((character) => character?.name ?? '') }
            : {}),
        ...(placed
            ? { characterCenters: characters.map((character) => character?.center ?? null) }
            : {}),
    })
}

// ── dependencies ────────────────────────────────────────────────────────────

export interface PluginImagesDependencies {
    getDatabase(): Record<string, any>
    getCurrentCharacter(): character
    generateImage(
        positive: string,
        currentChar: character,
        negative: string,
        prompt: IllustrationPromptV1,
        seed?: number,
    ): Promise<ImageGenerationAttempt>
    /**
     * Exact token measurement, or a throw when the configured provider has no
     * exact tokenizer. Implementations compute whatever fingerprint their
     * measurement backend requires; it is not the generic configRevision.
     */
    measure(prompt: IllustrationPromptV1): Promise<{
        positiveTokens: number
        negativeTokens: number
        maxPositiveTokens: number
        maxNegativeTokens: number
        model: string
        tokenizer: string
    }>
    writeInlay(dataUrl: string, assetId: string): Promise<string>
    removeInlay(assetId: string): Promise<void>
    readInlay(assetId: string): Promise<{
        data: string
        ext: string
        name: string
        type: string
        width?: number
        height?: number
    } | null>
    putImage?: {
        installId?: string
        atomic?: Pick<PluginAtomicSandboxApi, 'read' | 'cas'>
        inspectInlay(assetId: string): Promise<{
            asset: {
                data: Blob
                ext: string
                name: string
                type: string
            } | null
            info: {
                ext: string
                name: string
                type: string
            } | null
        }>
        writeInlayBytes(bytes: Uint8Array, input: {
            assetId: string
            ext: string
            mimeType: string
            name: string
            type: PluginInlayMediaKind
        }): Promise<string>
    }
}

export interface PluginImagesApi {
    measurePrompt(input: { prompt: PluginImagePromptInput }): Promise<PluginImageMeasurement>
    generateToInlay(input: PluginImageGenerateInput): Promise<PluginImageGenerateResult>
}

export interface PluginInlaysApi {
    putImage(input: PluginInlayPutImageInput): Promise<PluginInlayPutImageResult>
    putMedia(input: PluginInlayPutMediaInput): Promise<PluginInlayPutMediaResult>
    remove(input: PluginInlayRemoveInput): Promise<PluginInlayRemoveResult>
    read(input: PluginInlayReadInput): Promise<PluginInlayReadResult>
}

const PUT_IMAGE_EXT_BY_MIME: Readonly<Record<string, string>> = Object.freeze({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
})
// putMedia's superset. Aliases normalize onto the canonical MIME the inlay
// storage and the Comfy input sidecar both speak.
const PUT_MEDIA_EXT_BY_MIME: Readonly<Record<string, string>> = Object.freeze({
    ...PUT_IMAGE_EXT_BY_MIME,
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
})
const PUT_MEDIA_CANONICAL_MIME: Readonly<Record<string, string>> = Object.freeze({
    'image/jpg': 'image/jpeg',
    'audio/mp3': 'audio/mpeg',
    'audio/x-wav': 'audio/wav',
    'audio/wave': 'audio/wav',
})
const PUT_IMAGE_RECEIPT_VERSION = 1 as const
// putImage and putMedia share one claim record, so a single operationKey can
// only ever name one payload no matter which method wrote it first. The legacy
// path segment is load-bearing: receipts already live under it.
const PUT_CLAIM_KEY_PREFIX = '__risu_internal__/pluginInlays/putImage/'

type DecodedPluginImage = {
    bytes: Uint8Array
    ext: string
    mimeType: string
    mediaType: PluginInlayMediaKind
}

type PluginInlayPutClaim = {
    schemaVersion: typeof PUT_IMAGE_RECEIPT_VERSION
    operationHash: string
    byteHash: string
    assetId: string
    ext: string
    mimeType: string
    /**
     * Absent means image. putImage keeps writing receipts without the field, so
     * a receipt written before putMedia existed still reads back as its own.
     */
    type?: 'video' | 'audio'
}

type PutClaimResolution =
    | { ok: true, claim: PluginInlayPutClaim }
    | { ok: false, result: PluginInlayPutImageResult }

function decodeBase64ImagePayload(payload: string): Uint8Array {
    const compact = payload.replace(/[\t\n\f\r ]/g, '')
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
        throw new PluginImageError('inlay_data_url_decode_failed', 'image data URL has invalid base64 characters')
    }
    const firstPadding = compact.indexOf('=')
    if (firstPadding !== -1) {
        const paddingLength = compact.length - firstPadding
        if (paddingLength > 2 || compact.length % 4 !== 0) {
            throw new PluginImageError('inlay_data_url_decode_failed', 'image data URL has invalid base64 padding')
        }
    } else if (compact.length % 4 === 1) {
        throw new PluginImageError('inlay_data_url_decode_failed', 'image data URL has invalid base64 length')
    }

    let binary: string
    try {
        binary = atob(compact)
    } catch (error) {
        throw new PluginImageError(
            'inlay_data_url_decode_failed',
            `image data URL could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
        )
    }
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
}

function decodePercentImagePayload(payload: string): Uint8Array {
    const bytes: number[] = []
    for (let i = 0; i < payload.length; i++) {
        const code = payload.charCodeAt(i)
        if (code === 0x25) {
            const hex = payload.slice(i + 1, i + 3)
            if (hex.length !== 2 || !/^[0-9a-f]{2}$/i.test(hex)) {
                throw new PluginImageError('inlay_data_url_decode_failed', 'image data URL has invalid percent encoding')
            }
            bytes.push(Number.parseInt(hex, 16))
            i += 2
            continue
        }
        if (code > 0x7f) {
            throw new PluginImageError(
                'inlay_data_url_decode_failed',
                'non-ASCII image data URL octets must be percent encoded',
            )
        }
        bytes.push(code)
    }
    return Uint8Array.from(bytes)
}

function decodePluginImageDataUrl(
    dataUrl: unknown,
    extByMime: Readonly<Record<string, string>> = PUT_IMAGE_EXT_BY_MIME,
): DecodedPluginImage {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
        throw new PluginImageError('inlay_data_url_invalid', 'dataUrl must be an image data URL')
    }
    const comma = dataUrl.indexOf(',')
    if (comma < 5) {
        throw new PluginImageError('inlay_data_url_invalid', 'image data URL is malformed')
    }
    const fields = dataUrl.slice(5, comma).split(';')
    const declaredMime = String(fields.shift() ?? '').trim().toLowerCase()
    const ext = extByMime[declaredMime]
    if (!ext) {
        throw new PluginImageError(
            'inlay_image_mime_unsupported',
            `dataUrl must declare a canonical ${
                extByMime === PUT_IMAGE_EXT_BY_MIME ? 'image' : 'image, video, or audio'
            } MIME type`,
        )
    }
    const mimeType = PUT_MEDIA_CANONICAL_MIME[declaredMime] ?? declaredMime
    const mediaType = mimeType.slice(0, mimeType.indexOf('/')) as PluginInlayMediaKind
    const base64 = fields.some(field => field.trim().toLowerCase() === 'base64')
    const payload = dataUrl.slice(comma + 1)
    const bytes = base64
        ? decodeBase64ImagePayload(payload)
        : decodePercentImagePayload(payload)
    if (bytes.length === 0) {
        throw new PluginImageError('inlay_image_data_empty', 'image data URL decodes to no bytes')
    }
    return { bytes, ext, mimeType, mediaType }
}

function preconditionFailure(code: string, error: string): PluginInlayPutImageResult {
    return { status: 'precondition_failed', code, error }
}

function ambiguousFailure(code: string, error: string): PluginInlayPutImageResult {
    return { status: 'ambiguous', code, error }
}

function claimMediaType(claim: { type?: unknown }): PluginInlayMediaKind {
    return claim.type === 'video' || claim.type === 'audio' ? claim.type : 'image'
}

function resolveStoredPutClaim(value: unknown, expected: PluginInlayPutClaim): PutClaimResolution {
    if (!value || typeof value !== 'object') {
        return {
            ok: false,
            result: {
                status: 'definite_failure',
                code: 'inlay_receipt_invalid',
                error: 'the durable putImage receipt is malformed',
            },
        }
    }
    const stored = value as Record<string, unknown>
    if (stored.schemaVersion !== PUT_IMAGE_RECEIPT_VERSION
        || stored.operationHash !== expected.operationHash
        || typeof stored.assetId !== 'string'
        || typeof stored.byteHash !== 'string'
        || typeof stored.ext !== 'string'
        || typeof stored.mimeType !== 'string'
        || (stored.type !== undefined && stored.type !== 'video' && stored.type !== 'audio')) {
        return {
            ok: false,
            result: {
                status: 'definite_failure',
                code: 'inlay_receipt_invalid',
                error: 'the durable putImage receipt is malformed',
            },
        }
    }
    if (stored.assetId !== expected.assetId) {
        return {
            ok: false,
            result: {
                status: 'definite_failure',
                code: 'inlay_receipt_invalid',
                error: 'the durable putImage receipt points to an unexpected asset',
            },
        }
    }
    if (stored.byteHash !== expected.byteHash
        || stored.ext !== expected.ext
        || stored.mimeType !== expected.mimeType
        || claimMediaType(stored) !== claimMediaType(expected)) {
        return {
            ok: false,
            result: preconditionFailure(
                'inlay_operation_key_reused',
                'operationKey was already used with different image bytes or media metadata',
            ),
        }
    }
    return { ok: true, claim: stored as unknown as PluginInlayPutClaim }
}

function atomicPutFailure(failure: any): PluginInlayPutImageResult {
    if (failure?.code === 'PLUGIN_ATOMIC_NO_INSTALL_ID') {
        return preconditionFailure('inlay_install_id_unavailable', 'plugin installation identity is unavailable')
    }
    if (failure?.code === 'PLUGIN_ATOMIC_RECEIPT_MISMATCH') {
        return preconditionFailure(
            'inlay_operation_key_reused',
            'operationKey was already used with different image bytes or media metadata',
        )
    }
    if (failure?.code === 'PLUGIN_ATOMIC_BAD_KEY'
        || failure?.code === 'PLUGIN_ATOMIC_BAD_REQUEST'
        || failure?.code === 'PLUGIN_ATOMIC_VALUE_TOO_LARGE') {
        return {
            status: 'definite_failure',
            code: failure.code,
            error: failure?.message || 'the durable putImage receipt request was rejected',
        }
    }
    return ambiguousFailure(
        'inlay_receipt_state_uncertain',
        failure?.message || 'the durable putImage receipt state could not be determined',
    )
}

async function claimPluginInlayPut(
    put: NonNullable<PluginImagesDependencies['putImage']>,
    expected: PluginInlayPutClaim,
    recordKey: string,
    atomicOperationKey: string,
): Promise<PutClaimResolution> {
    const atomic = put.atomic!
    let record: any
    try {
        record = await atomic.read(recordKey)
    } catch (error) {
        return {
            ok: false,
            result: ambiguousFailure(
                'inlay_receipt_state_uncertain',
                error instanceof Error ? error.message : String(error),
            ),
        }
    }
    if (record?.ok !== true) return { ok: false, result: atomicPutFailure(record) }
    if (record.value !== null && record.value !== undefined && record.deleted !== true) {
        return resolveStoredPutClaim(record.value, expected)
    }
    if (record.revision !== 0 || record.deleted === true) {
        return {
            ok: false,
            result: {
                status: 'definite_failure',
                code: 'inlay_receipt_invalid',
                error: 'the durable putImage receipt record is unexpectedly empty',
            },
        }
    }

    let claimed: any
    try {
        claimed = await atomic.cas({
            key: recordKey,
            value: expected,
            operationKey: atomicOperationKey,
            expectedRevision: 0,
        })
    } catch (error) {
        return {
            ok: false,
            result: ambiguousFailure(
                'inlay_receipt_state_uncertain',
                error instanceof Error ? error.message : String(error),
            ),
        }
    }
    if (claimed?.ok === true) return { ok: true, claim: expected }
    if (claimed?.code !== 'PLUGIN_ATOMIC_CONFLICT') {
        return { ok: false, result: atomicPutFailure(claimed) }
    }

    try {
        const winner: any = await atomic.read(recordKey)
        if (winner?.ok !== true) return { ok: false, result: atomicPutFailure(winner) }
        if (winner.value === null || winner.value === undefined || winner.deleted === true) {
            return {
                ok: false,
                result: ambiguousFailure(
                    'inlay_receipt_state_uncertain',
                    'a concurrent putImage claim did not publish a readable receipt',
                ),
            }
        }
        return resolveStoredPutClaim(winner.value, expected)
    } catch (error) {
        return {
            ok: false,
            result: ambiguousFailure(
                'inlay_receipt_state_uncertain',
                error instanceof Error ? error.message : String(error),
            ),
        }
    }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) return false
    for (let i = 0; i < left.length; i++) {
        if (left[i] !== right[i]) return false
    }
    return true
}

async function isCompleteClaimedInlay(
    put: NonNullable<PluginImagesDependencies['putImage']>,
    claim: PluginInlayPutClaim,
    decoded: DecodedPluginImage,
): Promise<boolean> {
    const state = await put.inspectInlay(claim.assetId)
    const asset = state.asset
    const info = state.info
    const mediaType = claimMediaType(claim)
    if (!asset || !info || !(asset.data instanceof Blob)) return false
    if (asset.type !== mediaType
        || asset.ext !== claim.ext
        || asset.name !== claim.assetId
        || asset.data.type !== claim.mimeType
        || info.type !== mediaType
        || info.ext !== claim.ext
        || info.name !== claim.assetId) {
        return false
    }
    const storedBytes = new Uint8Array(await asset.data.arrayBuffer())
    return equalBytes(storedBytes, decoded.bytes)
}

async function materializeClaimedInlay(
    put: NonNullable<PluginImagesDependencies['putImage']>,
    claim: PluginInlayPutClaim,
    decoded: DecodedPluginImage,
): Promise<PluginInlayPutImageResult> {
    try {
        if (await isCompleteClaimedInlay(put, claim, decoded)) {
            return { status: 'succeeded', result: { assetId: claim.assetId } }
        }
    } catch {
        // The claim owns this deterministic id, so a repair write remains safe.
    }

    let writeError: unknown = null
    try {
        await put.writeInlayBytes(decoded.bytes, {
            assetId: claim.assetId,
            ext: claim.ext,
            mimeType: claim.mimeType,
            name: claim.assetId,
            type: claimMediaType(claim),
        })
    } catch (error) {
        writeError = error
    }

    try {
        if (await isCompleteClaimedInlay(put, claim, decoded)) {
            return { status: 'succeeded', result: { assetId: claim.assetId } }
        }
    } catch (error) {
        if (writeError === null) writeError = error
    }
    return ambiguousFailure(
        'inlay_write_uncertain',
        `the canonical inlay pair could not be verified: ${
            writeError instanceof Error ? writeError.message : String(writeError ?? 'incomplete payload or sidecar')
        }`,
    )
}

async function runPluginInlayPut(
    deps: PluginImagesDependencies,
    method: 'putImage' | 'putMedia',
    input: PluginInlayPutImageInput,
): Promise<PluginInlayPutImageResult> {
    let operationKey: string
    let decoded: DecodedPluginImage
    try {
        operationKey = typeof input?.operationKey === 'string' ? input.operationKey : ''
        if (!operationKey) {
            throw new PluginImageError(
                'inlay_operation_key_invalid',
                'operationKey must be a non-empty string',
            )
        }
        decoded = decodePluginImageDataUrl(
            input?.dataUrl,
            method === 'putMedia' ? PUT_MEDIA_EXT_BY_MIME : PUT_IMAGE_EXT_BY_MIME,
        )
    } catch (error) {
        return {
            status: 'definite_failure',
            code: error instanceof PluginImageError ? error.code : 'inlay_data_url_invalid',
            error: error instanceof Error ? error.message : String(error),
        }
    }

    const put = deps.putImage
    const installId = put?.installId
    if (!put || !put.atomic
        || typeof installId !== 'string'
        || !INSTALL_ID_PATTERN.test(installId)) {
        return preconditionFailure(
            'inlay_install_id_unavailable',
            'plugin installation identity or durable receipt storage is unavailable',
        )
    }

    let operationHash: string
    let byteHash: string
    let assetId: string
    try {
        [operationHash, byteHash, assetId] = await Promise.all([
            sha256Hex(operationKey),
            sha256BytesHex(decoded.bytes),
            sha256Hex(`${installId}\u0000${operationKey}`).then(hash => `plugin-inlay-${hash}`),
        ])
    } catch (error) {
        return preconditionFailure(
            'inlay_digest_unavailable',
            error instanceof Error ? error.message : String(error),
        )
    }

    const expected: PluginInlayPutClaim = {
        schemaVersion: PUT_IMAGE_RECEIPT_VERSION,
        operationHash,
        byteHash,
        assetId,
        ext: decoded.ext,
        mimeType: decoded.mimeType,
        ...(decoded.mediaType === 'image' ? {} : { type: decoded.mediaType }),
    }
    const recordKey = `${PUT_CLAIM_KEY_PREFIX}${operationHash}`
    const atomicOperationKey = `risu:pluginInlays.${method}:${installId}:${operationHash}`

    try {
        const resolution = await claimPluginInlayPut(put, expected, recordKey, atomicOperationKey)
        if (resolution.ok !== true) {
            return (resolution as Extract<PutClaimResolution, { ok: false }>).result
        }
        return await materializeClaimedInlay(put, resolution.claim, decoded)
    } catch (error) {
        return ambiguousFailure(
            'inlay_put_uncertain',
            error instanceof Error ? error.message : String(error),
        )
    }
}

export function createPluginImagesApi(deps: PluginImagesDependencies): PluginImagesApi & PluginInlaysApi {
    async function currentConfigRevision(): Promise<string> {
        const db = deps.getDatabase()
        const projection: Record<string, unknown> = {}
        for (const key of IMAGE_CONFIG_KEYS) projection[key] = canonicalize(db[key])
        return await sha256Hex(JSON.stringify(projection))
    }

    return {
        async measurePrompt(input) {
            const prompt = toIllustrationPrompt(input?.prompt)
            const db = deps.getDatabase()
            const provider = String(db.sdProvider ?? '')
            const model = configuredModel(db)
            const configRevision = await currentConfigRevision()

            try {
                const measured = await deps.measure(prompt)
                const effectiveModel = measured.model || model
                const limitEvaluation = evaluateImagePromptLimits({
                    ...measured,
                    model: effectiveModel,
                })
                const approximate = provider === 'novelai' && isNaiV5ImageModel(effectiveModel)
                return {
                    exact: !approximate,
                    units: limitEvaluation.pooled
                        ? limitEvaluation.combinedTokens
                        : measured.positiveTokens,
                    limit: limitEvaluation.pooled
                        ? limitEvaluation.combinedLimit
                        : measured.maxPositiveTokens,
                    withinLimits: limitEvaluation.withinLimits,
                    accepted: limitEvaluation.withinLimits,
                    configRevision,
                    provider,
                    supportsRegional: REGIONAL_PROVIDERS.has(provider),
                    model: effectiveModel,
                    tokenizer: measured.tokenizer,
                    detail: {
                        positiveTokens: measured.positiveTokens,
                        negativeTokens: measured.negativeTokens,
                        maxPositiveTokens: measured.maxPositiveTokens,
                        maxNegativeTokens: measured.maxNegativeTokens,
                    },
                    ...(approximate
                        ? {
                            reason: 'NovelAI V5 measurement uses the T5 approximation because the exact Qwen-family tokenizer is unavailable.',
                        }
                        : {}),
                }
            } catch (error) {
                // No exact tokenizer for this provider. Report that plainly
                // rather than inventing a budget: asserting a limit we cannot
                // compute would reject prompts the provider would have taken.
                return {
                    exact: false,
                    units: null,
                    limit: null,
                    withinLimits: true,
                    accepted: true,
                    configRevision,
                    provider,
                    supportsRegional: REGIONAL_PROVIDERS.has(provider),
                    model,
                    tokenizer: null,
                    detail: {
                        positiveTokens: null,
                        negativeTokens: null,
                        maxPositiveTokens: null,
                        maxNegativeTokens: null,
                    },
                    reason: error instanceof Error ? error.message : String(error),
                }
            }
        },

        async generateToInlay(input) {
            let prompt: IllustrationPromptV1
            let assetId: string
            try {
                if (input?.output?.kind !== 'inlay') {
                    throw new PluginImageError('image_output_unsupported', 'output.kind must be "inlay"')
                }
                assetId = String(input.output.assetId ?? '')
                // The id becomes an inlay key and is interpolated into
                // `{{inlay::<id>}}`, so it must not carry template characters.
                if (!assetId || /[{}\r\n:]/.test(assetId)) {
                    throw new PluginImageError('image_asset_id_invalid', 'output.assetId is missing or malformed')
                }
                if (typeof input.operationKey !== 'string' || !input.operationKey) {
                    throw new PluginImageError('image_operation_key_invalid', 'operationKey must be a non-empty string')
                }
                if (input.seed !== undefined
                    && (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > Number.MAX_SAFE_INTEGER)) {
                    throw new PluginImageError(
                        'image_seed_invalid',
                        `seed must be an integer between 0 and ${Number.MAX_SAFE_INTEGER}`,
                    )
                }
                prompt = toIllustrationPrompt(input.prompt)
            } catch (error) {
                // Nothing was dispatched, so this is unambiguously terminal.
                return {
                    status: 'definite_failure',
                    error: error instanceof Error ? error.message : String(error),
                    code: error instanceof PluginImageError ? error.code : 'image_request_invalid',
                }
            }

            const configRevision = await currentConfigRevision()
            if (input.expectedConfigRevision && input.expectedConfigRevision !== configRevision) {
                return {
                    status: 'precondition_failed',
                    error: 'the image configuration changed after the prompt was measured',
                    code: 'image_config_revision_mismatch',
                }
            }

            const db = deps.getDatabase()
            const provider = String(db.sdProvider ?? '')
            const model = configuredModel(db)

            let attempt: ImageGenerationAttempt
            try {
                attempt = await deps.generateImage(
                    prompt.basePositive,
                    deps.getCurrentCharacter(),
                    prompt.baseNegative,
                    prompt,
                    input.seed,
                )
            } catch (error) {
                // A throw out of the dispatch path gives no evidence about
                // whether the provider ran. Never report this as terminal.
                return {
                    status: 'ambiguous',
                    error: error instanceof Error ? error.message : String(error),
                    code: 'image_dispatch_uncertain',
                }
            }

            const outcome = attempt.result
            if (!outcome.ok) {
                // `strict` is off in this project, which weakens discriminated
                // union narrowing; name the failure member explicitly.
                const failure = outcome as Extract<ImageGenerationResult, { ok: false }>
                const uncertain = failure.certainty !== 'definite'
                return {
                    status: uncertain ? 'ambiguous' : 'definite_failure',
                    error: failure.reason || 'image generation failed',
                    code: uncertain ? 'image_dispatch_uncertain' : failure.code ?? 'image_generation_failed',
                }
            }

            const dataUrl = outcome.bytesOrDataUrl
            if (typeof dataUrl !== 'string' || !dataUrl) {
                return {
                    status: 'definite_failure',
                    error: 'the provider returned no image data',
                    code: 'image_result_empty',
                }
            }

            try {
                const written = await deps.writeInlay(dataUrl, assetId)
                return {
                    status: 'succeeded',
                    result: {
                        assetId: written,
                        inlayToken: `{{inlay::${written}}}`,
                        provider,
                        model,
                        configRevision,
                        seedSupported: attempt.seedSupported === true,
                        seedUsed: attempt.seedSupported === true
                            ? (Number.isInteger(attempt.seedUsed)
                                && Number(attempt.seedUsed) >= 0
                                && Number(attempt.seedUsed) <= Number.MAX_SAFE_INTEGER
                                ? Number(attempt.seedUsed)
                                : input.seed ?? null)
                            : null,
                    },
                }
            } catch (error) {
                // The image was paid for and produced but could not be stored.
                // Say so precisely: retrying costs money again, and the caller
                // needs to decide that, not us.
                return {
                    status: 'ambiguous',
                    error: `the image was generated but could not be stored: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                    code: 'inlay_write_failed',
                }
            }
        },

        async putImage(input) {
            return await runPluginInlayPut(deps, 'putImage', input)
        },

        async putMedia(input) {
            return await runPluginInlayPut(deps, 'putMedia', input)
        },

        async remove(input) {
            const assetId = String(input?.assetId ?? '')
            if (!assetId) {
                return { status: 'definite_failure', error: 'assetId must be a non-empty string', code: 'inlay_asset_id_invalid' }
            }
            try {
                await deps.removeInlay(assetId)
                return { status: 'succeeded' }
            } catch (error) {
                return {
                    status: 'definite_failure',
                    error: error instanceof Error ? error.message : String(error),
                    code: 'inlay_remove_failed',
                }
            }
        },

        async read(input) {
            const assetId = String(input?.assetId ?? '')
            if (!assetId) {
                return { status: 'definite_failure', error: 'assetId must be a non-empty string', code: 'inlay_asset_id_invalid' }
            }
            let asset: Awaited<ReturnType<PluginImagesDependencies['readInlay']>>
            try {
                asset = await deps.readInlay(assetId)
            } catch (error) {
                return {
                    status: 'definite_failure',
                    error: error instanceof Error ? error.message : String(error),
                    code: 'inlay_read_failed',
                }
            }
            if (!asset) {
                return { status: 'definite_failure', error: 'no inlay asset exists with this id', code: 'inlay_not_found' }
            }
            if (asset.type !== 'image') {
                return { status: 'definite_failure', error: `the inlay is ${asset.type}, not an image`, code: 'inlay_not_image' }
            }
            const data = String(asset.data ?? '')
            if (!data) {
                return { status: 'definite_failure', error: 'the inlay asset holds no data', code: 'inlay_data_empty' }
            }
            // Storage hands back either a full data: URL (assets that lived as
            // Blobs) or a bare base64 string (assets that lived as strings).
            // The caller gets one shape regardless.
            const dataUrl = data.startsWith('data:')
                ? data
                : `data:image/${asset.ext || 'png'};base64,${data}`
            return {
                status: 'succeeded',
                result: {
                    assetId,
                    dataUrl,
                    ext: asset.ext || '',
                    name: asset.name || '',
                    ...(Number.isFinite(asset.width) ? { width: Number(asset.width) } : {}),
                    ...(Number.isFinite(asset.height) ? { height: Number(asset.height) } : {}),
                },
            }
        },
    }
}

// ── default wiring ──────────────────────────────────────────────────────────

export const defaultPluginImagesDependencies: PluginImagesDependencies = {
    getDatabase: () => getDatabase() as unknown as Record<string, any>,
    getCurrentCharacter: () => getCurrentCharacter({ snapshot: true }) as character,
    generateImage: (positive, currentChar, negative, prompt, seed) => generateAIImageTyped(
        positive,
        currentChar,
        negative,
        'inlay',
        'interactive',
        // The prompt is already final: the plugin owns its dialect, and
        // rewriting a user's parentheses or wrapper syntax here would change
        // what they asked for.
        { preservePromptText: true, illustrationPrompt: prompt, ...(seed === undefined ? {} : { seed }) },
    ),
    // measureImagePrompt fences on the NAI settings fingerprint, which is a
    // different digest from the generic configRevision this module reports.
    // Compute it here so the fence still catches a settings change racing the
    // measurement, instead of mismatching on every call and silently
    // downgrading every provider to "no exact measurement".
    measure: async (prompt) => await measureImagePrompt({
        protocolVersion: 1,
        settingsFingerprint: await computeCanonicalNaiSettingsFingerprint(
            canonicalizeNaiSettings(getDatabase() as any),
        ),
        prompt,
    }) as any,
    writeInlay: async (dataUrl, assetId) => {
        const image = new Image()
        image.src = dataUrl
        return await writeInlayImage(image, { id: assetId, name: assetId })
    },
    removeInlay: async (assetId) => { await removeInlayAsset(assetId) },
    readInlay: async (assetId) => await getInlayAsset(assetId),
}

export interface DefaultPluginImagesApiOptions {
    installId?: string
    atomic?: Pick<PluginAtomicSandboxApi, 'read' | 'cas'>
}

export function createDefaultPluginImagesApi(
    options: DefaultPluginImagesApiOptions = {},
): PluginImagesApi & PluginInlaysApi {
    return createPluginImagesApi({
        ...defaultPluginImagesDependencies,
        putImage: {
            installId: options.installId,
            atomic: options.atomic,
            inspectInlay: async (assetId) => {
                const infos = await getInlayInfosBatch([assetId])
                const asset = await getInlayAssetBlobFromStorage(assetId)
                return { asset, info: infos[assetId] ?? null }
            },
            writeInlayBytes: async (bytes, input) => await writeInlayImageBytes(bytes, {
                id: input.assetId,
                ext: input.ext,
                mimeType: input.mimeType,
                name: input.name,
                type: input.type,
            }),
        },
    })
}
