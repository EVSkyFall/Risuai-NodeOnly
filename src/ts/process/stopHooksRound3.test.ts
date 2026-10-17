import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { get, writable } from 'svelte/store'
import { afterEach, expect, test, vi } from 'vitest'
import { raceAbort, throwIfAborted } from './abort'
import { endAllGenerations, endGeneration, generationStates, registerAbort, startGeneration, chatGenKey } from './generationState'

function source(path: string) { return readFileSync(`src/${path}`, 'utf8') }
function evaluate(code: string, deps: Record<string, any>) {
    const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
    return new Function(...Object.keys(deps), js)(...Object.values(deps))
}
function functionSource(path: string, name: string) {
    const text = source(path)
    const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name)!
    return node.getText(ast).replace(/^export /, '')
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
afterEach(() => { endAllGenerations(); vi.restoreAllMocks() })

test.each(['input', 'slash'].flatMap(entry => ['command', 'v2Command'].map(command => ({ entry, command }))))('no Stop: $entry / $command chain keeps both multisend model calls', async ({ entry, command }) => {
    const chat = { id: 'nested-chat', message: [] as any[] }
    const char = { type: 'character', chatPage: 0, chats: [chat], triggerscript: [
        { type: 'input', comment: 'entry', conditions: [], effect: [{ type: 'command', value: '/trigger recursive' }] },
        { type: 'manual', comment: 'recursive', conditions: [], effect: [{ type: 'runtrigger', value: 'v2' }] },
        { type: 'manual', comment: 'v2', conditions: [], effect: [{ type: 'v2RunTrigger', target: 'send' }] },
        { type: 'manual', comment: 'send', conditions: [], effect: [{ type: command, valueType: 'value', value: '/multisend "first|||second"' }] },
    ] }
    const controller = new AbortController()
    registerAbort(chat.id, controller)
    startGeneration(chat.id, 'input-owner')
    const model = vi.fn()
    const deps = {
        raceAbort, throwIfAborted, get, chatGenKey, endGeneration, generationStates, registerAbort, startGeneration,
        getDatabase: () => ({ characters: [char] }), getCurrentCharacter: () => char, getCurrentChat: () => chat,
        setCurrentChat: vi.fn(), selectedCharID: writable(0), risuChatParser: (v: string) => v,
        getModuleTriggers: () => [], parseKeyValue: () => [], CurrentTriggerIdStore: writable(null),
        safeStructuredClone: (v: any) => structuredClone(v),
        sendChat: async () => {
            if (get(generationStates).has(chat.id)) return false
            startGeneration(chat.id, 'model-send')
            model()
            endGeneration(chat.id)
            return true
        },
    }
    const commands = source('ts/process/command.ts').replace(/^import .*$/gm, '').replace(/^export /gm, '')
    const api = evaluate(commands + '\n' + functionSource('ts/process/triggers.ts', 'runTrigger') + '\nreturn { processMultiCommand, runTrigger }', deps)
    if (entry === 'input') await api.runTrigger(char, 'input', { chat, signal: controller.signal, inputGenerationId: 'input-owner' })
    else await api.processMultiCommand('/trigger entry', controller.signal, 'input-owner')
    expect(model).toHaveBeenCalledTimes(2)
    expect(chat.message.map(m => m.data)).toEqual(['"first', 'second"'])
    expect(get(generationStates).get(chat.id)?.generationId).toBe('input-owner')
})

