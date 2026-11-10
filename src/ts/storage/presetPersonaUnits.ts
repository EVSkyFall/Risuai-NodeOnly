import rfdc from 'rfdc'
import { LLMFormat } from '../model/types'
import type { PromptItem } from '../process/prompt'
import type { botPreset, Database, RisuPersona } from './database.svelte'

const rfdcClone = rfdc({ circles: true })

export function cloneUnitValue<T>(data: T): T {
    if (data === undefined || data === null || typeof data !== 'object') {
        return data
    }
    try {
        return structuredClone(data)
    } catch {
        return rfdcClone(data)
    }
}

export function normalizeJsonForComparison(value: any, seen = new WeakSet<object>()): any {
    if (value === null || value === undefined) return null
    if (typeof value !== 'object') {
        if (typeof value === 'number' && !Number.isFinite(value)) return null
        if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
            return undefined
        }
        return value
    }
    if (value instanceof Date) return value.toISOString()
    if (value instanceof RegExp || value instanceof Error) return {}
    if (seen.has(value)) return null
    seen.add(value)
    if (Array.isArray(value)) {
        const result: any[] = []
        for (const item of value) {
            if (item === undefined) {
                result.push(null)
            } else {
                const normalized = normalizeJsonForComparison(item, seen)
                result.push(normalized === undefined ? null : normalized)
            }
        }
        seen.delete(value)
        return result
    }
    const result: Record<string, any> = {}
    for (const key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
            const propValue = value[key]
            if (propValue !== undefined) {
                const normalized = normalizeJsonForComparison(propValue, seen)
                if (normalized !== undefined) {
                    result[key] = normalized
                }
            }
        }
    }
    seen.delete(value)
    return result
}

function deepEqualNormalizedNodes(a: any, b: any): boolean {
    if (Object.is(a, b)) return true
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
        return false
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false
    if (Array.isArray(a)) {
        if (a.length !== b.length) return false
        for (let i = 0; i < a.length; i++) {
            if (!deepEqualNormalizedNodes(a[i], b[i])) return false
        }
        return true
    }
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    if (keysA.length !== keysB.length) return false
    for (const key of keysA) {
        if (!Object.prototype.hasOwnProperty.call(b, key)) return false
        if (!deepEqualNormalizedNodes(a[key], b[key])) return false
    }
    return true
}

export function normalizedDeepEqual(
    a: unknown,
    b: unknown,
    normalizeValue: (value: any) => any = normalizeJsonForComparison,
): boolean {
    if (a === undefined && b === undefined) return true
    if (a === undefined || b === undefined) return false
    try {
        return deepEqualNormalizedNodes(normalizeValue(a), normalizeValue(b))
    } catch {
        return false
    }
}

function normalizePromptRole(role: unknown): 'user' | 'bot' | 'system' | null {
    if (role === 'user' || role === 'bot' || role === 'system') {
        return role
    }
    if (role === 'assistant' || role === 'char') {
        return 'bot'
    }
    return null
}

function normalizeCacheRole(role: unknown): 'user' | 'assistant' | 'system' | 'all' {
    if (role === 'user' || role === 'assistant' || role === 'system' || role === 'all') {
        return role
    }
    if (role === 'bot' || role === 'char') {
        return 'assistant'
    }
    return 'all'
}

export function normalizePromptTemplate(template: PromptItem[] | null | undefined): PromptItem[] | null {
    if (!Array.isArray(template)) {
        return null
    }
    const normalized = cloneUnitValue(template) as any[]
    for (const item of normalized) {
        if (!item || typeof item !== 'object') {
            continue
        }
        switch (item.type) {
            case 'plain':
            case 'jailbreak':
            case 'cot': {
                item.role = normalizePromptRole(item.role) ?? 'system'
                break
            }
            case 'persona':
            case 'description':
            case 'authornote':
            case 'memory': {
                if (item.role2 !== undefined && item.role2 !== null) {
                    item.role2 = normalizePromptRole(item.role2) ?? 'system'
                }
                break
            }
            case 'cache': {
                item.role = normalizeCacheRole(item.role)
                break
            }
        }
    }
    return normalized as PromptItem[]
}

