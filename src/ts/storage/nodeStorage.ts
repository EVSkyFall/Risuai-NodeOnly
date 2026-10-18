// ── NodeOnly: server-side JWT ────────────────────────────────────────────────
// Upstream uses client-side ECDSA JWT (crypto.subtle) which requires Secure
// Context (HTTPS/localhost). NodeOnly needs HTTP remote access, so JWT
// signing is moved to the server. The client only caches and forwards
// server-issued tokens. If upstream changes its auth flow, sync manually.
// Server counterpart: server/node/server.cjs (createServerJwt, checkAuth,
// /api/login, /api/token/refresh)
import { language } from "src/lang"
import { alertInput, waitAlert, notifyError } from "../alert"
import { decodeRisuSave, encodeRisuSaveLegacy } from "./risuSave"
import { normalizeChat } from "./database.svelte"
import type { PatchServerTimings } from "./saveMetrics"

const AUTH_FETCH_TRANSIENT_MAX_RETRIES = 3
const AUTH_FETCH_TRANSIENT_BASE_DELAY_MS = 500
const AUTH_FETCH_TRANSIENT_JITTER_MIN = 0.5
const AUTH_FETCH_TRANSIENT_JITTER_MAX = 1.5
const AUTH_FETCH_TRANSIENT_STATUS = new Set([502, 503, 504])

export type StorageFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface AuthFetchRetryOptions {
    maxRetries: number
    baseDelayMs: number
    jitterMin: number
    jitterMax: number
    random: () => number
    delay: (ms: number) => Promise<void>
}

const defaultStorageFetch: StorageFetch = (input, init) => fetch(input, init)
const defaultAuthFetchRetryOptions: AuthFetchRetryOptions = {
    maxRetries: AUTH_FETCH_TRANSIENT_MAX_RETRIES,
    baseDelayMs: AUTH_FETCH_TRANSIENT_BASE_DELAY_MS,
    jitterMin: AUTH_FETCH_TRANSIENT_JITTER_MIN,
    jitterMax: AUTH_FETCH_TRANSIENT_JITTER_MAX,
    random: Math.random,
    delay: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
}

// Custom error class for database conflict detection
export class ConflictError extends Error {
    currentEtag: string
    /** Server guard code (e.g. ARCHIVE_GUARD_REJECTED); undefined for a plain etag conflict. */
    code?: string
    constructor(message: string, currentEtag: string, code?: string) {
        super(message)
        this.name = 'ConflictError'
        this.currentEtag = currentEtag
        this.code = code
    }
}

export interface ChatContentBackupWarning {
    message: string
    source: string
}

export interface DurableChatSaveResult {
    success: true
    durable: true
    backupWarning?: ChatContentBackupWarning
}

export class DurableChatSaveError extends Error {
    status: number
    source?: string
    constructor(message: string, status: number, source?: string) {
        super(message)
        this.name = 'DurableChatSaveError'
        this.status = status
        this.source = source

    }
}

export class StorageRequestError extends Error {
    constructor(
        message: string,
        public readonly op: string,
        public readonly status?: number,
        public readonly serverMessage?: string
    ) {
        super(message)
        this.name = 'StorageRequestError'
        Object.setPrototypeOf(this, StorageRequestError.prototype)
    }
}

// Thrown by importBackup when the server rejects a backup. `code` is the
// server's machine-readable reason (e.g. BACKUP_ENCRYPTED) so the UI can show
// a localized explanation instead of the raw message.
export class BackupImportError extends Error {
    constructor(message: string, public readonly code: string | null = null) {
        super(message)
        this.name = 'BackupImportError'
        Object.setPrototypeOf(this, BackupImportError.prototype)
    }
}

// Warning the server attaches to /api/patch responses when the most recent
// debounced persist failed (Stage 1 visibility — see issues.md).
export interface PersistWarning {
    timestamp: number
    message: string
    attemptedSize: number | null
    source: string
}

export interface PatchItemResult {
    success: boolean
    etag?: string
    persistWarning?: PersistWarning
    /** Set when the server's chat-internal-field guard rejected the patch. */
    chatGuardRejected?: boolean
    /** Server-side per-key hashes sent with a hash-mismatch 409. */
    hashDiagnostics?: PatchHashDiagnostics
    /** `code` / `error` of a 409 body, for logging which guard rejected the patch. */
    conflictCode?: string
    conflictError?: string
    /** Server stage timings on success (older servers omit them). */
    serverTimings?: PatchServerTimings
}

/** Hash fields a 409 or a full-write response may carry; null when absent. */
export function parseHashDiagnostics(data: any): PatchHashDiagnostics | null {
    if (!data || typeof data !== 'object') return null
    if (!(data.keyHashes || data.characterHashes || typeof data.serverHash === 'string')) return null
    return {
        serverHash: typeof data.serverHash === 'string' ? data.serverHash : undefined,
        keyHashes: data.keyHashes && typeof data.keyHashes === 'object' ? data.keyHashes : undefined,
        characterHashes: data.characterHashes && typeof data.characterHashes === 'object' ? data.characterHashes : undefined,
        duplicateCharIds: Array.isArray(data.duplicateCharIds) ? data.duplicateCharIds.filter((id: unknown) => typeof id === 'string') : undefined,
    }
}

export interface PatchHashDiagnostics {
    serverHash?: string
    /** Root key → hex hash of the server's current value. */
    keyHashes?: Record<string, string>
    /** chaId (or `#index` when missing) → hex hash of the server's stubbed character (first occurrence). */
    characterHashes?: Record<string, string>
    /** chaIds that repeat in the server's characters array. */
    duplicateCharIds?: string[]
}

export interface ExportBackupOptions {
    /** Strip NodeOnly-only inlay namespaces so upstream RisuAI can import it. */
    target?: 'upstream'
    /** Drop characters, chats and inlay images — a seed for a fresh instance. */
    mode?: 'settings'
    /**
     * Carry asset-pack module images. Defaults to true; set false to leave out
     * what is usually the bulk of a settings backup. Only meaningful with
     * `mode: 'settings'`.
     */
    moduleAssets?: boolean
}

/** Size breakdown backing the settings-only confirm dialog. */
export interface PluginStorageIndex {
    entries: { key: string, size: number, updatedAt?: number | null }[]
    migrated: boolean
}

export interface SettingsBackupEstimate {
    dbBytes: number
    baseAssets: { count: number, bytes: number }
    moduleAssets: { count: number, bytes: number, moduleCount: number }
}

export type AssetManifestTuple = [string, string] | [string, string, string]

