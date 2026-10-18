import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { InMemoryLockManager } from '../inMemoryLockManager'
import { raceAbort } from '../../../abort'

const harness = vi.hoisted(() => {
    function createStore<T>(initial: T) {
        let value = initial
        return {
            subscribe(run: (next: T) => void) {
                run(value)
                return () => undefined
            },
            set(next: T) {
                value = next
            },
        }
    }

    return {
        realScripts: false,
        editoutput: new Set<(...args: any[]) => any>(),
        storageMap: new Map<string, Uint8Array>(),
        database: null as any,
        selectedChar: createStore(0),
        charEmotion: createStore<Record<string, Array<[string, string, number]>>>({}),
        currentTurnId: null as string | null,
        requestChatData: vi.fn(),
        strictSave: vi.fn(),
        hypaAddText: vi.fn(),
        hypaSearch: vi.fn(),
    }
})

vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: {
        async Init() {},
        async keys(prefix = '') {
            return [...harness.storageMap.keys()].filter((key) => key.startsWith(prefix))
        },
        async getItem(key: string) {
            return harness.storageMap.get(key) ?? null
        },
        async setItem(key: string, value: Uint8Array) {
            harness.storageMap.set(key, new Uint8Array(value))
        },
        async removeItem(key: string) {
            harness.storageMap.delete(key)
        },
    },
    getCurrentTurnId: () => harness.currentTurnId,
    readImage: vi.fn(async () => null),
    setCurrentTurnId: (turnId: string | null) => {
        harness.currentTurnId = turnId
    },
}))

vi.mock('src/ts/parser/parser.svelte', () => ({
    risuChatParser: (value: string) => value,
    assetRegex: /NEVER_MATCH/g,
    hasher: vi.fn(async () => new Uint8Array(32)),
}))

vi.mock('src/ts/storage/database.svelte', () => ({
    changeToPreset: vi.fn(),
    getDatabase: () => harness.database,
    getCurrentCharacter: () => harness.database.characters[0],
    getCurrentChat: () => harness.database.characters[0].chats[0],
    normalizeChat: (chat: unknown) => chat,
    setCurrentChat: vi.fn(),
}))

vi.mock('src/ts/storage/chatStorage', () => ({
    ensureChatHydrated: vi.fn(async (chats: unknown[], index: number) => chats[index] ?? null),
    saveChatToServerStrict: harness.strictSave,
}))

vi.mock('src/ts/stores.svelte', () => ({
    DBState: {
        get db() {
            return harness.database
        },
    },
    CharEmotion: harness.charEmotion,
    selectedCharID: harness.selectedChar,
}))

vi.mock('src/ts/tokenizer', () => ({
    ChatTokenizer: class {
        async tokenizeChat() {
            return 1
        }
    },
    tokenize: vi.fn(async () => 1),
    tokenizeNum: vi.fn(async () => []),
}))

