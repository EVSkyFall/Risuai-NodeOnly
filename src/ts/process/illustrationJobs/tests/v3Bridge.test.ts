import { afterEach, describe, expect, test, vi } from 'vitest'
import {
    ILLUSTRATION_JOBS_ALIAS,
    ILLUSTRATION_V3_ERROR_MESSAGES,
    ILLUSTRATION_V3_PROTECTED_PLUGIN_NAME,
    IllustrationV3HostLlmRegistry,
    PINNED_ILLUSTRATION_PLUGIN_DIGESTS,
    createAuthorizedIllustrationV3Bridge,
    createIllustrationV3CapabilityIfAuthorized,
    evaluateIllustrationV3Authorization,
    toIllustrationV3RpcError,
    validatePinnedIllustrationDigests,
    type IllustrationV3AuthorizationContext,
    type IllustrationV3BridgeDependencies,
} from '../v3Bridge'
import {
    emitIllustrationWakeHint,
    subscribeIllustrationWakeHints,
    type IllustrationWakeHintV1,
    type IllustrationWakeHintListener,
} from '../illustrationEvents'

const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)
const AUTH = Object.freeze({
    pluginName: ILLUSTRATION_V3_PROTECTED_PLUGIN_NAME,
    scriptDigest: DIGEST_A,
    apiVersion: '3.0',
}) satisfies IllustrationV3AuthorizationContext

type CoordinatorRecord = {
    version: number
    fence: number
    leaseId: string | null
    holderRuntimeId: string | null
    expiresAt: number
    draining: boolean
}

