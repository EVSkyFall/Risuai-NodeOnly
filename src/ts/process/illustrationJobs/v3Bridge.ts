import type { IllustrationWakeHintListener } from './illustrationEvents'
import type { MeasureImagePromptInputV1 } from './imagePromptMeasurement'
import type {
    IllustrationImagePromptMeasurementV1,
    IllustrationImagePromptOverLimitPayloadV1,
} from './types'

export const ILLUSTRATION_V3_PROTECTED_PLUGIN_NAME = 'lb_xnai_agent'

type PinnedDigestRotation = readonly [string] | readonly [string, string]

// Rotation may temporarily contain the old and new production digests, never more than two.
// [0] = previous release (rollback window), [1] = 0.2.6 prompt-dialect flat profiles (271,711 bytes;
// digest independently recomputed from the root and dist bundles on 2026-07-19 by
// scripts/rotate-illustration-pin.mjs — SDXL/Anima flat prompt dialect unlock). Retired releases, the discarded
// pre-contract 0.2.0 snapshot, and the discarded interim drafts must never re-enter
// (regressions in tests/acceptance/sharedFixtures.ts). Converge to a single pin once
// rollout confirms.
export const PINNED_ILLUSTRATION_PLUGIN_DIGESTS = Object.freeze([
    '3249d4ef850d765369e55dd014cee0a10426a64150688ba1ffead8904bbbdaae',
    '987586f7297b56f767acee718e7f2f6525d86c677b91d64ab14691f9ebe48ba5',
] as const satisfies PinnedDigestRotation)

export type IllustrationV3AuthorizationInput = {
    pluginName: string
    pluginScript: string
    apiVersion: unknown
    persistedPluginNames: readonly string[]
}

export type IllustrationV3AuthorizationContext = Readonly<{
    pluginName: typeof ILLUSTRATION_V3_PROTECTED_PLUGIN_NAME
    scriptDigest: string
    apiVersion: '3.0'
}>

type Sha256Hex = (value: string) => Promise<string>

async function sha256HexUtf8(value: string): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(value),
    )
    return Array.from(
        new Uint8Array(digest),
        (byte) => byte.toString(16).padStart(2, '0'),
    ).join('')
}

export function validatePinnedIllustrationDigests(
    digests: readonly string[],
): asserts digests is PinnedDigestRotation {
    if (digests.length < 1 || digests.length > 2) {
        throw new Error('Illustration V3 authorization requires one or two pinned digests')
    }
    if (new Set(digests).size !== digests.length) {
        throw new Error('Illustration V3 authorization digests must be unique')
    }
    for (const digest of digests) {
        if (!/^[0-9a-f]{64}$/.test(digest)) {
            throw new Error('Illustration V3 authorization digests must be lowercase SHA-256')
        }
    }
}

export async function evaluateIllustrationV3Authorization(
    input: IllustrationV3AuthorizationInput,
    pinnedDigests: readonly string[],
    sha256Hex: Sha256Hex,
): Promise<IllustrationV3AuthorizationContext | null> {
    const capturedDigests = Object.freeze([...pinnedDigests])
    const captured = Object.freeze({
        pluginName: input.pluginName,
        pluginScript: input.pluginScript,
        apiVersion: input.apiVersion,
        persistedPluginNames: Object.freeze([...input.persistedPluginNames]),
    })
    validatePinnedIllustrationDigests(capturedDigests)
    if (
        captured.pluginName !== ILLUSTRATION_V3_PROTECTED_PLUGIN_NAME
        || captured.apiVersion !== '3.0'
        || captured.persistedPluginNames.filter(
            (name) => name === ILLUSTRATION_V3_PROTECTED_PLUGIN_NAME,
        ).length > 1
    ) return null

    const scriptDigest = await sha256Hex(captured.pluginScript)
    if (!capturedDigests.includes(scriptDigest)) return null
    return Object.freeze({
        pluginName: ILLUSTRATION_V3_PROTECTED_PLUGIN_NAME,
        scriptDigest,
        apiVersion: '3.0',
    })
}

export async function authorizeIllustrationV3Plugin(
    input: IllustrationV3AuthorizationInput,
): Promise<IllustrationV3AuthorizationContext | null> {
    return await evaluateIllustrationV3Authorization(
        input,
        PINNED_ILLUSTRATION_PLUGIN_DIGESTS,
        sha256HexUtf8,
    )
}

export const ILLUSTRATION_V3_CONTRACT_IMPLEMENTATION = Object.freeze({
    marker: true,
    coordinator: true,
    agentFailure: true,
    agentLlmDrain: true,
    imagePrompt: true,
    // Provider-neutral Prompt Target V2 (Slice D): preparePromptContext + durable
    // PromptContext capture. novelai-native is the only resolvable transport yet.
    promptTargetV2: true,
} as const)

export const ILLUSTRATION_V3_ERROR_MESSAGES = Object.freeze({
    validation: 'The illustration request is invalid.',
    version_conflict: 'The illustration record changed; refresh the snapshot.',
    holder_mismatch: 'The illustration work lease is not owned by this caller.',
    coordinator_required: 'This runtime does not own the current illustration coordinator.',
    coordinator_draining: 'The illustration coordinator is draining.',
    coordinator_cooldown: 'The illustration coordinator is in orphan cooldown.',
    feature_disabled: 'Agentic illustration is disabled.',
    confirmation_required: 'Explicit cost confirmation is required.',
    unavailable: 'The illustration service is unavailable.',
    not_found: 'The requested illustration record was not found.',
    lease_conflict: 'The illustration work lease is already owned.',
    invalid_transition: 'The illustration state transition is not allowed.',
    idempotency_conflict: 'The illustration idempotency key conflicts with prior work.',
    corrupt: 'The illustration record is corrupt.',
    // Terminal Submit Diagnostics: a submitPlan that durably terminal-closed the turn
    // (turn + eligible jobs) for a stale/corrupt request. Distinct from generic
    // request validation so a message-only caller can restore the terminal cause after
    // the turn drops out of the pending snapshot. Fixed friendly strings only — no
    // internal reason, source, marker/nonce, or identifier is ever echoed.
    turn_terminal_stale: 'The illustration turn became stale before plan submission.',
    turn_terminal_corrupt: 'The illustration turn was closed as corrupt before plan submission.',
    agent_llm_timeout: 'The illustration Agent LLM request timed out.',
    image_prompt_over_limit: 'The final image prompt exceeds the model token budget.',
    image_tokenizer_unavailable: 'The exact image prompt tokenizer is unavailable.',
    image_prompt_measurement_unsupported: 'Exact image prompt measurement is unsupported for these settings.',
    image_prompt_invalid: 'The structured image prompt is invalid.',
    settings_fingerprint_mismatch: 'The captured image settings no longer match the current settings.',
    // Prompt Target V2: the current provider settings do not resolve a durable
    // transport target (Slice D resolves only novelai-native).
    prompt_target_unavailable: 'No illustration prompt target is available for the current provider settings.',
} as const)

