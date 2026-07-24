import { describe, expect, it } from 'vitest'
import { vi } from 'vitest'

// The module imports forageStorage only for its default (authenticated fetch)
// transport; every test here injects its own transport, so a light mock keeps
// the heavy globalApi module out of the graph.
vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: {
        async createAuth() {
            return 'test-jwt'
        },
    },
}))

const {
    PluginAtomicClient,
    PluginAtomicConflictError,
    PluginAtomicReceiptMismatchError,
    PluginAtomicCursorExpiredError,
    PluginAtomicValueTooLargeError,
    PluginAtomicIdentityError,
    createPluginNamespacedAtomicApi,
    createPluginAtomicSandboxApi,
    pluginNamespacePrefix,
} = await import('../pluginAtomic')
type PluginAtomicTransport = import('../pluginAtomic').PluginAtomicTransport

const INSTALL_A = '11111111-1111-4111-8111-111111111111'
const INSTALL_B = '22222222-2222-4222-8222-222222222222'
const NS_A = `p:${INSTALL_A}:`

interface Recorded {
    requests: any[]
    setResponder: (r: (body: any) => { status: number; body: unknown }) => void
    transport: PluginAtomicTransport
}

function makeTransport(): Recorded {
    const requests: any[] = []
    let responder: (body: any) => { status: number; body: unknown } = () => ({ status: 200, body: {} })
    const transport: PluginAtomicTransport = async (body) => {
        requests.push(body)
        const { status, body: responseBody } = responder(body)
        return { status, json: async () => responseBody }
    }
    return { requests, setResponder: (r) => { responder = r }, transport }
}

function encodeValue(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString('base64')
}

