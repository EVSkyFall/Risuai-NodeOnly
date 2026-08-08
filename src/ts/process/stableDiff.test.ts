import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    db: {} as any,
    charEmotions: {} as Record<string, [string, string, number][]>,
    globalFetch: vi.fn(),
    fetchNative: vi.fn(),
    processZip: vi.fn(),
    processZipWithMetadata: vi.fn(),
    alertError: vi.fn(),
    notifyError: vi.fn(),
    charEmotionSet: vi.fn(),
    random: vi.fn(),
}))

vi.mock('svelte/store', () => ({
    get: () => mocks.charEmotions,
}))

vi.mock('../storage/database.svelte', () => ({
    getDatabase: () => mocks.db,
}))

vi.mock('./request/request', () => ({
    requestChatData: vi.fn(),
}))

vi.mock('../alert', () => ({
    alertError: mocks.alertError,
    notifyError: mocks.notifyError,
}))

vi.mock('../globalApi.svelte', () => ({
    fetchNative: mocks.fetchNative,
    globalFetch: mocks.globalFetch,
    readImage: vi.fn(),
}))

vi.mock('../stores.svelte', () => ({
    CharEmotion: { set: mocks.charEmotionSet },
}))

vi.mock('./processzip', () => ({
    processZip: mocks.processZip,
    processZipWithMetadata: mocks.processZipWithMetadata,
}))

vi.mock('lodash/random', () => ({
    default: mocks.random,
}))

const { generateAIImage, generateAIImageTyped } = await import('./stableDiff')

const currentChar = {
    chaId: 'test-character',
    image: '',
} as any

