import { readPersistentJson, writePersistentJson } from '../../storage/persistentKv'
import { IllustrationLedgerValidationError } from './errors'
import { withIllustrationLedgerLock } from './locks'
import type { IllustrationCaptureMode } from './types'

export const ILLUSTRATION_CAPTURE_POLICY_KEY = 'illustration:v1:capturePolicy'
export const ILLUSTRATION_CAPTURE_POLICY_CONTRACT_VERSION = 1

export type { IllustrationCaptureMode, IllustrationCaptureOrigin } from './types'

type StoredCapturePolicyV1 = {
    protocolVersion: 1
    mode: IllustrationCaptureMode
}

export function isIllustrationCaptureMode(value: unknown): value is IllustrationCaptureMode {
    return value === 'manual' || value === 'automatic'
}

function parseStoredMode(raw: unknown): IllustrationCaptureMode | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const record = raw as { protocolVersion?: unknown; mode?: unknown }
    if (record.protocolVersion !== 1) return null
    return isIllustrationCaptureMode(record.mode) ? record.mode : null
}

/**
 * Durable current mode. The contract default — an absent record OR a structurally
 * invalid one — is 'manual', the fail-safe (no automatic cost) policy. A genuine
 * storage read failure (e.g. corrupt bytes throwing from JSON.parse, or the lock
 * manager being unavailable) is NOT swallowed: it propagates so `getCapturePolicy`
 * reports `unavailable` and the Plugin treats the contract as pending — zero cost
 * work — instead of silently guessing a mode.
 */
export async function readDurableCaptureMode(): Promise<IllustrationCaptureMode> {
    return await withIllustrationLedgerLock(async () => {
        const raw = await readPersistentJson<unknown>(ILLUSTRATION_CAPTURE_POLICY_KEY)
        return parseStoredMode(raw) ?? 'manual'
    })
}

/**
 * Fail-closed admission predicate for the automatic terminal-capture seam. An
 * automatic capture is admitted ONLY when the durable record is explicitly
 * 'automatic'. Any absence, invalid record, missing lock manager, or read error
 * resolves to `false`, so a manual/unknown/broken policy never triggers cost work.
 */
export async function isAutomaticCaptureAdmitted(): Promise<boolean> {
    try {
        return (await readDurableCaptureMode()) === 'automatic'
    } catch {
        return false
    }
}

export async function writeDurableCaptureMode(
    mode: IllustrationCaptureMode,
): Promise<IllustrationCaptureMode> {
    if (!isIllustrationCaptureMode(mode)) {
        throw new IllustrationLedgerValidationError('capture mode must be "manual" or "automatic"')
    }
    return await withIllustrationLedgerLock(async () => {
        const record: StoredCapturePolicyV1 = { protocolVersion: 1, mode }
        await writePersistentJson(ILLUSTRATION_CAPTURE_POLICY_KEY, record)
        return mode
    })
}

export async function getCapturePolicy(): Promise<{
    protocolVersion: 1
    capturePolicyContractVersion: 1
    mode: IllustrationCaptureMode
}> {
    return {
        protocolVersion: 1,
        capturePolicyContractVersion: ILLUSTRATION_CAPTURE_POLICY_CONTRACT_VERSION,
        mode: await readDurableCaptureMode(),
    }
}

export async function setCaptureMode(input: {
    protocolVersion: 1
    mode: IllustrationCaptureMode
}): Promise<{ protocolVersion: 1; mode: IllustrationCaptureMode }> {
    if (input.protocolVersion !== 1) {
        throw new IllustrationLedgerValidationError('protocolVersion must be 1')
    }
    const mode = await writeDurableCaptureMode(input.mode)
    return { protocolVersion: 1, mode }
}