describe('PluginAtomicClient', () => {
    it('read decodes the value and caches the revision', async () => {
        const t = makeTransport()
        t.setResponder(() => ({ status: 200, body: { key: `${NS_A}k`, revision: 2, value: encodeValue({ a: 1 }), deleted: false } }))
        const client = new PluginAtomicClient({ transport: t.transport })

        const record = await client.read(`${NS_A}k`)
        expect(record).toEqual({ key: `${NS_A}k`, revision: 2, value: { a: 1 }, deleted: false })
        expect(t.requests[0]).toMatchObject({ protocolVersion: 1, op: 'read', key: `${NS_A}k` })
        expect(client.getCachedRevision(`${NS_A}k`)).toBe(2)
    })

    it('cas encodes the value, threads the cached revision, and updates the cache', async () => {
        const t = makeTransport()
        t.setResponder((body) => {
            if (body.op === 'read') return { status: 200, body: { key: body.key, revision: 4, value: encodeValue({ old: true }), deleted: false } }
            return { status: 200, body: { applied: true, revision: 5 } }
        })
        const client = new PluginAtomicClient({ transport: t.transport })

        await client.read(`${NS_A}k`)
        const result = await client.cas({ key: `${NS_A}k`, value: { next: 1 }, operationKey: 'op-1' })
        expect(result).toEqual({ applied: true, revision: 5 })

        const casRequest = t.requests[1]
        expect(casRequest).toMatchObject({ op: 'cas', key: `${NS_A}k`, expectedRevision: 4, operationKey: 'op-1' })
        expect(JSON.parse(Buffer.from(casRequest.value, 'base64').toString('utf-8'))).toEqual({ next: 1 })
        expect(client.getCachedRevision(`${NS_A}k`)).toBe(5)
    })

    it('readMany / list / remove / receipt / changes each map their op', async () => {
        const t = makeTransport()
        t.setResponder((body) => {
            switch (body.op) {
                case 'bulkRead':
                    return { status: 200, body: { items: [{ key: `${NS_A}a`, revision: 1, value: encodeValue(1), deleted: false }] } }
                case 'list':
                    return { status: 200, body: { items: [{ key: `${NS_A}a`, revision: 1, deleted: false }], nextCursor: `${NS_A}a` } }
                case 'remove':
                    return { status: 200, body: { applied: true, revision: 9 } }
                case 'receipt':
                    return { status: 200, body: { receipt: { applied: true, key: `${NS_A}a`, resultingRevision: 3 } } }
                case 'changes':
                    return { status: 200, body: { cursor: '0:7', changedKeys: [`${NS_A}a`], epoch: 0 } }
                default:
                    return { status: 200, body: {} }
            }
        })
        const client = new PluginAtomicClient({ transport: t.transport })

        expect(await client.readMany([`${NS_A}a`])).toEqual([{ key: `${NS_A}a`, revision: 1, value: 1, deleted: false }])
        expect(await client.list(NS_A, { limit: 1 })).toEqual({ items: [{ key: `${NS_A}a`, revision: 1, deleted: false }], nextCursor: `${NS_A}a` })
        expect(await client.remove({ key: `${NS_A}a`, expectedRevision: 8, operationKey: 'rm-1' })).toEqual({ applied: true, revision: 9 })
        expect(await client.getReceipt('rm-1')).toEqual({ applied: true, key: `${NS_A}a`, resultingRevision: 3 })
        expect(await client.changes({ prefix: NS_A, limit: 10 })).toEqual({ cursor: '0:7', changedKeys: [`${NS_A}a`], epoch: 0 })
        // bulkRead caches revisions too.
        expect(client.getCachedRevision(`${NS_A}a`)).toBe(9)
    })

    it('maps every server error code to its typed error', async () => {
        const t = makeTransport()
        const client = new PluginAtomicClient({ transport: t.transport })

        t.setResponder(() => ({ status: 409, body: { error: 'conflict', code: 'PLUGIN_ATOMIC_CONFLICT', currentRevision: 7, currentDeleted: true } }))
        const conflict = await client.cas({ key: `${NS_A}k`, value: {}, operationKey: 'c-1' }).catch((e) => e)
        expect(conflict).toBeInstanceOf(PluginAtomicConflictError)
        expect(conflict.currentRevision).toBe(7)
        expect(conflict.currentDeleted).toBe(true)

        t.setResponder(() => ({ status: 409, body: { error: 'mismatch', code: 'PLUGIN_ATOMIC_RECEIPT_MISMATCH', operationKey: 'c-2' } }))
        const mismatch = await client.cas({ key: `${NS_A}k`, value: {}, operationKey: 'c-2' }).catch((e) => e)
        expect(mismatch).toBeInstanceOf(PluginAtomicReceiptMismatchError)
        expect(mismatch.operationKey).toBe('c-2')

        t.setResponder(() => ({ status: 409, body: { error: 'expired', code: 'PLUGIN_ATOMIC_CURSOR_EXPIRED', epoch: 4 } }))
        const expired = await client.changes({ prefix: NS_A, limit: 10, afterCursor: '0:3' }).catch((e) => e)
        expect(expired).toBeInstanceOf(PluginAtomicCursorExpiredError)
        expect(expired.epoch).toBe(4)

        t.setResponder(() => ({ status: 413, body: { error: 'too big', code: 'PLUGIN_ATOMIC_VALUE_TOO_LARGE' } }))
        await expect(client.cas({ key: `${NS_A}k`, value: {}, operationKey: 'c-3' })).rejects.toBeInstanceOf(PluginAtomicValueTooLargeError)
    })

    it('revision caches are instance-scoped, never shared between contexts', async () => {
        const t = makeTransport()
        t.setResponder((body) => ({ status: 200, body: { key: body.key, revision: body.marker ?? 3, value: null, deleted: false } }))
        const a = new PluginAtomicClient({ transport: t.transport })
        const b = new PluginAtomicClient({ transport: t.transport })

        await a.read(`${NS_A}shared`)
        expect(a.getCachedRevision(`${NS_A}shared`)).toBe(3)
        expect(b.getCachedRevision(`${NS_A}shared`)).toBeUndefined()

        a.clearRevisionCache()
        expect(a.getCachedRevision(`${NS_A}shared`)).toBeUndefined()
    })
})

