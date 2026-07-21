// Client transport for the server-authoritative illustration atomic storage
// (Gate 1a). A thin, typed wrapper over POST /api/illustration/atomic that
// reuses NodeStorage's existing auth plumbing (forageStorage.createAuth →
// risu-auth JWT header, mirroring NodeStorage.authFetch) — no new auth is
// invented here.
//
// The per-key revision cache is INSTANCE-scoped (design-review finding #23): the
// multi-context harness simulates several browsers, and a module-global cache
// would let one simulated browser's revisions leak into another. Tests construct
// their own IllustrationAtomicClient instances; production code uses the
// module-level default instance.

import { forageStorage } from '../../globalApi.svelte'

const ATOMIC_ENDPOINT = '/api/illustration/atomic'
const PROTOCOL_VERSION = 1

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface IllustrationAtomicRecord<T = unknown> {
    key: string
    revision: number
    value: T | null
    deleted: boolean
}

export interface IllustrationAtomicListItem {
    key: string
    revision: number
    deleted: boolean
}

export interface IllustrationAtomicListPage {
    items: IllustrationAtomicListItem[]
    nextCursor: string | null
}

export interface IllustrationMutationReceipt {
    applied: boolean
    key: string
    resultingRevision: number
}

export interface IllustrationAuthorityGuardV1 {
    coordinator?: { leaseId: string; fence: number }
    intent?: { intentId: string; leaseId: string; fence: number }
    execution?: { executionId: string; workFence: number }
    agentMode?: { generation: number; mode: string }
}

// ── Typed errors mirroring the server codes ─────────────────────────────────

export class IllustrationAtomicError extends Error {
    code: string
    constructor(message: string, code: string) {
        super(message)
        this.name = 'IllustrationAtomicError'
        this.code = code
    }
}

export class IllustrationAtomicConflictError extends IllustrationAtomicError {
    currentRevision: number
    currentDeleted: boolean
    constructor(currentRevision: number, currentDeleted: boolean, message = 'illustration atomic revision conflict') {
        super(message, 'ILLUS_ATOMIC_CONFLICT')
        this.name = 'IllustrationAtomicConflictError'
        this.currentRevision = currentRevision
        this.currentDeleted = currentDeleted
    }
}

export class IllustrationGuardStaleError extends IllustrationAtomicError {
    guard: string
    reason: string
    constructor(guard: string, reason: string, message = 'illustration authority guard is stale') {
        super(message, 'ILLUS_GUARD_STALE')
        this.name = 'IllustrationGuardStaleError'
        this.guard = guard
        this.reason = reason
    }
}

export class IllustrationReceiptReuseMismatchError extends IllustrationAtomicError {
    operationKey: string
    constructor(operationKey: string, message = 'operationKey reused with a different binding') {
        super(message, 'ILLUS_RECEIPT_REUSE_MISMATCH')
        this.name = 'IllustrationReceiptReuseMismatchError'
        this.operationKey = operationKey
    }
}

export class IllustrationValueTooLargeError extends IllustrationAtomicError {
    constructor(message = 'illustration atomic value exceeds the size cap') {
        super(message, 'ILLUS_VALUE_TOO_LARGE')
        this.name = 'IllustrationValueTooLargeError'
    }
}

export class IllustrationBadKeyError extends IllustrationAtomicError {
    constructor(message = 'illustration atomic key is invalid') {
        super(message, 'ILLUS_BAD_KEY')
        this.name = 'IllustrationBadKeyError'
    }
}

export class IllustrationBadRequestError extends IllustrationAtomicError {
    constructor(message = 'illustration atomic request is malformed') {
        super(message, 'ILLUS_BAD_REQUEST')
        this.name = 'IllustrationBadRequestError'
    }
}

// ── Transport seam (injectable for tests) ───────────────────────────────────

export interface AtomicHttpResponse {
    status: number
    json(): Promise<any>
}

export type AtomicTransport = (body: unknown) => Promise<AtomicHttpResponse>

async function defaultTransport(body: unknown): Promise<AtomicHttpResponse> {
    const token = await forageStorage.createAuth()
    return await fetch(ATOMIC_ENDPOINT, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'risu-auth': token,
        },
        body: JSON.stringify(body),
    })
}

function encodeValue(value: unknown): string {
    return Buffer.from(encoder.encode(JSON.stringify(value))).toString('base64')
}

function decodeValue<T>(base64: string | null): T | null {
    if (base64 === null || base64 === undefined) return null
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.length === 0) return null
    return JSON.parse(decoder.decode(bytes)) as T
}

function mapError(status: number, data: any): Error {
    const code = data && typeof data.code === 'string' ? data.code : undefined
    const message = data && typeof data.error === 'string' ? data.error : `illustration atomic request failed (${status})`
    switch (code) {
        case 'ILLUS_ATOMIC_CONFLICT':
            return new IllustrationAtomicConflictError(Number(data.currentRevision ?? 0), !!data.currentDeleted, message)
        case 'ILLUS_GUARD_STALE':
            return new IllustrationGuardStaleError(String(data.guard ?? 'unknown'), String(data.reason ?? 'unknown'), message)
        case 'ILLUS_RECEIPT_REUSE_MISMATCH':
            return new IllustrationReceiptReuseMismatchError(String(data.operationKey ?? ''), message)
        case 'ILLUS_VALUE_TOO_LARGE':
            return new IllustrationValueTooLargeError(message)
        case 'ILLUS_BAD_KEY':
            return new IllustrationBadKeyError(message)
        case 'ILLUS_BAD_REQUEST':
            return new IllustrationBadRequestError(message)
        default:
            return new IllustrationAtomicError(message, code ?? 'ILLUS_UNKNOWN')
    }
}

