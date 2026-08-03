import { describe, expect, test, vi } from 'vitest'

import {
    PLUGIN_STORAGE_PREVIEW_CHARS,
    canCommitDetailMutation,
    canMutateDetail,
    createBoundedValuePreview,
    createPluginStorageBackendAdapter,
    isCurrentStorageOperation,
    matchesBoundedValue,
} from './pluginStorageViewer'

describe('plugin storage bounded preview', () => {
    test('caps a tens-of-megabytes string without losing its exact length', () => {
        const value = 'A'.repeat(24 * 1024 * 1024)

        const preview = createBoundedValuePreview(value)

        expect(preview.text).toHaveLength(PLUGIN_STORAGE_PREVIEW_CHARS)
        expect(preview.totalChars).toBe(value.length)
        expect(preview.totalCharsExact).toBe(true)
        expect(preview.truncated).toBe(true)
        expect(preview.editable).toBe(false)
    })

    test('stops object traversal at the cap instead of touching later getters', () => {
        let touched = false
        const value: Record<string, unknown> = {
            payload: 'A'.repeat(PLUGIN_STORAGE_PREVIEW_CHARS),
        }
        Object.defineProperty(value, 'sentinel', {
            enumerable: true,
            get() {
                touched = true
                return 'must not be read'
            },
        })

        const preview = createBoundedValuePreview(value)

        expect(preview.text).toHaveLength(PLUGIN_STORAGE_PREVIEW_CHARS)
        expect(preview.truncated).toBe(true)
        expect(preview.totalCharsExact).toBe(false)
        expect(touched).toBe(false)
    })

    test('does not touch the next getter when the previous property exactly fills the cap', () => {
        let touched = false
        const value: Record<string, unknown> = { a: '12345' }
        Object.defineProperty(value, 'sentinel', {
            enumerable: true,
            get() {
                touched = true
                return 'must not be read'
            },
        })
        const exactPrefix = '{\n  "a": "12345"'

        const preview = createBoundedValuePreview(value, exactPrefix.length)

        expect(preview.text).toBe(exactPrefix)
        expect(preview.truncated).toBe(true)
        expect(touched).toBe(false)
    })

    test('searches only the bounded prefix', () => {
        const value = `${'A'.repeat(PLUGIN_STORAGE_PREVIEW_CHARS)}suffix-only`

        expect(matchesBoundedValue(value, 'aaaa')).toBe(true)
        expect(matchesBoundedValue(value, 'suffix-only')).toBe(false)
    })

    test('keeps a small JSON value complete and editable', () => {
        const value = { enabled: true, nested: ['one', 2] }

        const preview = createBoundedValuePreview(value)

        expect(JSON.parse(preview.text)).toEqual(value)
        expect(preview.totalCharsExact).toBe(true)
        expect(preview.truncated).toBe(false)
        expect(preview.editable).toBe(true)
    })
})

describe('plugin storage mutation guards', () => {
    const current = {
        backend: 'save' as const,
        key: 'large-key',
        generation: 7,
    }

    test('rejects both truncated state and stale backend/key/generation state', () => {
        expect(canMutateDetail({ ...current, editable: false }, current)).toBe(false)
        expect(canMutateDetail({ ...current, editable: true }, current)).toBe(true)
        expect(canMutateDetail({ ...current, editable: true }, { ...current, generation: 8 })).toBe(false)
        expect(canMutateDetail({ ...current, editable: true }, { ...current, backend: 'local' })).toBe(false)
        expect(canMutateDetail({ ...current, editable: true }, { ...current, key: 'other' })).toBe(false)
    })

    test('rejects stale detail and search operation results', () => {
        expect(isCurrentStorageOperation(4, 4, 'save', 'save')).toBe(true)
        expect(isCurrentStorageOperation(4, 5, 'save', 'save')).toBe(false)
        expect(isCurrentStorageOperation(4, 4, 'save', 'idb')).toBe(false)
    })

    test('rejects a save completion after its operation or detail generation becomes stale', () => {
        const detail = { ...current, editable: true }

        expect(canCommitDetailMutation(11, 11, detail, current)).toBe(true)
        expect(canCommitDetailMutation(11, 12, detail, current)).toBe(false)
        expect(canCommitDetailMutation(11, 11, detail, { ...current, generation: 8 })).toBe(false)
        expect(canCommitDetailMutation(11, 11, detail, { ...current, key: 'new-detail' })).toBe(false)
    })
})

describe('plugin storage backend adapter', () => {
    test('routes every save mutation through pluginCustomKv', async () => {
        const custom = {
            keys: vi.fn(() => ['one', 'two']),
            getItem: vi.fn(() => null),
            setItem: vi.fn(),
            removeItem: vi.fn(),
            flushImmediate: vi.fn(async () => {}),
        }
        const local = {
            keys: vi.fn(() => [] as string[]),
            getItem: vi.fn(() => null),
            setItem: vi.fn(),
            removeItem: vi.fn(),
        }
        const idb = {
            keys: vi.fn(async () => [] as string[]),
            getItemUncached: vi.fn(async () => null),
            setItem: vi.fn(async () => {}),
            removeItem: vi.fn(async () => {}),
        }
        const removeOwner = vi.fn(async () => {})
        const adapter = createPluginStorageBackendAdapter({ custom, local, idb, removeOwner })

        await adapter.write('save', 'one', { ok: true })
        await adapter.remove('save', 'one')
        await adapter.removeMany('save', ['one', 'two'])

        expect(custom.setItem).toHaveBeenCalledWith('one', { ok: true })
        expect(custom.removeItem).toHaveBeenCalledTimes(3)
        expect(custom.flushImmediate).toHaveBeenCalledTimes(3)
        expect(local.setItem).not.toHaveBeenCalled()
        expect(idb.setItem).not.toHaveBeenCalled()
        expect(removeOwner).toHaveBeenCalledWith('save', 'one')
        expect(removeOwner).toHaveBeenCalledWith('save', 'two')
    })
})
