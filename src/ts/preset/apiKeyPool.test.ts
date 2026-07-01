import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockDb } = vi.hoisted(() => ({ mockDb: { db: {} as any } }))

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => mockDb.db,
}))

import { addApiKey, getApiKey, listApiKeys, removeApiKey, updateApiKey } from './apiKeyPool'

let clock = 1000
beforeEach(() => {
    mockDb.db = { apiKeyPool: {} }
    clock = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => clock++)
})

describe('apiKeyPool', () => {
    it('adds a key and returns it via getApiKey', () => {
        const entry = addApiKey({ name: 'My OpenAI', key: 'sk-123', provider: 'openai' })
        expect(entry.id).toBeTruthy()
        expect(getApiKey(entry.id)).toEqual(entry)
        expect(mockDb.db.apiKeyPool[entry.id]).toEqual(entry)
    })

    it('reassigns apiKeyPool to a new object reference on mutation (Svelte reactivity)', () => {
        const before = mockDb.db.apiKeyPool
        addApiKey({ name: 'k', key: 'sk-1' })
        expect(mockDb.db.apiKeyPool).not.toBe(before)
    })

    it('initialises the pool when undefined', () => {
        mockDb.db = {} // no apiKeyPool
        const entry = addApiKey({ name: 'k', key: 'sk-1' })
        expect(mockDb.db.apiKeyPool[entry.id]).toEqual(entry)
    })

    it('filters by provider and falls back to all when omitted', () => {
        addApiKey({ name: 'a', key: 'k1', provider: 'openai' })
        addApiKey({ name: 'b', key: 'k2', provider: 'anthropic' })
        addApiKey({ name: 'c', key: 'k3' }) // untagged
        expect(listApiKeys('openai').map((e) => e.name)).toEqual(['a'])
        expect(listApiKeys().length).toBe(3)
    })

    it('sorts listed keys by updatedAt descending', () => {
        const first = addApiKey({ name: 'first', key: 'k1' })
        const second = addApiKey({ name: 'second', key: 'k2' })
        // force first to be the most recently updated
        updateApiKey(first.id, { name: 'first!' })
        const names = listApiKeys().map((e) => e.name)
        expect(names[0]).toBe('first!')
        expect(names).toContain('second')
        void second
    })

    it('updates fields and bumps updatedAt without touching createdAt', () => {
        const entry = addApiKey({ name: 'old', key: 'k', provider: 'openai' })
        updateApiKey(entry.id, { name: 'new', provider: 'anthropic' })
        const after = getApiKey(entry.id)!
        expect(after.name).toBe('new')
        expect(after.provider).toBe('anthropic')
        expect(after.key).toBe('k')
        expect(after.createdAt).toBe(entry.createdAt)
        expect(after.updatedAt).toBeGreaterThanOrEqual(entry.updatedAt)
    })

    it('update is a no-op for an unknown id', () => {
        addApiKey({ name: 'a', key: 'k' })
        const before = mockDb.db.apiKeyPool
        updateApiKey('missing', { name: 'x' })
        expect(mockDb.db.apiKeyPool).toBe(before)
    })

    it('removes a key', () => {
        const entry = addApiKey({ name: 'a', key: 'k' })
        removeApiKey(entry.id)
        expect(getApiKey(entry.id)).toBeUndefined()
        expect(Object.keys(mockDb.db.apiKeyPool)).toHaveLength(0)
    })
})
