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