function coded(code: string): Error & { code: string } {
    return Object.assign(new Error(`private payload for ${code}`), { code })
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

async function flushMicrotasks(): Promise<void> {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

function makeHarness(runtimeId = 'host-runtime') {
    const state = {
        now: 1_000,
        featureEnabled: true,
        disableFeatureAfterClaim: false,
        admitBeforeStart: null as Promise<void> | null,
        coordinator: {
            version: 1,
            fence: 7,
            leaseId: 'coordinator-lease',
            holderRuntimeId: runtimeId,
            expiresAt: 61_000,
            draining: false,
        } as CoordinatorRecord | null,
    }
    let uuidSequence = 0
    const wakeListeners = new Set<IllustrationWakeHintListener>()
    const provider = vi.fn(async (_options: unknown, _signal: AbortSignal): Promise<unknown> => ({ ok: true }))
    const claimCoordinator = vi.fn(async (input: {
        protocolVersion: 1
        leaseId: string
        holderRuntimeId: string
        expectedVersion?: number
        fence?: number
    }) => {
        const previous = state.coordinator
        state.coordinator = {
            version: (state.coordinator?.version ?? 0) + 1,
            fence: previous?.leaseId === null
                ? previous.fence + 1
                : previous?.fence ?? 1,
            leaseId: input.leaseId,
            holderRuntimeId: input.holderRuntimeId,
            expiresAt: state.now + 60_000,
            draining: false,
        }
        if (state.disableFeatureAfterClaim) state.featureEnabled = false
        return {
            protocolVersion: 1 as const,
            version: state.coordinator.version,
            fence: state.coordinator.fence,
            expiresAt: state.coordinator.expiresAt,
            ownedByCaller: true,
            draining: false,
        }
    })
    const releaseCoordinator = vi.fn(async () => {
        if (state.coordinator) {
            state.coordinator = {
                ...state.coordinator,
                version: state.coordinator.version + 1,
                leaseId: null,
                holderRuntimeId: null,
                expiresAt: 0,
            }
        }
    })
    const markCoordinatorDraining = vi.fn(async (input: {
        protocolVersion: 1
        leaseId: string
        expectedVersion: number
        fence: number
    }) => {
        if (
            !state.coordinator
            || state.coordinator.leaseId !== input.leaseId
            || state.coordinator.fence !== input.fence
        ) {
            throw coded('coordinator_mismatch')
        }
        if (state.coordinator.version !== input.expectedVersion) throw coded('version_conflict')
        state.coordinator = {
            ...state.coordinator,
            version: state.coordinator.version + 1,
            draining: true,
        }
        return structuredClone(state.coordinator)
    })
    const releaseCoordinatorFinal = vi.fn(async (input: {
        protocolVersion: 1
        leaseId: string
        expectedVersion: number
        fence: number
    }) => {
        if (
            !state.coordinator
            || state.coordinator.leaseId !== input.leaseId
            || state.coordinator.version !== input.expectedVersion
            || state.coordinator.fence !== input.fence
        ) throw coded('coordinator_mismatch')
        state.coordinator = {
            ...state.coordinator,
            version: state.coordinator.version + 1,
            leaseId: null,
            holderRuntimeId: null,
            expiresAt: 0,
            draining: true,
        }
    })
    const listPendingTurns = vi.fn(async () => [{ turnId: 'turn-1', state: 'awaiting_plan' }])
    const listJobs = vi.fn(async () => [{
        protocolVersion: 1,
        turnId: 'turn-1',
        jobId: 'job-1',
        state: 'awaiting_prompt',
        lease: { expiresAt: 10, fence: 2, ownedByCaller: false },
    }])
    const claimTurn = vi.fn(async (input: Record<string, unknown>) => input)
    const claimJob = vi.fn(async (input: Record<string, unknown>) => input)
    const rawJob = {
        turnId: 'turn-1',
        jobId: 'job-1',
        state: 'awaiting_prompt',
        version: 3,
        fence: 2,
        leaseId: 'job-owner',
        leaseExpiresAt: 9_000,
        prompt: 'private prompt',
        lastHolderWrite: { private: true },
    }
    const projectJobSnapshot = vi.fn((record: typeof rawJob, callerLeaseId?: string) => ({
        protocolVersion: 1,
        turnId: record.turnId,
        jobId: record.jobId,
        state: record.state,
        version: record.version,
        lease: {
            expiresAt: record.leaseExpiresAt,
            fence: record.fence,
            ownedByCaller: callerLeaseId === record.leaseId,
        },
    }))
    const setTimer = vi.fn((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
    const clearTimer = vi.fn((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer))
    const deps: IllustrationV3BridgeDependencies = {
        now: () => state.now,
        randomUUID: () => `subscription-${++uuidSequence}`,
        isFeatureEnabled: async () => state.featureEnabled,
        setFeatureEnabledWithCoordinatorDrain: vi.fn(async (enabled: boolean) => {
            state.featureEnabled = enabled
            if (enabled || !state.coordinator?.leaseId) {
                return { featureEnabled: enabled, coordinator: null }
            }
            state.coordinator = {
                ...state.coordinator,
                version: state.coordinator.version + 1,
                draining: true,
            }
            return {
                featureEnabled: false,
                coordinator: structuredClone(state.coordinator),
            }
        }),
        claimCoordinator,
        releaseCoordinator,
        markCoordinatorDraining,
        releaseCoordinatorFinal,
        getCoordinatorRecord: async () => state.coordinator
            ? structuredClone(state.coordinator)
            : null,
        admitLlm: async <T>(admittedRuntimeId: string, start: (record: CoordinatorRecord) => T) => {
            if (state.admitBeforeStart) await state.admitBeforeStart
            if (!state.featureEnabled) throw coded('feature_disabled')
            const current = state.coordinator
            if (!current?.leaseId || current.holderRuntimeId !== admittedRuntimeId) {
                throw coded('coordinator_mismatch')
            }
            if (current.expiresAt <= state.now) throw coded('coordinator_expired')
            if (current.draining) throw coded('coordinator_draining')
            const coordinator = structuredClone(current)
            return { coordinator, value: start(structuredClone(coordinator)) }
        },
        listPendingTurns,
        listJobs,
        claimTurn,
        claimJob,
        submitPlan: vi.fn(async () => [structuredClone(rawJob)]),
        supplyPrompt: vi.fn(async () => structuredClone(rawJob)),
        measureImagePrompt: vi.fn(async () => ({
            model: 'nai-diffusion-4-5-full',
            tokenizer: 't5-spiece-v1' as const,
            positiveTokens: 4,
            negativeTokens: 2,
            maxPositiveTokens: 512,
            maxNegativeTokens: 512,
        })),
        cancelJob: vi.fn(async () => structuredClone(rawJob)),
        cancelTurn: vi.fn(async (input) => ({ turnId: input.turnId, state: 'cancelled' })),
        retryUncertain: vi.fn(async () => structuredClone(rawJob)),
        reportAgentFailure: vi.fn(async (input) => input),
        retryAgentFailure: vi.fn(async (input) => input),
        projectJobSnapshot: (record, callerLeaseId) => projectJobSnapshot(
            record as typeof rawJob,
            callerLeaseId,
        ),
        runLlmModel: provider,
        subscribeWakeHints: (listener) => {
            wakeListeners.add(listener)
            return () => wakeListeners.delete(listener)
        },
        setTimer,
        clearTimer,
    }
    const registry = new IllustrationV3HostLlmRegistry(deps)
    const bridge = createAuthorizedIllustrationV3Bridge({ auth: AUTH, runtimeId, deps, hostRegistry: registry })
    const emit = async (hint: IllustrationWakeHintV1) => {
        for (const listener of [...wakeListeners]) listener(hint)
        await flushMicrotasks()
    }
    return {
        state,
        deps,
        registry,
        bridge,
        provider,
        claimCoordinator,
        releaseCoordinator,
        markCoordinatorDraining,
        releaseCoordinatorFinal,
        setTimer,
        clearTimer,
        listPendingTurns,
        listJobs,
        claimTurn,
        claimJob,
        projectJobSnapshot,
        wakeListeners,
        emit,
        rawJob,
        runtimeId,
    }
}

type DrainInitiator = 'feature OFF' | 'drain:true' | 'drain:false' | 'unload'

function currentCoordinatorProof(harness: ReturnType<typeof makeHarness>) {
    const coordinator = harness.state.coordinator
    if (!coordinator?.leaseId) throw new Error('Expected an owned coordinator')
    return {
        protocolVersion: 1 as const,
        leaseId: coordinator.leaseId,
        expectedVersion: coordinator.version,
        fence: coordinator.fence,
    }
}

async function initiateDrain(
    harness: ReturnType<typeof makeHarness>,
    initiator: DrainInitiator,
): Promise<void> {
    if (initiator === 'feature OFF') {
        await expect(harness.bridge.rootMethods._ijSetFeatureEnabled({
            protocolVersion: 1,
            enabled: false,
        })).resolves.toEqual({ featureEnabled: false })
        return
    }
    if (initiator === 'unload') {
        await expect(harness.bridge.unload()).resolves.toBeUndefined()
        return
    }
    const request = {
        ...currentCoordinatorProof(harness),
        drain: initiator === 'drain:true',
    }
    if (initiator === 'drain:false') {
        await expect(harness.bridge.rootMethods._ijReleaseCoordinator(request))
            .rejects.toThrow('[IJ:coordinator_draining]')
        return
    }
    await expect(harness.bridge.rootMethods._ijReleaseCoordinator(request))
        .resolves.toBeUndefined()
}

type ReaderCancelBehavior = 'resolve' | 'reject' | 'throw' | 'pending'

function controlledStream(cancelBehavior: ReaderCancelBehavior) {
    const read = deferred<ReadableStreamReadResult<unknown>>()
    const cancel = vi.fn(() => {
        if (cancelBehavior === 'reject') return Promise.reject(new Error('reader cancel rejected'))
        if (cancelBehavior === 'throw') throw new Error('reader cancel threw')
        if (cancelBehavior === 'pending') return new Promise<void>(() => {})
        return Promise.resolve()
    })
    const reader = { read: vi.fn(() => read.promise), cancel }
    const stream = new ReadableStream<unknown>()
    const getReader = vi.spyOn(stream, 'getReader').mockReturnValue(reader as never)
    return { stream, reader, read, cancel, getReader }
}

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe('private V3 authorization', () => {
    test('requires exact name, V3 version, pinned script digest, and a unique persisted name', async () => {
        const base = {
            pluginName: ILLUSTRATION_V3_PROTECTED_PLUGIN_NAME,
            pluginScript: 'exact script snapshot',
            apiVersion: '3.0',
            persistedPluginNames: [ILLUSTRATION_V3_PROTECTED_PLUGIN_NAME],
            permissionGranted: true,
        }
        const sha = vi.fn(async () => DIGEST_A)
        await expect(evaluateIllustrationV3Authorization(base, [DIGEST_A], sha)).resolves.toEqual(AUTH)
        await expect(evaluateIllustrationV3Authorization(
            { ...base, pluginName: 'permission-only-plugin' },
            [DIGEST_A],
            sha,
        )).resolves.toBeNull()
        await expect(evaluateIllustrationV3Authorization(
            { ...base, apiVersion: '2.0' },
            [DIGEST_A],
            sha,
        )).resolves.toBeNull()
        await expect(evaluateIllustrationV3Authorization(base, [DIGEST_B], sha)).resolves.toBeNull()
        await expect(evaluateIllustrationV3Authorization({
            ...base,
            persistedPluginNames: [
                ILLUSTRATION_V3_PROTECTED_PLUGIN_NAME,
                ILLUSTRATION_V3_PROTECTED_PLUGIN_NAME,
            ],
        }, [DIGEST_A], sha)).resolves.toBeNull()
    })

    test('captures plugin and rotation inputs immutably before async hashing resolves', async () => {
        const hash = deferred<string>()
        const persistedNames = [ILLUSTRATION_V3_PROTECTED_PLUGIN_NAME]
        const pins = [DIGEST_A]
        const input = {
            pluginName: ILLUSTRATION_V3_PROTECTED_PLUGIN_NAME,
            pluginScript: 'captured script',
            apiVersion: '3.0',
            persistedPluginNames: persistedNames,
        }
        const authorization = evaluateIllustrationV3Authorization(
            input,
            pins,
            async (script) => {
                expect(script).toBe('captured script')
                return await hash.promise
            },
        )
        input.pluginName = 'mutated-name'
        input.pluginScript = 'mutated script'
        persistedNames.push(ILLUSTRATION_V3_PROTECTED_PLUGIN_NAME)
        pins[0] = DIGEST_B
        hash.resolve(DIGEST_A)
        await expect(authorization).resolves.toEqual(AUTH)
    })

    test('supports a two-digest rotation and rejects invalid rotation lists', async () => {
        const input = {
            pluginName: ILLUSTRATION_V3_PROTECTED_PLUGIN_NAME,
            pluginScript: 'script',
            apiVersion: '3.0',
            persistedPluginNames: [ILLUSTRATION_V3_PROTECTED_PLUGIN_NAME],
        }
        await expect(evaluateIllustrationV3Authorization(
            input,
            [DIGEST_A, DIGEST_B],
            async () => DIGEST_B,
        )).resolves.toMatchObject({ scriptDigest: DIGEST_B })
        expect(() => validatePinnedIllustrationDigests([])).toThrow()
        expect(() => validatePinnedIllustrationDigests([DIGEST_A, DIGEST_B, 'c'.repeat(64)])).toThrow()
        expect(() => validatePinnedIllustrationDigests([DIGEST_A, DIGEST_A])).toThrow()
        expect(() => validatePinnedIllustrationDigests(['A'.repeat(64)])).toThrow()
        expect(Object.isFrozen(PINNED_ILLUSTRATION_PLUGIN_DIGESTS)).toBe(true)
    })

    test('does not construct roots or aliases when authorization is absent', () => {
        const create = vi.fn(() => makeHarness().bridge)
        expect(createIllustrationV3CapabilityIfAuthorized(null, create)).toBeUndefined()
        expect(create).not.toHaveBeenCalled()
        const capability = createIllustrationV3CapabilityIfAuthorized(AUTH, create)
        expect(capability?.rootMethods._ijGetCapabilities).toBeTypeOf('function')
        expect(capability?.aliases.illustrationJobs).toEqual(ILLUSTRATION_JOBS_ALIAS)
        expect(create).toHaveBeenCalledTimes(1)
    })
})

describe('private V3 API shape and hygiene', () => {
    test('exports exactly the allowlisted async roots, alias map, and fully implemented capabilities', async () => {
        const { bridge } = makeHarness()
        expect(Object.keys(bridge.rootMethods).sort()).toEqual([
            '_ijCancel',
            '_ijClaimCoordinator',
            '_ijClaimJob',
            '_ijClaimTurn',
            '_ijGetCapabilities',
            '_ijListJobs',
            '_ijListPendingTurns',
            '_ijMeasureImagePrompt',
            '_ijReleaseCoordinator',
            '_ijReportAgentFailure',
            '_ijRetryAgentFailure',
            '_ijRetryUncertain',
            '_ijSetFeatureEnabled',
            '_ijSubmitPlan',
            '_ijSubscribe',
            '_ijSupplyPrompt',
            '_ijUnsubscribe',
        ])
        expect(bridge.aliases).toEqual({ illustrationJobs: ILLUSTRATION_JOBS_ALIAS })
        for (const method of Object.values(bridge.rootMethods)) {
            const result = method()
            expect(result).toBeInstanceOf(Promise)
            await result.catch(() => undefined)
        }
        await expect(bridge.rootMethods._ijGetCapabilities()).resolves.toEqual({
            protocolVersion: 1,
            markerContractVersion: 1,
            coordinatorContractVersion: 1,
            agentFailureContractVersion: 1,
            agentLlmDrainContractVersion: 1,
            maxJobsPerTurn: 15,
            offsetEncoding: 'utf-16',
            promptOwnership: 'plugin-final',
            imagePromptContractVersion: 1,
            imagePromptOwnership: 'plugin-final-structured',
            imagePromptMeasurement: 'core-provider-model-exact',
            supportsNaiV4CharacterCaptions: true,
            illustrationStructuredOutputContractVersion: 1,
            illustrationSingleGeneration: true,
            featureEnabled: true,
        })
    })

    test('additive illustration capabilities do not disturb the required contract versions', async () => {
        const { bridge } = makeHarness()
        const capabilities = await bridge.rootMethods._ijGetCapabilities() as Record<string, unknown>
        // The additive fields are present...
        expect(capabilities.illustrationStructuredOutputContractVersion).toBe(1)
        expect(capabilities.illustrationSingleGeneration).toBe(true)
        // ...while none of the pre-existing required contract versions were bumped,
        // so a 0.2.5 plugin is never forced into contract_pending.
        expect(capabilities.protocolVersion).toBe(1)
        expect(capabilities.markerContractVersion).toBe(1)
        expect(capabilities.coordinatorContractVersion).toBe(1)
        expect(capabilities.agentFailureContractVersion).toBe(1)
        expect(capabilities.agentLlmDrainContractVersion).toBe(1)
        expect(capabilities.imagePromptContractVersion).toBe(1)
    })

    test('maps every stable code without echoing payloads or logging RPC values', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        for (const code of Object.keys(ILLUSTRATION_V3_ERROR_MESSAGES)) {
            expect(toIllustrationV3RpcError(coded(code)).message).toMatch(new RegExp(`^\\[IJ:${code}\\] `))
        }
        const unknown = toIllustrationV3RpcError(new Error('SECRET_SCENE_AND_PROMPT'))
        expect(unknown.message).toBe('[IJ:unavailable] The illustration service is unavailable.')
        expect(unknown.message).not.toContain('SECRET_SCENE_AND_PROMPT')
        const { bridge } = makeHarness()
        await expect(bridge.rootMethods._ijClaimCoordinator({
            protocolVersion: 999,
            scenePayload: 'SECRET_SCENE_AND_PROMPT',
        })).rejects.toThrow('[IJ:validation]')
        expect(log).not.toHaveBeenCalled()
        expect(warn).not.toHaveBeenCalled()
        expect(error).not.toHaveBeenCalled()
    })

    test('exposes exact measurement through the alias and strips caller identity fields', async () => {
        const { bridge, deps } = makeHarness()
        const prompt = {
            schemaVersion: 1,
            layout: 'nai-v4-characters',
            basePositive: 'base',
            characterPositives: ['source#1 Alice'],
            baseNegative: 'negative',
            characterNegatives: ['negative Alice'],
        }
        await expect(bridge.rootMethods._ijMeasureImagePrompt({
            protocolVersion: 1,
            settingsFingerprint: 'fingerprint',
            prompt,
            runtimeId: 'forged-runtime',
            scriptDigest: 'forged-digest',
        })).resolves.toEqual({
            model: 'nai-diffusion-4-5-full',
            tokenizer: 't5-spiece-v1',
            positiveTokens: 4,
            negativeTokens: 2,
            maxPositiveTokens: 512,
            maxNegativeTokens: 512,
        })
        expect(deps.measureImagePrompt).toHaveBeenCalledWith({
            protocolVersion: 1,
            settingsFingerprint: 'fingerprint',
            prompt,
        })
        expect(bridge.aliases.illustrationJobs.measureImagePrompt).toBe('_ijMeasureImagePrompt')
    })

    test('carries only allowlisted numeric over-limit measurements in RPC errors', () => {
        const payload = {
            positiveTokens: 513,
            negativeTokens: 12,
            maxPositiveTokens: 512,
            maxNegativeTokens: 512,
            model: 'nai-diffusion-4-5-full',
            secretPrompt: 'MUST NOT LEAK',
        }
        const error = toIllustrationV3RpcError({ code: 'image_prompt_over_limit', payload })
        expect(error).toMatchObject({
            code: 'image_prompt_over_limit',
            payload: {
                positiveTokens: 513,
                negativeTokens: 12,
                maxPositiveTokens: 512,
                maxNegativeTokens: 512,
                model: 'nai-diffusion-4-5-full',
            },
        })
        expect(JSON.stringify(error.payload)).not.toContain('MUST NOT LEAK')
    })

    test('injects the host runtime identity and returns bearer-free ownership views', async () => {
        const harness = makeHarness('immutable-host-runtime')
        await harness.bridge.rootMethods._ijClaimCoordinator({
            protocolVersion: 1,
            leaseId: 'caller-lease',
            holderRuntimeId: 'forged-runtime',
            runtimeId: 'forged-runtime-2',
            pluginName: ILLUSTRATION_V3_PROTECTED_PLUGIN_NAME,
            scriptDigest: DIGEST_A,
        })
        expect(harness.claimCoordinator).toHaveBeenCalledWith({
            protocolVersion: 1,
            leaseId: 'caller-lease',
            holderRuntimeId: 'immutable-host-runtime',
        })

        const submitted = await harness.bridge.rootMethods._ijSubmitPlan({ turnId: 'turn-1' }) as any[]
        expect(submitted[0]).not.toHaveProperty('leaseId')
        expect(submitted[0]).not.toHaveProperty('prompt')
        expect(submitted[0]).not.toHaveProperty('lastHolderWrite')
        expect(submitted[0].lease).toEqual({ expiresAt: 9_000, fence: 2, ownedByCaller: false })
        const supplied = await harness.bridge.rootMethods._ijSupplyPrompt({
            jobId: 'job-1',
            leaseId: 'job-owner',
        }) as any
        expect(supplied).not.toHaveProperty('leaseId')
        expect(supplied.lease.ownedByCaller).toBe(true)
    })
})

describe('host coordinator and LLM drain lifecycle', () => {
    test.each([
        ['feature_disabled', (h: ReturnType<typeof makeHarness>) => { h.state.featureEnabled = false }],
        ['coordinator_required', (h: ReturnType<typeof makeHarness>) => { h.state.coordinator!.holderRuntimeId = 'other-runtime' }],
        ['coordinator_draining', (h: ReturnType<typeof makeHarness>) => { h.state.coordinator!.draining = true }],
    ])('rejects %s before provider dispatch', async (code, arrange) => {
        const harness = makeHarness()
        arrange(harness)
        await expect(harness.bridge.runLLMModel({ mode: 'model', messages: [] }))
            .rejects.toThrow(`[IJ:${code}]`)
        expect(harness.provider).not.toHaveBeenCalled()
        expect(harness.registry.getActiveCount(harness.runtimeId, 7)).toBe(0)
    })

    test('tracks success and provider rejection, always decrementing the active count', async () => {
        const harness = makeHarness()
        const first = deferred<unknown>()
        harness.provider.mockImplementationOnce(async () => await first.promise)
        const running = harness.bridge.runLLMModel({ mode: 'model', messages: [] })
        await flushMicrotasks()
        expect(harness.registry.getActiveCount(harness.runtimeId, 7)).toBe(1)
        first.resolve({ answer: 'ok' })
        await expect(running).resolves.toEqual({ answer: 'ok' })
        expect(harness.registry.getActiveCount(harness.runtimeId, 7)).toBe(0)

        harness.provider.mockRejectedValueOnce(new Error('provider secret'))
        await expect(harness.bridge.runLLMModel({ mode: 'model', messages: [] }))
            .rejects.toThrow('[IJ:unavailable]')
        expect(harness.registry.getActiveCount(harness.runtimeId, 7)).toBe(0)
    })

    test('has no elapsed limit, schedules no timer, and settles once after the old threshold', async () => {
        vi.useFakeTimers()
        const harness = makeHarness()
        const provider = deferred<unknown>()
        let providerSignal: AbortSignal | undefined
        harness.provider.mockImplementationOnce((_options, signal) => {
            providerSignal = signal
            return provider.promise
        })
        let settled = false
        const running = harness.bridge.runLLMModel({ mode: 'model', messages: [] })
        void running.finally(() => { settled = true }).catch(() => {})
        await flushMicrotasks()
        expect(harness.registry.getActiveCount(harness.runtimeId, 7)).toBe(1)
        expect(harness.setTimer).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(1_000_000)
        expect(settled).toBe(false)
        expect(providerSignal?.aborted).toBe(false)
        expect(harness.registry.getActiveCount(harness.runtimeId, 7)).toBe(1)

        provider.resolve({ answer: 'late but valid' })
        await expect(running).resolves.toEqual({ answer: 'late but valid' })
        expect(harness.registry.getActiveCount(harness.runtimeId, 7)).toBe(0)
        expect(harness.releaseCoordinatorFinal).not.toHaveBeenCalled()
        expect(harness.state.coordinator).toMatchObject({
            leaseId: 'coordinator-lease',
            draining: false,
        })
    })

    test('keeps provider rejection sanitization and never replaces it with agent_llm_timeout', async () => {
        const harness = makeHarness()
        harness.provider.mockRejectedValueOnce(coded('validation'))
        const error = (await harness.bridge.runLLMModel({ mode: 'model', messages: [] })
            .catch((caught) => caught as Error)) as Error
        expect(error.message).toContain('[IJ:validation]')
        expect(error.message).not.toContain('agent_llm_timeout')
        expect(harness.setTimer).not.toHaveBeenCalled()
        expect(harness.registry.getActiveCount(harness.runtimeId, 7)).toBe(0)
    })

    test.each([
        ['feature OFF', 'resolve'],
        ['feature OFF', 'reject'],
        ['drain:true', 'resolve'],
        ['drain:true', 'reject'],
        ['drain:false', 'resolve'],
        ['drain:false', 'reject'],
        ['unload', 'resolve'],
        ['unload', 'reject'],
    ] as const)('%s cancels a non-cooperative provider and swallows late %s', async (initiator, late) => {
        const harness = makeHarness()
        const provider = deferred<unknown>()
        let providerSignal: AbortSignal | undefined
        harness.provider.mockImplementationOnce((_options, signal) => {
            providerSignal = signal
            return provider.promise
        })
        const running = harness.bridge.runLLMModel({ mode: 'model', messages: [] })
        await flushMicrotasks()
        expect(harness.registry.getActiveCount(harness.runtimeId, 7)).toBe(1)

        await initiateDrain(harness, initiator)
        await expect(running).rejects.toThrow('[IJ:unavailable]')
        expect(providerSignal?.aborted).toBe(true)
        expect(harness.registry.getActiveCount(harness.runtimeId, 7)).toBe(0)
        expect(harness.releaseCoordinatorFinal).toHaveBeenCalledTimes(1)

        if (late === 'resolve') provider.resolve({ result: 'detached late success' })
        else provider.reject(new Error('detached late failure'))
        await flushMicrotasks()
        expect(harness.registry.getActiveCount(harness.runtimeId, 7)).toBe(0)
        expect(harness.releaseCoordinatorFinal).toHaveBeenCalledTimes(1)
    })

    test('does not abort until markCoordinatorDraining durably succeeds', async () => {
        const harness = makeHarness()
        const provider = deferred<unknown>()
        const durableEntered = deferred<void>()
        const durableGate = deferred<void>()
        let providerSignal: AbortSignal | undefined
        harness.provider.mockImplementationOnce((_options, signal) => {
            providerSignal = signal
            return provider.promise
        })
        harness.markCoordinatorDraining.mockImplementationOnce(async (input) => {
            durableEntered.resolve()
            await durableGate.promise
            const current = harness.state.coordinator
            if (
                !current
                || current.leaseId !== input.leaseId
                || current.version !== input.expectedVersion
                || current.fence !== input.fence
            ) throw coded('coordinator_mismatch')
            harness.state.coordinator = {
                ...current,
                version: current.version + 1,
                draining: true,
            }
            return structuredClone(harness.state.coordinator)
        })
        const running = harness.bridge.runLLMModel({ mode: 'model', messages: [] })
        await flushMicrotasks()
        const draining = harness.bridge.rootMethods._ijReleaseCoordinator({
            ...currentCoordinatorProof(harness),
            drain: true,
        })
        await durableEntered.promise
        expect(providerSignal?.aborted).toBe(false)
        expect(harness.registry.getActiveCount(harness.runtimeId, 7)).toBe(1)

        durableGate.resolve()
        await expect(draining).resolves.toBeUndefined()
        await expect(running).rejects.toThrow('[IJ:unavailable]')
        expect(providerSignal?.aborted).toBe(true)
        expect(harness.releaseCoordinatorFinal).toHaveBeenCalledTimes(1)
    })

    test('stale lease, version, and fence proofs do not touch an active stream', async () => {
        const harness = makeHarness()
        const read = deferred<ReadableStreamReadResult<unknown>>()
        const cancel = vi.fn(async () => {})
        const reader = { read: vi.fn(() => read.promise), cancel }
        const stream = new ReadableStream<unknown>()
        vi.spyOn(stream, 'getReader').mockReturnValue(reader as never)
        let providerSignal: AbortSignal | undefined
        harness.provider.mockImplementationOnce(async (_options, signal) => {
            providerSignal = signal
            return { type: 'streaming', result: stream, model: 'stream-model' }
        })
        const running = harness.bridge.runLLMModel({ mode: 'model', messages: [] })
        await flushMicrotasks()
        const proof = currentCoordinatorProof(harness)

        await expect(harness.bridge.rootMethods._ijReleaseCoordinator({
            ...proof,
            leaseId: 'stale-lease',
            drain: true,
        })).rejects.toThrow('[IJ:coordinator_required]')
        await expect(harness.bridge.rootMethods._ijReleaseCoordinator({
            ...proof,
            expectedVersion: proof.expectedVersion + 1,
            drain: true,
        })).rejects.toThrow('[IJ:version_conflict]')
        await expect(harness.bridge.rootMethods._ijReleaseCoordinator({
            ...proof,
            fence: proof.fence + 1,
            drain: true,
        })).rejects.toThrow('[IJ:coordinator_required]')

        expect(providerSignal?.aborted).toBe(false)
        expect(cancel).not.toHaveBeenCalled()
        expect(harness.registry.getActiveCount(harness.runtimeId, 7)).toBe(1)
        expect(harness.state.coordinator?.draining).toBe(false)

        await initiateDrain(harness, 'drain:true')
        await expect(running).rejects.toThrow('[IJ:unavailable]')
        expect(cancel).toHaveBeenCalledTimes(1)
    })

    test.each([
        [[], ''],
        [[{ '0': 'partial' }, { '0': 'complete text' }], 'complete text'],
    ] as const)('normalizes an authorized provider stream at EOF (%#)', async (chunks, expected) => {
        const harness = makeHarness()
        const stream = new ReadableStream<Record<string, string>>({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(chunk)
                controller.close()
            },
        })
        harness.provider.mockResolvedValueOnce({
            type: 'streaming',
            result: stream,
            model: 'stream-model',
        })

        await expect(harness.bridge.runLLMModel({ mode: 'model', messages: [] }))
            .resolves.toEqual({ type: 'success', result: expected, model: 'stream-model' })
        expect(harness.registry.getActiveCount(harness.runtimeId, 7)).toBe(0)
    })

    test.each(
        (['feature OFF', 'drain:true', 'drain:false', 'unload'] as const).flatMap((initiator) => (
            (['resolve', 'reject', 'throw', 'pending'] as const).map((cancelBehavior) => (
                [initiator, cancelBehavior] as const
            ))
        )),
    )('%s drains a non-cooperative stream when reader.cancel is %s', async (initiator, cancelBehavior) => {
        const harness = makeHarness()
        const controlled = controlledStream(cancelBehavior)
        let providerSignal: AbortSignal | undefined
        harness.provider.mockImplementationOnce(async (_options, signal) => {
            providerSignal = signal
            return {
                type: 'streaming',
                result: controlled.stream,
                model: 'never-ending-model',
            }
        })
        let hostSettled = false
        const running = harness.bridge.runLLMModel({ mode: 'model', messages: [] })
        void running.then(
            () => { hostSettled = true },
            () => { hostSettled = true },
        )
        await flushMicrotasks()

        expect(controlled.getReader).toHaveBeenCalledTimes(1)
        expect(controlled.reader.read).toHaveBeenCalledTimes(1)
        expect(hostSettled).toBe(false)
        expect(harness.registry.getActiveCount(harness.runtimeId, 7)).toBe(1)

        await initiateDrain(harness, initiator)
        await expect(running).rejects.toThrow('[IJ:unavailable]')
        expect(providerSignal?.aborted).toBe(true)
        expect(controlled.cancel).toHaveBeenCalledTimes(1)
        expect(harness.registry.getActiveCount(harness.runtimeId, 7)).toBe(0)
        expect(harness.releaseCoordinatorFinal).toHaveBeenCalledTimes(1)

        if (cancelBehavior === 'resolve') {
            controlled.read.resolve({ done: false, value: { '0': 'late chunk' } })
        } else if (cancelBehavior === 'reject') {
            controlled.read.resolve({ done: true, value: undefined })
        } else {
            controlled.read.reject(new Error('late stream read failure'))
        }
        await flushMicrotasks()
        expect(controlled.reader.read).toHaveBeenCalledTimes(1)
        expect(harness.registry.getActiveCount(harness.runtimeId, 7)).toBe(0)
        expect(harness.releaseCoordinatorFinal).toHaveBeenCalledTimes(1)
    })

    test('ignores a streaming wrapper that arrives after host cancellation', async () => {
        const harness = makeHarness()
        const provider = deferred<unknown>()
        const controlled = controlledStream('resolve')
        harness.provider.mockImplementationOnce(() => provider.promise)
        const running = harness.bridge.runLLMModel({ mode: 'model', messages: [] })
        await flushMicrotasks()

        await initiateDrain(harness, 'drain:true')
        await expect(running).rejects.toThrow('[IJ:unavailable]')
        provider.resolve({ type: 'streaming', result: controlled.stream, model: 'late-stream' })
        await flushMicrotasks()

        expect(controlled.getReader).not.toHaveBeenCalled()
        expect(controlled.cancel).not.toHaveBeenCalled()
        expect(harness.releaseCoordinatorFinal).toHaveBeenCalledTimes(1)
    })

    test.each(['resolve', 'reject'] as const)(
        'old-fence late %s cannot affect an immediately reacquired coordinator',
        async (late) => {
            const harness = makeHarness()
            const oldProvider = deferred<unknown>()
            let oldSignal: AbortSignal | undefined
            harness.provider.mockImplementationOnce((_options, signal) => {
                oldSignal = signal
                return oldProvider.promise
            })
            const oldRunning = harness.bridge.runLLMModel({ mode: 'model', messages: [] })
            await flushMicrotasks()

            await initiateDrain(harness, 'drain:false')
            const reclaim = harness.bridge.rootMethods._ijClaimCoordinator({
                protocolVersion: 1,
                leaseId: 'coordinator-lease-new',
            }) as Promise<{ fence: number }>
            await expect(reclaim).resolves.toMatchObject({ fence: 8, ownedByCaller: true })
            await expect(oldRunning).rejects.toThrow('[IJ:unavailable]')
            expect(oldSignal?.aborted).toBe(true)

            const newProvider = deferred<unknown>()
            let newSignal: AbortSignal | undefined
            harness.provider.mockImplementationOnce((_options, signal) => {
                newSignal = signal
                return newProvider.promise
            })
            const newRunning = harness.bridge.runLLMModel({ mode: 'model', messages: [] })
            await flushMicrotasks()
            expect(harness.registry.getActiveCount(harness.runtimeId, 8)).toBe(1)

            if (late === 'resolve') oldProvider.resolve('old late success')
            else oldProvider.reject(new Error('old late failure'))
            await flushMicrotasks()
            expect(newSignal?.aborted).toBe(false)
            expect(harness.registry.getActiveCount(harness.runtimeId, 8)).toBe(1)
            expect(harness.releaseCoordinatorFinal).toHaveBeenCalledTimes(1)

            newProvider.resolve('new fence success')
            await expect(newRunning).resolves.toBe('new fence success')
            expect(harness.registry.getActiveCount(harness.runtimeId, 8)).toBe(0)
        },
    )

    test('unloading an old runtime never aborts a newer runtime or fence', async () => {
        const harness = makeHarness('runtime-a')
        const oldProvider = deferred<unknown>()
        let oldSignal: AbortSignal | undefined
        harness.provider.mockImplementationOnce((_options, signal) => {
            oldSignal = signal
            return oldProvider.promise
        })
        const oldRunning = harness.bridge.runLLMModel({ mode: 'model', messages: [] })
        await flushMicrotasks()

        harness.state.coordinator = {
            version: 2,
            fence: 8,
            leaseId: 'coordinator-b',
            holderRuntimeId: 'runtime-b',
            expiresAt: 61_000,
            draining: false,
        }
        const bridgeB = createAuthorizedIllustrationV3Bridge({
            auth: AUTH,
            runtimeId: 'runtime-b',
            deps: harness.deps,
            hostRegistry: harness.registry,
        })
        const newProvider = deferred<unknown>()
        let newSignal: AbortSignal | undefined
        harness.provider.mockImplementationOnce((_options, signal) => {
            newSignal = signal
            return newProvider.promise
        })
        const newRunning = bridgeB.runLLMModel({ mode: 'model', messages: [] })
        await flushMicrotasks()
        expect(harness.registry.getActiveCount('runtime-a', 7)).toBe(1)
        expect(harness.registry.getActiveCount('runtime-b', 8)).toBe(1)

        await expect(harness.bridge.unload()).resolves.toBeUndefined()
        await expect(oldRunning).rejects.toThrow('[IJ:unavailable]')
        expect(oldSignal?.aborted).toBe(true)
        expect(newSignal?.aborted).toBe(false)
        expect(harness.registry.getActiveCount('runtime-a', 7)).toBe(0)
        expect(harness.registry.getActiveCount('runtime-b', 8)).toBe(1)

        oldProvider.reject(new Error('old runtime late failure'))
        await flushMicrotasks()
        expect(newSignal?.aborted).toBe(false)
        expect(harness.registry.getActiveCount('runtime-b', 8)).toBe(1)

        newProvider.resolve('new runtime success')
        await expect(newRunning).resolves.toBe('new runtime success')
        await bridgeB.unload()
    })

    test('feature-disabled capability reconciliation cancels active work', async () => {
        const harness = makeHarness()
        const provider = deferred<unknown>()
        harness.provider.mockImplementationOnce(() => provider.promise)
        const running = harness.bridge.runLLMModel({ mode: 'model', messages: [] })
        await flushMicrotasks()
        harness.state.featureEnabled = false

        await expect(harness.bridge.rootMethods._ijGetCapabilities())
            .resolves.toMatchObject({ featureEnabled: false })
        await expect(running).rejects.toThrow('[IJ:unavailable]')
        expect(harness.markCoordinatorDraining).toHaveBeenCalledTimes(1)
        expect(harness.releaseCoordinatorFinal).toHaveBeenCalledTimes(1)
    })

    test('feature-disabled post-claim discovery cancels active work', async () => {
        const harness = makeHarness()
        const provider = deferred<unknown>()
        harness.provider.mockImplementationOnce(() => provider.promise)
        const running = harness.bridge.runLLMModel({ mode: 'model', messages: [] })
        await flushMicrotasks()
        harness.state.disableFeatureAfterClaim = true

        await expect(harness.bridge.rootMethods._ijClaimCoordinator({
            protocolVersion: 1,
            leaseId: 'claim-before-feature-off-discovery',
        })).rejects.toThrow('[IJ:feature_disabled]')
        await expect(running).rejects.toThrow('[IJ:unavailable]')
        expect(harness.releaseCoordinatorFinal).toHaveBeenCalledTimes(1)
    })

    test('provider failure remains primary when drain cleanup also fails', async () => {
        const harness = makeHarness()
        const provider = deferred<unknown>()
        harness.provider.mockImplementationOnce(() => provider.promise)
        harness.releaseCoordinatorFinal.mockRejectedValueOnce(new Error('cleanup secret'))
        const running = harness.bridge.runLLMModel({ mode: 'model', messages: [] })
        await flushMicrotasks()
        harness.state.coordinator = {
            ...harness.state.coordinator!,
            draining: true,
        }
        provider.reject(coded('validation'))

        await expect(running).rejects.toThrow('[IJ:validation]')
        expect(harness.registry.getActiveCount(harness.runtimeId, 7)).toBe(0)
    })

    test('keeps runtime bookkeeping until queued unload drain can final-release', async () => {
        const harness = makeHarness()
        const provider = deferred<unknown>()
        const serialBlocker = deferred<Array<{ turnId: string; state: string }>>()
        harness.provider.mockImplementationOnce(async () => await provider.promise)
        harness.listPendingTurns.mockImplementationOnce(async () => await serialBlocker.promise)
        const running = harness.bridge.runLLMModel({ mode: 'model', messages: [] })
        await flushMicrotasks()
        const blockingRpc = harness.bridge.rootMethods._ijListPendingTurns()
        await flushMicrotasks()

        provider.resolve('settled-before-unload-drain')
        await flushMicrotasks()
        const unloading = harness.bridge.unload()
        serialBlocker.resolve([])

        await expect(blockingRpc).resolves.toEqual([])
        await expect(running).resolves.toBe('settled-before-unload-drain')
        await expect(unloading).resolves.toBeUndefined()
        expect(harness.markCoordinatorDraining).toHaveBeenCalledTimes(1)
        expect(harness.releaseCoordinatorFinal).toHaveBeenCalledTimes(1)
        expect(harness.state.coordinator?.leaseId).toBeNull()
    })

    test('rejects an admission that acquires the ledger lock after unload begins', async () => {
        const harness = makeHarness()
        const admissionGate = deferred<void>()
        harness.state.admitBeforeStart = admissionGate.promise
        const running = harness.bridge.runLLMModel({ mode: 'model', messages: [] })
        await flushMicrotasks()
        const unloading = harness.bridge.unload()
        admissionGate.resolve()

        await expect(running).rejects.toThrow('[IJ:unavailable]')
        await expect(unloading).resolves.toBeUndefined()
        expect(harness.provider).not.toHaveBeenCalled()
        expect(harness.registry.getActiveCount(harness.runtimeId, 7)).toBe(0)
    })
})

describe('wake subscriptions', () => {
    test('uses per-instance tokens, unsubscribe isolation, rejection cleanup, and unload cleanup', async () => {
        const first = makeHarness('runtime-a')
        const secondRegistry = new IllustrationV3HostLlmRegistry(first.deps)
        const second = createAuthorizedIllustrationV3Bridge({
            auth: AUTH,
            runtimeId: 'runtime-b',
            deps: { ...first.deps, randomUUID: () => 'subscription-1' },
            hostRegistry: secondRegistry,
        })
        const listenerA = vi.fn()
        const listenerB = vi.fn()
        const tokenA = await first.bridge.rootMethods._ijSubscribe(listenerA) as { subscriptionId: string }
        const tokenB = await second.rootMethods._ijSubscribe(listenerB) as { subscriptionId: string }
        expect(tokenA.subscriptionId).toBe(tokenB.subscriptionId)
        await first.bridge.rootMethods._ijUnsubscribe(tokenA)
        await first.emit({ protocolVersion: 1, sequence: 1, kind: 'turn_changed', turnId: 'turn-1' })
        expect(listenerA).not.toHaveBeenCalled()
        expect(listenerB).toHaveBeenCalledTimes(1)

        const rejecting = vi.fn(async () => { throw new Error('listener failed') })
        await first.bridge.rootMethods._ijSubscribe(rejecting)
        await first.emit({ protocolVersion: 1, sequence: 2, kind: 'job_changed', turnId: 'turn-1', jobId: 'job-1' })
        await first.emit({ protocolVersion: 1, sequence: 3, kind: 'job_changed', turnId: 'turn-1', jobId: 'job-1' })
        expect(rejecting).toHaveBeenCalledTimes(1)
        await second.unload()
        expect(first.wakeListeners.size).toBe(0)
    })

    test('emits frozen, monotonic, nonblocking coarse hints from the shared hub', async () => {
        const observed: IllustrationWakeHintV1[] = []
        const dispose = subscribeIllustrationWakeHints((hint) => {
            observed.push(hint)
        })
        const first = emitIllustrationWakeHint('turn_changed', 'turn-a')
        const second = emitIllustrationWakeHint('job_changed', 'turn-a', 'job-a')
        expect(observed).toEqual([])
        expect(second.sequence).toBe(first.sequence + 1)
        expect(Object.isFrozen(first)).toBe(true)
        await flushMicrotasks()
        expect(observed).toEqual([first, second])
        dispose()
    })
})
