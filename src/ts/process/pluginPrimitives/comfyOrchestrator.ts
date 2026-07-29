import { forageStorage } from '../../globalApi.svelte'

const ENDPOINT = '/api/comfy/orchestrator'
const PROTOCOL_VERSION = 1

export interface ComfySlots {
    positive: string
    input_image: string
    seed: number
}

export interface ComfySubmitInput {
    operationKey: string
    template: string
    slots: ComfySlots
    target?: { charId?: string; chatId?: string }
}

export interface ComfyJobSnapshot {
    jobId: string
    operationKey: string
    template: string
    templateHash: string
    endpointGeneration: number
    target?: { charId?: string; chatId?: string }
    promptId?: string
    state: string
    revision: number
    error?: { code: string; message: string }
    resultAssetId?: string
    mimeType?: string
    createdAt: number
    updatedAt: number
    startedAt?: number
    finishedAt?: number
    deadlineAt: number
}

export interface ComfyHealth {
    reachable: boolean
    latencyMs?: number
    endpointGeneration?: number
    stats?: unknown
    error?: { code: string; message: string }
}

export interface ComfyConfig {
    url: string
    configured: boolean
    timeoutMs: number
    templateDir: string
    endpointGeneration: number
    health?: ComfyHealth
}

export interface ComfyHttpResponse {
    status: number
    json(): Promise<any>
}

export type ComfyTransport = (body: unknown) => Promise<ComfyHttpResponse>

export interface ComfySandboxFailure {
    ok: false
    code: string
    message: string
    uncertain: boolean
}

export type ComfySandboxResult<T extends object = Record<string, never>> =
    | ({ ok: true } & T)
    | ComfySandboxFailure

export class ComfyRelayError extends Error {
    readonly code: string
    readonly uncertain: boolean

    constructor(code: string, message: string, uncertain = false) {
        super(message)
        this.name = 'ComfyRelayError'
        this.code = code
        this.uncertain = uncertain
    }
}

async function defaultTransport(body: unknown): Promise<ComfyHttpResponse> {
    const token = await forageStorage.createAuth()
    return await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'risu-auth': token,
        },
        body: JSON.stringify(body),
    })
}

function relayFailure(error: unknown, submitTransport = false): ComfySandboxFailure {
    if (error instanceof ComfyRelayError) {
        return {
            ok: false,
            code: error.code,
            message: error.message,
            uncertain: error.uncertain,
        }
    }
    return {
        ok: false,
        code: submitTransport ? 'COMFY_TRANSPORT_UNCERTAIN' : 'COMFY_TRANSPORT_FAILED',
        message: error instanceof Error ? error.message : String(error),
        uncertain: submitTransport,
    }
}

export class ComfyOrchestratorClient {
    private readonly transport: ComfyTransport

    constructor(options: { transport?: ComfyTransport } = {}) {
        this.transport = options.transport ?? defaultTransport
    }

    async send(
        op: string,
        input: Record<string, unknown> = {},
        uncertainIfResponseInvalid = false,
    ): Promise<any> {
        const response = await this.transport({ protocolVersion: PROTOCOL_VERSION, op, ...input })
        let data: any
        try {
            data = await response.json()
        } catch {
            const submitCouldHaveCommitted = uncertainIfResponseInvalid
                && ((response.status >= 200 && response.status < 300) || response.status >= 500)
            throw new ComfyRelayError(
                'COMFY_RESPONSE_INVALID',
                'Core returned a non-JSON Comfy response',
                submitCouldHaveCommitted,
            )
        }
        const successStatus = response.status >= 200 && response.status < 300
        const submitCouldHaveCommitted = uncertainIfResponseInvalid
            && (successStatus || response.status >= 500)
        if (successStatus && data?.ok === true) {
            if (!uncertainIfResponseInvalid || (typeof data.jobId === 'string' && data.jobId.length > 0)) {
                return data
            }
            throw new ComfyRelayError(
                'COMFY_RESPONSE_INVALID',
                'Core returned an invalid Comfy response envelope',
                submitCouldHaveCommitted,
            )
        }
        if (data?.ok === false
            && typeof data.code === 'string'
            && typeof data.message === 'string'
            && typeof data.uncertain === 'boolean') {
            throw new ComfyRelayError(data.code, data.message, data.uncertain)
        }
        throw new ComfyRelayError(
            'COMFY_RESPONSE_INVALID',
            'Core returned an invalid Comfy response envelope',
            submitCouldHaveCommitted,
        )
    }
}

export function createComfySandboxApi(options: { transport?: ComfyTransport } = {}) {
    const client = new ComfyOrchestratorClient(options)

    const call = async <T extends object>(
        op: string,
        input: Record<string, unknown>,
        submitTransport = false,
    ): Promise<ComfySandboxResult<T>> => {
        try {
            return await client.send(op, input, submitTransport) as ComfySandboxResult<T>
        } catch (error) {
            return relayFailure(error, submitTransport)
        }
    }

    return {
        submit: (input: ComfySubmitInput) => call<{ jobId: string }>('submit', input as unknown as Record<string, unknown>, true),
        poll: (input: { jobId: string }) => call<{ job: ComfyJobSnapshot }>('poll', input),
        findByOperationKey: (input: { operationKey: string }) => (
            call<{ job: ComfyJobSnapshot | null }>('findByOperationKey', input)
        ),
        cancel: (input: { jobId: string }) => call<{ job: ComfyJobSnapshot }>('cancel', input),
        listTemplates: () => call<{ templates: any[] }>('listTemplates', {}),
        getConfig: () => call<{ config: ComfyConfig }>('getConfig', {}),
        updateEndpoint: (input: { url: string }) => call<{ config: ComfyConfig }>('updateEndpoint', input),
        getHealth: () => call<{ health: ComfyHealth }>('getHealth', {}),
    }
}

export function createDefaultComfySandboxApi() {
    return createComfySandboxApi()
}