export type IllustrationV3ErrorCode = keyof typeof ILLUSTRATION_V3_ERROR_MESSAGES

class IllustrationV3CodedError extends Error {
    readonly code: IllustrationV3ErrorCode

    constructor(code: IllustrationV3ErrorCode) {
        super(ILLUSTRATION_V3_ERROR_MESSAGES[code])
        this.code = code
    }
}

export class IllustrationV3RpcError extends Error {
    readonly code: IllustrationV3ErrorCode
    readonly payload?: IllustrationImagePromptOverLimitPayloadV1

    constructor(
        code: IllustrationV3ErrorCode,
        payload?: IllustrationImagePromptOverLimitPayloadV1,
    ) {
        super(`[IJ:${code}] ${ILLUSTRATION_V3_ERROR_MESSAGES[code]}`)
        this.name = 'IllustrationV3RpcError'
        this.code = code
        this.payload = payload
    }
}

function mappedErrorCode(error: unknown): IllustrationV3ErrorCode {
    const rawCode = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : ''
    switch (rawCode) {
        case 'validation':
        case 'version_conflict':
        case 'holder_mismatch':
        case 'coordinator_required':
        case 'coordinator_draining':
        case 'coordinator_cooldown':
        case 'feature_disabled':
        case 'confirmation_required':
        case 'unavailable':
        case 'not_found':
        case 'lease_conflict':
        case 'invalid_transition':
        case 'idempotency_conflict':
        case 'corrupt':
        case 'turn_terminal_stale':
        case 'turn_terminal_corrupt':
        case 'agent_llm_timeout':
        case 'image_prompt_over_limit':
        case 'image_tokenizer_unavailable':
        case 'image_prompt_measurement_unsupported':
        case 'image_prompt_invalid':
        case 'settings_fingerprint_mismatch':
        case 'prompt_target_unavailable':
            return rawCode
        case 'validation_failed':
            return 'validation'
        case 'ledger_unavailable':
            return 'unavailable'
        case 'coordinator_mismatch':
        case 'coordinator_expired':
            return 'coordinator_required'
        default:
            return 'unavailable'
    }
}

function overLimitPayload(error: unknown): IllustrationImagePromptOverLimitPayloadV1 | undefined {
    if (!error || typeof error !== 'object' || !('payload' in error)) return undefined
    const payload = (error as { payload?: unknown }).payload
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
    const value = payload as Record<string, unknown>
    const numericKeys = [
        'positiveTokens',
        'negativeTokens',
        'maxPositiveTokens',
        'maxNegativeTokens',
    ] as const
    if (typeof value.model !== 'string'
        || numericKeys.some((key) => !Number.isSafeInteger(value[key]) || (value[key] as number) < 0)) {
        return undefined
    }
    return {
        positiveTokens: value.positiveTokens as number,
        negativeTokens: value.negativeTokens as number,
        maxPositiveTokens: value.maxPositiveTokens as number,
        maxNegativeTokens: value.maxNegativeTokens as number,
        model: value.model,
    }
}

export function toIllustrationV3RpcError(error: unknown): IllustrationV3RpcError {
    if (error instanceof IllustrationV3RpcError) return error
    const code = mappedErrorCode(error)
    return new IllustrationV3RpcError(
        code,
        code === 'image_prompt_over_limit' ? overLimitPayload(error) : undefined,
    )
}

function codedError(code: IllustrationV3ErrorCode): IllustrationV3CodedError {
    return new IllustrationV3CodedError(code)
}

async function invokeRpc<T>(operation: () => T | Promise<T>): Promise<T> {
    try {
        return await operation()
    } catch (error) {
        throw toIllustrationV3RpcError(error)
    }
}

type CoordinatorRecord = {
    version: number
    fence: number
    leaseId: string | null
    holderRuntimeId: string | null
    expiresAt: number
    draining: boolean
}

type CoordinatorSnapshot = {
    protocolVersion: 1
    version: number
    fence: number
    expiresAt: number
    ownedByCaller: boolean
    draining?: boolean
}

// Coordinator Recovery Status V2 (§5): the typed non-owner standby DATA result the
// opt-in claimCoordinator waitStatus path returns instead of throwing.
type CoordinatorWait = {
    protocolVersion: 1
    ownedByCaller: false
    state: 'leased' | 'draining' | 'orphan-cooldown'
    expiresAt: number | null
    retryAt: number | null
    canForceTakeover: boolean
}

type CoordinatorClaimResult = CoordinatorSnapshot | CoordinatorWait

function isCoordinatorWait(value: CoordinatorClaimResult): value is CoordinatorWait {
    return value.ownedByCaller === false && 'state' in value
}

type CoordinatorProof = {
    protocolVersion: 1
    leaseId: string
    expectedVersion: number
    fence: number
}

type BridgeRecord = { turnId: string; jobId?: string; [key: string]: unknown }

