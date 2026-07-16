import { getDatabase } from '../../storage/database.svelte'
import { IllustrationImagePromptContractError } from './errors'
import { parseIllustrationPromptV1 } from './imagePrompt'
import {
    canonicalizeNaiSettings,
    computeCanonicalNaiSettingsFingerprint,
    serializeCanonicalNaiSettings,
    type NaiSettingsFingerprintDatabase,
} from './settingsFingerprint'
import type {
    IllustrationImagePromptMeasurementV1,
    IllustrationImagePromptOverLimitPayloadV1,
    IllustrationPromptV1,
} from './types'

export const IMAGE_PROMPT_TOKENIZER_ID = 't5-spiece-v1' as const
export const IMAGE_PROMPT_TOKENIZER_ASSET_URL = '/token/t5/spiece.model'

// NovelAI documents an approximately 512-T5-token combined budget over the
// base and all character prompts for V4/V4.5. This contract pins 512 per side:
// https://docs.novelai.net/en/image/models/
export const NAI_V4_IMAGE_PROMPT_LIMITS = Object.freeze({
    maxPositiveTokens: 512,
    maxNegativeTokens: 512,
} as const)

export type ImagePromptTokenizer = {
    encode(text: string): { readonly length: number }
}

export type ImagePromptTokenizerLoader = {
    load(): Promise<ImagePromptTokenizer>
    getLastFailure(): unknown
}

export type ImagePromptTokenizerLoaderDependencies = {
    loadModel(): Promise<ArrayBuffer>
    createTokenizer?(model: ArrayBuffer): Promise<ImagePromptTokenizer>
}

async function createSentencePieceTokenizer(model: ArrayBuffer): Promise<ImagePromptTokenizer> {
    const webTokenizer = await import('@mlc-ai/web-tokenizers')
    return await webTokenizer.Tokenizer.fromSentencePiece(model)
}

export function createImagePromptTokenizerLoader(
    dependencies: ImagePromptTokenizerLoaderDependencies,
): ImagePromptTokenizerLoader {
    let cached: ImagePromptTokenizer | undefined
    let inFlight: Promise<ImagePromptTokenizer> | undefined
    let lastFailure: unknown

    return {
        async load(): Promise<ImagePromptTokenizer> {
            if (cached) return cached
            const attempt = inFlight ?? (async () => {
                const model = await dependencies.loadModel()
                return await (dependencies.createTokenizer ?? createSentencePieceTokenizer)(model)
            })()
            inFlight = attempt
            try {
                cached = await attempt
                lastFailure = undefined
                return cached
            } catch (error) {
                lastFailure = error
                throw error
            } finally {
                if (inFlight === attempt) inFlight = undefined
            }
        },
        getLastFailure: () => lastFailure,
    }
}

async function fetchImagePromptTokenizerModel(): Promise<ArrayBuffer> {
    const response = await fetch(IMAGE_PROMPT_TOKENIZER_ASSET_URL)
    if (!response.ok) throw new Error(`Tokenizer asset returned HTTP ${response.status}`)
    return await response.arrayBuffer()
}

export type ImagePromptMeasurementSettings = {
    provider: string
    model: string
}

export type MeasureImagePromptInputV1 = {
    protocolVersion: 1
    settingsFingerprint: string
    prompt: IllustrationPromptV1
}

export type ImagePromptMeasurementService = {
    resolveSettings(settingsFingerprint: string): Promise<ImagePromptMeasurementSettings>
    measure(input: MeasureImagePromptInputV1): Promise<IllustrationImagePromptMeasurementV1>
}

export type ImagePromptMeasurementDependencies = {
    getDatabase(): NaiSettingsFingerprintDatabase
    tokenizerLoader: ImagePromptTokenizerLoader
}

function invalidMeasurementInput(message: string): never {
    throw new IllustrationImagePromptContractError('image_prompt_invalid', message)
}

export function isNaiV4ImageModel(model: string): boolean {
    return model.startsWith('nai-diffusion-4')
}

