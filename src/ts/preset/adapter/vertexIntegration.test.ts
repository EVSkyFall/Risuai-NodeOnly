import { describe, expect, test } from 'vitest'
import { loadBundledRegistry, resolveSnapshot } from '../registry'
import type { ModelPreset } from '../types'
import { buildPreparedRequest } from './buildRequest'
import { createServiceAccountTokenCache } from './googleServiceAccount/cache'
import type { ExchangeServiceAccountInput } from './googleServiceAccount/token'
import { resolveAdapterCredential } from './resolveCredential'

const VALID_SA_JSON = JSON.stringify({
    type: 'service_account',
    project_id: 'demo',
    private_key_id: 'kid-1',
    private_key:
        '-----BEGIN PRIVATE KEY-----\nMIIBVwIB...\n-----END PRIVATE KEY-----\n',
    client_email: 'svc@demo.iam.gserviceaccount.com',
    client_id: '1',
    token_uri: 'https://oauth2.googleapis.com/token',
})

function vertexPreset(userValues: Record<string, unknown>): ModelPreset {
    const registry = loadBundledRegistry()
    const snapshot = resolveSnapshot(registry, 'vertex-openai:standard')
    return {
        id: 'preset-1',
        name: 'Vertex Preset',
        profileSnapshot: snapshot,
        userValues,
        createdAt: 1,
        updatedAt: 1,
    }
}

function stubCache(accessToken: string) {
    const calls: ExchangeServiceAccountInput[] = []
    const exchange = async (input: ExchangeServiceAccountInput) => {
        calls.push(input)
        return {
            accessToken,
            tokenType: 'Bearer',
            expiresInSeconds: 3600,
            issuedAtMs: 1_000_000,
        }
    }
    return {
        cache: createServiceAccountTokenCache({ now: () => 1_000_000, exchange }),
        calls,
    }
}

describe('Vertex OpenAI end-to-end (bundled registry)', () => {
    test('resolves SA credential then builds the prepared request with bearer token + endpoint URL', async () => {
        const { cache, calls } = stubCache('ya29.integration')
        const preset = vertexPreset({
            serviceAccountJson: VALID_SA_JSON,
            projectId: 'my-proj',
            modelId: 'google/gemini-2.5-pro',
        })

        const credential = await resolveAdapterCredential({
            preset,
            credential: { apiKey: VALID_SA_JSON },
            tokenCache: cache,
        })
        expect(credential?.apiKey).toBe('ya29.integration')

        const prepared = buildPreparedRequest({ preset, credential })

        expect(prepared.method).toBe('POST')
        expect(prepared.url).toBe(
            'https://us-central1-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-central1/endpoints/openapi/chat/completions',
        )
        expect(prepared.headers.Authorization).toBe('Bearer ya29.integration')
        expect(prepared.body.model).toBe('google/gemini-2.5-pro')

        // SA parser ran and forwarded the parsed account to the cache.
        expect(calls).toHaveLength(1)
        expect(calls[0].serviceAccount.clientEmail).toBe('svc@demo.iam.gserviceaccount.com')
    })

    test('uses global location host when userValues sets location=global', async () => {
        const { cache } = stubCache('ya29.global')
        const preset = vertexPreset({
            serviceAccountJson: VALID_SA_JSON,
            projectId: 'my-proj',
            location: 'global',
            modelId: 'google/gemini-2.5-pro',
        })
        const credential = await resolveAdapterCredential({
            preset,
            credential: { apiKey: VALID_SA_JSON },
            tokenCache: cache,
        })
        const prepared = buildPreparedRequest({ preset, credential })
        expect(prepared.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/endpoints/openapi/chat/completions',
        )
    })
})