export type IllustrationV3BridgeDependencies = {
    now(): number
    randomUUID(): string
    isFeatureEnabled(): Promise<boolean>
    setFeatureEnabledWithCoordinatorDrain(enabled: boolean): Promise<{
        featureEnabled: boolean
        coordinator: CoordinatorRecord | null
    }>
    claimCoordinator(input: {
        protocolVersion: 1
        leaseId: string
        holderRuntimeId: string
        expectedVersion?: number
        fence?: number
        waitStatus?: boolean
    }): Promise<CoordinatorClaimResult>
    forceTakeoverCoordinator(input: {
        protocolVersion: 1
        leaseId: string
        holderRuntimeId: string
        confirmRisk: true
        expectedVersion: number
        fence?: number
    }): Promise<CoordinatorSnapshot>
    releaseCoordinator(input: CoordinatorProof & { drain: boolean }): Promise<void>
    markCoordinatorDraining(input: CoordinatorProof): Promise<CoordinatorRecord>
    releaseCoordinatorFinal(input: CoordinatorProof): Promise<void>
    getCoordinatorRecord(): Promise<CoordinatorRecord | null>
    admitLlm<T>(
        runtimeId: string,
        start: (coordinator: CoordinatorRecord) => T,
    ): Promise<{ coordinator: CoordinatorRecord; value: T }>
    getCapturePolicy(): Promise<{
        protocolVersion: 1
        capturePolicyContractVersion: 1
        mode: 'manual' | 'automatic'
    }>
    setCaptureMode(input: { protocolVersion: 1; mode: 'manual' | 'automatic' }): Promise<{
        protocolVersion: 1
        mode: 'manual' | 'automatic'
    }>
    requestCurrentVariant(input: Record<string, unknown>): Promise<unknown>
    purgeAutomaticBacklog(input: Record<string, unknown>): Promise<unknown>
    listPendingTurns(): Promise<unknown[]>
    listJobs(input?: { turnId?: string }): Promise<unknown[]>
    claimTurn(input: Record<string, unknown>): Promise<unknown>
    claimJob(input: Record<string, unknown>): Promise<unknown>
    submitPlan(input: Record<string, unknown>): Promise<BridgeRecord[]>
    supplyPrompt(input: Record<string, unknown>): Promise<BridgeRecord>
    // Prompt Target V2 (Slice F): the compiled-envelope supply for a prepared turn.
    // Optional for the same reason; absent => 'unavailable'.
    supplyPromptEnvelope?(input: Record<string, unknown>): Promise<BridgeRecord>
    // Prompt Target V2 (Slice D). Optional so existing dependency literals keep
    // type-checking; when absent the RPC surfaces 'unavailable'.
    preparePromptContext?(input: Record<string, unknown>): Promise<unknown>
    // Prompt Target V2 (Slice E): the durable transport election surface. Optional
    // for the same reason; absent => 'unavailable'.
    setTransportConfig?(input: unknown): Promise<unknown>
    getTransportConfig?(): Promise<unknown>
    measureImagePrompt(input: MeasureImagePromptInputV1): Promise<IllustrationImagePromptMeasurementV1>
    cancelJob(input: { jobId: string; expectedVersion: number }): Promise<BridgeRecord>
    cancelTurn(input: { turnId: string; expectedVersion: number }): Promise<unknown>
    createImageRevision(input: Record<string, unknown>): Promise<unknown>
    getImageRevisionTarget(input: Record<string, unknown>): Promise<unknown>
    listImageRevisions(input: Record<string, unknown>): Promise<unknown>
    restoreImageRevision(input: Record<string, unknown>): Promise<unknown>
    enqueueRevisionImage(input: Record<string, unknown>): Promise<unknown>
    listImageReferences(input: Record<string, unknown>): Promise<unknown>
    retryUncertain(input: Record<string, unknown>): Promise<BridgeRecord>
    reportAgentFailure(input: Record<string, unknown>): Promise<unknown>
    retryAgentFailure(input: Record<string, unknown>): Promise<unknown>
    projectJobSnapshot(record: BridgeRecord, callerLeaseId?: string): unknown
    runLlmModel(options: unknown, signal: AbortSignal): Promise<unknown>
    subscribeWakeHints(listener: IllustrationWakeHintListener): () => void
    setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
    clearTimer(timer: ReturnType<typeof setTimeout>): void
}

type RuntimeState = { unloaded: boolean; cleanupReady: boolean }

type ActiveLlmOutcome =
    | { ok: true; value: unknown }
    | { ok: false; error: unknown }

type ActiveLlmCall = {
    key: string
    runtimeId: string
    fence: number
    controller: AbortController
    settled: boolean
    streamReader?: ReadableStreamDefaultReader<unknown>
    settle(outcome: ActiveLlmOutcome): void
}

type StreamingLlmResponse = {
    type: 'streaming'
    result: ReadableStream<unknown>
    model?: unknown
}

function coordinatorKey(runtimeId: string, fence: number): string {
    return `${runtimeId}:${fence}`
}

function isStreamingLlmResponse(value: unknown): value is StreamingLlmResponse {
    return typeof value === 'object'
        && value !== null
        && 'type' in value
        && value.type === 'streaming'
        && 'result' in value
        && value.result instanceof ReadableStream
}

function cancelStreamReaderNoWait(reader: ReadableStreamDefaultReader<unknown>): void {
    try {
        void Promise.resolve(reader.cancel()).catch(() => {})
    } catch {}
}

function isRetryableCoordinatorRace(error: unknown): boolean {
    const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : ''
    return code === 'version_conflict'
        || code === 'coordinator_mismatch'
        || code === 'coordinator_expired'
}

export class IllustrationV3HostLlmRegistry {
    private readonly runtimes = new Map<string, RuntimeState>()
    private readonly activeCounts = new Map<string, number>()
    private readonly activeCalls = new Set<ActiveLlmCall>()
    private serialTail: Promise<void> = Promise.resolve()

    constructor(private readonly deps: IllustrationV3BridgeDependencies) {}

    registerRuntime(runtimeId: string): void {
        this.runtimes.set(runtimeId, { unloaded: false, cleanupReady: false })
    }

    getActiveCount(runtimeId: string, fence: number): number {
        return this.activeCounts.get(coordinatorKey(runtimeId, fence)) ?? 0
    }

