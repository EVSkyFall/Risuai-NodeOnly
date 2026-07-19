import type { ImageGenerationResult } from '../stableDiff'
import { IllustrationPromptV2ContractError } from './errors'
import type { IllustrationPromptTargetV2 } from './promptContextV2'

// ---------------------------------------------------------------------------
// Provider-neutral transport dispatch (request §7.2-7.4 / §8).
//
// These builders place the EXACT serialized positive/negative text into each
// transport's request with ZERO mangling — no trimming, no NAI bracket→brace
// escaping, no dedupe/reorder/reweight (contrast stableDiff.ts's NovelAI branch,
// which remaps parens). The dispatch functions take an INJECTED fetch so the HTTP
// certainty classification (request §8) is unit-testable without a live provider:
// a received HTTP response is a DEFINITE outcome for a non-charging local backend
// (webui/comfy) and UNCERTAIN for a possibly-charging remote (nai-compatible); a
// thrown socket/timeout is ALWAYS uncertain, and no path auto-duplicates a request.
// ---------------------------------------------------------------------------

export type TransportFetchArg = {
    body?: unknown
    headers?: Record<string, string>
    method?: 'POST' | 'GET'
    plainFetchDeforce?: boolean
    redactRequestLog?: boolean
    proxyRequestHeaders?: Record<string, string>
    abortSignal?: AbortSignal
}

export type TransportFetchResult = {
    ok: boolean
    data: unknown
    headers: Record<string, string>
    status: number
}

export type TransportFetch = (url: string, arg: TransportFetchArg) => Promise<TransportFetchResult>

// A raw-bytes fetch (ComfyUI polling + /view). Mirrors fetchNative's minimal surface.
export type TransportNativeFetch = (url: string, arg: TransportFetchArg) => Promise<{
    ok: boolean
    status: number
    json(): Promise<unknown>
    arrayBuffer(): Promise<ArrayBuffer>
}>

// ---------------------------------------------------------------------------
// WebUI (A1111/Forge) — flat positive/negative exact into /sdapi/v1/txt2img.
// ---------------------------------------------------------------------------

export type WebuiDispatchParams = {
    width: number
    height: number
    steps: number
    cfgScale: number
    samplerName: string
    enableHr: boolean
    denoisingStrength: number
    hrScale: number
    hrUpscaler: string
}

// request-pinned pins the checkpoint via override_settings; probe-and-revalidate
// leaves the backend's current checkpoint in place (the caller has already
// re-verified its identity) and omits the override.
export function buildWebuiTxt2ImgBody(
    positive: string,
    negative: string,
    params: WebuiDispatchParams,
    pinnedCheckpoint: string | null,
): Record<string, unknown> {
    const body: Record<string, unknown> = {
        width: params.width,
        height: params.height,
        seed: -1,
        steps: params.steps,
        cfg_scale: params.cfgScale,
        // EXACT text — the code units are the Plugin's compiled prompt verbatim.
        prompt: positive,
        negative_prompt: negative,
        sampler_name: params.samplerName,
        enable_hr: params.enableHr,
        denoising_strength: params.denoisingStrength,
        hr_scale: params.hrScale,
        hr_upscaler: params.hrUpscaler,
    }
    if (pinnedCheckpoint !== null) {
        body.override_settings = { sd_model_checkpoint: pinnedCheckpoint }
        body.override_settings_restore_afterwards = true
    }
    return body
}

export function webuiTxt2ImgUrl(endpoint: string): string {
    const url = new URL(endpoint)
    url.pathname = '/sdapi/v1/txt2img'
    return url.toString()
}

// ---------------------------------------------------------------------------
// ComfyUI — inject exact text into the ELECTION's positive/negative node inputs
// (never a general graph guess; the target pins the node ids + input names).
// ---------------------------------------------------------------------------

export type ComfyNodeBinding = { nodeId: string; inputName: string }

