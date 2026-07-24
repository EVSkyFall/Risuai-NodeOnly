// Client transport for the server-authoritative GENERIC plugin atomic storage
// (Pure Plugin Primitives V1 §4). A thin, typed wrapper over
// POST /api/plugin/atomic that reuses NodeStorage's existing auth plumbing
// (forageStorage.createAuth → risu-auth JWT header, mirroring
// NodeStorage.authFetch) — no new auth is invented here.
//
// Two layers, deliberately separated:
//
//  1. PluginAtomicClient — the raw transport. Takes ABSOLUTE keys
//     (`p:<installId>:<key>`) and is what host code uses directly.
//
//  2. createPluginNamespacedAtomicApi — the plugin-facing surface. Takes
//     plugin-RELATIVE keys and prepends `p:<installId>:` itself. This is the
//     whole namespace enforcement mechanism, and it is structural rather than
//     validated: the plugin-facing methods have no parameter through which a
//     namespace, prefix or plugin identity can be expressed, and every key and
//     prefix that reaches the wire is built by the host from the installId it
//     alone holds. A plugin passing `p:<other>:secret` merely addresses
//     `p:<mine>:p:<other>:secret` — still inside its own namespace. Keys come
//     back relative, so a plugin never even learns the namespace it is in.
//
// The per-key revision cache is INSTANCE-scoped: several browser contexts (and
// several plugins in one context) must never share revisions, so a
// module-global cache would be a correctness bug, not an optimisation.

import { forageStorage } from '../../globalApi.svelte'

const ATOMIC_ENDPOINT = '/api/plugin/atomic'
const PROTOCOL_VERSION = 1

/** Must stay in sync with KEY_PATTERN in server/node/pluginAtomicStore.cjs. */
export const INSTALL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function pluginNamespacePrefix(installId: string): string {
    return `p:${installId}:`
}

export interface PluginAtomicRecord<T = unknown> {
    key: string
    revision: number
    value: T | null
    deleted: boolean
}

export interface PluginAtomicListItem {
    key: string
    revision: number
    deleted: boolean
}

export interface PluginAtomicListPage {
    items: PluginAtomicListItem[]
    nextCursor: string | null
}

export interface PluginAtomicChangesPage {
    cursor: string
    changedKeys: string[]
    /**
     * Storage generation. Bumped whenever the database blob is swapped out from
     * under live storage (backup import, save-folder import, snapshot restore).
     * A cursor minted in an older epoch is rejected with
     * PluginAtomicCursorExpiredError instead of silently missing changes.
     */
    epoch: number
}

export interface PluginAtomicMutationResult {
    applied: boolean
    revision: number
}

export interface PluginAtomicReceipt {
    applied: boolean
    key: string
    resultingRevision: number
}

// ── Typed errors mirroring every server code ────────────────────────────────

export class PluginAtomicError extends Error {
    code: string
    constructor(message: string, code: string) {
        super(message)
        this.name = 'PluginAtomicError'
        this.code = code
    }
}

export class PluginAtomicConflictError extends PluginAtomicError {
    currentRevision: number
    currentDeleted: boolean
    constructor(currentRevision: number, currentDeleted: boolean, message = 'plugin atomic revision conflict') {
        super(message, 'PLUGIN_ATOMIC_CONFLICT')
        this.name = 'PluginAtomicConflictError'
        this.currentRevision = currentRevision
        this.currentDeleted = currentDeleted
    }
}

export class PluginAtomicReceiptMismatchError extends PluginAtomicError {
    operationKey: string
    constructor(operationKey: string, message = 'operationKey reused with a different binding') {
        super(message, 'PLUGIN_ATOMIC_RECEIPT_MISMATCH')
        this.name = 'PluginAtomicReceiptMismatchError'
        this.operationKey = operationKey
    }
}

export class PluginAtomicCursorExpiredError extends PluginAtomicError {
    epoch: number
    constructor(epoch: number, message = 'change cursor predates the current storage epoch') {
        super(message, 'PLUGIN_ATOMIC_CURSOR_EXPIRED')
        this.name = 'PluginAtomicCursorExpiredError'
        this.epoch = epoch
    }
}

export class PluginAtomicValueTooLargeError extends PluginAtomicError {
    constructor(message = 'plugin atomic value exceeds the size cap') {
        super(message, 'PLUGIN_ATOMIC_VALUE_TOO_LARGE')
        this.name = 'PluginAtomicValueTooLargeError'
    }
}

export class PluginAtomicBadKeyError extends PluginAtomicError {
    constructor(message = 'plugin atomic key is invalid') {
        super(message, 'PLUGIN_ATOMIC_BAD_KEY')
        this.name = 'PluginAtomicBadKeyError'
    }
}