vi.mock('src/lang', () => ({ language: { errors: {} } }))
vi.mock('src/ts/alert', () => ({ alertError: vi.fn(), notifyError: vi.fn() }))
vi.mock('src/ts/parser/chatML', () => ({ parseChatML: vi.fn(() => []) }))
vi.mock('src/ts/process/lorebook.svelte', () => ({
    loadLoreBookV3Prompt: vi.fn(async () => ({ actives: [] })),
}))
vi.mock('src/ts/util', () => ({
    findCharacterbyId: vi.fn(),
    getAuthorNoteDefaultText: vi.fn(() => ''),
    getPersonaPrompt: vi.fn(() => ''),
    getUserName: vi.fn(() => 'User'),
    isLastCharPunctuation: vi.fn(() => true),
    trimUntilPunctuation: vi.fn((value: string) => value),
    parseToggleSyntax: vi.fn(() => []),
    prebuiltAssetCommand: '',
}))
vi.mock('src/ts/process/request/request', () => ({
    requestChatData: harness.requestChatData,
    requestChatDataMain: vi.fn(async () => {
        throw new Error('requestChatDataMain must not run in process finalization acceptance')
    }),
}))
vi.mock('src/ts/process/request/requestReplay', () => ({
    commitMainRequestSnapshot: vi.fn(),
}))
vi.mock('src/ts/process/stableDiff', () => ({
    stableDiff: vi.fn(),
    generateAIImageTyped: vi.fn(async () => {
        throw new Error('image provider must not run in process finalization acceptance')
    }),
}))
vi.mock('src/ts/process/scripts', () => ({
    armStreamingScriptCircuit: vi.fn(),
    disarmStreamingScriptCircuit: vi.fn(),
    isStreamingScriptTripped: vi.fn(() => false),
    processScript: vi.fn((_: unknown, value: string) => ({ data: value, emoChanged: false })),
    processScriptFull: vi.fn(async (...args: any[]) => {
        if (harness.realScripts) {
            const actual = await vi.importActual<typeof import('../../../scripts')>('src/ts/process/scripts')
            return (actual.processScriptFull as any)(...args)
        }
        return { data: args[1], emoChanged: false }
    }),
    risuChatParser: vi.fn((value: string) => value),
    STREAM_SCRIPT_BUDGET_MS: 1_000,
    tripStreamingScriptCircuit: vi.fn(),
}))
vi.mock('src/ts/process/exampleMessages', () => ({ exampleMessage: vi.fn(() => []) }))
vi.mock('src/ts/process/tts', () => ({ sayTTS: vi.fn() }))
vi.mock('src/ts/process/triggers', () => ({ runTrigger: vi.fn(async () => undefined) }))
vi.mock('src/ts/process/memory/hypamemory', () => ({
    HypaProcesser: class {
        addText = harness.hypaAddText
        similaritySearchScored = harness.hypaSearch
    },
}))
vi.mock('src/ts/process/embedding/addinfo', () => ({ additionalInformations: vi.fn(async () => '') }))
vi.mock('src/ts/process/files/inlays', () => ({ getInlayAsset: vi.fn(async () => null) }))
vi.mock('src/ts/process/models/modelString', () => ({ getGenerationModelString: vi.fn(() => 'fake-model') }))
vi.mock('src/ts/process/inlayScreen', () => ({
    runInlayScreen: vi.fn((_: unknown, text: string) => ({ text })),
}))
vi.mock('src/ts/process/transformers', () => ({ runImageEmbedding: vi.fn() }))
vi.mock('src/ts/process/scriptings', () => ({
    runLuaEditTrigger: vi.fn(async (_: unknown, __: string, value: unknown) => value),
}))
vi.mock('src/ts/model/modellist', () => ({
    getModelInfo: vi.fn(() => ({ flags: [] })),
    LLMFlags: { hasImageInput: 'hasImageInput' },
}))
vi.mock('src/ts/process/request/modelPresetBinding', () => ({
    resolveClassicModelId: vi.fn(() => undefined),
    resolveChatModelBinding: vi.fn(() => ({ kind: 'legacy' })),
    resolvePresetMaxOutputTokens: vi.fn(() => undefined),
}))
vi.mock('src/ts/process/memory/hypav3', () => ({ hypaMemoryV3: vi.fn() }))
vi.mock('src/ts/plugins/plugins.svelte', () => ({ pluginV2: { editoutput: harness.editoutput, chatOutput: new Set() } }))
vi.mock('src/ts/parser/assetListHydration', () => ({ hydrateAssetListsForCbs: vi.fn(async () => {}) }))
vi.mock('src/ts/process/modules', () => ({
    getModuleRegexScripts: () => [],
    getModuleTriggers: () => [],
    getModules: () => [],
    getModuleAssets: vi.fn(() => []),
    getModuleToggles: vi.fn(() => ''),
}))

const featureModule = await import('../../featureFlag')
const capturePolicyModule = await import('../../capturePolicy')
const lockModule = await import('../../locks')
const operationLockModule = await import('../../operationLock')
const storeModule = await import('../../store')
const processModule = await import('../../../index.svelte')
const generationStateModule = await import('../../../generationState')

const { setIllustrationFeatureEnabled } = featureModule
const { writeDurableCaptureMode } = capturePolicyModule
const {
    resetIllustrationLockManagerAccessorForTests,
    setIllustrationLockManagerAccessorForTests,
} = lockModule
const {
    resetIllustrationOperationLockManagerAccessorForTests,
    setIllustrationOperationLockManagerAccessorForTests,
} = operationLockModule
const { illustrationJobStore } = storeModule
const { sendChat } = processModule
const { endAllGenerations } = generationStateModule

