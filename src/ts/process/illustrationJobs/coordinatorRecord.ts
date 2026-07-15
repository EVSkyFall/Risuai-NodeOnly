import { readPersistentJson, writePersistentJson } from '../../storage/persistentKv'
import {
    IllustrationCoordinatorDrainingError,
    IllustrationCoordinatorExpiredError,
    IllustrationCoordinatorMismatchError,
    IllustrationLedgerValidationError,
    IllustrationLedgerVersionConflictError,
} from './errors'
import { withIllustrationLedgerLock } from './locks'
import type {
    IllustrationCoordinatorProof,
    IllustrationCoordinatorRecordV1,
    IllustrationCoordinatorSnapshotV1,
} from './types'

export const ILLUSTRATION_COORDINATOR_KEY = 'illustration:v1:coordinator'
export const COORDINATOR_LEASE_DURATION_MS = 60_000

export type ClaimCoordinatorInput = {
    protocolVersion: 1
    leaseId: string
    holderRuntimeId: string
    expectedVersion?: number
    fence?: number
}

export type ReleaseCoordinatorInput = {
    protocolVersion: 1
    leaseId: string
    expectedVersion: number
    fence: number
    drain: boolean
}

export type CoordinatorReleaseProof = Omit<ReleaseCoordinatorInput, 'drain'>

function assertProtocolVersion(protocolVersion: unknown): asserts protocolVersion is 1 {
    if (protocolVersion !== 1) {
        throw new IllustrationLedgerValidationError('Illustration coordinator protocolVersion must be 1')
    }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new IllustrationLedgerValidationError(`${label} must be a non-empty string`)
    }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new IllustrationLedgerValidationError(`${label} must be a non-negative safe integer`)
    }
}

function assertOptionalSnapshot(input: ClaimCoordinatorInput, current: IllustrationCoordinatorRecordV1): void {
    if (input.expectedVersion !== undefined) {
        assertNonNegativeInteger(input.expectedVersion, 'expectedVersion')
        if (input.expectedVersion !== current.version) {
            throw new IllustrationLedgerVersionConflictError(input.expectedVersion, current.version)
        }
    }
    if (input.fence !== undefined) {
        assertNonNegativeInteger(input.fence, 'fence')
        if (input.fence !== current.fence) {
            throw new IllustrationCoordinatorMismatchError(
                'Illustration coordinator fence does not match the latest snapshot',
            )
        }
    }
}

function snapshot(
    record: IllustrationCoordinatorRecordV1,
    ownedByCaller: boolean,
): IllustrationCoordinatorSnapshotV1 {
    return {
        protocolVersion: 1,
        version: record.version,
        fence: record.fence,
        expiresAt: record.expiresAt,
        ownedByCaller,
        draining: record.draining,
    }
}

async function readCoordinatorUnlocked(): Promise<IllustrationCoordinatorRecordV1 | null> {
    return await readPersistentJson<IllustrationCoordinatorRecordV1>(ILLUSTRATION_COORDINATOR_KEY)
}

function validateReleaseProof(
    current: IllustrationCoordinatorRecordV1,
    input: CoordinatorReleaseProof,
): void {
    validateReleaseProofShape(input)
    if (current.version !== input.expectedVersion) {
        throw new IllustrationLedgerVersionConflictError(input.expectedVersion, current.version)
    }
    if (current.leaseId !== input.leaseId || current.fence !== input.fence) {
        throw new IllustrationCoordinatorMismatchError(
            'Illustration coordinator release proof does not match the active owner',
        )
    }
}

function validateReleaseProofShape(input: CoordinatorReleaseProof): void {
    assertProtocolVersion(input.protocolVersion)
    assertNonEmptyString(input.leaseId, 'leaseId')
    assertNonNegativeInteger(input.expectedVersion, 'expectedVersion')
    assertNonNegativeInteger(input.fence, 'fence')
}

export async function claimCoordinator(
    input: ClaimCoordinatorInput,
): Promise<IllustrationCoordinatorSnapshotV1> {
    return await withIllustrationLedgerLock(async () => {
        assertProtocolVersion(input.protocolVersion)
        assertNonEmptyString(input.leaseId, 'leaseId')
        assertNonEmptyString(input.holderRuntimeId, 'holderRuntimeId')
        const current = await readCoordinatorUnlocked()
        const now = Date.now()

        if (!current) {
            if (input.expectedVersion !== undefined && input.expectedVersion !== 0) {
                throw new IllustrationLedgerVersionConflictError(input.expectedVersion, 0)
            }
            if (input.fence !== undefined && input.fence !== 0) {
                throw new IllustrationCoordinatorMismatchError(
                    'The first coordinator claim must start from fence 0',
                )
            }
            const created: IllustrationCoordinatorRecordV1 = {
                version: 1,
                fence: 1,
                leaseId: input.leaseId,
                holderRuntimeId: input.holderRuntimeId,
                expiresAt: now + COORDINATOR_LEASE_DURATION_MS,
                draining: false,
                updatedAt: now,
            }
            await writePersistentJson(ILLUSTRATION_COORDINATOR_KEY, created)
            return snapshot(created, true)
        }

        const unexpired = current.leaseId !== null && current.expiresAt > now
        const sameOwner = unexpired
            && current.leaseId === input.leaseId
            && current.holderRuntimeId === input.holderRuntimeId
        if (unexpired && !sameOwner) return snapshot(current, false)

        assertOptionalSnapshot(input, current)
        if (sameOwner) {
            const renewed: IllustrationCoordinatorRecordV1 = {
                ...current,
                version: current.version + 1,
                expiresAt: now + COORDINATOR_LEASE_DURATION_MS,
                updatedAt: now,
                // A renew can maintain a draining owner while host-side LLMs settle,
                // but it must never reopen that runtime for new work.
                draining: current.draining,
            }
            await writePersistentJson(ILLUSTRATION_COORDINATOR_KEY, renewed)
            return snapshot(renewed, true)
        }

        const takenOver: IllustrationCoordinatorRecordV1 = {
            version: current.version + 1,
            fence: current.fence + 1,
            leaseId: input.leaseId,
            holderRuntimeId: input.holderRuntimeId,
            expiresAt: now + COORDINATOR_LEASE_DURATION_MS,
            // A successful fresh claim is the explicit boundary that clears an
            // expired predecessor's durable draining state.
            draining: false,
            updatedAt: now,
        }
        await writePersistentJson(ILLUSTRATION_COORDINATOR_KEY, takenOver)
        return snapshot(takenOver, true)
    })
}

