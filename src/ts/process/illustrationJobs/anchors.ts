import type { Chat, Message } from '../../storage/database.svelte'
import { IllustrationLedgerValidationError } from './errors'
import { findRequestMarkers, findSlotNodes } from './controlNodes'
import type { IllustrationTargetV1 } from './types'

export type SlotTextRange = {
    start: number
    end: number
    node: string
}

export type FoundSlotResolution = {
    kind: 'found'
    target: IllustrationTargetV1
    messageIndex: number
    activeSwipeIndex: number | null
    variant: 'active' | { swipeIndex: number }
    offsets: {
        data?: SlotTextRange
        swipe?: SlotTextRange & { swipeIndex: number }
    }
}

export type ResolveResult =
    | FoundSlotResolution
    | {
        kind: 'stale'
        reason: 'chat_not_hydrated' | 'conversation_mismatch' | 'message_missing' | 'message_fence' | 'slot_missing'
    }
    | {
        kind: 'corrupt'
        reason:
            | 'message_identity_collision'
            | 'invalid_swipe_state'
            | 'active_mirror_desync'
            | 'duplicate_slot'
            | 'multiple_logical_variants'
    }

export type SlotVariantPatch = {
    messageIndex: number
    data?: string
    swipe?: {
        swipeIndex: number
        text: string
    }
}

export type PlacementOffsetValidationReason =
    | 'non_integer'
    | 'out_of_range'
    | 'duplicate'
    | 'surrogate_split'
    | 'forbidden_zone'

export class IllustrationPlacementOffsetError extends IllustrationLedgerValidationError {
    readonly reason: PlacementOffsetValidationReason
    readonly offset: number

    constructor(reason: PlacementOffsetValidationReason, offset: number) {
        super(`Invalid illustration placement offset ${String(offset)}: ${reason}`)
        this.reason = reason
        this.offset = offset
    }
}

export class IllustrationAnchorPatchError extends IllustrationLedgerValidationError {
    readonly reason = 'resolution_mismatch' as const

    constructor() {
        super('Illustration slot resolution no longer matches the supplied chat')
    }
}

type InlaySpan = { start: number; end: number }

function findInlaySpans(text: string): InlaySpan[] {
    return Array.from(text.matchAll(/\{\{inlay::([A-Za-z0-9_:-]{1,128})\}\}/g), (match) => ({
        start: match.index,
        end: match.index + match[0].length,
    }))
}

function findTokenRanges(text: string, slotToken: string): SlotTextRange[] {
    return findSlotNodes(text)
        .filter((node) => node.slotToken === slotToken)
        .map((node) => ({
            start: node.start,
            end: node.end,
            node: text.slice(node.start, node.end),
        }))
}

function messageContainsToken(message: Message, slotToken: string): boolean {
    if (findTokenRanges(message.data, slotToken).length > 0) return true
    return message.swipes?.some((swipe) => findTokenRanges(swipe, slotToken).length > 0) ?? false
}

export function resolveSlotAnchor(chat: Chat, target: IllustrationTargetV1): ResolveResult {
    if (chat._placeholder || !chat.id) {
        return { kind: 'stale', reason: 'chat_not_hydrated' }
    }
    if (chat.id !== target.conversationId) {
        return { kind: 'stale', reason: 'conversation_mismatch' }
    }

    for (const message of chat.message) {
        if (message.chatId !== target.expectedMessageId && messageContainsToken(message, target.slotToken)) {
            return { kind: 'stale', reason: 'message_fence' }
        }
    }

    const containerIndexes: number[] = []
    for (let index = 0; index < chat.message.length; index += 1) {
        if (chat.message[index].chatId === target.expectedMessageId) containerIndexes.push(index)
    }
    if (containerIndexes.length === 0) {
        return { kind: 'stale', reason: 'message_missing' }
    }
    if (containerIndexes.length > 1) {
        return { kind: 'corrupt', reason: 'message_identity_collision' }
    }

    const messageIndex = containerIndexes[0]
    const message = chat.message[messageIndex]
    const dataMatches = findTokenRanges(message.data, target.slotToken)

    if (message.swipes === undefined) {
        if (dataMatches.length === 0) return { kind: 'stale', reason: 'slot_missing' }
        if (dataMatches.length > 1) return { kind: 'corrupt', reason: 'duplicate_slot' }
        return {
            kind: 'found',
            target: { ...target },
            messageIndex,
            activeSwipeIndex: null,
            variant: 'active',
            offsets: { data: dataMatches[0] },
        }
    }

    if (
        message.swipes.length === 0
        || !Number.isSafeInteger(message.swipeId)
        || message.swipeId < 0
        || message.swipeId >= message.swipes.length
    ) {
        return { kind: 'corrupt', reason: 'invalid_swipe_state' }
    }

    const activeSwipeIndex = message.swipeId
    const swipeMatches = message.swipes.map((swipe) => findTokenRanges(swipe, target.slotToken))
    const activeMatches = swipeMatches[activeSwipeIndex]
    const activeHasMatch = dataMatches.length > 0 || activeMatches.length > 0

    if (activeHasMatch) {
        if (dataMatches.length !== 1 || activeMatches.length !== 1) {
            const oneSided = dataMatches.length === 0 || activeMatches.length === 0
            return { kind: 'corrupt', reason: oneSided ? 'active_mirror_desync' : 'duplicate_slot' }
        }
        if (message.data !== message.swipes[activeSwipeIndex]) {
            return { kind: 'corrupt', reason: 'active_mirror_desync' }
        }
    }

    const inactiveMatches: Array<{ swipeIndex: number; range: SlotTextRange }> = []
    for (let swipeIndex = 0; swipeIndex < swipeMatches.length; swipeIndex += 1) {
        if (swipeIndex === activeSwipeIndex) continue
        const matches = swipeMatches[swipeIndex]
        if (matches.length > 1) return { kind: 'corrupt', reason: 'duplicate_slot' }
        if (matches.length === 1) inactiveMatches.push({ swipeIndex, range: matches[0] })
    }

    const logicalMatchCount = (activeHasMatch ? 1 : 0) + inactiveMatches.length
    if (logicalMatchCount === 0) return { kind: 'stale', reason: 'slot_missing' }
    if (logicalMatchCount > 1) return { kind: 'corrupt', reason: 'multiple_logical_variants' }

    if (activeHasMatch) {
        return {
            kind: 'found',
            target: { ...target },
            messageIndex,
            activeSwipeIndex,
            variant: 'active',
            offsets: {
                data: dataMatches[0],
                swipe: { ...activeMatches[0], swipeIndex: activeSwipeIndex },
            },
        }
    }

    const inactive = inactiveMatches[0]
    return {
        kind: 'found',
        target: { ...target },
        messageIndex,
        activeSwipeIndex,
        variant: { swipeIndex: inactive.swipeIndex },
        offsets: {
            swipe: { ...inactive.range, swipeIndex: inactive.swipeIndex },
        },
    }
}

