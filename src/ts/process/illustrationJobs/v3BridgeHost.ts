import type { OpenAIChat } from '../index.svelte'
import { requestChatDataMain } from '../request/request'
import { getGeneralJSONSchema } from '../templates/jsonSchema'
import {
    cancelLedger,
    cancelTurnLedger,
    claimCoordinatorLedger,
    claimJobLedger,
    claimTurnLedger,
    forceTakeoverCoordinatorLedger,
    getTransportConfig,
    listJobsLedger,
    listPendingTurnsLedger,
    markCoordinatorDrainingLedger,
    preparePromptContext,
    purgeAutomaticBacklog,
    releaseCoordinatorFinalLedger,
    releaseCoordinatorLedger,
    reportAgentFailureLedger,
    requestCurrentVariant,
    retryAgentFailureLedger,
    retryUncertainLedger,
    setTransportConfig,
    submitPlanLedger,
    supplyPromptLedger,
} from './coordinator'
import { getCapturePolicy, setCaptureMode } from './capturePolicy'
import {
    createImageRevision,
    enqueueRevisionImage,
    getImageRevisionTarget,
    listImageReferences,
    listImageRevisions,
    restoreImageRevision,
} from './revision'
import {
    admitIllustrationCoordinatorLlm,
    getCoordinatorRecord,
    setIllustrationFeatureEnabledWithCoordinatorDrain,
} from './coordinatorRecord'
import { IllustrationLedgerValidationError } from './errors'
import { isIllustrationFeatureEnabled } from './featureFlag'
import { subscribeIllustrationWakeHints } from './illustrationEvents'
import { measureImagePrompt } from './imagePromptMeasurement'
import { projectFullJobSnapshot } from './store'
import type { IllustrationJobRecordV1 } from './types'
import {
    createAuthorizedIllustrationV3Bridge,
    IllustrationV3HostLlmRegistry,
    type AuthorizedIllustrationV3Bridge,
    type IllustrationV3AuthorizationContext,
    type IllustrationV3BridgeDependencies,
} from './v3Bridge'

// Upper bound on the authorized-bridge structured-output schema string. 32 KiB
// (measured in UTF-16 code units, matching String.length) comfortably fits the
// Planner/Tagger interface contracts while rejecting pathological payloads before
// any provider call.
const ILLUSTRATION_LLM_SCHEMA_MAX_LENGTH = 32 * 1024

