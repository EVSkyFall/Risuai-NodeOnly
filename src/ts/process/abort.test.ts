import { describe, expect, test, vi } from 'vitest'
import { raceAbort } from './abort'

describe('raceAbort', () => {
    test('skips a hook when Stop happened before invocation', async () => {
        const controller = new AbortController()
        const hook = vi.fn()
        controller.abort()
        await expect(raceAbort(hook, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
        expect(hook).not.toHaveBeenCalled()
    })
    test.each([false, true])('starts the hook without delaying its subscription (signal: %s)', async withSignal => {
        const signal = withSignal ? new AbortController().signal : undefined
        const hook = vi.fn(() => 'ok')
        const pending = raceAbort(hook, signal)
        expect(hook).toHaveBeenCalledTimes(1)
        await expect(pending).resolves.toBe('ok')
    })
    test('cleans up after a synchronous hook error', async () => {
        const controller = new AbortController()
        const remove = vi.spyOn(controller.signal, 'removeEventListener')
        const failure = new Error('guest error')
        await expect(raceAbort(() => { throw failure }, controller.signal)).rejects.toBe(failure)
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    })
    test('Stop wins even if a hook resolves in the same turn', async () => {
        const controller = new AbortController()
        let resolve!: (value: string) => void
        const pending = raceAbort(() => new Promise<string>(r => { resolve = r }), controller.signal)
        await Promise.resolve()
        resolve('late')
        controller.abort()
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    })
    test('observes a late rejection and removes the abort listener', async () => {
        const controller = new AbortController()
        const remove = vi.spyOn(controller.signal, 'removeEventListener')
        let reject!: (reason: Error) => void
        const pending = raceAbort(() => new Promise((_, r) => { reject = r }), controller.signal)
        await Promise.resolve()
        controller.abort()
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        reject(new Error('guest failed later'))
        await Promise.resolve()
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    })
    test('without Stop returns the value and preserves errors', async () => {
        await expect(raceAbort(() => 'ok')).resolves.toBe('ok')
        const failure = new Error('guest error')
        await expect(raceAbort(() => { throw failure })).rejects.toBe(failure)
    })
})
