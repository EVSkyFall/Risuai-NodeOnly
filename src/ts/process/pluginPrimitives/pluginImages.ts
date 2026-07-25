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
import { removeInlayAsset, writeInlayImage } from '../files/inlays'
import { parseIllustrationPromptV1 } from '../illustrationJobs/imagePrompt'
import { measureImagePrompt } from '../illustrationJobs/imagePromptMeasurement'
import {
    canonicalizeNaiSettings,
    computeCanonicalNaiSettingsFingerprint,
} from '../illustrationJobs/settingsFingerprint'
import type { IllustrationPromptV1 } from '../illustrationJobs/types'

// ── wire types ──────────────────────────────────────────────────────────────

export interface PluginImagePromptCharacter {
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
    /** Positive-side token count, or null when `exact` is false. */
    units: number | null
    /** Positive-side budget, or null when no budget is known. */
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
    return parseIllustrationPromptV1({
        schemaVersion: 1,
        layout: input.layout,
        basePositive: String(input.positive ?? ''),
        baseNegative: String(input.negative ?? ''),
        characterPositives: characters.map((character) => String(character?.positive ?? '')),
        characterNegatives: characters.map((character) => String(character?.negative ?? '')),
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
}

export interface PluginImagesApi {
    measurePrompt(input: { prompt: PluginImagePromptInput }): Promise<PluginImageMeasurement>
    generateToInlay(input: PluginImageGenerateInput): Promise<PluginImageGenerateResult>
}

export interface PluginInlaysApi {
    remove(input: PluginInlayRemoveInput): Promise<PluginInlayRemoveResult>
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
                const withinLimits = measured.positiveTokens <= measured.maxPositiveTokens
                    && measured.negativeTokens <= measured.maxNegativeTokens
                return {
                    exact: true,
                    units: measured.positiveTokens,
                    limit: measured.maxPositiveTokens,
                    withinLimits,
                    accepted: withinLimits,
                    configRevision,
                    provider,
                    supportsRegional: REGIONAL_PROVIDERS.has(provider),
                    model: measured.model || model,
                    tokenizer: measured.tokenizer,
                    detail: {
                        positiveTokens: measured.positiveTokens,
                        negativeTokens: measured.negativeTokens,
                        maxPositiveTokens: measured.maxPositiveTokens,
                        maxNegativeTokens: measured.maxNegativeTokens,
                    },
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
                    code: uncertain ? 'image_dispatch_uncertain' : 'image_generation_failed',
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
    }
}

// ── default wiring ──────────────────────────────────────────────────────────

export const defaultPluginImagesDependencies: PluginImagesDependencies = {
    getDatabase: () => getDatabase() as unknown as Record<string, any>,
    getCurrentCharacter: () => getCurrentCharacter({ snapshot: true }) as character,
    generateImage: (positive, currentChar, negative, prompt) => generateAIImageTyped(
        positive,
        currentChar,
        negative,
        'inlay',
        'interactive',
        // The prompt is already final: the plugin owns its dialect, and
        // rewriting a user's parentheses or wrapper syntax here would change
        // what they asked for.
        { preservePromptText: true, illustrationPrompt: prompt },
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
}

export function createDefaultPluginImagesApi(): PluginImagesApi & PluginInlaysApi {
    return createPluginImagesApi(defaultPluginImagesDependencies)
}
