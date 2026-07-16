import { describe, expect, test, vi } from 'vitest'
import { IllustrationImagePromptContractError } from '../errors'
import {
    MAX_ILLUSTRATION_PROMPT_BYTES,
    parseIllustrationPromptV1,
} from '../imagePrompt'
import {
    assertImagePromptWithinLimits,
    createImagePromptMeasurementService,
    createImagePromptTokenizerLoader,
    measureAndEnforceImagePromptForDispatch,
    setImagePromptMeasurementServiceForTests,
} from '../imagePromptMeasurement'
import { computeNaiSettingsFingerprint } from '../settingsFingerprint'
import type { IllustrationPromptV1 } from '../types'

vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => ({}) }))

function database(model = 'nai-diffusion-4-5-full', provider = 'novelai') {
    return {
        sdProvider: provider,
        NAIImgUrl: 'https://image.novelai.net/ai/generate-image',
        NAIImgModel: model,
        NAII2I: false,
        NAIImgConfig: {},
    } as any
}

const flatPrompt: IllustrationPromptV1 = {
    schemaVersion: 1,
    layout: 'flat',
    basePositive: 'fixed-style',
    characterPositives: [],
    baseNegative: '',
    characterNegatives: [],
}

function fakeLoader(countTokens: (text: string) => number) {
    return createImagePromptTokenizerLoader({
        loadModel: async () => new ArrayBuffer(0),
        createTokenizer: async () => ({
            encode: (text) => ({ length: countTokens(text) }),
        }),
    })
}

describe('IllustrationPromptV1 validation', () => {
    // Request §4 rows 3-5 and 8: preserve bytes/order, pin six subjects, retain 16 KiB sides.
    test('preserves every code unit and ordered part without normalization', () => {
        const prompt = {
            schemaVersion: 1,
            layout: 'nai-v4-characters',
            basePositive: '  base\r\n(source#1)  ',
            characterPositives: ['source#1  Alice', 'target#2\tBob'],
            baseNegative: '  negative  ',
            characterNegatives: ['neg#1', 'neg#2'],
        } as const
        expect(parseIllustrationPromptV1(prompt)).toEqual(prompt)
    })

    test('rejects malformed layouts, cardinality, sparse/accessor arrays, and aggregate bytes', () => {
        expect(() => parseIllustrationPromptV1({ ...flatPrompt, extra: true }))
            .toThrowError(expect.objectContaining({ code: 'image_prompt_invalid' }))
        expect(() => parseIllustrationPromptV1({
            ...flatPrompt,
            layout: 'nai-v4-characters',
            characterPositives: Array.from({ length: 7 }, (_, index) => String(index)),
            characterNegatives: Array.from({ length: 7 }, (_, index) => String(index)),
        })).toThrowError(expect.objectContaining({ code: 'image_prompt_invalid' }))
        expect(() => parseIllustrationPromptV1({
            ...flatPrompt,
            layout: 'nai-v4-characters',
            characterPositives: ['one'],
            characterNegatives: [],
        })).toThrowError(expect.objectContaining({ code: 'image_prompt_invalid' }))
        expect(() => parseIllustrationPromptV1({
            ...flatPrompt,
            layout: 'nai-v4-characters',
            characterPositives: new Array(1),
            characterNegatives: new Array(1),
        })).toThrowError(expect.objectContaining({ code: 'image_prompt_invalid' }))

        const accessor = [] as string[]
        Object.defineProperty(accessor, 0, { enumerable: true, get: () => 'surprise' })
        accessor.length = 1
        expect(() => parseIllustrationPromptV1({
            ...flatPrompt,
            layout: 'nai-v4-characters',
            characterPositives: accessor,
            characterNegatives: ['negative'],
        })).toThrowError(expect.objectContaining({ code: 'image_prompt_invalid' }))
        expect(() => parseIllustrationPromptV1({
            ...flatPrompt,
            basePositive: 'a'.repeat(MAX_ILLUSTRATION_PROMPT_BYTES),
            baseNegative: '',
            layout: 'nai-v4-characters',
            characterPositives: ['b'],
            characterNegatives: [''],
        })).toThrowError(expect.objectContaining({ code: 'image_prompt_invalid' }))
    })
})

