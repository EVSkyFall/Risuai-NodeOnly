// @vitest-environment node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { beforeAll, expect, test, vi } from 'vitest'

vi.mock('../parser/parser.svelte', () => ({
  hasher: vi.fn(),
  risuChatParser: vi.fn(),
}))

vi.mock('../alert', () => ({
  alertConfirm: vi.fn(),
  alertError: vi.fn(),
  alertInput: vi.fn(),
  alertNormal: vi.fn(),
  alertSelect: vi.fn(),
}))

vi.mock('../globalApi.svelte', () => ({ fetchNative: vi.fn(), readImage: vi.fn() }))
vi.mock('../tokenizer', () => ({ tokenize: vi.fn() }))
vi.mock('../util', () => ({
  asBuffer: vi.fn(),
  getPersonaPrompt: vi.fn(),
  getUserIcon: vi.fn(),
  getUserName: vi.fn(),
}))

vi.mock('../storage/database.svelte', () => ({
  getCurrentCharacter: vi.fn(() => ({})),
  getCurrentChat: vi.fn(() => ({ message: [] })),
  getDatabase: vi.fn(() => ({ characters: [] })),
  setDatabase: vi.fn(),
}))

vi.mock('../stores.svelte', () => ({
  DBState: { db: {} },
  ReloadChatPointer: { update: vi.fn() },
  ReloadGUIPointer: { update: vi.fn() },
  selectedCharID: { subscribe: (run: (value: number) => void) => (run(0), () => undefined) },
}))

vi.mock('./modules', () => ({
  getModuleLorebooks: vi.fn(() => []),
  getModuleTriggers: vi.fn(() => []),
}))

vi.mock('./files/inlays', () => ({ getInlayAsset: vi.fn(), writeInlayImage: vi.fn(), InlayImageWriteError: class extends Error {} }))
vi.mock('./lorebook.svelte', () => ({ loadLoreBookV3Prompt: vi.fn() }))
vi.mock('./memory/hypamemory', () => ({ HypaProcesser: vi.fn() }))
vi.mock('./request/request', () => ({ requestChatData: vi.fn() }))
vi.mock('./stableDiff', () => ({ generateAIImage: vi.fn() }))

let runScripted: typeof import('./scriptings').runScripted

beforeAll(async () => {
  const jsonLua = await readFile(resolve(process.cwd(), 'public/lua/json.lua'), 'utf8')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(jsonLua, { status: 200 })))
  const scriptings = await import('./scriptings')
  runScripted = scriptings.runScripted
})

test('does not stop generation when setStateChanged is a no-op', async () => {
  const result = await runScripted(
    `
      function onStart(id)
        return setStateChanged(id, "unchanged", "value")
      end
    `,
    {
      char: {} as never,
      chat: { message: [] } as never,
      setVar: () => false,
      getVar: () => 'null',
      mode: 'start',
    }
  )

  expect(result.stopSending).toBe(false)
  expect(result.res).toBeNull()
})

test('keeps explicit false as the generation stop signal', async () => {
  const result = await runScripted('function onStart() return false end', {
    char: {} as never,
    chat: { message: [] } as never,
    mode: 'start',
  })

  expect(result.res).toBe(false)
  expect(result.stopSending).toBe(true)
})


test('Stop releases a Lua await, revokes its late writes, and leaves the engine usable', async () => {
  const { requestChatData } = await import('./request/request')
  let release!: (value: any) => void
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  vi.mocked(requestChatData).mockImplementationOnce(() => {
    started()
    return new Promise(resolve => { release = resolve })
  })
  const controller = new AbortController()
  const setVar = vi.fn()
  const code = `
    onStart = async(function(id)
      pcall(function() return simpleLLM(id, "wait"):await() end)
      setState(id, "late", "value")
    end)
  `
  const pending = runScripted(code, {
    char: {} as never, chat: { message: [] } as never,
    mode: 'start', lowLevelAccess: true, setVar, signal: controller.signal,
  })
  await entered
  expect(setVar).not.toHaveBeenCalled()
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(setVar).not.toHaveBeenCalled()
  release({ type: 'success', result: 'late' })
  vi.mocked(requestChatData).mockResolvedValue({ type: 'success', result: 'normal' })
  await runScripted(code, {
    char: {} as never, chat: { message: [] } as never,
    mode: 'start', lowLevelAccess: true, setVar,
  })
  expect(setVar).toHaveBeenCalledTimes(1)
  expect(setVar).toHaveBeenCalledWith('__late', '"value"')
})


