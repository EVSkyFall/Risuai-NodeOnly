import { get } from "svelte/store"
import { getDatabase, type character } from "../storage/database.svelte"
import { requestChatData } from "./request/request"
import { alertError, notifyError } from "../alert"
import { fetchNative, globalFetch, readImage } from "../globalApi.svelte"
import { CharEmotion } from "../stores.svelte"
import type { OpenAIChat } from "./index.svelte"
import { processZipWithMetadata } from "./processzip"
import random from "lodash/random"
import type { IllustrationPromptV1 } from "./illustrationJobs/types"

export type ImageGenerationResult =
    | { ok: true; bytesOrDataUrl: string; providerStatus: number }
    | { ok: false; certainty: 'definite'; reason: string; providerStatus?: number; code?: string }
    | { ok: false; certainty: 'uncertain'; reason: string }

export type ImageGenerationPriority = 'interactive' | 'background'

export type ImageGenerationAttempt = {
    result: ImageGenerationResult
    compatibilityValue: string | false
    seedSupported?: boolean
    seedUsed?: number | null
    shouldNotify?: boolean
    notifyErrorValue?: unknown
}

export type ImageGenerationOptions = {
    preservePromptText?: boolean
    illustrationPrompt?: IllustrationPromptV1
    seed?: number
}

const COMFY_QUEUE_POLL_INTERVAL_MS = 1500
const COMFY_RETRY_INITIAL_MS = 1000
const COMFY_RETRY_MAX_MS = 15000
const COMFY_REQUEST_TIMEOUT_MS = 30_000
const COMFY_PROMPT_REQUEST_TIMEOUT_MS = 600_000
const COMFY_BUFFERED_DOWNLOAD_TIMEOUT_MS = 600_000
const COMFY_TRANSIENT_DEFINITE_HTTP_RETRIES = 2

type ComfyCreateUrl = (pathname: string, params?: Record<string, string>) => string
type ComfyQueueSnapshot =
    | { sequence: number; valid: true; queuedIds: ReadonlySet<string> }
    | { sequence: number; valid: false }

type ComfyQueueSubscriber = {
    token: symbol
    id: string
    createUrl: ComfyCreateUrl
    minimumSequence: number
    lastConsumedSequence: number
    lastQueuedSequence: number
    latestSnapshot: ComfyQueueSnapshot | null
    waiter: ((snapshot: ComfyQueueSnapshot) => void) | null
}

type ComfyQueuePoller = {
    key: string
    queueUrl: string
    subscribers: Map<symbol, ComfyQueueSubscriber>
    nextSequence: number
    timer: ReturnType<typeof setTimeout> | null
    inFlight: boolean
    retryDelayMs: number
    transportFailed: boolean
    latestSnapshotValid: boolean | null
    requestController: AbortController | null
    disposed: boolean
}

type ComfyQueueSubscription = {
    next: () => Promise<ComfyQueueSnapshot>
    getLastQueuedSequence: () => number
    checkHistoryImmediately: boolean
    unsubscribe: () => void
}

const comfyQueuePollers = new Map<string, ComfyQueuePoller>()

const waitForComfyRetry = (delayMs: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs)
})

function isComfyRecord(value: unknown): value is Record<string, any> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

class ComfyDefiniteHttpError extends Error {
    readonly comfyDefinite = true

    constructor(
        readonly status: number,
        readonly path: string,
        requestName: string,
    ) {
        super(`ComfyUI ${requestName} request failed with status ${status} for ${path}`)
        this.name = 'ComfyDefiniteHttpError'
    }
}

class ComfyPromptUncertainError extends Error {
    readonly comfyPromptUncertain = true

    constructor(message: string, readonly transportCause?: unknown) {
        super(message)
        this.name = 'ComfyPromptUncertainError'
    }
}

function isComfyDefiniteHttpError(error: unknown): error is ComfyDefiniteHttpError {
    return isComfyRecord(error) && error.comfyDefinite === true
}

function isComfyPromptUncertainError(error: unknown): error is ComfyPromptUncertainError {
    return isComfyRecord(error) && error.comfyPromptUncertain === true
}

function isGlobalFetchTransportError(error: unknown): error is {
    globalFetchTransportError: true
    dispatched: boolean
    transportCause?: unknown
} {
    return isComfyRecord(error)
        && error.globalFetchTransportError === true
        && typeof error.dispatched === 'boolean'
}

function getComfyRequestPath(url: string): string {
    try {
        return new URL(url).pathname
    } catch {
        return url
    }
}

function isRetryableComfyHttpStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500 && status <= 599
}

function throwForComfyJobHttpError(
    response: { ok?: boolean; status?: number },
    url: string,
    requestName: string,
) {
    if (response.ok !== false) return
    const status = response.status
    const message = `ComfyUI ${requestName} request failed with status ${status} for ${getComfyRequestPath(url)}`
    if (typeof status !== 'number' || isRetryableComfyHttpStatus(status)) {
        throw new Error(message)
    }
    throw new ComfyDefiniteHttpError(status, getComfyRequestPath(url), requestName)
}

async function withComfyRequestTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    setController?: (controller: AbortController | null) => void,
): Promise<T> {
    const controller = new AbortController()
    let rejectOnAbort!: (reason: unknown) => void
    const abortPromise = new Promise<never>((_resolve, reject) => {
        rejectOnAbort = reject
    })
    const onAbort = () => rejectOnAbort(
        controller.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'),
    )
    controller.signal.addEventListener('abort', onAbort, { once: true })
    const timeoutId = setTimeout(() => controller.abort(), COMFY_REQUEST_TIMEOUT_MS)
    setController?.(controller)
    try {
        return await Promise.race([operation(controller.signal), abortPromise])
    } finally {
        clearTimeout(timeoutId)
        controller.signal.removeEventListener('abort', onAbort)
        setController?.(null)
    }
}

function takeComfyQueueSnapshot(subscriber: ComfyQueueSubscriber): ComfyQueueSnapshot | null {
    const snapshot = subscriber.latestSnapshot
    if (!snapshot
        || snapshot.sequence < subscriber.minimumSequence
        || snapshot.sequence <= subscriber.lastConsumedSequence) {
        return null
    }
    subscriber.lastConsumedSequence = snapshot.sequence
    return snapshot
}

function publishComfyQueueSnapshot(poller: ComfyQueuePoller, snapshot: ComfyQueueSnapshot) {
    if (poller.disposed) return
    poller.latestSnapshotValid = snapshot.valid
    for (const subscriber of poller.subscribers.values()) {
        // A request that started before this job subscribed may contain a stale
        // absence, even if its response arrives after the POST completed.
        if (snapshot.sequence < subscriber.minimumSequence) continue
        if (snapshot.valid && snapshot.queuedIds.has(subscriber.id)) {
            subscriber.lastQueuedSequence = snapshot.sequence
        }
        subscriber.latestSnapshot = snapshot
        if (subscriber.waiter) {
            const waiter = subscriber.waiter
            subscriber.waiter = null
            subscriber.lastConsumedSequence = snapshot.sequence
            waiter(snapshot)
        }
    }
}

function scheduleComfyQueuePoll(poller: ComfyQueuePoller, delayMs: number) {
    if (poller.disposed
        || poller.timer !== null
        || poller.inFlight
        || poller.subscribers.size === 0) return
    poller.timer = setTimeout(() => {
        poller.timer = null
        void runComfyQueuePoll(poller)
    }, delayMs)
}

