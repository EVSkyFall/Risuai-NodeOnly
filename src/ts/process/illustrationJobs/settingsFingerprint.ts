import type { Database, NAIImgConfig } from '../../storage/database.svelte'
import { sha256Hex } from './sourceHash'

export const NAI_SETTINGS_FINGERPRINT_SCHEMA_VERSION = 1
export const DEFAULT_NAI_MODEL = 'nai-diffusion-4-5-full'

export type NaiSettingsFingerprintDatabase = Pick<
    Database,
    'sdProvider' | 'NAIImgUrl' | 'NAIImgModel' | 'NAII2I' | 'NAIImgConfig'
>

type NaiConfigLike = NAIImgConfig & Record<string, unknown>

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
        .join(',')}}`
}

export type CanonicalNaiSettings = ReturnType<typeof canonicalizeNaiSettings>

export function serializeCanonicalNaiSettings(settings: CanonicalNaiSettings): string {
    return canonicalJson(settings)
}

type NaiModelFamilyKey =
    | 'v4full'
    | 'v4curated'
    | 'v4-5full'
    | 'v4-5curated'
    | 'v5full'
    | 'v5curated'
    | ''

function naiModelFamilyKey(model: string): NaiModelFamilyKey {
    if (model.includes('nai-diffusion-4-full')) return 'v4full'
    if (model.includes('nai-diffusion-4-curated')) return 'v4curated'
    if (model.includes('nai-diffusion-4-5-full')) return 'v4-5full'
    if (model.includes('nai-diffusion-4-5-curated')) return 'v4-5curated'
    if (model.includes('nai-diffusion-5-full')) return 'v5full'
    if (model.includes('nai-diffusion-5-curated')) return 'v5curated'
    return ''
}

function fallbackVibeModel(model: string): string {
    const family = naiModelFamilyKey(model)
    return family === 'v4full'
        || family === 'v4curated'
        || family === 'v4-5full'
        || family === 'v4-5curated'
        ? family
        : ''
}

function resolveConfiguredVibeEncoding(model: string, config: NaiConfigLike): {
    modelKey: string
    encoding: string
} {
    const vibeData = config.vibe_data
    const modelKey = config.vibe_model_selection || fallbackVibeModel(model)
    if (!vibeData || !modelKey) return { modelKey, encoding: '' }

    const encodings = vibeData.encodings?.[modelKey]
    if (!encodings) return { modelKey, encoding: '' }

    // Preserve stableDiff.ts selection semantics: fallback selection uses the
    // first stored key, while an explicit model selection searches by info.
    const keys = Object.keys(encodings)
    const informationExtracted = config.InfoExtracted || 1
    const encodingKey = config.vibe_model_selection
        ? keys.find((key) => encodings[key].params.information_extracted === informationExtracted)
        : keys[0]

    return {
        modelKey,
        encoding: encodingKey ? encodings[encodingKey].encoding : '',
    }
}

export function canonicalizeNaiSettings(db: NaiSettingsFingerprintDatabase) {
    const config = db.NAIImgConfig as NaiConfigLike
    const model = db.NAIImgModel ?? DEFAULT_NAI_MODEL
    const usesV5Wire = model.startsWith('nai-diffusion-5')
    const vibe = usesV5Wire ? undefined : resolveConfiguredVibeEncoding(model, config)

    return {
        schemaVersion: NAI_SETTINGS_FINGERPRINT_SCHEMA_VERSION,

        // §10.2 provider + NAI model; endpoint is a provider-specific dispatch option.
        provider: db.sdProvider ?? '',
        endpoint: db.NAIImgUrl ?? 'https://image.novelai.net/ai/generate-image',
        model,

        // §10.2 width/height, sampler, steps, CFG, and seed policy.
        generation: {
            width: config.width ?? 1024,
            height: config.height ?? 1024,
            sampler: config.sampler ?? 'k_euler_ancestral',
            steps: config.steps ?? 28,
            cfgScale: config.scale ?? 5,
            cfgRescale: config.cfg_rescale ?? 0,
            seedPolicy: {
                seed: 'random-u32-per-request',
                extraNoiseSeed: 'independent-random-u32-per-request',
            },
        },

        // §10.2 negative preset. V4 keeps its fixed numeric preset plus DB
        // legacy UC; V5 fingerprints the string preset IDs and integer hints
        // that stableDiff actually sends, with legacy UC absent.
        negativePreset: usesV5Wire
            ? {
                ucPresetId: 'none',
                qualityPresetId: 'none',
                tagHintQt: 0,
                tagHintUcPreset: 0,
            }
            : {
                ucPreset: 3,
                legacyUc: config.legacy_uc ?? false,
            },

        // §10.2 provider-specific NAI options read by stableDiff.ts.
        providerOptions: usesV5Wire
            ? {
                noiseSchedule: config.noise_schedule ?? 'karras',
            }
            : {
                noiseSchedule: config.noise_schedule ?? 'karras',
                smea: config.sm ?? true,
                smeaDynamic: config.sm_dyn ?? false,
                decrisp: config.decrisp ?? false,
                varietyPlus: config.variety_plus ?? false,
            },

        // §10.2 img2img/reference-image settings. Empty image ids use the
        // current character at dispatch; the sentinel records that policy.
        img2img: {
            enabled: db.NAII2I ?? false,
            source: config.image ? 'configured' : 'current-character',
            imageAssetId: config.image ?? '',
            imageBase64: config.base64image ?? '',
            strength: config.strength || 0.7,
            noise: config.noise || 0,
        },

        // V5 launch models ignore both reference families. Omitting the whole
        // block prevents stale unsupported settings from invalidating paid work.
        ...(usesV5Wire
            ? {}
            : {
                // §10.2 vibe/reference-image and character-reference settings.
                // Only the selected encoding is covered; display metadata is incidental.
                reference: {
                    mode: config.reference_mode ?? '',
                    vibeModelSelection: config.vibe_model_selection ?? '',
                    effectiveVibeModel: vibe!.modelKey,
                    informationExtracted: config.InfoExtracted || 1,
                    selectedVibeEncoding: vibe!.encoding,
                    strength: config.reference_strength_multiple?.length
                        ? config.reference_strength_multiple[0]
                        : 0.5,
                    characterSource: config.character_image ? 'configured' : 'current-character',
                    characterImageAssetId: config.character_image ?? '',
                    characterImageBase64: config.character_base64image ?? '',
                    styleAware: config.style_aware ?? false,
                },
            }),
    } as const
}

export async function computeNaiSettingsFingerprint(db: NaiSettingsFingerprintDatabase): Promise<string> {
    return computeCanonicalNaiSettingsFingerprint(canonicalizeNaiSettings(db))
}

export async function computeCanonicalNaiSettingsFingerprint(
    settings: CanonicalNaiSettings,
): Promise<string> {
    return sha256Hex(serializeCanonicalNaiSettings(settings))
}