/**
 * Per-entry defaults boot applies to each `botPresets` entry in `setDatabase`
 * (`localNetworkMode`, `localNetworkTimeoutSec`, prompt-template normalisation,
 * legacy string `openrouterProvider`). Does NOT mint an `id`.
 */
export function applyBotPresetEntryDefaults<T extends Partial<botPreset>>(preset: T): T {
    if (!preset || typeof preset !== 'object') return preset
    if (Array.isArray(preset.promptTemplate)) {
        preset.promptTemplate = normalizePromptTemplate(preset.promptTemplate) ?? undefined
    }
    if (typeof preset.openrouterProvider === 'string') {
        const oldProvider = preset.openrouterProvider as unknown as string
        preset.openrouterProvider = {
            order: oldProvider ? [oldProvider] : [],
            only: [],
            ignore: [],
        }
    }
    preset.localNetworkMode ??= false
    preset.localNetworkTimeoutSec ??= 600
    if (typeof preset.localNetworkMode !== 'boolean') {
        preset.localNetworkMode = false
    }
    if (typeof preset.localNetworkTimeoutSec !== 'number' || Number.isNaN(preset.localNetworkTimeoutSec)) {
        preset.localNetworkTimeoutSec = 600
    }
    return preset
}

/**
 * Per-entry defaults boot applies to each `personas` entry (excluding `id`
 * minting, which is never part of per-entry comparison).
 */
export function applyPersonaEntryDefaults<T extends Partial<RisuPersona>>(persona: T): T {
    return persona
}

/**
 * Shared implementation of `setPreset(db, newPres)`.
 */
