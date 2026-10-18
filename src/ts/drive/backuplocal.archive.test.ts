import { expect, test, vi } from 'vitest'
import fs from 'node:fs'
import ts from 'typescript'

const source = fs.readFileSync('src/ts/drive/backuplocal.ts', 'utf8')

test('S2: partial backup keeps unavailable archive stubs alongside successfully inlined characters', async () => {
    const start = source.indexOf('    // Deactivated characters live server-side;')
    const end = source.indexOf('    // Plugin values live in the server kv', start)
    const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
    const db = {
        characters: [{ chaId: 'live' }],
        nodeOnlyArchivedCharacters: [{ chaId: 'good', archivedAt: 1 }, { chaId: 'gone', archivedAt: 2 }],
    }
    const warn = vi.fn()
    const assemble = new Function('dbCopy', 'fetchArchivedCharactersInline', 'alertWait', 'notifyInfo', `return (async () => { ${code} })()`)
    await assemble(db, async () => ({ characters: [{ chaId: 'good' }], warnings: ['gone: payload unavailable; stub retained'] }), vi.fn(), warn)
    expect(db.characters.map(c => c.chaId)).toEqual(['live', 'good'])
    expect(db.nodeOnlyArchivedCharacters).toEqual([{ chaId: 'gone', archivedAt: 2 }])
    expect(warn).toHaveBeenCalledWith('gone: payload unavailable; stub retained')
})

test('S2: successful server backup displays its warning notes', async () => {
    const ast = ts.createSourceFile('backuplocal.ts', source, ts.ScriptTarget.Latest, true)
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'SaveServerBackup')!
    const js = ts.transpileModule(node.getText(ast).replace('export ', '') + '; return SaveServerBackup;', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
    const notice = vi.fn(), success = vi.fn(), error = vi.fn()
    const save = new Function('forageStorage', 'language', 'alertWait', 'notifySuccess', 'notifyInfo', 'alertError', 'formatBytes', js)(
        { saveServerBackup: async () => ({ ok: true, filename: 'backup.bin', size: 1, warnings: ['gone: stub retained'] }) },
        { serverBackupSaving: 'saving', serverBackupSaveSuccess: () => 'saved' }, vi.fn(), success, notice, error, String,
    )
    expect(await save()).toBe(true)
    expect(success).toHaveBeenCalledWith('saved')
    expect(notice).toHaveBeenCalledWith('gone: stub retained')
    expect(error).not.toHaveBeenCalled()
})
