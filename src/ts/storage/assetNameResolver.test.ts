import { describe, test, expect, vi } from 'vitest'
import { createAssetNameResolver } from './assetNameResolver'

const char = { id: 'c-1', ownerKind: 'character', ownerId: 'chara' } as any
const mod = { id: 'm-1', ownerKind: 'module', ownerId: 'risuco' } as any

describe('createAssetNameResolver', () => {
    test('asks once with the character first (fuzzy) and modules exact, then serves repeats from memory', async () => {
        const resolve = vi.fn(async (_owners: any, names: string[]) => Object.fromEntries(names.filter((n) => n !== 'missing').map((n) => [n, `assets/${n}`])))
        const resolveNames = createAssetNameResolver(resolve)

        const first = await resolveNames(char, [mod], ['BG-fog', 'missing'], true)
        expect(first).toEqual({ 'bg-fog': 'assets/bg-fog' })
        expect(resolve).toHaveBeenCalledTimes(1)
        expect(resolve.mock.calls[0][0]).toEqual([
            { manifestId: 'c-1', kind: 'character', ownerId: 'chara', fuzzy: true },
            { manifestId: 'm-1', kind: 'module', ownerId: 'risuco', fuzzy: false },
        ])
        expect(resolve.mock.calls[0][1]).toEqual(['bg-fog', 'missing'])

        // Same manifests, same names (hit and miss alike): no round trip.
        const again = await resolveNames(char, [mod], ['bg-fog', 'missing'], true)
        expect(again).toEqual(first)
        expect(resolve).toHaveBeenCalledTimes(1)

        // Only the new name goes to the server.
        await resolveNames(char, [mod], ['bg-fog', 'de-panel-1'], true)
        expect(resolve).toHaveBeenCalledTimes(2)
        expect(resolve.mock.calls[1][1]).toEqual(['de-panel-1'])
    })

    test('a different manifest set or fuzzy setting is a different cache', async () => {
        const resolve = vi.fn(async (_owners: any, _names: string[]) => ({}) as Record<string, string>)
        const resolveNames = createAssetNameResolver(resolve)
        await resolveNames(char, [mod], ['x'], true)
        await resolveNames(char, [mod], ['x'], false)
        await resolveNames(char, [{ ...mod, id: 'm-2' }], ['x'], true)
        await resolveNames(undefined, [mod], ['x'], true)
        expect(resolve).toHaveBeenCalledTimes(4)
        expect((resolve.mock.calls[1] as any)[0][0].fuzzy).toBe(false)
    })

    test('nothing to ask without manifests or names', async () => {
        const resolve = vi.fn(async () => ({}))
        const resolveNames = createAssetNameResolver(resolve)
        expect(await resolveNames(undefined, [], ['x'], true)).toEqual({})
        expect(await resolveNames(char, [], [], true)).toEqual({})
        expect(resolve).not.toHaveBeenCalled()
    })
})