export function applyPresetToRoot(db: Database, newPres: botPreset): Database {
    db.apiType = newPres.apiType ?? db.apiType
    db.localNetworkMode = newPres.localNetworkMode ?? db.localNetworkMode
    db.localNetworkTimeoutSec = newPres.localNetworkTimeoutSec ?? db.localNetworkTimeoutSec
    db.mainPrompt = newPres.mainPrompt ?? db.mainPrompt
    db.jailbreak = newPres.jailbreak ?? db.jailbreak
    db.globalNote = newPres.globalNote ?? db.globalNote
    db.temperature = newPres.temperature ?? db.temperature
    db.maxContext = newPres.maxContext ?? db.maxContext
    db.maxResponse = newPres.maxResponse ?? db.maxResponse
    db.frequencyPenalty = newPres.frequencyPenalty ?? db.frequencyPenalty
    db.PresensePenalty = newPres.PresensePenalty ?? db.PresensePenalty
    db.formatingOrder = newPres.formatingOrder ?? db.formatingOrder
    db.aiModel = newPres.aiModel ?? db.aiModel
    db.subModel = newPres.subModel ?? db.subModel
    db.subMaxContext = newPres.subMaxContext ?? db.subMaxContext
    db.subMaxResponse = newPres.subMaxResponse ?? db.subMaxResponse
    db.currentPluginProvider = newPres.currentPluginProvider ?? db.currentPluginProvider
    db.textgenWebUIStreamURL = newPres.textgenWebUIStreamURL ?? db.textgenWebUIStreamURL
    db.textgenWebUIBlockingURL = newPres.textgenWebUIBlockingURL ?? db.textgenWebUIBlockingURL
    db.forceReplaceUrl = newPres.forceReplaceUrl ?? db.forceReplaceUrl
    db.promptPreprocess = newPres.promptPreprocess ?? db.promptPreprocess
    db.bias = newPres.bias ?? db.bias
    db.koboldURL = newPres.koboldURL ?? db.koboldURL
    db.proxyKey = newPres.proxyKey ?? db.proxyKey
    db.ooba = cloneUnitValue(newPres.ooba ?? db.ooba)
    db.ainconfig = cloneUnitValue(newPres.ainconfig ?? db.ainconfig)
    db.openrouterRequestModel = newPres.openrouterRequestModel ?? db.openrouterRequestModel
    db.proxyRequestModel = newPres.proxyRequestModel ?? db.proxyRequestModel
    db.NAIsettings = newPres.NAISettings ?? db.NAIsettings
    db.autoSuggestPrompt = newPres.autoSuggestPrompt ?? db.autoSuggestPrompt
    db.autoSuggestPrefix = newPres.autoSuggestPrefix ?? db.autoSuggestPrefix
    db.autoSuggestClean = newPres.autoSuggestClean ?? db.autoSuggestClean
    db.promptTemplate = normalizePromptTemplate(newPres.promptTemplate)
    db.NAIadventure = newPres.NAIadventure
    db.NAIappendName = newPres.NAIappendName
    if (db.NAIsettings) {
        db.NAIsettings.cfg_scale ??= 1
        db.NAIsettings.mirostat_tau ??= 0
        db.NAIsettings.mirostat_lr ??= 1
    }
    db.localStopStrings = newPres.localStopStrings
    db.customProxyRequestModel = newPres.customProxyRequestModel ?? ''
    db.reverseProxyOobaArgs = cloneUnitValue(newPres.reverseProxyOobaArgs) ?? {
        mode: 'instruct',
    }
    db.top_p = newPres.top_p ?? 1
    db.promptSettings = cloneUnitValue(newPres.promptSettings) ?? {
        assistantPrefill: '',
        postEndInnerFormat: '',
        sendChatAsSystem: false,
        sendName: false,
        utilOverride: false,
    }
    db.promptSettings.maxThoughtTagDepth ??= -1
    db.repetition_penalty = newPres.repetition_penalty
    db.min_p = newPres.min_p
    db.top_a = newPres.top_a
    db.openrouterProvider = newPres.openrouterProvider
    db.useInstructPrompt = newPres.useInstructPrompt ?? false
    db.customPromptTemplateToggle = newPres.customPromptTemplateToggle ?? ''
    db.templateDefaultVariables = newPres.templateDefaultVariables ?? ''
    db.moduleIntergration = newPres.moduleIntergration ?? ''
    db.top_k = newPres.top_k ?? db.top_k
    db.instructChatTemplate = newPres.instructChatTemplate ?? db.instructChatTemplate
    db.JinjaTemplate = newPres.JinjaTemplate ?? db.JinjaTemplate
    db.jsonSchemaEnabled = newPres.jsonSchemaEnabled ?? false
    db.jsonSchema = newPres.jsonSchema ?? ''
    db.strictJsonSchema = newPres.strictJsonSchema ?? true
    db.extractJson = newPres.extractJson ?? ''
    db.groupOtherBotRole = newPres.groupOtherBotRole ?? 'user'
    db.groupTemplate = newPres.groupTemplate ?? ''
    db.seperateParametersEnabled = newPres.seperateParametersEnabled ?? false
    db.customAPIFormat = cloneUnitValue(newPres.customAPIFormat) ?? LLMFormat.OpenAICompatible
    db.systemContentReplacement = newPres.systemContentReplacement ?? ''
    db.systemRoleReplacement = newPres.systemRoleReplacement ?? 'user'
    db.customFlags = cloneUnitValue(newPres.customFlags) ?? []
    db.enableCustomFlags = newPres.enableCustomFlags ?? false
    db.presetRegex = newPres.regex ?? []
    db.reasoningEffort = newPres.reasonEffort ?? 0
    db.thinkingTokens = newPres.thinkingTokens ?? null
    db.thinkingType = newPres.thinkingType ?? 'budget'
    db.adaptiveThinkingEffort = newPres.adaptiveThinkingEffort ?? 'high'
    db.outputImageModal = newPres.outputImageModal ?? false
    if (!db.doNotChangeFallbackModels) {
        db.fallbackModels = cloneUnitValue(newPres.fallbackModels) ?? {
            memory: [],
            emotion: [],
            translate: [],
            otherAx: [],
            model: [],
        }
        db.fallbackWhenBlankResponse = newPres.fallbackWhenBlankResponse ?? false
    }
    if (db.disableSeperateParameterChangeOnPresetChange) {
        db.seperateParameters = cloneUnitValue(db.seperateParameters)
    } else {
        db.seperateParameters = newPres.seperateParameters ? cloneUnitValue(newPres.seperateParameters) : {
            memory: {},
            emotion: {},
            translate: {},
            otherAx: {},
            overrides: {},
        }
    }
    db.modelTools = cloneUnitValue(newPres.modelTools ?? [])
    db.verbosity = newPres.verbosity ?? 1
    db.dynamicOutput = newPres.dynamicOutput

    return db
}

