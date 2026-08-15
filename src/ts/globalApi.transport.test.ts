import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./process/modules', () => ({ moduleUpdate: vi.fn() }))

import {
    fetchNative,
    forageStorage,
    GlobalFetchTransportError,
    globalFetch,
    setCurrentTurnId,
} from './globalApi.svelte'
import { getDatabase } from './storage/database.svelte'
import { resetDirectFetchPolicyForTests } from './network/directFetchPolicy'

const REMOTE_URL = 'https://transport-truth.invalid/prompt'

describe('global fetch transport truth', () => {
    const originalFetch = globalThis.fetch
    const originalUserScriptFetch = window.userScriptFetch
    let originalUsePlainFetch: boolean | undefined

    beforeEach(() => {
        originalUsePlainFetch = getDatabase().usePlainFetch
        getDatabase().usePlainFetch = false
        window.userScriptFetch = undefined
        setCurrentTurnId('global-fetch-transport-test')
        resetDirectFetchPolicyForTests()
        vi.spyOn(forageStorage, 'createAuth').mockResolvedValue('test-auth')
    })

    afterEach(() => {
        getDatabase().usePlainFetch = originalUsePlainFetch as boolean
        globalThis.fetch = originalFetch
        window.userScriptFetch = originalUserScriptFetch
        setCurrentTurnId(null)
        vi.restoreAllMocks()
    })

    it.each([
        {
            name: 'plain fetch',
            arrange: (failure: Error) => {
                getDatabase().usePlainFetch = true
                globalThis.fetch = vi.fn().mockRejectedValue(failure)
            },
        },
        {
            name: 'userscript fetch',
            arrange: (failure: Error) => {
                window.userScriptFetch = vi.fn().mockRejectedValue(failure)
                globalThis.fetch = vi.fn()
            },
        },
        {
            name: 'proxy fetch',
            arrange: (failure: Error) => {
                globalThis.fetch = vi.fn().mockRejectedValue(failure)
            },
        },
    ])('passes through $name acquisition failures when requested', async ({ arrange }) => {
        const failure = new TypeError('response was lost')
        arrange(failure)

        await expect(globalFetch(REMOTE_URL, {
            method: 'POST',
            body: { prompt: {} },
            headers: {},
            throwOnTransportError: true,
        })).rejects.toMatchObject({
            globalFetchTransportError: true,
            dispatched: true,
            transportCause: failure,
        })
    })

    it('keeps the legacy synthesized failure result when pass-through is not requested', async () => {
        getDatabase().usePlainFetch = true
        globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('response was lost'))

        await expect(globalFetch(REMOTE_URL, {
            method: 'POST',
            body: { prompt: {} },
            headers: {},
        })).resolves.toMatchObject({
            ok: false,
            status: 400,
            headers: {},
            data: 'TypeError: response was lost',
        })
    })

    it('preserves an acquired HTTP status when decoding its body fails', async () => {
        getDatabase().usePlainFetch = true
        globalThis.fetch = vi.fn().mockResolvedValue(new Response('not-json', {
            status: 422,
            headers: {
                'content-type': 'application/json',
                'x-transport-route': 'plain',
            },
        }))

        await expect(globalFetch(REMOTE_URL, {
            method: 'POST',
            body: { prompt: {} },
            headers: {},
            throwOnTransportError: true,
        })).resolves.toMatchObject({
            ok: false,
            status: 422,
            headers: { 'x-transport-route': 'plain' },
        })
    })

    it('marks a pre-aborted request as definitely not dispatched', async () => {
        const controller = new AbortController()
        const reason = new DOMException('cancelled before dispatch', 'AbortError')
        controller.abort(reason)
        globalThis.fetch = vi.fn()

        await expect(globalFetch(REMOTE_URL, {
            method: 'POST',
            body: { prompt: {} },
            headers: {},
            abortSignal: controller.signal,
            throwOnTransportError: true,
        })).rejects.toMatchObject({
            globalFetchTransportError: true,
            dispatched: false,
            transportCause: reason,
        })
        expect(globalThis.fetch).not.toHaveBeenCalled()
    })

    it('marks createAuth rejection as pre-dispatch and never calls fetch', async () => {
        const failure = new TypeError('token refresh transport failed')
        vi.mocked(forageStorage.createAuth).mockRejectedValueOnce(failure)
        globalThis.fetch = vi.fn()

        await expect(globalFetch(REMOTE_URL, {
            method: 'POST',
            body: { prompt: {} },
            headers: {},
            throwOnTransportError: true,
        })).rejects.toMatchObject({
            globalFetchTransportError: true,
            dispatched: false,
            transportCause: failure,
        })
        expect(globalThis.fetch).not.toHaveBeenCalled()
    })

    it('keeps missing proxy headers on the pre-dispatch definite path', async () => {
        globalThis.fetch = vi.fn()

        await expect(globalFetch(REMOTE_URL, {
            method: 'POST',
            body: { prompt: {} },
            throwOnTransportError: true,
        })).rejects.toMatchObject({
            globalFetchTransportError: true,
            dispatched: false,
        })
        expect(forageStorage.createAuth).not.toHaveBeenCalled()
        expect(globalThis.fetch).not.toHaveBeenCalled()
    })

    it('does not dispatch after a signal aborts while createAuth is pending', async () => {
        const controller = new AbortController()
        const reason = new DOMException('timed out before proxy dispatch', 'TimeoutError')
        let resolveAuth!: (auth: string) => void
        vi.mocked(forageStorage.createAuth).mockReturnValueOnce(new Promise(resolve => {
            resolveAuth = resolve
        }))
        globalThis.fetch = vi.fn()

        const pending = globalFetch(REMOTE_URL, {
            method: 'POST',
            body: { prompt: {} },
            headers: {},
            abortSignal: controller.signal,
            throwOnTransportError: true,
        })
        controller.abort(reason)
        resolveAuth('late-auth')

        await expect(pending).rejects.toMatchObject({
            globalFetchTransportError: true,
            dispatched: false,
            transportCause: reason,
        })
        expect(globalThis.fetch).not.toHaveBeenCalled()
    })

    it('reports the userscript buffered body mode before waiting for its response', async () => {
        getDatabase().usePlainFetch = true
        let resolveResponse!: (response: Response) => void
        const responsePromise = new Promise<Response>((resolve) => {
            resolveResponse = resolve
        })
        window.userScriptFetch = vi.fn(() => responsePromise)
        const onResponseBodyMode = vi.fn()

        const pending = fetchNative(REMOTE_URL, {
            method: 'GET',
            onResponseBodyMode,
        })

        expect(onResponseBodyMode).toHaveBeenCalledOnce()
        expect(onResponseBodyMode).toHaveBeenCalledWith('buffered')
        resolveResponse(new Response(new Uint8Array([1, 2, 3])))
        await expect(pending).resolves.toBeInstanceOf(Response)
    })

    it('reports streaming body mode for direct and proxy2 responses', async () => {
        const onDirectBodyMode = vi.fn()
        getDatabase().usePlainFetch = true
        globalThis.fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([1])))

        await fetchNative(REMOTE_URL, {
            method: 'GET',
            onResponseBodyMode: onDirectBodyMode,
        })
        expect(onDirectBodyMode).toHaveBeenCalledWith('streaming')

        const onProxyBodyMode = vi.fn()
        getDatabase().usePlainFetch = false
        globalThis.fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([2])))

        await fetchNative('http://127.0.0.1:8188/view', {
            method: 'GET',
            networkRoute: 'local_network',
            onResponseBodyMode: onProxyBodyMode,
        })
        expect(onProxyBodyMode).toHaveBeenCalledWith('streaming')
    })

    it.each([
        {
            name: 'learns a header watchdog TimeoutError for the next attempt',
            reason: new DOMException('headers timed out', 'TimeoutError'),
            expectedSecondTarget: '/proxy2',
        },
        {
            name: 'does not learn an ordinary caller AbortError',
            reason: new DOMException('caller cancelled', 'AbortError'),
            expectedSecondTarget: REMOTE_URL,
        },
    ])('$name', async ({ reason, expectedSecondTarget }) => {
        getDatabase().usePlainFetch = true
        let directAttempt = 0
        const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            const target = String(input)
            if (directAttempt++ === 0) {
                return new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
                })
            }
            return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
        })
        globalThis.fetch = fetchMock
        const controller = new AbortController()

        const first = fetchNative(REMOTE_URL, { method: 'GET', signal: controller.signal })
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
        controller.abort(reason)
        await expect(first).rejects.toBe(reason)

        await expect(fetchNative(REMOTE_URL, { method: 'GET' })).resolves.toBeInstanceOf(Response)
        expect(String(fetchMock.mock.calls[1]?.[0])).toBe(expectedSecondTarget)
    })

    it('exports the transport marker as an unmistakable error type', () => {
        const cause = new TypeError('lost')
        expect(new GlobalFetchTransportError(true, cause)).toMatchObject({
            globalFetchTransportError: true,
            dispatched: true,
            transportCause: cause,
        })
    })
})
