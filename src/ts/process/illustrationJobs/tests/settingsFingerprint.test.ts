import { describe, expect, test } from 'vitest'
import {
    NAI_SETTINGS_FINGERPRINT_SCHEMA_VERSION,
    canonicalizeNaiSettings,
    computeNaiSettingsFingerprint,
} from '../settingsFingerprint'
import type { NaiSettingsFingerprintDatabase } from '../settingsFingerprint'

type TestDatabase = NaiSettingsFingerprintDatabase & Record<string, any>

function makeDatabase(): TestDatabase {
    return {
        sdProvider: 'novelai',
        NAIImgUrl: 'https://image.novelai.net/ai/generate-image',
        NAIImgModel: 'nai-diffusion-4-5-full',
        NAII2I: false,
        NAIApiKey: 'secret-a',
        NAIREF: false,
        unrelated: { theme: 'dark' },
        NAIImgConfig: {
            width: 1024,
            height: 1024,
            sampler: 'k_euler_ancestral',
            noise_schedule: 'karras',
            steps: 28,
            scale: 5,
            cfg_rescale: 0,
            sm: true,
            sm_dyn: false,
            noise: 0,
            strength: 0.6,
            image: '',
            base64image: '',
            InfoExtracted: 1,
            autoSmea: false,
            use_coords: false,
            legacy_uc: false,
            v4_prompt: {
                caption: { base_caption: '', char_captions: [] },
                use_coords: false,
                use_order: true,
            },
            v4_negative_prompt: {
                caption: { base_caption: '', char_captions: [] },
                legacy_uc: false,
            },
            reference_image_multiple: ['unused-stored-reference'],
            reference_strength_multiple: [0.7],
            vibe_model_selection: '',
            vibe_data: {
                identifier: 'identifier',
                version: 1,
                type: 'naiv4vibe',
                image: 'display-image',
                id: 'vibe-id',
                name: 'display name',
                thumbnail: 'display thumbnail',
                createdAt: 1,
                importInfo: { model: 'model', information_extracted: 1, strength: 0.7 },
                encodings: {
                    'v4-5full': {
                        first: { encoding: 'encoding-first', params: { information_extracted: 1 } },
                        second: { encoding: 'encoding-second', params: { information_extracted: 2 } },
                    },
                    v4full: {
                        unused: { encoding: 'encoding-unused-model', params: { information_extracted: 1 } },
                    },
                },
            },
            variety_plus: false,
            decrisp: false,
            reference_mode: 'vibe',
            character_image: '',
            character_base64image: '',
            style_aware: false,
        },
    } as TestDatabase
}

function cloneDatabase(database: TestDatabase): TestDatabase {
    return JSON.parse(JSON.stringify(database))
}