function replaceResolvedRange(source: string, range: SlotTextRange, replacement: string): string {
    if (source.slice(range.start, range.end) !== range.node) {
        throw new IllustrationAnchorPatchError()
    }
    return source.slice(0, range.start) + replacement + source.slice(range.end)
}

export function patchSlotInVariant(
    chat: Chat,
    resolution: FoundSlotResolution,
    replacement: string,
): SlotVariantPatch {
    const currentResolution = resolveSlotAnchor(chat, resolution.target)
    if (currentResolution.kind !== 'found' || !sameResolutionLocation(resolution, currentResolution)) {
        throw new IllustrationAnchorPatchError()
    }

    const message = chat.message[currentResolution.messageIndex]
    if (!message) throw new IllustrationAnchorPatchError()

    const patch: SlotVariantPatch = { messageIndex: currentResolution.messageIndex }
    if (currentResolution.offsets.data) {
        patch.data = replaceResolvedRange(message.data, currentResolution.offsets.data, replacement)
    }
    if (currentResolution.offsets.swipe) {
        const { swipeIndex, ...range } = currentResolution.offsets.swipe
        const swipe = message.swipes?.[swipeIndex]
        if (swipe === undefined) throw new IllustrationAnchorPatchError()
        patch.swipe = {
            swipeIndex,
            text: replaceResolvedRange(swipe, range, replacement),
        }
    }
    return patch
}

function sameResolutionLocation(left: FoundSlotResolution, right: FoundSlotResolution): boolean {
    if (
        left.messageIndex !== right.messageIndex
        || left.activeSwipeIndex !== right.activeSwipeIndex
        || !sameVariant(left.variant, right.variant)
    ) {
        return false
    }
    return sameRange(left.offsets.data, right.offsets.data)
        && sameRange(left.offsets.swipe, right.offsets.swipe)
}

function sameVariant(
    left: FoundSlotResolution['variant'],
    right: FoundSlotResolution['variant'],
): boolean {
    if (left === 'active' || right === 'active') return left === right
    return left.swipeIndex === right.swipeIndex
}

function sameRange(
    left: SlotTextRange | undefined,
    right: SlotTextRange | undefined,
): boolean {
    if (!left || !right) return left === right
    const leftSwipeIndex = 'swipeIndex' in left ? left.swipeIndex : undefined
    const rightSwipeIndex = 'swipeIndex' in right ? right.swipeIndex : undefined
    return left.start === right.start
        && left.end === right.end
        && left.node === right.node
        && leftSwipeIndex === rightSwipeIndex
}

export function validatePlacementOffsets(sourceTextUtf16: string, offsets: number[]): number[] {
    const seen = new Set<number>()
    const forbiddenSpans = [
        ...findRequestMarkers(sourceTextUtf16).map(({ start, end }) => ({ start, end })),
        ...findSlotNodes(sourceTextUtf16).map(({ start, end }) => ({ start, end })),
        ...findInlaySpans(sourceTextUtf16),
    ]

    for (const offset of offsets) {
        if (!Number.isSafeInteger(offset)) {
            throw new IllustrationPlacementOffsetError('non_integer', offset)
        }
        if (offset < 0 || offset > sourceTextUtf16.length) {
            throw new IllustrationPlacementOffsetError('out_of_range', offset)
        }
        if (seen.has(offset)) {
            throw new IllustrationPlacementOffsetError('duplicate', offset)
        }
        seen.add(offset)

        if (
            offset > 0
            && offset < sourceTextUtf16.length
            && sourceTextUtf16.charCodeAt(offset - 1) >= 0xD800
            && sourceTextUtf16.charCodeAt(offset - 1) <= 0xDBFF
            && sourceTextUtf16.charCodeAt(offset) >= 0xDC00
            && sourceTextUtf16.charCodeAt(offset) <= 0xDFFF
        ) {
            throw new IllustrationPlacementOffsetError('surrogate_split', offset)
        }
        if (forbiddenSpans.some((span) => span.start < offset && offset < span.end)) {
            throw new IllustrationPlacementOffsetError('forbidden_zone', offset)
        }
    }

    return [...offsets].sort((left, right) => right - left)
}
