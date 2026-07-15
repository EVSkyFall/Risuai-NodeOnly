import { describe, expect, test } from 'vitest'
import type { Chat, Message } from '../../../storage/database.svelte'
import {
    IllustrationAnchorPatchError,
    IllustrationPlacementOffsetError,
    patchSlotInVariant,
    resolveSlotAnchor,
    validatePlacementOffsets,
} from '../anchors'
import type { FoundSlotResolution } from '../anchors'
import { buildRequestMarker, buildSlotNode, findRequestMarkers, findSlotNodes } from '../controlNodes'
import type { IllustrationTargetV1 } from '../types'

const SLOT_TOKEN = 'token_anchor'
const SLOT = buildSlotNode('job_anchor', SLOT_TOKEN)

function message(data: string, options: Partial<Message> = {}): Message {
    return { role: 'char', data, chatId: 'message_expected', ...options }
}

function chat(messages: Message[]): Chat {
    return {
        id: 'conversation_expected',
        message: messages,
        note: '',
        name: '',
        localLore: [],
    }
}

function target(overrides: Partial<IllustrationTargetV1> = {}): IllustrationTargetV1 {
    return {
        chaId: 'character_expected',
        conversationId: 'conversation_expected',
        expectedMessageId: 'message_expected',
        rootTurnId: 'turn_expected',
        requestNonce: 'nonce_expected',
        slotToken: SLOT_TOKEN,
        capturedSwipeHint: 0,
        sourceRevisionHash: 'hash_expected',
        ...overrides,
    }
}

function requireFound(result: ReturnType<typeof resolveSlotAnchor>): FoundSlotResolution {
    expect(result.kind).toBe('found')
    if (result.kind !== 'found') throw new Error(`expected found, received ${result.kind}`)
    return result
}

describe('resolveSlotAnchor', () => {
    test('coalesces the active data/swipe mirror into one logical variant', () => {
        const active = `😀before${SLOT}after`
        const result = requireFound(resolveSlotAnchor(chat([
            message(active, { swipes: ['inactive', active], swipeId: 1 }),
        ]), target()))

        expect(result.variant).toBe('active')
        expect(result.activeSwipeIndex).toBe(1)
        expect(result.offsets.data).toMatchObject({
            start: '😀before'.length,
            end: '😀before'.length + SLOT.length,
            node: SLOT,
        })
        expect(result.offsets.swipe).toEqual({
            start: '😀before'.length,
            end: '😀before'.length + SLOT.length,
            node: SLOT,
            swipeIndex: 1,
        })
    })

    test('resolves an inactive swipe without trusting the captured hint', () => {
        const result = requireFound(resolveSlotAnchor(chat([
            message('active', { swipes: [`inactive ${SLOT}`, 'active', 'other'], swipeId: 1 }),
        ]), target({ capturedSwipeHint: 2 })))

        expect(result.variant).toEqual({ swipeIndex: 0 })
        expect(result.offsets.data).toBeUndefined()
        expect(result.offsets.swipe?.swipeIndex).toBe(0)
    })

    test('still finds the exact-token variant after swipe indices shift', () => {
        const shifted = chat([
            message('active', { swipes: [`moved ${SLOT}`, 'active'], swipeId: 1 }),
        ])
        const result = requireFound(resolveSlotAnchor(shifted, target({ capturedSwipeHint: 2 })))
        expect(result.variant).toEqual({ swipeIndex: 0 })
    })

    test('treats an absent token and a raw token literal as stale', () => {
        expect(resolveSlotAnchor(chat([message('plain body')]), target()))
            .toEqual({ kind: 'stale', reason: 'slot_missing' })
        expect(resolveSlotAnchor(chat([message(`literal ${SLOT_TOKEN} only`)]), target()))
            .toEqual({ kind: 'stale', reason: 'slot_missing' })
    })

    test('treats the same token in distinct logical swipes as corrupt', () => {
        const result = resolveSlotAnchor(chat([
            message('active', { swipes: [`one ${SLOT}`, 'active', `two ${SLOT}`], swipeId: 1 }),
        ]), target())
        expect(result).toEqual({ kind: 'corrupt', reason: 'multiple_logical_variants' })
    })

    test('treats duplicate slot nodes inside one physical variant as corrupt', () => {
        const result = resolveSlotAnchor(chat([message(`${SLOT} middle ${SLOT}`)]), target())
        expect(result).toEqual({ kind: 'corrupt', reason: 'duplicate_slot' })
    })

    test('gives the foreign-message fence priority even when the expected message also has the token', () => {
        const result = resolveSlotAnchor(chat([
            message(`expected ${SLOT}`),
            message(`copied ${SLOT}`, { chatId: 'message_new' }),
        ]), target())
        expect(result).toEqual({ kind: 'stale', reason: 'message_fence' })
    })

    test('classifies a token found only under another Message.chatId as stale', () => {
        const result = resolveSlotAnchor(chat([
            message('expected without slot'),
            message(`rerolled ${SLOT}`, { chatId: 'message_new' }),
        ]), target())
        expect(result).toEqual({ kind: 'stale', reason: 'message_fence' })
    })

    test.each([
        ['data only', `${SLOT}`, 'active'],
        ['active swipe only', 'active', `${SLOT}`],
        ['both present but unequal', `left ${SLOT}`, `right ${SLOT}`],
    ])('fails closed on active mirror desync: %s', (_label, data, activeSwipe) => {
        const result = resolveSlotAnchor(chat([
            message(data, { swipes: [activeSwipe], swipeId: 0 }),
        ]), target())
        expect(result).toEqual({ kind: 'corrupt', reason: 'active_mirror_desync' })
    })

    test.each([
        ['missing', undefined, [`active ${SLOT}`]],
        ['negative', -1, [`active ${SLOT}`]],
        ['fractional', 0.5, [`active ${SLOT}`]],
        ['out of range', 1, [`active ${SLOT}`]],
        ['empty array', undefined, []],
    ])('rejects %s swipe state, regardless of hint', (_label, swipeId, swipes) => {
        const result = resolveSlotAnchor(chat([
            message(`active ${SLOT}`, { swipes, swipeId }),
        ]), target({ capturedSwipeHint: 0 }))
        expect(result).toEqual({ kind: 'corrupt', reason: 'invalid_swipe_state' })
    })

    test('supports a data-only active variant when swipes are absent', () => {
        const result = requireFound(resolveSlotAnchor(chat([message(`plain ${SLOT}`)]), target()))
        expect(result.variant).toBe('active')
        expect(result.activeSwipeIndex).toBeNull()
        expect(result.offsets.swipe).toBeUndefined()
    })

    test('fails stale on a conversation mismatch or placeholder chat', () => {
        expect(resolveSlotAnchor({ ...chat([message(SLOT)]), id: 'other' }, target()))
            .toEqual({ kind: 'stale', reason: 'conversation_mismatch' })
        expect(resolveSlotAnchor({ ...chat([message(SLOT)]), _placeholder: true }, target()))
            .toEqual({ kind: 'stale', reason: 'chat_not_hydrated' })
    })
})