export interface IllustrationAtomicClientOptions {
    /** Injectable transport for tests. Defaults to the authenticated fetch. */
    transport?: AtomicTransport
}

export interface CasIllustrationAtomicParams<T = unknown> {
    key: string
    value: T
    operationKey: string
    /** Omit to use the cached revision (read→modify→cas without threading it). */
    expectedRevision?: number
    guard?: IllustrationAuthorityGuardV1
}

export interface RemoveIllustrationAtomicParams {
    key: string
    operationKey: string
    expectedRevision?: number
    guard?: IllustrationAuthorityGuardV1
}

export class IllustrationAtomicClient {
    private readonly transport: AtomicTransport
    // Instance-scoped so simulated browsers in the multi-context harness never
    // share revisions (finding #23).
    private readonly revisionCache = new Map<string, number>()

    constructor(options: IllustrationAtomicClientOptions = {}) {
        this.transport = options.transport ?? defaultTransport
    }

    getCachedRevision(key: string): number | undefined {
        return this.revisionCache.get(key)
    }

    clearRevisionCache(): void {
        this.revisionCache.clear()
    }

    private async send(body: Record<string, unknown>): Promise<any> {
        const res = await this.transport({ protocolVersion: PROTOCOL_VERSION, ...body })
        if (res.status >= 200 && res.status < 300) {
            return await res.json()
        }
        let data: any = null
        try {
            data = await res.json()
        } catch {
            // Non-JSON error body — fall through to a generic error.
        }
        throw mapError(res.status, data)
    }

    async read<T = unknown>(key: string): Promise<IllustrationAtomicRecord<T>> {
        const data = await this.send({ op: 'read', key })
        const record: IllustrationAtomicRecord<T> = {
            key: data.key,
            revision: data.revision,
            value: decodeValue<T>(data.value),
            deleted: !!data.deleted,
        }
        this.revisionCache.set(record.key, record.revision)
        return record
    }

    async readMany<T = unknown>(keys: string[]): Promise<IllustrationAtomicRecord<T>[]> {
        const data = await this.send({ op: 'bulkRead', keys })
        const items: IllustrationAtomicRecord<T>[] = (data.items as any[]).map((it) => ({
            key: it.key,
            revision: it.revision,
            value: decodeValue<T>(it.value),
            deleted: !!it.deleted,
        }))
        for (const it of items) this.revisionCache.set(it.key, it.revision)
        return items
    }

    async list(prefix: string, options: { cursor?: string | null; limit?: number } = {}): Promise<IllustrationAtomicListPage> {
        const data = await this.send({
            op: 'list',
            prefix,
            cursor: options.cursor ?? undefined,
            limit: options.limit ?? 200,
        })
        return { items: data.items ?? [], nextCursor: data.nextCursor ?? null }
    }

    async cas<T = unknown>(params: CasIllustrationAtomicParams<T>): Promise<{ applied: boolean; revision: number }> {
        const expectedRevision = params.expectedRevision ?? this.revisionCache.get(params.key) ?? 0
        const data = await this.send({
            op: 'cas',
            key: params.key,
            expectedRevision,
            value: encodeValue(params.value),
            operationKey: params.operationKey,
            guard: params.guard,
        })
        this.revisionCache.set(params.key, data.revision)
        return { applied: !!data.applied, revision: data.revision }
    }

    async remove(params: RemoveIllustrationAtomicParams): Promise<{ applied: boolean; revision: number }> {
        const expectedRevision = params.expectedRevision ?? this.revisionCache.get(params.key) ?? 0
        const data = await this.send({
            op: 'remove',
            key: params.key,
            expectedRevision,
            operationKey: params.operationKey,
            guard: params.guard,
        })
        this.revisionCache.set(params.key, data.revision)
        return { applied: !!data.applied, revision: data.revision }
    }

    async getReceipt(operationKey: string): Promise<IllustrationMutationReceipt | null> {
        const data = await this.send({ op: 'receipt', operationKey })
        return data.receipt ?? null
    }
}

// Module-level default instance for production callers.
export const defaultIllustrationAtomicClient = new IllustrationAtomicClient()

export function readIllustrationAtomic<T = unknown>(key: string): Promise<IllustrationAtomicRecord<T>> {
    return defaultIllustrationAtomicClient.read<T>(key)
}

export function readManyIllustrationAtomic<T = unknown>(keys: string[]): Promise<IllustrationAtomicRecord<T>[]> {
    return defaultIllustrationAtomicClient.readMany<T>(keys)
}

export function listIllustrationAtomic(
    prefix: string,
    options?: { cursor?: string | null; limit?: number },
): Promise<IllustrationAtomicListPage> {
    return defaultIllustrationAtomicClient.list(prefix, options)
}

export function casIllustrationAtomic<T = unknown>(
    params: CasIllustrationAtomicParams<T>,
): Promise<{ applied: boolean; revision: number }> {
    return defaultIllustrationAtomicClient.cas<T>(params)
}

export function removeIllustrationAtomic(
    params: RemoveIllustrationAtomicParams,
): Promise<{ applied: boolean; revision: number }> {
    return defaultIllustrationAtomicClient.remove(params)
}

export function getIllustrationMutationReceipt(operationKey: string): Promise<IllustrationMutationReceipt | null> {
    return defaultIllustrationAtomicClient.getReceipt(operationKey)
}
