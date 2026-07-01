import { describe, expect, test } from 'vitest'
import { ModelPresetAdapterError } from './error'
import { buildVertexOpenAIEndpointUrl } from './vertexEndpoint'

describe('buildVertexOpenAIEndpointUrl', () => {
    test('builds a regional URL with location prefix', () => {
        const url = buildVertexOpenAIEndpointUrl({ project: 'demo-proj', location: 'us-central1' })
        expect(url).toBe(
            'https://us-central1-aiplatform.googleapis.com/v1/projects/demo-proj/locations/us-central1/endpoints/openapi/chat/completions',
        )
    })

    test('builds the global URL without location prefix when location is "global"', () => {
        const url = buildVertexOpenAIEndpointUrl({ project: 'demo-proj', location: 'global' })
        expect(url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/demo-proj/locations/global/endpoints/openapi/chat/completions',
        )
    })

    test('handles multiple supported regions', () => {
        const regions = ['us-east5', 'us-west1', 'europe-west4', 'asia-northeast1']
        for (const region of regions) {
            const url = buildVertexOpenAIEndpointUrl({ project: 'p', location: region })
            expect(url).toContain(`https://${region}-aiplatform.googleapis.com/`)
            expect(url).toContain(`/locations/${region}/`)
        }
    })

    test('trims whitespace around inputs', () => {
        const url = buildVertexOpenAIEndpointUrl({ project: '  demo  ', location: '  us-central1  ' })
        expect(url).toBe(
            'https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/endpoints/openapi/chat/completions',
        )
    })

    test('throws invalid-request when project is empty', () => {
        expectInvalid(() => buildVertexOpenAIEndpointUrl({ project: '', location: 'us-central1' }))
        expectInvalid(() => buildVertexOpenAIEndpointUrl({ project: '   ', location: 'us-central1' }))
    })

    test('throws invalid-request when location is empty', () => {
        expectInvalid(() => buildVertexOpenAIEndpointUrl({ project: 'p', location: '' }))
        expectInvalid(() => buildVertexOpenAIEndpointUrl({ project: 'p', location: '   ' }))
    })

    test('throws invalid-request when project has illegal characters', () => {
        expectInvalid(() => buildVertexOpenAIEndpointUrl({ project: 'demo/proj', location: 'us-central1' }))
        expectInvalid(() => buildVertexOpenAIEndpointUrl({ project: 'demo proj', location: 'us-central1' }))
        expectInvalid(() => buildVertexOpenAIEndpointUrl({ project: 'demo.proj', location: 'us-central1' }))
    })

    test('throws invalid-request when location has illegal characters', () => {
        expectInvalid(() => buildVertexOpenAIEndpointUrl({ project: 'p', location: 'us central1' }))
        expectInvalid(() => buildVertexOpenAIEndpointUrl({ project: 'p', location: 'us_central1' }))
    })
})

function expectInvalid(fn: () => unknown): void {
    try {
        fn()
        throw new Error('expected throw')
    } catch (err) {
        expect(err).toBeInstanceOf(ModelPresetAdapterError)
        if (err instanceof ModelPresetAdapterError) {
            expect(err.kind).toBe('invalid-request')
            expect(err.retryable).toBe(false)
            expect(err.fallbackEligible).toBe(false)
        }
    }
}