function makeDatabase() {
    return {
        sdProvider: 'novelai',
        NAIApiKey: 'test-api-key',
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
}

function makeWebUiDatabase() {
    return {
        sdProvider: 'webui',
        webUiUrl: 'http://127.0.0.1:7860/',
        sdConfig: {
            width: 1024,
            height: 1024,
            sampler_name: 'Euler',
            enable_hr: false,
            denoising_strength: 0.7,
            hr_scale: 2,
            hr_upscaler: 'Latent',
        },
        sdSteps: 28,
        sdCFG: 7,
    }
}

function makeComfyUiDatabase(timeout = 30) {
    return {
        sdProvider: 'comfyui',
        comfyUiUrl: 'http://127.0.0.1:8188/',
        comfyConfig: {
            workflow: JSON.stringify({
                sampler: { class_type: 'KSampler', inputs: { seed: 17, steps: 28 } },
                positive: { class_type: 'CLIPTextEncode', inputs: { text: '{{risu_prompt}}' } },
            }),
            timeout,
        },
    }
}

function jsonResponse(data: unknown) {
    return { json: async () => data }
}

function completedComfyHistory(promptId: string) {
    return {
        [promptId]: {
            outputs: { save: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
            status: { messages: [] },
        },
    }
}

function fetchResult(overrides: Record<string, unknown>) {
    return {
        ok: true,
        data: new Uint8Array([1, 2, 3]),
        headers: { 'risu-image-result': 'provider-response' },
        status: 200,
        ...overrides,
    }
}

beforeEach(() => {
    mocks.db = makeDatabase()
    mocks.charEmotions = {}
    mocks.globalFetch.mockReset()
    mocks.fetchNative.mockReset()
    mocks.processZip.mockReset()
    mocks.processZipWithMetadata.mockReset()
    mocks.alertError.mockReset()
    mocks.notifyError.mockReset()
    mocks.charEmotionSet.mockReset()
    mocks.random.mockReset()
    mocks.random.mockReturnValue(12345)
    mocks.processZip.mockResolvedValue('data:image/png;base64,generated')
    mocks.processZipWithMetadata.mockResolvedValue({
        dataUrl: 'data:image/png;base64,generated',
        seedUsed: null,
    })
})

describe('generateAIImage NAI compatibility wrapper', () => {
    it.each([0, 4294967295])(
        'uses supplied uint32 seed %s for both NAI seed fields and reports it',
        async (seed) => {
        mocks.globalFetch.mockResolvedValue(fetchResult({}))

        const attempt = await generateAIImageTyped(
            'prompt', currentChar, 'negative', 'inlay', 'interactive', { seed },
        )
        const [, request] = mocks.globalFetch.mock.calls[0] as [string, { body: any }]

        expect(request.body.parameters.seed).toBe(seed)
        expect(request.body.parameters.extra_noise_seed).toBe(seed)
        expect(attempt.seedSupported).toBe(true)
        expect(attempt.seedUsed).toBe(seed)
    })

    it('prefers the seed returned in NAI PNG metadata over the request echo', async () => {
        mocks.globalFetch.mockResolvedValue(fetchResult({}))
        mocks.processZipWithMetadata.mockResolvedValue({
            dataUrl: 'data:image/png;base64,generated',
            seedUsed: 987654321,
        })

        const attempt = await generateAIImageTyped(
            'prompt', currentChar, 'negative', 'inlay', 'interactive', { seed: 123 },
        )

        expect(attempt.seedSupported).toBe(true)
        expect(attempt.seedUsed).toBe(987654321)
    })

    it('rejects a seed above the NAI uint32 limit before dispatch', async () => {
        const attempt = await generateAIImageTyped(
            'prompt', currentChar, 'negative', 'inlay', 'interactive', { seed: 4294967296 },
        )

        expect(attempt.result.ok).toBe(false)
        const failure = attempt.result as Extract<
            import('./stableDiff').ImageGenerationResult,
            { ok: false; certainty: 'definite' }
        >
        expect(failure.certainty).toBe('definite')
        expect(failure.code).toBe('image_seed_invalid')
        expect(failure.reason).toMatch(/NAI.*4294967295/)
        expect(attempt.compatibilityValue).toBe('')
        expect(mocks.globalFetch).not.toHaveBeenCalled()
        expect(mocks.random).not.toHaveBeenCalled()
    })

    it('keeps the two existing NAI random seed draws when no seed is supplied', async () => {
        mocks.globalFetch.mockResolvedValue(fetchResult({}))
        mocks.random.mockReset()
        mocks.random.mockReturnValueOnce(111).mockReturnValueOnce(222)

        const attempt = await generateAIImageTyped(
            'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
        )
        const [, request] = mocks.globalFetch.mock.calls[0] as [string, { body: any }]

        expect(request.body.parameters.seed).toBe(111)
        expect(request.body.parameters.extra_noise_seed).toBe(222)
        expect(mocks.random.mock.calls).toEqual([[0, 2**32 - 1], [0, 2**32 - 1]])
        expect(attempt.seedSupported).toBe(true)
        expect(attempt.seedUsed).toBe(111)
    })

    it('keeps inlay provider rejection as an empty string and marks the proxy request safe', async () => {
        mocks.globalFetch.mockResolvedValue(fetchResult({
            ok: false,
            data: new TextEncoder().encode('provider rejected'),
            status: 429,
        }))

        await expect(generateAIImage('prompt', currentChar, 'negative', 'inlay')).resolves.toBe('')
        expect(mocks.notifyError).toHaveBeenCalledWith('provider rejected')
        expect(mocks.globalFetch).toHaveBeenCalledWith(
            mocks.db.NAIImgUrl,
            expect.objectContaining({
                plainFetchDeforce: true,
                proxyRequestHeaders: { 'risu-image-class': 'interactive' },
                redactRequestLog: true,
                headers: { Authorization: 'Bearer test-api-key' },
            }),
        )
    })

    it('keeps a returned transport failure in inlay mode as an empty string', async () => {
        mocks.globalFetch.mockResolvedValue(fetchResult({
            ok: false,
            data: new TextEncoder().encode('transport failed'),
            headers: { 'risu-image-result': 'transport-error' },
            status: 502,
        }))

        await expect(generateAIImage('prompt', currentChar, 'negative', 'inlay')).resolves.toBe('')
        expect(mocks.notifyError).toHaveBeenCalledWith('transport failed')
    })

    it('keeps a thrown ZIP decode failure in inlay mode as false', async () => {
        const zipError = new Error('invalid zip')
        mocks.globalFetch.mockResolvedValue(fetchResult({}))
        mocks.processZipWithMetadata.mockRejectedValue(zipError)

        await expect(generateAIImage('prompt', currentChar, 'negative', 'inlay')).resolves.toBe(false)
        expect(mocks.notifyError).toHaveBeenCalledWith(zipError)
    })

    it('keeps non-inlay provider rejection as false', async () => {
        mocks.globalFetch.mockResolvedValue(fetchResult({
            ok: false,
            data: new TextEncoder().encode('provider rejected'),
            status: 400,
        }))

        await expect(generateAIImage('prompt', currentChar, 'negative', '')).resolves.toBe(false)
        expect(mocks.notifyError).toHaveBeenCalledWith('provider rejected')
    })

    it('keeps the non-inlay CharEmotion side effect and threads background priority', async () => {
        mocks.globalFetch.mockResolvedValue(fetchResult({}))

        await expect(generateAIImage('prompt', currentChar, 'negative', '', 'background')).resolves.toBe('')
        expect(mocks.charEmotions['test-character'][0][0]).toBe('data:image/png;base64,generated')
        expect(mocks.charEmotionSet).toHaveBeenCalledWith(mocks.charEmotions)
        expect(mocks.globalFetch).toHaveBeenCalledWith(
            mocks.db.NAIImgUrl,
            expect.objectContaining({
                proxyRequestHeaders: { 'risu-image-class': 'background' },
            }),
        )
    })
})

describe('generateAIImage Comfy seed threading', () => {
    it.each([4294967295, 4294967296, 9007199254740991])(
        'applies safe-integer seed %s to the Comfy workflow and reports it exactly',
        async (seed) => {
        mocks.db = {
            sdProvider: 'comfyui',
            comfyUiUrl: 'http://127.0.0.1:8188/',
            comfyConfig: {
                workflow: JSON.stringify({
                    sampler: { class_type: 'KSampler', inputs: { seed: 17, steps: 28 } },
                    sampler2: { class_type: 'KSampler', inputs: { seed: 18, steps: 20 } },
                    positive: { class_type: 'CLIPTextEncode', inputs: { text: '{{risu_prompt}}' } },
                }),
                timeout: 30,
            },
        }
        mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: 'job-1' } })
        mocks.fetchNative
            .mockResolvedValueOnce({
                json: async () => ({
                    'job-1': {
                        outputs: { save: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
                        status: { messages: [] },
                    },
                }),
            })
            .mockResolvedValueOnce({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })

        const attempt = await generateAIImageTyped(
            'prompt', currentChar, 'negative', 'inlay', 'interactive', { seed },
        )
        const promptRequest = mocks.globalFetch.mock.calls[0][1] as { body: { prompt: any } }

        expect(promptRequest.body.prompt.sampler.inputs.seed).toBe(seed)
        expect(promptRequest.body.prompt.sampler2.inputs.seed).toBe(seed)
        expect(attempt.seedSupported).toBe(true)
        expect(attempt.seedUsed).toBe(seed)
    })

    it('preserves and reports the workflow seed in legacy Comfy mode when none is supplied', async () => {
        mocks.db = {
            sdProvider: 'comfy',
            comfyUiUrl: 'http://127.0.0.1:8188/',
            comfyConfig: {
                workflow: JSON.stringify({
                    sampler: { class_type: 'KSampler', inputs: { seed: 17, steps: 28 } },
                    positive: { class_type: 'CLIPTextEncode', inputs: { text: 'old positive' } },
                    negative: { class_type: 'CLIPTextEncode', inputs: { text: 'old negative' } },
                }),
                posNodeID: 'positive',
                posInputName: 'text',
                negNodeID: 'negative',
                negInputName: 'text',
                timeout: 30,
            },
        }
        mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: 'job-1' } })
        mocks.fetchNative
            .mockResolvedValueOnce({
                json: async () => ({
                    'job-1': {
                        outputs: { save: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
                        status: { messages: [] },
                    },
                }),
            })
            .mockResolvedValueOnce({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })

        const attempt = await generateAIImageTyped(
            'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
        )
        const promptRequest = mocks.globalFetch.mock.calls[0][1] as { body: { prompt: any } }

        expect(promptRequest.body.prompt.sampler.inputs.seed).toBe(17)
        expect(attempt.seedSupported).toBe(true)
        expect(attempt.seedUsed).toBe(17)
    })

    it('keeps the existing Comfy randomization when no seed is supplied', async () => {
        mocks.db = {
            sdProvider: 'comfyui',
            comfyUiUrl: 'http://127.0.0.1:8188/',
            comfyConfig: {
                workflow: JSON.stringify({
                    sampler: { class_type: 'KSampler', inputs: { seed: 17, steps: 28 } },
                    positive: { class_type: 'CLIPTextEncode', inputs: { text: '{{risu_prompt}}' } },
                }),
                timeout: 30,
            },
        }
        mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: 'job-1' } })
        mocks.fetchNative
            .mockResolvedValueOnce({
                json: async () => ({
                    'job-1': {
                        outputs: { save: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
                        status: { messages: [] },
                    },
                }),
            })
            .mockResolvedValueOnce({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })
        const random = vi.spyOn(Math, 'random').mockReturnValue(0.25)

        try {
            const attempt = await generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            const promptRequest = mocks.globalFetch.mock.calls[0][1] as { body: { prompt: any } }
            expect(promptRequest.body.prompt.sampler.inputs.seed).toBe(250000000)
            expect(attempt.seedSupported).toBe(true)
            expect(attempt.seedUsed).toBe(250000000)
            expect(random).toHaveBeenCalledTimes(1)
        } finally {
            random.mockRestore()
        }
    })
})

