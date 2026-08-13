import { beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
    flags: {
        hasImageInput: 0,
        hasImageOutput: 1,
        hasAudioInput: 2,
        hasAudioOutput: 3,
        hasVideoInput: 4,
        noCivilIntegrity: 5,
        geminiBlockOff: 6,
        geminiThinking: 7,
    },
    formats: {
        GoogleCloud: 0,
        VertexAIGemini: 1,
    },
    db: {} as Record<string, any>,
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    fetchNative: vi.fn(),
    textifyReadableStream: vi.fn(),
}))

vi.mock('src/ts/model/modellist', () => ({
    LLMFlags: harness.flags,
    LLMFormat: harness.formats,
}))

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => harness.db,
    setDatabase: vi.fn(),
}))

vi.mock('src/ts/util', () => ({
    base64url: vi.fn(),
    simplifySchema: (schema: unknown) => schema,
}))

vi.mock('../files/inlays', () => ({
    saveInlayedSignature: vi.fn(),
    setInlayAsset: vi.fn(),
    writeInlayImage: vi.fn(),
}))

vi.mock('../templates/jsonSchema', () => ({
    extractJSON: vi.fn(),
    getGeneralJSONSchema: vi.fn(),
}))

vi.mock('../mcp/mcp', () => ({
    callTool: vi.fn(),
    decodeToolCall: vi.fn(),
    encodeToolCall: vi.fn(),
}))

vi.mock('src/ts/alert', () => ({
    notifyError: vi.fn(),
}))

vi.mock('src/ts/stores.svelte', () => ({
    bodyIntercepterStore: [],
}))

vi.mock('./shared', () => ({
    applyAdditionalParameters: (body: unknown) => body,
    applyParameters: (body: Record<string, unknown>) => ({ ...body, thinkingBudget: 1234 }),
    getAdditionalParameters: () => ({}),
}))

import { requestGoogleCloudVertex } from './google'

function vertexPreview(model: string) {
    return requestGoogleCloudVertex({
        aiModel: 'google-dynamic-vertex',
        modelInfo: {
            id: 'google-dynamic-vertex',
            internalID: 'google-dynamic',
            format: harness.formats.VertexAIGemini,
            flags: [harness.flags.geminiThinking],
            parameters: ['thinking_tokens'],
        },
        formated: [{ role: 'user', content: 'Hello' }],
        maxTokens: 256,
        mode: 'model',
        previewBody: true,
        useStreaming: false,
    } as never).then((result) => {
        expect(result.type).toBe('success')
        return JSON.parse(result.result as string) as {
            url: string
            body: { generation_config: { thinkingBudget?: number, thinkingConfig?: Record<string, unknown> } }
        }
    })
}

describe('Google Dynamic Vertex thinking request', () => {
    beforeEach(() => {
        harness.db = {
            google: { accessToken: '', projectId: 'project' },
            googleRequestModel: '',
            geminiThinkingLevel: 1,
            googleFlex: false,
            vertexRegion: 'us-central1',
            vertexAccessToken: 'token',
            vertexAccessTokenExpires: Date.now() + 60_000,
            vertexClientEmail: '',
            vertexPrivateKey: '',
            gptVisionQuality: '',
            jsonSchemaEnabled: false,
        }
    })

    test.each([
        ['gemini-2.5-pro', { thinkingBudget: 8192, includeThoughts: true }],
        ['gemini-pro-latest', { thinkingLevel: 'medium', includeThoughts: true }],
        ['gemini-3.1-pro-preview', { thinkingLevel: 'medium', includeThoughts: true }],
    ])('uses the selected real model for %s thinkingConfig', async (model, thinkingConfig) => {
        harness.db.googleRequestModel = model

        const preview = await vertexPreview(model)

        expect(preview.url).toContain(`/models/${model}:generateContent`)
        expect(preview.body.generation_config.thinkingConfig).toEqual(thinkingConfig)
        expect(preview.body.generation_config).not.toHaveProperty('thinkingBudget')
    })
})