    private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const prior = this.serialTail
        let release!: () => void
        this.serialTail = new Promise<void>((resolve) => { release = resolve })
        await prior.catch(() => {})
        try {
            return await operation()
        } finally {
            release()
        }
    }

    private createActiveLlmCallLocked(
        runtimeId: string,
        fence: number,
        controller: AbortController,
    ): { call: ActiveLlmCall; outcomePromise: Promise<ActiveLlmOutcome> } {
        const key = coordinatorKey(runtimeId, fence)
        let resolveOutcome!: (outcome: ActiveLlmOutcome) => void
        const outcomePromise = new Promise<ActiveLlmOutcome>((resolve) => {
            resolveOutcome = resolve
        })
        const call: ActiveLlmCall = {
            key,
            runtimeId,
            fence,
            controller,
            settled: false,
            settle: (outcome) => {
                if (call.settled) return
                call.settled = true
                void this.exclusive(async () => {
                    this.activeCalls.delete(call)
                    const count = this.activeCounts.get(call.key) ?? 0
                    if (count <= 1) this.activeCounts.delete(call.key)
                    else this.activeCounts.set(call.key, count - 1)
                    const current = await this.deps.getCoordinatorRecord()
                    if (
                        current?.holderRuntimeId === call.runtimeId
                        && current.fence === call.fence
                        && current.draining
                    ) await this.releaseIfLocalDrainedLocked(current)
                    this.cleanupUnloadedRuntime(call.runtimeId)
                }).then(
                    () => resolveOutcome(outcome),
                    (cleanupError) => resolveOutcome(outcome.ok
                        ? { ok: false, error: cleanupError }
                        : outcome),
                )
            },
        }
        this.activeCalls.add(call)
        this.activeCounts.set(key, (this.activeCounts.get(key) ?? 0) + 1)
        return { call, outcomePromise }
    }

    private cancelActiveCallsLocked(
        matches: (call: ActiveLlmCall) => boolean,
    ): void {
        for (const call of this.activeCalls) {
            if (call.settled || !matches(call)) continue
            const cancellationError = codedError('unavailable')
            try { call.controller.abort(cancellationError) } catch {}
            if (call.streamReader) cancelStreamReaderNoWait(call.streamReader)
            call.settle({ ok: false, error: cancellationError })
        }
    }

    private cancelAllActiveCallsLocked(): void {
        this.cancelActiveCallsLocked(() => true)
    }

    private cancelRuntimeActiveCallsLocked(runtimeId: string): void {
        this.cancelActiveCallsLocked((call) => call.runtimeId === runtimeId)
    }

    private cancelCoordinatorActiveCallsLocked(runtimeId: string, fence: number): void {
        this.cancelActiveCallsLocked((call) => (
            call.runtimeId === runtimeId && call.fence === fence
        ))
    }

    private handleProviderResolution(call: ActiveLlmCall, value: unknown): void {
        if (call.settled) return
        if (!isStreamingLlmResponse(value)) {
            call.settle({ ok: true, value })
            return
        }

        let reader: ReadableStreamDefaultReader<unknown>
        try {
            reader = value.result.getReader()
        } catch (error) {
            call.settle({ ok: false, error })
            return
        }
        if (call.settled) {
            cancelStreamReaderNoWait(reader)
            return
        }
        call.streamReader = reader
        void this.consumeProviderStream(call, value, reader)
    }

    private async consumeProviderStream(
        call: ActiveLlmCall,
        response: StreamingLlmResponse,
        reader: ReadableStreamDefaultReader<unknown>,
    ): Promise<void> {
        let lastText = ''
        try {
            while (!call.settled) {
                const { done, value } = await reader.read()
                if (call.settled) return
                if (done) {
                    call.settle({
                        ok: true,
                        value: {
                            type: 'success',
                            result: lastText,
                            model: response.model,
                        },
                    })
                    return
                }
                if (
                    typeof value === 'object'
                    && value !== null
                    && '0' in value
                    && typeof value[0] === 'string'
                ) lastText = value[0]
            }
        } catch (error) {
            call.settle({ ok: false, error })
        }
    }

    private async requireOwnerLocked(
        runtimeId: string,
        options: { allowDraining?: boolean; allowFeatureDisabled?: boolean } = {},
    ): Promise<CoordinatorRecord> {
        const runtime = this.runtimes.get(runtimeId)
        if (!runtime || runtime.unloaded) throw codedError('unavailable')
        if (
            options.allowFeatureDisabled !== true
            && !(await this.deps.isFeatureEnabled())
        ) throw codedError('feature_disabled')
        const current = await this.deps.getCoordinatorRecord()
        if (
            !current
            || current.leaseId === null
            || current.holderRuntimeId !== runtimeId
            || current.expiresAt <= this.deps.now()
        ) throw codedError('coordinator_required')
        if (current.draining && options.allowDraining !== true) {
            throw codedError('coordinator_draining')
        }
        return current
    }

    async runOwned<T>(
        runtimeId: string,
        options: { allowDraining?: boolean; allowFeatureDisabled?: boolean },
        operation: () => Promise<T>,
    ): Promise<T> {
        return await this.exclusive(async () => {
            await this.requireOwnerLocked(runtimeId, options)
            return await operation()
        })
    }

    async claimCoordinator(
        runtimeId: string,
        input: Record<string, unknown>,
    ): Promise<CoordinatorClaimResult> {
        return await this.exclusive(async () => {
            if (!(await this.deps.isFeatureEnabled())) throw codedError('feature_disabled')
            const claimed = await this.deps.claimCoordinator({
                protocolVersion: input.protocolVersion as 1,
                leaseId: input.leaseId as string,
                holderRuntimeId: runtimeId,
                ...(input.expectedVersion === undefined ? {} : {
                    expectedVersion: input.expectedVersion as number,
                }),
                ...(input.fence === undefined ? {} : { fence: input.fence as number }),
                ...(input.waitStatus === undefined ? {} : { waitStatus: input.waitStatus as boolean }),
            })
            if (!(await this.deps.isFeatureEnabled())) {
                const draining = await this.markLatestRuntimeDrainingLocked(runtimeId)
                this.cancelAllActiveCallsLocked()
                await this.releaseIfLocalDrainedLocked(draining)
                throw codedError('feature_disabled')
            }
            // Coordinator Recovery Status V2 (§5): a typed non-owner standby result is
            // returned as DATA. The record layer already ruled the lease force-takeover-
            // eligible by expiry for orphan-cooldown; downgrade canForceTakeover to false
            // when the stale holder still has active host LLM calls.
            if (isCoordinatorWait(claimed)) {
                if (claimed.state === 'orphan-cooldown' && claimed.canForceTakeover) {
                    const record = await this.deps.getCoordinatorRecord()
                    const activeCount = record && record.holderRuntimeId !== null
                        ? this.getActiveCount(record.holderRuntimeId, record.fence)
                        : 0
                    if (activeCount > 0) return { ...claimed, canForceTakeover: false }
                }
                return claimed
            }
            if (claimed.draining) throw codedError('coordinator_draining')
            return claimed
        })
    }

    // Coordinator Recovery Status V2 (§5): operator-confirmed force takeover of an
    // EXPIRED orphan lease. Two host-side preconditions gate the record CAS: the
    // existing lease must be expired, and the stale holder must have ZERO active host
    // LLM calls. A live owner or an active-LLM stale holder rejects as lease_conflict
    // — no new error codes, never automatic.
    async forceTakeoverAfterExpiry(
        runtimeId: string,
        input: Record<string, unknown>,
    ): Promise<CoordinatorSnapshot> {
        return await this.exclusive(async () => {
            if (!(await this.deps.isFeatureEnabled())) throw codedError('feature_disabled')
            if (input.confirmRisk !== true) throw codedError('validation')
            const current = await this.deps.getCoordinatorRecord()
            if (!current || current.leaseId === null || current.holderRuntimeId === null) {
                throw codedError('lease_conflict')
            }
            if (current.expiresAt > this.deps.now()) throw codedError('lease_conflict')
            if (this.getActiveCount(current.holderRuntimeId, current.fence) > 0) {
                throw codedError('lease_conflict')
            }
            return await this.deps.forceTakeoverCoordinator({
                protocolVersion: input.protocolVersion as 1,
                leaseId: input.leaseId as string,
                holderRuntimeId: runtimeId,
                confirmRisk: true,
                expectedVersion: input.expectedVersion as number,
                ...(input.fence === undefined ? {} : { fence: input.fence as number }),
            })
        })
    }

    async setFeatureEnabled(enabled: boolean): Promise<boolean> {
        return await this.exclusive(async () => {
            const result = await this.deps.setFeatureEnabledWithCoordinatorDrain(enabled)
            if (!result.featureEnabled) {
                this.cancelAllActiveCallsLocked()
                await this.releaseIfLocalDrainedLocked(result.coordinator)
            }
            return result.featureEnabled
        })
    }

    async releaseCoordinator(
        runtimeId: string,
        input: CoordinatorProof & { drain: boolean },
    ): Promise<void> {
        await this.exclusive(async () => {
            const current = await this.deps.getCoordinatorRecord()
            if (
                !current
                || current.leaseId === null
                || current.holderRuntimeId !== runtimeId
                || current.fence !== input.fence
            ) throw codedError('coordinator_required')
            const activeCount = this.getActiveCount(runtimeId, input.fence)
            if (input.drain || activeCount > 0) {
                const draining = await this.deps.markCoordinatorDraining({
                    protocolVersion: input.protocolVersion,
                    leaseId: input.leaseId,
                    expectedVersion: input.expectedVersion,
                    fence: input.fence,
                })
                this.cancelCoordinatorActiveCallsLocked(runtimeId, input.fence)
                await this.releaseIfLocalDrainedLocked(draining)
                if (!input.drain && activeCount > 0) throw codedError('coordinator_draining')
                return
            }
            await this.deps.releaseCoordinator(input)
        })
    }

    private async markLatestRuntimeDrainingLocked(
        runtimeId: string,
    ): Promise<CoordinatorRecord | null> {
        for (let attempt = 0; attempt < 32; attempt += 1) {
            const current = await this.deps.getCoordinatorRecord()
            if (
                !current
                || current.leaseId === null
                || current.holderRuntimeId !== runtimeId
                || current.draining
            ) return current
            try {
                return await this.deps.markCoordinatorDraining({
                    protocolVersion: 1,
                    leaseId: current.leaseId,
                    expectedVersion: current.version,
                    fence: current.fence,
                })
            } catch (error) {
                if (!isRetryableCoordinatorRace(error)) throw error
            }
        }
        throw codedError('unavailable')
    }

    private async releaseIfLocalDrainedLocked(
        candidate: CoordinatorRecord | null,
    ): Promise<void> {
        if (
            !candidate
            || candidate.leaseId === null
            || candidate.holderRuntimeId === null
            || !candidate.draining
            || !this.runtimes.has(candidate.holderRuntimeId)
            || this.getActiveCount(candidate.holderRuntimeId, candidate.fence) !== 0
        ) return

        for (let attempt = 0; attempt < 8; attempt += 1) {
            const latest = await this.deps.getCoordinatorRecord()
            if (
                !latest
                || latest.leaseId === null
                || latest.holderRuntimeId !== candidate.holderRuntimeId
                || latest.fence !== candidate.fence
                || !latest.draining
                || this.getActiveCount(latest.holderRuntimeId, latest.fence) !== 0
            ) return
            try {
                await this.deps.releaseCoordinatorFinal({
                    protocolVersion: 1,
                    leaseId: latest.leaseId,
                    expectedVersion: latest.version,
                    fence: latest.fence,
                })
                this.cleanupUnloadedRuntime(latest.holderRuntimeId)
                return
            } catch (error) {
                if (!isRetryableCoordinatorRace(error)) throw error
            }
        }
    }

    private cleanupUnloadedRuntime(runtimeId: string): void {
        const runtime = this.runtimes.get(runtimeId)
        if (!runtime?.unloaded || !runtime.cleanupReady) return
        for (const [key, count] of this.activeCounts) {
            if (key.startsWith(`${runtimeId}:`) && count > 0) return
        }
        this.runtimes.delete(runtimeId)
    }

    async settleRuntime(runtimeId: string): Promise<void> {
        await this.exclusive(async () => {
            let current = await this.deps.getCoordinatorRecord()
            const featureEnabled = await this.deps.isFeatureEnabled()
            if (
                current?.holderRuntimeId === runtimeId
                && !featureEnabled
                && !current.draining
            ) {
                current = await this.markLatestRuntimeDrainingLocked(runtimeId)
            }
            if (!featureEnabled) this.cancelAllActiveCallsLocked()
            if (current?.holderRuntimeId === runtimeId) {
                await this.releaseIfLocalDrainedLocked(current)
            }
        })
    }

    async unloadRuntime(runtimeId: string): Promise<void> {
        const state = this.runtimes.get(runtimeId)
        if (state) state.unloaded = true
        await this.exclusive(async () => {
            const draining = await this.markLatestRuntimeDrainingLocked(runtimeId)
            this.cancelRuntimeActiveCallsLocked(runtimeId)
            await this.releaseIfLocalDrainedLocked(draining)
            const latestState = this.runtimes.get(runtimeId)
            if (latestState) latestState.cleanupReady = true
            this.cleanupUnloadedRuntime(runtimeId)
        })
    }

    async runLlmModel(runtimeId: string, options: unknown): Promise<unknown> {
        const started = await this.exclusive(async () => {
            const runtime = this.runtimes.get(runtimeId)
            if (!runtime || runtime.unloaded) throw codedError('unavailable')
            const admitted = await this.deps.admitLlm(runtimeId, (owner) => {
                const admittedRuntime = this.runtimes.get(runtimeId)
                if (!admittedRuntime || admittedRuntime.unloaded) {
                    throw codedError('unavailable')
                }
                const controller = new AbortController()
                const active = this.createActiveLlmCallLocked(
                    runtimeId,
                    owner.fence,
                    controller,
                )
                let providerPromise: Promise<unknown>
                try {
                    providerPromise = Promise.resolve(this.deps.runLlmModel(options, controller.signal))
                } catch (error) {
                    providerPromise = Promise.reject(error)
                }
                void providerPromise.then(
                    (value) => this.handleProviderResolution(active.call, value),
                    (error) => active.call.settle({ ok: false, error }),
                ).catch(() => {})
                return active
            })
            return admitted.value
        })

        const outcome = await started.outcomePromise
        if (outcome.ok === false) throw outcome.error
        return outcome.value
    }
}

