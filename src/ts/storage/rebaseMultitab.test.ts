import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { get } from 'svelte/store'

// Mock heavy UI/network dependencies while keeping real storage, preset, persona,
// character, generationState, and stores logic intact.
vi.mock('../alert', () => ({
    alertConfirm: vi.fn(async () => true),
    alertError: vi.fn(),
    alertMd: vi.fn(),
    alertNormal: vi.fn(),
    alertSelect: vi.fn(),
    alertStore: { set: vi.fn() },
    alertWait: vi.fn(),
    alertAddCharacter: vi.fn(),
    notifyError: vi.fn(),
    notifySuccess: vi.fn(),
    notifyWarning: vi.fn(),
    waitAlert: vi.fn(),
}))

vi.mock('../../lang', () => ({
    language: {
        recoveredPresetName: 'Recovered Preset',
        recoveredPresetNotice: 'recovered',
        rebaseSkippedArchived: (names: string) => `skipped:${names}`,
        archiveGuardSaveWaiting: 'waiting',
        loading: 'loading',
        errors: { noData: 'noData' },
    },
    changeLanguage: vi.fn(),
    applyEarlyLanguage: vi.fn(),
}))

import { DBState, selectedCharID } from '../stores.svelte'
import { safeStructuredClone } from '../polyfill'
import {
    applyBotPresetEntryDefaults,
    changeToPreset,
    createBotPresetTemplate,
    getDatabase,
    getPersonaUnitRootKeys,
    getPresetUnitRootKeys,
    initUnitSnapshotsAtBoot,
    liveUnitSyncState,
    populateDatabaseDefaults,
    presetTemplate,
    saveCurrentPreset,
    setDatabase,
    setPreset,
    type Database,
} from './database.svelte'
import {
    applyPersonaToRoot,
    applyPresetToRoot,
    captureRawUnitPresence,
    recordPersonaUnitRootKeys,
    recordPresetUnitRootKeys,
    getTabLocalPresetRootKeys,
} from './presetPersonaUnits'
import { changeUserPersona, saveUserPersona } from '../persona'
import { characterFormatUpdate, changeChar, createBlankChar, removeChar } from '../characters'
import { checkCharOrder } from '../globalApi.svelte'
import {
    chatToStub,
    convertStubsToPlaceholders,
    restoreChatShapeAfterRebase,
    stubToPlaceholder,
} from './chatStorage'
import {
    defaultNormalizeCharacter,
    hasAmbiguousCharacterIds,
    mergeServerDbWithTrackedLocalChanges,
    withTrackedCharacters,
} from './rebaseMerge'
import { reanchorChatPage, reanchorRebasedSelection } from './rebaseSelection'
import {
    decodeRisuSave,
    encodeRisuSaveLegacy,
    findDangerousChatOps,
    normalizeJSON,
    RisuSaveEncoder,
    RisuSavePatcher,
    type toSaveType,
} from './risuSave'
import { newSaveTiming } from './saveMetrics'
import {
    abortGeneration,
    chatGenKey,
    endAllGenerations,
    endGeneration,
    generationStates,
    notifyDatabaseRebased,
    startGeneration,
} from '../process/generationState'
import { applyPatch } from 'fast-json-patch'

const requireCjs = createRequire(import.meta.url)
const assetManifestMigration = requireCjs('../../../server/node/assetManifestMigration.cjs') as {
    findAssetManifestConflicts: (db: any) => any[]
    findAssetManifestLossOwners: (prevDb: any, nextDb: any) => any[]
}

// Extract real save-loop functions from globalApi.svelte.ts so tests exercise
// the exact production persistTrackedChanges & rebaseTrackedLocalChangesOnLatestServerDb.
const globalApiSource = fs.readFileSync('src/ts/globalApi.svelte.ts', 'utf8').replace(/\r\n/g, '\n')
const globalApiAst = ts.createSourceFile('globalApi.ts', globalApiSource, ts.ScriptTarget.Latest, true)

function extractFunction(name: string): string {
    let found = ''
    function visit(node: ts.Node) {
        if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
            found = node.getText(globalApiAst).replace(/^export /, '')
        } else {
            ts.forEachChild(node, visit)
        }
    }
    visit(globalApiAst)
    if (!found) throw new Error(`Function ${name} not found in globalApi.svelte.ts`)
    return found
}

function emptyToSave(overrides: Partial<toSaveType> = {}): toSaveType {
    return {
        character: [],
        chat: [],
        root: false,
        botPreset: false,
        modules: false,
        plugins: false,
        ...overrides,
    }
}

class MockServer {
    etagCounter = 1
    etag = 'etag-1'
    strippedDb: any
    savedChats = new Map<string, any>()

    constructor(initialRawDb: any) {
        this.strippedDb = normalizeJSON(this.stripChats(structuredClone(initialRawDb)))
    }

    private stripChats(db: any): any {
        const out = structuredClone(db)
        if (Array.isArray(out.characters)) {
            out.characters = out.characters.map((ch: any) => ({
                ...ch,
                chats: Array.isArray(ch.chats) ? ch.chats.map((c: any) => chatToStub(c)) : [],
            }))
        }
        out.pluginCustomStorage = {}
        return out
    }

    readBytes(): { bytes: Uint8Array; etag: string } {
        return {
            bytes: new TextEncoder().encode(JSON.stringify(this.strippedDb)),
            etag: this.etag,
        }
    }

    async applyClientPatch(patchData: { patch: any[]; expectedHash: string }, clientEtag: string | null) {
        const tempPatcher = new RisuSavePatcher()
        await tempPatcher.init(structuredClone(this.strippedDb))
        const currentServerHash = tempPatcher.hash()
        if (patchData.expectedHash !== currentServerHash || (clientEtag && clientEtag !== this.etag)) {
            return {
                success: false,
                etag: this.etag,
            }
        }
        const candidate = structuredClone(this.strippedDb)
        const next = applyPatch(candidate, structuredClone(patchData.patch), true).newDocument
        const losses = assetManifestMigration.findAssetManifestLossOwners(this.strippedDb, next)
        const conflicts = assetManifestMigration.findAssetManifestConflicts(next)
        if (losses.length > 0 || conflicts.length > 0) {
            return {
                success: false,
                etag: this.etag,
                conflictCode: 'ASSET_MANIFEST_GUARD_REJECTED',
            }
        }
        this.strippedDb = normalizeJSON(next)
        this.etag = `etag-${++this.etagCounter}`
        return {
            success: true,
            etag: this.etag,
        }
    }

    overwriteDirectly(mutator: (serverDb: any) => void) {
        const copy = structuredClone(this.strippedDb)
        mutator(copy)
        this.strippedDb = normalizeJSON(this.stripChats(copy))
        this.etag = `etag-${++this.etagCounter}`
    }
}

async function decodeMockBytes(bytes: Uint8Array): Promise<any> {
    return JSON.parse(new TextDecoder().decode(bytes))
}