export function createImagePromptMeasurementService(
    dependencies: ImagePromptMeasurementDependencies,
): ImagePromptMeasurementService {
    const resolveSettings = async (
        settingsFingerprint: string,
    ): Promise<ImagePromptMeasurementSettings> => {
        if (typeof settingsFingerprint !== 'string' || settingsFingerprint.length === 0) {
            invalidMeasurementInput('settingsFingerprint must be a non-empty string')
        }
        const database = dependencies.getDatabase()
        const capturedSettings = canonicalizeNaiSettings(database)
        const serializedSettings = serializeCanonicalNaiSettings(capturedSettings)
        const currentFingerprint = await computeCanonicalNaiSettingsFingerprint(capturedSettings)
        // The database is live and mutable. Verify that the synchronous
        // canonical snapshot did not change while WebCrypto was hashing it.
        if (serializeCanonicalNaiSettings(canonicalizeNaiSettings(dependencies.getDatabase()))
            !== serializedSettings) {
            throw new IllustrationImagePromptContractError(
                'settings_fingerprint_mismatch',
                'The image settings changed while their fingerprint was being verified',
            )
        }
        if (currentFingerprint !== settingsFingerprint) {
            throw new IllustrationImagePromptContractError(
                'settings_fingerprint_mismatch',
                'The image settings fingerprint no longer matches the captured job settings',
            )
        }
        return {
            provider: capturedSettings.provider,
            model: capturedSettings.model,
        }
    }

    return {
        resolveSettings,
        async measure(input): Promise<IllustrationImagePromptMeasurementV1> {
            if (!input || typeof input !== 'object' || input.protocolVersion !== 1) {
                invalidMeasurementInput('protocolVersion must be 1')
            }
            const prompt = parseIllustrationPromptV1(input.prompt)
            const initialSettings = await resolveSettings(input.settingsFingerprint)
            if (initialSettings.provider !== 'novelai'
                || !isNaiV4ImageModel(initialSettings.model)) {
                throw new IllustrationImagePromptContractError(
                    'image_prompt_measurement_unsupported',
                    'Exact image prompt measurement is supported only for NovelAI V4 models',
                )
            }

            let tokenizer: ImagePromptTokenizer
            try {
                tokenizer = await dependencies.tokenizerLoader.load()
            } catch {
                throw new IllustrationImagePromptContractError(
                    'image_tokenizer_unavailable',
                    'The exact image prompt tokenizer is unavailable',
                )
            }

            // Loading the asset/WASM may await. Re-resolve after the cold path so
            // a settings change during initialization still fails closed.
            const settings = await resolveSettings(input.settingsFingerprint)
            if (settings.provider !== 'novelai' || !isNaiV4ImageModel(settings.model)) {
                throw new IllustrationImagePromptContractError(
                    'image_prompt_measurement_unsupported',
                    'Exact image prompt measurement is supported only for NovelAI V4 models',
                )
            }

            try {
                // The provider transports these as independent captions. Tokenize
                // each transported part separately, then sum the exact lengths.
                const positiveTokens = [prompt.basePositive, ...prompt.characterPositives]
                    .reduce((total, part) => total + tokenizer.encode(part).length, 0)
                const negativeTokens = [prompt.baseNegative, ...prompt.characterNegatives]
                    .reduce((total, part) => total + tokenizer.encode(part).length, 0)
                return {
                    model: settings.model,
                    tokenizer: IMAGE_PROMPT_TOKENIZER_ID,
                    positiveTokens,
                    negativeTokens,
                    ...NAI_V4_IMAGE_PROMPT_LIMITS,
                }
            } catch {
                throw new IllustrationImagePromptContractError(
                    'image_tokenizer_unavailable',
                    'The exact image prompt tokenizer is unavailable',
                )
            }
        },
    }
}

const defaultTokenizerLoader = createImagePromptTokenizerLoader({
    loadModel: fetchImagePromptTokenizerModel,
})
const defaultMeasurementService = createImagePromptMeasurementService({
    getDatabase,
    tokenizerLoader: defaultTokenizerLoader,
})
let activeMeasurementService = defaultMeasurementService

export function setImagePromptMeasurementServiceForTests(
    service: ImagePromptMeasurementService,
): () => void {
    const previous = activeMeasurementService
    activeMeasurementService = service
    return () => {
        activeMeasurementService = previous
    }
}

export async function resolveImagePromptMeasurementSettings(
    settingsFingerprint: string,
): Promise<ImagePromptMeasurementSettings> {
    return await activeMeasurementService.resolveSettings(settingsFingerprint)
}

export async function measureImagePrompt(
    input: MeasureImagePromptInputV1,
): Promise<IllustrationImagePromptMeasurementV1> {
    return await activeMeasurementService.measure(input)
}

export function assertImagePromptWithinLimits(
    measurement: IllustrationImagePromptMeasurementV1,
): void {
    if (measurement.positiveTokens <= measurement.maxPositiveTokens
        && measurement.negativeTokens <= measurement.maxNegativeTokens) return
    const payload: IllustrationImagePromptOverLimitPayloadV1 = {
        positiveTokens: measurement.positiveTokens,
        negativeTokens: measurement.negativeTokens,
        maxPositiveTokens: measurement.maxPositiveTokens,
        maxNegativeTokens: measurement.maxNegativeTokens,
        model: measurement.model,
    }
    throw new IllustrationImagePromptContractError(
        'image_prompt_over_limit',
        'The final image prompt exceeds the model token budget',
        payload,
    )
}

export async function measureAndEnforceImagePrompt(
    input: MeasureImagePromptInputV1,
): Promise<IllustrationImagePromptMeasurementV1> {
    const measurement = await measureImagePrompt(input)
    assertImagePromptWithinLimits(measurement)
    return measurement
}

export async function measureAndEnforceImagePromptForDispatch(
    input: MeasureImagePromptInputV1,
    options: { requireNovelAiProvider?: boolean } = {},
): Promise<IllustrationImagePromptMeasurementV1 | null> {
    const prompt = parseIllustrationPromptV1(input.prompt)
    const settings = await resolveImagePromptMeasurementSettings(input.settingsFingerprint)
    if (prompt.layout === 'flat') {
        if (settings.provider !== 'novelai') {
            if (options.requireNovelAiProvider) {
                throw new IllustrationImagePromptContractError(
                    'image_prompt_measurement_unsupported',
                    'Illustration dispatch requires the NovelAI provider',
                )
            }
            return null
        }
        if (!isNaiV4ImageModel(settings.model)) return null
    } else if (settings.provider !== 'novelai' || !isNaiV4ImageModel(settings.model)) {
        throw new IllustrationImagePromptContractError(
            'image_prompt_measurement_unsupported',
            'NAI V4 character prompts require a NovelAI V4 model',
        )
    }
    return await measureAndEnforceImagePrompt({ ...input, prompt })
}