export const ILLUSTRATION_JOBS_ALIAS = Object.freeze({
    getCapabilities: '_ijGetCapabilities',
    getCapturePolicy: '_ijGetCapturePolicy',
    setCaptureMode: '_ijSetCaptureMode',
    requestCurrentVariant: '_ijRequestCurrentVariant',
    purgeAutomaticBacklog: '_ijPurgeAutomaticBacklog',
    setFeatureEnabled: '_ijSetFeatureEnabled',
    claimCoordinator: '_ijClaimCoordinator',
    forceTakeoverAfterExpiry: '_ijForceTakeoverAfterExpiry',
    releaseCoordinator: '_ijReleaseCoordinator',
    listPendingTurns: '_ijListPendingTurns',
    claimTurn: '_ijClaimTurn',
    claimJob: '_ijClaimJob',
    submitPlan: '_ijSubmitPlan',
    supplyPrompt: '_ijSupplyPrompt',
    supplyPromptEnvelope: '_ijSupplyPromptEnvelope',
    preparePromptContext: '_ijPreparePromptContext',
    setTransportConfig: '_ijSetTransportConfig',
    getTransportConfig: '_ijGetTransportConfig',
    measureImagePrompt: '_ijMeasureImagePrompt',
    listJobs: '_ijListJobs',
    cancel: '_ijCancel',
    retryUncertain: '_ijRetryUncertain',
    reportAgentFailure: '_ijReportAgentFailure',
    retryAgentFailure: '_ijRetryAgentFailure',
    // Image Revision V1 (§4/§6): private-bridge revision surface.
    createImageRevision: '_ijCreateImageRevision',
    getImageRevisionTarget: '_ijGetImageRevisionTarget',
    listImageRevisions: '_ijListImageRevisions',
    restoreImageRevision: '_ijRestoreImageRevision',
    enqueueRevisionImage: '_ijEnqueueRevisionImage',
    listImageReferences: '_ijListImageReferences',
    subscribe: '_ijSubscribe',
    unsubscribe: '_ijUnsubscribe',
} as const)