describe('exact NAI V4 image prompt measurement', () => {
    // Request §4 rows 1-2: measurement reports over-limit; the gate carries exact payload.
    test('returns over-limit counts without rejecting and gates the final prompt separately', async () => {
        const db = database()
        const service = createImagePromptMeasurementService({
            getDatabase: () => db,
            tokenizerLoader: fakeLoader((text) => text === 'fixed-style' ? 513 : 0),
        })
        const measurement = await service.measure({
            protocolVersion: 1,
            settingsFingerprint: await computeNaiSettingsFingerprint(db),
            prompt: flatPrompt,
        })
        expect(measurement).toEqual({
            model: 'nai-diffusion-4-5-full',
            tokenizer: 't5-spiece-v1',
            positiveTokens: 513,
            negativeTokens: 0,
            maxPositiveTokens: 512,
            maxNegativeTokens: 512,
        })
        expect(() => assertImagePromptWithinLimits(measurement)).toThrowError(expect.objectContaining({
            code: 'image_prompt_over_limit',
            payload: {
                positiveTokens: 513,
                negativeTokens: 0,
                maxPositiveTokens: 512,
                maxNegativeTokens: 512,
                model: 'nai-diffusion-4-5-full',
            },
        }))
    })

    // Planner decision 3: parts are counted separately in transport order, then summed.
    test('tokenizes base and character captions separately in exact transport order', async () => {
        const db = database()
        const calls: string[] = []
        const lengths = new Map([
            ['base+', 2], ['source#1 Alice', 5], ['target#2 Bob', 7],
            ['base-', 3], ['negative one', 11], ['negative two', 13],
        ])
        const service = createImagePromptMeasurementService({
            getDatabase: () => db,
            tokenizerLoader: fakeLoader((text) => {
                calls.push(text)
                return lengths.get(text) ?? 0
            }),
        })
        const measurement = await service.measure({
            protocolVersion: 1,
            settingsFingerprint: await computeNaiSettingsFingerprint(db),
            prompt: {
                schemaVersion: 1,
                layout: 'nai-v4-characters',
                basePositive: 'base+',
                characterPositives: ['source#1 Alice', 'target#2 Bob'],
                baseNegative: 'base-',
                characterNegatives: ['negative one', 'negative two'],
            },
        })
        expect(calls).toEqual([
            'base+', 'source#1 Alice', 'target#2 Bob',
            'base-', 'negative one', 'negative two',
        ])
        expect(measurement).toMatchObject({ positiveTokens: 14, negativeTokens: 27 })
    })

    // Request §4 rows 6-7: mismatch/unsupported fail before tokenization; transient load retries.
    test('fails closed on fingerprint mismatch, replacement drift, and unsupported models', async () => {
        const db = database()
        const loadModel = vi.fn(async () => new ArrayBuffer(0))
        const service = createImagePromptMeasurementService({
            getDatabase: () => db,
            tokenizerLoader: createImagePromptTokenizerLoader({
                loadModel,
                createTokenizer: async () => ({ encode: () => ({ length: 1 }) }),
            }),
        })
        await expect(service.measure({
            protocolVersion: 1,
            settingsFingerprint: 'wrong',
            prompt: flatPrompt,
        })).rejects.toMatchObject({ code: 'settings_fingerprint_mismatch' })
        expect(loadModel).not.toHaveBeenCalled()

        const oldDb = database()
        const newDb = database('nai-diffusion-4-full')
        let reads = 0
        const replacementService = createImagePromptMeasurementService({
            getDatabase: () => ++reads === 1 ? oldDb : newDb,
            tokenizerLoader: fakeLoader(() => 1),
        })
        await expect(replacementService.resolveSettings(
            await computeNaiSettingsFingerprint(oldDb),
        )).rejects.toMatchObject({ code: 'settings_fingerprint_mismatch' })

        db.NAIImgModel = 'nai-diffusion-3'
        await expect(service.measure({
            protocolVersion: 1,
            settingsFingerprint: await computeNaiSettingsFingerprint(db),
            prompt: flatPrompt,
        })).rejects.toMatchObject({ code: 'image_prompt_measurement_unsupported' })
        expect(loadModel).not.toHaveBeenCalled()
    })

    test('remembers a tokenizer failure for diagnostics but retries and caches success', async () => {
        const transient = new Error('temporary asset outage')
        const loadModel = vi.fn()
            .mockRejectedValueOnce(transient)
            .mockResolvedValue(new ArrayBuffer(1))
        const createTokenizer = vi.fn(async () => ({ encode: () => ({ length: 1 }) }))
        const loader = createImagePromptTokenizerLoader({ loadModel, createTokenizer })

        await expect(loader.load()).rejects.toBe(transient)
        expect(loader.getLastFailure()).toBe(transient)
        const [first, second] = await Promise.all([loader.load(), loader.load()])
        expect(first).toBe(second)
        expect(loader.getLastFailure()).toBeUndefined()
        expect(loadModel).toHaveBeenCalledTimes(2)
        expect(createTokenizer).toHaveBeenCalledTimes(1)
    })

    test('keeps flat non-V4 supply transport-only but makes non-NAI dispatch fail closed', async () => {
        const db = database('other-model', 'webui')
        const service = createImagePromptMeasurementService({
            getDatabase: () => db,
            tokenizerLoader: fakeLoader(() => 1),
        })
        const restore = setImagePromptMeasurementServiceForTests(service)
        try {
            const input = {
                protocolVersion: 1 as const,
                settingsFingerprint: await computeNaiSettingsFingerprint(db),
                prompt: flatPrompt,
            }
            await expect(measureAndEnforceImagePromptForDispatch(input)).resolves.toBeNull()
            await expect(measureAndEnforceImagePromptForDispatch(
                input,
                { requireNovelAiProvider: true },
            )).rejects.toMatchObject({ code: 'image_prompt_measurement_unsupported' })
        } finally {
            restore()
        }
    })
})