const bridgeDependencies: IllustrationV3BridgeDependencies = {
    now: () => Date.now(),
    randomUUID: () => {
        if (!globalThis.crypto?.randomUUID) {
            throw new IllustrationLedgerValidationError('Secure UUID generation is unavailable')
        }
        return globalThis.crypto.randomUUID()
    },
    isFeatureEnabled: isIllustrationFeatureEnabled,
    setFeatureEnabledWithCoordinatorDrain: setIllustrationFeatureEnabledWithCoordinatorDrain,
    claimCoordinator: claimCoordinatorLedger,
    forceTakeoverCoordinator: forceTakeoverCoordinatorLedger,
    releaseCoordinator: releaseCoordinatorLedger,
    markCoordinatorDraining: markCoordinatorDrainingLedger,
    releaseCoordinatorFinal: releaseCoordinatorFinalLedger,
    getCoordinatorRecord,
    admitLlm: admitIllustrationCoordinatorLlm,
    getCapturePolicy,
    setCaptureMode: async (input) => await setCaptureMode(input),
    requestCurrentVariant: async (input) => await requestCurrentVariant(
        input as Parameters<typeof requestCurrentVariant>[0],
    ),
    purgeAutomaticBacklog: async (input) => await purgeAutomaticBacklog(
        input as Parameters<typeof purgeAutomaticBacklog>[0],
    ),
    listPendingTurns: listPendingTurnsLedger,
    listJobs: listJobsLedger,
    claimTurn: async (input) => await claimTurnLedger(
        input as Parameters<typeof claimTurnLedger>[0],
    ),
    claimJob: async (input) => await claimJobLedger(
        input as Parameters<typeof claimJobLedger>[0],
    ),
    submitPlan: async (input) => await submitPlanLedger(
        input as Parameters<typeof submitPlanLedger>[0],
    ),
    supplyPrompt: async (input) => await supplyPromptLedger(
        input as Parameters<typeof supplyPromptLedger>[0],
    ),
    preparePromptContext: async (input) => await preparePromptContext(
        input as Parameters<typeof preparePromptContext>[0],
    ),
    setTransportConfig: async (input) => await setTransportConfig(input),
    getTransportConfig: async () => await getTransportConfig(),
    measureImagePrompt: async (input) => await measureImagePrompt(input),
    cancelJob: cancelLedger,
    cancelTurn: cancelTurnLedger,
    createImageRevision: async (input) => await createImageRevision(
        input as Parameters<typeof createImageRevision>[0],
    ),
    getImageRevisionTarget: async (input) => await getImageRevisionTarget(
        input as Parameters<typeof getImageRevisionTarget>[0],
    ),
    listImageRevisions: async (input) => await listImageRevisions(
        input as Parameters<typeof listImageRevisions>[0],
    ),
    restoreImageRevision: async (input) => await restoreImageRevision(
        input as Parameters<typeof restoreImageRevision>[0],
    ),
    enqueueRevisionImage: async (input) => await enqueueRevisionImage(
        input as Parameters<typeof enqueueRevisionImage>[0],
    ),
    listImageReferences: async (input) => await listImageReferences(
        input as Parameters<typeof listImageReferences>[0],
    ),
    retryUncertain: async (input) => await retryUncertainLedger(
        input as Parameters<typeof retryUncertainLedger>[0],
    ),
    reportAgentFailure: async (input) => await reportAgentFailureLedger(
        input as Parameters<typeof reportAgentFailureLedger>[0],
    ),
    retryAgentFailure: async (input) => await retryAgentFailureLedger(
        input as Parameters<typeof retryAgentFailureLedger>[0],
    ),
    projectJobSnapshot: (record, callerLeaseId) => projectFullJobSnapshot(
        record as IllustrationJobRecordV1,
        callerLeaseId,
    ),
    runLlmModel: async (value, signal) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new IllustrationLedgerValidationError('runLLMModel options must be an object')
        }
        const options = value as {
            mode?: unknown
            messages?: unknown
            staticModel?: unknown
            allowPlugins?: unknown
            schema?: unknown
        }
        const allowedModes = new Set(['model', 'submodel', 'memory', 'emotion', 'otherAx', 'translate'])
        if (!allowedModes.has(String(options.mode)) || !Array.isArray(options.messages)) {
            throw new IllustrationLedgerValidationError('runLLMModel options are invalid')
        }
        if (options.staticModel !== undefined && typeof options.staticModel !== 'string') {
            throw new IllustrationLedgerValidationError('runLLMModel staticModel must be a string')
        }
        if (options.allowPlugins !== undefined && typeof options.allowPlugins !== 'boolean') {
            throw new IllustrationLedgerValidationError('runLLMModel allowPlugins must be a boolean')
        }
        let schema: string | undefined
        if (options.schema !== undefined) {
            if (typeof options.schema !== 'string') {
                throw new IllustrationLedgerValidationError('runLLMModel schema must be a string')
            }
            if (options.schema.length > ILLUSTRATION_LLM_SCHEMA_MAX_LENGTH) {
                throw new IllustrationLedgerValidationError('runLLMModel schema exceeds the maximum length')
            }
            // Reject malformed schema strings at the host boundary, before any
            // provider request. The provider builders (requestOpenAI/google) call
            // the schema converter with no local guard, so an unconvertible string
            // would otherwise throw synchronously inside the request builder.
            //
            // We run getGeneralJSONSchema — the Gemini/Vertex builder's exact
            // converter (google.ts uses these same excludes) — rather than the bare
            // convertInterfaceToSchema. getGeneralJSONSchema is a strict superset of
            // every provider path's conversion: it does convertInterfaceToSchema
            // (covering the OpenAI path, which only embeds that result) AND then
            // walks the parsed value with Object.keys. A primitive/null-valued
            // payload such as schema='null' parses to a non-object that
            // convertInterfaceToSchema accepts without throwing, but Object.keys(null)
            // throws a TypeError inside the Gemini builder. Running the full converter
            // here means acceptance genuinely guarantees the downstream conversion
            // cannot fail, so such payloads fail closed with a stable validation error
            // instead of surfacing an unmapped TypeError from the request builder.
            schema = options.schema
            try {
                getGeneralJSONSchema(schema, ['$schema', 'additionalProperties'])
            } catch {
                throw new IllustrationLedgerValidationError('runLLMModel schema is not a valid structured-output schema')
            }
        }
        const response = await requestChatDataMain({
            formated: options.messages as OpenAIChat[],
            bias: {},
            staticModel: options.staticModel as string | undefined,
            blockPlugins: options.allowPlugins !== true,
            useStreaming: false,
            // The Illustration Agent always resolves a single generation regardless
            // of the user's multi-generation DB setting. Public/generic V3 and other
            // plugin calls are unaffected.
            noMultiGen: true,
            schema,
            hostOmitCallerGenerationCap: true,
        }, options.mode as Parameters<typeof requestChatDataMain>[1], signal)
        // Fail-closed if a provider ignores noMultiGen and returns a multi-generation
        // tuple. Silently concatenating the tuple would splice ['user'|'char'] role
        // strings into the plugin's JSON payload, so we surface a stable validation
        // error instead of returning the tuple.
        if (response?.type === 'multiline') {
            throw new IllustrationLedgerValidationError('runLLMModel received an unexpected multi-generation response')
        }
        return response
    },
    subscribeWakeHints: subscribeIllustrationWakeHints,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (timer) => clearTimeout(timer),
}

const hostLlmRegistry = new IllustrationV3HostLlmRegistry(bridgeDependencies)

export function createAuthorizedIllustrationV3HostBridge(
    auth: IllustrationV3AuthorizationContext,
    runtimeId: string,
): AuthorizedIllustrationV3Bridge {
    return createAuthorizedIllustrationV3Bridge({
        auth,
        runtimeId,
        deps: bridgeDependencies,
        hostRegistry: hostLlmRegistry,
    })
}
