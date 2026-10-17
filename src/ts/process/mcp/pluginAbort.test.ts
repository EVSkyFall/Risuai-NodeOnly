import { beforeEach, describe, expect, test, vi } from 'vitest'
vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => ({ mcp: [] }) }))
vi.mock('src/ts/process/modules', () => ({ getModuleMcps: () => ['plugin:test'] }))
vi.mock('src/ts/stores.svelte', () => ({ DBState: { db: {} } }))
vi.mock('src/ts/alert', () => ({ alertInput: vi.fn(), notifySuccess: vi.fn(), notifyError: vi.fn() }))
vi.mock('src/ts/util', () => ({ sleep: vi.fn() }))
vi.mock('./mcplib', () => ({ MCPClient: class {} }))
vi.mock('src/ts/storage/persistentKv', () => ({
    makeEncodedStorageKey: vi.fn(), readPersistentJson: vi.fn(), writePersistentJson: vi.fn(),
}))
import { MCPs, getTools, callTool } from './mcp'

beforeEach(() => { for (const key of Object.keys(MCPs)) delete MCPs[key] })
describe('plugin MCP Stop', () => {
    test('tool discovery cannot hold an aborted request', async () => {
        const entered = vi.fn()
        MCPs['plugin:test'] = { getToolList: () => { entered(); return new Promise(() => {}) } } as any
        const controller = new AbortController()
        const pending = getTools(controller.signal)
        for (let i = 0; i < 30; i++) await Promise.resolve()
        expect(entered).toHaveBeenCalledOnce()
        controller.abort()
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    })
    test('a late tool result is discarded', async () => {
        let resolve!: (value: any) => void
        const next = vi.fn()
        MCPs['plugin:test'] = {
            getToolList: async () => [{ name: 'test', inputSchema: {} }],
            callTool: () => new Promise(r => { resolve = r }),
        } as any
        const controller = new AbortController()
        const pending = callTool('test', {}, controller.signal).then(next)
        for (let i = 0; i < 50; i++) await Promise.resolve()
        expect(resolve).toBeTypeOf('function')
        controller.abort()
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        resolve([{ type: 'text', text: 'late' }])
        for (let i = 0; i < 20; i++) await Promise.resolve()
        expect(next).not.toHaveBeenCalled()
    })
})