function installDatabase(emotionProcesser: string) {
    harness.database = {
        statics: { messages: 0 },
        presetChain: '',
        botPresets: [],
        botPresetsId: 0,
        aiModel: 'gpt-test',
        maxContext: 4_096,
        maxResponse: 128,
        outputImageModal: false,
        rememberToolUsage: false,
        removeIncompleteResponse: false,
        ttsAutoSpeech: false,
        autoContinueMinTokens: 0,
        autoContinueChat: false,
        igpPrompt: '',
        notification: false,
        promptInfoInsideChat: false,
        emotionProcesser,
        emotionPrompt2: '',
        sdProvider: 'novelai',
        NAIImgUrl: 'https://image.novelai.net/ai/generate-image',
        NAIImgModel: 'nai-diffusion-4-5-full',
        NAII2I: false,
        NAIImgConfig: {},
        inlayImageLossless: true,
        characters: [{
            customscript: [],
            triggerscript: [],
            type: 'character',
            chaId: 'character-process-finalization',
            name: 'Character',
            image: '',
            desc: '',
            emotionImages: [
                ['happy', 'happy.png'],
                ['sad', 'sad.png'],
            ],
            viewScreen: 'emotion',
            inlayViewScreen: false,
            chatPage: 0,
            lastInteraction: 0,
            reloadKeys: 0,
            chats: [{
                id: 'conversation-process-finalization',
                name: 'Chat',
                note: '',
                localLore: [],
                fmIndex: -1,
                message: [{
                    role: 'user',
                    data: 'Generate a response.',
                    chatId: 'message-user',
                    time: 0,
                }],
            }],
        }],
    }
}

function replayRequest() {
    return {
        formated: [{ role: 'user' as const, content: 'replay' }],
        biasString: [],
        staticModel: 'fake-model',
        forGenerationId: 'old-generation',
        capturedAt: 0,
    }
}

async function expectOneCapturedTurn(rootTurnId: string) {
    await vi.waitFor(async () => {
        expect(await illustrationJobStore.listTurns()).toHaveLength(1)
    })
    const turns = await illustrationJobStore.listTurns()
    expect(turns[0]).toMatchObject({
        state: 'awaiting_plan',
        sourceTextUtf16: 'Generated response.',
        target: { rootTurnId },
    })
    expect(harness.strictSave).toHaveBeenCalledTimes(1)
}

beforeEach(async () => {
    harness.realScripts = false
    harness.editoutput.clear()
    harness.storageMap.clear()
    harness.currentTurnId = null
    harness.requestChatData.mockReset()
    harness.strictSave.mockReset().mockResolvedValue({ success: true, durable: true })
    harness.hypaAddText.mockReset().mockResolvedValue(undefined)
    harness.hypaSearch.mockReset().mockResolvedValue([
        ['emotion:happy', 1],
        ['emotion:sad', 0.5],
    ])
    harness.selectedChar.set(0)
    harness.charEmotion.set({})
    endAllGenerations()
    const lockManager = new InMemoryLockManager()
    setIllustrationLockManagerAccessorForTests(() => lockManager)
    setIllustrationOperationLockManagerAccessorForTests(() => lockManager)
    await setIllustrationFeatureEnabled(true)
    // These acceptance tests exercise the automatic terminal-capture seam, so the
    // durable capture policy must be 'automatic' for admission to proceed.
    await writeDurableCaptureMode('automatic')
})

afterEach(() => {
    endAllGenerations()
    resetIllustrationLockManagerAccessorForTests()
    resetIllustrationOperationLockManagerAccessorForTests()
})

describe('Gate 4d process terminal-capture acceptance', () => {
    // §20 Finalization: the emotion-embedding early return must still capture the root turn.
    test('captures the root turn through the real emotion-embedding sendChat exit', async () => {
        installDatabase('embedding')
        const modes: string[] = []
        harness.requestChatData.mockImplementation(async (_request: unknown, mode: string) => {
            modes.push(mode)
            return { type: 'success', result: 'Generated response.' }
        })

        await expect(sendChat(-1, {
            copilotTurnId: 'root-emotion-embedding',
            replayRequest: replayRequest(),
        } as any)).resolves.toBe(true)

        expect(modes).toEqual(['model'])
        expect(harness.hypaSearch).toHaveBeenCalledTimes(1)
        await expectOneCapturedTurn('root-emotion-embedding')
    })

    // §20 Finalization: the emotion-LLM early return must still capture the root turn.
    test('captures the root turn through the real emotion-LLM sendChat exit', async () => {
        installDatabase('llm')
        const modes: string[] = []
        harness.requestChatData.mockImplementation(async (_request: unknown, mode: string) => {
            modes.push(mode)
            return mode === 'model'
                ? { type: 'success', result: 'Generated response.' }
                : { type: 'success', result: 'happy' }
        })

        await expect(sendChat(-1, {
            copilotTurnId: 'root-emotion-llm',
            replayRequest: replayRequest(),
        } as any)).resolves.toBe(true)

        expect(modes).toEqual(['model', 'emotion'])
        expect(harness.hypaSearch).not.toHaveBeenCalled()
        await expectOneCapturedTurn('root-emotion-llm')
    })
})