describe('NAI settings fingerprint', () => {
    const coveredMutations: Array<[string, (database: TestDatabase) => void]> = [
        ['provider', (db) => { db.sdProvider = 'other-provider' }],
        ['endpoint', (db) => { db.NAIImgUrl = 'https://example.test/nai' }],
        ['model', (db) => { db.NAIImgModel = 'nai-diffusion-3' }],
        ['width', (db) => { db.NAIImgConfig.width = 832 }],
        ['height', (db) => { db.NAIImgConfig.height = 1216 }],
        ['sampler', (db) => { db.NAIImgConfig.sampler = 'k_dpmpp_2m' }],
        ['steps', (db) => { db.NAIImgConfig.steps = 32 }],
        ['CFG scale', (db) => { db.NAIImgConfig.scale = 6 }],
        ['CFG rescale', (db) => { db.NAIImgConfig.cfg_rescale = 0.25 }],
        ['noise schedule', (db) => { db.NAIImgConfig.noise_schedule = 'exponential' }],
        ['SMEA', (db) => { db.NAIImgConfig.sm = false }],
        ['dynamic SMEA', (db) => { db.NAIImgConfig.sm_dyn = true }],
        ['decrisp', (db) => { db.NAIImgConfig.decrisp = true }],
        ['Variety+', (db) => { db.NAIImgConfig.variety_plus = true }],
        ['legacy UC', (db) => { db.NAIImgConfig.legacy_uc = true }],
        ['img2img enabled', (db) => { db.NAII2I = true }],
        ['img2img image id', (db) => { db.NAIImgConfig.image = 'asset-image' }],
        ['img2img bytes', (db) => { db.NAIImgConfig.base64image = 'base64-image' }],
        ['img2img strength', (db) => { db.NAIImgConfig.strength = 0.8 }],
        ['img2img noise', (db) => { db.NAIImgConfig.noise = 0.2 }],
        ['reference mode', (db) => { db.NAIImgConfig.reference_mode = 'character' }],
        ['vibe model selection', (db) => { db.NAIImgConfig.vibe_model_selection = 'v4-5full' }],
        ['vibe information extracted', (db) => { db.NAIImgConfig.InfoExtracted = 2 }],
        ['vibe strength', (db) => { db.NAIImgConfig.reference_strength_multiple = [0.8] }],
        ['selected vibe encoding', (db) => {
            db.NAIImgConfig.vibe_data.encodings['v4-5full'].first.encoding = 'encoding-changed'
        }],
        ['character image id', (db) => { db.NAIImgConfig.character_image = 'character-asset' }],
        ['character image bytes', (db) => { db.NAIImgConfig.character_base64image = 'character-base64' }],
        ['character style awareness', (db) => { db.NAIImgConfig.style_aware = true }],
    ]

    test.each(coveredMutations)('changes when covered field family changes: %s', async (_label, mutate) => {
        const baseline = makeDatabase()
        const changed = cloneDatabase(baseline)
        mutate(changed)
        expect(await computeNaiSettingsFingerprint(changed))
            .not.toBe(await computeNaiSettingsFingerprint(baseline))
    })

    test('ignores API keys, unrelated DB fields, and request-unused NAI fields', async () => {
        const baseline = makeDatabase()
        const changed = cloneDatabase(baseline)
        changed.NAIApiKey = 'secret-b'
        changed.NAIREF = true
        changed.unrelated = { theme: 'light', anything: 42 }
        changed.NAIImgConfig.autoSmea = true
        changed.NAIImgConfig.use_coords = true
        changed.NAIImgConfig.v4_prompt.caption.base_caption = 'unused'
        changed.NAIImgConfig.v4_negative_prompt.caption.base_caption = 'unused'
        changed.NAIImgConfig.reference_image_multiple = ['changed-but-unused']
        changed.NAIImgConfig.vibe_data.name = 'changed display name'
        changed.NAIImgConfig.vibe_data.thumbnail = 'changed display thumbnail'
        changed.NAIImgConfig.vibe_data.encodings.v4full.unused.encoding = 'changed-unselected-model'
        changed.NAIImgConfig.vibe_data.encodings['v4-5full'].second.encoding = 'changed-unselected-encoding'

        expect(await computeNaiSettingsFingerprint(changed))
            .toBe(await computeNaiSettingsFingerprint(baseline))
    })

    test('is stable across ordinary object key order changes', async () => {
        const baseline = makeDatabase()
        const reorderedConfig = Object.fromEntries(Object.entries(baseline.NAIImgConfig).reverse())
        const reordered = Object.fromEntries([
            ['NAIImgConfig', reorderedConfig],
            ['NAII2I', baseline.NAII2I],
            ['NAIImgModel', baseline.NAIImgModel],
            ['NAIImgUrl', baseline.NAIImgUrl],
            ['sdProvider', baseline.sdProvider],
        ]) as TestDatabase

        expect(await computeNaiSettingsFingerprint(reordered))
            .toBe(await computeNaiSettingsFingerprint(baseline))
    })

    test('selects fallback vibe encoding before canonical sorting, matching live Object.keys order', async () => {
        const firstOrder = makeDatabase()
        const reversedOrder = cloneDatabase(firstOrder)
        const encodings = reversedOrder.NAIImgConfig.vibe_data.encodings['v4-5full']
        reversedOrder.NAIImgConfig.vibe_data.encodings['v4-5full'] = {
            second: encodings.second,
            first: encodings.first,
        }

        expect(canonicalizeNaiSettings(firstOrder).reference.selectedVibeEncoding).toBe('encoding-first')
        expect(canonicalizeNaiSettings(reversedOrder).reference.selectedVibeEncoding).toBe('encoding-second')
        expect(await computeNaiSettingsFingerprint(reversedOrder))
            .not.toBe(await computeNaiSettingsFingerprint(firstOrder))
    })

    test('pins request-effective defaults and the current-character source sentinel', async () => {
        const zeroValues = makeDatabase()
        zeroValues.NAIImgConfig.strength = 0
        zeroValues.NAIImgConfig.noise = 0
        zeroValues.NAIImgConfig.InfoExtracted = 0
        zeroValues.NAIImgConfig.reference_strength_multiple = []

        const effectiveDefaults = cloneDatabase(zeroValues)
        effectiveDefaults.NAIImgConfig.strength = 0.7
        effectiveDefaults.NAIImgConfig.InfoExtracted = 1
        delete effectiveDefaults.NAIImgConfig.reference_strength_multiple

        const canonical = canonicalizeNaiSettings(zeroValues)
        expect(canonical.schemaVersion).toBe(NAI_SETTINGS_FINGERPRINT_SCHEMA_VERSION)
        expect(canonical.generation.seedPolicy).toEqual({
            seed: 'random-u32-per-request',
            extraNoiseSeed: 'independent-random-u32-per-request',
        })
        expect(canonical.negativePreset).toEqual({ ucPreset: 3, legacyUc: false })
        expect(canonical.img2img).toMatchObject({
            source: 'current-character',
            strength: 0.7,
            noise: 0,
        })
        expect(canonical.reference).toMatchObject({
            informationExtracted: 1,
            strength: 0.5,
            characterSource: 'current-character',
        })
        expect(await computeNaiSettingsFingerprint(zeroValues))
            .toBe(await computeNaiSettingsFingerprint(effectiveDefaults))
    })

    test('covers configured reference data even while its mode is inactive', async () => {
        const baseline = makeDatabase()
        baseline.NAIImgConfig.reference_mode = ''
        const changed = cloneDatabase(baseline)
        changed.NAIImgConfig.vibe_data.encodings['v4-5full'].first.encoding = 'inactive-but-configured-change'
        changed.NAIImgConfig.character_base64image = 'inactive-character-reference-change'

        expect(await computeNaiSettingsFingerprint(changed))
            .not.toBe(await computeNaiSettingsFingerprint(baseline))
    })

    test('returns a lowercase SHA-256 hex fingerprint', async () => {
        expect(await computeNaiSettingsFingerprint(makeDatabase())).toMatch(/^[0-9a-f]{64}$/)
    })
})
