import { describe, expect, test, vi } from 'vitest'
import {
    buildComfyWorkflowGraph,
    buildNaiCompatibleBody,
    buildWebuiTxt2ImgBody,
    dispatchComfyuiFlat,
    dispatchWebuiFlat,
    webuiTxt2ImgUrl,
    type TransportFetch,
    type TransportFetchResult,
    type WebuiDispatchParams,
} from '../transportDispatch'
import type { IllustrationPromptTargetV2 } from '../promptContextV2'

vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => ({}) }))

const WEBUI_PARAMS: WebuiDispatchParams = {
    width: 832,
    height: 1216,
    steps: 28,
    cfgScale: 5,
    samplerName: 'Euler a',
    enableHr: false,
    denoisingStrength: 0.7,
    hrScale: 2,
    hrUpscaler: 'Latent',
}

// Astral scalar to prove code-unit exactness end to end.
const ASTRAL_POSITIVE = 'masterpiece, 😀 1girl, 𐐷'
const NEGATIVE = 'lowres, (bad hands:1.2)'

function webuiTarget(): IllustrationPromptTargetV2 {
    return { transportId: 'webui-flat' } as IllustrationPromptTargetV2
}
function comfyTarget(): IllustrationPromptTargetV2 {
    return { transportId: 'comfyui-flat' } as IllustrationPromptTargetV2
}

describe('webui-flat request building (request §7.3 / §10-3)', () => {
    test('places positive/negative text verbatim, code-unit exact, with no mangling', () => {
        const body = buildWebuiTxt2ImgBody(ASTRAL_POSITIVE, NEGATIVE, WEBUI_PARAMS, null)
        // Verbatim: the parens are NOT escaped to braces (contrast NovelAI), astral
        // scalars intact, nothing trimmed.
        expect(body.prompt).toBe(ASTRAL_POSITIVE)
        expect(body.negative_prompt).toBe(NEGATIVE)
        // Round-trips through JSON with no code-unit loss.
        expect(JSON.parse(JSON.stringify(body)).prompt).toBe(ASTRAL_POSITIVE)
        expect(body.override_settings).toBeUndefined()
    })

    test('request-pinned checkpoint is pinned via override_settings', () => {
        const body = buildWebuiTxt2ImgBody('a', 'b', WEBUI_PARAMS, 'sdxl_illustrious.safetensors')
        expect(body.override_settings).toEqual({ sd_model_checkpoint: 'sdxl_illustrious.safetensors' })
        expect(body.override_settings_restore_afterwards).toBe(true)
    })

    test('the txt2img URL forces the /sdapi/v1/txt2img path', () => {
        expect(webuiTxt2ImgUrl('http://127.0.0.1:7860/')).toBe('http://127.0.0.1:7860/sdapi/v1/txt2img')
    })
})

describe('webui-flat dispatch certainty (request §8)', () => {
    const okResult: TransportFetchResult = { ok: true, status: 200, data: { images: ['AAAA'] }, headers: {} }

    test('a socket-level throw stays uncertain and never auto-duplicates', async () => {
        const fetchImpl: TransportFetch = async () => { throw new Error('ECONNRESET') }
        const result = await dispatchWebuiFlat({
            target: webuiTarget(), endpoint: 'http://127.0.0.1:7860/',
            positive: 'p', negative: 'n', params: WEBUI_PARAMS, pinnedCheckpoint: null,
            fetchImpl, priorityClass: 'background',
        })
        expect(result).toMatchObject({ ok: false, certainty: 'uncertain' })
    })

    test('a received HTTP error on a local backend is a DEFINITE no-image outcome', async () => {
        const fetchImpl: TransportFetch = async () => ({ ok: false, status: 500, data: {}, headers: {} })
        const result = await dispatchWebuiFlat({
            target: webuiTarget(), endpoint: 'http://127.0.0.1:7860/',
            positive: 'p', negative: 'n', params: WEBUI_PARAMS, pinnedCheckpoint: null,
            fetchImpl, priorityClass: 'background',
        })
        expect(result).toMatchObject({ ok: false, certainty: 'definite', providerStatus: 500 })
    })

    test('a success returns the decoded image data URL', async () => {
        const fetchImpl: TransportFetch = async () => okResult
        const result = await dispatchWebuiFlat({
            target: webuiTarget(), endpoint: 'http://127.0.0.1:7860/',
            positive: 'p', negative: 'n', params: WEBUI_PARAMS, pinnedCheckpoint: null,
            fetchImpl, priorityClass: 'background',
        })
        expect(result).toEqual({ ok: true, bytesOrDataUrl: 'data:image/png;base64,AAAA', providerStatus: 200 })
    })
})