test.each(['simpleLLM(id, "wait")', 'LLMMain(id, "[]")', 'axLLMMain(id, "[]")'])('unawaited Lua %s resolves cancellation without unhandledRejection', async call => {
  const { requestChatData } = await import('./request/request')
  let entered!: () => void
  const started = new Promise<void>(r => { entered = r })
  vi.mocked(requestChatData).mockImplementation(() => { entered(); return new Promise(() => {}) })
  const controller = new AbortController()
  const unhandled = vi.fn()
  process.on('unhandledRejection', unhandled)
  try {
    await runScripted(`function onStart(id) ${call}; return true end`, {
      char: {} as never, chat: { message: [] } as never,
      mode: 'start', lowLevelAccess: true, signal: controller.signal,
    })
    await started
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(unhandled).not.toHaveBeenCalled()
  } finally {
    process.off('unhandledRejection', unhandled)
  }
})

const asyncApiCases = [
  { api: 'getTokens', call: 'getTokens(id, "text")', cancelled: null, normal: 7 },
  { api: 'hash', call: 'hash(id, "text")', cancelled: null, normal: 'digest' },
  { api: 'similarity', call: 'similarity(id, "text", {"entry"})', cancelled: null, normal: ['entry'] },
  { api: 'request', call: 'request(id, "https://example.invalid/test")', cancelled: '{"status":400,"data":"internal error"}', normal: '{"status":200,"data":"body"}' },
  { api: 'generateImage', call: 'generateImage(id, "text")', cancelled: 'Error: Image generation failed', normal: '{{inlay::image-id}}' },
  { api: 'getCharacterImageMain', call: 'getCharacterImageMain(id)', cancelled: '', normal: '{{inlayed::image-id}}' },
  { api: 'getPersonaImageMain', call: 'getPersonaImageMain(id)', cancelled: '', normal: '{{inlayed::image-id}}' },
  { api: 'loadLoreBooksMain', call: 'loadLoreBooksMain(id, 0)', cancelled: '[]', normal: '[{"data":"book","role":"user"}]' },
  { api: 'alertInput', call: 'alertInput(id, "text")', cancelled: null, normal: 'answer' },
  { api: 'alertSelect', call: 'alertSelect(id, {"text"})', cancelled: null, normal: '0' },
  { api: 'alertConfirm', call: 'alertConfirm(id, "text")', cancelled: null, normal: true },
  { api: 'sleep', call: 'sleep(id, 50)', cancelled: null, normal: true },
]

