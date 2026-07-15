export class IllustrationLedgerError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
        super(message)
        this.name = new.target.name
        this.code = code
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