const CALLER_IDENTITY_KEYS = [
    'holderRuntimeId',
    'runtimeId',
    'pluginName',
    'scriptHash',
    'scriptDigest',
] as const

function inputRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw codedError('validation')
    }
    return value as Record<string, unknown>
}

function sanitizedInput(value: unknown): Record<string, unknown> {
    const input = { ...inputRecord(value) }
    for (const key of CALLER_IDENTITY_KEYS) delete input[key]
    return input
}

function assertProtocol(input: Record<string, unknown>): void {
    if (input.protocolVersion !== 1) throw codedError('validation')
}

export type AuthorizedIllustrationV3Bridge = {
    readonly rootMethods: Readonly<Record<string, (...args: unknown[]) => Promise<unknown>>>
    readonly aliases: Readonly<{ illustrationJobs: typeof ILLUSTRATION_JOBS_ALIAS }>
    runLLMModel(options: unknown): Promise<unknown>
    unload(): Promise<void>
}

export function createIllustrationV3CapabilityIfAuthorized(
    authorization: IllustrationV3AuthorizationContext | null,
    createBridge: (
        authorization: IllustrationV3AuthorizationContext,
    ) => AuthorizedIllustrationV3Bridge,
): AuthorizedIllustrationV3Bridge | undefined {
    return authorization ? createBridge(authorization) : undefined
}

