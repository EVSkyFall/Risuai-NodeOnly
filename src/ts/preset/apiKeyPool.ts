import { getDatabase } from 'src/ts/storage/database.svelte'
import type { ApiKeyPoolEntry } from './types'
import { v4 as uuidv4 } from 'uuid'

/**
 * Saved API key pool (db.apiKeyPool). A ModelPreset references an entry via
 * `apiKeyRef`; `buildModelPresetCredential` resolves apiKeyRef before any
 * inline/userValue key. Entries are tagged with `provider` (= the preset's
 * `profileSnapshot.providerBaseId`) so the in-form picker can filter to the
 * matching provider.
 *
 * Mutations reassign db.apiKeyPool to a fresh object — Svelte 5 no-ops a
 * same-reference assignment, so a new reference is required to trigger UI
 * reactivity for the pool manager and pickers.
 */

export function listApiKeys(provider?: string): ApiKeyPoolEntry[] {
    const pool = getDatabase().apiKeyPool ?? {}
    const all = Object.values(pool)
    const filtered = provider ? all.filter((e) => e.provider === provider) : all
    return filtered.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getApiKey(id: string | undefined): ApiKeyPoolEntry | undefined {
    if (!id) return undefined
    return getDatabase().apiKeyPool?.[id]
}

export function addApiKey(input: { name: string; key: string; provider?: string }): ApiKeyPoolEntry {
    const db = getDatabase()
    const now = Date.now()
    const entry: ApiKeyPoolEntry = {
        id: uuidv4(),
        name: input.name,
        provider: input.provider,
        key: input.key,
        createdAt: now,
        updatedAt: now,
    }
    db.apiKeyPool = { ...(db.apiKeyPool ?? {}), [entry.id]: entry }
    return entry
}

export function updateApiKey(
    id: string,
    patch: Partial<Pick<ApiKeyPoolEntry, 'name' | 'key' | 'provider'>>,
): void {
    const db = getDatabase()
    const cur = db.apiKeyPool?.[id]
    if (!cur) return
    const next: ApiKeyPoolEntry = { ...cur, ...patch, updatedAt: Date.now() }
    db.apiKeyPool = { ...(db.apiKeyPool ?? {}), [id]: next }
}

export function removeApiKey(id: string): void {
    const db = getDatabase()
    if (!db.apiKeyPool?.[id]) return
    const next = { ...db.apiKeyPool }
    delete next[id]
    db.apiKeyPool = next
}
