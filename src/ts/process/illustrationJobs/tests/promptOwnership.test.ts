import { beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
    db: {} as any,
    globalFetch: vi.fn(),
    processZip: vi.fn(),
}))

vi.mock('svelte/store', () => ({
    get: () => ({}),
}))

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => harness.db,
}))

vi.mock('src/ts/process/request/request', () => ({
    requestChatData: vi.fn(),
}))

vi.mock('src/ts/alert', () => ({
    alertError: vi.fn(),
    notifyError: vi.fn(),
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    fetchNative: vi.fn(),
    globalFetch: harness.globalFetch,
    readImage: vi.fn(),
}))

vi.mock('src/ts/stores.svelte', () => ({
    CharEmotion: { set: vi.fn() },
}))

vi.mock('src/ts/process/processzip', () => ({
    processZip: harness.processZip,
}))

vi.mock('lodash/random', () => ({
    default: () => 12345,
}))

const { generateAIImageTyped } = await import('../../stableDiff')

beforeEach(() => {
    harness.db = {
        sdProvider: 'novelai',
        NAIApiKey: 'test-key',
        NAIImgUrl: 'https://image.novelai.net/ai/generate-image',
        NAIImgModel: 'nai-diffusion-4-full',
        NAII2I: false,
        NAIImgConfig: {
            width: 1024,
            height: 1024,
            scale: 5,
            sampler: 'k_euler',
            steps: 28,
            noise_schedule: 'native',
            cfg_rescale: 0,
            undesired_content: '',
            legacy_uc: false,
            variety_plus: false,
            reference_mode: 'none',
        },
    }
    harness.globalFetch.mockReset()
    harness.processZip.mockReset()
    harness.globalFetch.mockResolvedValue({
        ok: true,
        data: new Uint8Array([1, 2, 3]),
        headers: { 'risu-image-result': 'provider-response' },
        status: 200,
    })
    harness.processZip.mockResolvedValue('data:image/png;base64,generated')
})

describe('illustration prompt ownership', () => {
    test('serializes the durable positive and negative verbatim in the NAI request body', async () => {
        const positive = String.raw`portrait (literal emphasis), escaped \(literal pair\)`
        const negative = 'durable negative; CURRENT CHARACTER PRESET MUST NOT APPEAR'
        const currentCharacter = {
            chaId: 'character-1',
            image: '',
            newGenData: { negative: 'character-current-negative-sentinel' },
        } as any

        await generateAIImageTyped(
            positive,
            currentCharacter,
            negative,
            'inlay',
            'background',
            { preservePromptText: true },
        )

        const request = harness.globalFetch.mock.calls[0][1]
        expect(request.body.input).toBe(positive)
        expect(request.body.parameters.v4_prompt.caption.base_caption).toBe(positive)
        expect(request.body.parameters.negative_prompt).toBe(negative)
        expect(request.body.parameters.v4_negative_prompt.caption.base_caption).toBe(negative)
        expect(JSON.stringify(request.body)).not.toContain('character-current-negative-sentinel')
    })

    // Request §4 rows 3-4: 1..6 subjects retain cardinality, order, role tags, and bytes.
    test.each([1, 2, 3, 4, 5, 6])(
        'serializes %i ordered character captions verbatim on both sides',
        async (count) => {
            const characterPositives = Array.from(
                { length: count },
                (_, index) => `source#${index + 1} (positive ${index + 1})\r\n`,
            )
            const characterNegatives = Array.from(
                { length: count },
                (_, index) => `target#${index + 1} negative ${index + 1}\t`,
            )
            await generateAIImageTyped(
                'base (positive)',
                { chaId: 'character-1', image: '', newGenData: {} } as any,
                'base (negative)',
                'inlay',
                'background',
                {
                    preservePromptText: true,
                    illustrationPrompt: {
                        schemaVersion: 1,
                        layout: 'nai-v4-characters',
                        basePositive: 'base (positive)',
                        characterPositives,
                        baseNegative: 'base (negative)',
                        characterNegatives,
                    },
                },
            )

            const body = harness.globalFetch.mock.calls[0][1].body
            const parameters = body.parameters
            expect(parameters.v4_prompt.caption.char_captions).toEqual(
                characterPositives.map((char_caption) => ({ char_caption, centers: [] })),
            )
            expect(parameters.v4_negative_prompt.caption.char_captions).toEqual(
                characterNegatives.map((char_caption) => ({ char_caption, centers: [] })),
            )
            expect(parameters.v4_prompt.caption.char_captions).toHaveLength(count)
            expect(parameters.v4_negative_prompt.caption.char_captions).toHaveLength(count)
            expect(body.input).toBe('base (positive)')
            expect(parameters.negative_prompt).toBe('base (negative)')
        },
    )

    // Request §4 row 8: additive flat options leave the legacy NAI body byte-for-byte equivalent.
    test('keeps the flat typed illustration request body identical to the legacy flat path', async () => {
        const positive = 'flat (positive) source#1'
        const negative = 'flat (negative) target#1'
        const currentCharacter = { chaId: 'character-1', image: '', newGenData: {} } as any

        await generateAIImageTyped(
            positive,
            currentCharacter,
            negative,
            'inlay',
            'background',
            { preservePromptText: true },
        )
        const legacyRequest = structuredClone(harness.globalFetch.mock.calls[0][1].body)
        harness.globalFetch.mockClear()

        await generateAIImageTyped(
            'ignored positive',
            currentCharacter,
            'ignored negative',
            'inlay',
            'background',
            {
                preservePromptText: true,
                illustrationPrompt: {
                    schemaVersion: 1,
                    layout: 'flat',
                    basePositive: positive,
                    characterPositives: [],
                    baseNegative: negative,
                    characterNegatives: [],
                },
            },
        )
        expect(harness.globalFetch.mock.calls[0][1].body).toEqual(legacyRequest)
    })
})