describe('comfyui-flat node injection (request §7.4 / §10-4)', () => {
    const workflow = JSON.stringify({
        '6': { class_type: 'CLIPTextEncode', inputs: { text: 'OLD_POS', clip: ['4', 1] } },
        '7': { class_type: 'CLIPTextEncode', inputs: { text: 'OLD_NEG', clip: ['4', 1] } },
    })

    test('injects exact text into the pinned nodes without mutating the source string', () => {
        const graph = buildComfyWorkflowGraph(
            workflow,
            { nodeId: '6', inputName: 'text' },
            { nodeId: '7', inputName: 'text' },
            ASTRAL_POSITIVE,
            NEGATIVE,
        )
        expect((graph['6'] as any).inputs.text).toBe(ASTRAL_POSITIVE)
        expect((graph['7'] as any).inputs.text).toBe(NEGATIVE)
        // Source JSON string is untouched.
        expect(workflow).toContain('OLD_POS')
    })

    test('a missing binding node is a provider-call-0 failure BEFORE any fetch', async () => {
        const fetchImpl = vi.fn<TransportFetch>()
        const result = await dispatchComfyuiFlat({
            target: comfyTarget(), endpoint: 'http://localhost:8188',
            positive: 'p', negative: 'n',
            workflowJson: workflow,
            positiveNode: { nodeId: '999', inputName: 'text' },
            negativeNode: { nodeId: '7', inputName: 'text' },
            fetchImpl,
            nativeFetchImpl: (async () => { throw new Error('should not run') }) as never,
            timeoutMs: 30000, now: () => 0, sleep: async () => {},
        })
        expect(result).toMatchObject({ ok: false, certainty: 'definite' })
        expect(fetchImpl).not.toHaveBeenCalled()
    })

    test('a non-ok /view is a DEFINITE failure, never an error body wrapped as a PNG', async () => {
        // The generation completed and /history lists an output image, but by the
        // time we GET /view the file was pruned/renamed → /view returns 404 with an
        // error body. That body must NOT be base64-wrapped and reported ok:true.
        const fetchImpl: TransportFetch = async () => ({ ok: true, status: 200, data: { prompt_id: 'abc' }, headers: {} })
        const errorBody = new TextEncoder().encode('{"error":"not found"}').buffer
        let call = 0
        const nativeFetchImpl = (async () => {
            call += 1
            if (call === 1) {
                // /history: our prompt_id is present with an image descriptor.
                return {
                    ok: true, status: 200,
                    json: async () => ({ abc: { outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } } }),
                    arrayBuffer: async () => new ArrayBuffer(0),
                }
            }
            // /view: the file is gone → HTTP 404 with a non-image error body.
            return {
                ok: false, status: 404,
                json: async () => ({ error: 'not found' }),
                arrayBuffer: async () => errorBody,
            }
        }) as never
        const result = await dispatchComfyuiFlat({
            target: comfyTarget(), endpoint: 'http://localhost:8188',
            positive: 'p', negative: 'n',
            workflowJson: workflow,
            positiveNode: { nodeId: '6', inputName: 'text' },
            negativeNode: { nodeId: '7', inputName: 'text' },
            fetchImpl,
            nativeFetchImpl,
            timeoutMs: 30000, now: () => 0, sleep: async () => {},
        })
        // comfyui-flat is a local, non-charging backend → a received error is definite.
        expect(result).toMatchObject({ ok: false, certainty: 'definite', providerStatus: 404 })
    })

    test('a non-ok /history is classified via the certainty policy, not consumed as an empty history', async () => {
        const fetchImpl: TransportFetch = async () => ({ ok: true, status: 200, data: { prompt_id: 'abc' }, headers: {} })
        const nativeFetchImpl = (async () => ({
            ok: false, status: 500,
            json: async () => { throw new Error('json() must not be called on a non-ok /history') },
            arrayBuffer: async () => new ArrayBuffer(0),
        })) as never
        const result = await dispatchComfyuiFlat({
            target: comfyTarget(), endpoint: 'http://localhost:8188',
            positive: 'p', negative: 'n',
            workflowJson: workflow,
            positiveNode: { nodeId: '6', inputName: 'text' },
            negativeNode: { nodeId: '7', inputName: 'text' },
            fetchImpl,
            nativeFetchImpl,
            timeoutMs: 30000, now: () => 0, sleep: async () => {},
        })
        expect(result).toMatchObject({ ok: false, certainty: 'definite', providerStatus: 500 })
    })

    test('a successful /view reports the real provider status, not a hardcoded 200', async () => {
        const fetchImpl: TransportFetch = async () => ({ ok: true, status: 200, data: { prompt_id: 'abc' }, headers: {} })
        const pngBytes = new Uint8Array([1, 2, 3, 4]).buffer
        let call = 0
        const nativeFetchImpl = (async () => {
            call += 1
            if (call === 1) {
                return {
                    ok: true, status: 200,
                    json: async () => ({ abc: { outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } } }),
                    arrayBuffer: async () => new ArrayBuffer(0),
                }
            }
            // /view succeeds but with a 206 to prove the status is not hardcoded.
            return { ok: true, status: 206, json: async () => ({}), arrayBuffer: async () => pngBytes }
        }) as never
        const result = await dispatchComfyuiFlat({
            target: comfyTarget(), endpoint: 'http://localhost:8188',
            positive: 'p', negative: 'n',
            workflowJson: workflow,
            positiveNode: { nodeId: '6', inputName: 'text' },
            negativeNode: { nodeId: '7', inputName: 'text' },
            fetchImpl,
            nativeFetchImpl,
            timeoutMs: 30000, now: () => 0, sleep: async () => {},
        })
        expect(result).toMatchObject({ ok: true, providerStatus: 206 })
    })

    test('a poll timeout stays uncertain (never auto-regenerated)', async () => {
        let clock = 0
        const fetchImpl: TransportFetch = async () => ({ ok: true, status: 200, data: { prompt_id: 'abc' }, headers: {} })
        const nativeFetchImpl = (async () => ({
            ok: true, status: 200,
            json: async () => ({}), // history never contains our prompt_id
            arrayBuffer: async () => new ArrayBuffer(0),
        })) as never
        const result = await dispatchComfyuiFlat({
            target: comfyTarget(), endpoint: 'http://localhost:8188',
            positive: 'p', negative: 'n',
            workflowJson: workflow,
            positiveNode: { nodeId: '6', inputName: 'text' },
            negativeNode: { nodeId: '7', inputName: 'text' },
            fetchImpl,
            nativeFetchImpl,
            timeoutMs: 1000,
            now: () => { const t = clock; clock += 600; return t },
            sleep: async () => {},
        })
        expect(result).toMatchObject({ ok: false, certainty: 'uncertain' })
    })
})

describe('nai-compatible-flat body building (request §7.2)', () => {
    test('places flat/pipe text verbatim with no NAI T5 or bracket escaping', () => {
        const body = buildNaiCompatibleBody(ASTRAL_POSITIVE, NEGATIVE, 'custom-model')
        expect(body.input).toBe(ASTRAL_POSITIVE)
        expect((body.parameters as any).negative_prompt).toBe(NEGATIVE)
        expect(body.model).toBe('custom-model')
    })
})