describe('patchSlotInVariant', () => {
    test('returns coordinated active data and swipe writes without mutating the chat', () => {
        const active = `before ${SLOT} after`
        const source = chat([message(active, { swipes: ['other', active], swipeId: 1 })])
        const snapshot = JSON.parse(JSON.stringify(source))
        const resolution = requireFound(resolveSlotAnchor(source, target()))
        const replacement = '{{inlay::asset-active}}'

        expect(patchSlotInVariant(source, resolution, replacement)).toEqual({
            messageIndex: 0,
            data: `before ${replacement} after`,
            swipe: { swipeIndex: 1, text: `before ${replacement} after` },
        })
        expect(source).toEqual(snapshot)
    })

    test('returns only the inactive swipe write and leaves all source variants untouched', () => {
        const source = chat([
            message('active', { swipes: ['other', `inactive ${SLOT}`, 'active'], swipeId: 2 }),
        ])
        const snapshot = JSON.parse(JSON.stringify(source))
        const resolution = requireFound(resolveSlotAnchor(source, target()))

        expect(patchSlotInVariant(source, resolution, 'replacement')).toEqual({
            messageIndex: 0,
            swipe: { swipeIndex: 1, text: 'inactive replacement' },
        })
        expect(source).toEqual(snapshot)
    })

    test('rejects a resolution whose source text changed', () => {
        const source = chat([message(`before ${SLOT}`)])
        const resolution = requireFound(resolveSlotAnchor(source, target()))
        const changed = chat([message(`changed before ${SLOT}`)])
        expect(() => patchSlotInVariant(changed, resolution, 'replacement'))
            .toThrow(IllustrationAnchorPatchError)
    })

    test('rejects active mirror desync outside an otherwise unchanged slot range', () => {
        const active = `before ${SLOT} suffix`
        const source = chat([message(active, { swipes: [active], swipeId: 0 })])
        const resolution = requireFound(resolveSlotAnchor(source, target()))
        const changed = chat([
            message(`before ${SLOT} changed`, { swipes: [active], swipeId: 0 }),
        ])

        expect(() => patchSlotInVariant(changed, resolution, 'replacement'))
            .toThrow(IllustrationAnchorPatchError)
    })

    test('rejects a resolution whose swipe changed from inactive to active', () => {
        const source = chat([
            message('active', { swipes: [`inactive ${SLOT}`, 'active'], swipeId: 1 }),
        ])
        const resolution = requireFound(resolveSlotAnchor(source, target()))
        const changed = chat([
            message(`inactive ${SLOT}`, { swipes: [`inactive ${SLOT}`, 'active'], swipeId: 0 }),
        ])

        expect(() => patchSlotInVariant(changed, resolution, 'replacement'))
            .toThrow(IllustrationAnchorPatchError)
    })
})

