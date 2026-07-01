import { describe, expect, test } from 'vitest'
import { ModelPresetAdapterError } from '../error'
import { exchangeServiceAccountForAccessToken, type ExchangeServiceAccountInput } from './token'
import { makeServiceAccountFixture } from './__testFixtures'

interface CapturedCall {
    url: string
    init: RequestInit
}

function fakeFetch(
    responder: (call: CapturedCall) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
    const calls: CapturedCall[] = []
    const fetchImpl = (async (
        input: RequestInfo | URL,
        init: RequestInit = {},
    ): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString()
        calls.push({ url, init })
        return responder({ url, init })
    }) as typeof fetch
    return { fetchImpl, calls }
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    })
}

const fixedNow = () => 1_700_000_000_000
const TOKEN_ENDPOINT = '/api/model-preset/google-service-account/token'

// Always inject fetchImpl + a stub auth header so the test never falls back to
// the real (globalApi-backed) auth getter.
function exchange(
    fetchImpl: typeof fetch,
    extra: Partial<ExchangeServiceAccountInput> = {},
): Promise<unknown> {
    return exchangeServiceAccountForAccessToken({
        serviceAccount: makeServiceAccountFixture(),
        fetchImpl,
        now: fixedNow,
        getAuthHeader: async () => 'test-jwt',
        ...extra,
    })
}

