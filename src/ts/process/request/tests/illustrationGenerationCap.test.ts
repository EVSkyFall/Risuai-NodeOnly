import { beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
    db: {
        enabledModules: [],
        modules: [],
        characters: [],
    } as any,
    models: new Map<string, any>(),
    providers: new Map<string, (...args: any[]) => Promise<any>>(),
    provider: vi.fn(),
    legacyProvider: vi.fn(),
    globalFetch: vi.fn(),
    formats: {
        OpenAICompatible: 0,
        OpenAILegacyInstruct: 1,
        Anthropic: 2,
        AnthropicLegacy: 3,
        Mistral: 4,
        GoogleCloud: 5,
        VertexAIGemini: 6,
        NovelList: 7,
        Cohere: 8,
        NovelAI: 9,
        WebLLM: 10,
        OobaLegacy: 11,
        Plugin: 12,
        Ooba: 13,
        Kobold: 14,
        Ollama: 15,
        Horde: 16,
        AWSBedrockClaude: 17,
        OpenAIResponseAPI: 18,
        Echo: 19,
        NanoGPT: 20,
        NanoGPTResponses: 21,
        NanoGPTMessages: 22,
        NanoGPTLegacy: 23,
    },
    flags: {
        hasImageInput: 0,
        hasImageOutput: 1,
        hasAudioInput: 2,
        hasAudioOutput: 3,
        hasPrefill: 4,
        hasCache: 5,
        hasFullSystemPrompt: 6,
        hasFirstSystemPrompt: 7,
        hasStreaming: 8,
        requiresAlternateRole: 9,
        mustStartWithUserInput: 10,
        poolSupported: 11,
        hasVideoInput: 12,
        OAICompletionTokens: 13,
        DeveloperRole: 14,
        geminiThinking: 15,
        geminiBlockOff: 16,
        deepSeekPrefix: 17,
        deepSeekThinkingInput: 18,
        deepSeekThinkingOutput: 19,
        noCivilIntegrity: 20,
        claudeThinking: 21,
        claudeAdaptiveThinking: 22,
        claudeAdaptiveThinkingOnly: 23,
    },
    providersEnum: {
        OpenAI: 0,
        Anthropic: 1,
        GoogleCloud: 2,
        VertexAI: 3,
        AsIs: 4,
        Mistral: 5,
    },
}))

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => harness.db,
    getCurrentCharacter: () => undefined,
    getCurrentChat: () => undefined,
}))

vi.mock('src/ts/model/modellist', () => ({
    LLMFlags: harness.flags,
    LLMFormat: harness.formats,
    LLMProvider: harness.providersEnum,
    getModelInfo: (id: string) => structuredClone(harness.models.get(id)),
    isClaudeAdaptiveThinkingOnlyModel: () => false,
}))

vi.mock('src/ts/plugins/plugins.svelte', () => ({
    pluginV2: {
        providers: harness.providers,
        providerOptions: new Map(),
        replacerbeforeRequest: new Set(),
        replacerafterRequest: new Set(),
    },
    pluginProcess: harness.legacyProvider,
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    globalFetch: harness.globalFetch,
    fetchNative: vi.fn(),
    textifyReadableStream: vi.fn(),
}))

vi.mock('src/ts/tokenizer', () => ({
    tokenizeNum: vi.fn(async () => []),
    encodeWithTokenizer: vi.fn(async () => []),
    strongBan: vi.fn(async (_text: string, bias: Record<string, number>) => bias),
}))

vi.mock('src/ts/process/templates/chatTemplate', () => ({
    applyChatTemplate: () => 'captured prompt',
}))

import { requestChatDataMain } from '../request'
import { resolvePresetMaxOutputTokens } from '../modelPresetBinding'

function model(
    id: string,
    format: number,
    options: { flags?: number[]; provider?: number; parameters?: string[] } = {},
) {
    return {
        id,
        name: id,
        internalID: `${id}-wire`,
        provider: options.provider ?? harness.providersEnum.AsIs,
        flags: options.flags ?? [],
        format,
        parameters: options.parameters ?? [],
        tokenizer: 0,
    }
}