async function runComfyQueuePoll(poller: ComfyQueuePoller) {
    if (poller.disposed || poller.inFlight || poller.subscribers.size === 0) return
    poller.inFlight = true
    const sequence = poller.nextSequence++
    let nextDelayMs = COMFY_QUEUE_POLL_INTERVAL_MS
    try {
        const queuedIds = await withComfyRequestTimeout(async (signal) => {
            const response = await fetchNative(poller.queueUrl, {
                headers: { 'Content-Type': 'application/json' },
                method: 'GET',
                signal,
                requestTimeoutMs: COMFY_REQUEST_TIMEOUT_MS,
            })
            if (response.ok === false || typeof response.json !== 'function') {
                throw new Error(`ComfyUI queue request failed with status ${response.status}`)
            }
            const queue = await response.json()
            if (!isComfyRecord(queue)
                || !Array.isArray(queue.queue_running)
                || !Array.isArray(queue.queue_pending)) {
                throw new Error('ComfyUI returned an invalid queue response')
            }
            const ids = new Set<string>()
            for (const entry of [...queue.queue_running, ...queue.queue_pending]) {
                if (!Array.isArray(entry) || typeof entry[1] !== 'string') continue
                ids.add(entry[1])
            }
            return ids
        }, (controller) => {
            poller.requestController = controller
        })
        if (poller.disposed) return
        if (poller.transportFailed) {
            console.warn(`[ComfyUI] Queue polling recovered for ${poller.queueUrl}`)
        }
        poller.transportFailed = false
        poller.retryDelayMs = COMFY_RETRY_INITIAL_MS
        publishComfyQueueSnapshot(poller, { sequence, valid: true, queuedIds })
    } catch (error) {
        if (poller.disposed) return
        publishComfyQueueSnapshot(poller, { sequence, valid: false })
        if (!poller.transportFailed) {
            console.warn(
                `[ComfyUI] Queue polling failed for ${poller.queueUrl}; retrying indefinitely.`,
                error,
            )
        }
        poller.transportFailed = true
        nextDelayMs = poller.retryDelayMs
        poller.retryDelayMs = Math.min(poller.retryDelayMs * 2, COMFY_RETRY_MAX_MS)
    } finally {
        poller.inFlight = false
        if (poller.disposed) {
            return
        } else if (poller.subscribers.size === 0) {
            if (comfyQueuePollers.get(poller.key) === poller) {
                comfyQueuePollers.delete(poller.key)
            }
        } else {
            scheduleComfyQueuePoll(poller, nextDelayMs)
        }
    }
}

function subscribeComfyQueue(createUrl: ComfyCreateUrl, id: string): ComfyQueueSubscription {
    const queueUrl = createUrl('/queue')
    let poller = comfyQueuePollers.get(queueUrl)
    if (poller?.disposed) {
        comfyQueuePollers.delete(queueUrl)
        poller = undefined
    }
    const checkHistoryImmediately = !poller
    if (!poller) {
        poller = {
            key: queueUrl,
            queueUrl,
            subscribers: new Map(),
            nextSequence: 1,
            timer: null,
            inFlight: false,
            retryDelayMs: COMFY_RETRY_INITIAL_MS,
            transportFailed: false,
            latestSnapshotValid: null,
            requestController: null,
            disposed: false,
        }
        comfyQueuePollers.set(queueUrl, poller)
    }

    const token = Symbol(id)
    const subscriber: ComfyQueueSubscriber = {
        token,
        id,
        createUrl,
        minimumSequence: poller.nextSequence,
        lastConsumedSequence: 0,
        lastQueuedSequence: 0,
        latestSnapshot: null,
        waiter: null,
    }
    poller.subscribers.set(token, subscriber)
    scheduleComfyQueuePoll(poller, 0)

    let active = true
    return {
        next: () => {
            const snapshot = takeComfyQueueSnapshot(subscriber)
            if (snapshot) return Promise.resolve(snapshot)
            return new Promise((resolve) => {
                subscriber.waiter = resolve
            })
        },
        getLastQueuedSequence: () => subscriber.lastQueuedSequence,
        checkHistoryImmediately,
        unsubscribe: () => {
            if (!active) return
            active = false
            poller.subscribers.delete(token)
            if (poller.subscribers.size !== 0) return
            if (poller.timer !== null) {
                clearTimeout(poller.timer)
                poller.timer = null
            }
            // Keep an in-flight poller discoverable so a new subscriber cannot
            // create a second request to the same queue before this one settles.
            if (!poller.inFlight && comfyQueuePollers.get(poller.key) === poller) {
                comfyQueuePollers.delete(poller.key)
            }
        },
    }
}

type ComfyQueueHealth = 'healthy' | 'unhealthy' | 'unknown'

function getComfyQueueHealth(createUrl: ComfyCreateUrl): ComfyQueueHealth {
    const poller = comfyQueuePollers.get(createUrl('/queue'))
    if (!poller || poller.disposed || poller.latestSnapshotValid === null) return 'unknown'
    return poller.latestSnapshotValid ? 'healthy' : 'unhealthy'
}

export function __resetComfyPollersForTest() {
    for (const poller of comfyQueuePollers.values()) {
        poller.disposed = true
        if (poller.timer !== null) {
            clearTimeout(poller.timer)
            poller.timer = null
        }
        poller.subscribers.clear()
        poller.requestController?.abort()
    }
    comfyQueuePollers.clear()
}

async function retryComfyTransport<T>(
    label: string,
    operation: () => Promise<T>,
    options: {
        definiteHttpRetries?: number
        getQueueHealth?: () => ComfyQueueHealth
    } = {},
): Promise<T> {
    let retryDelayMs = COMFY_RETRY_INITIAL_MS
    let transportFailed = false
    let definiteHttpFailures = 0
    while (true) {
        try {
            const value = await operation()
            if (transportFailed) console.warn(`[ComfyUI] ${label} recovered`)
            return value
        } catch (error) {
            if (isComfyDefiniteHttpError(error)) {
                const retryableDefinite4xx = error.status >= 400 && error.status <= 499
                if (retryableDefinite4xx && options.getQueueHealth?.() === 'unhealthy') {
                    definiteHttpFailures = 0
                    if (!transportFailed) {
                        console.warn(`[ComfyUI] ${label} failed during a shared queue outage; retrying indefinitely.`, error)
                    }
                    transportFailed = true
                    await waitForComfyRetry(retryDelayMs)
                    retryDelayMs = Math.min(retryDelayMs * 2, COMFY_RETRY_MAX_MS)
                    continue
                }
                if (!retryableDefinite4xx
                    || definiteHttpFailures >= (options.definiteHttpRetries ?? 0)) throw error
                definiteHttpFailures += 1
                await waitForComfyRetry(COMFY_RETRY_INITIAL_MS * definiteHttpFailures)
                continue
            }
            definiteHttpFailures = 0
            if (!transportFailed) {
                console.warn(`[ComfyUI] ${label} failed; retrying indefinitely.`, error)
            }
            transportFailed = true
            await waitForComfyRetry(retryDelayMs)
            retryDelayMs = Math.min(retryDelayMs * 2, COMFY_RETRY_MAX_MS)
        }
    }
}

async function readComfyHistory(
    createUrl: ComfyCreateUrl,
    id: string,
): Promise<Record<string, any> | undefined> {
    return retryComfyTransport(`History polling for ${id}`, async () => {
        const url = createUrl(`/history/${encodeURIComponent(id)}`)
        return withComfyRequestTimeout(async (signal) => {
            const response = await fetchNative(url, {
                headers: { 'Content-Type': 'application/json' },
                method: 'GET',
                signal,
                requestTimeoutMs: COMFY_REQUEST_TIMEOUT_MS,
            })
            throwForComfyJobHttpError(response, url, 'history')
            if (typeof response.json !== 'function') {
                throw new Error('ComfyUI returned an invalid history response')
            }
            const history = await response.json()
            if (!isComfyRecord(history)) {
                throw new Error('ComfyUI returned an invalid history response')
            }
            if (!Object.prototype.hasOwnProperty.call(history, id)) return undefined

            const item = history[id]
            if (!isComfyRecord(item) || !isComfyRecord(item.outputs)) {
                throw new Error('ComfyUI returned an invalid history item')
            }
            if (item.status !== undefined) {
                if (!isComfyRecord(item.status)
                    || (item.status.messages !== undefined && !Array.isArray(item.status.messages))) {
                    throw new Error('ComfyUI returned an invalid history status')
                }
            }
            return item
        })
    }, {
        definiteHttpRetries: COMFY_TRANSIENT_DEFINITE_HTTP_RETRIES,
        getQueueHealth: () => getComfyQueueHealth(createUrl),
    })
}

function validateComfyImageBytes(byteLength: number, contentType: string): void {
    if (byteLength === 0) {
        throw new Error('ComfyUI returned an empty image response')
    }
    const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
    if (mediaType.startsWith('image/') && byteLength < 64) {
        throw new Error(`ComfyUI returned an invalid ${mediaType} response (${byteLength} bytes)`)
    }
}

