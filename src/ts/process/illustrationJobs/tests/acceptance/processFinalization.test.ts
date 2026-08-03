import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { InMemoryLockManager } from '../inMemoryLockManager'

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
    hasher: vi.fn(async () => new Uint8Array(32)),
}))

vi.mock('src/ts/storage/database.svelte', () => ({
    changeToPreset: vi.fn(),
    getDatabase: () => harness.database,
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
    processScriptFull: vi.fn(async (_: unknown, value: string) => ({ data: value, emoChanged: false })),
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
    resolveChatModelBinding: vi.fn(() => ({ kind: 'legacy' })),
    resolvePresetMaxOutputTokens: vi.fn(() => undefined),
}))
vi.mock('src/ts/process/memory/hypav3', () => ({ hypaMemoryV3: vi.fn() }))
vi.mock('src/ts/process/modules', () => ({
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
