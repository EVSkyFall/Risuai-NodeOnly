import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import type { ParsedServiceAccount } from './serviceAccount'

let cached: { pem: string; publicKey: KeyObject } | undefined

export function getTestKeyPair(): { pem: string; publicKey: KeyObject } {
    if (cached) return cached
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    cached = {
        pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        publicKey,
    }
    return cached
}

export function makeServiceAccountFixture(
    overrides: Partial<ParsedServiceAccount> = {},
): ParsedServiceAccount {
    const { pem } = getTestKeyPair()
    const sa: ParsedServiceAccount = {
        type: 'service_account',
        clientEmail: 'svc@demo.iam.gserviceaccount.com',
        privateKeyId: 'kid-1',
        privateKey: pem,
        tokenUri: 'https://oauth2.googleapis.com/token',
        sourceJson: '',
        ...overrides,
    }
    if (!sa.sourceJson) {
        sa.sourceJson = JSON.stringify({
            type: 'service_account',
            client_email: sa.clientEmail,
            private_key: sa.privateKey,
            private_key_id: sa.privateKeyId,
            token_uri: sa.tokenUri,
        })
    }
    return sa
}