async function downloadComfyImage(
    url: string,
    getQueueHealth: () => ComfyQueueHealth,
): Promise<ArrayBuffer> {
    return retryComfyTransport('Image download', async () => {
        const controller = new AbortController()
        let timeoutId: ReturnType<typeof setTimeout> | null = null
        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
        const responseBodyState: {
            mode: 'streaming' | 'buffered'
            bufferedModeSelected: boolean
        } = {
            mode: 'streaming',
            bufferedModeSelected: false,
        }
        let rejectOnAbort!: (reason: unknown) => void
        const abortPromise = new Promise<never>((_resolve, reject) => {
            rejectOnAbort = reject
        })
        // Early HTTP/fetch failures can abort during cleanup before a body-read race is attached.
        void abortPromise.catch(() => {})
        const onAbort = () => rejectOnAbort(
            controller.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'),
        )
        controller.signal.addEventListener('abort', onAbort, { once: true })

        const clearWatchdog = () => {
            if (timeoutId !== null) {
                clearTimeout(timeoutId)
                timeoutId = null
            }
        }
        const armWatchdog = (timeoutMs: number, message: string) => {
            clearWatchdog()
            timeoutId = setTimeout(() => {
                controller.abort(new DOMException(message, 'TimeoutError'))
            }, timeoutMs)
        }

        armWatchdog(COMFY_REQUEST_TIMEOUT_MS, 'ComfyUI image response headers timed out.')
        try {
            const response = await Promise.race([
                fetchNative(url, {
                    headers: { 'Content-Type': 'application/json' },
                    method: 'GET',
                    signal: controller.signal,
                    onResponseBodyMode: (mode) => {
                        if (mode !== 'buffered' || responseBodyState.bufferedModeSelected) return
                        responseBodyState.bufferedModeSelected = true
                        responseBodyState.mode = 'buffered'
                        armWatchdog(
                            COMFY_BUFFERED_DOWNLOAD_TIMEOUT_MS,
                            'ComfyUI buffered image request timed out.',
                        )
                    },
                }),
                abortPromise,
            ])
            throwForComfyJobHttpError(response, url, 'image')
            const contentType = response.headers?.get?.('content-type') ?? ''

            if (responseBodyState.mode === 'buffered') {
                if (typeof response.arrayBuffer !== 'function') {
                    throw new Error('ComfyUI returned an invalid image response')
                }
                const body = await Promise.race([response.arrayBuffer(), abortPromise])
                if (Object.prototype.toString.call(body) !== '[object ArrayBuffer]') {
                    throw new Error('ComfyUI returned an invalid image response')
                }
                validateComfyImageBytes(body.byteLength, contentType)
                return body
            }

            clearWatchdog()
            if (!response.body || typeof response.body.getReader !== 'function') {
                throw new Error('ComfyUI returned an invalid image response')
            }
            reader = response.body.getReader()
            const chunks: Uint8Array[] = []
            let totalBytes = 0
            armWatchdog(COMFY_REQUEST_TIMEOUT_MS, 'ComfyUI image response made no byte progress.')
            while (true) {
                const readPromise = reader.read()
                void readPromise.catch(() => {})
                const { done, value } = await Promise.race([readPromise, abortPromise])
                if (done) break
                if (!value || value.byteLength === 0) continue
                chunks.push(value)
                totalBytes += value.byteLength
                armWatchdog(COMFY_REQUEST_TIMEOUT_MS, 'ComfyUI image response made no byte progress.')
            }
            clearWatchdog()
            validateComfyImageBytes(totalBytes, contentType)
            const body = new Uint8Array(totalBytes)
            let offset = 0
            for (const chunk of chunks) {
                body.set(chunk, offset)
                offset += chunk.byteLength
            }
            return body.buffer
        } catch (error) {
            if (!controller.signal.aborted) controller.abort(error)
            if (reader) {
                try {
                    // Cleanup must not turn a timed-out attempt into another unbounded wait.
                    void reader.cancel(error).catch(() => {})
                } catch {
                    // The abort may already have errored the stream.
                }
            }
            throw error
        } finally {
            clearWatchdog()
            controller.signal.removeEventListener('abort', onAbort)
            if (reader) {
                try {
                    reader.releaseLock()
                } catch {
                    // A transport-owned pending read can retain the lock briefly after abort.
                }
            }
        }
    }, {
        definiteHttpRetries: COMFY_TRANSIENT_DEFINITE_HTTP_RETRIES,
        getQueueHealth,
    })
}

function readWebUiSeed(info: unknown): number | null {
    try {
        const parsed = typeof info === 'string' ? JSON.parse(info) : info
        const seed = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).seed : null
        return Number.isSafeInteger(seed) && Number(seed) >= 0
            ? Number(seed)
            : null
    } catch {
        return null
    }
}

export async function stableDiff(currentChar:character,prompt:string){
    let db = getDatabase()

    if(db.sdProvider === ''){
        notifyError("Stable diffusion is not set in settings.")
        return false
    }


    const promptItem = `Chat:\n${prompt}`

    const promptbody:OpenAIChat[] = [
        {

            role:'system',
            content: currentChar.newGenData.instructions
        },
        {
            role: 'user',
            content: promptItem
        },
    ]

    const rq = await requestChatData({
        formated: promptbody,
        currentChar: currentChar,
        temperature: 0.2,
        maxTokens: 300,
        bias: {},
        useStreaming: false,
        noMultiGen: true
    }, 'submodel')


    if(rq.type === 'fail'){
        notifyError(rq.result)
        return false
    }
    if(rq.type === 'streaming' || rq.type === 'multiline'){
        notifyError('Unexpected response type')
        return false
    }

    const r = rq.result.replace(/<Thoughts>[\s\S]*?<\/Thoughts>/g, '').trim()


    const genPrompt = currentChar.newGenData.prompt.replaceAll('{{slot}}', r)
    const neg = currentChar.newGenData.negative

    return await generateAIImage(genPrompt, currentChar, neg, '')
}

export async function generateAIImage(
    genPrompt:string,
    currentChar:character,
    neg:string,
    returnSdData:string,
    priorityClass:ImageGenerationPriority = 'interactive',
):Promise<string|false>{
    const attempt = await generateAIImageTyped(genPrompt, currentChar, neg, returnSdData, priorityClass)
    if (!attempt.result.ok && attempt.shouldNotify) {
        notifyError(attempt.notifyErrorValue)
    }
    return attempt.compatibilityValue
}

export async function generateAIImageTyped(
    genPrompt:string,
    currentChar:character,
    neg:string,
    returnSdData:string,
    priorityClass:ImageGenerationPriority,
    options: ImageGenerationOptions = {},
):Promise<ImageGenerationAttempt>{
    const result = await generateAIImageInternal(
        genPrompt,
        currentChar,
        neg,
        returnSdData,
        priorityClass,
        options,
    )
    if (typeof result === 'object') {
        return result
    }
    if (result === false || (returnSdData === 'inlay' && result === '')) {
        return {
            result: { ok: false, certainty: 'definite', reason: 'Image generation failed' },
            compatibilityValue: result,
        }
    }
    return {
        result: { ok: true, bytesOrDataUrl: result, providerStatus: 200 },
        compatibilityValue: result,
    }
}

