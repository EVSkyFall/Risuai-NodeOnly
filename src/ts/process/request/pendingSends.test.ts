import { afterEach, describe, expect, test, vi } from 'vitest'
import { get } from 'svelte/store'

const mocks = vi.hoisted(() => ({
    db: { nodeOnlyServerSideRequests: true } as any,
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: { createAuth: async () => 'test-auth' },
}))
vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => mocks.db,
}))

async function loadModule() {
    vi.resetModules()
    return await import('./pendingSends')
}

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('pendingSends', () => {
    test('per-chat chain keeps register → clear in call order even when register is slow', async () => {
        const order: string[] = []
        let releaseRegister: () => void = () => {}
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const method = init?.method ?? 'GET'
            if (method === 'POST') {
                // Slow register: without the chain, the DELETE would overtake it.
                await new Promise<void>((r) => { releaseRegister = r })
                order.push('register')
            } else if (method === 'DELETE') {
                order.push('clear')
            }
            return new Response('{}', { status: 200 })
        }))
        const pending = await loadModule()

        pending.registerPendingSend('chat-1', 'gen-1')
        pending.clearPendingSend('chat-1', 'gen-1')
        await new Promise((r) => setTimeout(r, 10))
        expect(order).toEqual([]) // clear queued behind the stalled register
        releaseRegister()
        await vi.waitFor(() => expect(order).toEqual(['register', 'clear']))
    })

    test('registration is toggle-gated; clearing is not', async () => {
        const calls: string[] = []
        vi.stubGlobal('fetch', vi.fn(async (_: RequestInfo | URL, init?: RequestInit) => {
            calls.push(init?.method ?? 'GET')
            return new Response('{}', { status: 200 })
        }))
        mocks.db = { nodeOnlyServerSideRequests: false }
        const pending = await loadModule()

        pending.registerPendingSend('chat-1', 'gen-1')
        pending.clearPendingSend('chat-1', 'gen-1')
        await vi.waitFor(() => expect(calls).toEqual(['DELETE']))
    })

    test('claim returns true only on a confirmed server claim', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{"claimed":true}', { status: 200 })))
        const pending = await loadModule()
        expect(await pending.claimPendingSend('chat-1', 'gen-1')).toBe(true)

        vi.stubGlobal('fetch', vi.fn(async () => new Response('{"claimed":false}', { status: 200 })))
        expect(await pending.claimPendingSend('chat-1', 'gen-1')).toBe(false)

        vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 }))) // older server
        expect(await pending.claimPendingSend('chat-1', 'gen-1')).toBe(false)

        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('down') }))
        expect(await pending.claimPendingSend('chat-1', 'gen-1')).toBe(false)
    })

    test('takeResumable consumes exactly once; markResumable restores', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
        const pending = await loadModule()
        pending.markResumable('chat-1', 'gen-1')
        expect(pending.takeResumable('chat-1')).toEqual({ generationId: 'gen-1' })
        expect(pending.takeResumable('chat-1')).toBeUndefined()
        pending.markResumable('chat-1')
        expect(get(pending.resumableSends).has('chat-1')).toBe(true)
    })

    test('an old generation clear does not remove a newer local resume flag', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{"cleared":false}', { status: 200 })))
        const pending = await loadModule()
        pending.markResumable('chat-1', 'generation-new')

        pending.clearPendingSend('chat-1', 'generation-old')

        expect(get(pending.resumableSends).get('chat-1')).toEqual({ generationId: 'generation-new' })
    })

    test('resume keeps raw chatId for HTTP and a distinct generationKey for state callbacks', async () => {
        const calls: { url: string, method: string, body?: string }[] = []
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input)
            const method = init?.method ?? 'GET'
            calls.push({ url, method, body: init?.body as string | undefined })
            if (url.endsWith('/claim')) return new Response('{"claimed":true}', { status: 200 })
            return new Response('{"success":true}', { status: 200 })
        }))
        mocks.db = { nodeOnlyServerSideRequests: true }
        const pending = await loadModule()
        const stateCalls: string[] = []

        pending.registerPendingSend('chat-1', 'generation-1')
        pending.markResumable('chat-1', 'generation-1')
        const record = pending.takeResumable('chat-1')
        const result = await pending.resumePendingSend({
            chatId: 'chat-1',
            generationId: record?.generationId,
            generationKey: 'gen::chat-1',
            isRunnable: () => true,
            endsOnUser: () => true,
            beginGeneration: (key) => { stateCalls.push(`begin:${key}`) },
            endGeneration: (key) => { stateCalls.push(`end:${key}`) },
            send: async () => {
                stateCalls.push('send')
                pending.registerPendingSend('chat-1', 'generation-2')
                pending.clearPendingSend('chat-1', 'generation-2')
            },
        })

        expect(result).toBe('resumed')
        expect(stateCalls).toEqual(['begin:gen::chat-1', 'send', 'end:gen::chat-1'])
        await vi.waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true))
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'POST /api/pending-sends',
            'POST /api/pending-sends/chat-1/claim',
            'POST /api/pending-sends',
            'DELETE /api/pending-sends/chat-1',
        ])
        expect(calls[0].body).toContain('"chatId":"chat-1"')
        expect(calls[1].body).toContain('"generationId":"generation-1"')
        expect(calls[2].body).toContain('"generationId":"generation-2"')
        expect(calls[3].body).toContain('"generationId":"generation-2"')
    })

    test('post-claim invalidation restores only on confirmed insert-if-absent', async () => {
        for (const restored of [true, false]) {
            vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input)
                if (url.endsWith('/claim')) return new Response('{"claimed":true}', { status: 200 })
                if (url.endsWith('/restore')) {
                    return new Response(JSON.stringify({ restored }), { status: 200 })
                }
                throw new Error(`unexpected fetch: ${url}`)
            }))
            const pending = await loadModule()
            let checks = 0
            const result = await pending.resumePendingSend({
                chatId: 'chat-1',
                generationId: 'generation-1',
                generationKey: 'gen::chat-1',
                isRunnable: () => ++checks === 1,
                endsOnUser: () => true,
                beginGeneration: () => { throw new Error('must not begin') },
                endGeneration: () => { throw new Error('must not end') },
                send: async () => { throw new Error('must not send') },
            })

            expect(result).toBe(restored ? 'deferred' : 'lost')
            expect(get(pending.resumableSends).get('chat-1')).toEqual(
                restored ? { generationId: 'generation-1' } : undefined,
            )
        }
    })

    test('a changed tail concludes by clearing the raw-chat tombstone', async () => {
        const calls: string[] = []
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
            return new Response('{"success":true}', { status: 200 })
        }))
        const pending = await loadModule()

        const result = await pending.resumePendingSend({
            chatId: 'chat-1',
            generationId: 'generation-1',
            generationKey: 'gen::chat-1',
            isRunnable: () => true,
            endsOnUser: () => false,
            beginGeneration: () => {},
            endGeneration: () => {},
            send: async () => {},
        })

        expect(result).toBe('concluded')
        await vi.waitFor(() => expect(calls).toEqual(['DELETE /api/pending-sends/chat-1']))
    })

    test('a tail that changes while claim is pending concludes without sending', async () => {
        const calls: string[] = []
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
            if (String(input).endsWith('/claim')) return new Response('{"claimed":true}', { status: 200 })
            return new Response('{"success":true}', { status: 200 })
        }))
        const pending = await loadModule()
        let tailChecks = 0
        const send = vi.fn(async () => {})

        const result = await pending.resumePendingSend({
            chatId: 'chat-1',
            generationId: 'generation-1',
            generationKey: 'gen::chat-1',
            isRunnable: () => true,
            endsOnUser: () => ++tailChecks === 1,
            beginGeneration: () => { throw new Error('must not begin') },
            endGeneration: () => { throw new Error('must not end') },
            send,
        })

        expect(result).toBe('concluded')
        expect(send).not.toHaveBeenCalled()
        await vi.waitFor(() => expect(calls).toEqual([
            'POST /api/pending-sends/chat-1/claim',
            'DELETE /api/pending-sends/chat-1',
        ]))
    })
})
