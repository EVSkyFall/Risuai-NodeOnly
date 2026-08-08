import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
    createPluginPermissionManager,
    pluginPermissionDescList,
    type PersistedPluginPermissionState,
} from './pluginPermissionState'

const permissionKeyOf = (pluginName: string, permissionDesc: string) =>
    JSON.stringify([pluginName, permissionDesc])

function makeHarness(initialState: PersistedPluginPermissionState | null = null) {
    let storedState = initialState ? structuredClone(initialState) : null
    let removeCount = 0
    const writes: PersistedPluginPermissionState[] = []
    const scripts = new Map<string, string>()
    const manager = createPluginPermissionManager({
        readState: async () => storedState ? structuredClone(storedState) : null,
        writeState: async (state) => {
            storedState = structuredClone(state)
            writes.push(structuredClone(state))
        },
        removeState: async () => {
            storedState = null
            removeCount++
        },
        getPluginScript: (pluginName) => scripts.get(pluginName),
        hashPluginScript: async (script) => `hash:${script ?? ''}`,
        now: () => 1_234,
    })

    return {
        manager,
        scripts,
        writes,
        getStoredState: () => storedState,
        getRemoveCount: () => removeCount,
    }
}

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

async function waitFor(predicate: () => boolean) {
    for (let attempt = 0; attempt < 20; attempt++) {
        if (predicate()) return
        await new Promise(resolve => setTimeout(resolve, 0))
    }
    throw new Error('condition was not reached')
}

