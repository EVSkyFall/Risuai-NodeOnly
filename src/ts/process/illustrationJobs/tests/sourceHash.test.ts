import { describe, expect, test } from 'vitest'
import { buildRequestMarker, buildSlotNode } from '../controlNodes'
import {
    computeSourceRevisionHash,
    findInlayReferences,
    hashesMatch,
    normalizeSourceRevisionText,
    sha256Hex,
} from '../sourceHash'

const context = {
    requestNonce: 'nonce_current',
    slotTokens: ['token_one', 'token_two'],
    committedAssetIds: ['asset_one', 'asset:123e4567-e89b-12d3-a456-426614174000'],
} as const

describe('normalized source revision hash', () => {
    test('is invariant when a turn slot becomes its committed native inlay', async () => {
        const marker = buildRequestMarker(context.requestNonce)
        const slotOne = buildSlotNode('job_one', 'token_one')
        const slotTwo = buildSlotNode('job_two', 'token_two')
        const before = `A${marker}B${slotOne}C${slotTwo}D`
        const after = `AB{{inlay::asset_one}}C${slotTwo}D`

        expect(await computeSourceRevisionHash(before, context))
            .toBe(await computeSourceRevisionHash(after, context))
    })

    test('is invariant to adding or removing this turn request marker', async () => {
        const marker = buildRequestMarker(context.requestNonce)
        expect(await computeSourceRevisionHash(`body${marker}`, context))
            .toBe(await computeSourceRevisionHash('body', context))
    })

    test('changes for every ordinary body edit', async () => {
        const original = await computeSourceRevisionHash('body', context)
        for (const edited of ['Body', 'body ', 'body\n', 'bo😀dy']) {
            expect(await computeSourceRevisionHash(edited, context)).not.toBe(original)
        }
    })

    test('preserves other turns markers, slots, and inlays', () => {
        const currentMarker = buildRequestMarker(context.requestNonce)
        const otherMarker = buildRequestMarker('nonce_other')
        const currentSlot = buildSlotNode('job_current', 'token_one')
        const otherSlot = buildSlotNode('job_other', 'token_other')
        const text = `a${currentMarker}b${otherMarker}c${currentSlot}d${otherSlot}e{{inlay::asset_one}}f{{inlay::asset_other}}g`

        expect(normalizeSourceRevisionText(text, context)).toBe(
            `ab${otherMarker}cd${otherSlot}ef{{inlay::asset_other}}g`,
        )
    })

    test('recognizes current colon-prefixed asset ids and enforces the bounded native-id grammar', () => {
        const accepted128 = 'a'.repeat(128)
        const rejected129 = 'b'.repeat(129)
        const colonId = context.committedAssetIds[1]
        const text = [
            `{{inlay::${accepted128}}}`,
            `{{inlay::${colonId}}}`,
            `{{inlay::${rejected129}}}`,
            '{{inlay::bad{id}}}',
            '{{inlay::bad}id}}',
        ].join('|')

        expect(findInlayReferences(text).map(({ assetId }) => assetId)).toEqual([accepted128, colonId])
        expect(normalizeSourceRevisionText(text, {
            ...context,
            committedAssetIds: [accepted128, colonId, rejected129, 'bad{id', 'bad}id'],
        })).toBe([
            '',
            '',
            `{{inlay::${rejected129}}}`,
            '{{inlay::bad{id}}}',
            '{{inlay::bad}id}}',
        ].join('|'))
    })

    test.each([
        [
            'outer inlay wrapper',
            (slot: string) => `A{{inlay::${slot}}}B`,
            'A{{inlay::{{inlay::asset_one}}}}B',
            'A{{inlay::}}B',
        ],
        [
            'inlay-prefix adjacency',
            (slot: string) => `A{{inlay::${slot}B`,
            'A{{inlay::{{inlay::asset_one}}B',
            'A{{inlay::B',
        ],
        [
            'closing-brace adjacency',
            (slot: string) => `A${slot}}}B`,
            'A{{inlay::asset_one}}}}B',
            'A}}B',
        ],
    ])('preserves slot-to-inlay invariance across %s', async (_, buildBefore, after, expected) => {
        const before = buildBefore(buildSlotNode('job_one', 'token_one'))

        expect(normalizeSourceRevisionText(before, context)).toBe(expected)
        expect(normalizeSourceRevisionText(after, context)).toBe(expected)
        expect(hashesMatch(
            await computeSourceRevisionHash(before, context),
            await computeSourceRevisionHash(after, context),
        )).toBe(true)
    })

    test('scans 300 KB of unterminated inlay prefixes without finding references', () => {
        const unit = '{{inlay::a'
        const malformed = unit.repeat(Math.ceil((300 * 1024) / unit.length)).slice(0, 300 * 1024)

        expect(findInlayReferences(malformed)).toEqual([])
        expect(normalizeSourceRevisionText(malformed, context)).toBe(malformed)
    })

    test('normalizes nested selected controls and inlays to a fixpoint', () => {
        const cases = [
            nestSelectedRequestMarkers(3),
            nestSelectedSlotNodes(3),
            nestSelectedInlays(3),
        ]

        for (const nested of cases) {
            const normalized = normalizeSourceRevisionText(`before${nested}after`, context)
            expect(normalized).toBe('beforeafter')
            expect(normalizeSourceRevisionText(normalized, context)).toBe(normalized)
        }
    })

    test('preserves newly exposed non-selected nodes byte-for-byte', () => {
        const currentMarker = buildRequestMarker(context.requestNonce)
        const currentInlay = '{{inlay::asset_one}}'
        const nestedMarker = `<!--risu-illustration-request:v1:nonce_${currentMarker}other-->`
        const nestedInlay = `{{inlay::asset_${currentInlay}other}}`
        const expectedMarker = buildRequestMarker('nonce_other')
        const expectedInlay = '{{inlay::asset_other}}'

        expect(normalizeSourceRevisionText(
            `a${nestedMarker}b${nestedInlay}c`,
            context,
        )).toBe(`a${expectedMarker}b${expectedInlay}c`)
    })

    test('allows exactly 32 normalization passes and fails closed at 33 levels', () => {
        expect(normalizeSourceRevisionText(nestSelectedRequestMarkers(32), context)).toBe('')

        const nested = nestSelectedRequestMarkers(33)
        const original = nested
        try {
            normalizeSourceRevisionText(nested, context)
            throw new Error('expected iteration-limit failure')
        } catch (error) {
            expect(error).toMatchObject({
                name: 'IllustrationSourceNormalizationError',
                code: 'validation_failed',
                reason: 'iteration_limit',
            })
        }
        expect(nested).toBe(original)
    })

    test('normalization is idempotent and duplicate context entries do not matter', () => {
        const marker = buildRequestMarker(context.requestNonce)
        const slot = buildSlotNode('job_one', 'token_one')
        const text = `\r\n${marker} alpha ${slot}\t{{inlay::asset_one}} omega\r\n`
        const duplicated = {
            requestNonce: context.requestNonce,
            slotTokens: ['token_one', 'token_one'],
            committedAssetIds: ['asset_one', 'asset_one'],
        }
        const normalized = normalizeSourceRevisionText(text, duplicated)

        expect(normalized).toBe('\r\n alpha \t omega\r\n')
        expect(normalizeSourceRevisionText(normalized, duplicated)).toBe(normalized)
        expect(context.slotTokens).toEqual(['token_one', 'token_two'])
        expect(context.committedAssetIds).toEqual([
            'asset_one',
            'asset:123e4567-e89b-12d3-a456-426614174000',
        ])
    })

    test('uses happy-dom WebCrypto SHA-256 and returns lowercase 64-hex', async () => {
        expect(globalThis.crypto?.subtle).toBeDefined()
        const hash = await sha256Hex('abc')
        expect(hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
        expect(hash).toMatch(/^[0-9a-f]{64}$/)
        expect(hashesMatch(hash, hash)).toBe(true)
        expect(hashesMatch(hash, `${hash.slice(0, -1)}0`)).toBe(false)
    })
})

function nestSelectedRequestMarkers(depth: number): string {
    let nested = buildRequestMarker(context.requestNonce)
    for (let level = 1; level < depth; level += 1) {
        nested = `<!--risu-illustration-request:v1:nonce_${nested}current-->`
    }
    return nested
}

function nestSelectedSlotNodes(depth: number): string {
    let nested = buildSlotNode('job_inner', 'token_one')
    for (let level = 1; level < depth; level += 1) {
        nested = '<risu-illustration-slot data-v="1" data-job="job_outer" data-token="token_'
            + nested
            + 'one"></risu-illustration-slot>'
    }
    return nested
}

function nestSelectedInlays(depth: number): string {
    let nested = '{{inlay::asset_one}}'
    for (let level = 1; level < depth; level += 1) {
        nested = `{{inlay::asset_${nested}one}}`
    }
    return nested
}