export class PluginAtomicBadRequestError extends PluginAtomicError {
    constructor(message = 'plugin atomic request is malformed') {
        super(message, 'PLUGIN_ATOMIC_BAD_REQUEST')
        this.name = 'PluginAtomicBadRequestError'
    }
}

/**
 * Host-side only: the plugin installation has no usable persisted identity, so
 * there is no namespace to scope its storage to. Fail closed rather than
 * inventing one — a wrong namespace would orphan or cross-wire durable data.
 */
export class PluginAtomicIdentityError extends PluginAtomicError {
    constructor(message = 'plugin installation identity is unavailable') {
        super(message, 'PLUGIN_ATOMIC_NO_INSTALL_ID')
        this.name = 'PluginAtomicIdentityError'
    }
}

// ── Transport seam (injectable for tests) ───────────────────────────────────

export interface PluginAtomicHttpResponse {
    status: number
    json(): Promise<any>
}

export type PluginAtomicTransport = (body: unknown) => Promise<PluginAtomicHttpResponse>

async function defaultTransport(body: unknown): Promise<PluginAtomicHttpResponse> {
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
    const message = data && typeof data.error === 'string' ? data.error : `plugin atomic request failed (${status})`
    switch (code) {
        case 'PLUGIN_ATOMIC_CONFLICT':
            return new PluginAtomicConflictError(Number(data.currentRevision ?? 0), !!data.currentDeleted, message)
        case 'PLUGIN_ATOMIC_RECEIPT_MISMATCH':
            return new PluginAtomicReceiptMismatchError(String(data.operationKey ?? ''), message)
        case 'PLUGIN_ATOMIC_CURSOR_EXPIRED':
            return new PluginAtomicCursorExpiredError(Number(data.epoch ?? 0), message)
        case 'PLUGIN_ATOMIC_VALUE_TOO_LARGE':
            return new PluginAtomicValueTooLargeError(message)
        case 'PLUGIN_ATOMIC_BAD_KEY':
            return new PluginAtomicBadKeyError(message)
        case 'PLUGIN_ATOMIC_BAD_REQUEST':
            return new PluginAtomicBadRequestError(message)
        default:
            return new PluginAtomicError(message, code ?? 'PLUGIN_ATOMIC_UNKNOWN')
    }
}

export interface PluginAtomicClientOptions {
    /** Injectable transport for tests. Defaults to the authenticated fetch. */
    transport?: PluginAtomicTransport
}

export interface CasPluginAtomicParams<T = unknown> {
    key: string
    value: T
    operationKey: string
    /** Omit to use the cached revision (read→modify→cas without threading it). */
    expectedRevision?: number
}

export interface RemovePluginAtomicParams {
    key: string
    operationKey: string
    expectedRevision?: number
}

export interface ChangesPluginAtomicParams {
    prefix: string
    limit?: number
    afterCursor?: string | null
}

export class PluginAtomicClient {
    private readonly transport: PluginAtomicTransport
    // Instance-scoped: multiple contexts (and multiple plugins within one
    // context) must never share revisions.
    private readonly revisionCache = new Map<string, number>()