describe('plugin permission preset state', () => {
    it('supports granted, explicit denied, unset, and resumes periodic prompts', async () => {
        const harness = makeHarness()
        harness.scripts.set('Plug', 'script-a')

        expect(await harness.manager.listStates('Plug')).toEqual(
            Object.fromEntries(pluginPermissionDescList.map(desc => [desc, 'unset'])),
        )

        await harness.manager.setPreset('Plug', 'provider', 'granted')
        expect((await harness.manager.listStates('Plug')).provider).toBe('granted')

        const grantedPrompt = vi.fn(async () => false)
        await expect(harness.manager.getPermission(
            'Plug',
            'provider',
            'periodically',
            grantedPrompt,
        )).resolves.toBe(true)
        expect(grantedPrompt).not.toHaveBeenCalled()

        const grantedState = harness.getStoredState()!
        expect(grantedState.given).toContain(permissionKeyOf('Plug', 'provider'))
        expect(grantedState.cache).toContainEqual(['hash:script-a_provider', true])
        expect(grantedState.cache).toContainEqual([
            permissionKeyOf('Plug', 'provider') + '_lastGrantTime',
            1_234,
        ])

        await harness.manager.setPreset('Plug', 'provider', 'denied')
        expect((await harness.manager.listStates('Plug')).provider).toBe('denied')

        const deniedPrompt = vi.fn(async () => true)
        await expect(harness.manager.getPermission(
            'Plug',
            'provider',
            'periodically',
            deniedPrompt,
        )).resolves.toBe(false)
        expect(deniedPrompt).not.toHaveBeenCalled()

        await harness.manager.setPreset('Plug', 'provider', 'unset')
        expect((await harness.manager.listStates('Plug')).provider).toBe('unset')

        const answers = [false, true]
        const resumedPrompt = vi.fn(async () => answers.shift()!)
        await expect(harness.manager.getPermission(
            'Plug',
            'provider',
            'periodically',
            resumedPrompt,
        )).resolves.toBe(false)
        await expect(harness.manager.getPermission(
            'Plug',
            'provider',
            'periodically',
            resumedPrompt,
        )).resolves.toBe(true)
        expect(resumedPrompt).toHaveBeenCalledTimes(2)
    })

    it('loads the legacy schema without making periodic runtime denials sticky', async () => {
        const providerKey = permissionKeyOf('Legacy', 'provider')
        const replacerKey = permissionKeyOf('Legacy', 'replacer')
        const sendChatKey = permissionKeyOf('Legacy', 'sendChat')
        const harness = makeHarness({
            given: [],
            denied: [providerKey, replacerKey, sendChatKey],
            cache: [],
        })

        const states = await harness.manager.listStates('Legacy')
        expect(states.provider).toBe('unset')
        expect(states.replacer).toBe('unset')
        expect(states.sendChat).toBe('denied')

        const periodicPrompt = vi.fn(async () => false)
        await expect(harness.manager.getPermission(
            'Legacy',
            'replacer',
            'periodically',
            periodicPrompt,
        )).resolves.toBe(false)
        expect(periodicPrompt).toHaveBeenCalledOnce()

        const nonPeriodicPrompt = vi.fn(async () => true)
        await expect(harness.manager.getPermission(
            'Legacy',
            'replacer',
            false,
            nonPeriodicPrompt,
        )).resolves.toBe(false)
        expect(nonPeriodicPrompt).not.toHaveBeenCalled()
    })

    it('promotes a hash-only grant and removes every observed hash on unset', async () => {
        const dbKey = permissionKeyOf('Plug', 'db')
        const harness = makeHarness({
            given: [],
            denied: [],
            cache: [['hash:script-a_db', true]],
        })
        harness.scripts.set('Plug', 'script-a')

        expect((await harness.manager.listStates('Plug')).db).toBe('granted')
        expect(harness.getStoredState()!.given).toContain(dbKey)
        expect(harness.getStoredState()!.cacheKeysByPermission).toContainEqual([
            dbKey,
            ['hash:script-a_db'],
        ])

        harness.scripts.set('Plug', 'script-b')
        expect((await harness.manager.listStates('Plug')).db).toBe('granted')
        await harness.manager.setPreset('Plug', 'db', 'unset')

        harness.scripts.set('Plug', 'script-a')
        expect((await harness.manager.listStates('Plug')).db).toBe('unset')
        expect(harness.getStoredState()!.cache).not.toContainEqual(['hash:script-a_db', true])

        const prompt = vi.fn(async () => false)
        await expect(harness.manager.getPermission('Plug', 'db', false, prompt)).resolves.toBe(false)
        expect(prompt).toHaveBeenCalledOnce()
    })

    it('clears explicit denials in scoped and global resets without prefix collisions', async () => {
        const harness = makeHarness()
        harness.scripts.set('foo', 'foo-script')
        harness.scripts.set('foo_bar', 'bar-script')
        await harness.manager.setPreset('foo', 'provider', 'denied')
        await harness.manager.setPreset('foo_bar', 'provider', 'denied')

        await harness.manager.resetPlugin('foo')
        expect((await harness.manager.listStates('foo')).provider).toBe('unset')
        expect((await harness.manager.listStates('foo_bar')).provider).toBe('denied')

        await harness.manager.resetAll()
        expect(harness.getRemoveCount()).toBe(1)
        expect((await harness.manager.listStates('foo_bar')).provider).toBe('unset')
    })

    it('ignores a dialog answer when a newer unset mutation wins', async () => {
        const harness = makeHarness()
        harness.scripts.set('Plug', 'script-a')
        const answer = deferred<boolean>()
        let dialogOpened = false

        const pending = harness.manager.getPermission('Plug', 'sendChat', false, async () => {
            dialogOpened = true
            return answer.promise
        })
        await waitFor(() => dialogOpened)

        await harness.manager.setPreset('Plug', 'sendChat', 'unset')
        answer.resolve(true)

        await expect(pending).resolves.toBe(false)
        expect((await harness.manager.listStates('Plug')).sendChat).toBe('unset')
        expect(harness.getStoredState()!.given).not.toContain(permissionKeyOf('Plug', 'sendChat'))
        expect(harness.getStoredState()!.cache).not.toContainEqual(['hash:script-a_sendChat', true])
    })

    it('serializes concurrent preset writes in invocation order', async () => {
        const harness = makeHarness()
        harness.scripts.set('Plug', 'script-a')

        const granted = harness.manager.setPreset('Plug', 'db', 'granted')
        const denied = harness.manager.setPreset('Plug', 'db', 'denied')
        await Promise.all([granted, denied])

        expect((await harness.manager.listStates('Plug')).db).toBe('denied')
        expect(harness.getStoredState()!.explicitDenied).toContain(permissionKeyOf('Plug', 'db'))
        expect(harness.getStoredState()!.cache).not.toContainEqual(['hash:script-a_db', true])
    })
})

