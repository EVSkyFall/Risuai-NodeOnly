import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import {
    IllustrationControlNodeValidationError,
    buildRequestMarker,
    buildSlotNode,
    containsIllustrationControlNodes,
    findRequestMarkers,
    findSlotNodes,
    stripIllustrationControlNodes,
    stripIllustrationControlNodesFromPrompt,
} from '../controlNodes'

describe('illustration control nodes', () => {
    test('builds and parses the exact request-marker grammar with UTF-16 ranges', () => {
        const marker = buildRequestMarker('nonce_ABC-123')
        const text = `😀before${marker}after`

        expect(marker).toBe('<!--risu-illustration-request:v1:nonce_ABC-123-->')
        expect(findRequestMarkers(text)).toEqual([{
            start: '😀before'.length,
            end: '😀before'.length + marker.length,
            nonce: 'nonce_ABC-123',
        }])
    })

    test('builds and parses the exact slot-node grammar', () => {
        const slot = buildSlotNode('job_1-A', 'token_2-B')
        expect(slot).toBe(
            '<risu-illustration-slot data-v="1" data-job="job_1-A" data-token="token_2-B"></risu-illustration-slot>',
        )
        expect(findSlotNodes(`x${slot}y`)).toEqual([{
            start: 1,
            end: 1 + slot.length,
            jobId: 'job_1-A',
            slotToken: 'token_2-B',
        }])
    })

    test.each([
        '<!--risu-illustration-request:v1:nonce',
        '<!-- risu-illustration-request:v1:nonce -->',
        '<!--risu-illustration-request:v2:nonce-->',
        '<!--risu-illustration-request:v1:bad!nonce-->',
        '<!--risu-illustration-request:v1:-->',
    ])('does not match malformed request lookalike %s', (lookalike) => {
        expect(findRequestMarkers(lookalike)).toEqual([])
    })

    test.each([
        '<risu-illustration-slot data-v="1" data-job="job" data-token="token">',
        '<risu-illustration-slot data-job="job" data-v="1" data-token="token"></risu-illustration-slot>',
        '<risu-illustration-slot data-v="2" data-job="job" data-token="token"></risu-illustration-slot>',
        '<risu-illustration-slot data-v="1" data-job="job" data-token="bad!token"></risu-illustration-slot>',
        '<risu-illustration-slot data-v="1" data-job="job" data-token="token" data-token="again"></risu-illustration-slot>',
        '<risu-illustration-slot data-v="1" data-job="job" data-token="token">child</risu-illustration-slot>',
        '<risu-illustration-slot data-v="1" data-job="job" data-token="token"/>',
    ])('does not match malformed slot lookalike %s', (lookalike) => {
        expect(findSlotNodes(lookalike)).toEqual([])
    })

    test('strips every well-formed node, preserves malformed text, and is idempotent', () => {
        const markerA = buildRequestMarker('nonce_a')
        const markerB = buildRequestMarker('nonce_b')
        const slotA = buildSlotNode('job_a', 'token_a')
        const slotB = buildSlotNode('job_b', 'token_b')
        const malformed = '<!--risu-illustration-request:v1:bad!nonce-->'
        const text = `A\r\n${markerA} B ${slotA}\t${malformed}${markerB}${slotB} Z`
        const expected = `A\r\n B \t${malformed} Z`

        const stripped = stripIllustrationControlNodes(text)
        expect(stripped).toBe(expected)
        expect(stripIllustrationControlNodes(stripped)).toBe(expected)
    })

    test('uses fixed prefixes to bypass node-free text', () => {
        expect(containsIllustrationControlNodes('ordinary text\r\nwith <unrelated> markup'))
            .toBe(false)
        expect(containsIllustrationControlNodes(buildRequestMarker('nonce_fast'))).toBe(true)
        expect(containsIllustrationControlNodes(buildSlotNode('job_fast', 'token_fast'))).toBe(true)
    })

    test('strips prompt message copies without mutating inputs and preserves the no-node fast path', () => {
        const marker = buildRequestMarker('nonce_prompt')
        const slot = buildSlotNode('job_prompt', 'token_prompt')
        const original = [{
            role: 'assistant' as const,
            content: `before\r\n${marker}middle${slot}\tafter`,
            memo: 'message-1',
        }]

        const stripped = stripIllustrationControlNodesFromPrompt(original)

        expect(stripped).not.toBe(original)
        expect(stripped[0]).not.toBe(original[0])
        expect(stripped[0]).toEqual({
            role: 'assistant',
            content: 'before\r\nmiddle\tafter',
            memo: 'message-1',
        })
        expect(original[0].content).toBe(`before\r\n${marker}middle${slot}\tafter`)

        const nodeFree = [{ role: 'user' as const, content: 'unchanged\r\nbytes' }]
        expect(stripIllustrationControlNodesFromPrompt(nodeFree)).toBe(nodeFree)
        expect(stripIllustrationControlNodesFromPrompt(nodeFree)[0]).toBe(nodeFree[0])
    })

    test.each([
        [
            'request marker',
            '<!--risu-illustration-request:v1:A<!--risu-illustration-request:v1:B-->C-->',
        ],
        [
            'slot node',
            '<risu-illustration-slot data-v="1" data-job="outer" data-token="T'
                + '<risu-illustration-slot data-v="1" data-job="inner" data-token="I"></risu-illustration-slot>'
                + 'U"></risu-illustration-slot>',
        ],
    ])('re-scans after stripping a nested %s that synthesizes a valid outer node', (_, nested) => {
        const stripped = stripIllustrationControlNodes(`before${nested}after`)

        expect(stripped).toBe('beforeafter')
        expect(findRequestMarkers(stripped)).toEqual([])
        expect(findSlotNodes(stripped)).toEqual([])
        expect(stripIllustrationControlNodes(stripped)).toBe(stripped)
    })

    test.each([
        ['request markers', nestRequestMarkers(3)],
        ['slot nodes', nestSlotNodes(3)],
    ])('removes three levels of nested %s without changing surrounding text', (_, nested) => {
        const stripped = stripIllustrationControlNodes(`\r\nprefix${nested}suffix\t`)

        expect(stripped).toBe('\r\nprefixsuffix\t')
        expect(findRequestMarkers(stripped)).toEqual([])
        expect(findSlotNodes(stripped)).toEqual([])
    })

    test('allows exactly 32 shrinking passes and fails closed at 33 levels', () => {
        expect(stripIllustrationControlNodes(nestRequestMarkers(32))).toBe('')

        const nested = nestRequestMarkers(33)
        const original = nested
        try {
            stripIllustrationControlNodes(nested)
            throw new Error('expected iteration-limit failure')
        } catch (error) {
            expect(error).toMatchObject({
                name: 'IllustrationControlNodeStripError',
                code: 'validation_failed',
                reason: 'iteration_limit',
            })
        }
        expect(nested).toBe(original)
    })

    test('byte-preserves arbitrary surrounding text', () => {
        const safeSurrounding = fc.string().filter((value) => (
            !value.includes('<!--risu-illustration-request:')
            && !value.includes('<risu-illustration-slot')
        ))
        const marker = buildRequestMarker('nonce_property')
        const slot = buildSlotNode('job_property', 'token_property')

        fc.assert(fc.property(
            safeSurrounding,
            safeSurrounding,
            safeSurrounding,
            (prefix, middle, suffix) => {
                expect(stripIllustrationControlNodes(`${prefix}${marker}${middle}${slot}${suffix}`))
                    .toBe(`${prefix}${middle}${suffix}`)
            },
        ), { numRuns: 100 })
    })

    test('always reaches a node-free idempotent fixpoint for bounded randomized concatenations', () => {
        const safeFragment = fc.string({ maxLength: 24 }).filter((value) => (
            !value.includes('<!--risu-illustration-request:')
            && !value.includes('<risu-illustration-slot')
        ))
        const piece = fc.oneof(
            safeFragment,
            fc.constant(buildRequestMarker('nonce_property')),
            fc.constant(buildSlotNode('job_property', 'token_property')),
            fc.constant(nestRequestMarkers(3)),
            fc.constant(nestSlotNodes(3)),
        )

        fc.assert(fc.property(fc.array(piece, { maxLength: 20 }), (pieces) => {
            const stripped = stripIllustrationControlNodes(pieces.join(''))
            expect(findRequestMarkers(stripped)).toEqual([])
            expect(findSlotNodes(stripped)).toEqual([])
            expect(stripIllustrationControlNodes(stripped)).toBe(stripped)
        }), { numRuns: 100 })
    })

    test.each([
        ['nonce', ''],
        ['nonce', 'with space'],
        ['nonce', '한글'],
        ['jobId', 'bad"id'],
        ['slotToken', 'bad/token'],
    ] as const)('rejects invalid %s identifiers with a typed reason', (field, value) => {
        const build = () => {
            if (field === 'nonce') return buildRequestMarker(value)
            if (field === 'jobId') return buildSlotNode(value, 'token')
            return buildSlotNode('job', value)
        }

        try {
            build()
            throw new Error('expected validation failure')
        } catch (error) {
            expect(error).toBeInstanceOf(IllustrationControlNodeValidationError)
            expect(error).toMatchObject({ field, reason: 'invalid_charset' })
        }
    })
})

function nestRequestMarkers(depth: number): string {
    let nested = buildRequestMarker('B')
    for (let level = 1; level < depth; level += 1) {
        nested = `<!--risu-illustration-request:v1:A${nested}C-->`
    }
    return nested
}

function nestSlotNodes(depth: number): string {
    let nested = buildSlotNode('inner', 'I')
    for (let level = 1; level < depth; level += 1) {
        nested = '<risu-illustration-slot data-v="1" data-job="outer" data-token="T'
            + nested
            + 'U"></risu-illustration-slot>'
    }
    return nested
}