async function configureAsyncApis() {
  const { tokenize } = await import('../tokenizer')
  const { hasher, risuChatParser } = await import('../parser/parser.svelte')
  const { fetchNative, readImage } = await import('../globalApi.svelte')
  const { generateAIImage } = await import('./stableDiff')
  const { writeInlayImage } = await import('./files/inlays')
  const { getDatabase } = await import('../storage/database.svelte')
  const { getUserIcon, asBuffer } = await import('../util')
  const { loadLoreBookV3Prompt } = await import('./lorebook.svelte')
  const { HypaProcesser } = await import('./memory/hypamemory')
  const { alertInput, alertSelect, alertConfirm } = await import('../alert')
  const addText = vi.fn(async () => {})
  const similaritySearch = vi.fn(async () => ['entry'])
  vi.mocked(HypaProcesser).mockImplementation(class { addText = addText; similaritySearch = similaritySearch } as any)
  vi.mocked(tokenize).mockResolvedValue(7)
  vi.mocked(hasher).mockResolvedValue('digest')
  vi.mocked(risuChatParser).mockImplementation(value => value)
  vi.mocked(fetchNative).mockResolvedValue(new Response('body'))
  vi.mocked(generateAIImage).mockResolvedValue('data:image/png;base64,eA==')
  vi.mocked(readImage).mockResolvedValue(new Uint8Array([1]))
  vi.mocked(writeInlayImage).mockResolvedValue('image-id')
  vi.mocked(getDatabase).mockReturnValue({ characters: [{ type: 'character', image: 'image.png' }], maxContext: 100 } as any)
  vi.mocked(getUserIcon).mockReturnValue('persona.png')
  vi.mocked(asBuffer).mockImplementation(value => value as any)
  vi.mocked(loadLoreBookV3Prompt).mockResolvedValue({ actives: [{ prompt: 'book', role: 'user' }] } as any)
  vi.mocked(alertInput).mockResolvedValue('answer')
  vi.mocked(alertSelect).mockResolvedValue('0')
  vi.mocked(alertConfirm).mockResolvedValue(true)
  vi.stubGlobal('Image', class { src = '' })
  return { getTokens: tokenize, hash: hasher, similarity: addText, request: fetchNative,
    generateImage: generateAIImage, getCharacterImageMain: readImage, getPersonaImageMain: readImage,
    loadLoreBooksMain: loadLoreBookV3Prompt, alertInput, alertSelect, alertConfirm, sleep: undefined }
}

test.each(asyncApiCases)('unawaited Lua $api keeps its call signal and never emits unhandledRejection on Stop', async ({ api, call, cancelled }) => {
  const mocks = await configureAsyncApis()
  const dependency = mocks[api as keyof typeof mocks]
  let release: (value?: any) => void = () => {}
  if (dependency) vi.mocked(dependency).mockImplementationOnce(() => new Promise(resolve => { release = resolve }) as any)
  const controller = new AbortController()
  const unhandled = vi.fn()
  const code = `
    runs = 0
    onStart = async(function(id)
      runs = runs + 1
      if runs == 1 then pending = ${call}; return true end
      if runs == 3 then return pending:await() end
      return true
    end)
  `
  const args = { char: {} as never, chat: { message: [] } as never, mode: 'start', lowLevelAccess: true }
  process.on('unhandledRejection', unhandled)
  try {
    await runScripted(code, { ...args, signal: controller.signal })
    await runScripted(code, { ...args, signal: new AbortController().signal })
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(unhandled).not.toHaveBeenCalled()
    expect((await runScripted(code, args)).res).toEqual(cancelled)
    release()
  } finally {
    process.off('unhandledRejection', unhandled)
    vi.unstubAllGlobals()
  }
})

test.each(asyncApiCases)('Lua $api preserves its no-Stop return contract', async ({ call, normal }) => {
  await configureAsyncApis()
  try {
    const result = await runScripted(`onStart = async(function(id) return ${call}:await() end)`, {
      char: {} as never, chat: { message: [] } as never, mode: 'start', lowLevelAccess: true,
    })
    expect(result.res).toEqual(normal)
  } finally {
    vi.unstubAllGlobals()
  }
})

test.each(asyncApiCases)('fire-and-forget Lua $api has no unhandledRejection after Stop', async ({ api, call }) => {
  const mocks = await configureAsyncApis()
  const dependency = mocks[api as keyof typeof mocks]
  if (dependency) vi.mocked(dependency).mockImplementationOnce(() => new Promise(() => {}) as any)
  const controller = new AbortController()
  const unhandled = vi.fn()
  process.on('unhandledRejection', unhandled)
  try {
    await runScripted(`function onStart(id) ${call}; return true end`, {
      char: {} as never, chat: { message: [] } as never,
      mode: 'start', lowLevelAccess: true, signal: controller.signal,
    })
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(unhandled).not.toHaveBeenCalled()
  } finally {
    process.off('unhandledRejection', unhandled)
    vi.unstubAllGlobals()
  }
})
