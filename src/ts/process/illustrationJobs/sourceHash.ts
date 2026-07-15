import { findRequestMarkers, findSlotNodes } from './controlNodes'
import { IllustrationLedgerValidationError } from './errors'

const INLAY_REFERENCE_RE = /\{\{inlay::([A-Za-z0-9_:-]{1,128})\}\}/g
const MAX_SOURCE_NORMALIZATION_PASSES = 32

export type SourceRevisionTurnContext = {
    requestNonce: string
    slotTokens: readonly string[]
    committedAssetIds: readonly string[]
}

export type InlayReferenceMatch = {
    start: number
    end: number
    assetId: string
}

export class IllustrationSourceNormalizationError extends IllustrationLedgerValidationError {
    readonly reason = 'iteration_limit' as const

    constructor() {
        super('Illustration source normalization exceeded the safe iteration limit')
    }
}

export function findInlayReferences(text: string): InlayReferenceMatch[] {
    return Array.from(text.matchAll(INLAY_REFERENCE_RE), (match) => ({
        start: match.index,
        end: match.index + match[0].length,
        assetId: match[1],
    }))
}

type SourceNormalizationSpan = { start: number; end: number }

function findSelectedSourceSpans(
    text: string,
    requestNonce: string,
    slotTokens: ReadonlySet<string>,
    committedAssetIds: ReadonlySet<string>,
): SourceNormalizationSpan[] {
    return [
        ...findRequestMarkers(text)
            .filter((marker) => marker.nonce === requestNonce),
        ...findSlotNodes(text)
            .filter((node) => slotTokens.has(node.slotToken)),
        ...findInlayReferences(text)
            .filter((inlay) => committedAssetIds.has(inlay.assetId)),
    ].sort((left, right) => left.start - right.start)
}

function removeSourceSpans(text: string, spans: readonly SourceNormalizationSpan[]): string {
    let cursor = 0
    let normalized = ''
    for (const span of spans) {
        normalized += text.slice(cursor, span.start)
        cursor = span.end
    }
    return normalized + text.slice(cursor)
}

export function normalizeSourceRevisionText(
    variantText: string,
    turnContext: SourceRevisionTurnContext,
): string {
    const slotTokens = new Set(turnContext.slotTokens)
    const committedAssetIds = new Set(turnContext.committedAssetIds)
    let normalized = variantText

    for (let pass = 0; pass < MAX_SOURCE_NORMALIZATION_PASSES; pass += 1) {
        const spans = findSelectedSourceSpans(
            normalized,
            turnContext.requestNonce,
            slotTokens,
            committedAssetIds,
        )
        if (spans.length === 0) return normalized
        normalized = removeSourceSpans(normalized, spans)
    }

    const remaining = findSelectedSourceSpans(
        normalized,
        turnContext.requestNonce,
        slotTokens,
        committedAssetIds,
    )
    if (remaining.length > 0) throw new IllustrationSourceNormalizationError()
    return normalized
}

export async function sha256Hex(value: string): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function computeSourceRevisionHash(
    variantText: string,
    turnContext: SourceRevisionTurnContext,
): Promise<string> {
    return sha256Hex(normalizeSourceRevisionText(variantText, turnContext))
}

export function hashesMatch(left: string, right: string): boolean {
    return left === right
}