export type AssetNameResolution = { resolved: Record<string, string>; fuzzy: string[] }

export interface AssetManifestDescriptor {
    id: string
    version: number
    count: number
    sha256: string
    ownerKind?: 'module' | 'character' | 'persona-module'
    ownerId?: string
}

export interface AssetManifestPage {
    total: number
    offset: number
    limit: number
    items: AssetManifestTuple[]
}

export type AssetManifestOperation =
    | { type: 'append'; item: AssetManifestTuple }
    | { type: 'insert'; index: number; item: AssetManifestTuple }
    | { type: 'remove'; index: number }
    | { type: 'rename'; index: number; name: string }
    | { type: 'replace'; index: number; item: AssetManifestTuple }

export class NodeStorage{
    private static readonly BULK_WRITE_CLIENT_BATCH = 20

    _lastDbEtag: string | null = null

    private _lastDbWriteDiagnostics: PatchHashDiagnostics | null = null
    authChecked = false
    private cachedJwt: { token: string; expiresAt: number } | null = null
    private refreshPending: Promise<string> | null = null
    private refreshTimer: ReturnType<typeof setTimeout> | undefined
    private refreshRetryDelay = 5000

    constructor(
        private readonly fetchFn: StorageFetch = defaultStorageFetch,
        private readonly retryOptions: Partial<AuthFetchRetryOptions> = {}
    ) {}

    async createAuth(forceRefresh = false){
        if (!forceRefresh && this.cachedJwt && this.cachedJwt.expiresAt > Date.now()) {
            return this.cachedJwt.token
        }
        return this._refreshToken()
    }

    private cacheToken(token: string) {
        const payload = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'))
        const receiptTime = Date.now()
        const remaining = Number.isFinite(payload.exp) && Number.isFinite(payload.iat)
            ? (payload.exp - payload.iat) * 1000
            : 5 * 60 * 1000
        this.cachedJwt = { token, expiresAt: receiptTime + remaining }
        if (Number.isFinite(remaining) && remaining > 0) {
            this.refreshRetryDelay = 5000
            this.scheduleTokenRefresh(remaining / 2)
        } else {
            this.scheduleTokenRefresh(this.refreshRetryDelay)
            this.refreshRetryDelay = Math.min(this.refreshRetryDelay * 2, 60000)
        }
    }

