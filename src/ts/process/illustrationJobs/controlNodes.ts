import { IllustrationLedgerValidationError } from './errors'

const CONTROL_IDENTIFIER = '[A-Za-z0-9_-]+'
const CONTROL_IDENTIFIER_RE = /^[A-Za-z0-9_-]+$/
const REQUEST_MARKER_PREFIX = '<!--risu-illustration-request:v1:'
const SLOT_NODE_PREFIX = '<risu-illustration-slot '
const REQUEST_MARKER_RE = new RegExp(`<!--risu-illustration-request:v1:(${CONTROL_IDENTIFIER})-->`, 'g')
const SLOT_NODE_RE = new RegExp(
    `<risu-illustration-slot data-v="1" data-job="(${CONTROL_IDENTIFIER})" data-token="(${CONTROL_IDENTIFIER})"></risu-illustration-slot>`,
    'g',
)
const MAX_CONTROL_NODE_STRIP_PASSES = 32

export type ControlNodeField = 'nonce' | 'jobId' | 'slotToken'

export class IllustrationControlNodeValidationError extends IllustrationLedgerValidationError {
    readonly reason = 'invalid_charset' as const
    readonly field: ControlNodeField

    constructor(field: ControlNodeField) {
        super(`Illustration control-node ${field} must be a non-empty [A-Za-z0-9_-]+ identifier`)
        this.field = field
    }
}

export class IllustrationControlNodeStripError extends IllustrationLedgerValidationError {
    readonly reason = 'iteration_limit' as const

    constructor() {
        super('Illustration control-node stripping exceeded the safe iteration limit')
    }
}

export type RequestMarkerMatch = {
    start: number
    end: number
    nonce: string
}

export type SlotNodeMatch = {
    start: number
    end: number
    jobId: string
    slotToken: string
}

function assertControlIdentifier(value: string, field: ControlNodeField): void {
    if (typeof value !== 'string' || !CONTROL_IDENTIFIER_RE.test(value)) {
        throw new IllustrationControlNodeValidationError(field)
    }
}

export function buildRequestMarker(nonce: string): string {
    assertControlIdentifier(nonce, 'nonce')
    return `<!--risu-illustration-request:v1:${nonce}-->`
}

/**
 * Appends the v1 request marker so it always begins on its own line. If the
 * target text already ends with exactly U+000A the marker is appended verbatim;
 * otherwise exactly one U+000A is injected first. No trim, CRLF conversion, or
 * Unicode-newline normalization is performed, and the marker bytes are unchanged
 * — only line-boundary framing is added. An empty target yields `\n` + marker.
 *
 * The marker grammar is unchanged; this is purely the serialization boundary the
 * core owns so downstream RisuAI regex/markdown never sees the marker fused to the
 * body's last code unit (e.g. a closing ``` fence).
 */
export function appendRequestMarkerAtLineBoundary(text: string, nonce: string): string {
    const marker = buildRequestMarker(nonce)
    return text.endsWith('\n') ? `${text}${marker}` : `${text}\n${marker}`
}

export function buildSlotNode(jobId: string, slotToken: string): string {
    assertControlIdentifier(jobId, 'jobId')
    assertControlIdentifier(slotToken, 'slotToken')
    return `<risu-illustration-slot data-v="1" data-job="${jobId}" data-token="${slotToken}"></risu-illustration-slot>`
}

export function findRequestMarkers(text: string): RequestMarkerMatch[] {
    return Array.from(text.matchAll(REQUEST_MARKER_RE), (match) => ({
        start: match.index,
        end: match.index + match[0].length,
        nonce: match[1],
    }))
}

/**
 * Restores the canonical captured source from raw marked text, given the durable
 * `expectedSourceTextUtf16`. The stored marked text is ambiguous by shape alone:
 * a legacy source-owned trailing LF (`body\n` + adjacent marker) and a new
 * source `body` + an injected LF + marker serialize identically. The durable
 * source is the only authority that disambiguates them.
 *
 * Candidate 1 removes only the marker span; if it matches the durable source
 * exactly (byte/code-unit) it is canonical — this preserves legacy adjacent-marker
 * turns and any source that genuinely owns its trailing LF. Candidate 2 is tried
 * only when candidate 1 mismatches AND the char immediately before the marker is
 * exactly U+000A: it additionally removes that one injected LF. If neither matches,
 * the source is no longer canonical (returns null); callers must NOT hash the raw
 * marked text or guess — they take the existing stale/corrupt path.
 */
export function restoreExpectedCapturedSource(
    raw: string,
    marker: { start: number; end: number },
    expectedSourceTextUtf16: string,
): string | null {
    const markerOnly = raw.slice(0, marker.start) + raw.slice(marker.end)
    if (markerOnly === expectedSourceTextUtf16) return markerOnly

    if (marker.start > 0 && raw[marker.start - 1] === '\n') {
        const withInjectedLfRemoved = raw.slice(0, marker.start - 1) + raw.slice(marker.end)
        if (withInjectedLfRemoved === expectedSourceTextUtf16) return withInjectedLfRemoved
    }
    return null
}

export function findSlotNodes(text: string): SlotNodeMatch[] {
    return Array.from(text.matchAll(SLOT_NODE_RE), (match) => ({
        start: match.index,
        end: match.index + match[0].length,
        jobId: match[1],
        slotToken: match[2],
    }))
}

function findControlNodeSpans(text: string): { start: number; end: number }[] {
    return [
        ...findRequestMarkers(text).map(({ start, end }) => ({ start, end })),
        ...findSlotNodes(text).map(({ start, end }) => ({ start, end })),
    ].sort((left, right) => left.start - right.start)
}

function removeSpans(text: string, spans: readonly { start: number; end: number }[]): string {
    let cursor = 0
    let stripped = ''
    for (const span of spans) {
        stripped += text.slice(cursor, span.start)
        cursor = span.end
    }
    return stripped + text.slice(cursor)
}

export function containsIllustrationControlNodes(text: string): boolean {
    return text.includes(REQUEST_MARKER_PREFIX) || text.includes(SLOT_NODE_PREFIX)
}

export function stripIllustrationControlNodes(text: string): string {
    if (!containsIllustrationControlNodes(text)) return text
    let stripped = text

    for (let pass = 0; pass < MAX_CONTROL_NODE_STRIP_PASSES; pass += 1) {
        const spans = findControlNodeSpans(stripped)
        if (spans.length === 0) return stripped
        stripped = removeSpans(stripped, spans)
    }

    const spans = [
        ...findRequestMarkers(stripped),
        ...findSlotNodes(stripped),
    ]
    if (spans.length > 0) throw new IllustrationControlNodeStripError()
    return stripped
}

export function stripIllustrationControlNodesFromPrompt<T extends { content: string }>(
    messages: T[],
): T[] {
    let changed = false
    const stripped = messages.map((message) => {
        const content = stripIllustrationControlNodes(message.content)
        if (content === message.content) return message
        changed = true
        return { ...message, content }
    })
    return changed ? stripped : messages
}
