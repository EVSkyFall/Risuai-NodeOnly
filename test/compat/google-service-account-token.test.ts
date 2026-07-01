/**
 * Integration coverage for the server-side google-service-account token
 * endpoint (POST /api/model-preset/google-service-account/token). The client
 * unit tests mock fetch; these boot the real server.cjs and exercise the
 * security-critical invariants that only the server enforces: the checkAuth
 * gate, the token_uri SSRF allowlist (runs before any signing/network), input
 * validation, and that the private key is never echoed back.
 *
 * The "valid SA" case uses a freshly generated (unregistered) key pair, so
 * Google rejects the exchange (4xx) — or the network is unavailable (502).
 * Either way the request gets past signing without leaking the key, which is
 * what we assert.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'

const ENDPOINT = '/api/model-preset/google-service-account/token'

// The endpoint is stateless, so one server + client is reused across the suite
// (fewer concurrent spawns -> less harness contention, faster).
let srv: ServerHandle
let client: RisuClient

beforeAll(async () => {
    srv = await spawnServer()
    client = await createClient(srv.port, srv.password)
})

afterAll(async () => {
    await srv?.cleanup()
})

function makeServiceAccountJson(overrides: Record<string, unknown> = {}): string {
    const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    return JSON.stringify({
        type: 'service_account',
        client_email: 'svc@demo.iam.gserviceaccount.com',
        private_key: privateKey,
        private_key_id: 'kid-1',
        token_uri: 'https://oauth2.googleapis.com/token',
        ...overrides,
    })
}

describe('google-service-account token endpoint', () => {
    test('rejects requests without a risu-auth header', async () => {
        const res = await fetch(`http://127.0.0.1:${srv.port}${ENDPOINT}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ serviceAccountJson: makeServiceAccountJson() }),
        })
        expect(res.status).toBeGreaterThanOrEqual(400)
    })

    test('400s on missing or unparseable service account JSON', async () => {

        const missing = await client.fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(missing.status).toBe(400)

        const notJson = await client.fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ serviceAccountJson: 'definitely not json' }),
        })
        expect(notJson.status).toBe(400)
    })

    test('400s when client_email / private_key are absent', async () => {
        const res = await client.fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ serviceAccountJson: JSON.stringify({ type: 'service_account' }) }),
        })
        expect(res.status).toBe(400)
    })

    test('rejects a non-Google token_uri (SSRF / JWT-exfiltration guard)', async () => {
        const res = await client.fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                serviceAccountJson: makeServiceAccountJson({ token_uri: 'https://evil.example.com/token' }),
            }),
        })
        expect(res.status).toBe(400)
        expect((await res.text()).toLowerCase()).toContain('token_uri')
    })

    test('signs + forwards Google without echoing the private key', async () => {
        const serviceAccountJson = makeServiceAccountJson()
        const privateKey = JSON.parse(serviceAccountJson).private_key as string

        const res = await client.fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ serviceAccountJson }),
        })
        const body = await res.text()

        // An unregistered SA cannot mint a real token, so success (200) never
        // happens here; the server must have gotten past signing (no 400
        // "failed to sign") and forwarded Google's rejection (or a 502 when the
        // network is unavailable).
        expect(res.status).not.toBe(200)
        expect(body.toLowerCase()).not.toContain('failed to sign')
        // No key material may leak back to the client.
        expect(body).not.toContain('PRIVATE KEY')
        expect(body).not.toContain(privateKey)
    })
})