function requestArgument(staticModel: string, extras: Record<string, unknown> = {}) {
    return {
        formated: [
            { role: 'system', content: 'system instruction' },
            { role: 'user', content: 'hello' },
        ],
        bias: {},
        staticModel,
        useStreaming: false,
        ...extras,
    } as any
}

async function previewBody(
    staticModel: string,
    extras: Record<string, unknown> = {},
): Promise<Record<string, any>> {
    const response = await requestChatDataMain(requestArgument(staticModel, {
        previewBody: true,
        hostOmitCallerGenerationCap: true,
        ...extras,
    }), 'model')
    expect(response.type).toBe('success')
    if (response.type !== 'success') throw new Error('Expected a preview success response')
    return JSON.parse(response.result).body
}

// A raw JSON-Schema string, mirroring how the protected Illustration plugin ships
// its Planner/Tagger schema (convertInterfaceToSchema JSON.parses non-`interface`
// strings verbatim).
const SAMPLE_SCHEMA = JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    properties: { foo: { type: 'string' } },
    required: ['foo'],
})

beforeEach(() => {
    harness.db = {
        nodeOnlyModelModeLock: 'none',
        aiModel: 'pluginmodel:::illustration-provider',
        subModel: 'pluginmodel:::illustration-provider',
        seperateModelsForAxModels: false,
        seperateModels: {},
        seperateParametersEnabled: false,
        seperateParametersByModel: false,
        seperateParameters: {},
        maxResponse: 64_000,
        subMaxResponse: 32_000,
        subMaxContext: 0,
        maxContext: 8_192,
        temperature: 70,
        PresensePenalty: 0,
        frequencyPenalty: 0,
        repetition_penalty: 1,
        min_p: 0,
        top_a: 0,
        top_k: 40,
        top_p: 0.9,
        useStreaming: false,
        genTime: 1,
        extractJson: '',
        customModels: [],
        additionalParams: [],
        generationSeed: 0,
        jsonSchemaEnabled: false,
        simplifiedToolUse: false,
        modelTools: false,
        gptVisionQuality: 'low',
        systemContentReplacement: '',
        systemRoleReplacement: '',
        openAIRequestModel: 'gpt-test',
        openAIKey: 'openai-key',
        proxyRequestModel: 'proxy-model',
        customProxyRequestModel: 'custom-proxy-model',
        proxyKey: 'proxy-key',
        localNetworkMode: false,
        localNetworkTimeoutSec: 600,
        openrouterFallback: false,
        openrouterMiddleOut: false,
        openrouterProvider: '',
        OAIPrediction: '',
        openAIBatch: false,
        openAIFlex: false,
        reverseProxyOobaArgs: {},
        reverseProxyOobaMode: false,
        textgenWebUIStreamURL: 'http://127.0.0.1:5000/api/v1/stream',
        textgenWebUIBlockingURL: 'http://127.0.0.1:5000/api/v1/generate',
        localStopStrings: [],
        ooba: {
            do_sample: true,
            top_p: 0.9,
            typical_p: 1,
            repetition_penalty: 1,
            encoder_repetition_penalty: 1,
            top_k: 40,
            min_length: 0,
            no_repeat_ngram_size: 0,
            num_beams: 1,
            penalty_alpha: 0,
            length_penalty: 1,
            ban_eos_token: false,
            add_bos_token: true,
            formating: {
                header: '',
                systemPrefix: 'System:',
                userPrefix: 'User:',
                assistantPrefix: 'Assistant:',
                seperator: '\n',
                useName: false,
            },
        },
        username: 'User',
        hordeConfig: { apiKey: '' },
        google: { accessToken: 'google-key', projectId: 'project' },
        googleFlex: false,
        googleRequestModel: '',
        vertexRegion: 'us-central1',
        vertexAccessToken: '',
        vertexAccessTokenExpires: 0,
        vertexClientEmail: '',
        vertexPrivateKey: '',
        geminiThinkingLevel: 'low',
        streamGeminiThoughts: false,
        saveSignatures: false,
        claudeAPIKey: 'claude-key',
        claude1HourCaching: false,
        claudeRetrivalCaching: false,
        claudeBatching: false,
        adaptiveThinkingEffort: 'high',
        thinkingType: 'off',
        usePlainFetch: false,
        jsonSchema: '',
        requestRetrys: 0,
        antiServerOverloads: false,
    }
    harness.models.clear()
    harness.models.set('pluginmodel:::illustration-provider', model(
        'pluginmodel:::illustration-provider',
        harness.formats.Plugin,
    ))
    harness.models.set('openai-test', model('openai-test', harness.formats.OpenAICompatible))
    harness.models.set('gpt-illustration-test', model('gpt-illustration-test', harness.formats.OpenAICompatible))
    harness.models.set('openai-completion-test', model(
        'openai-completion-test',
        harness.formats.OpenAICompatible,
        { flags: [harness.flags.OAICompletionTokens] },
    ))
    harness.models.set('mistral-test', model(
        'mistral-test',
        harness.formats.Mistral,
        { provider: harness.providersEnum.Mistral },
    ))
    harness.models.set('responses-test', model('responses-test', harness.formats.OpenAIResponseAPI))
    harness.models.set('gemini-test', model('gemini-test', harness.formats.GoogleCloud))
    harness.models.set('anthropic-test', model('anthropic-test', harness.formats.Anthropic))
    harness.models.set('ooba-legacy-test', model('ooba-legacy-test', harness.formats.OobaLegacy))
    harness.models.set('ooba-test', model('ooba-test', harness.formats.Ooba))
    harness.models.set('horde:::auto', model('horde:::auto', harness.formats.Horde))
    harness.providers.clear()
    harness.provider.mockReset()
    harness.legacyProvider.mockReset()
    harness.globalFetch.mockReset()
    harness.providers.set('illustration-provider', harness.provider)
    harness.provider.mockResolvedValue({ success: true, content: 'provider result' })
    harness.legacyProvider.mockResolvedValue({ success: true, content: 'legacy result' })
})