const interceptorLoops = ['ts/globalApi.svelte.ts', 'ts/process/request/google.ts'].flatMap(path => {
    const ast = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true)
    const loops: { name: string, code: string }[] = []
    function visit(node: ts.Node) {
        if (ts.isForOfStatement(node) && node.expression.getText(ast) === 'bodyIntercepterStore') {
            loops.push({ name: `${path}:${loops.length}`, code: node.getText(ast) })
        }
        ts.forEachChild(node, visit)
    }
    visit(ast)
    return loops
})
test.each(interceptorLoops)('$name discards late body and skips later interceptors on Stop', async ({ code }) => {
    const controller = new AbortController()
    let release!: (v: string) => void
    const later = vi.fn()
    const arg = { body: 'original', interceptor: 'test', signal: controller.signal, abortSignal: controller.signal }
    const execute = evaluate(`return async () => { let body = arg.body; ${code}; return body }`, {
        arg, raceAbort, throwIfAborted, value: {}, data: { usageMetadata: {} },
        bodyIntercepterStore: [{ callback: () => new Promise(r => { release = r }) }, { callback: later }],
    })
    const pending = execute()
    await flush()
    controller.abort()
    let outcome: any
    pending.then(() => { outcome = 'resolved' }, (e: any) => { outcome = e.name })
    await flush()
    expect(outcome).toBe('AbortError')
    release('late')
    await flush()
    expect(arg.body).toBe('original')
    expect(later).not.toHaveBeenCalled()
})
test.each(interceptorLoops)('$name keeps ordinary errors fail-open', async ({ code }) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const later = vi.fn(() => 'updated')
    const arg = { body: 'original', interceptor: 'test' }
    const result = await evaluate(`return (async () => { let body = arg.body; ${code}; return body })()`, {
        arg, raceAbort, throwIfAborted, value: {}, data: { usageMetadata: {} },
        bodyIntercepterStore: [{ callback: () => { throw new Error('plugin') } }, { callback: later }],
    })
    expect(later).toHaveBeenCalledOnce()
    if (code.includes('arg.body =')) expect(arg.body).toBe('updated')
    if (code.includes('body =') && !code.includes('arg.body =')) expect(result).toBe('updated')
})

function batchHarness(signal: AbortSignal) {
    const path = 'ts/process/request/anthropic.ts'
    const ast = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true)
    let block = ''
    function visit(node: ts.Node) {
        if (ts.isIfStatement(node) && node.expression.getText(ast) === 'db.claudeBatching') block = node.thenStatement.getText(ast)
        ts.forEachChild(node, visit)
    }
    visit(ast)
    const cancel = vi.fn(async () => {})
    const trackerPath = 'ts/process/request/claudeBatchTracker.ts'
    const tracker = evaluate('const activeStreams = new Map();\n' + ['registerBatchStream', 'unregisterBatchStream', 'applyResultToMessage'].map(n => functionSource(trackerPath, n)).join('\n') + '\nreturn { registerBatchStream, unregisterBatchStream, applyResultToMessage, activeStreams }', { getDatabase: () => ({ characters: [] }) })
    const pending = evaluate(`return (async () => ${block})()`, {
        body: {}, headers: {}, replacerURL: 'https://example.invalid', arg: { abortSignal: signal },
        submitClaudeBatch: async () => ({ batchId: 'batch' }), ...tracker, cancelClaudeBatch: cancel,
        throwIfAborted, ReadableStream,
    })
    return { pending, tracker, cancel }
}
test.each(['complete', 'closed', 'completion-error', 'cancel', 'abort'])('batch %s removes listener and Stop cannot throw from it', async mode => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const { pending, tracker, cancel } = batchHarness(controller.signal)
    const result = await pending
    const subscriber = tracker.activeStreams.get('batch')
    const listener = add.mock.calls.find(c => c[0] === 'abort')![1] as () => void
    if (mode === 'completion-error') {
        subscriber.controller.close()
        await tracker.applyResultToMessage('batch', 'done')
    }
    if (mode === 'complete') await tracker.applyResultToMessage('batch', 'done')
    if (mode === 'closed') {
        subscriber.controller.close()
        controller.abort()
        expect(() => listener()).not.toThrow()
    }
    if (mode === 'cancel') await result.result.cancel()
    if (mode === 'abort') controller.abort()
    expect(remove).toHaveBeenCalledWith('abort', listener)
    if (mode === 'complete' || mode === 'cancel' || mode === 'completion-error') {
        controller.abort()
        expect(cancel).not.toHaveBeenCalled()
    }
})