describe('Stop during sendChat editOutput', () => {
    test.each([false, true])('hung editOutput settles and ignores a late result (streaming=%s)', async streaming => {
        installDatabase('embedding')
        harness.realScripts = true
        let release!: (value: string) => void
        let started!: () => void
        const entered = new Promise<void>(resolve => { started = resolve })
        harness.editoutput.add(() => { started(); return new Promise(resolve => { release = resolve }) })
        harness.requestChatData.mockResolvedValue(streaming
            ? { type: 'streaming', result: new ReadableStream({ start(controller) { controller.enqueue({ '0': 'Generated response.' }); controller.close() } }) }
            : { type: 'success', result: 'Generated response.' })
        const controller = new AbortController()
        const key = 'conversation-process-finalization'
        generationStateModule.registerAbort(key, controller)
        let settled: boolean | undefined
        const pending = sendChat(-1, { signal: controller.signal, replayRequest: replayRequest() }).then(value => { settled = value })
        await entered
        expect(generationStateModule.isChatGenerating(key)).toBe(true)
        generationStateModule.abortGeneration(key)
        for (let i = 0; i < 100; i++) await Promise.resolve()
        expect(settled).toBe(false)
        expect(generationStateModule.isChatGenerating(key)).toBe(false)
        const chat = harness.database.characters[0].chats[0]
        expect(chat.isStreaming).not.toBe(true)
        const saved = JSON.stringify(chat)
        release('LATE EDIT MUST NOT APPEAR')
        for (let i = 0; i < 100; i++) await Promise.resolve()
        expect(JSON.stringify(chat)).toBe(saved)
        await pending
    })
})

test.each(['abort', 'late resolve', 'ordinary rejection', 'no Stop'])('multi-candidate inlays handle every promise: %s', async outcome => {
    installDatabase('embedding')
    await setIllustrationFeatureEnabled(false)
    const { runInlayScreen } = await import('../../../inlayScreen')
    const { runTrigger } = await import('../../../triggers')
    const controller = new AbortController()
    let release!: (value: string) => void
    let reject!: (error: Error) => void
    let outputStarted!: () => void
    let releaseOutput!: () => void
    const entered = new Promise<void>(resolve => { outputStarted = resolve })
    vi.mocked(runTrigger).mockImplementation(async (_char, mode) => {
        if (mode === 'output') {
            outputStarted()
            await new Promise<void>(resolve => { releaseOutput = resolve })
        }
        return undefined
    })
    vi.mocked(runInlayScreen).mockImplementation((_char, text, signal) => ({
        text,
        promise: text === 'first'
            ? Promise.resolve('first inlay')
            : outcome === 'late resolve'
                ? new Promise<string>(resolve => { release = resolve })
                : raceAbort(() => new Promise<string>((resolve, fail) => { release = resolve; reject = fail }), signal),
    }))
    harness.requestChatData.mockResolvedValue({ type: 'multiline', result: [['char', 'first'], ['char', 'second']] })
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
        const pending = sendChat(-1, { signal: controller.signal, replayRequest: replayRequest() })
        await entered
        expect(harness.database.characters[0].chats[0].message.at(-1).data).toBe('first inlay')
        if (outcome === 'abort' || outcome === 'late resolve') controller.abort()
        if (outcome === 'ordinary rejection') reject(new Error('image failed'))
        if (outcome === 'no Stop') release('second inlay')
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(unhandled).not.toHaveBeenCalled()
        releaseOutput()
        expect(await pending).toBe(outcome === 'ordinary rejection' || outcome === 'no Stop')
        const saved = JSON.stringify(harness.database.characters[0].chats[0])
        release('late second inlay')
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(JSON.stringify(harness.database.characters[0].chats[0])).toBe(saved)
        expect(unhandled).not.toHaveBeenCalled()
    } finally {
        process.off('unhandledRejection', unhandled)
        vi.mocked(runInlayScreen).mockImplementation((_, text) => ({ text }))
        vi.mocked(runTrigger).mockImplementation(async () => undefined)
    }
})
