import { describe, expect, it, vi } from 'vitest'

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
    IllustrationAtomicClient,
    IllustrationAtomicConflictError,
    IllustrationGuardStaleError,
    IllustrationReceiptReuseMismatchError,
} = await import('../atomicStorage')
type AtomicTransport = import('../atomicStorage').AtomicTransport

interface Recorded {
    requests: any[]
    setResponder: (r: (body: any) => { status: number; body: unknown }) => void
    transport: AtomicTransport
}

function makeTransport(): Recorded {
    const requests: any[] = []
    let responder: (body: any) => { status: number; body: unknown } = () => ({ status: 200, body: {} })
    const transport: AtomicTransport = async (body) => {
        requests.push(body)
        const { status, body: responseBody } = responder(body)
        return { status, json: async () => responseBody }
    }
    return { requests, setResponder: (r) => { responder = r }, transport }
}

function encodeValue(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString('base64')
}

describe('IllustrationAtomicClient', () => {
    it('read decodes the value and caches the revision', async () => {
        const t = makeTransport()
        t.setResponder(() => ({ status: 200, body: { key: 'illustration:v2:k', revision: 2, value: encodeValue({ a: 1 }), deleted: false } }))
        const client = new IllustrationAtomicClient({ transport: t.transport })

        const record = await client.read('illustration:v2:k')
        expect(record).toEqual({ key: 'illustration:v2:k', revision: 2, value: { a: 1 }, deleted: false })
        expect(t.requests[0]).toMatchObject({ protocolVersion: 1, op: 'read', key: 'illustration:v2:k' })
        expect(client.getCachedRevision('illustration:v2:k')).toBe(2)
    })

    it('cas encodes the value, threads the cached revision, and updates the cache', async () => {
        const t = makeTransport()
        t.setResponder((body) => {
            if (body.op === 'read') return { status: 200, body: { key: body.key, revision: 4, value: encodeValue({ old: true }), deleted: false } }
            return { status: 200, body: { applied: true, revision: 5 } }
        })
        const client = new IllustrationAtomicClient({ transport: t.transport })

        await client.read('illustration:v2:k')
        const result = await client.cas({ key: 'illustration:v2:k', value: { next: 1 }, operationKey: 'op-1' })
        expect(result).toEqual({ applied: true, revision: 5 })

        const casRequest = t.requests[1]
        expect(casRequest).toMatchObject({ op: 'cas', key: 'illustration:v2:k', expectedRevision: 4, operationKey: 'op-1' })
        // Value crosses the wire base64-encoded and decodes back to the document.
        expect(JSON.parse(Buffer.from(casRequest.value, 'base64').toString('utf-8'))).toEqual({ next: 1 })
        expect(client.getCachedRevision('illustration:v2:k')).toBe(5)
    })

    it('cas honors an explicit expectedRevision over the cache', async () => {
        const t = makeTransport()
        t.setResponder(() => ({ status: 200, body: { applied: true, revision: 8 } }))
        const client = new IllustrationAtomicClient({ transport: t.transport })

        await client.cas({ key: 'illustration:v2:k', value: {}, operationKey: 'op', expectedRevision: 7 })
        expect(t.requests[0]).toMatchObject({ expectedRevision: 7 })
    })

    it('maps a 409 conflict to a typed error carrying currentRevision', async () => {
        const t = makeTransport()
        t.setResponder(() => ({ status: 409, body: { code: 'ILLUS_ATOMIC_CONFLICT', currentRevision: 12, currentDeleted: false, error: 'conflict' } }))
        const client = new IllustrationAtomicClient({ transport: t.transport })

        await expect(client.cas({ key: 'illustration:v2:k', value: {}, operationKey: 'op', expectedRevision: 3 }))
            .rejects.toMatchObject({ name: 'IllustrationAtomicConflictError', code: 'ILLUS_ATOMIC_CONFLICT', currentRevision: 12 })
        // Confirm the concrete class as well.
        try {
            await client.cas({ key: 'illustration:v2:k', value: {}, operationKey: 'op', expectedRevision: 3 })
        } catch (error) {
            expect(error).toBeInstanceOf(IllustrationAtomicConflictError)
            expect((error as InstanceType<typeof IllustrationAtomicConflictError>).currentRevision).toBe(12)
        }
    })

    it('maps guard-stale and receipt-mismatch errors', async () => {
        const t = makeTransport()
        const client = new IllustrationAtomicClient({ transport: t.transport })

        t.setResponder(() => ({ status: 409, body: { code: 'ILLUS_GUARD_STALE', guard: 'coordinator', reason: 'fence_mismatch', error: 'stale' } }))
        await expect(client.cas({ key: 'illustration:v2:k', value: {}, operationKey: 'op', expectedRevision: 0 }))
            .rejects.toBeInstanceOf(IllustrationGuardStaleError)

        t.setResponder(() => ({ status: 409, body: { code: 'ILLUS_RECEIPT_REUSE_MISMATCH', operationKey: 'op', error: 'mismatch' } }))
        await expect(client.cas({ key: 'illustration:v2:k', value: {}, operationKey: 'op', expectedRevision: 0 }))
            .rejects.toBeInstanceOf(IllustrationReceiptReuseMismatchError)
    })

    it('passes an authority guard through unchanged', async () => {
        const t = makeTransport()
        t.setResponder(() => ({ status: 200, body: { applied: true, revision: 1 } }))
        const client = new IllustrationAtomicClient({ transport: t.transport })

        const guard = {
            coordinator: { leaseId: 'L1', fence: 7 },
            agentMode: { generation: 2, mode: 'capture-intent-v1' },
        }
        await client.cas({ key: 'illustration:v2:k', value: {}, operationKey: 'op', expectedRevision: 0, guard })
        expect(t.requests[0].guard).toEqual(guard)
    })

    it('the revision cache is instance-scoped (no leak between clients)', async () => {
        const shared = makeTransport()
        shared.setResponder((body) => {
            if (body.op === 'read') return { status: 200, body: { key: body.key, revision: 9, value: null, deleted: false } }
            return { status: 200, body: { applied: true, revision: (body.expectedRevision ?? 0) + 1 } }
        })
        const clientA = new IllustrationAtomicClient({ transport: shared.transport })
        const clientB = new IllustrationAtomicClient({ transport: shared.transport })

        await clientA.read('illustration:v2:shared')
        expect(clientA.getCachedRevision('illustration:v2:shared')).toBe(9)
        expect(clientB.getCachedRevision('illustration:v2:shared')).toBeUndefined()

        // clientB has no cached revision, so its cas defaults expectedRevision to 0.
        await clientB.cas({ key: 'illustration:v2:shared', value: {}, operationKey: 'b-op' })
        const bCas = shared.requests.at(-1)
        expect(bCas).toMatchObject({ op: 'cas', expectedRevision: 0 })
    })

    it('supports remove, list, bulkRead, and receipt', async () => {
        const t = makeTransport()
        const client = new IllustrationAtomicClient({ transport: t.transport })

        t.setResponder(() => ({ status: 200, body: { applied: true, revision: 3 } }))
        expect(await client.remove({ key: 'illustration:v2:k', operationKey: 'rm', expectedRevision: 2 })).toEqual({ applied: true, revision: 3 })
        expect(client.getCachedRevision('illustration:v2:k')).toBe(3)

        t.setResponder(() => ({ status: 200, body: { items: [{ key: 'illustration:v2:a', revision: 1, deleted: false }], nextCursor: 'illustration:v2:a' } }))
        const page = await client.list('illustration:v2:', { limit: 1 })
        expect(page.nextCursor).toBe('illustration:v2:a')
        expect(page.items).toHaveLength(1)

        t.setResponder(() => ({ status: 200, body: { items: [{ key: 'illustration:v2:a', revision: 2, value: encodeValue({ z: 9 }), deleted: false }] } }))
        const many = await client.readMany('illustration:v2:a'.split('|'))
        expect(many[0]).toEqual({ key: 'illustration:v2:a', revision: 2, value: { z: 9 }, deleted: false })

        t.setResponder(() => ({ status: 200, body: { receipt: { applied: true, key: 'illustration:v2:k', resultingRevision: 3 } } }))
        expect(await client.getReceipt('rm')).toEqual({ applied: true, key: 'illustration:v2:k', resultingRevision: 3 })

        t.setResponder(() => ({ status: 200, body: { receipt: null } }))
        expect(await client.getReceipt('nope')).toBeNull()
    })
})
