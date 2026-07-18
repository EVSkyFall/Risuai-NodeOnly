import { beforeEach, describe, expect, test, vi } from 'vitest'

// Harness pattern copied from illustrationGenerationCap.test.ts (that file is left untouched).
// It hand-mirrors the real LLMFlags/LLMFormat/LLMProvider enums so the mocked modellist can
// hand out minimal LLMModel-shaped objects, and drives the REAL requestChatDataMain ->
// requestOpenAI transform through the previewBody envelope so we observe the actual wire roles.
const harness = vi.hoisted(() => ({
    db: {} as any,
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
    addFetchLog: vi.fn(),
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
import { normalizeDeveloperRole, resolveOpenAIRequestUrl, isOfficialOpenAIEndpoint } from '../openAI/requests'

const DEV = harness.flags.DeveloperRole
const FULL = harness.flags.hasFullSystemPrompt
const OFFICIAL_OPENAI = 'https://api.openai.com/v1/chat/completions'
const DEEPSEEK = 'https://api.deepseek.com/v1/chat/completions'

function model(
    id: string,
    format: number,
    options: { flags?: number[]; provider?: number; endpoint?: string } = {},
) {
    return {
        id,
        name: id,
        internalID: `${id}-wire`,
        provider: options.provider ?? harness.providersEnum.AsIs,
        flags: options.flags ?? [],
        format,
        parameters: [],
        tokenizer: 0,
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    }
}

const DEFAULT_MESSAGES = () => [
    { role: 'system', content: 'system instruction' },
    { role: 'user', content: 'hello' },
]

function requestArgument(staticModel: string, extras: Record<string, unknown> = {}) {
    return {
        formated: (extras.formated as any) ?? DEFAULT_MESSAGES(),
        bias: {},
        staticModel,
        useStreaming: false,
        ...extras,
    } as any
}

async function previewRoles(staticModel: string, extras: Record<string, unknown> = {}): Promise<string[]> {
    const response = await requestChatDataMain(requestArgument(staticModel, {
        previewBody: true,
        hostOmitCallerGenerationCap: true,
        ...extras,
    }), 'model')
    expect(response.type).toBe('success')
    if (response.type !== 'success') throw new Error('Expected a preview success response')
    const body = JSON.parse(response.result).body
    return (body.messages as Array<{ role: string }>).map((m) => m.role)
}

async function previewBody(staticModel: string, extras: Record<string, unknown> = {}): Promise<Record<string, any>> {
    const response = await requestChatDataMain(requestArgument(staticModel, {
        previewBody: true,
        hostOmitCallerGenerationCap: true,
        ...extras,
    }), 'model')
    expect(response.type).toBe('success')
    if (response.type !== 'success') throw new Error('Expected a preview success response')
    return JSON.parse(response.result).body
}

beforeEach(() => {
    harness.db = {
        aiModel: 'official-dev',
        subModel: 'official-dev',
        seperateModelsForAxModels: false,
        seperateModels: {},
        maxResponse: 64_000,
        subMaxResponse: 0,
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
        customAPIFormat: harness.formats.OpenAICompatible,
        forceReplaceUrl: DEEPSEEK,
        proxyKey: 'proxy-key',
        autofillRequestUrl: false,
        nanogptUseSubscriptionEndpoint: false,
        nanogptRequestModel: 'nano-model',
        nanogptKey: 'nano-key',
        localNetworkMode: false,
        localNetworkTimeoutSec: 600,
        openrouterFallback: false,
        openrouterMiddleOut: false,
        openrouterProvider: '',
        openrouterRequestModel: 'openrouter-model',
        openrouterKey: 'openrouter-key',
        vercelRequestModel: 'vercel-model',
        vercelKey: 'vercel-key',
        OAIPrediction: '',
        openAIBatch: false,
        openAIFlex: false,
        reverseProxyOobaArgs: {},
        reverseProxyOobaMode: false,
        newOAIHandle: true,
        localStopStrings: [],
        username: 'User',
        requestRetrys: 0,
        antiServerOverloads: false,
    }
    harness.models.clear()
    // (a) official OpenAI endpoint + DeveloperRole -> convert
    harness.models.set('official-dev', model('official-dev', harness.formats.OpenAICompatible, { flags: [FULL, DEV], provider: harness.providersEnum.OpenAI }))
    // (b) custom endpoint override (DeepSeek-style) + DeveloperRole -> preserve system
    harness.models.set('deepseek-dev', model('deepseek-dev', harness.formats.OpenAICompatible, { flags: [FULL, DEV], endpoint: DEEPSEEK }))
    // developer-unsupported provider (openrouter literal host) + DeveloperRole -> preserve
    harness.models.set('openrouter', model('openrouter', harness.formats.OpenAICompatible, { flags: [FULL, DEV] }))
    // reverse_proxy routed to a non-official host via customURL + DeveloperRole -> preserve
    harness.models.set('reverse_proxy', model('reverse_proxy', harness.formats.OpenAICompatible, { flags: [FULL, DEV] }))
    // Mistral format carrying DeveloperRole (only reachable via blanket) -> preserve (separate destination)
    harness.models.set('mistral-dev', model('mistral-dev', harness.formats.Mistral, { flags: [FULL, DEV], provider: harness.providersEnum.Mistral }))
    // OpenAICompatible official-shaped model WITHOUT the flag -> never converts
    harness.models.set('no-dev', model('no-dev', harness.formats.OpenAICompatible, { flags: [FULL], provider: harness.providersEnum.OpenAI }))
    // xcustom::: with the flag EXPLICITLY declared on the model itself -> convert (per-endpoint declaration)
    harness.models.set('xcustom:::explicit', model('xcustom:::explicit', harness.formats.OpenAICompatible, { flags: [FULL, DEV] }))
    // xcustom::: where modelInfo carries the flag (as if a blanket applied) but the model's OWN flags do NOT -> preserve
    harness.models.set('xcustom:::blanket', model('xcustom:::blanket', harness.formats.OpenAICompatible, { flags: [FULL, DEV] }))

    harness.providers.clear()
    harness.provider.mockReset()
    harness.legacyProvider.mockReset()
    harness.globalFetch.mockReset()
})

describe('provider-aware system->developer role normalization', () => {
    test('official OpenAI endpoint + DeveloperRole flag emits wire developer,user (contract 4.1)', async () => {
        expect(await previewRoles('official-dev')).toEqual(['developer', 'user'])
    })

    test('DeepSeek-style custom endpoint + DeveloperRole flag preserves system,user (contract 4.2 / 4.9)', async () => {
        // RED-FIRST regression: under the flag-only code this emits developer and the endpoint
        // rejects it with "unknown variant `developer`".
        expect(await previewRoles('deepseek-dev')).toEqual(['system', 'user'])
    })

    test('developer-unsupported provider (openrouter) preserves system,user (contract 4.3)', async () => {
        expect(await previewRoles('openrouter')).toEqual(['system', 'user'])
    })

    test('reverse_proxy routed to a non-official host preserves system,user', async () => {
        expect(await previewRoles('reverse_proxy')).toEqual(['system', 'user'])
    })

    test('Mistral format carrying DeveloperRole preserves system and does not developer-prefix content', async () => {
        const body = await previewBody('mistral-dev')
        expect(body.messages[0].role).toBe('system')
        expect(body.messages[0].content).toBe('system instruction')
    })

    test('model without DeveloperRole flag never converts (contract 4.8)', async () => {
        expect(await previewRoles('no-dev')).toEqual(['system', 'user'])
    })

    test('xcustom::: with own DeveloperRole flag converts (explicit per-endpoint declaration)', async () => {
        harness.db.customModels = [
            { id: 'xcustom:::explicit', name: 'x', internalId: 'x-wire', url: DEEPSEEK, key: 'k', format: harness.formats.OpenAICompatible, flags: [FULL, DEV], tokenizer: 0 },
        ]
        expect(await previewRoles('xcustom:::explicit')).toEqual(['developer', 'user'])
    })

    test('xcustom::: with the flag only on modelInfo but not the model own flags preserves system (blanket guard)', async () => {
        harness.db.customModels = [
            { id: 'xcustom:::blanket', name: 'x', internalId: 'x-wire', url: DEEPSEEK, key: 'k', format: harness.formats.OpenAICompatible, flags: [FULL], tokenizer: 0 },
        ]
        expect(await previewRoles('xcustom:::blanket')).toEqual(['system', 'user'])
    })

    test('same family flag but different endpoint branches per-destination (contract 4.6)', async () => {
        expect(await previewRoles('official-dev')).toEqual(['developer', 'user'])
        expect(await previewRoles('deepseek-dev')).toEqual(['system', 'user'])
    })

    test('non-system roles keep order and content untouched (contract 4.4)', async () => {
        const formated = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'u1' },
            { role: 'assistant', content: 'a1' },
            { role: 'tool', content: 't1', tool_call_id: 'call-1' },
            { role: 'latest_reminder', content: 'r1' },
            { role: 'user', content: 'u2' },
        ]
        const body = await previewBody('official-dev', { formated })
        expect(body.messages.map((m: any) => m.role)).toEqual(['developer', 'user', 'assistant', 'tool', 'latest_reminder', 'user'])
        expect(body.messages[1].content).toBe('u1')
        expect(body.messages[2].content).toBe('a1')
        expect(body.messages[3].content).toBe('t1')
        expect(body.messages[3].tool_call_id).toBe('call-1')
        expect(body.messages[4].content).toBe('r1')
        expect(body.messages[5].content).toBe('u2')
    })

    test('generic runLLMModel path and illustration-shaped call produce identical wire roles (contract 4.7)', async () => {
        const generic = await previewRoles('official-dev')
        const illustrationShaped = await previewRoles('official-dev', { blockPlugins: true, useStreaming: false })
        expect(generic).toEqual(illustrationShaped)
        expect(generic).toEqual(['developer', 'user'])
    })

    test('normalizer leaves the input array and objects deep-equal, returning new objects (contract 4.5)', () => {
        const input = [
            { role: 'system', content: 'sys', memo: 'keep' },
            { role: 'user', content: 'u1' },
            { role: 'assistant', content: 'a1' },
            { role: 'tool', content: 't1', tool_call_id: 'call-1' },
        ] as any
        const snapshot = structuredClone(input)
        const out = normalizeDeveloperRole(input, true)
        // input untouched (deep-equality)
        expect(input).toEqual(snapshot)
        expect(input[0].role).toBe('system')
        // converted entry is a NEW object with the developer role, content/metadata preserved
        expect(out[0]).not.toBe(input[0])
        expect(out[0].role).toBe('developer')
        expect(out[0].content).toBe('sys')
        expect(out[0].memo).toBe('keep')
        // non-system entries kept by reference, order preserved
        expect(out[1]).toBe(input[1])
        expect(out[2]).toBe(input[2])
        expect(out[3]).toBe(input[3])
        expect(out.map((m: any) => m.role)).toEqual(['developer', 'user', 'assistant', 'tool'])
    })

    test('normalizer with useDeveloperRole=false is a no-op passthrough', () => {
        const input = [{ role: 'system', content: 'x' }] as any
        const out = normalizeDeveloperRole(input, false)
        expect(out).toBe(input)
        expect(out[0].role).toBe('system')
    })

    test('destination helper is byte-identical to the send-site literals and fails official-check safely', () => {
        // official fallback (no special keyword, no customURL/endpoint)
        expect(resolveOpenAIRequestUrl({ aiModel: 'gpt-5' }).url).toBe(OFFICIAL_OPENAI)
        expect(isOfficialOpenAIEndpoint(resolveOpenAIRequestUrl({ aiModel: 'gpt-5' }).url)).toBe(true)
        // literal-host providers are never official
        expect(resolveOpenAIRequestUrl({ aiModel: 'openrouter' }).url).toBe('https://openrouter.ai/api/v1/chat/completions')
        expect(resolveOpenAIRequestUrl({ aiModel: 'vercel' }).url).toBe('https://ai-gateway.vercel.sh/v1/chat/completions')
        expect(resolveOpenAIRequestUrl({ aiModel: 'nanogpt' }).url).toBe('https://nano-gpt.com/api/v1/chat/completions')
        // endpoint override wins over the customURL/official fallback
        expect(resolveOpenAIRequestUrl({ aiModel: 'deepseek', customURL: 'https://x', endpoint: DEEPSEEK }).url).toBe(DEEPSEEK)
        expect(isOfficialOpenAIEndpoint(DEEPSEEK)).toBe(false)
        // look-alike host and plain http are not official
        expect(isOfficialOpenAIEndpoint('https://api.openai.com.evil.tld/v1/chat/completions')).toBe(false)
        expect(isOfficialOpenAIEndpoint('http://api.openai.com/v1/chat/completions')).toBe(false)
        expect(isOfficialOpenAIEndpoint('not a url')).toBe(false)
        // risu:: identify prefix is stripped, revealing the true (official) destination
        expect(resolveOpenAIRequestUrl({ aiModel: 'reverse_proxy', customURL: 'risu::https://api.openai.com/v1/chat/completions' }).url).toBe(OFFICIAL_OPENAI)
    })

    test('a 400 response does not trigger any role-fallback re-request (contract 4.10)', async () => {
        harness.globalFetch.mockResolvedValue({
            ok: false,
            status: 400,
            data: { error: { message: 'unknown variant `developer`' } },
        })
        await requestChatDataMain(requestArgument('official-dev', { hostOmitCallerGenerationCap: true }), 'model')
        expect(harness.globalFetch).toHaveBeenCalledTimes(1)
        // globalFetch receives the request body as a JS object (not a JSON string).
        const sentBody = harness.globalFetch.mock.calls[0][1].body as { messages: Array<{ role: string }> }
        // no second dispatch that downgrades the role, and the single dispatch reflects the decision
        expect(sentBody.messages.map((m) => m.role)).toEqual(['developer', 'user'])
    })
})
