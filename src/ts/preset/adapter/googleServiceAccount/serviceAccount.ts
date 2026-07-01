import { ModelPresetAdapterError } from '../error'

export interface ParsedServiceAccount {
    type: 'service_account'
    clientEmail: string
    privateKeyId?: string
    privateKey: string
    tokenUri: string
    // The original JSON string. JWT signing + token exchange runs on the Node
    // server (node:crypto, no Secure Context requirement), so the raw JSON is
    // forwarded there rather than signed in the browser.
    sourceJson: string
}

// Default OAuth scope. Lives here (not in the removed browser-side jwt module)
// so the token client + cache can share it.
export const DEFAULT_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token'

// SA JSON often comes from external sources (user-imported files, copy-paste
// from internal docs, …). We sign a JWT and POST it to whatever `token_uri`
// the JSON specifies, so an attacker-supplied SA JSON with a hostile
// `token_uri` would receive the signed assertion (potentially replayable for
// the actual Google audience) and let us probe internal networks (SSRF).
// Lock the field to Google's documented OAuth token endpoint. Any deviation
// would need a deliberate, code-level allowlist extension — not user input.
const ALLOWED_TOKEN_URIS = new Set<string>([
    'https://oauth2.googleapis.com/token',
])

export function parseServiceAccountJson(source: string): ParsedServiceAccount {
    if (typeof source !== 'string' || source.trim().length === 0) {
        throw invalid('Service account JSON is empty')
    }
    let raw: unknown
    try {
        raw = JSON.parse(source)
    } catch (err) {
        throw invalid('Service account JSON is not valid JSON', err)
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw invalid('Service account JSON must be a JSON object')
    }
    const obj = raw as Record<string, unknown>
    const type = obj.type
    if (type !== 'service_account') {
        throw invalid(`Service account JSON has unsupported type '${String(type)}'`)
    }
    const clientEmail = requireString(obj, 'client_email')
    const privateKey = requireString(obj, 'private_key')
    if (!privateKey.includes('BEGIN PRIVATE KEY') || !privateKey.includes('END PRIVATE KEY')) {
        throw invalid('Service account private_key is not a PEM-formatted PKCS#8 key')
    }
    const tokenUriRaw = obj.token_uri
    const tokenUri =
        typeof tokenUriRaw === 'string' && tokenUriRaw.length > 0 ? tokenUriRaw : DEFAULT_TOKEN_URI
    if (!ALLOWED_TOKEN_URIS.has(tokenUri)) {
        throw invalid(
            `Service account token_uri '${tokenUri}' is not in the allowed set. ` +
                'Only the standard Google OAuth token endpoint is permitted to ' +
                'prevent SSRF / signed-JWT exfiltration via imported SA JSON.',
        )
    }
    const privateKeyIdRaw = obj.private_key_id
    const privateKeyId =
        typeof privateKeyIdRaw === 'string' && privateKeyIdRaw.length > 0
            ? privateKeyIdRaw
            : undefined
    return {
        type: 'service_account',
        clientEmail,
        privateKeyId,
        privateKey,
        tokenUri,
        sourceJson: source,
    }
}

function requireString(obj: Record<string, unknown>, key: string): string {
    const value = obj[key]
    if (typeof value !== 'string' || value.length === 0) {
        throw invalid(`Service account JSON is missing field '${key}'`)
    }
    return value
}

function invalid(message: string, cause?: unknown): ModelPresetAdapterError {
    return new ModelPresetAdapterError('invalid-request', message, {
        retryable: false,
        fallbackEligible: false,
        cause,
    })
}
