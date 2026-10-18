import { test, expect, vi } from 'vitest'
import fs from 'node:fs'
import ts from 'typescript'
import { raceAbort, throwIfAborted } from '../abort'

vi.mock('src/ts/globalApi.svelte', () => ({ forageStorage: {} }))
const { ModelJobBusyError, ModelJobConnectionLostError } = await import('./jobFetch')
const source = fs.readFileSync('src/ts/process/request/request.ts', 'utf8')
const ast = ts.createSourceFile('request.ts', source, ts.ScriptTarget.Latest, true)
const fn = (name: string) => ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name)!
const presetTry = fn('requestModelPreset').body!.statements.find((node): node is ts.TryStatement => ts.isTryStatement(node) && !!node.catchClause?.block.statements.some(ts.isReturnStatement))!
const failedResult = presetTry.catchClause!.block.statements.find(ts.isReturnStatement)!.getText(ast)
function evaluate(code: string, deps: Record<string, unknown>) {
    const js = ts.transpileModule(`const { ${Object.keys(deps).join(',')} } = deps; ${code}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
    return new Function('deps', js)(deps)
}

test.each(['model', 'memory'])('a transient job connection loss remains retryable for %s requests', async mode => {
    const failed = evaluate(failedResult, {
        err: new ModelJobConnectionLostError(), ModelJobBusyError, ModelJobConnectionLostError,
        wireModel: 'wire-model', preset: { name: 'Preset' },
    })
    const dispatch = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce({ type: 'success', result: 'reattached response', model: 'wire-model' })
    const request = evaluate(`${fn('requestChatDataInner').getText(ast)}; return requestChatDataInner;`, {
        getDatabase: () => ({ requestRetrys: 1 }), safeStructuredClone: structuredClone,
        getTools: async () => [], risuUnescape: (x: string) => x,
        pluginV2: { replacerbeforeRequest: new Set(), replacerafterRequest: new Set() },
        getCurrentCharacter: () => undefined, shouldStageMainRequestSnapshot: () => false,
        requestChatDataMain: dispatch, raceAbort, throwIfAborted,
        console: { warn: vi.fn(), error: vi.fn() },
    })
    const arg = { replayExact: true, formated: [{ role: 'user', content: 'request' }], ...(mode === 'model' ? { chatId: 'same-generation', realChatId: 'chat' } : {}) }
    await expect(request(arg, mode)).resolves.toMatchObject({ type: 'success', result: 'reattached response' })
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch.mock.calls[0][0].chatId).toBe(dispatch.mock.calls[1][0].chatId)
})