describe('generateAIImage Comfy polling', () => {
    it.each(['queue_pending', 'queue_running'] as const)(
        'waits past the configured deadline while the job remains in %s and collects completion',
        async (queueLane) => {
            vi.useFakeTimers()
            try {
                const promptId = 'job/1?x'
                const queue: Record<'queue_pending' | 'queue_running', unknown[]> = {
                    queue_pending: [],
                    queue_running: [],
                }
                queue[queueLane] = [[0, promptId]]
                mocks.db = makeComfyUiDatabase(0.5)
                mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
                mocks.fetchNative
                    .mockResolvedValueOnce(jsonResponse({}))
                    .mockResolvedValueOnce(jsonResponse(queue))
                    .mockResolvedValueOnce(jsonResponse({}))
                    .mockResolvedValueOnce(jsonResponse(queue))
                    .mockResolvedValueOnce(jsonResponse(completedComfyHistory(promptId)))
                    .mockResolvedValueOnce({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })

                const resultPromise = generateAIImageTyped(
                    'prompt', currentChar, 'negative', 'inlay', 'interactive',
                    { seed: 9007199254740991 },
                )
                await vi.advanceTimersByTimeAsync(2000)
                const attempt = await resultPromise

                expect(attempt.result.ok).toBe(true)
                expect(attempt.seedSupported).toBe(true)
                expect(attempt.seedUsed).toBe(9007199254740991)
                const urls = mocks.fetchNative.mock.calls.map(([url]) => url)
                expect(urls.filter((url) => url === 'http://127.0.0.1:8188/history/job%2F1%3Fx')).toHaveLength(3)
                expect(urls.filter((url) => url === 'http://127.0.0.1:8188/queue')).toHaveLength(2)
            } finally {
                vi.useRealTimers()
            }
        },
    )

    it('fails after two consecutive observations absent from both queue and history', async () => {
        vi.useFakeTimers()
        try {
            const promptId = 'lost-job'
            const emptyQueue = { queue_pending: [], queue_running: [] }
            mocks.db = makeComfyUiDatabase(0.001)
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
            mocks.fetchNative
                .mockResolvedValueOnce(jsonResponse({}))
                .mockResolvedValueOnce(jsonResponse(emptyQueue))
                .mockResolvedValueOnce(jsonResponse({}))
                .mockResolvedValueOnce(jsonResponse(emptyQueue))

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(1000)
            const attempt = await resultPromise

            expect(attempt.result.ok).toBe(false)
            expect(mocks.alertError).toHaveBeenCalledOnce()
            expect(mocks.alertError).toHaveBeenCalledWith(
                'Error: ComfyUI job disappeared from both queue and history.',
            )
            expect(mocks.alertError.mock.calls[0][0]).not.toMatch(/time/i)
            const urls = mocks.fetchNative.mock.calls.map(([url]) => url)
            expect(urls.filter((url) => url.endsWith('/history/lost-job'))).toHaveLength(2)
            expect(urls.filter((url) => url.endsWith('/queue'))).toHaveLength(2)
        } finally {
            vi.useRealTimers()
        }
    })

    it('resets an absence after rediscovering the job and tolerates a later queue-to-history gap', async () => {
        vi.useFakeTimers()
        try {
            const promptId = 'transition-job'
            const emptyQueue = { queue_pending: [], queue_running: [] }
            const queued = { queue_pending: [[0, promptId]], queue_running: [] }
            mocks.db = makeComfyUiDatabase(0.001)
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
            mocks.fetchNative
                .mockResolvedValueOnce(jsonResponse({}))
                .mockResolvedValueOnce(jsonResponse(emptyQueue))
                .mockResolvedValueOnce(jsonResponse({}))
                .mockResolvedValueOnce(jsonResponse(queued))
                .mockResolvedValueOnce(jsonResponse({}))
                .mockResolvedValueOnce(jsonResponse(emptyQueue))
                .mockResolvedValueOnce(jsonResponse(completedComfyHistory(promptId)))
                .mockResolvedValueOnce({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', { seed: 4294967296 },
            )
            await vi.advanceTimersByTimeAsync(3000)
            const attempt = await resultPromise

            expect(attempt.result.ok).toBe(true)
            expect(attempt.seedUsed).toBe(4294967296)
            expect(mocks.alertError).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('generateAIImage WebUI seed threading', () => {
    it('applies a supplied uint32 seed and exactly reports a safe-integer seed returned by WebUI', async () => {
        mocks.db = makeWebUiDatabase()
        mocks.globalFetch.mockResolvedValue({
            ok: true,
            data: { images: ['AAAA'], info: JSON.stringify({ seed: 9007199254740991 }) },
        })

        const attempt = await generateAIImageTyped(
            'prompt', currentChar, 'negative', 'inlay', 'interactive', { seed: 4294967295 },
        )
        const [, request] = mocks.globalFetch.mock.calls[0] as [string, { body: any }]

        expect(request.body.seed).toBe(4294967295)
        expect(attempt.seedSupported).toBe(true)
        expect(attempt.seedUsed).toBe(9007199254740991)
    })

    it('ignores an unsafe integer returned in WebUI info and falls back to the requested seed', async () => {
        mocks.db = makeWebUiDatabase()
        mocks.globalFetch.mockResolvedValue({
            ok: true,
            data: { images: ['AAAA'], info: JSON.stringify({ seed: 9007199254740992 }) },
        })

        const attempt = await generateAIImageTyped(
            'prompt', currentChar, 'negative', 'inlay', 'interactive', { seed: 123 },
        )

        expect(attempt.seedUsed).toBe(123)
    })

    it('rejects a seed above the WebUI uint32 limit before dispatch', async () => {
        mocks.db = makeWebUiDatabase()

        const attempt = await generateAIImageTyped(
            'prompt', currentChar, 'negative', 'inlay', 'interactive', { seed: 4294967296 },
        )

        expect(attempt.result.ok).toBe(false)
        const failure = attempt.result as Extract<
            import('./stableDiff').ImageGenerationResult,
            { ok: false; certainty: 'definite' }
        >
        expect(failure.certainty).toBe('definite')
        expect(failure.code).toBe('image_seed_invalid')
        expect(failure.reason).toMatch(/WebUI.*4294967295/)
        expect(attempt.compatibilityValue).toBe('')
        expect(mocks.globalFetch).not.toHaveBeenCalled()
    })

    it('preserves the WebUI -1 random sentinel when no seed is supplied', async () => {
        mocks.db = makeWebUiDatabase()
        mocks.globalFetch.mockResolvedValue({
            ok: true,
            data: { images: ['AAAA'], info: JSON.stringify({ seed: 456 }) },
        })

        const attempt = await generateAIImageTyped(
            'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
        )
        const [, request] = mocks.globalFetch.mock.calls[0] as [string, { body: any }]

        expect(request.body.seed).toBe(-1)
        expect(attempt.seedSupported).toBe(true)
        expect(attempt.seedUsed).toBe(456)
    })
})

describe('NAI director reference fields', () => {
    const DIRECTOR_REFERENCE_KEYS = [
        'director_reference_images',
        'director_reference_descriptions',
        'director_reference_information_extracted',
        'director_reference_strength_values',
    ]

    // globalFetch serialises the body with JSON.stringify, so what the provider
    // actually receives is the round-tripped object, not the literal we build.
    // Asserting on the literal would pass on an `undefined` own key, which is
    // exactly the state this suite has to tell apart from a real omission.
    function sentBody() {
        const [, arg] = mocks.globalFetch.mock.calls[0] as [string, { body: unknown }]
        return JSON.parse(JSON.stringify(arg.body)) as Record<string, any>
    }

    function sentParameters() {
        return sentBody().parameters as Record<string, unknown>
    }

    it('sends no director reference key when the reference mode is None', async () => {
        mocks.globalFetch.mockResolvedValue(fetchResult({}))

        await generateAIImage('prompt', currentChar, 'negative', 'inlay')

        const parameters = sentParameters()
        for (const key of DIRECTOR_REFERENCE_KEYS) {
            expect(parameters).not.toHaveProperty(key)
        }
    })

    it('sends no director reference key while vibe transfer is active', async () => {
        mocks.db.NAIImgConfig.reference_mode = 'vibe'
        mocks.db.NAIImgConfig.reference_strength_multiple = [0.6]
        mocks.db.NAIImgConfig.vibe_data = {
            encodings: {
                v4full: {
                    'encoding-a': { encoding: 'ENCODED_VIBE', params: { information_extracted: 1 } },
                },
            },
        }
        mocks.globalFetch.mockResolvedValue(fetchResult({}))

        await generateAIImage('prompt', currentChar, 'negative', 'inlay')

        const parameters = sentParameters()
        expect(parameters.reference_image_multiple).toEqual(['ENCODED_VIBE'])
        expect(parameters.reference_strength_multiple).toEqual([0.6])
        for (const key of DIRECTOR_REFERENCE_KEYS) {
            expect(parameters).not.toHaveProperty(key)
        }
    })

    it('sends no director reference key on a v4.5 model that has no reference attached', async () => {
        mocks.db.NAIImgModel = 'nai-diffusion-4-5-full'
        mocks.globalFetch.mockResolvedValue(fetchResult({}))

        await generateAIImage('prompt', currentChar, 'negative', 'inlay')

        const parameters = sentParameters()
        for (const key of DIRECTOR_REFERENCE_KEYS) {
            expect(parameters).not.toHaveProperty(key)
        }
    })

    it('sends no director reference key when a stale character mode survives a model switch', async () => {
        // Changing the image model leaves reference_mode untouched, so a choice
        // made during a v4.5 session still reads 'character' on v4-full. The model
        // gate guarding the fill-in below is the only thing keeping the keys off
        // the wire here — deleting it would bring the 400 straight back.
        mocks.db.NAIImgConfig.reference_mode = 'character'
        mocks.db.NAIImgConfig.character_image = 'stored-reference'
        mocks.db.NAIImgConfig.character_base64image = 'QkFTRTY0'
        // Stubbed so that dropping the model gate fails this test on the assertion
        // rather than hanging on an onload that happy-dom never fires.
        vi.stubGlobal('Image', class {
            onload: (() => void) | null = null
            set src(_value: string) {
                queueMicrotask(() => this.onload?.())
            }
        })
        mocks.globalFetch.mockResolvedValue(fetchResult({}))

        try {
            await generateAIImage('prompt', currentChar, 'negative', 'inlay')
        } finally {
            vi.unstubAllGlobals()
        }

        const parameters = sentParameters()
        for (const key of DIRECTOR_REFERENCE_KEYS) {
            expect(parameters).not.toHaveProperty(key)
        }
    })

    it('sends no director reference key on the img2img path', async () => {
        mocks.db.NAII2I = true
        mocks.db.NAIImgConfig.image = 'stored-i2i'
        mocks.db.NAIImgConfig.base64image = 'SU1BR0U='
        mocks.globalFetch.mockResolvedValue(fetchResult({}))

        await generateAIImage('prompt', currentChar, 'negative', 'inlay')

        const body = sentBody()
        expect(body.action).toBe('img2img')
        for (const key of DIRECTOR_REFERENCE_KEYS) {
            expect(body.parameters).not.toHaveProperty(key)
        }
    })

    it('sends no director reference key on legacy v3 models', async () => {
        mocks.db.NAIImgModel = 'nai-diffusion-3'
        mocks.globalFetch.mockResolvedValue(fetchResult({}))

        await generateAIImage('prompt', currentChar, 'negative', 'inlay')

        const parameters = sentParameters()
        for (const key of DIRECTOR_REFERENCE_KEYS) {
            expect(parameters).not.toHaveProperty(key)
        }
    })

    it('still attaches all four keys when a v4.5 character reference is in use', async () => {
        // The resize step waits on Image.onload, which never fires in happy-dom.
        vi.stubGlobal('Image', class {
            onload: (() => void) | null = null
            set src(_value: string) {
                queueMicrotask(() => this.onload?.())
            }
        })
        mocks.db.NAIImgModel = 'nai-diffusion-4-5-full'
        mocks.db.NAIImgConfig.reference_mode = 'character'
        mocks.db.NAIImgConfig.character_image = 'stored-reference'
        mocks.db.NAIImgConfig.character_base64image = 'QkFTRTY0'
        mocks.globalFetch.mockResolvedValue(fetchResult({}))

        try {
            await generateAIImage('prompt', currentChar, 'negative', 'inlay')
        } finally {
            vi.unstubAllGlobals()
        }

        const parameters = sentParameters()
        expect(parameters.director_reference_images).toHaveLength(1)
        expect(parameters.director_reference_information_extracted).toEqual([1])
        expect(parameters.director_reference_strength_values).toEqual([1])
        expect(parameters.director_reference_descriptions).toHaveLength(1)
    })
})