describe('host-side namespace enforcement', () => {
    it('prepends the installation namespace and returns plugin-relative keys', async () => {
        const t = makeTransport()
        t.setResponder((body) => {
            if (body.op === 'read') return { status: 200, body: { key: body.key, revision: 1, value: encodeValue({ ok: 1 }), deleted: false } }
            if (body.op === 'list') return { status: 200, body: { items: [{ key: `${NS_A}jobs/1`, revision: 1, deleted: false }], nextCursor: `${NS_A}jobs/1` } }
            if (body.op === 'changes') return { status: 200, body: { cursor: '0:2', changedKeys: [`${NS_A}jobs/1`], epoch: 0 } }
            return { status: 200, body: { applied: true, revision: 2 } }
        })
        const api = createPluginNamespacedAtomicApi({
            installId: INSTALL_A,
            client: new PluginAtomicClient({ transport: t.transport }),
        })

        const record = await api.read('jobs/1')
        expect(t.requests[0].key).toBe(`${NS_A}jobs/1`)
        // Keys come back RELATIVE — plugins never see (or need) the namespace.
        expect(record).toEqual({ key: 'jobs/1', revision: 1, value: { ok: 1 }, deleted: false })

        const page = await api.list({ prefix: 'jobs/', limit: 10 })
        expect(t.requests[1].prefix).toBe(`${NS_A}jobs/`)
        expect(page.items).toEqual([{ key: 'jobs/1', revision: 1, deleted: false }])
        expect(page.nextCursor).toBe('jobs/1')

        const changed = await api.changes({ limit: 10 })
        expect(t.requests[2].prefix).toBe(NS_A)
        expect(changed.changedKeys).toEqual(['jobs/1'])
    })

    it('cannot escape its own namespace with a caller-supplied prefix', async () => {
        const t = makeTransport()
        t.setResponder(() => ({ status: 200, body: { key: 'x', revision: 0, value: null, deleted: false } }))
        const api = createPluginNamespacedAtomicApi({
            installId: INSTALL_A,
            client: new PluginAtomicClient({ transport: t.transport }),
        })

        // Every escape shape a plugin could express still lands inside p:<A>:.
        await api.read(`p:${INSTALL_B}:secret`)
        await api.read('../../p:' + INSTALL_B + ':secret')
        await api.list({ prefix: `p:${INSTALL_B}:`, limit: 10 })
        await api.changes({ prefix: `p:${INSTALL_B}:`, limit: 10 })

        for (const request of t.requests) {
            const target: string = request.key ?? request.prefix
            expect(target.startsWith(NS_A)).toBe(true)
            expect(target.startsWith(`p:${INSTALL_B}:`)).toBe(false)
        }
    })

    it('fails closed when the installation identity is missing or malformed', () => {
        const client = new PluginAtomicClient({ transport: makeTransport().transport })
        expect(() => createPluginNamespacedAtomicApi({ installId: undefined as any, client })).toThrow(PluginAtomicIdentityError)
        expect(() => createPluginNamespacedAtomicApi({ installId: 'not-a-uuid', client })).toThrow(PluginAtomicIdentityError)
    })

    it('pluginNamespacePrefix matches the server key shape', () => {
        expect(pluginNamespacePrefix(INSTALL_A)).toBe(NS_A)
        expect(/^p:[0-9a-f-]{36}:/.test(pluginNamespacePrefix(INSTALL_A))).toBe(true)
    })
})

describe('sandbox result envelope', () => {
    // The V3 bridge serializes a rejection as err.message only, so codes and
    // detail fields must ride in the resolved value instead.
    it('resolves success and surfaces typed failures with their detail fields', async () => {
        const t = makeTransport()
        const api = createPluginAtomicSandboxApi({
            installId: INSTALL_A,
            client: new PluginAtomicClient({ transport: t.transport }),
        })

        t.setResponder(() => ({ status: 200, body: { applied: true, revision: 3 } }))
        expect(await api.cas({ key: 'k', value: { a: 1 }, operationKey: 'op-1' })).toEqual({ ok: true, applied: true, revision: 3 })

        t.setResponder(() => ({ status: 409, body: { error: 'conflict', code: 'PLUGIN_ATOMIC_CONFLICT', currentRevision: 7, currentDeleted: false } }))
        expect(await api.cas({ key: 'k', value: {}, operationKey: 'op-2' })).toEqual({
            ok: false, code: 'PLUGIN_ATOMIC_CONFLICT', message: 'conflict', currentRevision: 7, currentDeleted: false,
        })

        t.setResponder(() => ({ status: 409, body: { error: 'expired', code: 'PLUGIN_ATOMIC_CURSOR_EXPIRED', epoch: 2 } }))
        expect(await api.changes({ afterCursor: '0:1', limit: 10 })).toEqual({
            ok: false, code: 'PLUGIN_ATOMIC_CURSOR_EXPIRED', message: 'expired', epoch: 2,
        })
    })

    it('fails closed on every call when the installation identity is unusable', async () => {
        const api = createPluginAtomicSandboxApi({ installId: undefined })
        for (const result of [
            await api.read('k'),
            await api.cas({ key: 'k', value: {}, operationKey: 'o' }),
            await api.changes({ limit: 1 }),
        ]) {
            expect(result).toMatchObject({ ok: false, code: 'PLUGIN_ATOMIC_NO_INSTALL_ID' })
        }
    })
})
