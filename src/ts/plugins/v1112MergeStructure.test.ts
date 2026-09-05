import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { pluginPermissionDescList } from './apiV3/pluginPermissionState'
import { wantsFullPluginStorage } from './pluginDbProxy'

vi.mock('./pluginStorageStore', () => ({}))

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('v1.11.2 policy structure', () => {
    test('the V3-only bootstrap has no unconditional custom value preload', () => {
        const bootstrap = source('src/ts/bootstrap.ts')
        const plugins = source('src/ts/plugins/plugins.svelte.ts')
        const load = plugins.slice(plugins.indexOf('export async function loadPlugins'), plugins.indexOf('export const allowedDbKeys'))
        expect(bootstrap).not.toMatch(/initPluginKvStorage|pluginCustomKv\.init|preloadAll|snapshotAll|getPluginStorageAll/)
        expect(bootstrap).toContain('await pluginBlobKv.init()')
        expect(load).toMatch(/await pluginStorageStore\.init\(\)/)
        expect(load.match(/preloadAll\(/g)).toHaveLength(1)
        expect(load).toMatch(/if \(v2PluginList\.length > 0\) await pluginStorageStore\.preloadAll\(\)/)
        expect(load).toContain('await loadV2Plugin(v2PluginList)')
        expect(load).not.toContain('loadV2Plugin([])')
    })

    test('full storage is user opt-in and snapshots only enter the detached plugin response', () => {
        const plugins = source('src/ts/plugins/plugins.svelte.ts')
        const allowedKeys = plugins.slice(plugins.indexOf('export const allowedDbKeys'), plugins.indexOf('export const getV2PluginAPIs'))
        expect(allowedKeys).toContain('PLUGIN_CUSTOM_STORAGE_KEY')
        expect(wantsFullPluginStorage(undefined)).toBe(false)
        expect(wantsFullPluginStorage({})).toBe(false)
        expect(wantsFullPluginStorage({ nodeOnlyFullStorageAccess: true })).toBe(true)
        const v3 = source('src/ts/plugins/apiV3/v3.svelte.ts')
        const read = v3.slice(v3.indexOf('getDatabase: async'), v3.indexOf('installPlugin: handlePluginInstallViaPlugin'))
        expect(read).toContain('if (PLUGIN_CUSTOM_STORAGE_KEY in liteDB)')
        expect(read).toContain('const configuredPlugin = DBState.db.plugins.find(')
        expect(read).toContain('entry.installId === plugin.installId')
        expect(read).toContain('if (wantsFullPluginStorage(configuredPlugin))')
        expect(read).toContain('(liteDB as any)[PLUGIN_CUSTOM_STORAGE_KEY] = await pluginStorageStore.snapshotAll()')
        expect(read).not.toMatch(/(?:DBState\.db|db)\[PLUGIN_CUSTOM_STORAGE_KEY\]\s*=/)
        expect(read).toContain('includeOnly.includes(key)')
    })

    test('inlay extends the existing permission preset manager', () => {
        expect(pluginPermissionDescList).toEqual(['fetchLogs', 'db', 'mainDom', 'replacer', 'provider', 'sendChat', 'inlay'])
        const v3 = source('src/ts/plugins/apiV3/v3.svelte.ts')
        expect(v3).toContain("getPluginPermission(plugin.name, 'inlay', 'periodically')")
        expect(v3).toContain('pluginPermissionManager.getPermission(')
        expect(v3).not.toContain('const permissionDeniedPlugins: Set<string>')
    })

    test('images cannot acquire blanket plugin logging and the factory bridge is retained', () => {
        const plugins = source('src/ts/plugins/plugins.svelte.ts')
        const v3 = source('src/ts/plugins/apiV3/v3.svelte.ts')
        const images = source('src/ts/process/stableDiff.ts')
        expect(plugins).not.toContain('withPluginFetchLog')
        expect(v3).not.toMatch(/logCategory:\s*'other'/)
        expect(images).not.toMatch(/logCategory|recordRequestLog|describeFormData/)
        const factory = source('src/ts/plugins/apiV3/factory.ts')
        expect(factory).not.toMatch(/replaceStreamsWithPorts|reconstructStreamsFromPorts|portIndex|Original request:|Original response:/)
        const guest = factory.slice(factory.indexOf('function collectTransferables'))
        expect(guest.slice(0, guest.indexOf('return transferables'))).toContain('ReadableStream')
        expect(factory).toContain("'screen-wake-lock'")
        expect(factory).toContain('rejectPendingCallbacks')
    })

    test('server patching recomputes hashes and clones fully while rebase uses latestDb', () => {
        const server = source('server/node/server.cjs')
        expect(server).not.toMatch(/require\('\.\/patch-(hash-cache|selective-clone)\.cjs'\)|databasePatchHashCache|clonePatchSnapshot/)
        expect(server).toContain('const snapshot = structuredClone(dbCache[filePath])')
        expect(server).toContain('const next = result.newDocument')
        const save = source('src/ts/globalApi.svelte.ts')
        expect(save).toContain('await patcher.init(latestDb)')
        expect(save).not.toContain('patcher.init(mergedBaseline)')
        expect(save).toContain('activeSavePatcher?.updateAssetManifestBaseline(')
    })
})