/**
 * Shared implementation of the root assignments in `changeUserPersona()`
 * (selection untouched).
 */
export function applyPersonaToRoot(
    db: Pick<Database, 'personaPrompt' | 'username' | 'userIcon' | 'userNote'>,
    pr: Pick<RisuPersona, 'personaPrompt' | 'name' | 'icon' | 'note'>,
): void {
    db.personaPrompt = pr.personaPrompt
    db.username = pr.name
    db.userIcon = pr.icon
    db.userNote = pr.note
}

/**
 * Record every root key written by `setPreset()` against a recording proxy.
 */
export function recordPresetUnitRootKeys(
    presetSetter: (db: Database, preset: botPreset) => Database = applyPresetToRoot,
    flags: { doNotChangeFallbackModels?: boolean, disableSeperateParameterChangeOnPresetChange?: boolean } = {},
): Set<string> {
    const keys = new Set<string>()
    const target: Record<string, any> = {
        doNotChangeFallbackModels: !!flags.doNotChangeFallbackModels,
        disableSeperateParameterChangeOnPresetChange: !!flags.disableSeperateParameterChangeOnPresetChange,
        NAIsettings: {},
    }
    const proxy = new Proxy(target, {
        set(obj, prop, value) {
            if (typeof prop === 'string') keys.add(prop)
            obj[prop as string] = value
            return true
        },
    })
    presetSetter(proxy as unknown as Database, { NAISettings: {} } as unknown as botPreset)
    return keys
}

/**
 * Record every root key written by `changeUserPersona()`'s root assignment
 * against a recording proxy.
 */
export function recordPersonaUnitRootKeys(
    personaSetter: (db: any, pr: any) => void = applyPersonaToRoot,
): Set<string> {
    const keys = new Set<string>()
    const target: Record<string, any> = {}
    const proxy = new Proxy(target, {
        set(obj, prop, value) {
            if (typeof prop === 'string') keys.add(prop)
            obj[prop as string] = value
            return true
        },
    })
    personaSetter(proxy, {})
    return keys
}

let cachedPresetUnitRootKeys: ReadonlySet<string> | null = null
let cachedPersonaUnitRootKeys: ReadonlySet<string> | null = null

export function getPresetUnitRootKeys(): ReadonlySet<string> {
    cachedPresetUnitRootKeys ??= recordPresetUnitRootKeys()
    return cachedPresetUnitRootKeys
}

// Root keys setPreset() writes that saveCurrentPreset() never puts into the
// entry. Nothing carries them from tab to tab but the root itself, so they
// are ordinary shared settings.
const PRESET_KEYS_NOT_STORED_IN_ENTRY: readonly string[] = ['autoSuggestPrefix', 'autoSuggestClean']

/**
 * The root keys that belong to this tab's active preset when databases are
 * merged: the ones a preset switch would overwrite here, given this tab's
 * settings, and that the preset entry carries. With "keep fallback models"
 * or "keep separate parameters" on, a preset switch leaves those keys alone:
 * they are global settings and merge like any other root key.
 */
export function getTabLocalPresetRootKeys(db: {
    doNotChangeFallbackModels?: boolean
    disableSeperateParameterChangeOnPresetChange?: boolean
} | null | undefined): ReadonlySet<string> {
    const keepFallback = !!db?.doNotChangeFallbackModels
    const keepSeparate = !!db?.disableSeperateParameterChangeOnPresetChange
    const keys = new Set(getPresetUnitRootKeys())
    for (const key of PRESET_KEYS_NOT_STORED_IN_ENTRY) keys.delete(key)
    if (keepFallback) {
        // Recorded from the real function, with the setting on.
        const written = recordPresetUnitRootKeys(applyPresetToRoot, { doNotChangeFallbackModels: true })
        for (const key of [...keys]) if (!written.has(key)) keys.delete(key)
    }
    // With the setting on, the function assigns the key its own value.
    if (keepSeparate) keys.delete('seperateParameters')
    return keys
}