    private scheduleTokenRefresh(delay: number) {
        if (this.refreshTimer) clearTimeout(this.refreshTimer)
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined
            void this._refreshToken().catch((error) => {
                console.error('[Auth] Background refresh failed:', error)
                this.scheduleTokenRefresh(this.refreshRetryDelay)
                this.refreshRetryDelay = Math.min(this.refreshRetryDelay * 2, 60000)
            })
        }, delay)
        ;(this.refreshTimer as any).unref?.()
    }

    // Issue at boot and renew after JWT refresh for headerless asset requests.
    private async initSession(token: string) {
        try {
            const res = await fetch('/api/session', {
                method: 'POST',
                headers: { 'risu-auth': token },
            })
            if (!res.ok) throw new Error(`Session renewal failed with HTTP ${res.status}`)
        } catch (error) {
            console.warn('[Auth] Session renewal failed:', error)
        }
    }

    private async _refreshToken(): Promise<string> {
        if (this.refreshPending) return this.refreshPending
        this.refreshPending = this._doRefreshToken()
        try { return await this.refreshPending }
        finally { this.refreshPending = null }
    }

    private async _doRefreshToken(): Promise<string> {
        try {
            const res = await fetch('/api/token/refresh', {
                method: 'POST',
                headers: { 'risu-auth': this.cachedJwt?.token ?? '' }
            })
            if (!res.ok) throw new Error(`Token refresh failed with HTTP ${res.status}`)
            const data = await res.json()
            this.cacheToken(data.token)
            void this.initSession(data.token)
            return data.token
        } catch {
            this.authChecked = false
            // Renew the session after recovery so token refresh never waits for it.
            await this.checkAuth(false)
            if (!this.cachedJwt || this.cachedJwt.expiresAt <= Date.now()) {
                this.authChecked = false
                throw new Error('Authentication did not issue an unexpired token')
            }
            void this.initSession(this.cachedJwt.token)
            return this.cachedJwt.token
        }
    }

    private async loginWithPassword(password: string) {
        const response = await fetch('/api/login', {
            method: "POST",
            body: JSON.stringify({ password }),
            headers: {
                'content-type': 'application/json'
            }
        })

        if(response.status === 429){
            notifyError(`Too many attempts. Please wait and try again later.`)
            await waitAlert()
            throw new Error('Too many login attempts')
        }

        if(response.status < 200 || response.status >= 300){
            let message = 'Node login failed'
            try {
                const data = await response.json()
                message = data.error ?? message
            } catch {
                // noop
            }
            throw new Error(message)
        }

        const data = await response.json()
        if (data.token) {
            this.cacheToken(data.token)
        }
        this.authChecked = true
    }

    private async shouldRetryAuth(response: Response) {
        if(response.status !== 400 && response.status !== 401){
            return false
        }

        try {
            const data = await response.clone().json()
            return [
                'No auth header',
                'Invalid Signature',
                'Token Expired'
            ].includes(data?.error)
        } catch {
            return false
        }
    }

    private getAuthFetchRetryOptions(): AuthFetchRetryOptions {
        return {
            ...defaultAuthFetchRetryOptions,
            ...this.retryOptions,
        }
    }

    private getTransientRetryDelay(attempt: number, options: AuthFetchRetryOptions): number {
        if (options.baseDelayMs <= 0) return 0
        const jitterRange = options.jitterMax - options.jitterMin
        const jitter = options.jitterMin + (options.random() * jitterRange)
        return options.baseDelayMs * (2 ** attempt) * jitter
    }

    private isAbortError(error: unknown): boolean {
        return error instanceof DOMException && error.name === 'AbortError'
            || error instanceof Error && error.name === 'AbortError'
    }

    private isTransientStatus(status: number): boolean {
        return AUTH_FETCH_TRANSIENT_STATUS.has(status)
    }

    private abortReason(signal: AbortSignal): unknown {
        return (signal as AbortSignal & { reason?: unknown }).reason
            ?? new DOMException('The operation was aborted.', 'AbortError')
    }

    private async authFetch(input: RequestInfo | URL, init: RequestInit = {}, retry = true) {
        const retryOptions = this.getAuthFetchRetryOptions()
        let transientRetries = 0

        while (true) {
            if (init.signal?.aborted) {
                throw this.abortReason(init.signal)
            }

            try {
                const response = await this.authFetchOnce(input, init, retry)
                if (!this.isTransientStatus(response.status) || transientRetries >= retryOptions.maxRetries) {
                    return response
                }

                const delayMs = this.getTransientRetryDelay(transientRetries, retryOptions)
                transientRetries += 1
                await retryOptions.delay(delayMs)
            } catch (error) {
                if (init.signal?.aborted || this.isAbortError(error)) {
                    throw error
                }
                // Only genuine network failures retry — fetch rejects those as
                // TypeError. Auth/login errors and bugs must surface at once.
                if (!(error instanceof TypeError)) {
                    throw error
                }
                if (transientRetries >= retryOptions.maxRetries) {
                    throw error
                }

                const delayMs = this.getTransientRetryDelay(transientRetries, retryOptions)
                transientRetries += 1
                await retryOptions.delay(delayMs)
            }
        }
    }

    private async authFetchOnce(input: RequestInfo | URL, init: RequestInit = {}, retry = true) {
        await this.checkAuth()
        const headers = new Headers(init.headers)
        headers.set('risu-auth', await this.createAuth())
        if (init.signal?.aborted) {
            throw this.abortReason(init.signal)
        }

        // Storage calls share one URL per endpoint and differ only by headers,
        // so Chrome's HTTP cache can serialize them on one cache entry. An asset
        // read once sat "Stalled" forever without ever reaching the server.
        const response = await this.fetchFn(input, {
            cache: 'no-store',
            ...init,
            headers
        })

        if(retry && await this.shouldRetryAuth(response)){
            this.authChecked = false
            this.cachedJwt = null
            await this.checkAuth()
            return this.authFetchOnce(input, init, false)
        }

        return response
    }

    private async readStorageServerMessage(response: Response): Promise<string | undefined> {
        try {
            const data = await response.clone().json()
            return typeof data?.error === 'string' ? data.error : undefined
        } catch {
            return undefined
        }
    }

    private buildStorageRequestMessage(op: string, status?: number, serverMessage?: string): string {
        let message = status === 413 && (op === 'setItem' || op === 'setItems')
            ? language.errors.storageRequestTooLarge
            : `${op} failed${status ? ` with HTTP ${status}` : ''}`
        if (serverMessage) {
            message += `: ${serverMessage}`
        }
        return message
    }

    private async storageRequestError(op: string, response: Response): Promise<StorageRequestError> {
        const serverMessage = await this.readStorageServerMessage(response)
        return new StorageRequestError(
            this.buildStorageRequestMessage(op, response.status, serverMessage),
            op,
            response.status,
            serverMessage
        )
    }

    async setItem(key:string, value:Uint8Array, etag?:string, signal?:AbortSignal) {
        const headers: Record<string, string> = {
            'content-type': 'application/octet-stream',
            'file-path': Buffer.from(key, 'utf-8').toString('hex')
        }
        if (etag) {
            headers['x-if-match'] = etag
        }
        const da = await this.authFetch('/api/write', {
            method: "POST",
            body: value as any,
            headers,
            signal
        })
        if(da.status === 409){
            const data = await da.json()
            throw new ConflictError(data.error, data.currentEtag, typeof data.code === 'string' ? data.code : undefined)
        }
        if(da.status < 200 || da.status >= 300){
            throw await this.storageRequestError('setItem', da)
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
        const nextEtag = data.etag as string | undefined
        if (key === 'database/database.bin' && nextEtag) {
            this._lastDbEtag = nextEtag
        }
        if (key === 'database/database.bin') {
            this._lastDbWriteDiagnostics = parseHashDiagnostics(data)
        }
    }

    /** Hashes of the view the last database.bin full write persisted; consumed once. */
    takeDbWriteDiagnostics(): PatchHashDiagnostics | null {
        const diagnostics = this._lastDbWriteDiagnostics
        this._lastDbWriteDiagnostics = null
        return diagnostics
    }
    async getItem(key:string):Promise<Buffer> {
        const headers: Record<string, string> = {
            'file-path': Buffer.from(key, 'utf-8').toString('hex')
        }

        // database.bin keeps HTTP revalidation (304 on an unchanged boot).
        const cache: RequestCache = key === 'database/database.bin' ? 'default' : 'no-store'
        const da = await this.authFetch('/api/read', { method: "GET", headers, cache })
        if(da.status < 200 || da.status >= 300){
            throw await this.storageRequestError('getItem', da)
        }

        // Capture ETag for database.bin
        const etag = da.headers.get('x-db-etag')
        if (etag) {
            this._lastDbEtag = etag
        }

        const data = Buffer.from(await da.arrayBuffer())
        if (data.length === 0){
            return null
        }

        return data
    }
    async keys(prefix: string = ''):Promise<string[]>{
        const headers: Record<string, string> = {
        }
        if (prefix) {
            headers['key-prefix'] = prefix
        }
        const da = await this.authFetch('/api/list', {
            method: "GET",
            headers
        })
        if(da.status < 200 || da.status >= 300){
            throw await this.storageRequestError('listItem', da)
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
        return data.content
    }
    async removeItem(key:string){
        const da = await this.authFetch('/api/remove', {
            method: "GET",
            headers: {
                'file-path': Buffer.from(key, 'utf-8').toString('hex')
            }
        })
        if(da.status < 200 || da.status >= 300){
            throw await this.storageRequestError('removeItem', da)
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
    }

    private authPending: Promise<void> | null = null
    private async checkAuth(initializeSession = true) {
        const needsAuth = !this.authChecked
        if (needsAuth) {
            this.authPending ??= this.runAuthCheck().finally(() => { this.authPending = null })
            await this.authPending
        }
        if (needsAuth && initializeSession && this.cachedJwt) await this.initSession(this.cachedJwt.token)
    }
    private async runAuthCheck() {
        const initializeSession = false

        if(!this.authChecked){
            const data = await (await fetch('/api/test_auth',{
                headers: {
                    'risu-auth': this.cachedJwt?.token ?? ''
                }
            })).json()

            if(data.status === 'unset'){
                const input = await digestPassword(await alertInput(language.setNodePassword))
                const response = await fetch('/api/set_password',{
                    method: "POST",
                    body:JSON.stringify({
                        password: input 
                    }),
                    headers: {
                        'content-type': 'application/json'
                    }
                })

                if(response.status < 200 || response.status >= 300){
                    throw new Error('Failed to set node password')
                }

                await this.loginWithPassword(input)
                if (initializeSession && this.cachedJwt) await this.initSession(this.cachedJwt.token)
                return
            }
            else if(data.status === 'incorrect'){
                const input = await digestPassword(await alertInput(language.inputNodePassword))
                await this.loginWithPassword(input)
                if (initializeSession && this.cachedJwt) await this.initSession(this.cachedJwt.token)
                return
            }
            else{
                if (data.status !== 'success' || !data.token) {
                    throw new Error('Authentication did not issue a token')
                }
                if (data.token) {
                    this.cacheToken(data.token)
                }
                this.authChecked = true
            }
            if (initializeSession && this.cachedJwt) await this.initSession(this.cachedJwt.token)
        }
    }

    listItem = this.keys

    /** Set cached ETag for database.bin */
    setDbEtag(etag: string | null) {
        this._lastDbEtag = etag
    }

    async patchItem(key: string, patchData: { patch: any[], expectedHash: string }): Promise<PatchItemResult> {
        const da = await this.authFetch('/api/patch', {
            method: "POST",
            body: JSON.stringify(patchData),
            headers: {
                'content-type': 'application/json',
                'file-path': Buffer.from(key, 'utf-8').toString('hex')
            }
        })

        if (da.status === 409) {
            const data = await da.json()
            // The server's etag is returned for the caller to compare, not
            // adopted: if it differs from the one this client last synced
            // against, someone else wrote in between, and adopting it would
            // let the full-write fallback pass x-if-match and overwrite them.
            const currentEtag = data.currentEtag as string | undefined
            // Server signals chat-guard rejection via explicit fields. The
            // error string fallback is kept for forward-compat with deployed
            // servers that haven't shipped the explicit fields yet.
            const rejectedByChatGuard = data.chatGuardRejected === true
                || data.code === 'CHAT_GUARD_REJECTED'
                || (typeof data.error === 'string' && data.error.includes('chat-internal field ops'))
            return {
                success: false,
                etag: currentEtag,
                chatGuardRejected: rejectedByChatGuard,
                hashDiagnostics: parseHashDiagnostics(data) ?? undefined,
                conflictCode: typeof data.code === 'string' ? data.code : undefined,
                conflictError: typeof data.error === 'string' ? data.error : undefined,
            }
        }
        if (da.status < 200 || da.status >= 300) {
            // Surface the server's error detail — without this the browser
            // console shows nothing while every save silently falls back to
            // a full write.
            const body = await da.text().catch(() => '')
            console.error(`[Patch] Server rejected patch (${da.status}):`, body)
            return { success: false }
        }
        const data = await da.json()
        if (data.error) {
            return { success: false }
        }
        const nextEtag = data.etag as string | undefined
        if (key === 'database/database.bin' && nextEtag) {
            this._lastDbEtag = nextEtag
        }
        const persistWarning = data.persistWarning as PersistWarning | undefined
        const serverTimings = data.timings && typeof data.timings === 'object'
            ? data.timings as PatchServerTimings
            : undefined
        return { success: true, etag: nextEtag, persistWarning, serverTimings }
    }

    // ── Bulk asset operations (3-2-B) ──────────────────────────────────────────
    async getItems(keys: string[]): Promise<{key: string, value: Buffer}[]> {
        const da = await this.authFetch('/api/assets/bulk-read', {
            method: 'POST',
            body: JSON.stringify(keys),
            headers: {
                'content-type': 'application/json',
                'accept': 'application/octet-stream'
            }
        })
        if (da.status < 200 || da.status >= 300) throw 'getItems Error'

        const ct = da.headers.get('content-type') || ''
        if (ct.includes('application/octet-stream')) {
            // Binary protocol: [count(4)] then per entry: [keyLen(4)][key][valLen(4)][value]
            const buf = Buffer.from(await da.arrayBuffer())
            let offset = 0
            const count = buf.readUInt32BE(offset); offset += 4
            const results: {key: string, value: Buffer}[] = []
            for (let i = 0; i < count; i++) {
                const keyLen = buf.readUInt32BE(offset); offset += 4
                const key = buf.subarray(offset, offset + keyLen).toString('utf-8'); offset += keyLen
                const valLen = buf.readUInt32BE(offset); offset += 4
                const value = buf.subarray(offset, offset + valLen) as Buffer; offset += valLen
                results.push({ key, value })
            }
            return results
        }

        // Fallback: JSON+base64
        const results: {key: string, value: string}[] = await da.json()
        return results.map(r => ({ key: r.key, value: Buffer.from(r.value, 'base64') }))
    }

    async setItems(entries: {key: string, value: Uint8Array}[]) {
        for (let i = 0; i < entries.length; i += NodeStorage.BULK_WRITE_CLIENT_BATCH) {
            const batch = entries.slice(i, i + NodeStorage.BULK_WRITE_CLIENT_BATCH)
            const body = batch.map(e => ({
                key: e.key,
                value: Buffer.from(e.value).toString('base64')
            }))
            const da = await this.authFetch('/api/assets/bulk-write', {
                method: 'POST',
                body: JSON.stringify(body),
                headers: {
                    'content-type': 'application/json'
                }
            })
            if (da.status < 200 || da.status >= 300) throw await this.storageRequestError('setItems', da)
        }
    }

    // ── Lazy asset-reference manifests ────────────────────────────────────────
    async getAssetManifestPage(
        manifest: string | AssetManifestDescriptor,
        options: { offset?: number; limit?: number; search?: string } = {},
    ): Promise<AssetManifestPage> {
        const descriptor = typeof manifest === 'string' ? null : manifest
        let manifestId = typeof manifest === 'string' ? manifest : manifest.id
        const params = new URLSearchParams()
        if (options.offset != null) params.set('offset', String(options.offset))
        if (options.limit != null) params.set('limit', String(options.limit))
        if (options.search) params.set('search', options.search)
        // The server caches pages as immutable (content-addressed ids); the
        // format version in the URL keeps a newer client from reading a page
        // shape cached by an older one.
        if (descriptor?.version != null) params.set('v', String(descriptor.version))
        const query = params.toString()
        for (let attempt = 0; attempt < 2; attempt++) {
            const da = await this.authFetch(`/api/asset-manifests/${encodeURIComponent(manifestId)}${query ? `?${query}` : ''}`)
            if (da.ok) return await da.json()
            if (da.status !== 404 || !descriptor?.ownerKind || !descriptor.ownerId || attempt > 0) {
                throw new Error(`asset manifest read error: ${da.status}`)
            }

            // Superseded manifest rows are pruned on activation. A 404 for a
            // descriptor that carries owner information means the client must
            // refresh the owner's live descriptor and retry once.
            const live = await this.getAssetManifestOwner(descriptor.ownerKind, descriptor.ownerId)
            if (!live) throw new Error('asset manifest owner is no longer live')
            Object.assign(descriptor, live)
            manifestId = live.id
        }
        throw new Error('asset manifest read retry exhausted')
    }

    async getAssetManifestOwner(ownerKind: string, ownerId: string): Promise<AssetManifestDescriptor | null> {
        const da = await this.authFetch(
            `/api/asset-manifests/owner/${encodeURIComponent(ownerKind)}/${encodeURIComponent(ownerId)}`,
        )
        if (da.status === 404) return null
        if (!da.ok) throw new Error(`asset manifest owner read error: ${da.status}`)
        return await da.json()
    }

    async getAllAssetManifestItems(manifest: AssetManifestDescriptor): Promise<AssetManifestTuple[]> {
        const pageSize = 500
        // Pages are fetched in parallel: sequential paging cost one RTT per
        // 500 assets (a 5,000-asset manifest = ~10 round trips), which is
        // what made warming the manifest cache slow over remote links.
        // getAssetManifestPage may refresh the descriptor in place when the
        // revision was superseded mid-flight; tuples from two revisions must
        // never mix, so any id change discards everything and restarts
        // against the fresh descriptor.
        for (let attempt = 0; attempt < 3; attempt++) {
            const requestedManifestId = manifest.id
            const count = manifest.count
            if (count <= 0) return []
            const pageCount = Math.ceil(count / pageSize)
            const pages = await Promise.all(Array.from({ length: pageCount }, (_, i) =>
                this.getAssetManifestPage(manifest, { offset: i * pageSize, limit: pageSize }),
            ))
            if (manifest.id !== requestedManifestId) continue
            const items = pages.flatMap((page) => page.items)
            if (items.length !== count) {
                throw new Error(`asset manifest count mismatch: expected ${count}, got ${items.length}`)
            }
            return items
        }
        throw new Error('asset manifest kept changing while loading; retry exhausted')
    }

    async resolveAssetManifestNames(
        owners: Array<{ kind?: string; ownerId?: string; manifestId?: string; fuzzy?: boolean }>,
        names: string[],
        maxDistance: number,
    ): Promise<AssetNameResolution> {
        const da = await this.authFetch('/api/asset-manifests/resolve', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ owners, names, maxDistance }),
        })
        if (!da.ok) throw new Error(`asset manifest resolve error: ${da.status}`)
        const body = await da.json()
        // `fuzzy` lists the names only the fuzzy fallback matched (older
        // servers omit it: treat everything as exact, as before).
        return { resolved: body.resolved ?? {}, fuzzy: Array.isArray(body.fuzzy) ? body.fuzzy : [] }
    }

    async editAssetManifest(
        ownerKind: string,
        ownerId: string,
        expectedManifestId: string,
        operations: AssetManifestOperation[],
    ): Promise<AssetManifestDescriptor> {
        const da = await this.authFetch(
            `/api/asset-manifests/owner/${encodeURIComponent(ownerKind)}/${encodeURIComponent(ownerId)}`,
            {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ expectedManifestId, operations }),
            },
        )
        if (da.status === 409) {
            const body = await da.json().catch(() => ({}))
            const error = new ConflictError('Asset manifest revision conflict', '') as ConflictError & {
                current?: AssetManifestDescriptor
            }
            error.current = body?.current
            throw error
        }
        if (!da.ok) throw new Error(`asset manifest edit error: ${da.status}`)
        return await da.json()
    }

    /** Hands the backup export to the browser's own download manager. */
    async downloadBackupExport(opts?: ExportBackupOptions): Promise<void> {
        const params = new URLSearchParams()
        if (opts?.target === 'upstream') params.set('target', 'upstream')
        if (opts?.mode === 'settings') params.set('mode', 'settings')
        if (opts?.moduleAssets === false) params.set('moduleAssets', '0')
        const query = params.toString()
        await this.startCookieDownload(query ? `/api/backup/export?${query}` : '/api/backup/export')
    }

    // A backup is streamed by the browser's download manager straight to disk
    // instead of relayed through this tab (whose memory Safari fills with the
    // whole file, and which non-secure origins route through a third-party
    // page). The GET authenticates with the session cookie, so refresh it
    // first. No x-session-id: registering a boot here would disturb the
    // writer lock.
    private async startCookieDownload(url: string): Promise<void> {
        const res = await fetch('/api/session', {
            method: 'POST',
            headers: { 'risu-auth': await this.createAuth() },
        })
        if (!res.ok) throw new Error(`session refresh failed: ${res.status}`)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = ''
        anchor.style.display = 'none'
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
    }

    // Key names + sizes only; values stay on the server until read per key.
    async getPluginStorageIndex(): Promise<PluginStorageIndex> {
        const da = await this.authFetch('/api/plugin-storage/index', { method: 'GET' })
        if (da.status < 200 || da.status >= 300) throw await this.storageRequestError('pluginStorageIndex', da)
        return await da.json()
    }

    // Streams every plugin-storage value (NDJSON `[key, json]` per line).
    async getPluginStorageAll(onEntry: (key: string, text: string) => void): Promise<void> {
        const da = await this.authFetch('/api/plugin-storage/all', { method: 'GET' })
        if (da.status < 200 || da.status >= 300) throw await this.storageRequestError('pluginStorageAll', da)
        const reader = da.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop()!
            for (const line of lines) {
                if (!line) continue
                const [key, text] = JSON.parse(line)
                onEntry(key, text)
            }
        }
        buffer += decoder.decode()
        if (buffer.trim()) {
            const [key, text] = JSON.parse(buffer)
            onEntry(key, text)
        }
    }

    async settingsBackupEstimate(): Promise<SettingsBackupEstimate> {
        const da = await this.authFetch('/api/backup/export/settings-estimate')
        if (da.status < 200 || da.status >= 300) throw `settings estimate error: ${da.status}`
        return await da.json()
    }

    async prepareImport(size: number): Promise<void> {
        const da = await this.authFetch('/api/backup/import/prepare', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ size }),
        })
        if (da.status === 409) throw new Error('Another import is already in progress')
        if (da.status === 413) throw new Error('Backup file is too large')
        if (da.status === 507) {
            const body = await da.json().catch(() => ({}))
            const avail = body.available != null ? ` (available: ${Math.round(body.available / 1024 / 1024)} MB)` : ''
            throw new Error(`Insufficient disk space${avail}`)
        }
        if (da.status < 200 || da.status >= 300) throw new Error(`backup prepare error: ${da.status}`)
    }

    async importBackup(
        file: Blob,
        onProgress?: (loaded: number, total: number) => void
    ): Promise<{ok: boolean, assetsRestored: number, coldStorageFailed?: number}> {
        await this.prepareImport(file.size)
        const authHeader = await this.createAuth()

        return await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest()
            xhr.open('POST', '/api/backup/import')
            xhr.setRequestHeader('content-type', 'application/x-risu-backup')
            xhr.setRequestHeader('risu-auth', authHeader)
            // Opt into NDJSON streaming so the server keeps the response socket
            // alive during long post-upload work — prevents reverse-proxy 502s.
            xhr.setRequestHeader('accept', 'application/x-ndjson')

            let uploadComplete = false
            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) {
                    onProgress?.(event.loaded, event.total)
                }
            }
            xhr.upload.onload = () => { uploadComplete = true }

            let parsedIndex = 0
            let leftover = ''
            let result: {ok: boolean, assetsRestored: number, coldStorageFailed?: number} | null = null
            let serverErrorMsg: string | null = null
            let serverErrorCode: string | null = null

            const drainNdjson = () => {
                const text = xhr.responseText
                if (text.length <= parsedIndex) return
                leftover += text.slice(parsedIndex)
                parsedIndex = text.length
                const lines = leftover.split('\n')
                leftover = lines.pop() ?? ''
                for (const line of lines) {
                    if (!line) continue
                    let msg: any
                    try { msg = JSON.parse(line) } catch { continue }
                    if (msg.type === 'progress' && uploadComplete) {
                        // After upload finishes, surface server-side processing
                        // progress through the same callback for UI continuity.
                        onProgress?.(msg.bytes, msg.totalBytes)
                    } else if (msg.type === 'done') {
                        result = msg
                    } else if (msg.type === 'error') {
                        serverErrorMsg = typeof msg.message === 'string' ? msg.message : 'backup import failed'
                        serverErrorCode = typeof msg.code === 'string' ? msg.code : null
                    }
                    // Ignore 'heartbeat' and unknown event types.
                }
            }

            xhr.onprogress = drainNdjson
            xhr.onerror = () => reject(new Error('backup import request failed'))
            xhr.onload = () => {
                if (xhr.status < 200 || xhr.status >= 300) {
                    let msg = `backup import error: ${xhr.status}`
                    try {
                        const body = JSON.parse(xhr.responseText)
                        if (body?.error) msg = String(body.error)
                    } catch {}
                    reject(new Error(msg))
                    return
                }
                drainNdjson()
                if (serverErrorMsg) reject(new BackupImportError(serverErrorMsg, serverErrorCode))
                else if (result) resolve(result)
                else reject(new Error('backup import: no result received'))
            }

            xhr.send(file)
        })
    }

    // ── Server-side backup ─────────────────────────────────────────────────────

    async saveServerBackup(
        onProgress?: (current: number, total: number, bytes: number, totalBytes: number) => void
    ): Promise<{ok: boolean, filename: string, size: number, dir?: string}> {
        const da = await this.authFetch('/api/backup/server/save', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
        })
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `server backup save error: ${da.status}`)
        }

        const reader = da.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let result: {ok: boolean, filename: string, size: number, dir?: string} | null = null

        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop()!
            for (const line of lines) {
                if (!line) continue
                const msg = JSON.parse(line)
                if (msg.type === 'progress') {
                    onProgress?.(msg.current, msg.total, msg.bytes, msg.totalBytes)
                } else if (msg.type === 'done') {
                    result = msg
                } else if (msg.type === 'error') {
                    throw new Error(msg.message)
                }
            }
        }
        if (!result) throw new Error('Server backup: no result received')
        return result
    }

    async listServerBackups(): Promise<{backups: Array<{filename: string, size: number, createdAt: number}>}> {
        const da = await this.authFetch('/api/backup/server/list')
        if (da.status < 200 || da.status >= 300) throw new Error(`server backup list error: ${da.status}`)
        return da.json()
    }

    async restoreServerBackup(
        filename: string,
        onProgress?: (bytes: number, totalBytes: number) => void
    ): Promise<{ok: boolean, assetsRestored: number, coldStorageFailed?: number}> {
        const da = await this.authFetch('/api/backup/server/restore', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({ filename }),
        })
        if (da.status === 404) throw new Error('Backup file not found')
        if (da.status === 409) throw new Error('Another import is already in progress')
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `server backup restore error: ${da.status}`)
        }

        const reader = da.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let result: {ok: boolean, assetsRestored: number, coldStorageFailed?: number} | null = null

        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop()!
            for (const line of lines) {
                if (!line) continue
                const msg = JSON.parse(line)
                if (msg.type === 'progress') {
                    onProgress?.(msg.bytes, msg.totalBytes)
                } else if (msg.type === 'done') {
                    result = msg
                } else if (msg.type === 'error') {
                    throw new Error(msg.message)
                }
            }
        }
        if (!result) throw new Error('Server backup restore: no result received')
        return result
    }

    async deleteServerBackup(filename: string): Promise<void> {
        const da = await this.authFetch(`/api/backup/server/${encodeURIComponent(filename)}`, {
            method: 'DELETE',
        })
        if (da.status === 404) throw new Error('Backup file not found')
        if (da.status < 200 || da.status >= 300) throw new Error(`server backup delete error: ${da.status}`)
    }

    async downloadServerBackup(filename: string): Promise<void> {
        await this.startCookieDownload(`/api/backup/server/download/${encodeURIComponent(filename)}`)
    }

    // ── Chat content (runtime lazy load) ────────────────────────────────────

    async fetchChatContent(chaId: string, chatIndex: number, chatId: string): Promise<any | null> {
        const da = await this.authFetch(`/api/chat-content/${encodeURIComponent(chaId)}/${chatIndex}`, {
            headers: { 'x-chat-id': chatId },
        })
        if (da.status === 404) return null
        if (da.status < 200 || da.status >= 300) throw new Error(`fetchChatContent error: ${da.status}`)
        const buffer = new Uint8Array(await da.arrayBuffer())
        return normalizeChat(await decodeRisuSave(buffer))
    }

    private chatSaveChains = new Map<string, Promise<unknown>>()

    enqueueChatSave<T>(chaId: string, chatId: string, save: () => Promise<T>): Promise<T> {
        const key = JSON.stringify([chaId, chatId])
        const previous = this.chatSaveChains.get(key) ?? Promise.resolve()
        const next = previous.then(save, save)
        this.chatSaveChains.set(key, next)
        const cleanup = () => {
            if (this.chatSaveChains.get(key) === next) this.chatSaveChains.delete(key)
        }
        void next.then(cleanup, cleanup)
        return next
    }

    /**
     * Chat delta sync (see server `sendChatContent`): with a base, the server
     * answers with only the messages after it when the prefix verifies —
     * `deltaBase` is then set and `chat.message` holds just the rest.
     */
    async fetchChatContentDelta(chaId: string, chatIndex: number, chatId: string, base: { count: number, fp: string } | null): Promise<{ chat: any, deltaBase: number | null } | null> {
        const headers: Record<string, string> = { 'x-chat-id': chatId }
        if (base) {
            headers['x-chat-base-count'] = String(base.count)
            headers['x-chat-base-fp'] = base.fp
        }
        const da = await this.authFetch(`/api/chat-content/${encodeURIComponent(chaId)}/${chatIndex}`, { headers })
        if (da.status === 404) return null
        if (da.status < 200 || da.status >= 300) throw new Error(`fetchChatContent error: ${da.status}`)
        const deltaHeader = da.headers.get('x-chat-delta-base')
        const deltaBase = deltaHeader !== null && base && Number(deltaHeader) === base.count ? base.count : null
        const buffer = new Uint8Array(await da.arrayBuffer())
        return { chat: normalizeChat(await decodeRisuSave(buffer)), deltaBase }
    }

    /**
     * Save a chat, optionally as a delta: `base` names the prefix the server
     * already holds and `chat.message` carries only the messages after it.
     * The body is gzipped when the browser can. Returns 'base-mismatch' when
     * the server could not verify the prefix (the caller then saves in full).
     */
    async saveChatContentDelta(chaId: string, chatIndex: number, chatId: string, chat: any, base: { count: number, fp: string } | null): Promise<'ok' | 'base-mismatch'> {
        return this.enqueueChatSave(chaId, chatId, () => this.saveChatContentDeltaUnqueued(chaId, chatIndex, chatId, chat, base))
    }

    async saveChatContentDeltaUnqueued(chaId: string, chatIndex: number, chatId: string, chat: any, base: { count: number, fp: string } | null): Promise<'ok' | 'base-mismatch'> {
        const encoded = encodeRisuSaveLegacy(chat)
        const headers: Record<string, string> = {
            'content-type': 'application/octet-stream',
            'x-chat-id': chatId,
        }
        if (base) {
            headers['x-chat-base-count'] = String(base.count)
            headers['x-chat-base-fp'] = base.fp
        }
        const gzipped = await gzipForUpload(encoded)
        if (gzipped) headers['content-encoding'] = 'gzip'
        const da = await this.authFetch(`/api/chat-content/${encodeURIComponent(chaId)}/${chatIndex}`, {
            method: 'POST',
            headers,
            body: (gzipped ?? encoded) as BodyInit,
        })
        if (base && da.status === 409) {
            const body = await da.json().catch(() => ({})) as { code?: string }
            if (body?.code === 'CHAT_DELTA_BASE_MISMATCH') return 'base-mismatch'
        }
        if (da.status < 200 || da.status >= 300) throw new Error(`saveChatContent error: ${da.status}`)
        return 'ok'
    }

    async saveChatContent(chaId: string, chatIndex: number, chatId: string, chat: any): Promise<void> {
        const encoded = encodeRisuSaveLegacy(chat)
        return this.enqueueChatSave(chaId, chatId, async () => {
            const da = await this.authFetch(`/api/chat-content/${encodeURIComponent(chaId)}/${chatIndex}`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/octet-stream',
                    'x-chat-id': chatId,
                },
                body: encoded,
            })
            if (da.status < 200 || da.status >= 300) throw new Error(`saveChatContent error: ${da.status}`)
        })
    }

    async saveChatContentStrict(chaId: string, chatIndex: number, chatId: string, chat: any): Promise<DurableChatSaveResult> {
        const encoded = encodeRisuSaveLegacy(chat)
        return this.enqueueChatSave(chaId, chatId, async () => {
            let da: Response
            try {
                da = await this.authFetch(`/api/chat-content/${encodeURIComponent(chaId)}/${chatIndex}`, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/octet-stream',
                        'x-chat-id': chatId,
                        'x-strict-flush': '1',
                    },
                    body: encoded,
                })
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                throw new DurableChatSaveError(`saveChatContentStrict request failed: ${message}`, 0)
            }

            let decoded: unknown
            try {
                decoded = await da.json()
            } catch {
                throw new DurableChatSaveError(`saveChatContentStrict invalid response: ${da.status}`, da.status)
            }

            const data = decoded !== null && typeof decoded === 'object'
                ? decoded as Record<string, unknown>
                : null
            if (!da.ok || data?.success !== true || data.durable !== true) {
                const message = typeof data?.error === 'string'
                    ? data.error
                    : `saveChatContentStrict did not receive a durable ACK: ${da.status}`
                const source = typeof data?.source === 'string' ? data.source : undefined
                throw new DurableChatSaveError(message, da.status, source)
            }

            return data as unknown as DurableChatSaveResult
        })
    }

    // ── Character archive (deactivate / activate) — see src/ts/characterArchive.ts ──

    /** Server writes + verifies the payload; returns the stub to keep in the database. */
    async archiveCharacter(chaId: string, arg: { acceptLostChats?: boolean } = {}): Promise<any> {
        const da = await this.authFetch(`/api/characters/${encodeURIComponent(chaId)}/archive`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ acceptLostChats: arg.acceptLostChats === true }),
        })
        const body = await da.json().catch(() => ({})) as { ok?: boolean; stub?: any; error?: string; code?: string; chats?: string[] }
        if (da.status < 200 || da.status >= 300 || !body?.stub) {
            throw new CharacterArchiveError(body?.code ?? `HTTP_${da.status}`, body?.error ?? `archive error: ${da.status}`, body?.chats)
        }
        return body.stub
    }

    /**
     * Archive rows for many characters in one request. Throws only when the
     * request as a whole fails; each character's outcome is in its result.
     */
    async archiveCharacters(chaIds: string[], arg: { acceptLostChats?: boolean } = {}): Promise<ArchiveBatchResult[]> {
        const da = await this.authFetch('/api/characters/archive-batch', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chaIds, acceptLostChats: arg.acceptLostChats === true }),
        })
        const body = await da.json().catch(() => ({})) as { ok?: boolean; results?: ArchiveBatchResult[]; error?: string; code?: string }
        if (da.status < 200 || da.status >= 300 || !Array.isArray(body?.results)) {
            throw new CharacterArchiveError(body?.code ?? `HTTP_${da.status}`, body?.error ?? `archive error: ${da.status}`)
        }
        return body.results
    }

    /** Server registers the chats and returns the client-view character (stub chats, manifest descriptor). */
    async activateCharacter(chaId: string, archivedAt?: number): Promise<any> {
        const da = await this.authFetch(`/api/characters/${encodeURIComponent(chaId)}/activate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ archivedAt }),
        })
        const body = await da.json().catch(() => ({})) as { ok?: boolean; character?: any; error?: string; code?: string }
        if (da.status < 200 || da.status >= 300 || !body?.character) {
            throw new CharacterArchiveError(body?.code ?? `HTTP_${da.status}`, body?.error ?? `activate error: ${da.status}`)
        }
        return body.character
    }

    /** Permanently delete every archive row of a deactivated character (the caller drops the stub). */
    async deleteArchivedCharacter(chaId: string): Promise<void> {
        const da = await this.authFetch(`/api/characters/${encodeURIComponent(chaId)}/archive`, { method: 'DELETE' })
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({})) as { error?: string; code?: string }
            throw new CharacterArchiveError(body?.code ?? `HTTP_${da.status}`, body?.error ?? `archive delete error: ${da.status}`)
        }
    }

    /** Server-side inlay reference scan over every chat body (lazy-loaded and deactivated ones included). */
    async fetchInlayReferences(): Promise<{ scannedAt: number; totalMessages: number; refCounts: Record<string, number> }> {
        const da = await this.authFetch('/api/inlays/references')
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({})) as { error?: string }
            throw new Error(body?.error ?? `inlay reference scan error: ${da.status}`)
        }
        return await da.json()
    }

    /** Every deactivated character as a full legacy record (partial backup). */
    async fetchArchivedCharactersInline(): Promise<any[]> {
        const da = await this.authFetch('/api/characters/archived/inline')
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({})) as { error?: string; code?: string }
            throw new CharacterArchiveError(body?.code ?? `HTTP_${da.status}`, body?.error ?? `archived inline error: ${da.status}`)
        }
        const decoded = await decodeRisuSave(new Uint8Array(await da.arrayBuffer())) as { characters?: any[] }
        return Array.isArray(decoded?.characters) ? decoded.characters : []
    }

    // ── Save-folder migration ─────────────────────────────────────────────────

    async scanSaveFolder(folderPath?: string): Promise<{count: number, totalSize: number, hasDatabase: boolean}> {
        const da = await this.authFetch('/api/migrate/save-folder/scan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: folderPath }),
        })
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `scan error: ${da.status}`)
        }
        return da.json()
    }

    async executeSaveFolderImport(folderPath?: string): Promise<{ok: boolean, imported: number}> {
        const da = await this.authFetch('/api/migrate/save-folder/execute', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: folderPath }),
        })
        if (da.status === 409) throw new Error('Another import is already in progress')
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `import error: ${da.status}`)
        }
        return da.json()
    }

    async uploadSaveFolderZip(
        file: Blob,
        onProgress?: (loaded: number, total: number) => void
    ): Promise<{ok: boolean, imported: number}> {
        const authHeader = await this.createAuth()

        return await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest()
            xhr.open('POST', '/api/migrate/save-folder/upload')
            xhr.setRequestHeader('content-type', 'application/zip')
            xhr.setRequestHeader('risu-auth', authHeader)

            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) {
                    onProgress?.(event.loaded, event.total)
                }
            }

            xhr.onerror = () => reject(new Error('zip upload failed'))
            xhr.onload = () => {
                if (xhr.status < 200 || xhr.status >= 300) {
                    let msg = `zip import error: ${xhr.status}`
                    try { msg = JSON.parse(xhr.responseText).error || msg } catch {}
                    reject(new Error(msg))
                    return
                }
                try {
                    resolve(JSON.parse(xhr.responseText))
                } catch (error) {
                    reject(error)
                }
            }

            xhr.send(file)
        })
    }

    async scanCleanup(): Promise<{count: number, totalSize: number}> {
        const da = await this.authFetch('/api/migrate/save-folder/cleanup/scan', {
            method: 'POST',
        })
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `cleanup scan error: ${da.status}`)
        }
        return da.json()
    }

    async executeCleanup(): Promise<{ok: boolean, removed: number, freedBytes: number}> {
        const da = await this.authFetch('/api/migrate/save-folder/cleanup/execute', {
            method: 'POST',
        })
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `cleanup error: ${da.status}`)
        }
        return da.json()
    }

}

async function digestPassword(message:string) {
    const res = await fetch('/api/crypto', {
        body: JSON.stringify({
            data: message
        }),
        headers: {
            'content-type': 'application/json'
        },
        method: "POST"
    })
    if(res.status < 200 || res.status >= 300){
        throw new Error(`Password hashing failed (${res.status})`)
    }
    return await res.text()
}

/** Failure reported by the character archive endpoints; `code` is the server's error code. */
/** One character's outcome in /api/characters/archive-batch. */
export type ArchiveBatchResult =
    | { chaId: string; ok: true; stub: any }
    | { chaId: string; ok: false; code: string; error: string; chats?: string[] }

export class CharacterArchiveError extends Error {
    code: string
    /** Names of the chats the failure is about (ARCHIVE_CHATS_UNAVAILABLE). */
    chats: string[]
    constructor(code: string, message: string, chats: string[] = []) {
        super(message)
        this.name = 'CharacterArchiveError'
        this.code = code
        this.chats = Array.isArray(chats) ? chats : []
    }
}

// Chat bodies are text-heavy (Korean prose is ~3 bytes a character), so the
// upload shrinks several-fold; small bodies are not worth the round trip
// through the stream. The server's express.raw() inflates Content-Encoding
// gzip transparently, and old servers never see this header from old code.
const GZIP_MIN_BYTES = 8 * 1024

async function gzipForUpload(bytes: Uint8Array): Promise<Uint8Array | null> {
    if (bytes.byteLength < GZIP_MIN_BYTES || typeof CompressionStream === 'undefined') return null
    try {
        const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))
        return new Uint8Array(await new Response(stream).arrayBuffer())
    } catch {
        return null
    }
}
