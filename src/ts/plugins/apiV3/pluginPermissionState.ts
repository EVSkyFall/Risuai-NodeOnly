export const pluginPermissionDescList = [
    'fetchLogs',
    'db',
    'mainDom',
    'replacer',
    'provider',
    'sendChat',
] as const

export type PluginPermissionDesc = (typeof pluginPermissionDescList)[number]
export type PluginPermissionPresetState = 'granted' | 'denied' | 'unset'
export type PluginPermissionReconfirm = boolean | 'periodically'

type PermissionCacheValue = boolean | number

export type PersistedPluginPermissionState = {
    given?: string[]
    denied?: string[]
    cache?: [string, PermissionCacheValue][]
    explicitDenied?: string[]
    cacheKeysByPermission?: [string, string[]][]
}

export type PluginPermissionManagerDependencies = {
    readState: () => Promise<PersistedPluginPermissionState | null>
    writeState: (state: PersistedPluginPermissionState) => Promise<void>
    removeState: () => Promise<void>
    getPluginScript: (pluginName: string) => string | undefined
    hashPluginScript: (script: string | undefined) => Promise<string>
    now?: () => number
}

type PermissionResolution = {
    resolved: boolean
    value: boolean
    pluginHash: string
    promoted: boolean
}

// These descriptors use the runtime's deliberately non-sticky denial policy.
// `replacer` also has one legacy non-periodic call site; preset state follows
// the descriptor-level periodic policy from the settings contract, while the
// two runtime call modes retain their existing behavior.
const periodicallyReconfirmedPermissions = new Set<PluginPermissionDesc>([
    'provider',
    'replacer',
    'db',
])

const permissionKeyOf = (pluginName: string, permissionDesc: PluginPermissionDesc) =>
    JSON.stringify([pluginName, permissionDesc])