export function createAuthorizedIllustrationV3Bridge(input: {
    auth: IllustrationV3AuthorizationContext
    runtimeId: string
    deps: IllustrationV3BridgeDependencies
    hostRegistry: IllustrationV3HostLlmRegistry
}): AuthorizedIllustrationV3Bridge {
    const auth = Object.freeze({ ...input.auth, runtimeId: input.runtimeId })
    const { deps, hostRegistry } = input
    const subscriptions = new Map<string, () => void>()
    let unloaded = false
    hostRegistry.registerRuntime(auth.runtimeId)

    const ensureLive = () => {
        if (unloaded) throw codedError('unavailable')
    }
    const removeSubscription = (subscriptionId: string) => {
        const dispose = subscriptions.get(subscriptionId)
        subscriptions.delete(subscriptionId)
        dispose?.()
    }

    const rootMethods: Record<string, (...args: unknown[]) => Promise<unknown>> = {
        _ijGetCapabilities: async () => await invokeRpc(async () => {
            ensureLive()
            await hostRegistry.settleRuntime(auth.runtimeId)
            return {
                protocolVersion: 1,
                markerContractVersion: ILLUSTRATION_V3_CONTRACT_IMPLEMENTATION.marker ? 1 : 0,
                coordinatorContractVersion: ILLUSTRATION_V3_CONTRACT_IMPLEMENTATION.coordinator ? 1 : 0,
                agentFailureContractVersion: ILLUSTRATION_V3_CONTRACT_IMPLEMENTATION.agentFailure ? 1 : 0,
                agentLlmDrainContractVersion: ILLUSTRATION_V3_CONTRACT_IMPLEMENTATION.agentLlmDrain ? 1 : 0,
                maxJobsPerTurn: 15,
                offsetEncoding: 'utf-16',
                promptOwnership: 'plugin-final',
                // The tokenizer asset ships statically. Runtime asset/WASM
                // failures remain fail-closed contract errors on measure/gates.
                imagePromptContractVersion: ILLUSTRATION_V3_CONTRACT_IMPLEMENTATION.imagePrompt ? 1 : 0,
                imagePromptOwnership: 'plugin-final-structured',
                imagePromptMeasurement: 'core-provider-model-exact',
                supportsNaiV4CharacterCaptions: true,
                // Provider-neutral Prompt Target V2 (Slice D). Additive: it does
                // not bump imagePromptContractVersion and keeps every V1 field.
                // preparePromptContext captures a durable PromptContext; only the
                // novelai-native transport resolves so far (others report
                // prompt_target_unavailable until Slice E).
                promptTargetContractVersion: ILLUSTRATION_V3_CONTRACT_IMPLEMENTATION.promptTargetV2 ? 2 : 0,
                // Transports that auto-resolve from the current provider without an
                // explicit election (unchanged — additive fields carry Slice E).
                promptTargetResolvableTransports: ['novelai-native'],
                // Slice E: every transport adapter Core can serialize/dispatch. The
                // non-native three resolve only via an explicit setTransportConfig
                // election on a compatible provider; this list is purely additive.
                promptTransportsAvailable: [
                    'novelai-native',
                    'nai-compatible-flat',
                    'webui-flat',
                    'comfyui-flat',
                ],
                // Durable transport-election RPC surface (setTransportConfig /
                // getTransportConfig). Additive.
                transportConfigContractVersion: 1,
                // Capture Policy V1: durable manual/automatic capture mode, manual
                // per-response capture, and the pending-only backlog controls. Additive.
                capturePolicyContractVersion: 1,
                // Coordinator Recovery Status V2 (§5): opt-in claimCoordinator waitStatus
                // returns typed non-owner standby data (leased/draining/orphan-cooldown
                // with expiresAt/retryAt/canForceTakeover), and forceTakeoverAfterExpiry
                // recovers an expired orphan with zero active LLM. Additive.
                coordinatorWaitContractVersion: 1,
                // Image Revision V1: reference/lineage ledger, exact/edited/retag
                // revision children, replace/retain dispositions, no-charge restore,
                // and bounded revision/reference projections. Additive.
                imageRevisionContractVersion: 1,
                // Additive capabilities. The host always forces a single generation
                // (noMultiGen) and, on supported providers only, forwards a validated
                // structured-output schema to native JSON schema / response format;
                // unsupported providers fall back to the prompt-only strict path.
                // These are additive: older plugins that ignore them keep working.
                illustrationStructuredOutputContractVersion: 1,
                illustrationSingleGeneration: true,
                featureEnabled: await deps.isFeatureEnabled(),
            }
        }),
        _ijGetCapturePolicy: async () => await invokeRpc(async () => {
            ensureLive()
            // Read-only durable mode. Readable without coordinator ownership so a
            // reloading Plugin can resolve the mode before opening its scheduler.
            return await deps.getCapturePolicy()
        }),
        _ijSetCaptureMode: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = sanitizedInput(value)
            assertProtocol(request)
            if (request.mode !== 'manual' && request.mode !== 'automatic') {
                throw codedError('validation')
            }
            return await deps.setCaptureMode({ protocolVersion: 1, mode: request.mode })
        }),
        _ijRequestCurrentVariant: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = sanitizedInput(value)
            assertProtocol(request)
            return await hostRegistry.runOwned(
                auth.runtimeId,
                {},
                async () => await deps.requestCurrentVariant(request),
            )
        }),
        _ijPurgeAutomaticBacklog: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = sanitizedInput(value)
            assertProtocol(request)
            return await hostRegistry.runOwned(
                auth.runtimeId,
                {},
                async () => await deps.purgeAutomaticBacklog(request),
            )
        }),
        _ijMeasureImagePrompt: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = sanitizedInput(value)
            assertProtocol(request)
            return await deps.measureImagePrompt(request as MeasureImagePromptInputV1)
        }),
        _ijSetFeatureEnabled: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = inputRecord(value)
            assertProtocol(request)
            if (typeof request.enabled !== 'boolean') throw codedError('validation')
            return {
                featureEnabled: await hostRegistry.setFeatureEnabled(request.enabled),
            }
        }),
        _ijClaimCoordinator: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = sanitizedInput(value)
            assertProtocol(request)
            // Coordinator Recovery Status V2 (§5): additive, validated boolean.
            if (request.waitStatus !== undefined && typeof request.waitStatus !== 'boolean') {
                throw codedError('validation')
            }
            return await hostRegistry.claimCoordinator(auth.runtimeId, request)
        }),
        _ijForceTakeoverAfterExpiry: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = sanitizedInput(value)
            assertProtocol(request)
            // Never automatic (§5): the caller must explicitly accept the recovery risk.
            if (request.confirmRisk !== true) throw codedError('validation')
            if (typeof request.leaseId !== 'string' || request.leaseId.length === 0) {
                throw codedError('validation')
            }
            if (!Number.isSafeInteger(request.expectedVersion) || (request.expectedVersion as number) < 0) {
                throw codedError('validation')
            }
            if (
                request.fence !== undefined
                && (!Number.isSafeInteger(request.fence) || (request.fence as number) < 0)
            ) {
                throw codedError('validation')
            }
            return await hostRegistry.forceTakeoverAfterExpiry(auth.runtimeId, request)
        }),
        _ijReleaseCoordinator: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = sanitizedInput(value)
            assertProtocol(request)
            if (typeof request.drain !== 'boolean') throw codedError('validation')
            await hostRegistry.releaseCoordinator(auth.runtimeId, {
                protocolVersion: 1,
                leaseId: request.leaseId as string,
                expectedVersion: request.expectedVersion as number,
                fence: request.fence as number,
                drain: request.drain,
            })
        }),
        _ijListPendingTurns: async () => await invokeRpc(async () => {
            ensureLive()
            return await hostRegistry.runOwned(auth.runtimeId, {}, deps.listPendingTurns)
        }),
        _ijClaimTurn: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = sanitizedInput(value)
            return await hostRegistry.runOwned(
                auth.runtimeId,
                {},
                async () => await deps.claimTurn(request),
            )
        }),
        _ijClaimJob: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = sanitizedInput(value)
            return await hostRegistry.runOwned(
                auth.runtimeId,
                {},
                async () => await deps.claimJob(request),
            )
        }),
        _ijSubmitPlan: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = sanitizedInput(value)
            const records = await hostRegistry.runOwned(
                auth.runtimeId,
                {},
                async () => await deps.submitPlan(request),
            )
            return records.map((record) => deps.projectJobSnapshot(record))
        }),
        _ijSupplyPrompt: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = sanitizedInput(value)
            const record = await hostRegistry.runOwned(
                auth.runtimeId,
                {},
                async () => await deps.supplyPrompt(request),
            )
            return deps.projectJobSnapshot(record, request.leaseId as string)
        }),
        _ijSupplyPromptEnvelope: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = sanitizedInput(value)
            // Prompt Target V2 uses protocolVersion 2 for THIS method; the rest of the
            // bridge stays on protocolVersion 1.
            if (request.protocolVersion !== 2) throw codedError('validation')
            const supply = deps.supplyPromptEnvelope
            if (!supply) throw codedError('unavailable')
            const record = await hostRegistry.runOwned(
                auth.runtimeId,
                {},
                async () => await supply(request),
            )
            return deps.projectJobSnapshot(record, request.leaseId as string)
        }),
        _ijPreparePromptContext: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = sanitizedInput(value)
            // Prompt Target V2 uses protocolVersion 2 for THIS method only; the
            // rest of the bridge stays on protocolVersion 1.
            if (request.protocolVersion !== 2) throw codedError('validation')
            const prepare = deps.preparePromptContext
            if (!prepare) throw codedError('unavailable')
            // Coordinator ownership is required, matching every other durable
            // turn mutation (claimTurn/submitPlan/supplyPrompt).
            return await hostRegistry.runOwned(
                auth.runtimeId,
                {},
                async () => await prepare(request),
            )
        }),
        _ijSetTransportConfig: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = sanitizedInput(value)
            if (request.protocolVersion !== 2) throw codedError('validation')
            const setConfig = deps.setTransportConfig
            if (!setConfig) throw codedError('unavailable')
            // A durable global mutation — require coordinator ownership like every
            // other durable write.
            return await hostRegistry.runOwned(
                auth.runtimeId,
                {},
                async () => await setConfig(request.transportConfig),
            )
        }),
        _ijGetTransportConfig: async () => await invokeRpc(async () => {
            ensureLive()
            const getConfig = deps.getTransportConfig
            if (!getConfig) throw codedError('unavailable')
            // Read-only durable setting, readable without ownership so a reloading
            // Plugin/executor can resolve its target before opening a scheduler.
            return await getConfig()
        }),
        _ijListJobs: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = value === undefined ? {} : sanitizedInput(value)
            const listInput = request.turnId === undefined
                ? {}
                : { turnId: request.turnId as string }
            return await hostRegistry.runOwned(
                auth.runtimeId,
                {},
                async () => await deps.listJobs(listInput),
            )
        }),
        _ijCancel: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = sanitizedInput(value)
            const hasJob = typeof request.jobId === 'string' && request.jobId.length > 0
            const hasTurn = typeof request.turnId === 'string' && request.turnId.length > 0
            if (hasJob === hasTurn || !Number.isSafeInteger(request.expectedVersion)) {
                throw codedError('validation')
            }
            if (hasJob) {
                await deps.cancelJob({
                    jobId: request.jobId as string,
                    expectedVersion: request.expectedVersion as number,
                })
            } else {
                await deps.cancelTurn({
                    turnId: request.turnId as string,
                    expectedVersion: request.expectedVersion as number,
                })
            }
        }),
        _ijRetryUncertain: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = sanitizedInput(value)
            const record = await hostRegistry.runOwned(
                auth.runtimeId,
                {},
                async () => await deps.retryUncertain(request),
            )
            return deps.projectJobSnapshot(record)
        }),
        _ijReportAgentFailure: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = sanitizedInput(value)
            return await hostRegistry.runOwned(
                auth.runtimeId,
                { allowDraining: true, allowFeatureDisabled: true },
                async () => await deps.reportAgentFailure(request),
            )
        }),
        _ijRetryAgentFailure: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = sanitizedInput(value)
            return await hostRegistry.runOwned(
                auth.runtimeId,
                {},
                async () => await deps.retryAgentFailure(request),
            )
        }),
        // Image Revision V1: mutating revision RPCs run under coordinator ownership
        // (they admit executor work, charge, or mutate chat). Read-only projections
        // are available without ownership so a reloading dashboard can render.
        _ijCreateImageRevision: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = sanitizedInput(value)
            assertProtocol(request)
            return await hostRegistry.runOwned(
                auth.runtimeId,
                {},
                async () => await deps.createImageRevision(request),
            )
        }),
        _ijGetImageRevisionTarget: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = sanitizedInput(value)
            assertProtocol(request)
            return await deps.getImageRevisionTarget(request)
        }),
        _ijListImageRevisions: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = sanitizedInput(value)
            assertProtocol(request)
            return await deps.listImageRevisions(request)
        }),
        _ijListImageReferences: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = sanitizedInput(value)
            assertProtocol(request)
            return await deps.listImageReferences(request)
        }),
        _ijRestoreImageRevision: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = sanitizedInput(value)
            assertProtocol(request)
            return await hostRegistry.runOwned(
                auth.runtimeId,
                {},
                async () => await deps.restoreImageRevision(request),
            )
        }),
        _ijEnqueueRevisionImage: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = sanitizedInput(value)
            assertProtocol(request)
            return await hostRegistry.runOwned(
                auth.runtimeId,
                {},
                async () => await deps.enqueueRevisionImage(request),
            )
        }),
        _ijSubscribe: async (value) => await invokeRpc(async () => {
            ensureLive()
            if (typeof value !== 'function') throw codedError('validation')
            let subscriptionId = deps.randomUUID()
            while (subscriptions.has(subscriptionId)) subscriptionId = deps.randomUUID()
            const listener = value as IllustrationWakeHintListener
            const dispose = deps.subscribeWakeHints((hint) => {
                try {
                    const result = listener(hint)
                    void Promise.resolve(result).catch(() => removeSubscription(subscriptionId))
                } catch {
                    removeSubscription(subscriptionId)
                }
            })
            subscriptions.set(subscriptionId, dispose)
            return { subscriptionId }
        }),
        _ijUnsubscribe: async (value) => await invokeRpc(async () => {
            ensureLive()
            const request = inputRecord(value)
            if (typeof request.subscriptionId !== 'string') throw codedError('validation')
            removeSubscription(request.subscriptionId)
        }),
    }

    return Object.freeze({
        rootMethods: Object.freeze(rootMethods),
        aliases: Object.freeze({ illustrationJobs: ILLUSTRATION_JOBS_ALIAS }),
        runLLMModel: async (options: unknown) => await invokeRpc(async () => {
            ensureLive()
            return await hostRegistry.runLlmModel(auth.runtimeId, options)
        }),
        unload: async () => {
            if (unloaded) return
            unloaded = true
            for (const subscriptionId of [...subscriptions.keys()]) {
                removeSubscription(subscriptionId)
            }
            await invokeRpc(async () => await hostRegistry.unloadRuntime(auth.runtimeId))
        },
    })
}