export function getPersonaUnitRootKeys(): ReadonlySet<string> {
    cachedPersonaUnitRootKeys ??= recordPersonaUnitRootKeys()
    return cachedPersonaUnitRootKeys
}

export function captureUnitRootObject(source: Record<string, any> | null | undefined, keys: Iterable<string>): Record<string, any> {
    const out: Record<string, any> = {}
    if (!source || typeof source !== 'object') return out
    for (const key of keys) {
        const val = source[key]
        if (val !== undefined) {
            out[key] = normalizeJsonForComparison(val)
        }
    }
    return out
}

function isNullish(val: unknown): boolean {
    return val === undefined || val === null
}

export function captureRawUnitPresence(rawDb: Record<string, any> | null | undefined): Record<string, boolean | null> | null {
    if (!rawDb || typeof rawDb !== 'object') return null
    const presence: Record<string, boolean | null> = {}
    for (const key of getPresetUnitRootKeys()) {
        presence[key] = isNullish(rawDb[key]) ? null : true
    }
    for (const key of getPersonaUnitRootKeys()) {
        presence[key] = isNullish(rawDb[key]) ? null : true
    }
    return presence
}

// A copy of what applyPresetToRoot / applyPersonaToRoot read and write: the
// unit's keys and the two settings that steer a preset switch. (A copy of the
// whole database, lorebooks and all, is not needed for that.)
function unitRootCopy(db: Database, unitKeys: Iterable<string>): Database {
    const source = db as unknown as Record<string, unknown>
    const picked: Record<string, unknown> = {
        doNotChangeFallbackModels: source.doNotChangeFallbackModels,
        disableSeperateParameterChangeOnPresetChange: source.disableSeperateParameterChangeOnPresetChange,
    }
    for (const key of unitKeys) {
        if (source[key] !== undefined) picked[key] = source[key]
    }
    return cloneUnitValue(picked) as unknown as Database
}

function computePresetBootDirty(
    db: Database,
    rawPreDefaultDb?: Record<string, any> | null,
    defaultRoot?: Record<string, any> | null,
): boolean {
    if (!Array.isArray(db.botPresets) || typeof db.botPresetsId !== 'number' || db.botPresetsId < 0) {
        return false
    }
    const selected = db.botPresets[db.botPresetsId]
    if (!selected) return false

    const unitKeys = getPresetUnitRootKeys()
    const currentUnit = captureUnitRootObject(db as any, unitKeys)

    const cloneWithSelected = unitRootCopy(db, unitKeys)
    applyPresetToRoot(cloneWithSelected, cloneUnitValue(selected))
    const appliedSelectedUnit = captureUnitRootObject(cloneWithSelected as any, unitKeys)

    if (deepEqualNormalizedNodes(currentUnit, appliedSelectedUnit)) {
        return false
    }

    const cloneWithEmpty = unitRootCopy(db, unitKeys)
    applyPresetToRoot(cloneWithEmpty, { NAISettings: selected.NAISettings ? {} : undefined } as unknown as botPreset)
    const appliedEmptyUnit = captureUnitRootObject(cloneWithEmpty as any, unitKeys)
    const defaultUnit = defaultRoot ? captureUnitRootObject(defaultRoot, unitKeys) : null

    const allDiffKeys = new Set([...Object.keys(currentUnit), ...Object.keys(appliedSelectedUnit)])
    for (const key of allDiffKeys) {
        const curVal = currentUnit[key]
        const selVal = appliedSelectedUnit[key]
        if (curVal === undefined && selVal === undefined) continue
        if (curVal !== undefined && selVal !== undefined && deepEqualNormalizedNodes(curVal, selVal)) continue

        // A key missing/null in raw server storage before boot defaults was filled
        // by setDatabase(), not left as an unmirrored user edit in root.
        if (rawPreDefaultDb && isNullish(rawPreDefaultDb[key])) {
            continue
        }

        // An entry leaving a field undefined causes setPreset() to emit its
        // empty-entry fallback (e.g. '' vs setDatabase's 'system: {{slot}}').
        // When root merely holds setDatabase({})'s boot default, that is not an edit.
        const empVal = appliedEmptyUnit[key]
        const sameAsEmptyEntry = (selVal === undefined && empVal === undefined)
            || (selVal !== undefined && empVal !== undefined && deepEqualNormalizedNodes(selVal, empVal))
        if (sameAsEmptyEntry && defaultUnit) {
            const defVal = defaultUnit[key]
            const sameAsDefaultRoot = (curVal === undefined && defVal === undefined)
                || (curVal !== undefined && defVal !== undefined && deepEqualNormalizedNodes(curVal, defVal))
            if (sameAsDefaultRoot) {
                continue
            }
        }

        return true
    }

    return false
}