describe('validatePlacementOffsets', () => {
    test('returns a descending copy without mutating the input', () => {
        const offsets = [0, 3, 1]
        expect(validatePlacementOffsets('abc', offsets)).toEqual([3, 1, 0])
        expect(offsets).toEqual([0, 3, 1])
    })

    test.each([Number.NaN, 1.5, Number.POSITIVE_INFINITY])('rejects non-integer offset %s', (offset) => {
        expectOffsetError('abc', [offset], 'non_integer')
    })

    test.each([-1, 4])('rejects out-of-range offset %s', (offset) => {
        expectOffsetError('abc', [offset], 'out_of_range')
    })

    test('allows duplicate offsets for manifest-order tie breaking', () => {
        expect(validatePlacementOffsets('abc', [1, 1])).toEqual([1, 1])
    })

    test('rejects offsets that split a UTF-16 surrogate pair', () => {
        expectOffsetError('A😀B', [2], 'surrogate_split')
        expect(validatePlacementOffsets('A😀B', [1, 3])).toEqual([3, 1])
    })

    test('rejects strict control/inlay interiors but allows every exact boundary', () => {
        const marker = buildRequestMarker('nonce_zone')
        const slot = buildSlotNode('job_zone', 'token_zone')
        const inlay = '{{inlay::asset:123e4567-e89b-12d3-a456-426614174000}}'
        const text = `a${marker}b${slot}c${inlay}d`
        const markerSpan = findRequestMarkers(text)[0]
        const slotSpan = findSlotNodes(text)[0]
        const inlayStart = text.indexOf(inlay)
        const inlayEnd = inlayStart + inlay.length

        for (const interior of [markerSpan.start + 1, slotSpan.start + 1, inlayStart + 1]) {
            expectOffsetError(text, [interior], 'forbidden_zone')
        }

        const boundaries = [
            markerSpan.start,
            markerSpan.end,
            slotSpan.start,
            slotSpan.end,
            inlayStart,
            inlayEnd,
        ]
        expect(validatePlacementOffsets(text, boundaries)).toEqual([...boundaries].sort((a, b) => b - a))
    })

    test('enforces the bounded native inlay-id grammar for forbidden zones', () => {
        const accepted = [
            'a'.repeat(128),
            'asset:123e4567-e89b-12d3-a456-426614174000',
        ]
        const rejected = [
            'b'.repeat(129),
            'bad{id',
            'bad}id',
        ]

        for (const assetId of accepted) {
            expectOffsetError(`{{inlay::${assetId}}}`, [1], 'forbidden_zone')
        }
        for (const assetId of rejected) {
            const lookalike = `{{inlay::${assetId}}}`
            expect(validatePlacementOffsets(lookalike, [1])).toEqual([1])
        }
    })

    test('scans 300 KB of unterminated inlay prefixes without creating forbidden zones', () => {
        const unit = '{{inlay::a'
        const malformed = unit.repeat(Math.ceil((300 * 1024) / unit.length)).slice(0, 300 * 1024)

        expect(validatePlacementOffsets(malformed, [0, malformed.length]))
            .toEqual([malformed.length, 0])
    })

    test('treats malformed lookalikes as inert text', () => {
        const text = 'x<!--risu-illustration-request:v1:bad!nonce-->y{{inlay::broken'
        expect(validatePlacementOffsets(text, [2, text.length - 1])).toEqual([text.length - 1, 2])
    })

    test('allows control-node boundaries adjacent to surrogate pairs', () => {
        const marker = buildRequestMarker('nonce_surrogate')
        const text = `😀${marker}😀`
        const span = findRequestMarkers(text)[0]
        expect(validatePlacementOffsets(text, [span.start, span.end])).toEqual([span.end, span.start])
        expectOffsetError(text, [1], 'surrogate_split')
    })
})

function expectOffsetError(
    source: string,
    offsets: number[],
    reason: IllustrationPlacementOffsetError['reason'],
): void {
    try {
        validatePlacementOffsets(source, offsets)
        throw new Error('expected validation failure')
    } catch (error) {
        expect(error).toBeInstanceOf(IllustrationPlacementOffsetError)
        expect(error).toMatchObject({ reason })
    }
}