describe('plugin permission dialog queue', () => {
    it('serializes dialogs for different permissions', async () => {
        const harness = makeHarness()
        harness.scripts.set('A', 'a')
        harness.scripts.set('B', 'b')
        let active = 0
        let maximumActive = 0
        const prompt = async () => {
            active++
            maximumActive = Math.max(maximumActive, active)
            await new Promise(resolve => setTimeout(resolve, 5))
            active--
            return true
        }

        await Promise.all([
            harness.manager.getPermission('A', 'fetchLogs', false, prompt),
            harness.manager.getPermission('B', 'fetchLogs', false, prompt),
        ])
        expect(maximumActive).toBe(1)
    })

    it('rechecks a duplicate under the lock and prompts only once', async () => {
        const harness = makeHarness()
        harness.scripts.set('Plug', 'script-a')
        const prompt = vi.fn(async () => true)

        await expect(Promise.all([
            harness.manager.getPermission('Plug', 'fetchLogs', false, prompt),
            harness.manager.getPermission('Plug', 'fetchLogs', false, prompt),
        ])).resolves.toEqual([true, true])
        expect(prompt).toHaveBeenCalledOnce()
    })

    it('recovers the dialog chain after a prompt throws', async () => {
        const harness = makeHarness()
        harness.scripts.set('A', 'a')
        harness.scripts.set('B', 'b')
        const first = harness.manager.getPermission('A', 'mainDom', false, async () => {
            throw new Error('boom')
        })
        const second = harness.manager.getPermission('B', 'mainDom', false, async () => true)

        await expect(first).rejects.toThrow('boom')
        await expect(second).resolves.toBe(true)
    })

    it('lets granted and explicit-denied fast paths bypass a pending dialog', async () => {
        const harness = makeHarness()
        harness.scripts.set('Pending', 'pending')
        harness.scripts.set('Granted', 'granted')
        harness.scripts.set('Denied', 'denied')
        await harness.manager.setPreset('Granted', 'db', 'granted')
        await harness.manager.setPreset('Denied', 'db', 'denied')

        const answer = deferred<boolean>()
        let dialogOpened = false
        const pending = harness.manager.getPermission('Pending', 'db', false, async () => {
            dialogOpened = true
            return answer.promise
        })
        await waitFor(() => dialogOpened)

        const unexpectedPrompt = vi.fn(async () => true)
        await expect(harness.manager.getPermission(
            'Granted',
            'db',
            'periodically',
            unexpectedPrompt,
        )).resolves.toBe(true)
        await expect(harness.manager.getPermission(
            'Denied',
            'db',
            'periodically',
            unexpectedPrompt,
        )).resolves.toBe(false)
        expect(unexpectedPrompt).not.toHaveBeenCalled()

        answer.resolve(false)
        await expect(pending).resolves.toBe(false)
    })
})

describe('v3 permission wiring', () => {
    it('exports the preset contract and enforces provider denial before invocation', () => {
        const source = readFileSync(join(import.meta.dirname, 'v3.svelte.ts'), 'utf8')
        expect(source).toContain('export async function listPluginPermissionStates(')
        expect(source).toContain('export async function setPluginPermissionPreset(')
        expect(source).toContain('export { pluginPermissionDescList }')

        const providerStart = source.indexOf('pluginV2.providers.set(name')
        const providerEnd = source.indexOf('pluginV2.providerOptions.set(name', providerStart)
        const providerBlock = source.slice(providerStart, providerEnd)
        expect(providerBlock).toContain("const conf = await getPluginPermission(plugin.name, 'provider', 'periodically')")
        expect(providerBlock).toContain('if(!conf)')
        expect(providerBlock).toContain('return { success: false, content: language.permissionDenied }')
        expect(providerBlock.indexOf('if(!conf)')).toBeLessThan(providerBlock.indexOf('return await func'))
    })
})