export function createPluginPermissionManager(deps: PluginPermissionManagerDependencies) {
    const permissionGivenPlugins = new Set<string>()
    const permissionDeniedPlugins = new Set<string>()
    const permissionExplicitDenied = new Set<string>()
    const permissionCache = new Map<string, PermissionCacheValue>()
    const cacheKeysByPermission = new Map<string, Set<string>>()
    const permissionRevisions = new Map<string, number>()
    const now = deps.now ?? Date.now

    let resetRevision = 0
    let loadPromise: Promise<void> | null = null
    let mutationChain: Promise<unknown> = Promise.resolve()
    // All plugins share one alert surface, so permission prompts must never overlap.
    let dialogChain: Promise<unknown> = Promise.resolve()

    const enqueueMutation = <T>(operation: () => Promise<T>): Promise<T> => {
        const run = mutationChain.catch(() => {}).then(operation)
        mutationChain = run.catch(() => {})
        return run
    }

    const ensureLoaded = async () => {
        if (!loadPromise) {
            loadPromise = (async () => {
                const payload = await deps.readState()
                if (!payload) {
                    return
                }

                permissionGivenPlugins.clear()
                permissionDeniedPlugins.clear()
                permissionExplicitDenied.clear()
                permissionCache.clear()
                cacheKeysByPermission.clear()

                for (const key of payload.given ?? []) {
                    permissionGivenPlugins.add(key)
                }
                for (const key of payload.denied ?? []) {
                    permissionDeniedPlugins.add(key)
                }
                for (const key of payload.explicitDenied ?? []) {
                    permissionExplicitDenied.add(key)
                }
                for (const [key, value] of payload.cache ?? []) {
                    permissionCache.set(key, value)
                }
                for (const [permissionKey, cacheKeys] of payload.cacheKeysByPermission ?? []) {
                    cacheKeysByPermission.set(permissionKey, new Set(cacheKeys))
                }
            })()
        }
        await loadPromise
    }

    const persist = async () => {
        await deps.writeState({
            given: [...permissionGivenPlugins],
            denied: [...permissionDeniedPlugins],
            cache: [...permissionCache.entries()],
            explicitDenied: [...permissionExplicitDenied],
            cacheKeysByPermission: [...cacheKeysByPermission.entries()]
                .map(([permissionKey, cacheKeys]) => [permissionKey, [...cacheKeys]]),
        })
    }

    const revisionOf = (permissionKey: string) => ({
        reset: resetRevision,
        permission: permissionRevisions.get(permissionKey) ?? 0,
    })

    const revisionMatches = (
        permissionKey: string,
        revision: ReturnType<typeof revisionOf>,
    ) => revision.reset === resetRevision
        && revision.permission === (permissionRevisions.get(permissionKey) ?? 0)

    const bumpPermissionRevision = (permissionKey: string) => {
        permissionRevisions.set(permissionKey, (permissionRevisions.get(permissionKey) ?? 0) + 1)
    }

    const rememberCacheKey = (permissionKey: string, pluginHash: string) => {
        let cacheKeys = cacheKeysByPermission.get(permissionKey)
        if (!cacheKeys) {
            cacheKeys = new Set()
            cacheKeysByPermission.set(permissionKey, cacheKeys)
        }
        cacheKeys.add(pluginHash)
    }

    const clearPermissionCache = (
        permissionKey: string,
        currentPluginHash?: string,
    ) => {
        for (const cacheKey of cacheKeysByPermission.get(permissionKey) ?? []) {
            permissionCache.delete(cacheKey)
        }
        cacheKeysByPermission.delete(permissionKey)
        if (currentPluginHash) {
            permissionCache.delete(currentPluginHash)
        }
        permissionCache.delete(permissionKey + '_lastGrantTime')
    }

    const pluginHashOf = async (
        pluginName: string,
        permissionDesc: PluginPermissionDesc,
    ) => `${await deps.hashPluginScript(deps.getPluginScript(pluginName))}_${permissionDesc}`

    const resolvePermission = async (
        pluginName: string,
        permissionDesc: PluginPermissionDesc,
        requiresReconfirm: boolean,
    ): Promise<PermissionResolution> => {
        const permissionKey = permissionKeyOf(pluginName, permissionDesc)
        if (permissionExplicitDenied.has(permissionKey)) {
            return { resolved: true, value: false, pluginHash: '', promoted: false }
        }
        if (!requiresReconfirm && permissionGivenPlugins.has(permissionKey)) {
            return { resolved: true, value: true, pluginHash: '', promoted: false }
        }
        if (!requiresReconfirm && permissionDeniedPlugins.has(permissionKey)) {
            return { resolved: true, value: false, pluginHash: '', promoted: false }
        }

        const pluginHash = await pluginHashOf(pluginName, permissionDesc)
        if (!requiresReconfirm && permissionCache.get(pluginHash)) {
            permissionGivenPlugins.add(permissionKey)
            rememberCacheKey(permissionKey, pluginHash)
            bumpPermissionRevision(permissionKey)
            return { resolved: true, value: true, pluginHash, promoted: true }
        }

        return { resolved: false, value: false, pluginHash, promoted: false }
    }

    const resolveAndPersistPromotion = async (
        pluginName: string,
        permissionDesc: PluginPermissionDesc,
        requiresReconfirm: boolean,
    ) => {
        const resolution = await resolvePermission(pluginName, permissionDesc, requiresReconfirm)
        if (resolution.promoted) {
            await persist()
        }
        return resolution
    }

    const resetAll = () => enqueueMutation(async () => {
        await ensureLoaded()
        permissionGivenPlugins.clear()
        permissionDeniedPlugins.clear()
        permissionExplicitDenied.clear()
        permissionCache.clear()
        cacheKeysByPermission.clear()
        permissionRevisions.clear()
        resetRevision++
        loadPromise = Promise.resolve()
        await deps.removeState()
    })

    const resetPlugin = (pluginName: string) => enqueueMutation(async () => {
        await ensureLoaded()
        const script = deps.getPluginScript(pluginName)
        const scriptHash = script ? await deps.hashPluginScript(script) : null

        for (const permissionDesc of pluginPermissionDescList) {
            const permissionKey = permissionKeyOf(pluginName, permissionDesc)
            permissionGivenPlugins.delete(permissionKey)
            permissionDeniedPlugins.delete(permissionKey)
            permissionExplicitDenied.delete(permissionKey)
            clearPermissionCache(
                permissionKey,
                scriptHash ? `${scriptHash}_${permissionDesc}` : undefined,
            )
            bumpPermissionRevision(permissionKey)
        }

        // Clear legacy name-only entries without prefix matching another plugin.
        permissionGivenPlugins.delete(pluginName)
        permissionDeniedPlugins.delete(pluginName)
        await persist()
    })

    const listStates = (pluginName: string) => enqueueMutation(async () => {
        await ensureLoaded()
        const scriptHash = await deps.hashPluginScript(deps.getPluginScript(pluginName))
        const states = {} as Record<PluginPermissionDesc, PluginPermissionPresetState>
        let promoted = false

        for (const permissionDesc of pluginPermissionDescList) {
            const permissionKey = permissionKeyOf(pluginName, permissionDesc)
            if (permissionExplicitDenied.has(permissionKey)) {
                states[permissionDesc] = 'denied'
                continue
            }
            if (permissionGivenPlugins.has(permissionKey)) {
                states[permissionDesc] = 'granted'
                continue
            }
            if (permissionDeniedPlugins.has(permissionKey)) {
                states[permissionDesc] = periodicallyReconfirmedPermissions.has(permissionDesc)
                    ? 'unset'
                    : 'denied'
                continue
            }

            const pluginHash = `${scriptHash}_${permissionDesc}`
            if (permissionCache.get(pluginHash)) {
                permissionGivenPlugins.add(permissionKey)
                rememberCacheKey(permissionKey, pluginHash)
                bumpPermissionRevision(permissionKey)
                states[permissionDesc] = 'granted'
                promoted = true
                continue
            }
            states[permissionDesc] = 'unset'
        }

        if (promoted) {
            await persist()
        }
        return states
    })

    const setPreset = (
        pluginName: string,
        permissionDesc: PluginPermissionDesc,
        state: PluginPermissionPresetState,
    ) => enqueueMutation(async () => {
        await ensureLoaded()
        const permissionKey = permissionKeyOf(pluginName, permissionDesc)
        const pluginHash = await pluginHashOf(pluginName, permissionDesc)

        if (state === 'granted') {
            permissionGivenPlugins.add(permissionKey)
            permissionDeniedPlugins.delete(permissionKey)
            permissionExplicitDenied.delete(permissionKey)
            permissionCache.set(pluginHash, true)
            rememberCacheKey(permissionKey, pluginHash)
            if (periodicallyReconfirmedPermissions.has(permissionDesc)) {
                permissionCache.set(permissionKey + '_lastGrantTime', now())
            }
        }
        else if (state === 'denied') {
            permissionGivenPlugins.delete(permissionKey)
            permissionDeniedPlugins.add(permissionKey)
            permissionExplicitDenied.add(permissionKey)
            clearPermissionCache(permissionKey, pluginHash)
        }
        else {
            permissionGivenPlugins.delete(permissionKey)
            permissionDeniedPlugins.delete(permissionKey)
            permissionExplicitDenied.delete(permissionKey)
            clearPermissionCache(permissionKey, pluginHash)
        }

        bumpPermissionRevision(permissionKey)
        await persist()
    })

    const getPermission = async (
        pluginName: string,
        permissionDesc: PluginPermissionDesc,
        reconfirm: PluginPermissionReconfirm = false,
        requestPermission: () => Promise<boolean>,
    ) => {
        await ensureLoaded()
        const permissionKey = permissionKeyOf(pluginName, permissionDesc)
        // In this fork, "periodically" keeps grants permanent but deliberately
        // bypasses ordinary runtime denials so the next call asks again.
        const computeRequiresReconfirm = () => {
            if (reconfirm === 'periodically') {
                return !permissionGivenPlugins.has(permissionKey)
            }
            return reconfirm === true
        }

        const early = await enqueueMutation(() => resolveAndPersistPromotion(
            pluginName,
            permissionDesc,
            computeRequiresReconfirm(),
        ))
        if (early.resolved) {
            return early.value
        }

        const showDialog = async (): Promise<boolean> => {
            const recheck = await enqueueMutation(() => resolveAndPersistPromotion(
                pluginName,
                permissionDesc,
                computeRequiresReconfirm(),
            ))
            if (recheck.resolved) {
                return recheck.value
            }

            const pluginHash = recheck.pluginHash
            const revision = revisionOf(permissionKey)
            const confirmed = await requestPermission()

            return enqueueMutation(async () => {
                if (!revisionMatches(permissionKey, revision)) {
                    if (permissionExplicitDenied.has(permissionKey)) {
                        return false
                    }
                    if (!computeRequiresReconfirm() && permissionGivenPlugins.has(permissionKey)) {
                        return true
                    }
                    if (!computeRequiresReconfirm() && permissionDeniedPlugins.has(permissionKey)) {
                        return false
                    }
                    return false
                }

                if (confirmed && pluginHash) {
                    permissionGivenPlugins.add(permissionKey)
                    permissionDeniedPlugins.delete(permissionKey)
                    permissionExplicitDenied.delete(permissionKey)
                    permissionCache.set(pluginHash, true)
                    rememberCacheKey(permissionKey, pluginHash)
                    if (reconfirm === 'periodically') {
                        permissionCache.set(permissionKey + '_lastGrantTime', now())
                    }
                    bumpPermissionRevision(permissionKey)
                    await persist()
                    return true
                }

                permissionDeniedPlugins.add(permissionKey)
                bumpPermissionRevision(permissionKey)
                await persist()
                return false
            })
        }

        const run = dialogChain.catch(() => {}).then(showDialog)
        dialogChain = run.catch(() => {})
        return run
    }

    return {
        getPermission,
        listStates,
        resetAll,
        resetPlugin,
        setPreset,
    }
}
