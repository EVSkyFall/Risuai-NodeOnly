import type { OpenAIChat } from '../index.svelte'
import { requestChatDataMain } from '../request/request'
import {
    cancelLedger,
    cancelTurnLedger,
    claimCoordinatorLedger,
    claimJobLedger,
    claimTurnLedger,
    listJobsLedger,
    listPendingTurnsLedger,
    markCoordinatorDrainingLedger,
    releaseCoordinatorFinalLedger,
    releaseCoordinatorLedger,
    reportAgentFailureLedger,
    retryAgentFailureLedger,
    retryUncertainLedger,
    submitPlanLedger,
    supplyPromptLedger,
} from './coordinator'
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
    releaseCoordinator: releaseCoordinatorLedger,
    markCoordinatorDraining: markCoordinatorDrainingLedger,
    releaseCoordinatorFinal: releaseCoordinatorFinalLedger,
    getCoordinatorRecord,
    admitLlm: admitIllustrationCoordinatorLlm,
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
    measureImagePrompt: async (input) => await measureImagePrompt(input),
    cancelJob: cancelLedger,
    cancelTurn: cancelTurnLedger,
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
        return await requestChatDataMain({
            formated: options.messages as OpenAIChat[],
            bias: {},
            staticModel: options.staticModel as string | undefined,
            blockPlugins: options.allowPlugins !== true,
            useStreaming: false,
            hostOmitCallerGenerationCap: true,
        }, options.mode as Parameters<typeof requestChatDataMain>[1], signal)
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
