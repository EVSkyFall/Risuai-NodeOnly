import { afterEach, describe, expect, test, vi } from 'vitest'
import { AWAIT_PARSED_DOCUMENT, GUEST_BRIDGE_SCRIPT, guestDocument, SandboxHost } from './factory'

// collectTransferables() checks `instanceof ImageBitmap`, which happy-dom lacks.
if (typeof ImageBitmap === 'undefined') vi.stubGlobal('ImageBitmap', class {})

// A host whose iframe is a stub: callbacks from the plugin come back as
// wrappers that post INVOKE_CALLBACK and wait for CALLBACK_RETURN, which a
// stub never sends — the state of a plugin that was unloaded mid-call.
function hostWithCallback() {
    const host = new SandboxHost({})
    const postMessage = vi.fn()
    ;(host as any).iframe = { contentWindow: { postMessage }, remove: vi.fn() }
    const [callback] = (host as any).deserializeArgs([{ __type: 'CALLBACK_REF', id: 'cb1' }])
    return { host, callback: callback as (...args: any[]) => Promise<unknown>, postMessage }
}

const unhandled: unknown[] = []
const onUnhandled = (reason: unknown) => { unhandled.push(reason) }

afterEach(() => {
    process.off('unhandledRejection', onUnhandled)
    unhandled.length = 0
})

describe('guestDocument', () => {
    // CPM's stream check (v1.30.84 bundle): unless it finds the bridge here,
    // CPM reads every provider stream to the end and returns one string.
    const cpmSeesBridge = (doc: Document) => {
        const match = (doc.querySelector('script')?.textContent || '').match(/function\s+collectTransferables\b[\s\S]{0,3000}?return\s+transferables/)
        return !!match && match[0].includes('ReadableStream')
    }

    test('the bridge stays the first script after a plugin appends scripts to <head>', () => {
        const doc = new DOMParser().parseFromString(guestDocument('default-src none', 'n0', 'pluginCode()'), 'text/html')
        expect(cpmSeesBridge(doc)).toBe(true)

        // CPM runs each sub-plugin as a <script> appended to <head>, before its check.
        const subPlugin = doc.createElement('script')
        subPlugin.textContent = 'subPlugin()'
        doc.head.appendChild(subPlugin)

        expect(cpmSeesBridge(doc)).toBe(true)
        const bridge = doc.querySelector('script')!
        expect(bridge.parentNode).toBe(doc.head)
        expect(bridge.getAttribute('nonce')).toBe('n0')
        expect(bridge.textContent).toContain('pluginCode()')
        // The CSP <meta> must come first: its policy covers only what follows it.
        const csp = doc.querySelector('meta#csp-meta')!
        expect(csp.parentNode).toBe(doc.head)
        expect(csp.compareDocumentPosition(bridge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    test('plugin code starts after the whole bridge and the parser wait', () => {
        const script = new DOMParser().parseFromString(guestDocument('c', 'n', 'pluginCode()'), 'text/html').querySelector('script')!.textContent!
        expect(() => new Function(script)).not.toThrow()
        const bridgeEnd = script.indexOf(GUEST_BRIDGE_SCRIPT) + GUEST_BRIDGE_SCRIPT.length
        expect(bridgeEnd).toBeGreaterThan(GUEST_BRIDGE_SCRIPT.length - 1)
        const wait = script.indexOf(AWAIT_PARSED_DOCUMENT)
        expect(wait).toBeGreaterThanOrEqual(bridgeEnd)
        expect(wait).toBeLessThan(script.indexOf('pluginCode()'))
    })

    test('the parser wait holds plugin code only while the document is still loading', async () => {
        const start = (readyState: string) => {
            const listeners: (() => void)[] = []
            const doc = {
                readyState,
                addEventListener: (name: string, listener: () => void) => { if (name === 'DOMContentLoaded') listeners.push(listener) },
            }
            const state = { ran: 0, listeners, done: undefined as unknown as Promise<void> }
            state.done = new Function('document', 'mark', `return (async () => { ${AWAIT_PARSED_DOCUMENT}\nmark() })()`)(doc, () => { state.ran++ })
            return state
        }
        const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

        for (const parsed of ['interactive', 'complete']) {
            const run = start(parsed)
            await run.done
            expect(run.ran).toBe(1)
            expect(run.listeners).toHaveLength(0)
        }

        const loading = start('loading')
        await settle()
        expect(loading.ran).toBe(0)
        expect(loading.listeners).toHaveLength(1)
        loading.listeners[0]()
        await loading.done
        expect(loading.ran).toBe(1)
    })
})

describe('SandboxHost.terminate', () => {
    test('rejects a callback still waiting on the iframe', async () => {
        const { host, callback, postMessage } = hostWithCallback()
        const call = callback('x')
        expect(postMessage).toHaveBeenCalledTimes(1)

        host.terminate()

        await expect(call).rejects.toThrow(/sandbox terminated/i)
    })

    test('fails a callback called after termination without posting it', async () => {
        const { host, callback, postMessage } = hostWithCallback()
        host.terminate()

        await expect(callback('x')).rejects.toThrow(/sandbox terminated/i)
        // terminate() itself tells the guest it ended (SANDBOX_TERMINATED);
        // the callback must post nothing.
        expect(postMessage.mock.calls.filter(([message]) => message?.type !== 'SANDBOX_TERMINATED')).toEqual([])
    })

    test('a call nobody awaits does not become an unhandled rejection', async () => {
        process.on('unhandledRejection', onUnhandled)
        const { host, callback } = hostWithCallback()

        callback('pending at terminate')
        host.terminate()
        callback('after terminate')
        await new Promise((r) => setTimeout(r, 10))

        expect(unhandled).toEqual([])
    })
})
