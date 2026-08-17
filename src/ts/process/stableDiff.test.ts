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

const {
    generateAIImage,
    generateAIImageTyped,
    __resetComfyPollersForTest: resetComfyPollersForTest,
} = await import('./stableDiff')

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
    return { ok: true, json: async () => data }
}

function imageResponse(bytes = [1, 2, 3]) {
    return new Response(new Uint8Array(bytes), { status: 200 })
}

function httpErrorResponse(status: number) {
    return {
        ok: false,
        status,
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
    }
}

function globalTransportError(dispatched: boolean, cause: unknown = new TypeError('Failed to fetch')) {
    return {
        name: 'GlobalFetchTransportError',
        message: String(cause),
        globalFetchTransportError: true,
        dispatched,
        transportCause: cause,
    }
}

function globalFetchResponse(status: number, data: unknown = {}) {
    return {
        ok: status >= 200 && status < 300,
        data,
        headers: {},
        status,
    }
}

function typedImageResponse(byteLength: number, bodyMode: 'streaming' | 'buffered' = 'streaming') {
    const response = new Response(new Uint8Array(byteLength), {
        status: 200,
        headers: { 'content-type': 'image/png; charset=binary' },
    })
    return { response, bodyMode }
}

function settleOnAbortOrDelay<T>(
    signal: AbortSignal | undefined,
    value: T,
    delayMs = 30_001,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => resolve(value), delayMs)
        signal?.addEventListener('abort', () => {
            clearTimeout(timeoutId)
            reject(new DOMException('The operation was aborted.', 'AbortError'))
        }, { once: true })
    })
}

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => {
        resolve = done
    })
    return { promise, resolve }
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
    resetComfyPollersForTest()
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
            .mockResolvedValueOnce(jsonResponse({}))
            .mockResolvedValueOnce(jsonResponse({ queue_pending: [], queue_running: [] }))
            .mockResolvedValueOnce(jsonResponse(completedComfyHistory('job-1')))
            .mockResolvedValueOnce(imageResponse())

        const attempt = await generateAIImageTyped(
            'prompt', currentChar, 'negative', 'inlay', 'interactive', { seed },
        )
        const promptRequest = mocks.globalFetch.mock.calls[0][1] as { body: { prompt: any } }

        expect(promptRequest.body.prompt.sampler.inputs.seed).toBe(seed)
        expect(promptRequest.body.prompt.sampler2.inputs.seed).toBe(seed)
        expect(attempt.seedSupported).toBe(true)
        expect(attempt.seedUsed).toBe(seed)
    })

    it('heals brace-stripped whole-value placeholders from exported workflows', async () => {
        const runWorkflow = async (positiveText: string, negativeText: string) => {
            mocks.db = {
                sdProvider: 'comfyui',
                comfyUiUrl: 'http://127.0.0.1:8188/',
                comfyConfig: {
                    workflow: JSON.stringify({
                        sampler: { class_type: 'KSampler', inputs: { seed: 17, steps: 28 } },
                        positive: { class_type: 'CLIPTextEncode', inputs: { text: positiveText } },
                        negative: { class_type: 'CLIPTextEncode', inputs: { text: negativeText } },
                        caption: { class_type: 'Note', inputs: { text: 'risu_prompt is embedded prose' } },
                    }),
                    timeout: 30,
                },
            }
            mocks.globalFetch.mockReset()
            mocks.fetchNative.mockReset()
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: 'job-1' } })
            mocks.fetchNative
                .mockResolvedValueOnce(jsonResponse({}))
                .mockResolvedValueOnce(jsonResponse({ queue_pending: [], queue_running: [] }))
                .mockResolvedValueOnce(jsonResponse(completedComfyHistory('job-1')))
                .mockResolvedValueOnce(imageResponse())
            await generateAIImageTyped('prompt text', currentChar, 'negative text', 'inlay', 'interactive', {})
            return (mocks.globalFetch.mock.calls[0][1] as { body: { prompt: any } }).body.prompt
        }

        const braced = await runWorkflow('{{risu_prompt}}', '{{risu_neg}}')
        const stripped = await runWorkflow('risu_prompt', ' risu_neg ')

        // A whole-value bare placeholder (export tooling strips the braces)
        // heals to the same substitution the braced form receives; a bare
        // token embedded in longer prose stays literal.
        expect(stripped.positive.inputs.text).toBe(braced.positive.inputs.text)
        expect(stripped.negative.inputs.text).toBe(braced.negative.inputs.text)
        expect(stripped.caption.inputs.text).toBe('risu_prompt is embedded prose')
        expect(braced.caption.inputs.text).toBe('risu_prompt is embedded prose')
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
            .mockResolvedValueOnce(jsonResponse({}))
            .mockResolvedValueOnce(jsonResponse({ queue_pending: [], queue_running: [] }))
            .mockResolvedValueOnce(jsonResponse(completedComfyHistory('job-1')))
            .mockResolvedValueOnce(imageResponse())

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
            .mockResolvedValueOnce(jsonResponse({}))
            .mockResolvedValueOnce(jsonResponse({ queue_pending: [], queue_running: [] }))
            .mockResolvedValueOnce(jsonResponse(completedComfyHistory('job-1')))
            .mockResolvedValueOnce(imageResponse())
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
                    .mockResolvedValueOnce(jsonResponse({ queue_pending: [], queue_running: [] }))
                    .mockResolvedValueOnce(jsonResponse(completedComfyHistory(promptId)))
                    .mockResolvedValueOnce(imageResponse())

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
                expect(urls).toEqual([
                    'http://127.0.0.1:8188/history/job%2F1%3Fx',
                    'http://127.0.0.1:8188/queue',
                    'http://127.0.0.1:8188/queue',
                    'http://127.0.0.1:8188/history/job%2F1%3Fx',
                    'http://127.0.0.1:8188/view?filename=out.png&subfolder=&type=output',
                ])
                expect(urls.filter((url) => url === 'http://127.0.0.1:8188/history/job%2F1%3Fx')).toHaveLength(2)
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
                .mockResolvedValueOnce(jsonResponse({}))

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(1500)
            const attempt = await resultPromise

            expect(attempt.result.ok).toBe(false)
            expect(mocks.alertError).toHaveBeenCalledOnce()
            expect(mocks.alertError).toHaveBeenCalledWith(
                'Error: ComfyUI job disappeared from both queue and history.',
            )
            expect(mocks.alertError.mock.calls[0][0]).not.toMatch(/time/i)
            const urls = mocks.fetchNative.mock.calls.map(([url]) => url)
            expect(urls.filter((url) => url.endsWith('/history/lost-job'))).toHaveLength(3)
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
                .mockResolvedValueOnce(jsonResponse(emptyQueue))
                .mockResolvedValueOnce(jsonResponse({}))
                .mockResolvedValueOnce(jsonResponse(emptyQueue))
                .mockResolvedValueOnce(jsonResponse(completedComfyHistory(promptId)))
                .mockResolvedValueOnce(imageResponse())

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', { seed: 4294967296 },
            )
            await vi.advanceTimersByTimeAsync(4500)
            const attempt = await resultPromise

            expect(attempt.result.ok).toBe(true)
            expect(attempt.seedUsed).toBe(4294967296)
            expect(mocks.alertError).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })

    it('shares one in-flight queue request across concurrent Comfy jobs and resolves each output', async () => {
        vi.useFakeTimers()
        try {
            const promptIds = ['bulk-1', 'bulk-2', 'bulk-3', 'bulk-4']
            const emptyQueue = { queue_pending: [], queue_running: [] }
            let promptIndex = 0
            let queueCalls = 0
            let activeQueueCalls = 0
            let maxActiveQueueCalls = 0
            let releaseQueue: (() => void) | undefined

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockImplementation(async () => ({
                ok: true,
                data: { prompt_id: promptIds[promptIndex++] },
            }))
            mocks.fetchNative.mockImplementation((url: string) => {
                if (url.endsWith('/queue')) {
                    queueCalls += 1
                    activeQueueCalls += 1
                    maxActiveQueueCalls = Math.max(maxActiveQueueCalls, activeQueueCalls)
                    return new Promise((resolve) => {
                        releaseQueue = () => {
                            activeQueueCalls -= 1
                            resolve(jsonResponse(emptyQueue))
                        }
                    })
                }
                if (url.includes('/history/')) {
                    const promptId = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
                    const history = completedComfyHistory(promptId)
                    history[promptId].outputs.save.images[0].filename = `${promptId}.png`
                    return Promise.resolve(jsonResponse(history))
                }
                if (url.includes('/view?')) return Promise.resolve(imageResponse())
                throw new Error(`Unexpected URL: ${url}`)
            })

            const resultPromises = promptIds.map(() => generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            ))
            await Promise.resolve()
            await Promise.resolve()
            await vi.advanceTimersByTimeAsync(0)

            expect(queueCalls).toBe(1)
            await vi.advanceTimersByTimeAsync(10_000)
            expect(queueCalls).toBe(1)
            expect(maxActiveQueueCalls).toBe(1)

            releaseQueue?.()
            await vi.advanceTimersByTimeAsync(0)
            const attempts = await Promise.all(resultPromises)

            expect(attempts.every((attempt) => attempt.result.ok)).toBe(true)
            const urls = mocks.fetchNative.mock.calls.map(([url]) => String(url))
            expect(urls.filter((url) => url.endsWith('/queue'))).toHaveLength(1)
            expect(urls.filter((url) => url.includes('/history/')).sort()).toEqual(
                promptIds.map((id) => `http://127.0.0.1:8188/history/${id}`).sort(),
            )
            expect(urls.filter((url) => url.includes('/view?')).map((url) => (
                new URL(url).searchParams.get('filename')
            )).sort()).toEqual(promptIds.map((id) => `${id}.png`).sort())
        } finally {
            vi.useRealTimers()
        }
    })

    it('does not deliver a queue snapshot that started before a later job subscribed', async () => {
        vi.useFakeTimers()
        try {
            const promptIds = ['early-job', 'late-job']
            const firstQueue = deferred<ReturnType<typeof jsonResponse>>()
            const emptyQueue = { queue_pending: [], queue_running: [] }
            let promptIndex = 0
            let queueCalls = 0
            const historyIds: string[] = []
            const historyCounts = new Map<string, number>()

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockImplementation(async () => ({
                ok: true,
                data: { prompt_id: promptIds[promptIndex++] },
            }))
            mocks.fetchNative.mockImplementation((url: string) => {
                if (url.endsWith('/queue')) {
                    queueCalls += 1
                    return queueCalls === 1
                        ? firstQueue.promise
                        : Promise.resolve(jsonResponse(emptyQueue))
                }
                if (url.includes('/history/')) {
                    const promptId = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
                    historyIds.push(promptId)
                    const count = (historyCounts.get(promptId) ?? 0) + 1
                    historyCounts.set(promptId, count)
                    return Promise.resolve(jsonResponse(
                        promptId === 'early-job' && count === 1
                            ? {}
                            : completedComfyHistory(promptId),
                    ))
                }
                if (url.includes('/view?')) return Promise.resolve(imageResponse())
                throw new Error(`Unexpected URL: ${url}`)
            })

            const earlyResult = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await Promise.resolve()
            await vi.advanceTimersByTimeAsync(0)
            expect(queueCalls).toBe(1)

            const lateResult = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await Promise.resolve()
            firstQueue.resolve(jsonResponse(emptyQueue))
            await vi.advanceTimersByTimeAsync(0)

            expect((await earlyResult).result.ok).toBe(true)
            expect(historyIds).toEqual(['early-job', 'early-job'])

            await vi.advanceTimersByTimeAsync(1500)
            expect((await lateResult).result.ok).toBe(true)
            expect(historyIds).toEqual(['early-job', 'early-job', 'late-job'])
            expect(queueCalls).toBe(2)
        } finally {
            vi.useRealTimers()
        }
    })

    it('keeps a retiring in-flight poller shared when another job subscribes', async () => {
        vi.useFakeTimers()
        try {
            const promptIds = ['retiring-job', 'replacement-job']
            const retiringHistory = deferred<ReturnType<typeof jsonResponse>>()
            const retiringQueue = deferred<ReturnType<typeof jsonResponse>>()
            const emptyQueue = { queue_pending: [], queue_running: [] }
            let promptIndex = 0
            let queueCalls = 0
            let activeQueueCalls = 0
            let maxActiveQueueCalls = 0
            const historyIds: string[] = []

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockImplementation(async () => ({
                ok: true,
                data: { prompt_id: promptIds[promptIndex++] },
            }))
            mocks.fetchNative.mockImplementation((url: string) => {
                if (url.endsWith('/queue')) {
                    queueCalls += 1
                    activeQueueCalls += 1
                    maxActiveQueueCalls = Math.max(maxActiveQueueCalls, activeQueueCalls)
                    if (queueCalls === 2) {
                        return retiringQueue.promise.finally(() => {
                            activeQueueCalls -= 1
                        })
                    }
                    activeQueueCalls -= 1
                    return Promise.resolve(jsonResponse(emptyQueue))
                }
                if (url.includes('/history/')) {
                    const promptId = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
                    historyIds.push(promptId)
                    return promptId === 'retiring-job'
                        ? retiringHistory.promise
                        : Promise.resolve(jsonResponse(completedComfyHistory(promptId)))
                }
                if (url.includes('/view?')) return Promise.resolve(imageResponse())
                throw new Error(`Unexpected URL: ${url}`)
            })

            const retiringResult = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(0)
            await vi.advanceTimersByTimeAsync(1500)
            expect(queueCalls).toBe(2)
            expect(activeQueueCalls).toBe(1)

            retiringHistory.resolve(jsonResponse(completedComfyHistory('retiring-job')))
            await vi.advanceTimersByTimeAsync(0)
            expect((await retiringResult).result.ok).toBe(true)

            const replacementResult = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await Promise.resolve()
            expect(queueCalls).toBe(2)

            retiringQueue.resolve(jsonResponse(emptyQueue))
            await vi.advanceTimersByTimeAsync(0)
            expect(historyIds).toEqual(['retiring-job'])

            await vi.advanceTimersByTimeAsync(1500)
            expect((await replacementResult).result.ok).toBe(true)
            expect(historyIds).toEqual(['retiring-job', 'replacement-job'])
            expect(queueCalls).toBe(3)
            expect(maxActiveQueueCalls).toBe(1)
        } finally {
            vi.useRealTimers()
        }
    })

    it.each([
        ['a rejected request', () => Promise.reject(new TypeError('queue transport failed'))],
        ['a malformed response', () => Promise.resolve(jsonResponse({ queue_pending: 'bad', queue_running: [] }))],
    ])('survives %s while polling and completes after a valid queue observation', async (_label, firstQueueResult) => {
        vi.useFakeTimers()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const promptId = 'transport-job'
            const emptyQueue = { queue_pending: [], queue_running: [] }
            let queueAttempts = 0

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
            mocks.fetchNative.mockImplementation((url: string) => {
                if (url.endsWith('/queue')) {
                    queueAttempts += 1
                    return queueAttempts === 1
                        ? firstQueueResult()
                        : Promise.resolve(jsonResponse(emptyQueue))
                }
                if (url.includes('/history/')) {
                    return Promise.resolve(jsonResponse(
                        queueAttempts === 0 ? {} : completedComfyHistory(promptId),
                    ))
                }
                if (url.includes('/view?')) return Promise.resolve(imageResponse())
                throw new Error(`Unexpected URL: ${url}`)
            })

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(1000)
            const attempt = await resultPromise

            expect(attempt.result.ok).toBe(true)
            expect(queueAttempts).toBe(2)
            expect(mocks.alertError).not.toHaveBeenCalled()
            expect(mocks.notifyError).not.toHaveBeenCalled()
        } finally {
            warn.mockRestore()
            vi.useRealTimers()
        }
    })

    it('does not count a failed queue poll between two valid absence observations', async () => {
        vi.useFakeTimers()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const promptId = 'interleaved-absence-job'
            const emptyQueue = { queue_pending: [], queue_running: [] }
            let queueAttempts = 0
            let historyAttempts = 0

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
            mocks.fetchNative.mockImplementation((url: string) => {
                if (url.endsWith('/queue')) {
                    queueAttempts += 1
                    if (queueAttempts === 2) return Promise.reject(new TypeError('temporary queue outage'))
                    return Promise.resolve(jsonResponse(emptyQueue))
                }
                if (url.includes('/history/')) {
                    historyAttempts += 1
                    return Promise.resolve(jsonResponse({}))
                }
                throw new Error(`Unexpected URL: ${url}`)
            })

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(2500)
            const attempt = await resultPromise

            expect(attempt.result.ok).toBe(false)
            expect(queueAttempts).toBe(3)
            expect(historyAttempts).toBe(3)
            expect(mocks.alertError).toHaveBeenCalledOnce()
            expect(mocks.alertError).toHaveBeenCalledWith(
                'Error: ComfyUI job disappeared from both queue and history.',
            )
        } finally {
            warn.mockRestore()
            vi.useRealTimers()
        }
    })

    it('retries a rejected history poll indefinitely and later completes', async () => {
        vi.useFakeTimers()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const promptId = 'history-retry-job'
            const emptyQueue = { queue_pending: [], queue_running: [] }
            let historyAttempts = 0

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
            mocks.fetchNative.mockImplementation((url: string) => {
                if (url.endsWith('/queue')) return Promise.resolve(jsonResponse(emptyQueue))
                if (url.includes('/history/')) {
                    historyAttempts += 1
                    return historyAttempts === 1
                        ? Promise.reject(new TypeError('history transport failed'))
                        : Promise.resolve(jsonResponse(completedComfyHistory(promptId)))
                }
                if (url.includes('/view?')) return Promise.resolve(imageResponse())
                throw new Error(`Unexpected URL: ${url}`)
            })

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(1000)
            const attempt = await resultPromise

            expect(attempt.result.ok).toBe(true)
            expect(historyAttempts).toBe(2)
            expect(mocks.notifyError).not.toHaveBeenCalled()
        } finally {
            warn.mockRestore()
            vi.useRealTimers()
        }
    })

    it('retries a malformed history item instead of treating it as a no-output result', async () => {
        vi.useFakeTimers()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const promptId = 'malformed-history-job'
            const emptyQueue = { queue_pending: [], queue_running: [] }
            let historyAttempts = 0

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
            mocks.fetchNative.mockImplementation((url: string) => {
                if (url.endsWith('/queue')) return Promise.resolve(jsonResponse(emptyQueue))
                if (url.includes('/history/')) {
                    historyAttempts += 1
                    return historyAttempts === 1
                        ? Promise.resolve(jsonResponse({
                            [promptId]: { outputs: null, status: { messages: [] } },
                        }))
                        : Promise.resolve(jsonResponse(completedComfyHistory(promptId)))
                }
                if (url.includes('/view?')) return Promise.resolve(imageResponse())
                throw new Error(`Unexpected URL: ${url}`)
            })

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(1000)
            const attempt = await resultPromise

            expect(attempt.result.ok).toBe(true)
            expect(historyAttempts).toBe(2)
            expect(mocks.alertError).not.toHaveBeenCalled()
        } finally {
            warn.mockRestore()
            vi.useRealTimers()
        }
    })

    it('logs one queue failure transition and one recovery across repeated retry attempts', async () => {
        vi.useFakeTimers()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const promptId = 'warning-state-job'
            const emptyQueue = { queue_pending: [], queue_running: [] }
            let queueAttempts = 0
            let historyAttempts = 0

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
            mocks.fetchNative.mockImplementation((url: string) => {
                if (url.endsWith('/queue')) {
                    queueAttempts += 1
                    return queueAttempts < 3
                        ? Promise.reject(new TypeError('queue unavailable'))
                        : Promise.resolve(jsonResponse(emptyQueue))
                }
                if (url.includes('/history/')) {
                    historyAttempts += 1
                    return Promise.resolve(jsonResponse(
                        historyAttempts === 1 ? {} : completedComfyHistory(promptId),
                    ))
                }
                if (url.includes('/view?')) return Promise.resolve(imageResponse())
                throw new Error(`Unexpected URL: ${url}`)
            })

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(3000)
            expect((await resultPromise).result.ok).toBe(true)

            expect(queueAttempts).toBe(3)
            expect(warn).toHaveBeenCalledTimes(2)
            expect(String(warn.mock.calls[0][0])).toMatch(/failed.*retrying indefinitely/i)
            expect(String(warn.mock.calls[1][0])).toMatch(/recovered/i)
        } finally {
            warn.mockRestore()
            vi.useRealTimers()
        }
    })

    it('keeps a valid empty outputs object on the existing definite no-output path', async () => {
        vi.useFakeTimers()
        try {
            const promptId = 'no-output-job'
            const emptyQueue = { queue_pending: [], queue_running: [] }

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
            mocks.fetchNative
                .mockResolvedValueOnce(jsonResponse({}))
                .mockResolvedValueOnce(jsonResponse(emptyQueue))
                .mockResolvedValueOnce(jsonResponse({
                    [promptId]: { outputs: {}, status: { messages: [] } },
                }))

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(0)
            const attempt = await resultPromise

            expect(attempt.result).toEqual({
                ok: false,
                certainty: 'definite',
                reason: 'Image generation failed',
            })
            expect(mocks.alertError).toHaveBeenCalledWith(
                'Error: ComfyUI returned no image. Check that the workflow has a SaveImage output node.',
            )
            expect(mocks.fetchNative).toHaveBeenCalledTimes(3)
        } finally {
            vi.useRealTimers()
        }
    })

    it('keeps a real Comfy execution error on the existing definite failure path', async () => {
        const promptId = 'execution-error-job'

        mocks.db = makeComfyUiDatabase()
        mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
        mocks.fetchNative.mockResolvedValueOnce(jsonResponse({
            [promptId]: {
                outputs: {},
                status: {
                    messages: [[
                        'execution_error',
                        {
                            node_type: 'KSampler',
                            exception_type: 'RuntimeError',
                            exception_message: 'CUDA failure',
                        },
                    ]],
                },
            },
        }))

        const attempt = await generateAIImageTyped(
            'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
        )

        expect(attempt.result).toEqual({
            ok: false,
            certainty: 'definite',
            reason: 'Image generation failed',
        })
        expect(mocks.alertError).toHaveBeenCalledWith(
            'Error: ComfyUI execution_error (KSampler: RuntimeError: CUDA failure)',
        )
        expect(mocks.fetchNative).toHaveBeenCalledOnce()
    })

    it('keeps a genuine HTTP 400 POST rejection definite', async () => {
        mocks.db = makeComfyUiDatabase()
        mocks.globalFetch.mockResolvedValue({
            ok: false,
            data: { error: 'prompt rejected' },
            headers: {},
            status: 400,
        })

        const attempt = await generateAIImageTyped(
            'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
        )

        expect(attempt.result).toEqual({
            ok: false,
            certainty: 'definite',
            reason: 'Image generation failed',
        })
        expect(mocks.fetchNative).not.toHaveBeenCalled()
        expect(mocks.globalFetch).toHaveBeenCalledOnce()
        expect(mocks.notifyError).toHaveBeenCalledOnce()
    })

    it.each([
        null,
        {},
        { prompt_id: '' },
    ])('reports malformed 2xx prompt acknowledgement %# as uncertain', async (data) => {
        mocks.db = makeComfyUiDatabase()
        mocks.globalFetch.mockResolvedValue({
            ok: true,
            data,
            headers: {},
            status: 200,
        })

        const attempt = await generateAIImageTyped(
            'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
        )

        expect(attempt.result).toMatchObject({
            ok: false,
            certainty: 'uncertain',
        })
        expect(mocks.fetchNative).not.toHaveBeenCalled()
        expect(mocks.globalFetch).toHaveBeenCalledOnce()
    })

    it('keeps a decoded-failure HTTP 200 prompt acknowledgement uncertain without probing', async () => {
        mocks.db = makeComfyUiDatabase()
        mocks.globalFetch.mockResolvedValue({
            ok: false,
            data: 'SyntaxError: Unexpected token in JSON',
            headers: {},
            status: 200,
        })

        const attempt = await generateAIImageTyped(
            'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
        )

        expect(attempt.result).toMatchObject({
            ok: false,
            certainty: 'uncertain',
        })
        expect(mocks.globalFetch).toHaveBeenCalledOnce()
        expect(mocks.globalFetch).toHaveBeenCalledWith(
            'http://127.0.0.1:8188/prompt',
            expect.objectContaining({ method: 'POST' }),
        )
        expect(mocks.fetchNative).not.toHaveBeenCalled()
    })

    it('keeps a proven pre-dispatch POST failure definite without probing', async () => {
        mocks.db = makeComfyUiDatabase()
        mocks.globalFetch.mockRejectedValue(globalTransportError(false))

        const attempt = await generateAIImageTyped(
            'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
        )

        expect(attempt.result).toEqual({
            ok: false,
            certainty: 'definite',
            reason: 'Image generation failed',
        })
        expect(mocks.globalFetch).toHaveBeenCalledOnce()
        expect(mocks.fetchNative).not.toHaveBeenCalled()
    })

    it('downgrades a dispatched POST transport failure when its one-shot queue probe cannot connect', async () => {
        mocks.db = makeComfyUiDatabase()
        mocks.globalFetch
            .mockRejectedValueOnce(globalTransportError(true))
            .mockRejectedValueOnce(globalTransportError(true, new TypeError('queue connect failed')))

        const attempt = await generateAIImageTyped(
            'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
        )

        expect(attempt.result).toEqual({
            ok: false,
            certainty: 'definite',
            reason: 'Image generation failed',
        })
        expect(mocks.globalFetch).toHaveBeenCalledTimes(2)
        expect(mocks.globalFetch.mock.calls.map(([url]) => url)).toEqual([
            'http://127.0.0.1:8188/prompt',
            'http://127.0.0.1:8188/queue',
        ])
        expect(mocks.fetchNative).not.toHaveBeenCalled()
    })

    it.each([200, 404])(
        'keeps a dispatched POST transport failure uncertain when the queue probe receives HTTP %s',
        async (probeStatus) => {
            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch
                .mockRejectedValueOnce(globalTransportError(true))
                .mockResolvedValueOnce(globalFetchResponse(probeStatus, {
                    queue_pending: [],
                    queue_running: [],
                }))

            const attempt = await generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )

            expect(attempt.result).toMatchObject({
                ok: false,
                certainty: 'uncertain',
            })
            expect(mocks.globalFetch).toHaveBeenCalledTimes(2)
            expect(mocks.globalFetch.mock.calls.map(([url]) => url)).toEqual([
                'http://127.0.0.1:8188/prompt',
                'http://127.0.0.1:8188/queue',
            ])
            expect(mocks.fetchNative).not.toHaveBeenCalled()
        },
    )

    it('keeps a dispatched POST transport failure uncertain when the probe itself fails before dispatch', async () => {
        mocks.db = makeComfyUiDatabase()
        mocks.globalFetch
            .mockRejectedValueOnce(globalTransportError(true))
            .mockRejectedValueOnce(globalTransportError(false, new TypeError('auth refresh failed')))

        const attempt = await generateAIImageTyped(
            'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
        )

        expect(attempt.result).toMatchObject({
            ok: false,
            certainty: 'uncertain',
        })
        expect(mocks.globalFetch).toHaveBeenCalledTimes(2)
        expect(mocks.globalFetch.mock.calls.map(([url]) => url)).toEqual([
            'http://127.0.0.1:8188/prompt',
            'http://127.0.0.1:8188/queue',
        ])
        expect(mocks.fetchNative).not.toHaveBeenCalled()
    })

    it('opts the prompt into the 600 second request bound', async () => {
        mocks.db = makeComfyUiDatabase()
        mocks.globalFetch.mockRejectedValue(globalTransportError(false))

        await generateAIImageTyped(
            'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
        )

        expect(mocks.globalFetch).toHaveBeenCalledWith(
            'http://127.0.0.1:8188/prompt',
            expect.objectContaining({
                method: 'POST',
                requestTimeoutMs: 600_000,
                throwOnTransportError: true,
            }),
        )
    })

    it('allows a prompt response after 30 seconds under the 600 second request bound', async () => {
        vi.useFakeTimers()
        try {
            const promptId = 'slow-prompt-ack'
            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockImplementationOnce((_url, options: { requestTimeoutMs?: number }) => (
                new Promise(resolve => setTimeout(() => resolve({
                    ok: true,
                    data: { prompt_id: promptId },
                    headers: {},
                    status: 200,
                }), 30_001))
            ))
            mocks.fetchNative.mockImplementation((url: string) => {
                if (url.includes('/history/')) {
                    return Promise.resolve(jsonResponse(completedComfyHistory(promptId)))
                }
                if (url.includes('/view?')) return Promise.resolve(imageResponse())
                throw new Error(`Unexpected URL: ${url}`)
            })

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(30_100)

            expect((await resultPromise).result.ok).toBe(true)
            expect(mocks.globalFetch).toHaveBeenCalledWith(
                'http://127.0.0.1:8188/prompt',
                expect.objectContaining({ requestTimeoutMs: 600_000 }),
            )
        } finally {
            vi.useRealTimers()
        }
    })

    it('keeps a gateway HTTP 502 POST response uncertain when its queue probe reaches Comfy', async () => {
        mocks.db = makeComfyUiDatabase()
        mocks.globalFetch
            .mockResolvedValueOnce(globalFetchResponse(502, { error: 'upstream response lost' }))
            .mockResolvedValueOnce(globalFetchResponse(200, { queue_pending: [], queue_running: [] }))

        const attempt = await generateAIImageTyped(
            'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
        )

        expect(attempt.result).toMatchObject({
            ok: false,
            certainty: 'uncertain',
        })
        expect(mocks.globalFetch).toHaveBeenCalledTimes(2)
        expect(mocks.fetchNative).not.toHaveBeenCalled()
    })

    it('downgrades a gateway HTTP 502 POST response when the queue probe also returns 502', async () => {
        mocks.db = makeComfyUiDatabase()
        mocks.globalFetch
            .mockResolvedValueOnce(globalFetchResponse(502, { error: 'upstream response lost' }))
            .mockResolvedValueOnce(globalFetchResponse(502, { error: 'queue upstream unavailable' }))

        const attempt = await generateAIImageTyped(
            'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
        )

        expect(attempt.result).toEqual({
            ok: false,
            certainty: 'definite',
            reason: 'Image generation failed',
        })
        expect(mocks.globalFetch).toHaveBeenCalledTimes(2)
        expect(mocks.globalFetch.mock.calls.map(([url]) => url)).toEqual([
            'http://127.0.0.1:8188/prompt',
            'http://127.0.0.1:8188/queue',
        ])
        expect(mocks.fetchNative).not.toHaveBeenCalled()
    })

    it('retries the final image download after a transport rejection', async () => {
        vi.useFakeTimers()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const promptId = 'view-retry-job'
            const emptyQueue = { queue_pending: [], queue_running: [] }
            let viewAttempts = 0

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
            mocks.fetchNative.mockImplementation((url: string) => {
                if (url.endsWith('/queue')) return Promise.resolve(jsonResponse(emptyQueue))
                if (url.includes('/history/')) {
                    return Promise.resolve(jsonResponse(completedComfyHistory(promptId)))
                }
                if (url.includes('/view?')) {
                    viewAttempts += 1
                    return viewAttempts === 1
                        ? Promise.reject(new TypeError('view transport failed'))
                        : Promise.resolve(imageResponse())
                }
                throw new Error(`Unexpected URL: ${url}`)
            })

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(1000)
            const attempt = await resultPromise

            expect(attempt.result.ok).toBe(true)
            expect(viewAttempts).toBe(2)
            expect(mocks.notifyError).not.toHaveBeenCalled()
        } finally {
            warn.mockRestore()
            vi.useRealTimers()
        }
    })

    it('aborts a half-open shared queue request and recovers jobs that joined before and during it', async () => {
        vi.useFakeTimers()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const promptIds = ['half-open-early', 'half-open-late']
            const emptyQueue = { queue_pending: [], queue_running: [] }
            const historyCounts = new Map<string, number>()
            let promptIndex = 0
            let queueAttempts = 0

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockImplementation(async () => ({
                ok: true,
                data: { prompt_id: promptIds[promptIndex++] },
            }))
            mocks.fetchNative.mockImplementation((url: string, options: { signal?: AbortSignal }) => {
                if (url.endsWith('/queue')) {
                    queueAttempts += 1
                    return queueAttempts === 1
                        ? settleOnAbortOrDelay(options.signal, jsonResponse(emptyQueue))
                        : Promise.resolve(jsonResponse(emptyQueue))
                }
                if (url.includes('/history/')) {
                    const promptId = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
                    const count = (historyCounts.get(promptId) ?? 0) + 1
                    historyCounts.set(promptId, count)
                    return Promise.resolve(jsonResponse(
                        promptId === promptIds[0] && count === 1
                            ? {}
                            : completedComfyHistory(promptId),
                    ))
                }
                if (url.includes('/view?')) return Promise.resolve(imageResponse())
                throw new Error(`Unexpected URL: ${url}`)
            })

            const earlyResult = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(0)
            expect(queueAttempts).toBe(1)

            const lateResult = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await Promise.resolve()
            await vi.advanceTimersByTimeAsync(31_100)

            const attempts = await Promise.all([earlyResult, lateResult])
            expect(attempts.every((attempt) => attempt.result.ok)).toBe(true)
            expect(queueAttempts).toBe(2)
            const queueOptions = mocks.fetchNative.mock.calls
                .filter(([url]) => String(url).endsWith('/queue'))
                .map(([, options]) => options)
            expect(queueOptions).toEqual([
                expect.objectContaining({ requestTimeoutMs: 30_000, signal: expect.any(AbortSignal) }),
                expect.objectContaining({ requestTimeoutMs: 30_000, signal: expect.any(AbortSignal) }),
            ])
        } finally {
            warn.mockRestore()
            vi.useRealTimers()
        }
    })

    it('bounds a stalled history response body and retries after abort', async () => {
        vi.useFakeTimers()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const promptId = 'history-body-stall'
            const queued = { queue_pending: [[0, promptId]], queue_running: [] }
            let historyAttempts = 0

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
            mocks.fetchNative.mockImplementation((url: string, options: { signal?: AbortSignal }) => {
                if (url.endsWith('/queue')) return Promise.resolve(jsonResponse(queued))
                if (url.includes('/history/')) {
                    historyAttempts += 1
                    return Promise.resolve({
                        ok: true,
                        json: () => historyAttempts === 1
                            ? new Promise(() => {})
                            : Promise.resolve(completedComfyHistory(promptId)),
                    })
                }
                if (url.includes('/view?')) return Promise.resolve(imageResponse())
                throw new Error(`Unexpected URL: ${url}`)
            })

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(31_100)
            expect((await resultPromise).result.ok).toBe(true)
            expect(historyAttempts).toBe(2)
            const historyOptions = mocks.fetchNative.mock.calls
                .filter(([url]) => String(url).includes('/history/'))
                .map(([, options]) => options)
            expect(historyOptions).toEqual([
                expect.objectContaining({ requestTimeoutMs: 30_000, signal: expect.any(AbortSignal) }),
                expect.objectContaining({ requestTimeoutMs: 30_000, signal: expect.any(AbortSignal) }),
            ])
        } finally {
            warn.mockRestore()
            vi.useRealTimers()
        }
    })

    it('allows a progressing image stream to outlive the 30 second request interval', async () => {
        vi.useFakeTimers()
        try {
            const promptId = 'view-slow-progress'
            let viewAttempts = 0

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
            mocks.fetchNative.mockImplementation((url: string, options: { signal?: AbortSignal }) => {
                if (url.includes('/history/')) {
                    return Promise.resolve(jsonResponse(completedComfyHistory(promptId)))
                }
                if (url.includes('/view?')) {
                    viewAttempts += 1
                    if (viewAttempts > 1) return Promise.resolve(httpErrorResponse(400))
                    return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
                        start(controller) {
                            const timers = [20_000, 40_000, 60_000].map((delay, index) => setTimeout(() => {
                                controller.enqueue(new Uint8Array([index + 1]))
                                if (index === 2) controller.close()
                            }, delay))
                            options.signal?.addEventListener('abort', () => {
                                timers.forEach(clearTimeout)
                                controller.error(options.signal?.reason)
                            }, { once: true })
                        },
                    })))
                }
                throw new Error(`Unexpected URL: ${url}`)
            })

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(60_100)

            expect((await resultPromise).result.ok).toBe(true)
            expect(viewAttempts).toBe(1)
        } finally {
            vi.useRealTimers()
        }
    })

    it('allows the buffered userscript image path to outlive 30 seconds within its request bound', async () => {
        vi.useFakeTimers()
        try {
            const promptId = 'view-buffered-userscript'
            let viewAttempts = 0

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
            mocks.fetchNative.mockImplementation((url: string, options: {
                signal?: AbortSignal
                onResponseBodyMode?: (mode: 'streaming' | 'buffered') => void
            }) => {
                if (url.includes('/history/')) {
                    return Promise.resolve(jsonResponse(completedComfyHistory(promptId)))
                }
                if (url.includes('/view?')) {
                    viewAttempts += 1
                    options.onResponseBodyMode?.('buffered')
                    return viewAttempts === 1
                        ? settleOnAbortOrDelay(options.signal, imageResponse(), 30_001)
                        : Promise.resolve(httpErrorResponse(400))
                }
                throw new Error(`Unexpected URL: ${url}`)
            })

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(30_100)

            expect((await resultPromise).result.ok).toBe(true)
            expect(viewAttempts).toBe(1)
        } finally {
            vi.useRealTimers()
        }
    })

    it('bounds a buffered userscript image request even when its transport ignores abort', async () => {
        vi.useFakeTimers()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const promptId = 'view-buffered-userscript-timeout'
            let viewAttempts = 0
            const viewSignals: AbortSignal[] = []

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
            mocks.fetchNative.mockImplementation((url: string, options: {
                signal?: AbortSignal
                onResponseBodyMode?: (mode: 'streaming' | 'buffered') => void
            }) => {
                if (url.includes('/history/')) {
                    return Promise.resolve(jsonResponse(completedComfyHistory(promptId)))
                }
                if (url.includes('/view?')) {
                    viewAttempts += 1
                    if (options.signal) viewSignals.push(options.signal)
                    options.onResponseBodyMode?.('buffered')
                    return viewAttempts === 1
                        ? new Promise<Response>(() => {})
                        : Promise.resolve(imageResponse())
                }
                throw new Error(`Unexpected URL: ${url}`)
            })

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(601_100)

            expect((await resultPromise).result.ok).toBe(true)
            expect(viewAttempts).toBe(2)
            expect(viewSignals[0]?.aborted).toBe(true)
        } finally {
            warn.mockRestore()
            vi.useRealTimers()
        }
    })

    it('aborts a byte-idle image stream and retries the attempt', async () => {
        vi.useFakeTimers()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const promptId = 'view-body-stall'
            let viewAttempts = 0
            const viewSignals: AbortSignal[] = []

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
            mocks.fetchNative.mockImplementation((url: string, options: { signal?: AbortSignal }) => {
                if (url.includes('/history/')) {
                    return Promise.resolve(jsonResponse(completedComfyHistory(promptId)))
                }
                if (url.includes('/view?')) {
                    viewAttempts += 1
                    if (options.signal) viewSignals.push(options.signal)
                    if (viewAttempts > 1) return Promise.resolve(imageResponse())
                    return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(new Uint8Array([1]))
                        },
                        cancel: () => new Promise<void>(() => {}),
                    })))
                }
                throw new Error(`Unexpected URL: ${url}`)
            })

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(31_100)
            expect((await resultPromise).result.ok).toBe(true)
            expect(viewAttempts).toBe(2)
            expect(viewSignals[0]?.aborted).toBe(true)
            const viewOptions = mocks.fetchNative.mock.calls
                .filter(([url]) => String(url).includes('/view?'))
                .map(([, options]) => options)
            expect(viewOptions).toEqual([
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
            ])
            expect(viewOptions.every((options) => options.requestTimeoutMs === undefined)).toBe(true)
        } finally {
            warn.mockRestore()
            vi.useRealTimers()
        }
    })

    it.each([
        { bodyMode: 'streaming' as const, rejectedBytes: 0 },
        { bodyMode: 'buffered' as const, rejectedBytes: 0 },
        { bodyMode: 'streaming' as const, rejectedBytes: 63 },
        { bodyMode: 'buffered' as const, rejectedBytes: 63 },
    ])('retries a $bodyMode image response with $rejectedBytes structural bytes', async ({ bodyMode, rejectedBytes }) => {
        vi.useFakeTimers()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const promptId = `view-${bodyMode}-${rejectedBytes}`
            const emptyQueue = { queue_pending: [], queue_running: [] }
            let viewAttempts = 0

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
            mocks.fetchNative.mockImplementation((url: string, options: {
                onResponseBodyMode?: (mode: 'streaming' | 'buffered') => void
            }) => {
                if (url.endsWith('/queue')) return Promise.resolve(jsonResponse(emptyQueue))
                if (url.includes('/history/')) {
                    return Promise.resolve(jsonResponse(completedComfyHistory(promptId)))
                }
                if (url.includes('/view?')) {
                    viewAttempts += 1
                    options.onResponseBodyMode?.(bodyMode)
                    return Promise.resolve(typedImageResponse(
                        viewAttempts === 1 ? rejectedBytes : 64,
                        bodyMode,
                    ).response)
                }
                throw new Error(`Unexpected URL: ${url}`)
            })

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(1100)

            expect((await resultPromise).result.ok).toBe(true)
            expect(viewAttempts).toBe(2)
        } finally {
            warn.mockRestore()
            vi.useRealTimers()
        }
    })

    it('retries when reader.read rejects and does not strand the later attempt', async () => {
        vi.useFakeTimers()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const promptId = 'view-reader-rejection'
            const emptyQueue = { queue_pending: [], queue_running: [] }
            let viewAttempts = 0

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
            mocks.fetchNative.mockImplementation((url: string) => {
                if (url.endsWith('/queue')) return Promise.resolve(jsonResponse(emptyQueue))
                if (url.includes('/history/')) {
                    return Promise.resolve(jsonResponse(completedComfyHistory(promptId)))
                }
                if (url.includes('/view?')) {
                    viewAttempts += 1
                    if (viewAttempts > 1) return Promise.resolve(imageResponse())
                    return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.error(new TypeError('reader transport failed'))
                        },
                    })))
                }
                throw new Error(`Unexpected URL: ${url}`)
            })

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(1100)

            expect((await resultPromise).result.ok).toBe(true)
            expect(viewAttempts).toBe(2)
        } finally {
            warn.mockRestore()
            vi.useRealTimers()
        }
    })

    it('attaches a rejection observer to every reader promise before racing it', async () => {
        const promptId = 'view-reader-observer'
        const readPromises = [
            Promise.resolve({ done: false, value: new Uint8Array([1, 2, 3]) }),
            Promise.resolve({ done: true, value: undefined }),
        ]
        const catchSpies = readPromises.map(promise => vi.spyOn(promise, 'catch'))
        const reader = {
            read: vi.fn(() => readPromises.shift() ?? Promise.resolve({ done: true, value: undefined })),
            cancel: vi.fn(() => Promise.resolve()),
            releaseLock: vi.fn(),
        }

        mocks.db = makeComfyUiDatabase()
        mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
        mocks.fetchNative.mockImplementation((url: string) => {
            if (url.includes('/history/')) {
                return Promise.resolve(jsonResponse(completedComfyHistory(promptId)))
            }
            if (url.includes('/view?')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers(),
                    body: { getReader: () => reader },
                })
            }
            throw new Error(`Unexpected URL: ${url}`)
        })

        const attempt = await generateAIImageTyped(
            'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
        )

        expect(attempt.result.ok).toBe(true)
        expect(reader.read).toHaveBeenCalledTimes(2)
        expect(catchSpies.every(spy => spy.mock.calls.length === 1)).toBe(true)
    })

    it('resets the bounded 4xx ladder after transport evidence', async () => {
        vi.useFakeTimers()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const promptId = 'history-ladder-reset'
            const emptyQueue = { queue_pending: [], queue_running: [] }
            let historyAttempts = 0

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
            mocks.fetchNative.mockImplementation((url: string) => {
                if (url.endsWith('/queue')) return Promise.resolve(jsonResponse(emptyQueue))
                if (url.includes('/history/')) {
                    historyAttempts += 1
                    if (historyAttempts === 2) return Promise.reject(new TypeError('route transport failed'))
                    if (historyAttempts <= 4) return Promise.resolve(httpErrorResponse(404))
                    return Promise.resolve(jsonResponse(completedComfyHistory(promptId)))
                }
                if (url.includes('/view?')) return Promise.resolve(imageResponse())
                throw new Error(`Unexpected URL: ${url}`)
            })

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(5100)

            expect((await resultPromise).result.ok).toBe(true)
            expect(historyAttempts).toBe(5)
        } finally {
            warn.mockRestore()
            vi.useRealTimers()
        }
    })

    it('survives more than three history 404s while the shared queue poller is unhealthy', async () => {
        vi.useFakeTimers()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const promptId = 'history-route-flap'
            const emptyQueue = { queue_pending: [], queue_running: [] }
            const queueRecovery = deferred<ReturnType<typeof jsonResponse>>()
            const startedAt = Date.now()
            let queueAttempts = 0
            let historyAttempts = 0
            let settled = false

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
            mocks.fetchNative.mockImplementation((url: string) => {
                if (url.endsWith('/queue')) {
                    queueAttempts += 1
                    if (queueAttempts === 1) return Promise.resolve(httpErrorResponse(502))
                    if (queueAttempts === 2) return queueRecovery.promise
                    return Promise.resolve(jsonResponse(emptyQueue))
                }
                if (url.includes('/history/')) {
                    historyAttempts += 1
                    return Date.now() - startedAt < 8_000
                        ? Promise.resolve(httpErrorResponse(404))
                        : Promise.resolve(jsonResponse(completedComfyHistory(promptId)))
                }
                if (url.includes('/view?')) return Promise.resolve(imageResponse())
                throw new Error(`Unexpected URL: ${url}`)
            })

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            void resultPromise.then(() => { settled = true })
            await vi.advanceTimersByTimeAsync(7_900)

            expect(historyAttempts).toBeGreaterThan(3)
            expect(settled).toBe(false)
            queueRecovery.resolve(jsonResponse(emptyQueue))
            await vi.advanceTimersByTimeAsync(1_100)

            expect((await resultPromise).result.ok).toBe(true)
            expect(queueAttempts).toBeGreaterThanOrEqual(2)
            expect(mocks.alertError).not.toHaveBeenCalled()
        } finally {
            warn.mockRestore()
            vi.useRealTimers()
        }
    })

    it('keeps the queue poller alive so an unhealthy route protects view 404 retries', async () => {
        vi.useFakeTimers()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const promptId = 'view-route-flap'
            const emptyQueue = { queue_pending: [], queue_running: [] }
            const queueRecovery = deferred<ReturnType<typeof jsonResponse>>()
            const startedAt = Date.now()
            let queueAttempts = 0
            let viewAttempts = 0
            let settled = false

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
            mocks.fetchNative.mockImplementation((url: string) => {
                if (url.endsWith('/queue')) {
                    queueAttempts += 1
                    if (queueAttempts === 1) return Promise.resolve(httpErrorResponse(502))
                    if (queueAttempts === 2) return queueRecovery.promise
                    return Promise.resolve(jsonResponse(emptyQueue))
                }
                if (url.includes('/history/')) {
                    return Promise.resolve(jsonResponse(completedComfyHistory(promptId)))
                }
                if (url.includes('/view?')) {
                    viewAttempts += 1
                    return Date.now() - startedAt < 8_000
                        ? Promise.resolve(httpErrorResponse(404))
                        : Promise.resolve(imageResponse())
                }
                throw new Error(`Unexpected URL: ${url}`)
            })

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            void resultPromise.then(() => { settled = true })
            await vi.advanceTimersByTimeAsync(7_900)

            expect(viewAttempts).toBeGreaterThan(3)
            expect(settled).toBe(false)
            queueRecovery.resolve(jsonResponse(emptyQueue))
            await vi.advanceTimersByTimeAsync(1_100)

            expect((await resultPromise).result.ok).toBe(true)
            expect(queueAttempts).toBeGreaterThanOrEqual(2)
            expect(mocks.alertError).not.toHaveBeenCalled()
        } finally {
            warn.mockRestore()
            vi.useRealTimers()
        }
    })

    it('keeps a healthy poller on the bounded three-observation history 404 path', async () => {
        vi.useFakeTimers()
        try {
            const promptId = 'history-healthy-404'
            const emptyQueue = { queue_pending: [], queue_running: [] }
            let historyAttempts = 0

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
            mocks.fetchNative.mockImplementation((url: string) => {
                if (url.endsWith('/queue')) return Promise.resolve(jsonResponse(emptyQueue))
                if (url.includes('/history/')) {
                    historyAttempts += 1
                    return Promise.resolve(httpErrorResponse(404))
                }
                throw new Error(`Unexpected URL: ${url}`)
            })

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(3_100)
            const attempt = await resultPromise

            expect(attempt.result).toEqual({
                ok: false,
                certainty: 'definite',
                reason: 'Image generation failed',
            })
            expect(historyAttempts).toBe(3)
            expect(mocks.alertError).toHaveBeenCalledWith(expect.stringMatching(/404.*\/history/))
        } finally {
            vi.useRealTimers()
        }
    })

    it('recovers when history returns two transient 404 responses before success', async () => {
        vi.useFakeTimers()
        try {
            const promptId = 'history-404-job'
            let historyAttempts = 0

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
            mocks.fetchNative.mockImplementation((url: string) => {
                if (url.endsWith('/queue')) {
                    return Promise.resolve(jsonResponse({ queue_pending: [], queue_running: [] }))
                }
                if (url.includes('/history/')) {
                    historyAttempts += 1
                    return Promise.resolve(historyAttempts <= 2
                        ? httpErrorResponse(404)
                        : jsonResponse(completedComfyHistory(promptId)))
                }
                if (url.includes('/view?')) return Promise.resolve(imageResponse())
                throw new Error(`Unexpected URL: ${url}`)
            })

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(3100)
            const attempt = await resultPromise

            expect(attempt.result.ok).toBe(true)
            expect(historyAttempts).toBe(3)
            expect(mocks.alertError).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })

    it.each([408, 429, 502])(
        'retries a history HTTP %s and succeeds after recovery',
        async (status) => {
            vi.useFakeTimers()
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
            try {
                const promptId = `history-retry-${status}`
                let historyAttempts = 0

                mocks.db = makeComfyUiDatabase()
                mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
                mocks.fetchNative.mockImplementation((url: string) => {
                    if (url.includes('/history/')) {
                        historyAttempts += 1
                        return Promise.resolve(historyAttempts === 1
                            ? httpErrorResponse(status)
                            : jsonResponse(completedComfyHistory(promptId)))
                    }
                    if (url.includes('/view?')) return Promise.resolve(imageResponse())
                    throw new Error(`Unexpected URL: ${url}`)
                })

                const resultPromise = generateAIImageTyped(
                    'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
                )
                await vi.advanceTimersByTimeAsync(1000)
                expect((await resultPromise).result.ok).toBe(true)
                expect(historyAttempts).toBe(2)
                expect(mocks.alertError).not.toHaveBeenCalled()
            } finally {
                warn.mockRestore()
                vi.useRealTimers()
            }
        },
    )

    it('keeps a persistent view 404 definite after two bounded retries', async () => {
        vi.useFakeTimers()
        try {
            const promptId = 'view-404-job'
            let viewAttempts = 0

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
            mocks.fetchNative.mockImplementation((url: string) => {
                if (url.endsWith('/queue')) {
                    return Promise.resolve(jsonResponse({ queue_pending: [], queue_running: [] }))
                }
                if (url.includes('/history/')) {
                    return Promise.resolve(jsonResponse(completedComfyHistory(promptId)))
                }
                if (url.includes('/view?')) {
                    viewAttempts += 1
                    return Promise.resolve(httpErrorResponse(404))
                }
                throw new Error(`Unexpected URL: ${url}`)
            })

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(3100)
            const attempt = await resultPromise

            expect(attempt.result).toEqual({
                ok: false,
                certainty: 'definite',
                reason: 'Image generation failed',
            })
            expect(viewAttempts).toBe(3)
            expect(mocks.alertError).toHaveBeenCalledWith(expect.stringMatching(/404.*\/view/))
        } finally {
            vi.useRealTimers()
        }
    })

    it.each([408, 429, 502])(
        'retries a view HTTP %s and succeeds after recovery',
        async (status) => {
            vi.useFakeTimers()
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
            try {
                const promptId = `view-retry-${status}`
                let viewAttempts = 0

                mocks.db = makeComfyUiDatabase()
                mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
                mocks.fetchNative.mockImplementation((url: string) => {
                    if (url.includes('/history/')) {
                        return Promise.resolve(jsonResponse(completedComfyHistory(promptId)))
                    }
                    if (url.includes('/view?')) {
                        viewAttempts += 1
                        return Promise.resolve(viewAttempts === 1
                            ? httpErrorResponse(status)
                            : imageResponse())
                    }
                    throw new Error(`Unexpected URL: ${url}`)
                })

                const resultPromise = generateAIImageTyped(
                    'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
                )
                await vi.advanceTimersByTimeAsync(1000)
                expect((await resultPromise).result.ok).toBe(true)
                expect(viewAttempts).toBe(2)
                expect(mocks.alertError).not.toHaveBeenCalled()
            } finally {
                warn.mockRestore()
                vi.useRealTimers()
            }
        },
    )

    it('keeps a shared queue 404 indeterminate and completes after recovery', async () => {
        vi.useFakeTimers()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const promptId = 'queue-404-job'
            const emptyQueue = { queue_pending: [], queue_running: [] }
            let queueAttempts = 0
            let historyAttempts = 0

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
            mocks.fetchNative.mockImplementation((url: string) => {
                if (url.endsWith('/queue')) {
                    queueAttempts += 1
                    return Promise.resolve(queueAttempts === 1
                        ? httpErrorResponse(404)
                        : jsonResponse(emptyQueue))
                }
                if (url.includes('/history/')) {
                    historyAttempts += 1
                    return Promise.resolve(jsonResponse(
                        historyAttempts === 1 ? {} : completedComfyHistory(promptId),
                    ))
                }
                if (url.includes('/view?')) return Promise.resolve(imageResponse())
                throw new Error(`Unexpected URL: ${url}`)
            })

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(1000)
            expect((await resultPromise).result.ok).toBe(true)
            expect(queueAttempts).toBe(2)
            expect(mocks.alertError).not.toHaveBeenCalled()
        } finally {
            warn.mockRestore()
            vi.useRealTimers()
        }
    })

    it('skips a malformed foreign queue entry while matching a valid job entry', async () => {
        vi.useFakeTimers()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const promptId = 'valid-among-malformed'
            const mixedQueue = {
                queue_pending: [['foreign-without-id'], [0, promptId]],
                queue_running: [],
            }
            const emptyQueue = { queue_pending: [], queue_running: [] }
            let historyAttempts = 0

            mocks.db = makeComfyUiDatabase()
            mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
            mocks.fetchNative.mockImplementation((url: string) => {
                if (url.endsWith('/queue')) {
                    return Promise.resolve(jsonResponse(
                        mocks.fetchNative.mock.calls.filter(([calledUrl]) => String(calledUrl).endsWith('/queue')).length === 1
                            ? mixedQueue
                            : emptyQueue,
                    ))
                }
                if (url.includes('/history/')) {
                    historyAttempts += 1
                    return Promise.resolve(jsonResponse(
                        historyAttempts === 1 ? {} : completedComfyHistory(promptId),
                    ))
                }
                if (url.includes('/view?')) return Promise.resolve(imageResponse())
                throw new Error(`Unexpected URL: ${url}`)
            })

            const resultPromise = generateAIImageTyped(
                'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
            )
            await vi.advanceTimersByTimeAsync(1500)
            expect((await resultPromise).result.ok).toBe(true)
            expect(warn).not.toHaveBeenCalled()
            expect(historyAttempts).toBe(2)
        } finally {
            warn.mockRestore()
            vi.useRealTimers()
        }
    })

    it('exports an unmistakable test-only Comfy poller reset', () => {
        expect(resetComfyPollersForTest).toBeTypeOf('function')
    })

    describe.sequential('Comfy poller test reset isolation', () => {
        it('can leave an in-flight poller for the reset hook to clean', async () => {
            vi.useFakeTimers()
            try {
                const promptId = 'leaked-poller-job'
                mocks.db = makeComfyUiDatabase()
                mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
                mocks.fetchNative.mockImplementation((url: string, options: { signal?: AbortSignal }) => {
                    if (url.includes('/history/')) return Promise.resolve(jsonResponse({}))
                    if (url.endsWith('/queue')) {
                        return settleOnAbortOrDelay(
                            options.signal,
                            jsonResponse({ queue_pending: [], queue_running: [] }),
                        )
                    }
                    throw new Error(`Unexpected URL: ${url}`)
                })

                void generateAIImageTyped(
                    'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
                )
                await vi.advanceTimersByTimeAsync(0)
                expect(mocks.fetchNative.mock.calls.some(([url]) => String(url).endsWith('/queue'))).toBe(true)
            } finally {
                vi.useRealTimers()
            }
        })

        it('starts a fresh poller after beforeEach resets the leaked one', async () => {
            vi.useFakeTimers()
            try {
                const promptId = 'fresh-after-reset'
                const emptyQueue = { queue_pending: [], queue_running: [] }
                let historyAttempts = 0

                mocks.db = makeComfyUiDatabase()
                mocks.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: promptId } })
                mocks.fetchNative.mockImplementation((url: string) => {
                    if (url.endsWith('/queue')) return Promise.resolve(jsonResponse(emptyQueue))
                    if (url.includes('/history/')) {
                        historyAttempts += 1
                        return Promise.resolve(jsonResponse(
                            historyAttempts === 1 ? {} : completedComfyHistory(promptId),
                        ))
                    }
                    if (url.includes('/view?')) return Promise.resolve(imageResponse())
                    throw new Error(`Unexpected URL: ${url}`)
                })

                const resultPromise = generateAIImageTyped(
                    'prompt', currentChar, 'negative', 'inlay', 'interactive', {},
                )
                await vi.advanceTimersByTimeAsync(0)
                expect(mocks.fetchNative).toHaveBeenCalled()
                expect((await resultPromise).result.ok).toBe(true)
            } finally {
                vi.useRealTimers()
            }
        })
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
