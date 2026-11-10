import type { Database } from './database.svelte'
import type { toSaveType } from './risuSave'
import {
    applyBotPresetEntryDefaults,
    applyPersonaEntryDefaults,
    applyPersonaToRoot,
    applyPresetToRoot,
    getPersonaUnitRootKeys,
    getPresetUnitRootKeys,
    getTabLocalPresetRootKeys,
    normalizedDeepEqual,
    normalizeJsonForComparison,
} from './presetPersonaUnits'
import { didChatStubFieldsChange, isChatStub, mergeChatStubFieldsOnto, projectChatStub } from './chatStub'
import { reanchorChatPage, reanchorPersonaIndex, reanchorPresetIndex } from './rebaseSelection'
import { chatGenKey, isChatGenerating } from '../process/generationState'

export interface RebaseMergeOptions {
    dirtyPresetIds?: ReadonlySet<string>
    dirtyPersonaIds?: ReadonlySet<string>
    isPresetUnitDirty?: boolean
    isPersonaUnitDirty?: boolean
    localSelectedCharIndex?: number
    generatingChatKeys?: ReadonlySet<string>
    knownChatIdsByCharacter?: ReadonlyMap<string, ReadonlySet<string>>
    normalizeCharacter?: (character: any) => any
}

export interface RebaseMergeResult {
    mergedDb: Database
    skippedArchivedCharIds: string[]
    appliedRemoteSelectedPreset: boolean
    appliedRemoteSelectedPersona: boolean
}

const DEFAULT_SD_DATA: [string, string][] = [
    ['always', 'solo, 1girl'],
    ['negative', ''],
    ["|character's appearance", ''],
    ['current situation', ''],
    ["$character's pose", ''],
    ["$character's emotion", ''],
    ['current location', ''],
]

function updateLorebooksPure(book: any[]): any[] {
    return book.map((entry) => {
        if (!entry || typeof entry !== 'object') return entry
        entry.bookVersion ??= 1
        if (entry.bookVersion >= 2) {
            return entry
        }
        if (entry.activationPercent) {
            const perc = entry.activationPercent
            entry.activationPercent = null
            entry.content = `@@probability ${perc}\n${entry.content}`
        }
        if (typeof entry.content === 'string') {
            entry.content = entry.content
                .replace(/@@@?end/g, '@@depth 0')
                .replace(/<(char|bot)>/g, '{{char}}')
                .replace(/<(user)>/g, '{{user}}')
        }
        entry.bookVersion = 2
        return entry
    })
}

function updateInlayScreenPure(char: any): any {
    switch (char.viewScreen) {
        case 'emotion':
            char.newGenData = {
                prompt: '',
                negative: '',
                instructions: '',
                emotionInstructions: char.inlayViewScreen
                    ? `You must always output the character's emotional image as a command at the end of a conversation. The command must be selected from a given list, and it's better to have variety than to repeat images used in previous chats. Use one image, depending on the character's emotion. See the list below. Form: <Emotion="<image command>"> Example: <Emotion="Agree"> List of commands: {{slot}}`
                    : `You must always output the character's emotional image as a command. The command must be selected from a given list, only output the command, depending on the character's emotion. List of commands: {{slot}}`,
            }
            return char
        case 'imggen':
            char.newGenData = {
                prompt: 'best quality, {{slot}}',
                negative: 'worse quality',
                instructions: char.inlayViewScreen
                    ? "You must always output the character's image as a keyword-formatted prompts that can be used in stable diffusion  at the end of a conversation. Use one image, depending on character, place, situation, etc. keyword should be long enough. Form: <ImgGen=\"<keyword-formatted prompt>\">"
                    : "You must always output the character's image as a keyword-formatted prompts that can be used in stable diffusion. only output the that prompt, depending on character, place, situation, etc. keyword should be long enough.",
                emotionInstructions: '',
            }
            return char
        default:
            char.newGenData = {
                prompt: '',
                negative: '',
                instructions: '',
                emotionInstructions: '',
            }
            return char
    }
}

/**
 * Pure detached equivalent of `characterFormatUpdate(character)` used when the
 * caller does not inject `options.normalizeCharacter`.
 */
export function defaultNormalizeCharacter<T extends Record<string, any>>(input: T): T {
    if (!input || typeof input !== 'object') return input
    const cha: Record<string, any> = input
    if (!Array.isArray(cha.chats)) {
        cha.chats = []
    }
    if (cha.chats.length === 0) {
        cha.chats = [{
            message: [],
            note: '',
            name: 'Chat 1',
            localLore: [],
            memoryPresetId: 'default',
        }]
    }
    if (!cha.chats[cha.chatPage]) {
        cha.chatPage = 0
    }
    if (!cha.chats[cha.chatPage].message) {
        cha.chats[cha.chatPage].message = []
    }
    if (!cha.type) {
        cha.type = 'character'
    }
    if (cha.sdData === undefined || cha.sdData === null) {
        cha.sdData = DEFAULT_SD_DATA.map(([k, v]) => [k, v] as [string, string])
    }
    if (cha.utilityBot === undefined || cha.utilityBot === null) {
        cha.utilityBot = false
    }
    cha.triggerscript = cha.triggerscript ?? []
    cha.alternateGreetings = cha.alternateGreetings ?? []
    cha.exampleMessage = cha.exampleMessage ?? ''
    cha.creatorNotes = cha.creatorNotes ?? ''
    cha.systemPrompt = cha.systemPrompt ?? ''
    cha.tags = cha.tags ?? []
    cha.creator = cha.creator ?? ''
    cha.characterVersion = cha.characterVersion ?? ''
    cha.personality = cha.personality ?? ''
    cha.scenario = cha.scenario ?? ''
    cha.firstMsgIndex = cha.firstMsgIndex ?? -1
    cha.additionalData = cha.additionalData ?? {
        tag: [],
        creator: '',
        character_version: '',
    }
    cha.voicevoxConfig = cha.voicevoxConfig ?? {
        SPEED_SCALE: 1,
        PITCH_SCALE: 0,
        INTONATION_SCALE: 1,
        VOLUME_SCALE: 1,
    }
    if (cha.postHistoryInstructions) {
        cha.chats[cha.chatPage].note = `${cha.chats[cha.chatPage].note ?? ''}\n${cha.postHistoryInstructions}`.trim()
        cha.postHistoryInstructions = null
    }
    cha.additionalText ??= ''
    cha.depth_prompt ??= {
        depth: 0,
        prompt: '',
    }
    cha.hfTTS ??= {
        model: '',
        language: 'en',
    }
    cha.backgroundHTML ??= ''
    cha.backgroundCSS ??= ''
    cha.creation_date ??= Date.now()
    cha.globalLore = Array.isArray(cha.globalLore) ? updateLorebooksPure(cha.globalLore) : []
    if (!cha.newGenData) {
        updateInlayScreenPure(cha)
    }
    if (cha.ttsMode === 'none') {
        cha.ttsMode = ''
    }
    cha.ttsMode ??= ''
    if (cha.customscript === undefined || cha.customscript === null) {
        cha.customscript = []
    }
    cha.lastInteraction = Date.now()
    for (let i = 0; i < cha.chats.length; i++) {
        const chat = cha.chats[i]
        if (!chat || typeof chat !== 'object') continue
        chat.fmIndex ??= cha.firstMsgIndex ?? -1
        if (!chat.localLore) {
            chat.localLore = []
        }
    }
    return input
}