// Parse + inject on a COPY of the workflow graph so the durable db.comfyConfig
// string is never mutated. Missing/typeless target nodes are a definite pre-call
// failure (request §7.4 missing binding => provider-call-0).
export function buildComfyWorkflowGraph(
    workflowJson: string,
    positiveNode: ComfyNodeBinding,
    negativeNode: ComfyNodeBinding,
    positive: string,
    negative: string,
): Record<string, unknown> {
    let graph: unknown
    try {
        graph = JSON.parse(workflowJson)
    } catch {
        throw new IllustrationPromptV2ContractError(
            'prompt_target_fingerprint_mismatch',
            'The ComfyUI workflow JSON is not parseable at dispatch time',
        )
    }
    if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
        throw new IllustrationPromptV2ContractError(
            'prompt_target_fingerprint_mismatch',
            'The ComfyUI workflow is not a node graph object',
        )
    }
    const cloned = JSON.parse(JSON.stringify(graph)) as Record<string, unknown>
    injectComfyNode(cloned, positiveNode, positive)
    injectComfyNode(cloned, negativeNode, negative)
    return cloned
}

function injectComfyNode(graph: Record<string, unknown>, binding: ComfyNodeBinding, text: string): void {
    const node = graph[binding.nodeId]
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        throw new IllustrationPromptV2ContractError(
            'prompt_target_fingerprint_mismatch',
            `The ComfyUI workflow has no node "${binding.nodeId}" to bind`,
        )
    }
    const inputs = (node as Record<string, unknown>).inputs
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
        throw new IllustrationPromptV2ContractError(
            'prompt_target_fingerprint_mismatch',
            `The ComfyUI node "${binding.nodeId}" has no inputs object`,
        )
    }
    const inputRecord = inputs as Record<string, unknown>
    if (!Object.hasOwn(inputRecord, binding.inputName)) {
        throw new IllustrationPromptV2ContractError(
            'prompt_target_fingerprint_mismatch',
            `The ComfyUI node "${binding.nodeId}" has no input "${binding.inputName}"`,
        )
    }
    // EXACT text — verbatim assignment, never a template replaceAll that could
    // duplicate on repeated placeholders.
    inputRecord[binding.inputName] = text
}

export function comfyPromptUrl(endpoint: string): string {
    return joinComfyPath(endpoint, '/prompt')
}

export function comfyHistoryUrl(endpoint: string): string {
    return joinComfyPath(endpoint, '/history')
}

export function comfyViewUrl(
    endpoint: string,
    params: { filename: string; subfolder: string; type: string },
): string {
    const base = joinComfyPath(endpoint, '/view')
    const url = new URL(base)
    url.search = new URLSearchParams(params).toString()
    return url.toString()
}

function joinComfyPath(endpoint: string, pathname: string): string {
    const url = endpoint.endsWith('/api')
        ? new URL(`${endpoint}${pathname}`)
        : new URL(pathname, new URL(endpoint))
    return url.toString()
}

// ---------------------------------------------------------------------------
// NAI-compatible flat — NAI-shaped JSON body, but tags are OPAQUE: no NAI T5,
// no bracket escaping, no truncation (request §7.2). Flat/pipe text goes into
// input/negative_prompt exactly.
// ---------------------------------------------------------------------------

export function buildNaiCompatibleBody(
    positive: string,
    negative: string,
    modelId: string | null,
): Record<string, unknown> {
    return {
        input: positive,
        model: modelId ?? undefined,
        action: 'generate',
        parameters: {
            negative_prompt: negative,
        },
    }
}

// ---------------------------------------------------------------------------
// Certainty classification (request §8). Charging remotes never claim a definite
// no-charge on a provider error; local backends do (no charge concept). A thrown
// socket/timeout is always uncertain — the request may have reached the provider.
// ---------------------------------------------------------------------------

export type TransportCertaintyPolicy = {
    // Whether a received (non-ok) HTTP response is a DEFINITE no-image outcome.
    httpErrorIsDefinite: boolean
}

export function certaintyPolicyForTransport(target: IllustrationPromptTargetV2): TransportCertaintyPolicy {
    switch (target.transportId) {
        case 'webui-flat':
        case 'comfyui-flat':
            // Local, non-charging: a received error means no image and no charge.
            return { httpErrorIsDefinite: true }
        case 'nai-compatible-flat':
        case 'novelai-native':
            // Possibly-charging remote: a received error cannot confirm no-charge.
            return { httpErrorIsDefinite: false }
    }
}

function httpFailureResult(
    policy: TransportCertaintyPolicy,
    status: number,
    reason: string,
): ImageGenerationResult {
    if (policy.httpErrorIsDefinite) {
        return { ok: false, certainty: 'definite', reason, providerStatus: status }
    }
    return { ok: false, certainty: 'uncertain', reason }
}