async function generateAIImageInternal(
    genPrompt:string,
    currentChar:character,
    neg:string,
    returnSdData:string,
    priorityClass:ImageGenerationPriority,
    options: ImageGenerationOptions,
):Promise<string|false|ImageGenerationAttempt>{
    const db = getDatabase()
    if(options.illustrationPrompt){
        genPrompt = options.illustrationPrompt.basePositive
        neg = options.illustrationPrompt.baseNegative
    }
    console.log(db.sdProvider)
    if(db.sdProvider === 'webui'){
        if (options.seed !== undefined && options.seed > 0xFFFFFFFF) {
            return {
                result: {
                    ok: false,
                    certainty: 'definite',
                    reason: 'WebUI seed must be at most 4294967295',
                    code: 'image_seed_invalid',
                },
                compatibilityValue: returnSdData === 'inlay' ? '' : false,
            }
        }


        const uri = new URL(db.webUiUrl)
        uri.pathname = '/sdapi/v1/txt2img'
        try {
            const da = await globalFetch(uri.toString(), {
                body: {
                    "width": db.sdConfig.width,
                    "height": db.sdConfig.height,
                    "seed": options.seed ?? -1,
                    "steps": db.sdSteps,
                    "cfg_scale": db.sdCFG,
                    "prompt": genPrompt,
                    "negative_prompt": neg,
                    "sampler_name": db.sdConfig.sampler_name,
                    "enable_hr": db.sdConfig.enable_hr,
                    "denoising_strength": db.sdConfig.denoising_strength,
                    "hr_scale": db.sdConfig.hr_scale,
                    "hr_upscaler": db.sdConfig.hr_upscaler
                },
                headers:{
                    'Content-Type': 'application/json'
                }
            })   

            if(returnSdData === 'inlay'){
                if(da.ok){
                    const dataUrl = `data:image/png;base64,${da.data.images[0]}`
                    return {
                        result: { ok: true, bytesOrDataUrl: dataUrl, providerStatus: da.status ?? 200 },
                        compatibilityValue: dataUrl,
                        seedSupported: true,
                        seedUsed: readWebUiSeed(da.data.info) ?? options.seed ?? null,
                    }
                }
                else{
                    notifyError(JSON.stringify(da.data))
                    return ''
                }
            }
            else if(da.ok){
                let charemotions = get(CharEmotion)
                const img = `data:image/png;base64,${da.data.images[0]}`
                console.log(img)
                const emos:[string, string,number][] = [[img, img, Date.now()]]
                charemotions[currentChar.chaId] = emos
                CharEmotion.set(charemotions)
            }
            else{
                notifyError(JSON.stringify(da.data))
                return false   
            }

            return {
                result: { ok: true, bytesOrDataUrl: `data:image/png;base64,${da.data.images[0]}`, providerStatus: da.status ?? 200 },
                compatibilityValue: returnSdData,
                seedSupported: true,
                seedUsed: readWebUiSeed(da.data.info) ?? options.seed ?? null,
            }


        } catch (error) {
            notifyError(error)
            return false   
        }
    }
    if(db.sdProvider === 'novelai'){
        if (options.seed !== undefined && options.seed > 0xFFFFFFFF) {
            return {
                result: {
                    ok: false,
                    certainty: 'definite',
                    reason: 'NAI seed must be at most 4294967295',
                    code: 'image_seed_invalid',
                },
                compatibilityValue: returnSdData === 'inlay' ? '' : false,
            }
        }
        if(options.preservePromptText !== true){
            genPrompt = genPrompt
                .replaceAll('\\(', "♧")
                .replaceAll('\\)', "♤")
                .replaceAll('(','{')
                .replaceAll(')','}')
                .replaceAll('♧','(')
                .replaceAll('♤',')')
        }

        let reqlist:any = {}

        // Character captions can be placed regionally. Placement is opt-in and
        // driven entirely by the caller: `use_coords` turns on only when the
        // prompt actually carries a center, so every caller that does not ask
        // for placement keeps producing the exact request it produced before.
        //
        // Every caption must carry a non-empty `centers`, on BOTH sides.
        // Measured against the live API: an empty array is rejected with HTTP
        // 500, so is omitting the key, and so is supplying centres on the
        // positive captions but not the negative ones. Only "one centre per
        // caption everywhere" is accepted. An unplaced caption therefore gets
        // the middle of the canvas, which `use_coords: false` tells the
        // provider to ignore in favour of caption order.
        const NEUTRAL_CENTER = { x: 0.5, y: 0.5 }
        const naiCenters = options.illustrationPrompt?.layout === 'nai-v4-characters'
            ? (options.illustrationPrompt.characterCenters ?? [])
            : []
        const useCoords = naiCenters.some((center) => center !== null && center !== undefined)
        const toCaption = (char_caption: string, index: number) => ({
            char_caption,
            centers: [naiCenters[index] ?? NEUTRAL_CENTER],
        })
        const characterPositives = options.illustrationPrompt?.layout === 'nai-v4-characters'
            ? options.illustrationPrompt.characterPositives.map(toCaption)
            : []
        const characterNegatives = options.illustrationPrompt?.layout === 'nai-v4-characters'
            ? options.illustrationPrompt.characterNegatives.map(toCaption)
            : []
        const naiSeed = options.seed ?? random(0, 2**32-1)
        const naiExtraNoiseSeed = options.seed ?? random(0, 2**32-1)

        const commonReq = {
            body: {
                // NAI's legacy compatibility field remains the base positive;
                // v4_prompt below is authoritative for structured captions.
                "input": genPrompt,
                "model": db.NAIImgModel,
                "parameters": {
                    "params_version": 3,
                    "add_original_image": true,
                    "cfg_rescale": db.NAIImgConfig.cfg_rescale,
                    "controlnet_strength": 1,
                    "dynamic_thresholding": db.NAIImgModel.includes('nai-diffusion-3') || db.NAIImgModel.includes('nai-diffusion-furry-3') || db.NAIImgModel.includes('nai-diffusion-2') ? db.NAIImgConfig.decrisp : false,
                    "n_samples": 1,
                    "width": db.NAIImgConfig.width,
                    "height": db.NAIImgConfig.height,
                    "sampler": db.NAIImgConfig.sampler,
                    "steps": db.NAIImgConfig.steps,
                    "scale": db.NAIImgConfig.scale,
                    "negative_prompt": neg,
                    "sm": db.NAIImgModel.includes('nai-diffusion-3') || db.NAIImgModel.includes('nai-diffusion-furry-3') || db.NAIImgModel.includes('nai-diffusion-2') ? db.NAIImgConfig.sm : undefined,
                    "sm_dyn": db.NAIImgModel.includes('nai-diffusion-3') || db.NAIImgModel.includes('nai-diffusion-furry-3') ? db.NAIImgConfig.sm_dyn : undefined,
                    "noise_schedule": db.NAIImgConfig.noise_schedule,
                    "normalize_reference_strength_multiple":true,
                    "ucPreset": 3,
                    "uncond_scale": 1,
                    "qualityToggle": false,
                    "legacy_v3_extend": false,
                    "legacy": false,
                    //add v4
                    "autoSmea": false,
                    "use_coords": useCoords,
                    "legacy_uc": db.NAIImgConfig.legacy_uc,
                    "v4_prompt":{
                        caption:{
                            base_caption:genPrompt,
                            char_captions: characterPositives
                        },
                        use_coords: useCoords,
                        // Order still identifies which caption is which subject
                        // even when coordinates place them, so it stays on.
                        use_order: true,
                    },
                    "v4_negative_prompt":{
                        caption:{
                            base_caption:neg,
                            char_captions: characterNegatives
                        },
                        legacy_uc: db.NAIImgConfig.legacy_uc,
                    },
                    "reference_image_multiple" : [],
                    "reference_strength_multiple" : [],
                    //add reference image
                    "image": undefined, 
                    "strength": undefined,
                    "noise": undefined,
                    //add additional parameters
                    "seed": naiSeed,
                    "extra_noise_seed": naiExtraNoiseSeed,
                    "prefer_brownian": true,
                    "deliberate_euler_ancestral_bug": false,
                    "skip_cfg_above_sigma": null,
                    //add character reference
                    // Absent, not empty. A model without the director-reference
                    // feature answers HTTP 400 "model <name> doesn't support director
                    // reference images" while these keys are present, and `[]` counts
                    // as present: nai-diffusion-4-full was rejected that way with
                    // Image Reference set to None, back when the keys went out
                    // unconditionally. They are filled in below only when a reference
                    // image is really attached; until then JSON.stringify, which drops
                    // undefined, keeps them off the wire entirely.
                    "director_reference_images": undefined as string[] | undefined,
                    "director_reference_descriptions": undefined as object[] | undefined,
                    "director_reference_information_extracted": undefined as number[] | undefined,
                    "director_reference_strength_values": undefined as number[] | undefined,
                }
            },
            headers:{
                "Authorization": "Bearer " + db.NAIApiKey
            },
            rawResponse: true
        }

        // Add Variety+ option 
        if(db.NAIImgConfig.variety_plus) {
            if(db.NAIImgModel.includes('nai-diffusion-4-full') || db.NAIImgModel.includes('nai-diffusion-4-curated')
            || db.NAIImgModel.includes('nai-diffusion-3') || db.NAIImgModel.includes('nai-diffusion-furry-3')) {
                commonReq.body.parameters.skip_cfg_above_sigma = Math.sqrt(db.NAIImgConfig.width * db.NAIImgConfig.height) * 0.01889;
            }
            if(db.NAIImgModel.includes('nai-diffusion-4-5-full') || db.NAIImgModel.includes('nai-diffusion-4-5-curated')) {
                commonReq.body.parameters.skip_cfg_above_sigma = Math.sqrt(db.NAIImgConfig.width * db.NAIImgConfig.height) * 0.05766;
            }
        }

        // Add vibe reference_image_multiple if exists
        if(db.NAIImgConfig.reference_mode === 'vibe' && db.NAIImgConfig.vibe_data) {
            const vibeData = db.NAIImgConfig.vibe_data;
            // Determine which model to use based on vibe_model_selection or fallback to current model
            const modelKey = db.NAIImgConfig.vibe_model_selection || 
                            (db.NAIImgModel.includes('nai-diffusion-4-full') ? 'v4full' : 
                             db.NAIImgModel.includes('nai-diffusion-4-curated') ? 'v4curated' : 
                             db.NAIImgModel.includes('nai-diffusion-4-5-full') ? 'v4-5full' :
                             db.NAIImgModel.includes('nai-diffusion-4-5-curated') ? 'v4-5curated' : null);

            if(modelKey && vibeData.encodings && vibeData.encodings[modelKey]) {
                // Initialize arrays if they don't exist
                if(!commonReq.body.parameters.reference_image_multiple) {
                    commonReq.body.parameters.reference_image_multiple = [];
                }
                if(!commonReq.body.parameters.reference_strength_multiple) {
                    commonReq.body.parameters.reference_strength_multiple = [];
                }

                // Use selected encoding or first available
                let encodingKey = db.NAIImgConfig.vibe_model_selection ? 
                                 Object.keys(vibeData.encodings[modelKey]).find(key => 
                                    vibeData.encodings[modelKey][key].params.information_extracted === 
                                    (db.NAIImgConfig.InfoExtracted || 1)) : 
                                 Object.keys(vibeData.encodings[modelKey])[0];

                if(encodingKey) {
                    const encoding = vibeData.encodings[modelKey][encodingKey].encoding;
                    // Add encoding to the array
                    commonReq.body.parameters.reference_image_multiple.push(encoding);

                    // Add reference_strength_multiple if it exists
                    const strength = db.NAIImgConfig.reference_strength_multiple && 
                                    db.NAIImgConfig.reference_strength_multiple.length > 0 ? 
                                    db.NAIImgConfig.reference_strength_multiple[0] : 0.5;
                    commonReq.body.parameters.reference_strength_multiple.push(strength);
                }
            }
        }

        if(db.NAIImgConfig.reference_mode === 'character' &&
            (db.NAIImgModel.includes('nai-diffusion-4-5-full') || db.NAIImgModel.includes('nai-diffusion-4-5-curated'))
        ) {
            let base64img = ''
            if(!db.NAIImgConfig.character_image || db.NAIImgConfig.character_image === ''){
                const charimg = currentChar.image;
                const img = await readImage(charimg)
                if (img) {
                    base64img = Buffer.from(img).toString('base64')
                }
            }   
            else{
                base64img = db.NAIImgConfig.character_base64image;
            }
            
            try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                const imageObj = new Image();
                
                await new Promise<void>((resolve) => {
                    imageObj.onload = () => resolve();
                    imageObj.src = `data:image/png;base64,${base64img}`;
                });
                
                canvas.width = 1472;
                canvas.height = 1472;
                
                const scale = Math.min(1472 / imageObj.width, 1472 / imageObj.height);
                const scaledWidth = Math.floor(imageObj.width * scale);
                const scaledHeight = Math.floor(imageObj.height * scale);
                
                const x = (1472 - scaledWidth) / 2;
                const y = (1472 - scaledHeight) / 2;
                
                ctx.fillStyle = 'black';
                ctx.fillRect(0, 0, 1472, 1472);
                
                ctx.drawImage(imageObj, x, y, scaledWidth, scaledHeight);
                
                const blob = await new Promise<Blob>((resolve) => {
                    canvas.toBlob(resolve, 'image/png');
                });
                
                if (blob) {
                    const arrayBuffer = await blob.arrayBuffer();
                    base64img = Buffer.from(arrayBuffer).toString('base64');
                }
            } catch (error) {
                console.warn('Image resize failed, using original:', error);
            }
            
            if(base64img){
                commonReq.body.parameters.director_reference_descriptions = [
                    {
                        caption: {
                            base_caption: "character" + (db.NAIImgConfig.style_aware ? "&style" : ""),
                            char_captions: []
                        },
                        legacy_uc: db.NAIImgConfig.legacy_uc,
                    }
                ]
                commonReq.body.parameters.director_reference_images = [base64img]
                commonReq.body.parameters.director_reference_information_extracted = [1]
                commonReq.body.parameters.director_reference_strength_values = [1]
            }
        }

        if(db.NAII2I){
            let seed = random(0, 1000000000);

            let base64img = ''
            if(!db.NAIImgConfig.image || db.NAIImgConfig.image === ''){
                const charimg = currentChar.image;

                const img = await readImage(charimg)
                if (img) {
                    base64img = Buffer.from(img).toString('base64')
                }
            }   
            else{
                base64img = db.NAIImgConfig.base64image;
            }
            
            if(base64img) {
                reqlist = commonReq;
                reqlist.body.action = "img2img";
                reqlist.body.parameters.image = base64img;
                reqlist.body.parameters.strength = db.NAIImgConfig.strength || 0.7;
                reqlist.body.parameters.noise = db.NAIImgConfig.noise || 0;
            }
            
        }else{

            reqlist = commonReq;
            reqlist.body.action = 'generate';
        }
        try {
            const da = await globalFetch(db.NAIImgUrl, {
                ...reqlist,
                plainFetchDeforce: true,
                proxyRequestHeaders: {
                    'risu-image-class': priorityClass,
                },
                redactRequestLog: true,
            })

            if(!da.ok){
                const reason = Buffer.from(da.data).toString()
                const brokerResult = da.headers?.['risu-image-result']
                const result:ImageGenerationResult = brokerResult === 'provider-response'
                    ? { ok: false, certainty: 'definite', reason, providerStatus: da.status }
                    : brokerResult === 'validation-reject'
                        ? { ok: false, certainty: 'definite', reason }
                        : { ok: false, certainty: 'uncertain', reason }
                return {
                    result,
                    compatibilityValue: returnSdData === 'inlay' ? '' : false,
                    shouldNotify: true,
                    notifyErrorValue: reason,
                }
            }

            const processed = await processZipWithMetadata(da.data);
            const img = processed.dataUrl
            const seedUsed = processed.seedUsed ?? naiSeed
            if(returnSdData === 'inlay'){
                return {
                    result: { ok: true, bytesOrDataUrl: img, providerStatus: da.status },
                    compatibilityValue: img,
                    seedSupported: true,
                    seedUsed,
                }
            }

            let charemotions = get(CharEmotion)
            const emos:[string, string,number][] = [[img, img, Date.now()]]
            charemotions[currentChar.chaId] = emos
            CharEmotion.set(charemotions)
            return {
                result: { ok: true, bytesOrDataUrl: img, providerStatus: da.status },
                compatibilityValue: returnSdData,
                seedSupported: true,
                seedUsed,
            }

        } catch (error) {
            return {
                result: { ok: false, certainty: 'uncertain', reason: String(error) },
                compatibilityValue: false,
                shouldNotify: true,
                notifyErrorValue: error,
            }
        }
    }
    if(db.sdProvider === 'dalle'){
        const da = await globalFetch("https://api.openai.com/v1/images/generations", {
            body: {
                "prompt": genPrompt,
                "model": "dall-e-3",
                "response_format": "b64_json",
                "style": "natural",
                "quality": db.dallEQuality || 'standard'
            },
            headers: {
                "Authorization": "Bearer " + db.openAIKey
            }
        })

        console.log(da)

        if(returnSdData === 'inlay'){
            let res = da?.data?.data?.[0]?.b64_json
            if(!res){
                notifyError(JSON.stringify(da.data))
                return ''
            }
            return `data:image/png;base64,${res}`
        }

        else if(da.ok){
            let charemotions = get(CharEmotion)
            let img = da?.data?.data?.[0]?.b64_json
            if(!img){
                notifyError(JSON.stringify(da.data))
                return false
            }
            img = `data:image/png;base64,${img}`
            const emos:[string, string,number][] = [[img, img, Date.now()]]
            charemotions[currentChar.chaId] = emos
            CharEmotion.set(charemotions)
        }
        else{
            notifyError(Buffer.from(da.data).toString())
            return false   
        }
        return returnSdData
    }
    if(db.sdProvider === 'stability'){
        const formData = new FormData()
        const model = db.stabilityModel
        formData.append('prompt', genPrompt)
        if(model !== 'core' && model !== 'ultra'){
            formData.append('negative_prompt', neg)
            formData.append('model', model)
        }
        if(model === 'core'){
            if(db.stabllityStyle){
                formData.append('style_preset', db.stabllityStyle)
            }
        }
        if(model === 'ultra'){
            formData.append('negative_prompt', neg)
        }

        const uri = model === 'core' ? 'core' : model === 'ultra' ? 'ultra' : 'sd3'
        const da = await fetch("https://api.stability.ai/v2beta/stable-image/generate/" + uri, {
            body: formData,
            headers:{
                "authorization": "Bearer " + db.stabilityKey,
                "accept": "image/*"
            },
            method: 'POST'
        })

        const res = await da.arrayBuffer()
        if(!da.ok){
            notifyError(Buffer.from(res).toString())
            return false
        }

        if((da.headers["content-type"] ?? "").startsWith('application/json')){
            notifyError(Buffer.from(res).toString())
            return false
        }

        if(returnSdData === 'inlay'){
            return `data:image/png;base64,${Buffer.from(res).toString('base64')}`
        }

        let charemotions = get(CharEmotion)
        const img = `data:image/png;base64,${Buffer.from(res).toString('base64')}`
        const emos:[string, string,number][] = [[img, img, Date.now()]]
        charemotions[currentChar.chaId] = emos
        CharEmotion.set(charemotions)
        return returnSdData


    }

    if(db.sdProvider === 'comfy' || db.sdProvider === 'comfyui'){
        const legacy = db.sdProvider === 'comfy' // Legacy Comfy mode
        const {workflow, posNodeID, posInputName, negNodeID, negInputName} = db.comfyConfig
        const baseUrl = new URL(db.comfyUiUrl)

        const createUrl = (pathname: string, params: Record<string, string> = {}) => {
            const url = db.comfyUiUrl.endsWith('/api') ? new URL(`${db.comfyUiUrl}${pathname}`) : new URL(pathname, baseUrl)
            url.search = new URLSearchParams(params).toString()
            return url.toString()
        }

        const probePromptEndpoint = async (): Promise<boolean> => {
            const queueUrl = createUrl('/queue')
            try {
                const response = await withComfyRequestTimeout((signal) => globalFetch(queueUrl, {
                    method: 'GET',
                    headers: { 'Content-Type': 'application/json' },
                    abortSignal: signal,
                    requestTimeoutMs: COMFY_REQUEST_TIMEOUT_MS,
                    throwOnTransportError: true,
                }))
                return typeof response.status === 'number'
                    && response.status > 0
                    && response.status < 500
            } catch (error) {
                // A probe that failed before its own dispatch (auth refresh, URL
                // prep) observed nothing about the endpoint — it must not count
                // as unreachability evidence, so the original POST stays uncertain.
                if (isGlobalFetchTransportError(error) && !error.dispatched) return true
                return false
            }
        }

        const throwPromptUncertainAfterProbe = async (
            message: string,
            transportCause?: unknown,
        ): Promise<never> => {
            if (!await probePromptEndpoint()) {
                throw new Error(`${message} The one-shot ComfyUI queue probe could not reach the endpoint.`)
            }
            throw new ComfyPromptUncertainError(message, transportCause)
        }

        const fetchWrapper = async (url: string, options = {}) => {
            console.log(url)
            let response
            try {
                response = await globalFetch(url, options)
            } catch (error) {
                if (isGlobalFetchTransportError(error) && !error.dispatched) {
                    throw new Error(
                        `ComfyUI prompt submission failed before dispatch: ${String(error.transportCause)}`,
                    )
                }
                return throwPromptUncertainAfterProbe(
                    `ComfyUI prompt submission response was lost: ${String(error)}`,
                    error,
                )
            }
            if (!response.ok) {
                console.log(JSON.stringify(response.data))
                const message = `ComfyUI prompt request failed with status ${response.status}: ${JSON.stringify(response.data)}`
                if (typeof response.status === 'number'
                    && response.status >= 400
                    && response.status <= 499) {
                    throw new Error(message)
                }
                if (typeof response.status === 'number'
                    && response.status > 0
                    && response.status < 400) {
                    throw new ComfyPromptUncertainError(message)
                }
                return throwPromptUncertainAfterProbe(message)
            }
            return response.data
        }

        try {
            const prompt = JSON.parse(workflow)
            let comfySeedSupported = false
            let comfySeedUsed: number | null = null
            if(legacy){
                prompt[posNodeID].inputs[posInputName] = genPrompt
                prompt[negNodeID].inputs[negInputName] = neg
                for (const node of Object.values(prompt) as any[]) {
                    for (const inputName of Object.keys(node.inputs)) {
                        if (inputName === 'seed' && typeof node.inputs[inputName] === 'number') {
                            if (options.seed !== undefined) {
                                node.inputs[inputName] = options.seed
                            }
                            comfySeedSupported = true
                            comfySeedUsed ??= node.inputs[inputName]
                        }
                    }
                }
            }
            else{
                // Regional prompting lives in the user's own workflow: Comfy
                // expresses regions with several CLIPTextEncode nodes wired
                // into conditioning-area/combine nodes, and only the workflow
                // author knows which arrangement they want. So this does not
                // build or patch a graph — it extends the documented
                // {{risu_prompt}} placeholder contract with per-subject values
                // the workflow can pull into whichever node it likes.
                //
                //   {{risu_subject_N}}       caption for subject N (1-based)
                //   {{risu_subject_N_neg}}   its negative caption
                //   {{risu_subject_N_x}}     normalized CENTRE, 0..1
                //   {{risu_subject_N_y}}
                //   {{risu_subject_N_left}}  the region RECTANGLE, 0..1
                //   {{risu_subject_N_top}}
                //   {{risu_subject_N_width}}
                //   {{risu_subject_N_height}}
                //   {{risu_subject_N_strength}} 1 if subject N exists, else 0
                //   {{risu_subject_count}}   how many subjects this scene has
                //
                // `_strength` zeroes a spare region's contribution, but Comfy
                // still evaluates its conditioning. An unused slot is therefore
                // kept degenerate so that wasted pass stays cheap. A workflow
                // can remove that cost by putting ConditioningSetTimestepRange
                // between the area node and combine, with `end` bound to the
                // same {{risu_subject_N_strength}}: 1 keeps it fully active,
                // while 0 excludes it from every step.
                //
                // Both forms exist because the area nodes want a rectangle
                // whose x/y is its TOP-LEFT corner, not a centre — feeding a
                // centre straight into them shifts every region down and right.
                // The rectangle is the grid cell the caller's own centre falls
                // in, so it asserts nothing the caller did not already say.
                //
                // A placeholder for a subject the scene does not have resolves
                // to empty (or 0), so one workflow can serve scenes with fewer
                // subjects than it has regions.
                const subjectPositives = options.illustrationPrompt?.layout === 'nai-v4-characters'
                    ? options.illustrationPrompt.characterPositives
                    : []
                const subjectNegatives = options.illustrationPrompt?.layout === 'nai-v4-characters'
                    ? options.illustrationPrompt.characterNegatives
                    : []
                const subjectCenters = options.illustrationPrompt?.layout === 'nai-v4-characters'
                    ? (options.illustrationPrompt.characterCenters ?? [])
                    : []

                // The region is a full-height column, banded horizontally only.
                //
                // The vertical coordinate carries DEPTH, not height on screen:
                // a foreground subject is nearer the camera, not lower in the
                // frame. Banding vertically as well was measured against a real
                // generation and it confined two standing figures to the bottom
                // third — which made them small instead of near, the opposite of
                // what foreground means. Horizontal placement measured correct
                // in the same run, so only that becomes a boundary.
                //
                // An unplaced subject gets the whole canvas, so a region node
                // degrades to "no restriction" rather than pinning it somewhere
                // nobody asked for.
                // Each placed subject owns a column of width 1/N centred on its
                // own coordinate, where N is how many subjects are placed.
                //
                // Quantizing to fixed thirds instead was measured and it left a
                // gap: two subjects at left and right owned the outer thirds
                // and nobody owned the middle, so the base conditioning filled
                // it — with more people. Sizing by subject count closes that,
                // and it still respects the stated position, so two subjects
                // pressed together legitimately end up sharing a column rather
                // than being pushed apart.
                const UNUSED_SUBJECT_REGION_SIZE = 0.08
                const placedCount = subjectCenters.filter((centre) => centre).length || 1
                const columnWidth = 1 / placedCount
                const regionFor = (index: number) => {
                    if (!subjectPositives[index]) {
                        return {
                            left: 0,
                            top: 0,
                            width: UNUSED_SUBJECT_REGION_SIZE,
                            height: UNUSED_SUBJECT_REGION_SIZE,
                        }
                    }
                    const centre = subjectCenters[index]
                    if (!centre) return { left: 0, top: 0, width: 1, height: 1 }
                    const left = Math.min(Math.max(centre.x - columnWidth / 2, 0), 1 - columnWidth)
                    return { left, width: columnWidth, top: 0, height: 1 }
                }

                const subjectValue = (index: number, suffix: string | undefined): string | number => {
                    if (!Number.isInteger(index) || index < 0) return ''
                    switch (suffix) {
                        case '_neg': return subjectNegatives[index] ?? ''
                        case '_x': return subjectCenters[index]?.x ?? 0
                        case '_y': return subjectCenters[index]?.y ?? 0
                        case '_left': return regionFor(index).left
                        case '_top': return regionFor(index).top
                        case '_width': return regionFor(index).width
                        case '_height': return regionFor(index).height
                        case '_strength': return subjectPositives[index] ? 1 : 0
                        default: return subjectPositives[index] ?? ''
                    }
                }

                const SUBJECT_PLACEHOLDER = /\{\{risu_subject_(\d+)(_neg|_x|_y|_left|_top|_width|_height|_strength)?\}\}/g

                const substituteText = (value: string) => value
                    .replaceAll('{{risu_prompt}}', genPrompt)
                    .replaceAll('{{risu_neg}}', neg)
                    .replaceAll('{{risu_subject_count}}', String(subjectPositives.length))
                    .replace(SUBJECT_PLACEHOLDER, (_match, ordinal: string, suffix: string | undefined) => (
                        String(subjectValue(Number(ordinal) - 1, suffix))
                    ))

                // Comfy area nodes take numbers, not strings. An input whose
                // ENTIRE value is a geometry placeholder becomes a number; one
                // embedded in a larger string stays text.
                const NUMERIC_PLACEHOLDER = /^\{\{risu_subject_(\d+)(_x|_y|_left|_top|_width|_height|_strength)\}\}$/
                const NUMERIC_COUNT_PLACEHOLDER = '{{risu_subject_count}}'

                // A workflow with fewer regions than the scene has subjects
                // would otherwise drop the later ones with no error and no
                // trace. Silently losing a subject is precisely the failure
                // regional placement exists to prevent, so track which
                // captions were actually consumed and refuse before posting.
                const consumed = new Set<number>()
                const noteConsumed = (value: string) => {
                    for (const found of value.matchAll(SUBJECT_PLACEHOLDER)) {
                        consumed.add(Number(found[1]))
                    }
                }

                //search all nodes for the prompt and negative prompt
                const keys = Object.keys(prompt)
                for(let i = 0; i < keys.length; i++){
                    const node = prompt[keys[i]]
                    const inputKeys = Object.keys(node.inputs)
                    for(let j = 0; j < inputKeys.length; j++){
                        let input = node.inputs[inputKeys[j]]
                        if(typeof input === 'string'){
                            noteConsumed(input)
                            const trimmed = input.trim()
                            const numeric = NUMERIC_PLACEHOLDER.exec(trimmed)
                            if(numeric){
                                input = Number(subjectValue(Number(numeric[1]) - 1, numeric[2]))
                            }
                            else if(trimmed === NUMERIC_COUNT_PLACEHOLDER){
                                input = subjectPositives.length
                            }
                            else{
                                input = substituteText(input)
                            }
                        }

                        if(inputKeys[j] === 'seed' && typeof input === 'number'){
                            input = options.seed ?? Math.floor(Math.random() * 1000000000)
                            comfySeedSupported = true
                            comfySeedUsed ??= input
                        }

                        node.inputs[inputKeys[j]] = input
                    }
                }

                const unconsumed = subjectPositives
                    .map((_caption, index) => index + 1)
                    .filter((ordinal) => !consumed.has(ordinal))
                if (subjectPositives.length > 0 && unconsumed.length > 0) {
                    // Nothing has been posted yet, so this costs nothing.
                    return {
                        result: {
                            ok: false,
                            certainty: 'definite',
                            reason: `The Comfy workflow has no placeholder for subject ${unconsumed.join(', ')}. `
                                + `Add {{risu_subject_${unconsumed[0]}}} (and its region) to the workflow, `
                                + 'or turn regional placement off.',
                        },
                        compatibilityValue: returnSdData === 'inlay' ? '' : false,
                        shouldNotify: true,
                        notifyErrorValue: `Comfy workflow is missing a region for subject ${unconsumed.join(', ')}.`,
                    }
                }
            }

            const promptResponse = await fetchWrapper(createUrl('/prompt'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: { 'prompt': prompt },
                requestTimeoutMs: COMFY_PROMPT_REQUEST_TIMEOUT_MS,
                throwOnTransportError: true,
            })
            const id = isComfyRecord(promptResponse) ? promptResponse.prompt_id : undefined
            if (typeof id !== 'string' || id.trim().length === 0) {
                throw new ComfyPromptUncertainError(
                    'ComfyUI prompt acknowledgement did not contain a usable prompt_id; submission outcome is uncertain.',
                )
            }
            console.log(`prompt id: ${id}`)

            const queueSubscription = subscribeComfyQueue(createUrl, id)
            try {
                let item = queueSubscription.checkHistoryImmediately
                    ? await readComfyHistory(createUrl, id)
                    : undefined
                let consecutiveAbsences = 0
                while (!item) {
                    const queue = await queueSubscription.next()
                    if (!queue.valid) continue
                    if (queue.queuedIds.has(id)) {
                        consecutiveAbsences = 0
                        continue
                    }

                    const history = await readComfyHistory(createUrl, id)
                    if (history) {
                        item = history
                        break
                    }
                    if (queueSubscription.getLastQueuedSequence() > queue.sequence) {
                        consecutiveAbsences = 0
                        continue
                    }
                    consecutiveAbsences += 1
                    // One empty observation can be the queue-to-history handoff.
                    if (consecutiveAbsences >= 2) {
                        alertError('Error: ComfyUI job disappeared from both queue and history.')
                        return false
                    }
                }
                // A history entry also appears when the workflow failed, but then it carries
                // no outputs — surface the reported cause instead of dying on undefined.
                const failure = (item.status?.messages ?? []).find((m: any) =>
                    Array.isArray(m) && (m[0] === 'execution_error' || m[0] === 'execution_interrupted'))
                if(failure){
                    const info = failure[1] ?? {}
                    const detail = [info.node_type ?? info.node_id, info.exception_type, info.exception_message].filter(Boolean).join(': ')
                    alertError(`Error: ComfyUI ${failure[0]}${detail ? ` (${detail})` : ''}`)
                    return false
                }
                const genImgInfo = Object.values(item.outputs).flatMap((output: any) => Array.isArray(output?.images) ? output.images : [])[0];
                if(!genImgInfo?.filename){
                    alertError("Error: ComfyUI returned no image. Check that the workflow has a SaveImage output node.")
                    return false
                }

                const imgBuffer = await downloadComfyImage(
                    createUrl('/view', {
                        filename: genImgInfo.filename,
                        subfolder: genImgInfo.subfolder,
                        type: genImgInfo.type,
                    }),
                    () => getComfyQueueHealth(createUrl),
                )
                const img64 = Buffer.from(imgBuffer).toString('base64')

                if(returnSdData === 'inlay'){
                    const dataUrl = `data:image/png;base64,${img64}`
                    return {
                        result: { ok: true, bytesOrDataUrl: dataUrl, providerStatus: 200 },
                        compatibilityValue: dataUrl,
                        seedSupported: comfySeedSupported,
                        seedUsed: comfySeedSupported ? comfySeedUsed : null,
                    }
                }
                else {
                    let charemotions = get(CharEmotion)
                    const img = `data:image/png;base64,${img64}`
                    const emos:[string, string,number][] = [[img, img, Date.now()]]
                    charemotions[currentChar.chaId] = emos
                    CharEmotion.set(charemotions)
                }

                return {
                    result: { ok: true, bytesOrDataUrl: `data:image/png;base64,${img64}`, providerStatus: 200 },
                    compatibilityValue: returnSdData,
                    seedSupported: comfySeedSupported,
                    seedUsed: comfySeedSupported ? comfySeedUsed : null,
                }
            } finally {
                queueSubscription.unsubscribe()
            }
        } catch (error) {
            if (isComfyPromptUncertainError(error)) {
                notifyError(error)
                return {
                    result: { ok: false, certainty: 'uncertain', reason: error.message },
                    compatibilityValue: false,
                }
            }
            if (isComfyDefiniteHttpError(error)) {
                alertError(`Error: ${error.message}`)
            } else {
                notifyError(error)
            }
            return false
        }
    }
    if(db.sdProvider === 'fal'){
        const model = db.falModel
        const token = db.falToken

        let body:{[key:string]:any} = {
            prompt: genPrompt,
            enable_safety_checker: false,
            sync_mode: true,
            image_size: {
                "width": db.sdConfig.width,
                "height": db.sdConfig.height,
            }
        }

        if(db.falModel === 'fal-ai/flux-lora'){
            let loraPath = db.falLora
            if(loraPath.startsWith('urn:') || loraPath.startsWith('civitai:')){
                const id = loraPath.split('@').pop()
                loraPath = `https://civitai.com/api/download/models/${id}?type=Model&format=SafeTensor`
            }
            body.loras = [{
                "path": loraPath,
                "scale": db.falLoraScale
            }]
        }

        if(db.falModel === 'fal-ai/flux-pro'){
            delete body.enable_safety_checker
        }

        const res = await globalFetch('https://fal.run/' + model, {
            headers: {
                "Authorization": "Key " + token,
                "Content-Type": "application/json"
            },
            method: 'POST',
            body: body
        })

        if(!res.ok){
            notifyError(JSON.stringify(res.data))
            return false
        }

        let image = res.data?.images?.[0]?.url
        if(!image){
            notifyError(JSON.stringify(res.data))
            return false
        }

        if(returnSdData === 'inlay'){
            return image
        }
        else{
            let charemotions = get(CharEmotion)
            const emos:[string, string,number][] = [[image, image, Date.now()]]
            charemotions[currentChar.chaId] = emos
            CharEmotion.set(charemotions)
        }
    }
    if(db.sdProvider === 'Imagen') {
        const model = db.ImagenModel
        const size = db.ImagenImageSize
        const aspect = db.ImagenAspectRatio
        const person = db.ImagenPersonGeneration

        let body:any = {
            instances: [{
                prompt: genPrompt
            }],
            parameters: {
                sampleCount: 1,
                aspectRatio: aspect,
                personGeneration: person,
            }
        }

        if(model === 'imagen-4.0-generate-001' || model === 'imagen-4.0-ultra-generate-001') {
            body.parameters = {
                ...body.parameters,
                sampleImageSize: size
            }
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${db.google.accessToken}`

        const res = await globalFetch(url, {
            headers: {
                "Content-Type": "application/json"
            },
            method: 'POST',
            body: body,
        })

        if(!res.ok) {
            notifyError(JSON.stringify(res.data))
            return false
        }

        const img64 = res.data?.predictions?.[0]?.bytesBase64Encoded

        if(!img64) {
            notifyError(JSON.stringify(res.data))
            return false
        }
        
        const mimeType = res.data?.predictions?.[0]?.mimeType || 'image/png'
        return `data:${mimeType};base64,${img64}`
    }
    if(db.sdProvider === 'openai-compat'){
        const config = db.openaiCompatImage
        if(!config.url){
            notifyError("OpenAI Compatible API URL is not set")
            return false
        }

        const body: {[key:string]: any} = {
            "prompt": genPrompt,
            "response_format": "b64_json",
            "size": config.size || "1024x1024",
            "quality": config.quality || "auto"
        }

        if(config.model){
            body.model = config.model
        }

        const headers: {[key:string]: string} = {
            "Content-Type": "application/json"
        }

        if(config.key){
            headers["Authorization"] = "Bearer " + config.key
        }

        const da = await globalFetch(config.url, {
            body: body,
            headers: headers
        })

        if(returnSdData === 'inlay'){
            let res = da?.data?.data?.[0]?.b64_json
            if(!res){
                notifyError(JSON.stringify(da.data))
                return ''
            }
            return `data:image/png;base64,${res}`
        }

        if(da.ok){
            let charemotions = get(CharEmotion)
            let img = da?.data?.data?.[0]?.b64_json
            if(!img){
                notifyError(JSON.stringify(da.data))
                return false
            }
            img = `data:image/png;base64,${img}`
            const emos:[string, string,number][] = [[img, img, Date.now()]]
            charemotions[currentChar.chaId] = emos
            CharEmotion.set(charemotions)
        }
        else{
            notifyError(JSON.stringify(da.data))
            return false
        }
        return returnSdData
    }
    if(db.sdProvider === 'wavespeed'){
        const config = db.wavespeedImage
        if (!config.key) {
            notifyError('Please enter wavespeed API key')
            return false
        }
        const body: {[key:string]: any} = {}

        // Prompt
        body.prompt = genPrompt

        // reference image
        let base64img = ''
        if (config.reference_mode === 'image') {
            // reference: uploaded image
            base64img = config.reference_base64image
        }
        else if (config.reference_mode === 'character') {
            // reference: auto use the character's default image
            const charimg = currentChar.image;
            const img = await readImage(charimg)
            if (img) {
                base64img = Buffer.from(img).toString('base64')
            }
        }
        if(base64img){
            body.images = [base64img]
        }

        // LoRAs
        if (config.loras && Array.isArray(config.loras)) {
            body.loras = [];
            for (const lora of config.loras) {
                if (lora && lora.path && lora.path.trim() !== "") {
                    body.loras.push({
                        path: lora.path,
                        scale: typeof lora.scale === 'number' ? lora.scale : 1.0
                    });
                }
            }
        }

        // Request
        try {
            // First: submit task
            const requestEndpoint = `https://api.wavespeed.ai/api/v3/${config.model}`
            const requestResponse = await globalFetch(requestEndpoint, {
                body: body,
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + config.key
                }
            })
            let requestId: string;
            if (requestResponse.ok) {
                /*
                * submit response:
                * {
                *   code: number = HTTP status code (e.g., 200 for success)
                *   message: string = Status message (e.g., “success”)
                *   data: {
                *     id: string = Unique identifier for the prediction, Task Id
                *   }
                * }
                * */
                requestId = requestResponse.data.data.id
            }
            else {
                notifyError(`Submit task failed ${requestResponse.status}: ${requestResponse.data}`)
                return false
            }

            // Second: monitor task
            const taskEndpoint = `https://api.wavespeed.ai/api/v3/predictions/${requestId}/result`
            let resultEndpoint: string;
            const POLL_INTERVAL = 3000; // monitor every 3 seconds
            const MAX_WAIT_TIME = 10 * 60 * 1000; // 10 minutes absolute timeout
            const startTime = Date.now();
            while (true) {
                const elapsedTime = Date.now() - startTime;
                if (elapsedTime > MAX_WAIT_TIME) {
                    notifyError(`Task timeout after ${MAX_WAIT_TIME / 1000}s`);
                    break;
                }
                const taskResponse = await globalFetch(taskEndpoint, {
                    method: 'GET',
                    headers: {
                        "Authorization": "Bearer " + config.key
                    }
                })
                if (taskResponse.ok) {
                    /*
                    * monitor response:
                    * {
                    *   code: number = HTTP status code (e.g., 200 for success)
                    *   message: string = Status message (e.g., “success”)
                    *   data: {
                    *     status: string = Status of the task: created, processing, completed, or failed
                    *     outputs: string[] = Array of URLs to the generated content (empty when status is not completed)
                    *   }
                    * }
                    * */
                    if (taskResponse.data.data.status === 'completed') {
                        resultEndpoint = taskResponse.data.data.outputs[0]
                        break
                    }
                    else if (taskResponse.data.data.status === 'failed') {
                        notifyError(JSON.stringify(taskResponse.data))
                        break
                    }
                    // else keep loop
                    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
                }
                else {
                    notifyError(JSON.stringify(taskResponse.data))
                    break
                }
            }
            if (!resultEndpoint) {
                notifyError('Task finished but no result URL')
                return false
            }

            // Third: get result
            const resultResponse = await globalFetch(resultEndpoint, {
                method: 'GET',
                headers: {
                    "Authorization": "Bearer " + config.key
                },
                rawResponse: true
            })
            if (resultResponse.ok) {
                // mime-type: jpeg (default), png, webp
                const contentType = resultResponse.headers?.['content-type'] || 'image/jpeg'
                const mimeType = contentType.split(';')[0] // resolve "image/png; charset=utf-8"

                // binary image file, need to convert to base64
                const binary = resultResponse.data
                const res = Buffer.from(binary).toString('base64');
                const img = `data:${mimeType};base64,${res}`

                // inlay mode
                if(returnSdData === 'inlay'){
                    return img
                }
                // default mode
                else {
                    let charemotions = get(CharEmotion)
                    charemotions[currentChar.chaId] = [[img, img, Date.now()]]
                    CharEmotion.set(charemotions)
                    return returnSdData
                }
            }
            else {
                notifyError(JSON.stringify(resultResponse.data))
                return false
            }
        } catch (error) {
            notifyError(error)
            return false
        }
    }
    return ''
}
