import { expect, test, vi } from 'vitest'
import fs from 'node:fs'
import ts from 'typescript'

const source = fs.readFileSync('src/lib/CharacterManager/CharacterManager.svelte', 'utf8').split('</script>')[0].replace(/<script[^>]*>/, '')
const ast = ts.createSourceFile('manager.ts', source, ts.ScriptTarget.Latest, true)

test.each([0, 20])('C4: cancelling after %s completed characters does not report a save failure', done => {
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'reportBulk')!
    const error = vi.fn(), success = vi.fn()
    const js = ts.transpileModule(node.getText(ast) + '; return reportBulk;', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
    const report = new Function('alertError', 'notifySuccess', 'language', 'bulkList', js)(error, success, { bulkArchiveDone: n => `done:${n}` }, vi.fn())
    report({ done, failed: [], lost: [], stopped: true }, false)
    expect(error).not.toHaveBeenCalled()
    expect(success).toHaveBeenCalledTimes(done ? 1 : 0)
})

test.each(['bulkDeactivate', 'bulkTrash'])('C3: %s retains selections for every character whose chunk did not complete', async name => {
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name)!
    const db = { characters: Array.from({ length: 25 }, (_, i) => ({ chaId: `c${i}` })) }
    const targets = db.characters.map(c => ({ ...c, archived: false }))
    const deps = {
        DBState: { db }, selectedEntries: () => targets,
        queueBulkAction: fn => fn(), alertConfirm: async () => true,
        language: { deactivateSelectedConfirm: () => '', trashSelectedConfirm: () => '' },
        archiveCharacters: async () => { db.characters.splice(0, 20); throw new Error('last chunk failed') },
        alertError: vi.fn(), trashDeactivatedCharacter: () => false,
    }
    const js = ts.transpileModule(`const { ${Object.keys(deps).join(',')} } = deps;
        let selectedIds = new Set(targets.map(t => t.chaId));
        ${node.getText(ast)}
        return { run: ${name}, selected: () => [...selectedIds] };
    `, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
    const api = new Function('deps', 'targets', js)(deps, targets)
    await api.run()
    expect(api.selected()).toEqual(['c20', 'c21', 'c22', 'c23', 'c24'])
})
