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
})
