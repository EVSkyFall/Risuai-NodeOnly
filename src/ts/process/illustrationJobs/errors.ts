import type { IllustrationImagePromptOverLimitPayloadV1 } from './types'

export class IllustrationLedgerError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
        super(message)
        this.name = new.target.name
        this.code = code
    }
}

export type IllustrationImagePromptErrorCode =
    | 'image_prompt_over_limit'
    | 'image_tokenizer_unavailable'
    | 'image_prompt_measurement_unsupported'
    | 'image_prompt_invalid'
    | 'settings_fingerprint_mismatch'

export class IllustrationImagePromptContractError extends IllustrationLedgerError {
    readonly payload?: IllustrationImagePromptOverLimitPayloadV1

    constructor(
        code: IllustrationImagePromptErrorCode,
        message: string,
        payload?: IllustrationImagePromptOverLimitPayloadV1,
    ) {
        super(code, message)
        this.payload = payload
    }
}

export class IllustrationLedgerUnavailableError extends IllustrationLedgerError {
    constructor() {
        super('ledger_unavailable', 'Illustration jobs require the Web Locks API')
    }
}

export class IllustrationLedgerNotFoundError extends IllustrationLedgerError {
    constructor(kind: string, id: string) {
        super('not_found', `Illustration ${kind} was not found: ${id}`)
    }
}

export class IllustrationLedgerVersionConflictError extends IllustrationLedgerError {
    readonly expectedVersion: number
    readonly actualVersion: number

    constructor(expectedVersion: number, actualVersion: number) {
        super(
            'version_conflict',
            `Illustration ledger version conflict: expected ${expectedVersion}, received ${actualVersion}`,
        )
        this.expectedVersion = expectedVersion
        this.actualVersion = actualVersion
    }
}

export class IllustrationLedgerTransitionError extends IllustrationLedgerError {
    constructor(kind: string, from: string, to: string) {
        super('invalid_transition', `Invalid illustration ${kind} transition: ${from} -> ${to}`)
    }
}

export class IllustrationLedgerValidationError extends IllustrationLedgerError {
    constructor(message: string) {
        super('validation_failed', message)
    }
}

// Thrown by submitPlan ONLY after a durable terminal close (turn + eligible jobs)
// completed for a stale/corrupt request. The public message is a fixed friendly
// string — the internal marker/source reason is durably recorded on the turn/job
// records and is never echoed here. The V3 bridge maps 'turn_terminal_stale' /
// 'turn_terminal_corrupt' straight through so a message-only Sandbox caller can
// distinguish a completed terminal close from generic request validation.
export class IllustrationLedgerTerminalCloseError extends IllustrationLedgerError {
    constructor(state: 'stale' | 'corrupt') {
        super(
            state === 'stale' ? 'turn_terminal_stale' : 'turn_terminal_corrupt',
            state === 'stale'
                ? 'The illustration turn became stale before plan submission.'
                : 'The illustration turn was closed as corrupt before plan submission.',
        )
    }
}

export class IllustrationLedgerCorruptError extends IllustrationLedgerError {
    constructor(message: string) {
        super('corrupt', message)
    }
}

export class IllustrationLedgerLeaseConflictError extends IllustrationLedgerError {
    constructor(message: string) {
        super('lease_conflict', message)
    }
}

export class IllustrationLedgerHolderMismatchError extends IllustrationLedgerError {
    constructor(message: string) {
        super('holder_mismatch', message)
    }
}

export class IllustrationCoordinatorMismatchError extends IllustrationLedgerError {
    constructor(message: string) {
        super('coordinator_mismatch', message)
    }
}

export class IllustrationCoordinatorExpiredError extends IllustrationLedgerError {
    constructor() {
        super('coordinator_expired', 'Illustration Agent coordinator lease has expired')
    }
}

export class IllustrationCoordinatorDrainingError extends IllustrationLedgerError {
    constructor() {
        super('coordinator_draining', 'Illustration Agent coordinator is draining')
    }
}

export class IllustrationCoordinatorCooldownError extends IllustrationLedgerError {
    readonly retryAt: number

    constructor(retryAt: number) {
        super(
            'coordinator_cooldown',
            'Illustration Agent coordinator takeover is in orphan cooldown',
        )
        this.retryAt = retryAt
    }
}

export class IllustrationLedgerIdempotencyConflictError extends IllustrationLedgerError {
    constructor(message: string) {
        super('idempotency_conflict', message)
    }
}

export class IllustrationLedgerConfirmationRequiredError extends IllustrationLedgerError {
    constructor(message = 'Retrying an uncertain job requires confirmNewCharge: true') {
        super('confirmation_required', message)
    }
}

// ---------------------------------------------------------------------------
// Provider-neutral Prompt Target V2 (Slice D). These errors sit on the new V2
// preparation/envelope/receipt surface and never touch the V1 legacy drain path.
// ---------------------------------------------------------------------------

// Re-binding a turn that already carries a durable PromptContext. It extends the
// validation family (code 'validation_failed', surfaced through the V3 bridge as
// 'validation') so a repeated prepare is a stable, definite request rejection —
// never an uncertain provider outcome. The `reason` disambiguates it in tests.
export class IllustrationPromptContextRebindError extends IllustrationLedgerValidationError {
    readonly reason = 'prompt_context_already_bound' as const

    constructor() {
        super('The illustration turn prompt context is already prepared and cannot be re-bound')
    }
}

// A transport whose durable target cannot be resolved yet. In Slice D only
// 'novelai-native' resolves; the other three transports (nai-compatible-flat,
// webui-flat, comfyui-flat) surface this typed preparation failure until Slice E.
export class IllustrationPromptTargetUnavailableError extends IllustrationLedgerError {
    readonly transportId: string
    readonly detail: string

    constructor(transportId: string, detail: string) {
        super(
            'prompt_target_unavailable',
            `The illustration prompt target for transport "${transportId}" is unavailable: ${detail}`,
        )
        this.transportId = transportId
        this.detail = detail
    }
}

export type IllustrationPromptV2ContractErrorCode =
    | 'prompt_envelope_invalid'
    | 'prompt_layout_unsupported'
    | 'prompt_negative_channel_unsupported'
    | 'prompt_pipe_conflict'
    | 'prompt_pipe_serialization_unsupported'
    | 'prompt_measurement_mode_unsupported'
    | 'prompt_receipt_binding_mismatch'
    | 'prompt_target_fingerprint_mismatch'
    | 'prompt_dispatch_ineligible'

// Envelope validation, measurement-receipt binding, and dispatch-eligibility
// failures on the V2 surface. All are definite validation-family rejections.
export class IllustrationPromptV2ContractError extends IllustrationLedgerError {
    constructor(code: IllustrationPromptV2ContractErrorCode, message: string) {
        super(code, message)
    }
}
