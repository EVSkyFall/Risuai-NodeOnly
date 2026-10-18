import { expect, test, vi } from 'vitest'
import fs from 'node:fs'
import ts from 'typescript'

test('S6: failed server cold-reference scan rejects instead of returning locally unreferenced inlays', async () => {
    const source = fs.readFileSync('src/ts/process/files/inlays.ts', 'utf8')
    const ast = ts.createSourceFile('inlays.ts', source, ts.ScriptTarget.Latest, true)
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'scanInlayReferences')!
    const local = vi.fn(() => ({ refCounts: {}, totalMessages: 0 }))
    const error = new Error('Cold chat inlay references could not be read (missing)')
    const storage = { fetchInlayReferences: vi.fn().mockRejectedValue(error) }
    const js = ts.transpileModule(node.getText(ast).replace('export ', '') + '; return scanInlayReferences;', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
    const scan = new Function('forageStorage', 'scanLocalInlayReferences', js)({ realStorage: storage }, local)
    await expect(scan()).rejects.toBe(error)
    expect(local).not.toHaveBeenCalled()
})