describe('authorized illustration caller generation-cap omission', () => {
    test('plugin provider payload has no own max_tokens while generic inheritance stays byte-identical', async () => {
        let authorizedPayload: Record<string, unknown> | undefined
        harness.provider.mockImplementationOnce(async (payload) => {
            authorizedPayload = payload
            return { success: true, content: 'authorized result' }
        })
        await expect(requestChatDataMain(requestArgument(
            'pluginmodel:::illustration-provider',
            { hostOmitCallerGenerationCap: true },
        ), 'model')).resolves.toMatchObject({ type: 'success', result: 'authorized result' })
        expect(Object.hasOwn(authorizedPayload!, 'max_tokens')).toBe(false)

        let genericPayload: Record<string, unknown> | undefined
        harness.provider.mockImplementationOnce(async (payload) => {
            genericPayload = payload
            return { success: true, content: 'generic result' }
        })
        await expect(requestChatDataMain(requestArgument(
            'pluginmodel:::illustration-provider',
        ), 'model')).resolves.toMatchObject({ type: 'success', result: 'generic result' })
        expect(Object.hasOwn(genericPayload!, 'max_tokens')).toBe(true)
        expect(genericPayload!.max_tokens).toBe(64_000)
        expect(Object.keys(genericPayload!).slice(0, 4)).toEqual([
            'prompt_chat',
            'mode',
            'bias',
            'max_tokens',
        ])
    })

    test.each([
        ['openai-test', ['max_tokens']],
        ['mistral-test', ['max_tokens']],
        ['responses-test', ['max_output_tokens']],
        ['gemini-test', ['generation_config.maxOutputTokens']],
        ['ooba-legacy-test', ['max_new_tokens', 'truncation_length']],
        ['ooba-test', ['max_tokens']],
    ] as const)('omits optional native output fields for %s', async (modelId, paths) => {
        const body = await previewBody(modelId)
        for (const path of paths) {
            if (path === 'generation_config.maxOutputTokens') {
                expect(Object.hasOwn(body.generation_config, 'maxOutputTokens')).toBe(false)
            } else {
                expect(Object.hasOwn(body, path)).toBe(false)
            }
        }
    })

    test('OAICompletionTokens rename creates neither token-field alias', async () => {
        const body = await previewBody('openai-completion-test')
        expect(Object.hasOwn(body, 'max_tokens')).toBe(false)
        expect(Object.hasOwn(body, 'max_completion_tokens')).toBe(false)
    })

    test('Anthropic keeps its required max_tokens value', async () => {
        const body = await previewBody('anthropic-test')
        expect(body.max_tokens).toBe(64_000)
    })

    test('Horde keeps required params.max_length byte-identical', async () => {
        let capturedBody: Record<string, any> | undefined
        const originalFetch = globalThis.fetch
        globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
            capturedBody = JSON.parse(String(init?.body))
            return {
                status: 400,
                text: async () => 'stop after capture',
            }
        }) as unknown as typeof fetch
        try {
            await requestChatDataMain(requestArgument('horde:::auto', {
                hostOmitCallerGenerationCap: true,
            }), 'model')
            expect(capturedBody?.params.max_length).toBe(64_000)
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    test('ModelPreset explicit output limit remains preset-owned', () => {
        const preset = {
            profileSnapshot: {
                schema: [{
                    key: 'max_tokens',
                    default: 4_096,
                    mapsTo: { target: 'body', path: 'max_tokens' },
                }],
            },
            userValues: { max_tokens: 12_345 },
        } as any
        expect(resolvePresetMaxOutputTokens(preset)).toBe(12_345)
    })
})

describe('authorized illustration structured output and single generation', () => {
    // §5-5: the OpenAI-compatible builder emits an exact json_schema response_format
    // from the passed-through schema string, without relying on the global toggle.
    test('OpenAI-compatible body carries the exact json_schema response_format', async () => {
        const body = await previewBody('openai-test', { schema: SAMPLE_SCHEMA })
        expect(body.response_format.type).toBe('json_schema')
        expect(body.response_format.json_schema.name).toBe('format')
        expect(body.response_format.json_schema.schema).toEqual(JSON.parse(SAMPLE_SCHEMA))
    })

    // §5-6: the Gemini builder emits the JSON mime type and a response schema, with
    // Gemini-incompatible keys ($schema / additionalProperties) stripped.
    test('Gemini body carries JSON mime type and a stripped response schema', async () => {
        const body = await previewBody('gemini-test', { schema: SAMPLE_SCHEMA })
        expect(body.generation_config.response_mime_type).toBe('application/json')
        expect(body.generation_config.response_schema.type).toBe('object')
        expect(body.generation_config.response_schema.properties.foo).toEqual({ type: 'string' })
        expect(Object.hasOwn(body.generation_config.response_schema, '$schema')).toBe(false)
        expect(Object.hasOwn(body.generation_config.response_schema, 'additionalProperties')).toBe(false)
    })

    // §5-7: providers without native structured-output support get no bogus schema
    // wire field and keep their normal prompt, so the plugin's strict prompt-only
    // fallback path is intact.
    test.each([
        ['anthropic-test', 'messages'],
        ['ooba-test', 'prompt'],
    ] as const)('unsupported provider %s gets no schema wire field and keeps its prompt', async (modelId, promptField) => {
        const body = await previewBody(modelId, { schema: SAMPLE_SCHEMA })
        const serialized = JSON.stringify(body)
        expect(serialized).not.toContain('response_format')
        expect(serialized).not.toContain('response_schema')
        expect(serialized).not.toContain('response_mime_type')
        expect(Object.hasOwn(body, promptField)).toBe(true)
    })

    // §5-2: with the user's multi-generation setting on, forcing noMultiGen (as the
    // Illustration host does) suppresses the OpenAI `n` fan-out — one dispatch, one
    // result — even for a gpt-prefixed model that would otherwise multi-generate.
    test('noMultiGen suppresses the OpenAI n fan-out while generic calls still fan out', async () => {
        harness.db.genTime = 2
        const forced = await previewBody('gpt-illustration-test', { noMultiGen: true })
        expect(Object.hasOwn(forced, 'n')).toBe(false)

        // §5-10: a generic (non-Illustration) call with the same multi-gen setting is
        // unchanged — it still requests the fan-out.
        const generic = await previewBody('gpt-illustration-test')
        expect(generic.n).toBe(2)
    })

    // §5-10: generic calls that pass no schema get no structured-output wire field,
    // proving the schema behavior is opt-in per call and does not leak globally.
    test('generic OpenAI-compatible call without a schema gets no response_format', async () => {
        const body = await previewBody('openai-test')
        expect(Object.hasOwn(body, 'response_format')).toBe(false)
    })
})
