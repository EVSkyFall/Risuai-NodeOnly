import { beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
    db: {} as any,
    globalFetch: vi.fn(),
    processZipWithMetadata: vi.fn(),
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
    processZipWithMetadata: harness.processZipWithMetadata,
}))

vi.mock('lodash/random', () => ({
    default: () => 12345,
}))

const { generateAIImageTyped } = await import('../../stableDiff')

// Measured against the live provider: a caption with an empty or absent
// `centers` is rejected with HTTP 500, on both the positive and the negative
// side. An unplaced caption therefore carries the middle of the canvas, which
// `use_coords: false` tells the provider to ignore in favour of order.
const NEUTRAL = { x: 0.5, y: 0.5 }

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
    harness.processZipWithMetadata.mockReset()
    harness.globalFetch.mockResolvedValue({
        ok: true,
        data: new Uint8Array([1, 2, 3]),
        headers: { 'risu-image-result': 'provider-response' },
        status: 200,
    })
    harness.processZipWithMetadata.mockResolvedValue({
        dataUrl: 'data:image/png;base64,generated',
        seedUsed: null,
    })
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
                characterPositives.map((char_caption) => ({ char_caption, centers: [NEUTRAL] })),
            )
            expect(parameters.v4_negative_prompt.caption.char_captions).toEqual(
                characterNegatives.map((char_caption) => ({ char_caption, centers: [NEUTRAL] })),
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

// Regional placement is opt-in and driven entirely by the prompt: `use_coords`
// is a property of the scene being drawn, not a global setting, because a
// one-subject scene has nothing to place.
describe('regional character placement', () => {
    const character = { chaId: 'character-1', image: '', newGenData: {} } as any

    const dispatch = async (characterCenters?: Array<{ x: number, y: number } | null>) => {
        await generateAIImageTyped(
            'base positive',
            character,
            'base negative',
            'inlay',
            'background',
            {
                preservePromptText: true,
                illustrationPrompt: {
                    schemaVersion: 1,
                    layout: 'nai-v4-characters',
                    basePositive: 'base positive',
                    characterPositives: ['left subject', 'right subject'],
                    baseNegative: 'base negative',
                    characterNegatives: ['', ''],
                    ...(characterCenters ? { characterCenters } : {}),
                },
            },
        )
        return harness.globalFetch.mock.calls[0][1].body.parameters
    }

    test('a prompt with no placement produces the request it always produced', async () => {
        const parameters = await dispatch()

        expect(parameters.use_coords).toBe(false)
        expect(parameters.v4_prompt.use_coords).toBe(false)
        expect(parameters.v4_prompt.caption.char_captions).toEqual([
            { char_caption: 'left subject', centers: [NEUTRAL] },
            { char_caption: 'right subject', centers: [NEUTRAL] },
        ])
    })

    test('supplied centres turn coordinate placement on and travel with their caption', async () => {
        const parameters = await dispatch([{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }])

        expect(parameters.use_coords).toBe(true)
        expect(parameters.v4_prompt.use_coords).toBe(true)
        // Order still identifies which caption belongs to which subject.
        expect(parameters.v4_prompt.use_order).toBe(true)
        expect(parameters.v4_prompt.caption.char_captions).toEqual([
            { char_caption: 'left subject', centers: [{ x: 0.25, y: 0.5 }] },
            { char_caption: 'right subject', centers: [{ x: 0.75, y: 0.5 }] },
        ])
    })

    test('an unplaced subject in a placed scene keeps its caption and stays unplaced', async () => {
        const parameters = await dispatch([{ x: 0.25, y: 0.5 }, null])

        expect(parameters.use_coords).toBe(true)
        expect(parameters.v4_prompt.caption.char_captions).toEqual([
            { char_caption: 'left subject', centers: [{ x: 0.25, y: 0.5 }] },
            { char_caption: 'right subject', centers: [NEUTRAL] },
        ])
    })

    test('an all-null placement array is treated as no placement at all', async () => {
        const parameters = await dispatch([null, null])

        expect(parameters.use_coords).toBe(false)
    })

    // Measured against the live provider, not inferred. Every one of these
    // shapes was sent for real: an empty `centers`, an absent `centers`, and
    // centres on the positive captions but not the negative ones each came
    // back HTTP 500. Only one centre per caption on BOTH sides was accepted.
    // The core used to send an empty array unconditionally, which means
    // multi-character generation could not have worked at all.
    test('every caption carries exactly one centre, on both sides, always', async () => {
        for (const placement of [undefined, [null, null], [{ x: 0.25, y: 0.72 }, null]] as const) {
            const parameters = await dispatch(placement as any)
            const sides = [
                parameters.v4_prompt.caption.char_captions,
                parameters.v4_negative_prompt.caption.char_captions,
            ]
            for (const captions of sides) {
                expect(captions).toHaveLength(2)
                for (const caption of captions) {
                    expect(Array.isArray(caption.centers)).toBe(true)
                    expect(caption.centers).toHaveLength(1)
                    expect(typeof caption.centers[0].x).toBe('number')
                    expect(typeof caption.centers[0].y).toBe('number')
                }
            }
            harness.globalFetch.mockClear()
        }
    })

    test('negative captions are placed alongside their positive counterpart', async () => {
        const parameters = await dispatch([{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }])

        expect(parameters.v4_negative_prompt.caption.char_captions).toEqual([
            { char_caption: '', centers: [{ x: 0.25, y: 0.5 }] },
            { char_caption: '', centers: [{ x: 0.75, y: 0.5 }] },
        ])
    })
})