function thrownResult(error: unknown): ImageGenerationResult {
    // socket reset / timeout / lost response — never auto-duplicated.
    return { ok: false, certainty: 'uncertain', reason: String(error) }
}

// ---------------------------------------------------------------------------
// Dispatch functions (injected fetch).
// ---------------------------------------------------------------------------

export type WebuiDispatchInput = {
    target: IllustrationPromptTargetV2
    endpoint: string
    positive: string
    negative: string
    params: WebuiDispatchParams
    pinnedCheckpoint: string | null
    fetchImpl: TransportFetch
}

export async function dispatchWebuiFlat(input: WebuiDispatchInput): Promise<ImageGenerationResult> {
    const policy = certaintyPolicyForTransport(input.target)
    let response: TransportFetchResult
    try {
        // No `risu-image-class` proxy header: that marker forces the SERVER NovelAI broker
        // to validate the request as NAI-class (https + Bearer/NAI body shape), which a
        // local webui backend is not. Only the genuinely NAI-class transports carry it.
        response = await input.fetchImpl(webuiTxt2ImgUrl(input.endpoint), {
            method: 'POST',
            body: buildWebuiTxt2ImgBody(input.positive, input.negative, input.params, input.pinnedCheckpoint),
            headers: { 'Content-Type': 'application/json' },
            plainFetchDeforce: true,
            redactRequestLog: true,
        })
    } catch (error) {
        return thrownResult(error)
    }
    if (!response.ok) {
        return httpFailureResult(policy, response.status, `webui-flat provider error (HTTP ${response.status})`)
    }
    const image = extractWebuiImage(response.data)
    if (image === null) {
        return httpFailureResult(policy, response.status, 'webui-flat response carried no image')
    }
    return { ok: true, bytesOrDataUrl: `data:image/png;base64,${image}`, providerStatus: response.status }
}

function extractWebuiImage(data: unknown): string | null {
    if (!data || typeof data !== 'object') return null
    const images = (data as Record<string, unknown>).images
    if (!Array.isArray(images) || typeof images[0] !== 'string' || images[0].length === 0) return null
    return images[0]
}

export type NaiCompatibleDispatchInput = {
    target: IllustrationPromptTargetV2
    endpoint: string
    positive: string
    negative: string
    modelId: string | null
    apiKey: string
    fetchImpl: TransportFetch
    priorityClass: 'interactive' | 'background'
    // Extracts base64 image bytes from a successful response (e.g. ZIP unpack).
    extractImage: (data: unknown) => Promise<string | null> | string | null
}