export async function markCoordinatorDraining(
    input: CoordinatorReleaseProof,
): Promise<IllustrationCoordinatorRecordV1> {
    return await withIllustrationLedgerLock(async () => {
        validateReleaseProofShape(input)
        const current = await readCoordinatorUnlocked()
        if (!current) {
            throw new IllustrationCoordinatorMismatchError('Illustration coordinator does not exist')
        }
        if (
            current.draining
            && current.version === input.expectedVersion + 1
            && current.leaseId === input.leaseId
            && current.fence === input.fence
        ) {
            return structuredClone(current)
        }
        validateReleaseProof(current, input)
        const next: IllustrationCoordinatorRecordV1 = {
            ...current,
            draining: true,
            version: current.version + 1,
            updatedAt: Date.now(),
        }
        await writePersistentJson(ILLUSTRATION_COORDINATOR_KEY, next)
        return structuredClone(next)
    })
}

export async function releaseCoordinator(input: ReleaseCoordinatorInput): Promise<void> {
    validateReleaseProofShape(input)
    if (input.drain === true) {
        await markCoordinatorDraining(input)
        return
    }
    if (input.drain !== false) {
        throw new IllustrationLedgerValidationError('drain must be a boolean')
    }
    await withIllustrationLedgerLock(async () => {
        const current = await readCoordinatorUnlocked()
        if (!current) {
            throw new IllustrationCoordinatorMismatchError('Illustration coordinator does not exist')
        }
        if (
            current.version === input.expectedVersion + 1
            && current.leaseId === null
            && current.fence === input.fence
            && current.draining === false
        ) return
        validateReleaseProof(current, input)
        if (current.draining) {
            throw new IllustrationCoordinatorDrainingError()
        }
        const next: IllustrationCoordinatorRecordV1 = {
            ...current,
            version: current.version + 1,
            leaseId: null,
            holderRuntimeId: null,
            expiresAt: 0,
            draining: false,
            updatedAt: Date.now(),
        }
        await writePersistentJson(ILLUSTRATION_COORDINATOR_KEY, next)
    })
}

export async function releaseCoordinatorFinal(input: CoordinatorReleaseProof): Promise<void> {
    await withIllustrationLedgerLock(async () => {
        validateReleaseProofShape(input)
        const current = await readCoordinatorUnlocked()
        if (!current) {
            throw new IllustrationCoordinatorMismatchError('Illustration coordinator does not exist')
        }
        if (
            current.version === input.expectedVersion + 1
            && current.leaseId === null
            && current.fence === input.fence
            && current.draining === true
        ) return
        validateReleaseProof(current, input)
        if (!current.draining) {
            throw new IllustrationCoordinatorMismatchError(
                'Illustration coordinator final release requires durable draining state',
            )
        }
        const next: IllustrationCoordinatorRecordV1 = {
            ...current,
            version: current.version + 1,
            leaseId: null,
            holderRuntimeId: null,
            expiresAt: 0,
            // Preserve the drain marker until a successful fresh claim explicitly
            // starts a non-draining ownership epoch.
            draining: true,
            updatedAt: Date.now(),
        }
        await writePersistentJson(ILLUSTRATION_COORDINATOR_KEY, next)
    })
}

export async function getCoordinatorRecord(): Promise<IllustrationCoordinatorRecordV1 | null> {
    return await withIllustrationLedgerLock(async () => {
        const record = await readCoordinatorUnlocked()
        return record ? structuredClone(record) : null
    })
}

// This helper intentionally does not acquire the Web Lock. Store mutations call
// it only from inside their existing ledger-lock callback so coordinator proof
// and the target record CAS share one atomic boundary.
export async function validateCoordinatorProofUnlocked(
    input: IllustrationCoordinatorProof,
    options: { allowDraining?: boolean; now?: number } = {},
): Promise<IllustrationCoordinatorRecordV1> {
    assertNonEmptyString(input.coordinatorLeaseId, 'coordinatorLeaseId')
    assertNonNegativeInteger(input.coordinatorFence, 'coordinatorFence')
    const current = await readCoordinatorUnlocked()
    if (!current) {
        throw new IllustrationCoordinatorMismatchError('Illustration coordinator does not exist')
    }
    if (
        current.leaseId !== input.coordinatorLeaseId
        || current.fence !== input.coordinatorFence
    ) {
        throw new IllustrationCoordinatorMismatchError(
            'Illustration coordinator proof does not match the active owner',
        )
    }
    if (current.expiresAt <= (options.now ?? Date.now())) {
        throw new IllustrationCoordinatorExpiredError()
    }
    if (current.draining && options.allowDraining !== true) {
        throw new IllustrationCoordinatorDrainingError()
    }
    return current
}