async function createLiveTabHarness(server: MockServer) {
    const { bytes, etag: initialEtag } = server.readBytes()
    const rawDecoded = await decodeMockBytes(bytes)
    const rawPresence = captureRawUnitPresence(rawDecoded as any)
    const bootBaseline = structuredClone(rawDecoded)

    setDatabase(rawDecoded)
    const db = getDatabase()
    for (const ch of db.characters) {
        ch.chats = convertStubsToPlaceholders(ch.chats)
    }
    selectedCharID.set(-1)
    initUnitSnapshotsAtBoot(db, rawPresence)

    let currentEtag: string | null = initialEtag
    const uploadedChats: Array<{ chaId: string; chatIndex: number; chatId: string; chat: any }> = []

    const forageMock = {
        getDbEtag: () => currentEtag,
        setDbEtag: (next: string | null) => { currentEtag = next },
        getItem: async (key: string) => {
            if (key === 'database/database.bin') {
                const res = server.readBytes()
                currentEtag = res.etag
                return res.bytes
            }
            return null
        },
        patchItem: async (_key: string, patchData: { patch: any[]; expectedHash: string }) => {
            return await server.applyClientPatch(patchData, currentEtag)
        },
        setItem: async (_key: string, data: Uint8Array, ifMatch?: string) => {
            if (ifMatch && ifMatch !== server.etag) {
                const err: any = new Error('Conflict')
                err.currentEtag = server.etag
                throw Object.assign(new ConflictErrorStub('Conflict'), { currentEtag: server.etag })
            }
            const decoded = await decodeRisuSave(data)
            server.overwriteDirectly((target) => {
                for (const k of Object.keys(target)) delete target[k]
                Object.assign(target, decoded)
            })
            currentEtag = server.etag
        },
        realStorage: { takeDbWriteDiagnostics: () => null },
    }

    class ConflictErrorStub extends Error {
        currentEtag?: string
        code?: string
    }

    const saveChatSpy = vi.fn(async (chaId: string, chatIndex: number, chatId: string, chat: any) => {
        uploadedChats.push({ chaId, chatIndex, chatId, chat: safeStructuredClone(chat) })
        server.savedChats.set(`${chaId}/${chatId}`, safeStructuredClone(chat))
    })

    const saveUnitLifecycle = {
        flushDirtyUnits(targetDb: Database, toSave: toSaveType): void {
            if (!liveUnitSyncState.hasSnapshotsFor(targetDb)) return
            if (Array.isArray(targetDb.botPresets) && typeof targetDb.botPresetsId === 'number' && targetDb.botPresetsId >= 0 && liveUnitSyncState.isPresetDirty(targetDb)) {
                saveCurrentPreset()
                toSave.botPreset = true
            }
            if (liveUnitSyncState.peekDirtyPresetIds().size > 0) {
                toSave.botPreset = true
            }
            if (Array.isArray(targetDb.personas) && typeof targetDb.selectedPersona === 'number' && targetDb.selectedPersona >= 0 && targetDb.personas[targetDb.selectedPersona] && liveUnitSyncState.isPersonaDirty(targetDb)) {
                saveUserPersona()
                toSave.root = true
            }
            if (liveUnitSyncState.peekDirtyPersonaIds().size > 0) {
                toSave.root = true
            }
        },
        takeCarriedIds(toSave: toSaveType): () => void {
            const presetIds = toSave.botPreset ? liveUnitSyncState.takeDirtyPresetIds() : new Set<string>()
            const personaIds = liveUnitSyncState.takeDirtyPersonaIds()
            let restored = false
            return () => {
                if (restored) return
                restored = true
                liveUnitSyncState.requeueDirtyPresetIds(presetIds)
                liveUnitSyncState.requeueDirtyPersonaIds(personaIds)
            }
        },
        mergeOptions(
            targetDb: Database,
            liveSelectedCharIndex: number,
            streamingChatKeys: ReadonlySet<string>,
            knownChatIdsByCharacter: ReadonlyMap<string, ReadonlySet<string>>,
        ) {
            const tracked = liveUnitSyncState.hasSnapshotsFor(targetDb)
            return {
                dirtyPresetIds: liveUnitSyncState.peekDirtyPresetIds(),
                dirtyPersonaIds: liveUnitSyncState.peekDirtyPersonaIds(),
                isPresetUnitDirty: tracked ? liveUnitSyncState.isPresetDirty(targetDb) : true,
                isPersonaUnitDirty: tracked ? liveUnitSyncState.isPersonaDirty(targetDb) : true,
                localSelectedCharIndex: liveSelectedCharIndex,
                generatingChatKeys: streamingChatKeys,
                knownChatIdsByCharacter,
                normalizeCharacter: characterFormatUpdate,
            }
        },
        afterRebaseApplied(appliedRemoteSelectedPreset: boolean, appliedRemoteSelectedPersona: boolean): void {
            const currentDb = getDatabase()
            if (!liveUnitSyncState.hasSnapshotsFor(currentDb)) return
            if (appliedRemoteSelectedPreset) {
                liveUnitSyncState.retakePresetSnapshot(currentDb)
            }
            if (appliedRemoteSelectedPersona) {
                liveUnitSyncState.retakePersonaSnapshot(currentDb)
            }
        },
    }

    const patcher = new RisuSavePatcher()
    await patcher.init(bootBaseline)

    const deps: Record<string, any> = {
        forageStorage: forageMock,
        getDatabase,
        setDatabase,
        decodeRisuSave: async (bytes: Uint8Array) => {
            try {
                return await decodeMockBytes(bytes)
            } catch {
                return await decodeRisuSave(bytes)
            }
        },
        safeStructuredClone,
        supportsPatchSync: true,
        RisuSaveEncoder,
        RisuSavePatcher,
        findDangerousChatOps,
        normalizeJSON,
        convertStubsToPlaceholders,
        restoreChatShapeAfterRebase,
        reanchorRebasedSelection,
        reanchorChatPage,
        mergeServerDbWithTrackedLocalChanges,
        withTrackedCharacters,
        hasAmbiguousCharacterIds,
        checkCharOrder,
        selectedCharID,
        generationStates,
        chatGenKey,
        abortGeneration,
        notifyDatabaseRebased,
        get,
        sleep: async () => {},
        newSaveTiming,
        recordDbTransferSize: () => {},
        showPersistWarningOnce: () => {},
        showChatGuardToastThrottled: () => {},
        isChatGuardDebugEnabled: () => false,
        summarizeHashMismatch: () => '',
        addLog: () => {},
        notifyError: () => {},
        language: { rebaseSkippedArchived: (n: string) => n, archiveGuardSaveWaiting: 'w' },
        ConflictError: ConflictErrorStub,
        saveChatToServer: saveChatSpy,
        resendChatOnNextSave: () => {},
        errorMessage: (e: any) => String(e?.message ?? e),
        saveUnitLifecycle,
        chatToStub,
        classifyChat: () => 'full',
        CHAT_GUARD_DEBUG_KEY: 'debug',
        console: { warn: () => {}, error: () => {}, log: () => {} },
        performance,
    }

    const body = `
        let changed = false, savetrys = 0, archiveGuardNoticeShown = false;
        let patcher = initialPatcher;
        let activeSavePatcher = patcher;
        const changeTracker = { character: [], chat: [], root: false, botPreset: false, modules: false, plugins: false };
        const knownChatIdsByCharacter = new Map(
            (getDatabase()?.characters ?? [])
                .filter(c => c?.chaId)
                .map(c => [c.chaId, new Set((c.chats ?? []).map(ch => ch?.id).filter(Boolean))])
        );
        ${extractFunction('requeueTrackedChanges')}
        ${extractFunction('collectChatsToPersist')}
        ${extractFunction('updateKnownChatsAfterSuccessfulSave')}
        ${extractFunction('resyncBaselineAfterFullWrite')}
        ${extractFunction('generatingCharacters')}
        ${extractFunction('abortGenerationsAndWait')}
        ${extractFunction('rebaseTrackedLocalChangesOnLatestServerDb')}
        ${extractFunction('queueArchiveGuardRetry')}
        ${extractFunction('persistTrackedChanges')}
        return {
            persistOnce: (toSave, opts) => persistTrackedChanges(toSave, newSaveTiming(), opts),
            flushWithRetries: async (initialToSave, opts) => {
                let firstOutcome = await persistTrackedChanges(initialToSave, newSaveTiming(), opts);
                let safety = 0;
                while (firstOutcome === 'retry' && safety++ < 5) {
                    const nextToSave = safeStructuredClone(changeTracker);
                    changeTracker.character = [];
                    changeTracker.chat = [];
                    changeTracker.root = false;
                    changeTracker.botPreset = false;
                    changeTracker.modules = false;
                    changeTracker.plugins = false;
                    firstOutcome = await persistTrackedChanges(nextToSave, newSaveTiming(), opts);
                }
                return firstOutcome;
            },
            getKnownChats: (chaId) => knownChatIdsByCharacter.get(chaId),
            getPatcher: () => patcher,
            getChangeTracker: () => changeTracker,
        };
    `
    deps.initialPatcher = patcher
    const js = ts.transpileModule(
        `const { ${Object.keys(deps).join(', ')} } = deps;\n${body}`,
        { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
    ).outputText
    const loop = new Function('deps', js)(deps)

    return {
        loop,
        forageMock,
        uploadedChats,
        saveChatSpy,
    }
}

beforeEach(() => {
    liveUnitSyncState.reset()
    endAllGenerations()
    generationStates.set(new Map())
    selectedCharID.set(-1)
})

afterEach(() => {
    liveUnitSyncState.reset()
    endAllGenerations()
    generationStates.set(new Map())
    selectedCharID.set(-1)
    vi.restoreAllMocks()
})

function makeSeedPreset(id: string, name: string, overrides: Record<string, any> = {}) {
    return {
        ...structuredClone(presetTemplate),
        id,
        name,
        ...overrides,
    }
}

function makeSyncedInitialDb(raw: Record<string, any>): Database {
    const db = populateDatabaseDefaults(raw as Database)
    if (Array.isArray(db.botPresets) && typeof db.botPresetsId === 'number' && db.botPresetsId >= 0 && db.botPresets[db.botPresetsId]) {
        applyPresetToRoot(db, structuredClone(db.botPresets[db.botPresetsId]))
        populateDatabaseDefaults(db)
    }
    return db
}

describe('Section 1: Unit key sets recorded dynamically from real functions', () => {
    test('preset unit keys match every key written by real setPreset() and exclude openAIKey and botPresetsId', () => {
        const recordedFromRealSetPreset = recordPresetUnitRootKeys((db, pres) => setPreset(db, pres))
        const unitKeys = getPresetUnitRootKeys()
        expect([...unitKeys].sort()).toEqual([...recordedFromRealSetPreset].sort())
        expect(unitKeys.has('openAIKey')).toBe(false)
        expect(unitKeys.has('botPresetsId')).toBe(false)
        expect(unitKeys.has('temperature')).toBe(true)
        expect(unitKeys.has('mainPrompt')).toBe(true)
        expect(unitKeys.has('fallbackModels')).toBe(true)
        expect(unitKeys.has('seperateParameters')).toBe(true)
    })

    test('persona unit keys match every root key written by real changeUserPersona()', () => {
        DBState.db = {
            personas: [{ id: 'p-1', name: 'Alice', icon: 'assets/a.png', personaPrompt: 'Prompt A', note: 'Note A' }],
        } as any
        changeUserPersona(0, 'noSave')
        const written = Object.keys(DBState.db).filter((k) => k !== 'personas')
        const expected = ['selectedPersona', ...getPersonaUnitRootKeys()]
        expect(written.sort()).toEqual(expected.sort())
        expect([...recordPersonaUnitRootKeys()].sort()).toEqual([...getPersonaUnitRootKeys()].sort())
    })
})

describe('Section 1 base test & Traps 1–10: Presets and Personas', () => {
    test('Section 1 base test: A on X, B switches to Y and saves, A rebases, then saveCurrentPreset() in A leaves X equal to X', async () => {
        const presetX = makeSeedPreset('id-x', 'Preset X', { mainPrompt: 'Prompt X', temperature: 80, maxContext: 8000 })
        const presetY = makeSeedPreset('id-y', 'Preset Y', { mainPrompt: 'Prompt Y', temperature: 30, maxContext: 16000 })
        const initialDb = makeSyncedInitialDb({
            botPresets: [structuredClone(presetX), structuredClone(presetY)],
            botPresetsId: 0,
            mainPrompt: 'Prompt X',
            temperature: 80,
            maxContext: 8000,
            characters: [],
        } as any)

        const server = new MockServer(initialDb)
        const tabA = await createLiveTabHarness(server)

        // Tab B switches to Y and saves on server.
        server.overwriteDirectly((srv) => {
            srv.botPresetsId = 1
            applyPresetToRoot(srv, srv.botPresets[1])
        })

        // Tab A saves an unrelated root change (customCSS), triggering rebase.
        getDatabase().customCSS = 'body { color: red; }'
        const outcome = await tabA.loop.flushWithRetries(emptyToSave({ root: true }))
        expect(outcome).toBe('saved')

        // Tab A must still be on X with X's values in root, and saveCurrentPreset() leaves X equal to X.
        expect(getDatabase().botPresetsId).toBe(0)
        expect(getDatabase().mainPrompt).toBe('Prompt X')
        expect(getDatabase().temperature).toBe(80)
        expect(getDatabase().maxContext).toBe(8000)

        const beforeSaveCurrent = safeStructuredClone(getDatabase().botPresets[0])
        saveCurrentPreset()
        expect(getDatabase().botPresets[0]).toEqual(beforeSaveCurrent)
        expect(getDatabase().botPresets[0].mainPrompt).toBe('Prompt X')
        expect(getDatabase().botPresets[0].temperature).toBe(80)
    })

    test('Trap 1: a save that only changed root values writes the edit into the entry and sets toSave.botPreset', async () => {
        const presetX = makeSeedPreset('id-x', 'Preset X', { temperature: 80, mainPrompt: 'Initial' })
        const initialDb = makeSyncedInitialDb({
            botPresets: [presetX],
            botPresetsId: 0,
            temperature: 80,
            mainPrompt: 'Initial',
            characters: [],
        } as any)

        const server = new MockServer(initialDb)
        const tabA = await createLiveTabHarness(server)

        // User edits root temperature & mainPrompt without switching presets (toSave.botPreset is false).
        getDatabase().temperature = 95
        getDatabase().mainPrompt = 'Edited via root'
        const toSave = emptyToSave({ root: true, botPreset: false })

        const res = await tabA.loop.persistOnce(toSave)
        expect(res).toBe('saved')
        expect(toSave.botPreset).toBe(true)
        expect(getDatabase().botPresets[0].temperature).toBe(95)
        expect(getDatabase().botPresets[0].mainPrompt).toBe('Edited via root')
        expect(server.strippedDb.botPresets[0].temperature).toBe(95)
        expect(server.strippedDb.botPresets[0].mainPrompt).toBe('Edited via root')
        // Accepted save cleared dirtyPresetIds.
        expect(liveUnitSyncState.peekDirtyPresetIds().size).toBe(0)
    })

    test('Trap 2: changeToPreset() on an unedited preset leaves its entry untouched and does not make it a local win', async () => {
        const presetX = makeSeedPreset('id-x', 'Preset X', { mainPrompt: 'Orig X', temperature: 80 })
        const presetY = makeSeedPreset('id-y', 'Preset Y', { mainPrompt: 'Orig Y', temperature: 40 })
        const initialDb = makeSyncedInitialDb({
            botPresets: [presetX, presetY],
            botPresetsId: 0,
            mainPrompt: 'Orig X',
            temperature: 80,
            characters: [],
        } as any)

        const server = new MockServer(initialDb)
        const tabA = await createLiveTabHarness(server)

        const originalEntryRef = getDatabase().botPresets[0]
        changeToPreset(1)
        expect(getDatabase().botPresets[0]).toBe(originalEntryRef)
        expect(liveUnitSyncState.peekDirtyPresetIds().has('id-x')).toBe(false)

        // Meanwhile Tab B edited Preset X on the server.
        server.overwriteDirectly((srv) => {
            srv.botPresets[0].mainPrompt = 'Edited X from Tab B'
            srv.botPresets[0].temperature = 65
        })

        // Tab A saves its switch to Y (botPreset: true, root: true) -> rebases -> B's edit to X survives!
        const res = await tabA.loop.flushWithRetries(emptyToSave({ root: true, botPreset: true }))
        expect(res).toBe('saved')
        expect(getDatabase().botPresetsId).toBe(1)
        expect(getDatabase().botPresets[0].mainPrompt).toBe('Edited X from Tab B')
        expect(getDatabase().botPresets[0].temperature).toBe(65)
        expect(server.strippedDb.botPresets[0].mainPrompt).toBe('Edited X from Tab B')
    })

    test('Trap 3: boot defaults in root or entry do not make an idle tab overwrite another tab preset edit', async () => {
        // Raw server DB omits root temperature, localNetworkMode, etc., and entry omits localNetworkMode/Timeout
        // and has un-normalised promptTemplate role 'assistant'.
        const rawServerDb = {
            botPresets: [{
                id: 'id-x',
                name: 'Preset X',
                mainPrompt: 'Original X',
                jailbreak: 'jb',
                globalNote: '',
                temperature: 80,
                maxContext: 4000,
                maxResponse: 300,
                frequencyPenalty: 70,
                PresensePenalty: 70,
                formatingOrder: ['main', 'chats'],
                promptPreprocess: false,
                bias: [],
                ooba: structuredClone(presetTemplate.ooba),
                ainconfig: structuredClone(presetTemplate.ainconfig),
                promptTemplate: [{ type: 'plain', type2: 'main', text: 'hi', role: 'assistant' }],
            }],
            botPresetsId: 0,
            temperature: null,
            characters: [],
        }

        const server = new MockServer(rawServerDb)
        const tabA = await createLiveTabHarness(server)

        // Idle Tab A must NOT have marked the preset unit dirty from boot defaults.
        expect(liveUnitSyncState.isPresetDirty(getDatabase())).toBe(false)

        // Tab B edits Preset X on the server and normalises its entry.
        server.overwriteDirectly((srv) => {
            applyBotPresetEntryDefaults(srv.botPresets[0])
            srv.botPresets[0].temperature = 25
            srv.botPresets[0].mainPrompt = 'Edited by B'
            srv.temperature = 25
            srv.mainPrompt = 'Edited by B'
        })

        // Idle Tab A saves an unrelated change -> rebases -> takes B's edit to X into both botPresets[0] and A's root!
        getDatabase().customCSS = '/* idle tab css */'
        const res = await tabA.loop.flushWithRetries(emptyToSave({ root: true }))
        expect(res).toBe('saved')
        expect(getDatabase().botPresets[0].temperature).toBe(25)
        expect(getDatabase().botPresets[0].mainPrompt).toBe('Edited by B')
        expect(getDatabase().temperature).toBe(25)
        expect(getDatabase().mainPrompt).toBe('Edited by B')
        expect(server.strippedDb.botPresets[0].temperature).toBe(25)
    })

    test('Section 2 boot recovery: real pre-existing root edit left by older code is captured once at boot', async () => {
        const presetX = makeSeedPreset('id-x', 'Preset X', { temperature: 80, mainPrompt: 'Old entry prompt' })
        const rawServerDb = populateDatabaseDefaults({
            botPresets: [presetX],
            botPresetsId: 0,
            temperature: 80,
            mainPrompt: 'Old entry prompt',
            characters: [],
        } as any)
        // Simulate older code having saved an edit in root without copying into botPresets[0].
        rawServerDb.temperature = 93
        rawServerDb.mainPrompt = 'Unmirrored root edit'

        const server = new MockServer(rawServerDb)
        const tabA = await createLiveTabHarness(server)
        expect(liveUnitSyncState.isPresetDirty(getDatabase())).toBe(true)

        const res = await tabA.loop.persistOnce(emptyToSave({ root: true }))
        expect(res).toBe('saved')
        expect(server.strippedDb.botPresets[0].temperature).toBe(93)
        expect(server.strippedDb.botPresets[0].mainPrompt).toBe('Unmirrored root edit')
        expect(liveUnitSyncState.isPresetDirty(getDatabase())).toBe(false)
    })

    test('Trap 4: an entry with undefined fields on a tab whose root holds the previous preset values does not read as edited', async () => {
        const presetX = makeSeedPreset('id-x', 'Preset X', {
            temperature: 92,
            top_k: 45,
            JinjaTemplate: 'jinja-from-x',
        })
        const presetY: any = makeSeedPreset('id-y', 'Preset Y', { mainPrompt: 'Y prompt' })
        delete presetY.temperature
        delete presetY.top_k
        delete presetY.JinjaTemplate

        const initialDb = makeSyncedInitialDb({
            botPresets: [presetX, presetY],
            botPresetsId: 0,
            temperature: 92,
            top_k: 45,
            JinjaTemplate: 'jinja-from-x',
            characters: [],
        } as any)

        const server = new MockServer(initialDb)
        const tabA = await createLiveTabHarness(server)

        // Switch to Y: root keeps X's temperature/top_k/JinjaTemplate via ?? in setPreset().
        changeToPreset(1)
        expect(getDatabase().temperature).toBe(92)
        expect(getDatabase().JinjaTemplate).toBe('jinja-from-x')
        expect(liveUnitSyncState.isPresetDirty(getDatabase())).toBe(false)

        // Switch back to X: Y must NOT have been rewritten or marked dirty.
        changeToPreset(0)
        expect(getDatabase().botPresets[1].temperature).toBeUndefined()
        expect(getDatabase().botPresets[1].JinjaTemplate).toBeUndefined()
        expect(liveUnitSyncState.peekDirtyPresetIds().has('id-y')).toBe(false)

        // Tab B edits Y on server; Tab A rebases -> B's edit on Y wins cleanly.
        server.overwriteDirectly((srv) => {
            srv.botPresets[1].mainPrompt = 'Y edited on B'
        })
        getDatabase().customCSS = '/* trigger */'
        await tabA.loop.flushWithRetries(emptyToSave({ root: true, botPreset: true }))
        expect(getDatabase().botPresets[1].mainPrompt).toBe('Y edited on B')
    })

    test('Trap 5: entry-only fields (folderId, image, modelBinding, subModelBinding, taskModelBindings, forceReplaceUrl2) survive merge when unedited here', async () => {
        const entryOnlyFields = {
            folderId: 'folder-123',
            image: 'assets/preset.png',
            forceReplaceUrl2: 'https://alt.example/v1',
            modelBinding: { mode: 'preset', presetId: 'mp-main' } as any,
            subModelBinding: { mode: 'preset', presetId: 'mp-sub' } as any,
            taskModelBindings: { memory: { mode: 'preset', presetId: 'mp-mem' } } as any,
        }
        const presetX = makeSeedPreset('id-x', 'Preset X', { ...entryOnlyFields })
        const presetY = makeSeedPreset('id-y', 'Preset Y', { mainPrompt: 'Y' })
        const initialDb = makeSyncedInitialDb({
            botPresets: [presetX, presetY],
            botPresetsId: 0,
            characters: [],
        } as any)

        const server = new MockServer(initialDb)
        const tabA = await createLiveTabHarness(server)

        // Switch away from X without editing X, then rebase against a server update to X.
        changeToPreset(1)
        server.overwriteDirectly((srv) => {
            srv.botPresets[0].mainPrompt = 'Remote X prompt'
        })
        await tabA.loop.flushWithRetries(emptyToSave({ root: true, botPreset: true }))

        expect(getDatabase().botPresets[0]).toMatchObject({
            id: 'id-x',
            mainPrompt: 'Remote X prompt',
            ...entryOnlyFields,
        })
    })

    test('Trap 6: selection -1 with a root edit survives a rebase and selection stays -1', async () => {
        const presetX = makeSeedPreset('id-x', 'Preset X', { temperature: 80 })
        const initialDb = makeSyncedInitialDb({
            botPresets: [presetX],
            botPresetsId: -1,
            temperature: 80,
            mainPrompt: 'Detached base',
            characters: [],
        } as any)

        const server = new MockServer(initialDb)
        const tabA = await createLiveTabHarness(server)

        getDatabase().temperature = 42
        getDatabase().mainPrompt = 'Detached local edit'

        // Tab B switches to Preset X on server.
        server.overwriteDirectly((srv) => {
            srv.botPresetsId = 0
            srv.temperature = 80
            srv.mainPrompt = 'Server X'
        })

        const res = await tabA.loop.flushWithRetries(emptyToSave({ root: true }))
        expect(res).toBe('saved')
        expect(getDatabase().botPresetsId).toBe(-1)
        expect(getDatabase().temperature).toBe(42)
        expect(getDatabase().mainPrompt).toBe('Detached local edit')
        expect(getDatabase().botPresets[0].temperature).toBe(80)
    })

    test('Trap 7: openAIKey edited in another tab reaches this tab across rebase', async () => {
        const presetX = makeSeedPreset('id-x', 'Preset X', { openAIKey: 'old-key' })
        const initialDb = makeSyncedInitialDb({
            botPresets: [presetX],
            botPresetsId: 0,
            openAIKey: 'old-key',
            characters: [],
        } as any)

        const server = new MockServer(initialDb)
        const tabA = await createLiveTabHarness(server)

        server.overwriteDirectly((srv) => {
            srv.openAIKey = 'sk-new-from-tab-b'
        })

        getDatabase().temperature = 77
        const res = await tabA.loop.flushWithRetries(emptyToSave({ root: true }))
        expect(res).toBe('saved')
        expect(getDatabase().openAIKey).toBe('sk-new-from-tab-b')
        expect(getDatabase().temperature).toBe(77)
    })

    test('settings a preset switch leaves alone here, or that no preset entry carries, still arrive from another tab', async () => {
        const presetX = makeSeedPreset('id-x', 'Preset X', {})
        const oldFallback = { model: ['old-model'], memory: [], emotion: [], translate: [], otherAx: [] }
        const newFallback = { model: ['new-model-from-b'], memory: [], emotion: [], translate: [], otherAx: [] }
        const initialDb = makeSyncedInitialDb({
            botPresets: [presetX],
            botPresetsId: 0,
            doNotChangeFallbackModels: true,
            fallbackModels: oldFallback,
            autoSuggestPrefix: 'old prefix',
            characters: [],
        } as any)

        const server = new MockServer(initialDb)
        const tabA = await createLiveTabHarness(server)

        server.overwriteDirectly((srv) => {
            srv.fallbackModels = newFallback
            srv.autoSuggestPrefix = 'prefix from tab B'
        })

        getDatabase().temperature = 77
        expect(await tabA.loop.flushWithRetries(emptyToSave({ root: true }))).toBe('saved')
        expect(getDatabase().fallbackModels).toEqual(newFallback)
        expect(getDatabase().autoSuggestPrefix).toBe('prefix from tab B')
        expect(getDatabase().temperature).toBe(77)
        // And A did not write its old values back.
        expect(server.strippedDb.fallbackModels).toEqual(newFallback)
        expect(server.strippedDb.autoSuggestPrefix).toBe('prefix from tab B')
    })

    test('which preset keys are per tab follows this tab\'s "keep on preset change" settings', () => {
        const all = getTabLocalPresetRootKeys({})
        expect(all.has('mainPrompt')).toBe(true)
        expect(all.has('fallbackModels')).toBe(true)
        expect(all.has('fallbackWhenBlankResponse')).toBe(true)
        expect(all.has('seperateParameters')).toBe(true)
        expect(all.has('autoSuggestPrefix')).toBe(false)
        expect(all.has('autoSuggestClean')).toBe(false)
        expect(all.has('openAIKey')).toBe(false)

        const keepFallback = getTabLocalPresetRootKeys({ doNotChangeFallbackModels: true })
        expect(keepFallback.has('fallbackModels')).toBe(false)
        expect(keepFallback.has('fallbackWhenBlankResponse')).toBe(false)
        expect(keepFallback.has('mainPrompt')).toBe(true)

        const keepSeparate = getTabLocalPresetRootKeys({ disableSeperateParameterChangeOnPresetChange: true })
        expect(keepSeparate.has('seperateParameters')).toBe(false)
        expect(keepSeparate.has('seperateParametersEnabled')).toBe(true)
    })

    test('Trap 8: preset selected in this tab and deleted in another tab stays with its content and later saveCurrentPreset() overwrites no other entry', async () => {
        const presetX = makeSeedPreset('id-x', 'Preset X', { mainPrompt: 'Keep X content', temperature: 88 })
        const presetY = makeSeedPreset('id-y', 'Preset Y', { mainPrompt: 'Keep Y intact', temperature: 33 })
        const initialDb = makeSyncedInitialDb({
            botPresets: [presetX, presetY],
            botPresetsId: 1, // Y is at 1; let's select X at 0 too — test when X is shifted or deleted!
            characters: [],
        } as any)
        initialDb.botPresetsId = 0
        setPreset(initialDb, presetX)

        const server = new MockServer(initialDb)
        const tabA = await createLiveTabHarness(server)

        // Tab B deletes Preset X on server, leaving only [Preset Y].
        server.overwriteDirectly((srv) => {
            srv.botPresets = [srv.botPresets[1]]
            srv.botPresetsId = 0
            applyPresetToRoot(srv, srv.botPresets[0])
        })

        getDatabase().customCSS = '/* rebase */'
        const res = await tabA.loop.flushWithRetries(emptyToSave({ root: true }))
        expect(res).toBe('saved')

        const presets = getDatabase().botPresets
        expect(presets.map((p) => p.id)).toEqual(['id-y', 'id-x'])
        expect(getDatabase().botPresetsId).toBe(1)
        expect(presets[1].mainPrompt).toBe('Keep X content')
        expect(presets[0].mainPrompt).toBe('Keep Y intact')

        // Later edit + saveCurrentPreset() writes into X (index 1), never Y (index 0).
        getDatabase().mainPrompt = 'Further edit on X'
        saveCurrentPreset()
        expect(getDatabase().botPresets[1].mainPrompt).toBe('Further edit on X')
        expect(getDatabase().botPresets[0].mainPrompt).toBe('Keep Y intact')
    })

    test('Trap 9: two rebases in a row — A on X; B switches to Y and saves; A rebases; B switches back to X, edits it, saves; A rebases again -> A root has B edit', async () => {
        const presetX = makeSeedPreset('id-x', 'Preset X', { mainPrompt: 'X v1', temperature: 80 })
        const presetY = makeSeedPreset('id-y', 'Preset Y', { mainPrompt: 'Y v1', temperature: 50 })
        const initialDb = makeSyncedInitialDb({
            botPresets: [presetX, presetY],
            botPresetsId: 0,
            mainPrompt: 'X v1',
            temperature: 80,
            characters: [],
        } as any)

        const server = new MockServer(initialDb)
        const tabA = await createLiveTabHarness(server)

        // 1) B switches to Y and saves.
        server.overwriteDirectly((srv) => {
            srv.botPresetsId = 1
            applyPresetToRoot(srv, srv.botPresets[1])
        })

        // 2) A rebases (#1).
        getDatabase().customCSS = '/* rebase 1 */'
        expect(await tabA.loop.flushWithRetries(emptyToSave({ root: true }))).toBe('saved')
        expect(getDatabase().botPresetsId).toBe(0)
        expect(getDatabase().mainPrompt).toBe('X v1')
        expect(liveUnitSyncState.isPresetDirty(getDatabase())).toBe(false)

        // 3) B switches back to X, edits X, and saves.
        server.overwriteDirectly((srv) => {
            srv.botPresetsId = 0
            srv.botPresets[0].mainPrompt = 'X v2 from B'
            srv.botPresets[0].temperature = 62
            applyPresetToRoot(srv, srv.botPresets[0])
        })

        // 4) A rebases (#2) -> A's root receives B's edit to X!
        getDatabase().customCSS = '/* rebase 2 */'
        expect(await tabA.loop.flushWithRetries(emptyToSave({ root: true }))).toBe('saved')
        expect(getDatabase().botPresetsId).toBe(0)
        expect(getDatabase().botPresets[0].mainPrompt).toBe('X v2 from B')
        expect(getDatabase().botPresets[0].temperature).toBe(62)
        expect(getDatabase().mainPrompt).toBe('X v2 from B')
        expect(getDatabase().temperature).toBe(62)
    })

    test('Trap 10: personas mirror section 1 base test, unedited switch (2), boot defaults (3), selected deleted remotely (8), and two rebases in a row with saveUserPersona()', async () => {
        const rawServerDb = {
            personas: [
                { id: 'pers-1', name: 'Persona One', icon: 'icon-1', personaPrompt: 'Prompt 1' },
                { id: 'pers-2', name: 'Persona Two', icon: 'icon-2', personaPrompt: 'Prompt 2', note: 'Note 2' },
            ],
            selectedPersona: 0,
            username: 'Persona One',
            userIcon: 'icon-1',
            personaPrompt: 'Prompt 1',
            // userNote omitted on disk -> boot default sets ''
            characters: [],
        }

        const server = new MockServer(rawServerDb)
        const tabA = await createLiveTabHarness(server)

        // Trap 3 for personas: boot default userNote='' must NOT mark persona unit dirty.
        expect(liveUnitSyncState.isPersonaDirty(getDatabase())).toBe(false)

        // Base test + Trap 9 part 1 for personas: B switches to Persona Two and saves; A rebases.
        server.overwriteDirectly((srv) => {
            srv.selectedPersona = 1
            applyPersonaToRoot(srv, srv.personas[1])
        })
        getDatabase().customCSS = '/* persona rebase 1 */'
        expect(await tabA.loop.flushWithRetries(emptyToSave({ root: true }))).toBe('saved')
        expect(getDatabase().selectedPersona).toBe(0)
        expect(getDatabase().username).toBe('Persona One')
        expect(getDatabase().personaPrompt).toBe('Prompt 1')
        saveUserPersona()
        expect(getDatabase().personas[0]).toMatchObject({ id: 'pers-1', name: 'Persona One', personaPrompt: 'Prompt 1' })

        // B switches back to Persona One, edits it, and saves; A rebases again -> A root gets B's edit.
        server.overwriteDirectly((srv) => {
            srv.selectedPersona = 0
            srv.personas[0].personaPrompt = 'Prompt 1 edited by B'
            srv.personas[0].note = 'Note 1 from B'
            applyPersonaToRoot(srv, srv.personas[0])
        })
        getDatabase().customCSS = '/* persona rebase 2 */'
        expect(await tabA.loop.flushWithRetries(emptyToSave({ root: true }))).toBe('saved')
        expect(getDatabase().personaPrompt).toBe('Prompt 1 edited by B')
        expect(getDatabase().userNote).toBe('Note 1 from B')

        // Trap 2 for personas: changeUserPersona() on unedited Persona One does not make it a local win.
        changeUserPersona(1)
        expect(liveUnitSyncState.peekDirtyPersonaIds().has('pers-1')).toBe(false)
        server.overwriteDirectly((srv) => {
            srv.personas[0].name = 'Persona One Renamed by B'
        })
        expect(await tabA.loop.flushWithRetries(emptyToSave({ root: true }))).toBe('saved')
        expect(getDatabase().personas[0].name).toBe('Persona One Renamed by B')
        expect(getDatabase().selectedPersona).toBe(1)

        // Trap 8 for personas: selected Persona Two deleted in B stays in A with its content; saveUserPersona() safe.
        server.overwriteDirectly((srv) => {
            srv.personas = [srv.personas[0]]
            srv.selectedPersona = 0
            applyPersonaToRoot(srv, srv.personas[0])
        })
        getDatabase().customCSS = '/* persona rebase 3 */'
        expect(await tabA.loop.flushWithRetries(emptyToSave({ root: true }))).toBe('saved')
        expect(getDatabase().personas.map((p) => p.id)).toEqual(['pers-1', 'pers-2'])
        expect(getDatabase().selectedPersona).toBe(1)
        expect(getDatabase().personas[1].personaPrompt).toBe('Prompt 2')

        getDatabase().personaPrompt = 'Prompt 2 edited in A'
        saveUserPersona()
        expect(getDatabase().personas[1].personaPrompt).toBe('Prompt 2 edited in A')
        expect(getDatabase().personas[0].name).toBe('Persona One Renamed by B')
    })

    test('dirtyPresetIds and dirtyPersonaIds survive failed save attempts and clear only on accepted save', async () => {
        const presetX = makeSeedPreset('id-x', 'Preset X', { temperature: 80 })
        const initialDb = makeSyncedInitialDb({
            botPresets: [presetX],
            botPresetsId: 0,
            temperature: 80,
            personas: [{ id: 'p-1', name: 'U', icon: '', personaPrompt: 'P', note: '' }],
            selectedPersona: 0,
            username: 'U',
            userIcon: '',
            personaPrompt: 'P',
            userNote: '',
            characters: [],
        } as any)

        const server = new MockServer(initialDb)
        const tabA = await createLiveTabHarness(server)

        getDatabase().temperature = 99
        getDatabase().personaPrompt = 'New P'

        const origPatch = tabA.forageMock.patchItem
        tabA.forageMock.patchItem = async () => { throw new Error('network down') }
        await expect(tabA.loop.persistOnce(emptyToSave({ root: true }))).rejects.toThrow('network down')

        expect(liveUnitSyncState.peekDirtyPresetIds().has('id-x')).toBe(true)
        expect(liveUnitSyncState.peekDirtyPersonaIds().has('p-1')).toBe(true)

        tabA.forageMock.patchItem = origPatch
        expect(await tabA.loop.persistOnce(emptyToSave({ root: true, botPreset: true }))).toBe('saved')
        expect(liveUnitSyncState.peekDirtyPresetIds().size).toBe(0)
        expect(liveUnitSyncState.peekDirtyPersonaIds().size).toBe(0)
    })
})

describe('Traps 11, 12, 18: Per-item preset/module merges, ordering, asset guards, and id-less fallback', () => {
    test('Trap 11: B adds preset P and edits Q while A edits R -> all three exist after A rebase; same for modules', () => {
        const q = makeSeedPreset('id-q', 'Q', { mainPrompt: 'Q0' })
        const r = makeSeedPreset('id-r', 'R', { mainPrompt: 'R0' })
        const p = makeSeedPreset('id-p', 'P', { mainPrompt: 'P-new' })

        const base = {
            botPresets: [structuredClone(q), structuredClone(r)],
            botPresetsId: 1,
            modules: [
                { id: 'mod-q', name: 'Mod Q', description: 'orig' },
                { id: 'mod-r', name: 'Mod R', description: 'orig' },
            ],
            characters: [],
        } as any

        const remote = {
            ...structuredClone(base),
            botPresets: [
                { ...structuredClone(q), mainPrompt: 'Q-edited-by-B' },
                structuredClone(r),
                structuredClone(p),
            ],
            modules: [
                { id: 'mod-q', name: 'Mod Q', description: 'edited-by-B' },
                { id: 'mod-r', name: 'Mod R', description: 'orig' },
                { id: 'mod-p', name: 'Mod P', description: 'added-by-B' },
            ],
        }

        const local = {
            ...structuredClone(base),
            botPresets: [
                structuredClone(q),
                { ...structuredClone(r), mainPrompt: 'R-edited-by-A' },
            ],
            modules: [
                { id: 'mod-q', name: 'Mod Q', description: 'orig' },
                { id: 'mod-r', name: 'Mod R', description: 'edited-by-A' },
            ],
        }

        const toSave = emptyToSave({ botPreset: true, modules: true })
        const { mergedDb } = mergeServerDbWithTrackedLocalChanges(
            remote,
            local,
            toSave,
            structuredClone,
            convertStubsToPlaceholders,
            new Set(),
            base,
            normalizeJSON,
            { dirtyPresetIds: new Set(['id-r']), isPresetUnitDirty: true },
        )

        expect(mergedDb.botPresets.map((x) => [x.id, x.mainPrompt])).toEqual([
            ['id-q', 'Q-edited-by-B'],
            ['id-r', 'R-edited-by-A'],
            ['id-p', 'P-new'],
        ])
        expect(mergedDb.modules.map((m) => [m.id, m.description])).toEqual([
            ['mod-q', 'edited-by-B'],
            ['mod-r', 'edited-by-A'],
            ['mod-p', 'added-by-B'],
        ])
    })

    test('Section 4 ordering: local-only reordering of common entries uses local order; otherwise remote order with local-only appended', () => {
        const a = makeSeedPreset('a', 'A')
        const b = makeSeedPreset('b', 'B')
        const c = makeSeedPreset('c', 'C')
        const lNew = makeSeedPreset('l', 'L')
        const rNew = makeSeedPreset('r', 'R')

        const base = { botPresets: [a, b, c], botPresetsId: 0, characters: [] } as any
        const localReordered = { botPresets: [c, a, b, lNew], botPresetsId: 1, characters: [] } as any
        const remoteUnreordered = { botPresets: [a, b, c, rNew], botPresetsId: 0, characters: [] } as any

        const { mergedDb } = mergeServerDbWithTrackedLocalChanges(
            remoteUnreordered,
            localReordered,
            emptyToSave({ botPreset: true }),
            structuredClone,
            convertStubsToPlaceholders,
            new Set(),
            base,
            normalizeJSON,
        )
        expect(mergedDb.botPresets.map((p) => p.id)).toEqual(['c', 'a', 'b', 'l', 'r'])
        expect(mergedDb.botPresetsId).toBe(1) // 'a' moved to index 1
    })

    test('Trap 12: asset manifest loss-owner and conflict guards pass for module, persona embeddedModule, and character', () => {
        const modManifest = { id: 'man-mod', version: 1, count: 1, sha256: 'aa', ownerKind: 'module', ownerId: 'm1' }
        const perManifest = { id: 'man-per', version: 1, count: 1, sha256: 'bb', ownerKind: 'persona-module', ownerId: 'p1' }
        const perManifest2 = { id: 'man-per2', version: 1, count: 1, sha256: 'cc', ownerKind: 'persona-module', ownerId: 'p2' }
        const chrManifest = { id: 'man-chr', version: 1, count: 1, sha256: 'dd', ownerKind: 'character', ownerId: 'c1' }

        const base = {
            modules: [{ id: 'm1', name: 'M1', description: 'd0' }],
            personas: [
                { id: 'p1', name: 'P1', icon: '', personaPrompt: 'pp0', embeddedModule: { id: 'em1', name: 'EM', description: '' } },
                { id: 'p2', name: 'P2', icon: '', personaPrompt: 'pp2' },
            ],
            selectedPersona: 0,
            characters: [{ chaId: 'c1', name: 'C1', desc: 'd0', chats: [{ id: 'ch1', name: 'Chat 1', _stub: true }] }],
        } as any

        const remote = {
            modules: [{ id: 'm1', name: 'M1', description: 'd0', assetManifest: modManifest }],
            personas: [
                { id: 'p1', name: 'P1', icon: '', personaPrompt: 'pp0', embeddedModule: { id: 'em1', name: 'EM', description: '', assetManifest: perManifest } },
                { id: 'p2', name: 'P2', icon: '', personaPrompt: 'pp2', embeddedModule: { id: 'em2', name: 'EM2', description: '', assetManifest: perManifest2 } },
            ],
            selectedPersona: 0,
            characters: [{
                chaId: 'c1',
                name: 'C1',
                desc: 'd0',
                additionalAssetManifest: chrManifest,
                chats: [{ id: 'ch1', name: 'Chat 1', _stub: true }],
            }],
        } as any

        const local = {
            modules: [{ id: 'm1', name: 'M1-edited-by-A', description: 'd-local' }],
            personas: [
                { id: 'p1', name: 'P1', icon: '', personaPrompt: 'pp-local', embeddedModule: { id: 'em1', name: 'EM-edited', description: '' } },
                { id: 'p2', name: 'P2-edited', icon: '', personaPrompt: 'pp2-local' },
            ],
            selectedPersona: 0,
            characters: [{
                chaId: 'c1',
                name: 'C1',
                desc: 'desc-edited-by-A',
                chats: [{ id: 'ch1', name: 'Chat 1', message: [], note: '', localLore: [] }],
            }],
        } as any

        const { mergedDb } = mergeServerDbWithTrackedLocalChanges(
            remote,
            local,
            emptyToSave({ modules: true, character: ['c1'] }),
            structuredClone,
            convertStubsToPlaceholders,
            new Set(),
            base,
            normalizeJSON,
            { dirtyPersonaIds: new Set(['p1', 'p2']), isPersonaUnitDirty: true },
        )

        expect(mergedDb.modules[0].name).toBe('M1-edited-by-A')
        expect(mergedDb.modules[0].assetManifest).toEqual(modManifest)
        expect(mergedDb.personas[0].personaPrompt).toBe('pp-local')
        expect(mergedDb.personas[0].embeddedModule?.assetManifest).toEqual(perManifest)
        expect(mergedDb.personas[1].name).toBe('P2-edited')
        expect(mergedDb.personas[1].embeddedModule?.assetManifest).toEqual(perManifest2)
        expect(mergedDb.characters[0].desc).toBe('desc-edited-by-A')
        expect(mergedDb.characters[0].additionalAssetManifest).toEqual(chrManifest)
        expect(mergedDb.characters[0].additionalAssets).toBeUndefined()

        expect(assetManifestMigration.findAssetManifestConflicts(mergedDb)).toEqual([])
        expect(assetManifestMigration.findAssetManifestLossOwners(remote, mergedDb)).toEqual([])
    })

    test('Trap 18: an array with an id-less entry falls back to pre-existing behaviour while Section 1 still applies', () => {
        const base = {
            botPresets: [{ name: 'Idless Base', mainPrompt: 'B' }],
            botPresetsId: 0,
            personas: [{ name: 'Idless Persona', personaPrompt: 'PB' }],
            selectedPersona: 0,
            modules: [{ name: 'Idless Mod' }],
            temperature: 80,
            username: 'LocalUser',
            personaPrompt: 'LocalPersonaPrompt',
            globalChatVariables: { toggle_mode: 'old', shared: 'base' },
            characters: [],
        } as any

        const remote = {
            ...structuredClone(base),
            botPresets: [{ name: 'Idless Remote', mainPrompt: 'R' }, { id: 'p2', name: 'Remote2', mainPrompt: 'R2' }],
            botPresetsId: 1,
            temperature: 20,
            username: 'RemoteUser',
            personaPrompt: 'RemotePersonaPrompt',
            globalChatVariables: { toggle_mode: 'remote', toggle_extra: '1', shared: 'remote-updated' },
        }

        const local = {
            ...structuredClone(base),
            temperature: 80,
            username: 'LocalUser',
            personaPrompt: 'LocalPersonaPrompt',
            globalChatVariables: { toggle_mode: 'local-only', shared: 'base' },
        }

        // toSave.botPreset is false -> today's fallback keeps remote's botPresets array,
        // while Section 1 still keeps local preset unit, persona unit, and toggles!
        const { mergedDb } = mergeServerDbWithTrackedLocalChanges(
            remote,
            local,
            emptyToSave({ botPreset: false }),
            structuredClone,
            convertStubsToPlaceholders,
            new Set(),
            base,
            normalizeJSON,
        )

        expect(mergedDb.botPresets).toHaveLength(2)
        expect(mergedDb.temperature).toBe(80)
        expect(mergedDb.username).toBe('LocalUser')
        expect(mergedDb.personaPrompt).toBe('LocalPersonaPrompt')
        expect(mergedDb.globalChatVariables).toEqual({
            toggle_mode: 'local-only',
            shared: 'remote-updated',
        })
    })
})

describe('Traps 13–17: Characters, Chats, Hydration/Streaming, Deletions, Toggles & chatPage', () => {
    test('defaultNormalizeCharacter matches real characterFormatUpdate on detached blank character', () => {
        const raw1 = createBlankChar()
        delete (raw1 as any).creation_date
        const raw2 = structuredClone(raw1)

        const realNorm = characterFormatUpdate(raw1)
        const pureNorm = defaultNormalizeCharacter(raw2)

        delete (realNorm as any).creation_date
        delete (pureNorm as any).creation_date
        delete (realNorm as any).lastInteraction
        delete (pureNorm as any).lastInteraction

        expect(normalizeJSON(pureNorm)).toEqual(normalizeJSON(realNorm))
    })

    test('Trap 13: A chats in a character while B edits its description -> both survive', async () => {
        const char = createBlankChar()
        char.chaId = 'char-1'
        char.name = 'Heroine'
        char.desc = 'Initial description'
        char.chats = [{
            id: 'chat-1',
            name: 'Chat 1',
            message: [{ role: 'user', data: 'hi', chatId: 'm1' }],
            note: '',
            localLore: [],
            lastDate: 1000,
        }]

        const initialDb = makeSyncedInitialDb({
            characters: [char],
            characterOrder: ['char-1'],
        } as any)

        const server = new MockServer(initialDb)
        const tabA = await createLiveTabHarness(server)

        // Hydrate chat-1 in Tab A and send a new message.
        getDatabase().characters[0].chats[0] = structuredClone(char.chats[0])
        selectedCharID.set(0)
        getDatabase().characters[0].chats[0].message.push({ role: 'char', data: 'Reply in A', chatId: 'm2' })
        getDatabase().characters[0].chats[0].lastDate = 2000

        // Tab B edits description on the server.
        server.overwriteDirectly((srv) => {
            srv.characters[0].desc = 'Updated description from B'
        })

        const outcome = await tabA.loop.flushWithRetries(emptyToSave({
            character: ['char-1'],
            chat: [['char-1', 'chat-1']],
        }))
        expect(outcome).toBe('saved')

        expect(getDatabase().characters[0].desc).toBe('Updated description from B')
        expect(getDatabase().characters[0].chats[0].message).toHaveLength(2)
        expect(getDatabase().characters[0].chats[0].message[1].data).toBe('Reply in A')
        expect(getDatabase().characters[0].chats[0].lastDate).toBe(2000)
        expect(server.strippedDb.characters[0].desc).toBe('Updated description from B')
        expect(server.strippedDb.characters[0].chats[0].lastDate).toBe(2000)
    })

    test('Trap 14: B renames chat & moves to new folder while A has it hydrated and saves C2 or root -> rename, folder & folder entry survive; streaming chat keeps isStreaming', async () => {
        const c1 = createBlankChar()
        c1.chaId = 'c1'
        c1.name = 'C1'
        c1.chats = [{
            id: 'chat-1',
            name: 'Old Name',
            message: [{ role: 'user', data: 'hydrated msg', chatId: 'm1' }],
            note: '',
            localLore: [],
        }]
        const c2 = createBlankChar()
        c2.chaId = 'c2'
        c2.name = 'C2'

        const initialDb = makeSyncedInitialDb({
            characters: [c1, c2],
            characterOrder: ['c1', 'c2'],
        } as any)

        const server = new MockServer(initialDb)
        const tabA = await createLiveTabHarness(server)

        // Hydrate c1/chat-1 in Tab A.
        getDatabase().characters[0].chats[0] = structuredClone(c1.chats[0])

        // Tab B renames chat-1 and moves it into a new folder F1.
        server.overwriteDirectly((srv) => {
            srv.characters[0].chatFolders = [{ id: 'F1', name: 'Chapter 1', folded: false }]
            srv.characters[0].chats[0].name = 'Renamed by B'
            srv.characters[0].chats[0].folderId = 'F1'
        })

        // Case 14a: Tab A edits C2 and saves -> rebases & retries.
        getDatabase().characters[1].desc = 'C2 edit in A'
        expect(await tabA.loop.flushWithRetries(emptyToSave({ character: ['c2'] }))).toBe('saved')

        expect(getDatabase().characters[0].chatFolders).toEqual([{ id: 'F1', name: 'Chapter 1', folded: false }])
        expect(getDatabase().characters[0].chats[0].name).toBe('Renamed by B')
        expect(getDatabase().characters[0].chats[0].folderId).toBe('F1')
        expect(getDatabase().characters[0].chats[0].message[0].data).toBe('hydrated msg')
        // Server must NOT have had B's rename/folder reverted by A's retry patch!
        expect(server.strippedDb.characters[0].chats[0].name).toBe('Renamed by B')
        expect(server.strippedDb.characters[0].chats[0].folderId).toBe('F1')
        expect(server.strippedDb.characters[0].chatFolders).toEqual([{ id: 'F1', name: 'Chapter 1', folded: false }])

        // Case 14b: Tab B renames again while Tab A is actively streaming in chat-1 and saves a root key!
        startGeneration(chatGenKey('chat-1'), 'gen-1', 'live')
        getDatabase().characters[0].chats[0].isStreaming = true

        server.overwriteDirectly((srv) => {
            srv.characters[0].chats[0].name = 'Renamed While Streaming'
        })
        getDatabase().customCSS = '/* root save during stream */'
        expect(await tabA.loop.flushWithRetries(emptyToSave({ root: true }))).toBe('saved')

        expect(getDatabase().characters[0].chats[0].isStreaming).toBe(true)
        expect(getDatabase().characters[0].chats[0].name).toBe('Renamed While Streaming')
        expect(server.strippedDb.characters[0].chats[0].name).toBe('Renamed While Streaming')

        endGeneration(chatGenKey('chat-1'))
    })

    test('Trap 15: B deletes unopened chat -> gone; B deletes open chat -> kept & body re-uploaded; A deletes rebase-received chat -> stays deleted; import uploads all chat bodies', async () => {
        const c1 = createBlankChar()
        c1.chaId = 'c1'
        c1.name = 'C1'
        c1.chatPage = 0
        c1.chats = [
            { id: 'open-chat', name: 'Open Chat', message: [{ role: 'user', data: 'in open', chatId: 'm1' }], note: '', localLore: [] },
            { id: 'unopened-chat', name: 'Unopened Chat', message: [{ role: 'user', data: 'in unopened', chatId: 'm2' }], note: '', localLore: [] },
        ]
        const initialDb = makeSyncedInitialDb({
            characters: [c1],
            characterOrder: ['c1'],
        } as any)

        const server = new MockServer(initialDb)
        const tabA = await createLiveTabHarness(server)

        // Hydrate open-chat at index 0; leave unopened-chat at index 1 as placeholder.
        getDatabase().characters[0].chats[0] = structuredClone(c1.chats[0])
        selectedCharID.set(0)

        // 15a: B deletes unopened-chat AND adds b-new-chat.
        server.overwriteDirectly((srv) => {
            srv.characters[0].chats = [
                srv.characters[0].chats[0],
                { id: 'b-new-chat', name: 'From B', _stub: true },
            ]
        })

        getDatabase().characters[0].chats[0].lastDate = 5000
        expect(await tabA.loop.flushWithRetries(emptyToSave({
            character: ['c1'],
            chat: [['c1', 'open-chat']],
        }))).toBe('saved')

        // unopened-chat is gone; b-new-chat arrived through rebase.
        expect(getDatabase().characters[0].chats.map((c) => c.id)).toEqual(['open-chat', 'b-new-chat'])

        // 15b: A now deletes b-new-chat (which A first received through the rebase above!), while B edits C1.desc.
        getDatabase().characters[0].chats = [getDatabase().characters[0].chats[0]]
        server.overwriteDirectly((srv) => {
            srv.characters[0].desc = 'B desc edit'
        })
        expect(await tabA.loop.flushWithRetries(emptyToSave({ character: ['c1'] }))).toBe('saved')
        expect(getDatabase().characters[0].chats.map((c) => c.id)).toEqual(['open-chat'])
        expect(server.strippedDb.characters[0].chats.map((c: any) => c.id)).toEqual(['open-chat'])

        // 15c: B deletes open-chat while A has open-chat open -> kept AND its body is re-uploaded!
        tabA.uploadedChats.length = 0
        server.overwriteDirectly((srv) => {
            srv.characters[0].chats = [{ id: 'other-b', name: 'Other B', _stub: true }]
            srv.characters[0].chatPage = 0
        })
        getDatabase().customCSS = '/* trigger rebase while open-chat is open */'
        // Only a root key changed here: the character is not among the tracked changes.
        expect(await tabA.loop.flushWithRetries(emptyToSave({ root: true }))).toBe('saved')
        expect(getDatabase().characters[0].chats.map((c) => c.id)).toContain('open-chat')
        expect(tabA.uploadedChats.map((u) => `${u.chaId}/${u.chatId}`)).toContain('c1/open-chat')

        // 15d: Character import posts every chat body (even across a rebase).
        tabA.uploadedChats.length = 0
        const imported = createBlankChar()
        imported.chaId = 'imported-char'
        imported.name = 'Imported'
        imported.chats = [
            { id: 'imp-1', name: 'Imp 1', message: [{ role: 'char', data: 'hello 1', chatId: 'im1' }], note: '', localLore: [] },
            { id: 'imp-2', name: 'Imp 2', message: [{ role: 'char', data: 'hello 2', chatId: 'im2' }], note: '', localLore: [] },
        ]
        getDatabase().characters.push(imported)
        server.overwriteDirectly((srv) => {
            srv.customCSS = '/* concurrent B edit */'
        })
        expect(await tabA.loop.flushWithRetries(emptyToSave({ character: ['imported-char'] }))).toBe('saved')
        const uploadedKeys = tabA.uploadedChats.map((u) => `${u.chaId}/${u.chatId}`)
        expect(uploadedKeys).toContain('imported-char/imp-1')
        expect(uploadedKeys).toContain('imported-char/imp-2')
    })

    test('Trap 16: createBlankChar() + real changeChar() character deletion symmetry (all 4 cases) and checkCharOrder()', async () => {
        const blank = createBlankChar()
        blank.chaId = 'blank-1'
        blank.name = 'Blank One'
        // Confirm createBlankChar() has no creation_date.
        expect(blank.creation_date).toBeUndefined()

        const keeper = createBlankChar()
        keeper.chaId = 'keeper'
        keeper.name = 'Keeper'

        // ── 16a: Selected in A through real changeChar(), deleted in B -> gone in A, selection becomes -1
        {
            const initialDb = makeSyncedInitialDb({
                characters: [structuredClone(blank), structuredClone(keeper)],
                characterOrder: ['blank-1', 'keeper'],
            } as any)
            const server = new MockServer(initialDb)
            const tabA = await createLiveTabHarness(server)
            // Hydrate first chat so changeChar takes synchronous path cleanly.
            getDatabase().characters[0].chats[0] = structuredClone(blank.chats[0])

            changeChar(0)
            expect(get(selectedCharID)).toBe(0)
            expect(getDatabase().characters[0].creation_date).toEqual(expect.any(Number))

            // B deletes blank-1 on server.
            server.overwriteDirectly((srv) => {
                srv.characters = [srv.characters[1]]
                srv.characterOrder = ['keeper']
            })

            expect(await tabA.loop.flushWithRetries(emptyToSave({ character: ['blank-1'] }))).toBe('saved')
            expect(getDatabase().characters.map((c) => c.chaId)).toEqual(['keeper'])
            expect(get(selectedCharID)).toBe(-1)
        }

        // ── 16b: Edited in A, deleted in B -> kept in A
        {
            const initialDb = makeSyncedInitialDb({
                characters: [structuredClone(blank), structuredClone(keeper)],
                characterOrder: ['blank-1', 'keeper'],
            } as any)
            const server = new MockServer(initialDb)
            const tabA = await createLiveTabHarness(server)
            getDatabase().characters[0].chats[0] = structuredClone(blank.chats[0])

            changeChar(0)
            getDatabase().characters[0].desc = 'Real edit in A'

            server.overwriteDirectly((srv) => {
                srv.characters = [srv.characters[1]]
                srv.characterOrder = ['keeper']
            })

            expect(await tabA.loop.flushWithRetries(emptyToSave({ character: ['blank-1'] }))).toBe('saved')
            expect(getDatabase().characters.map((c) => c.chaId)).toContain('blank-1')
            expect(getDatabase().characters.find((c) => c.chaId === 'blank-1')?.desc).toBe('Real edit in A')
            expect(getDatabase().characterOrder).toContain('blank-1')
        }

        // ── 16c: Deleted in A after B merely selected it (changeChar backfill) -> stays deleted
        {
            const initialDb = makeSyncedInitialDb({
                characters: [structuredClone(blank), structuredClone(keeper)],
                characterOrder: ['blank-1', 'keeper'],
            } as any)
            const server = new MockServer(initialDb)
            const tabA = await createLiveTabHarness(server)

            // B merely selects blank-1 (running characterFormatUpdate) and saves.
            server.overwriteDirectly((srv) => {
                characterFormatUpdate(srv.characters[0])
            })

            // A permanently deletes blank-1.
            await removeChar(0, 'Blank One', 'permanentForce')
            expect(getDatabase().characters.map((c) => c.chaId)).toEqual(['keeper'])

            expect(await tabA.loop.flushWithRetries(emptyToSave({ character: ['blank-1'], root: true }))).toBe('saved')
            expect(getDatabase().characters.map((c) => c.chaId)).toEqual(['keeper'])
            expect(server.strippedDb.characters.map((c: any) => c.chaId)).toEqual(['keeper'])
        }

        // ── 16d: Deleted in A, edited in B -> kept AND listed in characterOrder
        {
            const initialDb = makeSyncedInitialDb({
                characters: [structuredClone(blank), structuredClone(keeper)],
                characterOrder: ['blank-1', 'keeper'],
            } as any)
            const server = new MockServer(initialDb)
            const tabA = await createLiveTabHarness(server)

            // B edits blank-1 on server.
            server.overwriteDirectly((srv) => {
                characterFormatUpdate(srv.characters[0])
                srv.characters[0].desc = 'Edited in B before A deleted'
            })

            // A permanently deletes blank-1 (which also removes 'blank-1' from local characterOrder).
            await removeChar(0, 'Blank One', 'permanentForce')
            expect(getDatabase().characterOrder).toEqual(['keeper'])

            expect(await tabA.loop.flushWithRetries(emptyToSave({ character: ['blank-1'], root: true }))).toBe('saved')
            expect(getDatabase().characters.map((c) => c.chaId)).toContain('blank-1')
            expect(getDatabase().characters.find((c) => c.chaId === 'blank-1')?.desc).toBe('Edited in B before A deleted')
            expect(getDatabase().characterOrder).toContain('blank-1')
        }
    })

    test('Trap 17: chatPage stays on this tab chat for non-overlaid character; toggle_* stays exact local set (including unset); other globalChatVariables merge by key', () => {
        const base = {
            globalChatVariables: {
                toggle_keep: 'base-v',
                toggle_unset_locally: 'was-set',
                shared_unchanged: 'same',
                shared_local_edit: 'old',
                shared_remote_edit: 'old',
                shared_local_del: 'bye-local',
                shared_remote_del: 'bye-remote',
            },
            characters: [{
                chaId: 'non-overlaid',
                name: 'Non Overlaid',
                chatPage: 1,
                chats: [
                    { id: 'ch-0', name: 'Chat 0', _stub: true },
                    { id: 'ch-1', name: 'Chat 1', _stub: true },
                ],
            }],
        } as any

        const remote = {
            globalChatVariables: {
                toggle_keep: 'remote-v',
                toggle_unset_locally: 'still-set-remotely',
                toggle_remote_only: 'remote-only',
                shared_unchanged: 'same',
                shared_local_edit: 'old',
                shared_remote_edit: 'new-from-remote',
                shared_local_del: 'bye-local',
                shared_remote_added: 'added-remote',
            },
            characters: [{
                chaId: 'non-overlaid',
                name: 'Non Overlaid',
                chatPage: 0, // B switched to ch-new at 0 and shifted ch-1 to index 2!
                chats: [
                    { id: 'ch-new', name: 'Prepended by B', _stub: true },
                    { id: 'ch-0', name: 'Chat 0', _stub: true },
                    { id: 'ch-1', name: 'Chat 1', _stub: true },
                ],
            }],
        } as any

        const local = {
            globalChatVariables: {
                toggle_keep: 'local-v',
                toggle_local_only: '1',
                // toggle_unset_locally is deliberately absent here!
                shared_unchanged: 'same',
                shared_local_edit: 'new-from-local',
                shared_remote_edit: 'old',
                shared_remote_del: 'bye-remote',
                shared_local_added: 'added-local',
            },
            characters: [{
                chaId: 'non-overlaid',
                name: 'Non Overlaid',
                chatPage: 1, // ch-1 is open on this character in Tab A
                chats: [
                    stubToPlaceholder({ id: 'ch-0', name: 'Chat 0', _stub: true }),
                    stubToPlaceholder({ id: 'ch-1', name: 'Chat 1', _stub: true }),
                ],
            }],
        } as any

        // Notice toSave does NOT track 'non-overlaid'!
        const { mergedDb } = mergeServerDbWithTrackedLocalChanges(
            remote,
            local,
            emptyToSave({ root: true }),
            structuredClone,
            convertStubsToPlaceholders,
            new Set(),
            base,
            normalizeJSON,
        )

        // ch-1 is now at index 2 in remote's array -> chatPage re-anchored to 2!
        expect(mergedDb.characters[0].chatPage).toBe(2)
        expect(mergedDb.characters[0].chats[mergedDb.characters[0].chatPage].id).toBe('ch-1')

        // toggle_* keys are exact local set; non-toggle keys merged key by key with deletions!
        expect(mergedDb.globalChatVariables).toEqual({
            toggle_keep: 'local-v',
            toggle_local_only: '1',
            shared_unchanged: 'same',
            shared_local_edit: 'new-from-local',
            shared_remote_edit: 'new-from-remote',
            shared_remote_added: 'added-remote',
            shared_local_added: 'added-local',
        })
        expect('toggle_unset_locally' in mergedDb.globalChatVariables).toBe(false)
        expect('toggle_remote_only' in mergedDb.globalChatVariables).toBe(false)
        expect('shared_local_del' in mergedDb.globalChatVariables).toBe(false)
        expect('shared_remote_del' in mergedDb.globalChatVariables).toBe(false)

        // Also check fallback when local's chatPage chat no longer exists remotely -> remote's chatPage clamped into range.
        const remoteWithoutCh1 = structuredClone(remote)
        remoteWithoutCh1.characters[0].chats = [{ id: 'ch-0', name: 'Chat 0', _stub: true }]
        remoteWithoutCh1.characters[0].chatPage = 99
        const { mergedDb: clampedDb } = mergeServerDbWithTrackedLocalChanges(
            remoteWithoutCh1,
            local,
            emptyToSave({ root: true }),
            structuredClone,
            convertStubsToPlaceholders,
            new Set(),
            base,
            normalizeJSON,
        )
        expect(clampedDb.characters[0].chatPage).toBe(0)
    })
})