export function hasValidUniqueIds(entries: unknown, idKey = 'id'): entries is Record<string, any>[] {
    if (!Array.isArray(entries)) return false
    const seen = new Set<string>()
    for (const entry of entries) {
        const id = entry?.[idKey]
        if (typeof id !== 'string' || id.length === 0) return false
        if (seen.has(id)) return false
        seen.add(id)
    }
    return true
}

function isPlainRecord(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

interface MergeEntriesByIdArgs<T extends Record<string, any>> {
    baseList: T[]
    localList: T[]
    remoteList: T[]
    clone: <V>(value: V) => V
    normalizeValue: (value: any) => any
    dirtyIds?: ReadonlySet<string>
    selectedId?: string
    normalizeEntry?: (entry: T) => T
    preserveManifest?: (kept: T, remote: T | undefined) => void
}

function mergeEntriesById<T extends Record<string, any>>(args: MergeEntriesByIdArgs<T>): {
    merged: T[]
    winnerById: Map<string, 'local' | 'remote'>
} {
    const {
        baseList,
        localList,
        remoteList,
        clone,
        normalizeValue,
        dirtyIds = new Set<string>(),
        selectedId,
        normalizeEntry = (entry) => entry,
        preserveManifest,
    } = args

    const baseById = new Map<string, T>()
    const localById = new Map<string, T>()
    const remoteById = new Map<string, T>()
    for (const e of baseList) baseById.set(e.id, e)
    for (const e of localList) localById.set(e.id, e)
    for (const e of remoteList) remoteById.set(e.id, e)

    const allIds = new Set<string>([
        ...baseById.keys(),
        ...localById.keys(),
        ...remoteById.keys(),
    ])

    const keptById = new Map<string, T>()
    const winnerById = new Map<string, 'local' | 'remote'>()

    const entriesEqual = (a: T, b: T): boolean => {
        return normalizedDeepEqual(
            normalizeEntry(clone(a)),
            normalizeEntry(clone(b)),
            normalizeValue,
        )
    }

    for (const id of allIds) {
        const b = baseById.get(id)
        const l = localById.get(id)
        const r = remoteById.get(id)

        const isLocalWin = !!l && (
            dirtyIds.has(id)
            || !b
            || !entriesEqual(l, b)
        )

        let kept: T | undefined
        let winner: 'local' | 'remote' | undefined

        if (b && l && r) {
            if (isLocalWin) {
                kept = clone(l)
                winner = 'local'
            } else {
                kept = clone(r)
                winner = 'remote'
            }
        } else if (!b && l && !r) {
            kept = clone(l)
            winner = 'local'
        } else if (!b && !l && r) {
            kept = clone(r)
            winner = 'remote'
        } else if (!b && l && r) {
            if (dirtyIds.has(id) || !entriesEqual(l, r)) {
                kept = clone(l)
                winner = 'local'
            } else {
                kept = clone(r)
                winner = 'remote'
            }
        } else if (b && !l && r) {
            // In base, missing locally: drop if remote equals base, else keep remote's.
            if (!entriesEqual(r, b)) {
                kept = clone(r)
                winner = 'remote'
            }
        } else if (b && l && !r) {
            // In base, missing remotely: keep local's if selected or local win, else drop.
            if ((selectedId !== undefined && id === selectedId) || isLocalWin) {
                kept = clone(l)
                winner = 'local'
            }
        }

        if (kept && winner) {
            if (preserveManifest) {
                preserveManifest(kept, r)
            }
            keptById.set(id, kept)
            winnerById.set(id, winner)
        }
    }

    const baseLocalInBase = baseList.map((e) => e.id).filter((id) => localById.has(id))
    const baseLocalInLocal = localList.map((e) => e.id).filter((id) => baseById.has(id))
    const localChangedOrder = baseLocalInBase.some((id, idx) => id !== baseLocalInLocal[idx])

    const baseRemoteInBase = baseList.map((e) => e.id).filter((id) => remoteById.has(id))
    const baseRemoteInRemote = remoteList.map((e) => e.id).filter((id) => baseById.has(id))
    const remoteChangedOrder = baseRemoteInBase.some((id, idx) => id !== baseRemoteInRemote[idx])

    const orderedIds: string[] = (localChangedOrder && !remoteChangedOrder)
        ? [
            ...localList.map((e) => e.id).filter((id) => keptById.has(id)),
            ...remoteList.map((e) => e.id).filter((id) => keptById.has(id) && !localById.has(id)),
        ]
        : [
            ...remoteList.map((e) => e.id).filter((id) => keptById.has(id)),
            ...localList.map((e) => e.id).filter((id) => keptById.has(id) && !remoteById.has(id)),
        ]

    return {
        merged: orderedIds.map((id) => keptById.get(id)!),
        winnerById,
    }
}

function preserveModuleAssetManifest(kept: any, remote: any, clone: <T>(v: T) => T): void {
    if (!kept || typeof kept !== 'object') return
    if (Array.isArray(kept.assets) && kept.assetManifest) {
        delete kept.assetManifest
    }
    if (remote?.assetManifest && !kept.assetManifest && !Array.isArray(kept.assets)) {
        kept.assetManifest = clone(remote.assetManifest)
        delete kept.assets
    }
}

function preservePersonaEmbeddedAssetManifest(kept: any, remote: any, clone: <T>(v: T) => T): void {
    if (!kept || typeof kept !== 'object') return
    if (Array.isArray(kept.embeddedModule?.assets) && kept.embeddedModule?.assetManifest) {
        delete kept.embeddedModule.assetManifest
    }
    const remoteManifest = remote?.embeddedModule?.assetManifest
    if (remoteManifest && !kept.embeddedModule?.assetManifest && !Array.isArray(kept.embeddedModule?.assets)) {
        if (kept.embeddedModule && typeof kept.embeddedModule === 'object') {
            kept.embeddedModule = {
                ...kept.embeddedModule,
                assetManifest: clone(remoteManifest),
            }
            delete kept.embeddedModule.assets
        } else {
            kept.embeddedModule = clone(remote.embeddedModule)
            delete kept.embeddedModule.assets
        }
    }
}

function applyCharacterAssetPairRule(
    mergedChar: any,
    normBase: any,
    localChar: any,
    remoteChar: any,
    clone: <T>(v: T) => T,
    normalizeValue: (v: any) => any,
): void {
    const assetsChanged = !normalizedDeepEqual(localChar?.additionalAssets, normBase?.additionalAssets, normalizeValue)
    const manifestChanged = !normalizedDeepEqual(localChar?.additionalAssetManifest, normBase?.additionalAssetManifest, normalizeValue)
    const takeLocal = assetsChanged || manifestChanged
    const source = takeLocal ? localChar : remoteChar

    let keptAssets = Array.isArray(source?.additionalAssets) ? clone(source.additionalAssets) : undefined
    let keptManifest = source?.additionalAssetManifest ? clone(source.additionalAssetManifest) : undefined

    // Never carry both members.
    if (keptAssets !== undefined && keptManifest !== undefined) {
        if (takeLocal && assetsChanged && !manifestChanged) {
            keptManifest = undefined
        } else {
            keptAssets = undefined
        }
    }

    // Loss-owner rule: if remote has a manifest and the kept pair has neither, take remote's pair.
    if (remoteChar?.additionalAssetManifest && !keptManifest && !Array.isArray(keptAssets)) {
        keptManifest = clone(remoteChar.additionalAssetManifest)
        keptAssets = undefined
    }

    if (keptAssets !== undefined) {
        mergedChar.additionalAssets = keptAssets
    } else {
        delete mergedChar.additionalAssets
    }
    if (keptManifest !== undefined) {
        mergedChar.additionalAssetManifest = keptManifest
    } else {
        delete mergedChar.additionalAssetManifest
    }
}

function didCharacterChangeForDeletion(
    candidateChar: any,
    baseChar: any,
    normalizeChar: (char: any) => any,
    clone: <T>(v: T) => T,
    normalizeValue: (v: any) => any,
): boolean {
    const candidateStubs = (Array.isArray(candidateChar?.chats) ? candidateChar.chats : []).map(projectChatStub)
    const baseStubs = (Array.isArray(baseChar?.chats) ? baseChar.chats : []).map(projectChatStub)
    const baseLacksCreationDate = baseChar?.creation_date === undefined || baseChar?.creation_date === null

    const normCandidate = normalizeChar(clone(candidateChar))
    const normBase = normalizeChar(clone(baseChar))

    delete normCandidate.lastInteraction
    delete normBase.lastInteraction
    delete normCandidate.reloadKeys
    delete normBase.reloadKeys
    delete normCandidate.chatPage
    delete normBase.chatPage
    if (baseLacksCreationDate) {
        delete normCandidate.creation_date
        delete normBase.creation_date
    }

    // Normalize asset representation so an untouched manifest vs absence on one side works cleanly,
    // while real asset additions/edits still register.
    normCandidate.chats = candidateStubs
    normBase.chats = baseStubs

    return !normalizedDeepEqual(normCandidate, normBase, normalizeValue)
}

function mergeCharacterChats(args: {
    baseChar: any | undefined
    localChar: any
    remoteChar: any
    clone: <T>(v: T) => T
    convertChats: (chats: any[]) => any[]
    normalizeValue: (v: any) => any
    isCharSelectedLocally: boolean
    hasExplicitCharSelection: boolean
    generatingChatKeys?: ReadonlySet<string>
    knownChatIds?: ReadonlySet<string>
}): any[] {
    const {
        baseChar,
        localChar,
        remoteChar,
        clone,
        convertChats,
        normalizeValue,
        isCharSelectedLocally,
        hasExplicitCharSelection,
        generatingChatKeys,
        knownChatIds,
    } = args

    const localChats: any[] = Array.isArray(localChar?.chats) ? localChar.chats : []
    const remoteChats: any[] = Array.isArray(remoteChar?.chats) ? remoteChar.chats : []
    const baseChats: any[] = Array.isArray(baseChar?.chats) ? baseChar.chats : []

    const baseById = new Map<string, any>()
    for (const c of baseChats) {
        if (c?.id) baseById.set(c.id, c)
    }
    const remoteById = new Map<string, any>()
    for (const c of remoteChats) {
        if (c?.id) remoteById.set(c.id, c)
    }
    const localIds = new Set<string>()
    for (const c of localChats) {
        if (c?.id) localIds.add(c.id)
    }

    const localOpenChatId = typeof localChar?.chatPage === 'number'
        ? localChats[localChar.chatPage]?.id
        : undefined

    const mergedChats: any[] = []
    for (const localChat of localChats) {
        const chatId = localChat?.id
        if (!chatId) {
            mergedChats.push(clone(localChat))
            continue
        }
        const baseChat = baseById.get(chatId)
        const remoteChat = remoteById.get(chatId)

        if (baseChat && !remoteChat) {
            // Deleted remotely: drop unless open in this tab, generating, or stub fields changed.
            const isOpenHere = hasExplicitCharSelection
                ? (isCharSelectedLocally && localOpenChatId === chatId)
                : (localOpenChatId === chatId && !localChat._placeholder && !isChatStub(localChat) && Array.isArray(localChat.message))
            const genKey = chatGenKey(chatId)
            const isGeneratingHere = isChatGenerating(genKey) || (generatingChatKeys?.has(genKey) ?? false)
            const stubChangedHere = didChatStubFieldsChange(localChat, baseChat, normalizeValue)
            if (!isOpenHere && !isGeneratingHere && !stubChangedHere) {
                continue
            }
            mergedChats.push(clone(localChat))
            continue
        }

        const clonedLocal = clone(localChat)
        if (remoteChat) {
            mergeChatStubFieldsOnto(clonedLocal, baseChat, clonedLocal, remoteChat, clone, normalizeValue)
        }
        mergedChats.push(clonedLocal)
    }

    // Remote-new chats (not in base, not in known, not in local): append converted placeholders.
    const mergedIds = new Set(mergedChats.map((c) => c?.id).filter(Boolean))
    const remoteNew = remoteChats.filter((c) =>
        c?.id
        && !baseById.has(c.id)
        && !(knownChatIds?.has(c.id) ?? false)
        && !localIds.has(c.id)
        && !mergedIds.has(c.id),
    )
    if (remoteNew.length > 0) {
        const convertedRemoteNew = convertChats(clone(remoteNew))
        for (const c of convertedRemoteNew) {
            mergedChats.push(c)
        }
    }

    return mergedChats
}

function mergeOverlaidCharacterWithBase(args: {
    baseChar: any
    localChar: any
    remoteChar: any
    clone: <T>(v: T) => T
    convertChats: (chats: any[]) => any[]
    normalizeValue: (v: any) => any
    normalizeChar: (char: any) => any
    isCharSelectedLocally: boolean
    hasExplicitCharSelection: boolean
    generatingChatKeys?: ReadonlySet<string>
    knownChatIds?: ReadonlySet<string>
}): any {
    const {
        baseChar,
        localChar,
        remoteChar,
        clone,
        convertChats,
        normalizeValue,
        normalizeChar,
        isCharSelectedLocally,
        hasExplicitCharSelection,
        generatingChatKeys,
        knownChatIds,
    } = args

    const mergedChar = clone(remoteChar)
    const normBase = normalizeChar(clone(baseChar))
    const baseLacksCreationDate = baseChar?.creation_date === undefined || baseChar?.creation_date === null

    const specialKeys = new Set<string>([
        'chaId',
        'chats',
        'chatFolders',
        'chatPage',
        'additionalAssets',
        'additionalAssetManifest',
        'lastInteraction',
        'reloadKeys',
    ])
    if (baseLacksCreationDate) {
        specialKeys.add('creation_date')
    }

    const allKeys = new Set<string>([
        ...Object.keys(baseChar ?? {}),
        ...Object.keys(normBase ?? {}),
        ...Object.keys(localChar ?? {}),
        ...Object.keys(remoteChar ?? {}),
    ])

    for (const key of allKeys) {
        if (specialKeys.has(key)) continue
        const localVal = localChar?.[key]
        const matchesNormBase = normalizedDeepEqual(localVal, normBase?.[key], normalizeValue)
        const matchesRawBase = normalizedDeepEqual(localVal, baseChar?.[key], normalizeValue)
        if (!matchesNormBase && !matchesRawBase) {
            if (Object.prototype.hasOwnProperty.call(localChar, key) && localVal !== undefined) {
                mergedChar[key] = clone(localVal)
            } else {
                delete mergedChar[key]
            }
        }
    }

    // Volatile fields: local's if this tab has the character selected, else remote's.
    const volatileKeys = baseLacksCreationDate
        ? ['lastInteraction', 'reloadKeys', 'creation_date']
        : ['lastInteraction', 'reloadKeys']
    const volatileSource = isCharSelectedLocally ? localChar : remoteChar
    for (const vKey of volatileKeys) {
        if (volatileSource && Object.prototype.hasOwnProperty.call(volatileSource, vKey) && volatileSource[vKey] !== undefined) {
            mergedChar[vKey] = clone(volatileSource[vKey])
        } else {
            delete mergedChar[vKey]
        }
    }

    // additionalAssets + additionalAssetManifest move together, never both, with loss-owner protection.
    applyCharacterAssetPairRule(mergedChar, normBase, localChar, remoteChar, clone, normalizeValue)

    // chatFolders merge per folder by id like section 4 (no selection, no dirty set).
    if (
        baseChar?.chatFolders !== undefined
        || localChar?.chatFolders !== undefined
        || remoteChar?.chatFolders !== undefined
    ) {
        const bFolders = baseChar?.chatFolders ?? []
        const lFolders = localChar?.chatFolders ?? []
        const rFolders = remoteChar?.chatFolders ?? []
        if (hasValidUniqueIds(bFolders) && hasValidUniqueIds(lFolders) && hasValidUniqueIds(rFolders)) {
            mergedChar.chatFolders = mergeEntriesById({
                baseList: bFolders,
                localList: lFolders,
                remoteList: rFolders,
                clone,
                normalizeValue,
            }).merged
        } else if (!normalizedDeepEqual(lFolders, bFolders, normalizeValue)) {
            mergedChar.chatFolders = clone(lFolders)
        }
    }

    // Chats merge.
    mergedChar.chats = mergeCharacterChats({
        baseChar,
        localChar,
        remoteChar,
        clone,
        convertChats,
        normalizeValue,
        isCharSelectedLocally,
        hasExplicitCharSelection,
        generatingChatKeys,
        knownChatIds,
    })

    return mergedChar
}

/**
 * Merge the server's latest database with the changes this client still
 * tracks, for the conflict rebase path.
 *
 * When `baselineDb` is present (patch mode):
 * - Tab-local block (preset unit, persona unit, `toggle_*` of `globalChatVariables`,
 *   every character's `chatPage`, and `selectedCharID` via caller) comes from local;
 * - `botPresets`, `personas`, `modules` (when `toSave.modules`), and `chatFolders`
 *   merge per entry by `id`, with asset-manifest loss-owner protection;
 * - Overlaid characters merge per top-level field against `characterFormatUpdate(base)`,
 *   with volatile-field handling, stub-level chat metadata merge, remote chat
 *   deletion propagation, and normalised character deletion symmetry.
 *
 * Without `baselineDb` (non-patch mode), or whenever an array's id precondition
 * fails, falls back to the pre-existing behaviour for that piece only.
 */
export function mergeServerDbWithTrackedLocalChanges(
    latestDb: Database,
    localDbSource: Database,
    toSave: toSaveType,
    clone: <T>(value: T) => T,
    convertChats: (chats: any[]) => any[],
    baselineArchivedIds: ReadonlySet<string> = new Set(),
    baselineDb: Database | null = null,
    normalizeValue?: (value: any) => any,
    options: RebaseMergeOptions = {},
): RebaseMergeResult {
    const mergedDb = clone(latestDb)
    const localDb = clone(localDbSource)

    // ── Non-baseline mode: keep pre-existing behaviour unchanged ─────────────
    if (!baselineDb) {
        for (const key in localDb) {
            if (
                key !== 'characters' && key !== 'botPresets' && key !== 'modules' &&
                key !== 'plugins' && key !== 'pluginCustomStorage' && key !== 'nodeOnlyArchivedCharacters'
            ) {
                ;(mergedDb as any)[key] = clone((localDb as any)[key])
            }
        }

        if (toSave.botPreset) {
            mergedDb.botPresets = clone(localDb.botPresets)
            mergedDb.botPresetsId = localDb.botPresetsId
        }
        if (toSave.plugins) mergedDb.plugins = clone(localDb.plugins)
        if (toSave.modules) {
            mergedDb.modules = clone(localDb.modules)
        }

        const { skippedArchivedCharIds } = mergeCharactersAndArchivesLegacy(
            latestDb,
            localDb,
            mergedDb,
            toSave,
            clone,
            convertChats,
            baselineArchivedIds,
        )
        return {
            mergedDb,
            skippedArchivedCharIds,
            appliedRemoteSelectedPreset: false,
            appliedRemoteSelectedPersona: false,
        }
    }

    // ── Patch-baseline mode ──────────────────────────────────────────────────
    const normFn = normalizeValue ?? normalizeJsonForComparison
    const presetUnitKeys = getTabLocalPresetRootKeys(localDb)
    const personaUnitKeys = getPersonaUnitRootKeys()

    const excludedSharedRootKeys = new Set<string>([
        'characters',
        'botPresets',
        'modules',
        'plugins',
        'pluginCustomStorage',
        'nodeOnlyArchivedCharacters',
        'personas',
        'globalChatVariables',
        'botPresetsId',
        'selectedPersona',
        ...presetUnitKeys,
        ...personaUnitKeys,
    ])

    const candidateSharedKeys = new Set<string>([
        ...Object.keys(localDb),
        ...Object.keys(baselineDb),
    ])
    for (const key of candidateSharedKeys) {
        if (excludedSharedRootKeys.has(key)) continue
        const localHas = Object.prototype.hasOwnProperty.call(localDb, key) && (localDb as any)[key] !== undefined
        const baseHas = Object.prototype.hasOwnProperty.call(baselineDb, key) && (baselineDb as any)[key] !== undefined
        const localChanged = (localHas !== baseHas)
            || (localHas && !normalizedDeepEqual((localDb as any)[key], (baselineDb as any)[key], normFn))
        if (localChanged) {
            if (localHas) {
                ;(mergedDb as any)[key] = clone((localDb as any)[key])
            } else {
                delete (mergedDb as any)[key]
            }
        }
    }

    // ── Section 1: Tab-local units (preset unit, persona unit, toggles) ─────
    const copyLocalRootScalarOrDelete = (key: string) => {
        if (Object.prototype.hasOwnProperty.call(localDb, key) && (localDb as any)[key] !== undefined) {
            ;(mergedDb as any)[key] = clone((localDb as any)[key])
        } else {
            delete (mergedDb as any)[key]
        }
    }

    copyLocalRootScalarOrDelete('botPresetsId')
    for (const key of presetUnitKeys) {
        copyLocalRootScalarOrDelete(key)
    }

    copyLocalRootScalarOrDelete('selectedPersona')
    for (const key of personaUnitKeys) {
        copyLocalRootScalarOrDelete(key)
    }

    if (
        isPlainRecord(baselineDb.globalChatVariables)
        || isPlainRecord(localDb.globalChatVariables)
        || isPlainRecord(latestDb.globalChatVariables)
    ) {
        const bVars = isPlainRecord(baselineDb.globalChatVariables) ? baselineDb.globalChatVariables : {}
        const lVars = isPlainRecord(localDb.globalChatVariables) ? localDb.globalChatVariables : {}
        const rVars = isPlainRecord(latestDb.globalChatVariables) ? latestDb.globalChatVariables : {}
        const mergedVars: Record<string, any> = {}

        // toggle_* keys: exact set from local.
        for (const key of Object.keys(lVars)) {
            if (key.startsWith('toggle_') && lVars[key] !== undefined) {
                mergedVars[key] = clone(lVars[key])
            }
        }

        // Other keys: local if differs from base, else remote, deletions included.
        const otherKeys = new Set<string>(
            [...Object.keys(bVars), ...Object.keys(lVars), ...Object.keys(rVars)]
                .filter((k) => !k.startsWith('toggle_')),
        )
        for (const key of otherKeys) {
            const bHas = Object.prototype.hasOwnProperty.call(bVars, key) && bVars[key] !== undefined
            const lHas = Object.prototype.hasOwnProperty.call(lVars, key) && lVars[key] !== undefined
            const rHas = Object.prototype.hasOwnProperty.call(rVars, key) && rVars[key] !== undefined
            const localDiffers = (lHas !== bHas) || (lHas && !normalizedDeepEqual(lVars[key], bVars[key], normFn))
            if (localDiffers) {
                if (lHas) mergedVars[key] = clone(lVars[key])
            } else if (rHas) {
                mergedVars[key] = clone(rVars[key])
            }
        }
        mergedDb.globalChatVariables = mergedVars
    }

    // ── Section 4: botPresets per-entry merge ────────────────────────────────
    let appliedRemoteSelectedPreset = false
    if (
        hasValidUniqueIds(baselineDb.botPresets)
        && hasValidUniqueIds(localDb.botPresets)
        && hasValidUniqueIds(latestDb.botPresets)
    ) {
        const localSelectedPresetId = (typeof localDb.botPresetsId === 'number' && localDb.botPresetsId >= 0)
            ? localDb.botPresets[localDb.botPresetsId]?.id
            : undefined

        const { merged, winnerById } = mergeEntriesById({
            baseList: baselineDb.botPresets,
            localList: localDb.botPresets,
            remoteList: latestDb.botPresets,
            clone,
            normalizeValue: normFn,
            dirtyIds: options.dirtyPresetIds,
            selectedId: localSelectedPresetId,
            normalizeEntry: applyBotPresetEntryDefaults,
        })
        mergedDb.botPresets = merged

        if (localDb.botPresetsId !== undefined) {
            mergedDb.botPresetsId = reanchorPresetIndex(mergedDb.botPresets, localDb.botPresets, localDb.botPresetsId)
        }

        if (
            localSelectedPresetId
            && winnerById.get(localSelectedPresetId) === 'remote'
            && !options.isPresetUnitDirty
            && typeof mergedDb.botPresetsId === 'number'
            && mergedDb.botPresetsId >= 0
        ) {
            const selectedEntry = mergedDb.botPresets[mergedDb.botPresetsId]
            if (selectedEntry) {
                applyPresetToRoot(mergedDb, clone(selectedEntry))
                appliedRemoteSelectedPreset = true
            }
        }

        if (!normalizedDeepEqual(mergedDb.botPresets, latestDb.botPresets, normFn)) {
            toSave.botPreset = true
        }
    } else {
        if (toSave.botPreset) {
            mergedDb.botPresets = clone(localDb.botPresets)
        }
        if (localDb.botPresetsId !== undefined && Array.isArray(mergedDb.botPresets)) {
            mergedDb.botPresetsId = reanchorPresetIndex(mergedDb.botPresets, localDb.botPresets, localDb.botPresetsId)
        }
    }

    // ── Section 4: personas per-entry merge ──────────────────────────────────
    let appliedRemoteSelectedPersona = false
    if (
        hasValidUniqueIds(baselineDb.personas)
        && hasValidUniqueIds(localDb.personas)
        && hasValidUniqueIds(latestDb.personas)
    ) {
        const localSelectedPersonaId = (typeof localDb.selectedPersona === 'number' && localDb.selectedPersona >= 0)
            ? localDb.personas[localDb.selectedPersona]?.id
            : undefined

        const { merged, winnerById } = mergeEntriesById({
            baseList: baselineDb.personas,
            localList: localDb.personas,
            remoteList: latestDb.personas,
            clone,
            normalizeValue: normFn,
            dirtyIds: options.dirtyPersonaIds,
            selectedId: localSelectedPersonaId,
            normalizeEntry: applyPersonaEntryDefaults,
            preserveManifest: (kept, remote) => preservePersonaEmbeddedAssetManifest(kept, remote, clone),
        })
        mergedDb.personas = merged

        if (localDb.selectedPersona !== undefined) {
            mergedDb.selectedPersona = reanchorPersonaIndex(mergedDb.personas, localDb.personas, localDb.selectedPersona)
        }

        if (
            localSelectedPersonaId
            && winnerById.get(localSelectedPersonaId) === 'remote'
            && !options.isPersonaUnitDirty
            && typeof mergedDb.selectedPersona === 'number'
            && mergedDb.selectedPersona >= 0
        ) {
            const selectedEntry = mergedDb.personas[mergedDb.selectedPersona]
            if (selectedEntry) {
                applyPersonaToRoot(mergedDb, selectedEntry)
                appliedRemoteSelectedPersona = true
            }
        }
    } else {
        const localHasPersonas = Object.prototype.hasOwnProperty.call(localDb, 'personas') && localDb.personas !== undefined
        const baseHasPersonas = Object.prototype.hasOwnProperty.call(baselineDb, 'personas') && baselineDb.personas !== undefined
        const personasChanged = (localHasPersonas !== baseHasPersonas)
            || (localHasPersonas && !normalizedDeepEqual(localDb.personas, baselineDb.personas, normFn))
        if (personasChanged) {
            if (localHasPersonas) {
                mergedDb.personas = clone(localDb.personas)
            } else {
                delete (mergedDb as any).personas
            }
        }
        if (localDb.selectedPersona !== undefined && Array.isArray(mergedDb.personas)) {
            mergedDb.selectedPersona = reanchorPersonaIndex(mergedDb.personas, localDb.personas, localDb.selectedPersona)
        }
    }

    // ── Plugins & Section 5 Modules ──────────────────────────────────────────
    if (toSave.plugins) {
        mergedDb.plugins = clone(localDb.plugins)
    }
    if (toSave.modules) {
        if (
            hasValidUniqueIds(baselineDb.modules)
            && hasValidUniqueIds(localDb.modules)
            && hasValidUniqueIds(latestDb.modules)
        ) {
            mergedDb.modules = mergeEntriesById({
                baseList: baselineDb.modules,
                localList: localDb.modules,
                remoteList: latestDb.modules,
                clone,
                normalizeValue: normFn,
                preserveManifest: (kept, remote) => preserveModuleAssetManifest(kept, remote, clone),
            }).merged
        } else {
            mergedDb.modules = clone(localDb.modules)
        }
    }

    // ── Section 5: Archives & Characters ─────────────────────────────────────
    const localCharacters = Array.isArray(localDb.characters) ? localDb.characters : []
    const baseCharacters = Array.isArray(baselineDb.characters) ? baselineDb.characters : []
    const remoteCharacters = Array.isArray(latestDb.characters) ? latestDb.characters : []

    const charsAmbiguous = hasAmbiguousCharacterIds(baseCharacters)
        || hasAmbiguousCharacterIds(localCharacters)
        || hasAmbiguousCharacterIds(remoteCharacters)

    let skippedArchivedCharIds: string[]
    if (charsAmbiguous) {
        skippedArchivedCharIds = mergeCharactersAndArchivesLegacy(
            latestDb,
            localDb,
            mergedDb,
            toSave,
            clone,
            convertChats,
            baselineArchivedIds,
        ).skippedArchivedCharIds
    } else {
        skippedArchivedCharIds = mergeCharactersAndArchivesWithBaseline({
            latestDb,
            localDb,
            mergedDb,
            baseCharacters,
            localCharacters,
            remoteCharacters,
            toSave,
            clone,
            convertChats,
            baselineArchivedIds,
            normalizeValue: normFn,
            options,
        })
    }

    // Section 1: Re-anchor chatPage for ALL characters (not only overlaid ones).
    const mergedCharacters = Array.isArray(mergedDb.characters) ? mergedDb.characters : []
    for (const char of mergedCharacters) {
        if (!char) continue
        const localChar = char.chaId ? localCharacters.find((c) => c?.chaId === char.chaId) : undefined
        const remoteChar = char.chaId ? remoteCharacters.find((c) => c?.chaId === char.chaId) : undefined
        if (localChar !== undefined || remoteChar !== undefined) {
            if (
                localChar?.chatPage !== undefined
                || remoteChar?.chatPage !== undefined
                || char.chatPage !== undefined
            ) {
                char.chatPage = reanchorChatPage(char.chats, localChar, remoteChar)
            }
        }
    }

    return {
        mergedDb,
        skippedArchivedCharIds,
        appliedRemoteSelectedPreset,
        appliedRemoteSelectedPersona,
    }
}

function mergeArchiveRecords(
    latestDb: Database,
    localDb: Database,
    mergedDb: Database,
    toSave: toSaveType,
    clone: <T>(value: T) => T,
    baselineArchivedIds: ReadonlySet<string>,
) {
    type Stub = { chaId?: string }
    const idOf = (stub: Stub | undefined | null) => (typeof stub?.chaId === 'string' && stub.chaId.length > 0 ? stub.chaId : null)
    const localCharacters = Array.isArray(localDb.characters) ? localDb.characters : []
    const localArchived: Stub[] = Array.isArray((localDb as any).nodeOnlyArchivedCharacters) ? (localDb as any).nodeOnlyArchivedCharacters : []
    const localArchivedIds = new Set(localArchived.map(idOf).filter((id): id is string => id !== null))
    const localActiveIds = new Set(localCharacters.map(idOf).filter((id): id is string => id !== null))
    let mergedArchived: Stub[] = Array.isArray((latestDb as any).nodeOnlyArchivedCharacters)
        ? clone((latestDb as any).nodeOnlyArchivedCharacters as Stub[])
        : []
    const trackedCharIds = new Set<string>(toSave.character.filter(Boolean))
    // Deactivated here, not yet on the server: keep our stub, drop the
    // server's active copy. Only when the character was active at our last
    // sync — a stub that was already in the baseline and is now active on
    // the server means another device activated it, and the server wins.
    for (const stub of localArchived) {
        const id = idOf(stub)
        if (!id || localActiveIds.has(id) || baselineArchivedIds.has(id)) continue
        if (!mergedArchived.some((s) => idOf(s) === id)) mergedArchived.push(clone(stub))
        trackedCharIds.add(id)
    }
    // Activated here, not yet on the server: only when this client last saw
    // the character deactivated. Otherwise it was deactivated elsewhere while
    // this client still had it active, which is the skip case below.
    const activatedLocally = new Set<string>()
    for (const id of localActiveIds) {
        if (!localArchivedIds.has(id) && baselineArchivedIds.has(id) && mergedArchived.some((s) => idOf(s) === id)) {
            activatedLocally.add(id)
            trackedCharIds.add(id)
        }
    }
    if (activatedLocally.size > 0) mergedArchived = mergedArchived.filter((s) => !activatedLocally.has(idOf(s) ?? ''))
    ;(mergedDb as any).nodeOnlyArchivedCharacters = mergedArchived
    const archivedOnServer = new Set(mergedArchived.map(idOf).filter((id): id is string => id !== null))

    for (const trackedChat of toSave.chat) {
        if (trackedChat?.[0]) {
            trackedCharIds.add(trackedChat[0])
        }
    }

    return { trackedCharIds, archivedOnServer }
}

function mergeCharactersAndArchivesLegacy(
    latestDb: Database,
    localDb: Database,
    mergedDb: Database,
    toSave: toSaveType,
    clone: <T>(value: T) => T,
    convertChats: (chats: any[]) => any[],
    baselineArchivedIds: ReadonlySet<string>,
): { skippedArchivedCharIds: string[] } {
    const localCharacters = Array.isArray(localDb.characters) ? localDb.characters : []
    const { trackedCharIds, archivedOnServer } = mergeArchiveRecords(
        latestDb,
        localDb,
        mergedDb,
        toSave,
        clone,
        baselineArchivedIds,
    )
    const mergedCharacters = Array.isArray(mergedDb.characters) ? mergedDb.characters : []
    const skippedArchivedCharIds: string[] = []
    const overlaidFromLocal = new Set<any>()

    for (const charId of trackedCharIds) {
        const localChar = localCharacters.find((char) => char?.chaId === charId)
        const mergedIndex = mergedCharacters.findIndex((char) => char?.chaId === charId)
        if (localChar && archivedOnServer.has(charId)) {
            skippedArchivedCharIds.push(charId)
            continue
        }
        if (localChar) {
            const clonedLocalChar = clone(localChar)
            overlaidFromLocal.add(clonedLocalChar)
            if (mergedIndex >= 0) {
                mergedCharacters[mergedIndex] = clonedLocalChar
            } else {
                mergedCharacters.push(clonedLocalChar)
            }
        } else if (mergedIndex >= 0) {
            mergedCharacters.splice(mergedIndex, 1)
        }
    }
    for (const character of mergedCharacters) {
        if (!character || overlaidFromLocal.has(character) || !Array.isArray(character.chats)) continue
        character.chats = convertChats(character.chats)
    }
    mergedDb.characters = mergedCharacters
    return { skippedArchivedCharIds }
}

function mergeCharactersAndArchivesWithBaseline(args: {
    latestDb: Database
    localDb: Database
    mergedDb: Database
    baseCharacters: any[]
    localCharacters: any[]
    remoteCharacters: any[]
    toSave: toSaveType
    clone: <T>(value: T) => T
    convertChats: (chats: any[]) => any[]
    baselineArchivedIds: ReadonlySet<string>
    normalizeValue: (v: any) => any
    options: RebaseMergeOptions
}): string[] {
    const {
        latestDb,
        localDb,
        mergedDb,
        baseCharacters,
        localCharacters,
        remoteCharacters,
        toSave,
        clone,
        convertChats,
        baselineArchivedIds,
        normalizeValue,
        options,
    } = args

    const { trackedCharIds, archivedOnServer } = mergeArchiveRecords(
        latestDb,
        localDb,
        mergedDb,
        toSave,
        clone,
        baselineArchivedIds,
    )

    const normalizeChar = options.normalizeCharacter ?? defaultNormalizeCharacter
    const hasExplicitCharSelection = options.localSelectedCharIndex !== undefined
    const localSelectedCharId = (typeof options.localSelectedCharIndex === 'number' && options.localSelectedCharIndex >= 0)
        ? localCharacters[options.localSelectedCharIndex]?.chaId
        : undefined

    const mergedCharacters = Array.isArray(mergedDb.characters) ? mergedDb.characters : []
    const skippedArchivedCharIds: string[] = []
    const overlaidFromLocal = new Set<any>()

    for (const charId of trackedCharIds) {
        const localChar = localCharacters.find((char) => char?.chaId === charId)
        const baseChar = baseCharacters.find((char) => char?.chaId === charId)
        const remoteChar = remoteCharacters.find((char) => char?.chaId === charId)
        const mergedIndex = mergedCharacters.findIndex((char) => char?.chaId === charId)

        if (localChar && archivedOnServer.has(charId)) {
            skippedArchivedCharIds.push(charId)
            continue
        }

        if (localChar && remoteChar && mergedIndex >= 0) {
            if (baseChar) {
                const mergedChar = mergeOverlaidCharacterWithBase({
                    baseChar,
                    localChar,
                    remoteChar,
                    clone,
                    convertChats,
                    normalizeValue,
                    normalizeChar,
                    isCharSelectedLocally: localSelectedCharId === charId,
                    hasExplicitCharSelection,
                    generatingChatKeys: options.generatingChatKeys,
                    knownChatIds: options.knownChatIdsByCharacter?.get(charId),
                })
                overlaidFromLocal.add(mergedChar)
                mergedCharacters[mergedIndex] = mergedChar
            } else {
                const clonedLocalChar = clone(localChar)
                applyCharacterAssetPairRule(clonedLocalChar, localChar, localChar, remoteChar, clone, normalizeValue)
                overlaidFromLocal.add(clonedLocalChar)
                mergedCharacters[mergedIndex] = clonedLocalChar
            }
        } else if (localChar && mergedIndex < 0) {
            if (!baseChar) {
                // Newly added or reactivated locally.
                const clonedLocalChar = clone(localChar)
                overlaidFromLocal.add(clonedLocalChar)
                mergedCharacters.push(clonedLocalChar)
            } else if (didCharacterChangeForDeletion(localChar, baseChar, normalizeChar, clone, normalizeValue)) {
                // Deleted remotely, edited locally -> keep local's character.
                const clonedLocalChar = clone(localChar)
                overlaidFromLocal.add(clonedLocalChar)
                mergedCharacters.push(clonedLocalChar)
            }
        } else if (!localChar && mergedIndex >= 0) {
            if (archivedOnServer.has(charId)) {
                // Deactivation in flight on this client: active copy must leave characters.
                mergedCharacters.splice(mergedIndex, 1)
            } else if (!baseChar || !remoteChar || !didCharacterChangeForDeletion(remoteChar, baseChar, normalizeChar, clone, normalizeValue)) {
                // Deleted locally and not edited remotely -> stays deleted.
                mergedCharacters.splice(mergedIndex, 1)
            }
            // Otherwise remote edited it -> stays in mergedCharacters (and gets convertChats below).
        }
    }

    for (const character of mergedCharacters) {
        if (!character || overlaidFromLocal.has(character) || !Array.isArray(character.chats)) continue
        character.chats = convertChats(character.chats)
    }
    mergedDb.characters = mergedCharacters
    return skippedArchivedCharIds
}

/**
 * `toSave` with extra chaIds added to its tracked list — the characters the
 * patcher saw change by hash in the save that hit the conflict, so a rebase
 * overlays every edited character, not only the tracked ones, without
 * touching characters the user did not edit.
 */
export function withTrackedCharacters(toSave: toSaveType, chaIds: readonly string[]): toSaveType {
    const extra = chaIds.filter((id) => id && !toSave.character.includes(id))
    if (extra.length === 0) return toSave
    return { ...toSave, character: [...toSave.character, ...new Set(extra)] }
}

/**
 * True when the character array has an entry without a chaId or two entries
 * sharing one. Rebase and the patcher's change detection both key by chaId,
 * so in that state an edit could be attributed to the wrong entry or dropped;
 * callers keep the pre-existing full-write fallback instead.
 */
export function hasAmbiguousCharacterIds(characters: ReadonlyArray<{ chaId?: string } | undefined | null>): boolean {
    const seen = new Set<string>()
    for (const character of characters) {
        const id = character?.chaId
        if (typeof id !== 'string' || id.length === 0) return true
        if (seen.has(id)) return true
        seen.add(id)
    }
    return false
}
