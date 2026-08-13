import { describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
    db: {
        enableCustomFlags: false,
        customFlags: [],
    },
}))

vi.mock('../storage/database.svelte', () => ({
    getDatabase: () => harness.db,
}))

vi.mock('../globalApi.svelte', () => ({
    fetchNative: vi.fn(),
}))

vi.mock('../stores.svelte', () => ({
    DBState: { db: harness.db },
}))

vi.mock('../plugins/plugins.svelte', () => ({
    customProviderStore: undefined,
    pluginV2: { providers: new Map() },
}))

vi.mock('../plugins/apiV3/v3.svelte', () => ({
    customV3ProviderMetaStore: [],
}))

import { getModelInfo } from '../model/modellist'
import { allBasicParameterItems } from './botSettingsParamsData'

describe('Google Dynamic Vertex thinking settings', () => {
    test('exposes Thinking Level for the registered wrapper model', () => {
        const modelInfo = getModelInfo('google-dynamic-vertex')
        const item = allBasicParameterItems.find((item) => item.id === 'params.geminiThinkingLevel')

        expect(item?.condition?.({
            db: { aiModel: 'google-dynamic-vertex' },
            modelInfo,
            subModelInfo: modelInfo,
        } as never)).toBe(true)
    })

    test('exposes Thinking Level only for the Vertex dynamic sub-model path', () => {
        const modelInfo = getModelInfo('openai-dynamic')
        const item = allBasicParameterItems.find((item) => item.id === 'params.geminiThinkingLevel')

        expect(item?.condition?.({
            db: { subModel: 'google-dynamic-vertex' },
            modelInfo,
            subModelInfo: getModelInfo('google-dynamic-vertex'),
        } as never)).toBe(true)

        expect(item?.condition?.({
            db: { subModel: 'google-dynamic' },
            modelInfo,
            subModelInfo: getModelInfo('google-dynamic'),
        } as never)).toBe(false)
    })
})