function computePersonaBootDirty(
    db: Database,
    rawPreDefaultDb?: Record<string, any> | null,
    defaultRoot?: Record<string, any> | null,
): boolean {
    if (!Array.isArray(db.personas) || typeof db.selectedPersona !== 'number' || db.selectedPersona < 0) {
        return false
    }
    const selected = db.personas[db.selectedPersona]
    if (!selected) return false

    const unitKeys = getPersonaUnitRootKeys()
    const currentUnit = captureUnitRootObject(db as any, unitKeys)

    const cloneWithSelected = unitRootCopy(db, unitKeys)
    applyPersonaToRoot(cloneWithSelected, selected)
    const appliedSelectedUnit = captureUnitRootObject(cloneWithSelected as any, unitKeys)

    if (deepEqualNormalizedNodes(currentUnit, appliedSelectedUnit)) {
        return false
    }

    const cloneWithEmpty = unitRootCopy(db, unitKeys)
    applyPersonaToRoot(cloneWithEmpty, {} as RisuPersona)
    const appliedEmptyUnit = captureUnitRootObject(cloneWithEmpty as any, unitKeys)
    const defaultUnit = defaultRoot ? captureUnitRootObject(defaultRoot, unitKeys) : null

    const allDiffKeys = new Set([...Object.keys(currentUnit), ...Object.keys(appliedSelectedUnit)])
    for (const key of allDiffKeys) {
        const curVal = currentUnit[key]
        const selVal = appliedSelectedUnit[key]
        if (curVal === undefined && selVal === undefined) continue
        if (curVal !== undefined && selVal !== undefined && deepEqualNormalizedNodes(curVal, selVal)) continue

        if (rawPreDefaultDb && isNullish(rawPreDefaultDb[key])) {
            continue
        }

        const empVal = appliedEmptyUnit[key]
        const sameAsEmptyEntry = (selVal === undefined && empVal === undefined)
            || (selVal !== undefined && empVal !== undefined && deepEqualNormalizedNodes(selVal, empVal))
        if (sameAsEmptyEntry && defaultUnit) {
            const defVal = defaultUnit[key]
            const sameAsDefaultRoot = (curVal === undefined && defVal === undefined)
                || (curVal !== undefined && defVal !== undefined && deepEqualNormalizedNodes(curVal, defVal))
            if (sameAsDefaultRoot) {
                continue
            }
        }

        return true
    }

    return false
}

/**
 * Per-tab working-unit snapshot & dirty-entry tracker for prompt presets and personas.
 */
export class UnitSyncState {
    private ownerDb: object | null = null
    private presetSnapshot: Record<string, any> | null = null
    private personaSnapshot: Record<string, any> | null = null
    private presetBootDirty = false
    private personaBootDirty = false
    private readonly dirtyPresetIds = new Set<string>()
    private readonly dirtyPersonaIds = new Set<string>()