export async function dispatchNaiCompatibleFlat(
    input: NaiCompatibleDispatchInput,
): Promise<ImageGenerationResult> {
    const policy = certaintyPolicyForTransport(input.target)
    let response: TransportFetchResult
    try {
        response = await input.fetchImpl(input.endpoint, {
            method: 'POST',
            body: buildNaiCompatibleBody(input.positive, input.negative, input.modelId),
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${input.apiKey}`,
            },
            plainFetchDeforce: true,
            redactRequestLog: true,
            proxyRequestHeaders: { 'risu-image-class': input.priorityClass },
        })
    } catch (error) {
        return thrownResult(error)
    }
    if (!response.ok) {
        return httpFailureResult(policy, response.status, `nai-compatible-flat provider error (HTTP ${response.status})`)
    }
    let image: string | null
    try {
        image = await input.extractImage(response.data)
    } catch (error) {
        return thrownResult(error)
    }
    if (image === null) {
        return httpFailureResult(policy, response.status, 'nai-compatible-flat response carried no image')
    }
    return { ok: true, bytesOrDataUrl: `data:image/png;base64,${image}`, providerStatus: response.status }
}

export type ComfyuiDispatchInput = {
    target: IllustrationPromptTargetV2
    endpoint: string
    positive: string
    negative: string
    workflowJson: string
    positiveNode: ComfyNodeBinding
    negativeNode: ComfyNodeBinding
    fetchImpl: TransportFetch
    nativeFetchImpl: TransportNativeFetch
    timeoutMs: number
    now: () => number
    sleep: (ms: number) => Promise<void>
}

export async function dispatchComfyuiFlat(input: ComfyuiDispatchInput): Promise<ImageGenerationResult> {
    const policy = certaintyPolicyForTransport(input.target)
    // Build/inject BEFORE any network I/O so a missing binding is provider-call-0.
    let graph: Record<string, unknown>
    try {
        graph = buildComfyWorkflowGraph(
            input.workflowJson,
            input.positiveNode,
            input.negativeNode,
            input.positive,
            input.negative,
        )
    } catch (error) {
        // A binding/parse failure is a DEFINITE config rejection — no provider call.
        return { ok: false, certainty: 'definite', reason: String(error) }
    }

    let promptId: string
    try {
        const submit = await input.fetchImpl(comfyPromptUrl(input.endpoint), {
            method: 'POST',
            body: { prompt: graph },
            headers: { 'Content-Type': 'application/json' },
            plainFetchDeforce: true,
            redactRequestLog: true,
        })
        if (!submit.ok) {
            return httpFailureResult(policy, submit.status, `comfyui-flat submit error (HTTP ${submit.status})`)
        }
        const id = (submit.data as Record<string, unknown> | null)?.prompt_id
        if (typeof id !== 'string' || id.length === 0) {
            return httpFailureResult(policy, submit.status, 'comfyui-flat submit returned no prompt_id')
        }
        promptId = id
    } catch (error) {
        return thrownResult(error)
    }

    const startTime = input.now()
    try {
        for (;;) {
            const history = await input.nativeFetchImpl(comfyHistoryUrl(input.endpoint), {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
            })
            // Transport fidelity: a non-ok /history is a received provider error, not a
            // "prompt not ready yet" poll — classify it via the certainty policy instead
            // of feeding an error body into json() and treating it as an empty history.
            if (!history.ok) {
                return httpFailureResult(policy, history.status, `comfyui-flat history error (HTTP ${history.status})`)
            }
            const parsed = (await history.json()) as Record<string, unknown>
            const entry = parsed?.[promptId]
            if (entry) {
                const descriptor = extractComfyImageDescriptor(entry)
                if (!descriptor) {
                    return { ok: false, certainty: 'definite', reason: 'comfyui-flat history carried no image output' }
                }
                const view = await input.nativeFetchImpl(comfyViewUrl(input.endpoint, descriptor), {
                    method: 'GET',
                    headers: { 'Content-Type': 'application/json' },
                })
                // Transport fidelity: a pruned/renamed/moved output makes /view return an
                // HTTP error whose body is NOT image bytes. Never base64-wrap an error body
                // as a genuine PNG with a hardcoded 200 — classify it via the certainty policy.
                if (!view.ok) {
                    return httpFailureResult(policy, view.status, `comfyui-flat view error (HTTP ${view.status})`)
                }
                const bytes = await view.arrayBuffer()
                const base64 = Buffer.from(bytes).toString('base64')
                return { ok: true, bytesOrDataUrl: `data:image/png;base64,${base64}`, providerStatus: view.status }
            }
            if (input.now() - startTime >= input.timeoutMs) {
                // Timeout: the generation may still complete server-side — uncertain,
                // never auto-duplicated (request §8).
                return { ok: false, certainty: 'uncertain', reason: 'comfyui-flat generation timed out' }
            }
            await input.sleep(1000)
        }
    } catch (error) {
        return thrownResult(error)
    }
}

export function extractComfyImageDescriptor(
    entry: unknown,
): { filename: string; subfolder: string; type: string } | null {
    if (!entry || typeof entry !== 'object') return null
    const outputs = (entry as Record<string, unknown>).outputs
    if (!outputs || typeof outputs !== 'object') return null
    for (const output of Object.values(outputs as Record<string, unknown>)) {
        if (!output || typeof output !== 'object') continue
        const images = (output as Record<string, unknown>).images
        if (Array.isArray(images) && images.length > 0) {
            const first = images[0]
            if (
                first && typeof first === 'object'
                && typeof (first as Record<string, unknown>).filename === 'string'
            ) {
                const record = first as Record<string, unknown>
                return {
                    filename: record.filename as string,
                    subfolder: typeof record.subfolder === 'string' ? record.subfolder : '',
                    type: typeof record.type === 'string' ? record.type : 'output',
                }
            }
        }
    }
    return null
}
