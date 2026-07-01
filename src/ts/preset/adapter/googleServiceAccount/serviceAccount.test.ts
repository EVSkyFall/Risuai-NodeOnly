import { describe, expect, test } from 'vitest'
import { ModelPresetAdapterError } from '../error'
import { parseServiceAccountJson } from './serviceAccount'

function validJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        type: 'service_account',
        project_id: 'demo-project',
        private_key_id: 'kid-123',
        private_key:
            '-----BEGIN PRIVATE KEY-----\nMIIBVwIB...\n-----END PRIVATE KEY-----\n',
        client_email: 'svc@demo-project.iam.gserviceaccount.com',
        client_id: '1',
        token_uri: 'https://oauth2.googleapis.com/token',
        ...overrides,
    })
}

describe('parseServiceAccountJson', () => {
    test('parses a valid SA JSON', () => {
        const parsed = parseServiceAccountJson(validJson())
        expect(parsed.type).toBe('service_account')
        expect(parsed.clientEmail).toBe('svc@demo-project.iam.gserviceaccount.com')
        expect(parsed.privateKeyId).toBe('kid-123')
        expect(parsed.tokenUri).toBe('https://oauth2.googleapis.com/token')
        expect(parsed.privateKey.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true)
    })

    test('falls back to default tokenUri when missing', () => {
        const parsed = parseServiceAccountJson(validJson({ token_uri: undefined }))
        expect(parsed.tokenUri).toBe('https://oauth2.googleapis.com/token')
    })

    test('treats empty tokenUri as missing', () => {
        const parsed = parseServiceAccountJson(validJson({ token_uri: '' }))
        expect(parsed.tokenUri).toBe('https://oauth2.googleapis.com/token')
    })

    test('omits privateKeyId when missing or empty', () => {
        expect(parseServiceAccountJson(validJson({ private_key_id: undefined })).privateKeyId).toBeUndefined()
        expect(parseServiceAccountJson(validJson({ private_key_id: '' })).privateKeyId).toBeUndefined()
    })

    test('throws invalid-request for empty input', () => {
        expectInvalid(() => parseServiceAccountJson(''))
        expectInvalid(() => parseServiceAccountJson('   '))
    })

    test('throws invalid-request for malformed JSON', () => {
        expectInvalid(() => parseServiceAccountJson('{not-json'))
    })

    test('throws invalid-request for non-object JSON', () => {
        expectInvalid(() => parseServiceAccountJson('"string"'))
        expectInvalid(() => parseServiceAccountJson('[1,2,3]'))
        expectInvalid(() => parseServiceAccountJson('null'))
    })

    test('throws invalid-request for wrong type field', () => {
        expectInvalid(() => parseServiceAccountJson(validJson({ type: 'user' })))
        expectInvalid(() => parseServiceAccountJson(validJson({ type: undefined })))
    })

    test('throws invalid-request when client_email missing', () => {
        expectInvalid(() => parseServiceAccountJson(validJson({ client_email: undefined })))
        expectInvalid(() => parseServiceAccountJson(validJson({ client_email: '' })))
    })

    test('throws invalid-request when private_key missing', () => {
        expectInvalid(() => parseServiceAccountJson(validJson({ private_key: undefined })))
    })

    test('throws invalid-request when private_key is not PEM', () => {
        expectInvalid(() => parseServiceAccountJson(validJson({ private_key: 'plain-text-key' })))
    })

    test('throws invalid-request when private_key only has BEGIN marker', () => {
        expectInvalid(() =>
            parseServiceAccountJson(validJson({ private_key: '-----BEGIN PRIVATE KEY-----\nabc' })),
        )
    })

    test('rejects non-Google token_uri (SSRF / signed-JWT exfiltration guard)', () => {
        // Hostile imported SA JSON could redirect our signed assertion to any
        // URL. Only the standard Google OAuth token endpoint is allowed.
        expectInvalid(() => parseServiceAccountJson(validJson({ token_uri: 'https://attacker.test/token' })))
        expectInvalid(() => parseServiceAccountJson(validJson({ token_uri: 'http://internal-host:8080/probe' })))
        // Even a Google-looking but non-standard host is rejected (e.g. a typo
        // attack or a related but unaudited endpoint).
        expectInvalid(() => parseServiceAccountJson(validJson({ token_uri: 'https://oauth2.google.com/token' })))
        expectInvalid(() => parseServiceAccountJson(validJson({ token_uri: 'https://accounts.google.com/o/oauth2/token' })))
        // Default fallback (when token_uri is missing/empty) is still allowed.
        const parsed = parseServiceAccountJson(validJson({ token_uri: '' }))
        expect(parsed.tokenUri).toBe('https://oauth2.googleapis.com/token')
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