    initAtBoot(
        db: Database,
        rawPreDefaultDb?: Record<string, any> | null,
        defaultRoot?: Record<string, any> | null,
    ): void {
        if (!db || typeof db !== 'object') return
        this.ownerDb = db
        this.presetSnapshot = captureUnitRootObject(db as any, getPresetUnitRootKeys())
        this.personaSnapshot = captureUnitRootObject(db as any, getPersonaUnitRootKeys())
        this.presetBootDirty = computePresetBootDirty(db, rawPreDefaultDb, defaultRoot)
        this.personaBootDirty = computePersonaBootDirty(db, rawPreDefaultDb, defaultRoot)
    }

    reset(): void {
        this.ownerDb = null
        this.presetSnapshot = null
        this.personaSnapshot = null
        this.presetBootDirty = false
        this.personaBootDirty = false
        this.dirtyPresetIds.clear()
        this.dirtyPersonaIds.clear()
    }

    hasSnapshotsFor(db: object | null | undefined): boolean {
        return !!db && this.ownerDb === db && this.presetSnapshot !== null && this.personaSnapshot !== null
    }

    rebindOwnerDb(prevDb: object | null | undefined, nextDb: object | null | undefined): void {
        if (prevDb && nextDb && this.ownerDb === prevDb) {
            this.ownerDb = nextDb
        }
    }

    retakePresetSnapshot(db: Database): void {
        if (!db || typeof db !== 'object') return
        this.ownerDb = db
        this.presetSnapshot = captureUnitRootObject(db as any, getPresetUnitRootKeys())
        if (this.personaSnapshot === null) {
            this.personaSnapshot = captureUnitRootObject(db as any, getPersonaUnitRootKeys())
        }
        this.presetBootDirty = false
    }

    retakePersonaSnapshot(db: Database): void {
        if (!db || typeof db !== 'object') return
        this.ownerDb = db
        this.personaSnapshot = captureUnitRootObject(db as any, getPersonaUnitRootKeys())
        if (this.presetSnapshot === null) {
            this.presetSnapshot = captureUnitRootObject(db as any, getPresetUnitRootKeys())
        }
        this.personaBootDirty = false
    }

    isPresetDirty(db: Database): boolean {
        if (!this.hasSnapshotsFor(db)) {
            return true
        }
        if (this.presetBootDirty) {
            return true
        }
        const current = captureUnitRootObject(db as any, getPresetUnitRootKeys())
        return !deepEqualNormalizedNodes(current, this.presetSnapshot!)
    }

    isPersonaDirty(db: Database): boolean {
        if (!this.hasSnapshotsFor(db)) {
            return true
        }
        if (this.personaBootDirty) {
            return true
        }
        const current = captureUnitRootObject(db as any, getPersonaUnitRootKeys())
        return !deepEqualNormalizedNodes(current, this.personaSnapshot!)
    }

    markPresetDirtyId(id: string | undefined | null): void {
        if (typeof id === 'string' && id.length > 0) {
            this.dirtyPresetIds.add(id)
        }
    }

    markPersonaDirtyId(id: string | undefined | null): void {
        if (typeof id === 'string' && id.length > 0) {
            this.dirtyPersonaIds.add(id)
        }
    }

    peekDirtyPresetIds(): ReadonlySet<string> {
        return this.dirtyPresetIds
    }

    peekDirtyPersonaIds(): ReadonlySet<string> {
        return this.dirtyPersonaIds
    }

    takeDirtyPresetIds(): Set<string> {
        const taken = new Set(this.dirtyPresetIds)
        this.dirtyPresetIds.clear()
        return taken
    }

    takeDirtyPersonaIds(): Set<string> {
        const taken = new Set(this.dirtyPersonaIds)
        this.dirtyPersonaIds.clear()
        return taken
    }

    requeueDirtyPresetIds(ids: Iterable<string>): void {
        for (const id of ids) {
            if (typeof id === 'string' && id.length > 0) this.dirtyPresetIds.add(id)
        }
    }

    requeueDirtyPersonaIds(ids: Iterable<string>): void {
        for (const id of ids) {
            if (typeof id === 'string' && id.length > 0) this.dirtyPersonaIds.add(id)
        }
    }
}

export const liveUnitSyncState = new UnitSyncState()