    constructor(options: PluginAtomicClientOptions = {}) {
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

    async read<T = unknown>(key: string): Promise<PluginAtomicRecord<T>> {
        const data = await this.send({ op: 'read', key })
        const record: PluginAtomicRecord<T> = {
            key: data.key,
            revision: data.revision,
            value: decodeValue<T>(data.value),
            deleted: !!data.deleted,
        }
        this.revisionCache.set(record.key, record.revision)
        return record
    }

    async readMany<T = unknown>(keys: string[]): Promise<PluginAtomicRecord<T>[]> {
        const data = await this.send({ op: 'bulkRead', keys })
        const items: PluginAtomicRecord<T>[] = (data.items as any[]).map((it) => ({
            key: it.key,
            revision: it.revision,
            value: decodeValue<T>(it.value),
            deleted: !!it.deleted,
        }))
        for (const it of items) this.revisionCache.set(it.key, it.revision)
        return items
    }

    async list(prefix: string, options: { cursor?: string | null; limit?: number } = {}): Promise<PluginAtomicListPage> {
        const data = await this.send({
            op: 'list',
            prefix,
            cursor: options.cursor ?? undefined,
            limit: options.limit ?? 200,
        })
        return { items: data.items ?? [], nextCursor: data.nextCursor ?? null }
    }

    async cas<T = unknown>(params: CasPluginAtomicParams<T>): Promise<PluginAtomicMutationResult> {
        const expectedRevision = params.expectedRevision ?? this.revisionCache.get(params.key) ?? 0
        const data = await this.send({
            op: 'cas',
            key: params.key,
            expectedRevision,
            value: encodeValue(params.value),
            operationKey: params.operationKey,
        })
        this.revisionCache.set(params.key, data.revision)
        return { applied: !!data.applied, revision: data.revision }
    }

    async remove(params: RemovePluginAtomicParams): Promise<PluginAtomicMutationResult> {
        const expectedRevision = params.expectedRevision ?? this.revisionCache.get(params.key) ?? 0
        const data = await this.send({
            op: 'remove',
            key: params.key,
            expectedRevision,
            operationKey: params.operationKey,
        })
        this.revisionCache.set(params.key, data.revision)
        return { applied: !!data.applied, revision: data.revision }
    }

    async getReceipt(operationKey: string): Promise<PluginAtomicReceipt | null> {
        const data = await this.send({ op: 'receipt', operationKey })
        return data.receipt ?? null
    }

    async changes(params: ChangesPluginAtomicParams): Promise<PluginAtomicChangesPage> {
        const data = await this.send({
            op: 'changes',
            prefix: params.prefix,
            limit: params.limit ?? 200,
            afterCursor: params.afterCursor ?? undefined,
        })
        return {
            cursor: String(data.cursor ?? ''),
            changedKeys: data.changedKeys ?? [],
            epoch: Number(data.epoch ?? 0),
        }
    }
}

// ── Plugin-facing, namespace-scoped surface ─────────────────────────────────

export interface PluginScopedAtomicApi {
    read<T = unknown>(key: string): Promise<PluginAtomicRecord<T>>
    readMany<T = unknown>(keys: string[]): Promise<PluginAtomicRecord<T>[]>
    list(input: { prefix?: string; cursor?: string | null; limit?: number }): Promise<PluginAtomicListPage>
    cas<T = unknown>(input: CasPluginAtomicParams<T>): Promise<PluginAtomicMutationResult>
    remove(input: RemovePluginAtomicParams): Promise<PluginAtomicMutationResult>
    getReceipt(operationKey: string): Promise<PluginAtomicReceipt | null>
    changes(input: { prefix?: string; afterCursor?: string | null; limit?: number }): Promise<PluginAtomicChangesPage>
}

export interface PluginNamespacedAtomicApiOptions {
    /** Persisted plugin installation id. The caller is the ONLY source. */
    installId: string | undefined
    /** Injectable client for tests. Defaults to a fresh, per-plugin instance. */
    client?: PluginAtomicClient
}

export function createPluginNamespacedAtomicApi(
    options: PluginNamespacedAtomicApiOptions,
): PluginScopedAtomicApi {
    const installId = options.installId
    if (typeof installId !== 'string' || !INSTALL_ID_PATTERN.test(installId)) {
        throw new PluginAtomicIdentityError()
    }
    // A fresh client per plugin by default, so one plugin's revision cache can
    // never be observed (or poisoned) through another's surface.
    const client = options.client ?? new PluginAtomicClient()
    const prefix = pluginNamespacePrefix(installId)

    const abs = (key: unknown): string => `${prefix}${typeof key === 'string' ? key : ''}`
    const rel = (key: string): string => (key.startsWith(prefix) ? key.slice(prefix.length) : key)

    return {
        async read<T = unknown>(key: string) {
            const record = await client.read<T>(abs(key))
            return { ...record, key: rel(record.key) }
        },
        async readMany<T = unknown>(keys: string[]) {
            if (!Array.isArray(keys)) throw new PluginAtomicBadRequestError('keys must be an array')
            const records = await client.readMany<T>(keys.map(abs))
            return records.map((record) => ({ ...record, key: rel(record.key) }))
        },
        async list(input) {
            const page = await client.list(abs(input?.prefix ?? ''), {
                // The server cursor IS a key, so it needs the same treatment.
                cursor: input?.cursor ? abs(input.cursor) : undefined,
                limit: input?.limit,
            })
            return {
                items: page.items.map((item) => ({ ...item, key: rel(item.key) })),
                nextCursor: page.nextCursor === null ? null : rel(page.nextCursor),
            }
        },
        cas(input) {
            return client.cas({ ...input, key: abs(input?.key) })
        },
        remove(input) {
            return client.remove({ ...input, key: abs(input?.key) })
        },
        getReceipt(operationKey: string) {
            return client.getReceipt(operationKey)
        },
        async changes(input) {
            const page = await client.changes({
                prefix: abs(input?.prefix ?? ''),
                afterCursor: input?.afterCursor,
                limit: input?.limit,
            })
            return { ...page, changedKeys: page.changedKeys.map(rel) }
        },
    }
}

// ── Sandbox-facing surface (V3 plugins) ─────────────────────────────────────
//
// Everything above throws typed errors. Those cannot survive the V3 sandbox
// bridge: it serializes a rejection as `err.message` only (apiV3/factory.ts:707
// and :215), so a plugin would receive a bare Error with no `code`,
// `currentRevision` or `epoch` — and the request's contract is explicit that
// conflicts must be TYPED and distinguishable. The plugin-facing methods
// therefore resolve to a discriminated result envelope instead of rejecting, so
// every code and detail field crosses the boundary intact.

export interface PluginAtomicFailure {
    ok: false
    code: string
    message: string
    /** PLUGIN_ATOMIC_CONFLICT only. */
    currentRevision?: number
    /** PLUGIN_ATOMIC_CONFLICT only. */
    currentDeleted?: boolean
    /** PLUGIN_ATOMIC_RECEIPT_MISMATCH only. */
    operationKey?: string
    /** PLUGIN_ATOMIC_CURSOR_EXPIRED only. */
    epoch?: number
}

export type PluginAtomicResult<T> = ({ ok: true } & T) | PluginAtomicFailure

export interface PluginAtomicSandboxApi {
    read(key: string): Promise<PluginAtomicResult<PluginAtomicRecord>>
    readMany(keys: string[]): Promise<PluginAtomicResult<{ items: PluginAtomicRecord[] }>>
    list(input: { prefix?: string; cursor?: string | null; limit?: number }): Promise<PluginAtomicResult<PluginAtomicListPage>>
    cas(input: CasPluginAtomicParams): Promise<PluginAtomicResult<PluginAtomicMutationResult>>
    remove(input: RemovePluginAtomicParams): Promise<PluginAtomicResult<PluginAtomicMutationResult>>
    getReceipt(operationKey: string): Promise<PluginAtomicResult<{ receipt: PluginAtomicReceipt | null }>>
    changes(input: { prefix?: string; afterCursor?: string | null; limit?: number }): Promise<PluginAtomicResult<PluginAtomicChangesPage>>
}

export function toPluginAtomicFailure(error: unknown): PluginAtomicFailure {
    if (error instanceof PluginAtomicError) {
        const failure: PluginAtomicFailure = { ok: false, code: error.code, message: error.message }
        if (error instanceof PluginAtomicConflictError) {
            failure.currentRevision = error.currentRevision
            failure.currentDeleted = error.currentDeleted
        } else if (error instanceof PluginAtomicReceiptMismatchError) {
            failure.operationKey = error.operationKey
        } else if (error instanceof PluginAtomicCursorExpiredError) {
            failure.epoch = error.epoch
        }
        return failure
    }
    return {
        ok: false,
        code: 'PLUGIN_ATOMIC_UNKNOWN',
        message: error instanceof Error ? error.message : String(error),
    }
}

async function envelope<T>(run: () => Promise<T>): Promise<PluginAtomicResult<T>> {
    try {
        return { ok: true, ...(await run()) }
    } catch (error) {
        return toPluginAtomicFailure(error)
    }
}

/**
 * Build the surface handed to a V3 plugin. A missing/malformed installId does
 * NOT throw here: that would take the whole plugin down at load time. Instead
 * every call fails closed with PLUGIN_ATOMIC_NO_INSTALL_ID, which is loud,
 * recoverable, and can never write to a guessed namespace.
 */
export function createPluginAtomicSandboxApi(
    options: PluginNamespacedAtomicApiOptions,
): PluginAtomicSandboxApi {
    let scoped: PluginScopedAtomicApi | null = null
    let identityFailure: PluginAtomicFailure | null = null
    try {
        scoped = createPluginNamespacedAtomicApi(options)
    } catch (error) {
        identityFailure = toPluginAtomicFailure(error)
    }

    const call = <T>(run: (api: PluginScopedAtomicApi) => Promise<T>): Promise<PluginAtomicResult<T>> => {
        if (!scoped) return Promise.resolve(identityFailure!)
        return envelope(() => run(scoped!))
    }

    return {
        read: (key) => call((api) => api.read(key)),
        readMany: (keys) => call(async (api) => ({ items: await api.readMany(keys) })),
        list: (input) => call((api) => api.list(input ?? {})),
        cas: (input) => call((api) => api.cas(input)),
        remove: (input) => call((api) => api.remove(input)),
        getReceipt: (operationKey) => call(async (api) => ({ receipt: await api.getReceipt(operationKey) })),
        changes: (input) => call((api) => api.changes(input ?? {})),
    }
}