describe('exchangeServiceAccountForAccessToken', () => {
    test('returns access token and expiry on 200', async () => {
        const { fetchImpl } = fakeFetch(() =>
            jsonResponse({ access_token: 'ya29.test', token_type: 'Bearer', expires_in: 3599 }),
        )
        const result = (await exchange(fetchImpl)) as Record<string, unknown>
        expect(result.accessToken).toBe('ya29.test')
        expect(result.tokenType).toBe('Bearer')
        expect(result.expiresInSeconds).toBe(3599)
        expect(result.issuedAtMs).toBe(fixedNow())
    })

    test('defaults token_type to Bearer when missing', async () => {
        const { fetchImpl } = fakeFetch(() => jsonResponse({ access_token: 'tok', expires_in: 3600 }))
        const result = (await exchange(fetchImpl)) as Record<string, unknown>
        expect(result.tokenType).toBe('Bearer')
    })

    test('POSTs the service account JSON + scope to the auth-gated server endpoint', async () => {
        const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ access_token: 'tok', expires_in: 3600 }))
        await exchange(fetchImpl, { scope: 'https://www.googleapis.com/auth/aiplatform' })
        expect(calls).toHaveLength(1)
        const call = calls[0]
        expect(call.url).toBe(TOKEN_ENDPOINT)
        expect(call.init.method).toBe('POST')
        const headers = call.init.headers as Record<string, string>
        expect(headers['Content-Type']).toBe('application/json')
        expect(headers['risu-auth']).toBe('test-jwt')
        const body = JSON.parse(call.init.body as string)
        expect(typeof body.serviceAccountJson).toBe('string')
        expect(JSON.parse(body.serviceAccountJson).client_email).toBe('svc@demo.iam.gserviceaccount.com')
        expect(body.scope).toBe('https://www.googleapis.com/auth/aiplatform')
    })

    test('honors abort signal by forwarding to fetch', async () => {
        const controller = new AbortController()
        const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ access_token: 'tok', expires_in: 3600 }))
        await exchange(fetchImpl, { abortSignal: controller.signal })
        expect(calls[0].init.signal).toBe(controller.signal)
    })

    test('maps 401 to auth error and surfaces Google OAuth error_description', async () => {
        const { fetchImpl } = fakeFetch(
            () =>
                new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'bad sig' }), {
                    status: 401,
                }),
        )
        await expectAdapterError(() => exchange(fetchImpl), {
            kind: 'auth',
            retryable: false,
            fallbackEligible: false,
            status: 401,
            messageContains: 'invalid_grant: bad sig',
        })
    })

    test('maps 400 to invalid-request and surfaces Google OAuth error_description', async () => {
        const { fetchImpl } = fakeFetch(
            () =>
                new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'bad jwt' }), {
                    status: 400,
                }),
        )
        await expectAdapterError(() => exchange(fetchImpl), {
            kind: 'invalid-request',
            retryable: false,
            fallbackEligible: false,
            status: 400,
            messageContains: 'invalid_grant: bad jwt',
        })
    })

    test('maps 429 to rate-limit (retryable=true, fallbackEligible=false)', async () => {
        const { fetchImpl } = fakeFetch(() => new Response('rate', { status: 429 }))
        await expectAdapterError(() => exchange(fetchImpl), {
            kind: 'rate-limit',
            retryable: true,
            fallbackEligible: false,
            status: 429,
        })
    })

    test('maps 500 to server (retryable, fallback eligible)', async () => {
        const { fetchImpl } = fakeFetch(() => new Response('oops', { status: 503 }))
        await expectAdapterError(() => exchange(fetchImpl), {
            kind: 'server',
            retryable: true,
            fallbackEligible: true,
            status: 503,
        })
    })

    test('wraps fetch throw as network error', async () => {
        const fetchImpl = (async () => {
            throw new TypeError('network down')
        }) as typeof fetch
        await expectAdapterError(() => exchange(fetchImpl), {
            kind: 'network',
            retryable: true,
            fallbackEligible: true,
        })
    })

    test('throws parse error when body is not JSON', async () => {
        const { fetchImpl } = fakeFetch(() => new Response('not-json', { status: 200 }))
        await expectAdapterError(() => exchange(fetchImpl), { kind: 'parse' })
    })

    test('throws parse error when body is not a JSON object', async () => {
        const { fetchImpl } = fakeFetch(() => new Response('"hello"', { status: 200 }))
        await expectAdapterError(() => exchange(fetchImpl), { kind: 'parse' })
    })

    test('throws parse error when access_token missing (not retryable)', async () => {
        const { fetchImpl } = fakeFetch(() => jsonResponse({ expires_in: 3600 }))
        await expectAdapterError(() => exchange(fetchImpl), {
            kind: 'parse',
            retryable: false,
            fallbackEligible: false,
        })
    })

    test('throws parse error when expires_in missing or non-positive', async () => {
        const cases: Array<unknown> = [undefined, 0, -1, 'three thousand', null]
        for (const expires of cases) {
            const { fetchImpl } = fakeFetch(() => jsonResponse({ access_token: 'tok', expires_in: expires }))
            await expectAdapterError(() => exchange(fetchImpl), {
                kind: 'parse',
                retryable: false,
                fallbackEligible: false,
            })
        }
    })

    test('throws unsupported when no fetch implementation is available', async () => {
        const original = globalThis.fetch
        // Drop the global so the defensive fallback fires.
        ;(globalThis as { fetch?: typeof fetch }).fetch = undefined
        try {
            await expectAdapterError(
                () =>
                    exchangeServiceAccountForAccessToken({
                        serviceAccount: makeServiceAccountFixture(),
                        now: fixedNow,
                        getAuthHeader: async () => 'test-jwt',
                    }),
                { kind: 'unsupported', retryable: false, fallbackEligible: false },
            )
        } finally {
            ;(globalThis as { fetch?: typeof fetch }).fetch = original
        }
    })
})

interface AdapterErrorExpectation {
    kind?: ModelPresetAdapterError['kind']
    retryable?: boolean
    fallbackEligible?: boolean
    status?: number
    messageContains?: string
}

async function expectAdapterError(
    fn: () => Promise<unknown>,
    expected: AdapterErrorExpectation | undefined,
): Promise<void> {
    try {
        await fn()
        throw new Error('expected throw')
    } catch (err) {
        expect(err).toBeInstanceOf(ModelPresetAdapterError)
        if (!(err instanceof ModelPresetAdapterError)) return
        if (!expected) return
        if (expected.kind !== undefined) expect(err.kind).toBe(expected.kind)
        if (expected.retryable !== undefined) expect(err.retryable).toBe(expected.retryable)
        if (expected.fallbackEligible !== undefined)
            expect(err.fallbackEligible).toBe(expected.fallbackEligible)
        if (expected.status !== undefined) expect(err.status).toBe(expected.status)
        if (expected.messageContains !== undefined) {
            expect(err.message).toContain(expected.messageContains)
        }
    }
}
