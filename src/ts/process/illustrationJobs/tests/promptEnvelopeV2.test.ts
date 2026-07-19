import { beforeAll, describe, expect, test, vi } from 'vitest'
import {
    assertEnvelopeMatchesContext,
    computeEnvelopeHash,
    MAX_ILLUSTRATION_ENVELOPE_BYTES,
    parseIllustrationPromptEnvelopeV2,
    serializeEnvelopeForTransport,
    validateEnvelopeAgainstTarget,
    type IllustrationPromptEnvelopeV2,
} from '../promptEnvelopeV2'
import {
    resolveNovelAiNativeTarget,
    type IllustrationPromptContextV2,
    type IllustrationPromptTargetV2,
} from '../promptContextV2'

vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => ({}) }))

const NAI_DB = {
    sdProvider: 'novelai',
    NAIImgUrl: 'https://image.novelai.net/ai/generate-image',
    NAIImgModel: 'nai-diffusion-4-5-full',
} as never

let naiTarget: IllustrationPromptTargetV2

beforeAll(async () => {
    naiTarget = await resolveNovelAiNativeTarget(NAI_DB)
})

function flatEnvelope(
    overrides: Partial<IllustrationPromptEnvelopeV2> = {},
): IllustrationPromptEnvelopeV2 {
    return {
        schemaVersion: 2,
        tagProfileId: 'nai-v4',
        tagProfileRevision: '1',
        profileConfigRevision: 'cfg-1',
        assetCatalogDigest: 'cat-1',
        layout: 'flat',
        basePositive: 'masterpiece',
        subjectPositives: [],
        baseNegative: 'lowres',
        subjectNegatives: [],
        ...overrides,
    }
}

function invalid(code: string): ReturnType<typeof expect.objectContaining> {
    return expect.objectContaining({ code })
}

describe('envelope parse preserves opaque tag bytes (request §5/§10-16)', () => {
    test('preserves weights, duplicates, astral Unicode, literal pipes, whitespace, and order', () => {
        const envelope: IllustrationPromptEnvelopeV2 = {
            schemaVersion: 2,
            tagProfileId: 'nai-v4',
            tagProfileRevision: '1',
            profileConfigRevision: 'cfg-1',
            assetCatalogDigest: 'cat-1',
            layout: 'native-character-slots',
            basePositive: '  (masterpiece:1.3), 1girl, 1girl  ',
            subjectPositives: ['😀𝕏 alice|extra', 'bob\tsource#2'],
            baseNegative: '  lowres  ',
            subjectNegatives: ['neg😀', 'neg\t2'],
        }
        // Deep-equal, code-unit-for-code-unit: nothing trimmed, deduped, reweighted,
        // reordered, or truncated.
        expect(parseIllustrationPromptEnvelopeV2(envelope)).toEqual(envelope)
    })

    test('rejects malformed shape, cardinality, sparse arrays, and aggregate bytes', () => {
        expect(() => parseIllustrationPromptEnvelopeV2({ ...flatEnvelope(), extra: true }))
            .toThrowError(invalid('prompt_envelope_invalid'))
        expect(() => parseIllustrationPromptEnvelopeV2(flatEnvelope({ subjectPositives: ['x'] })))
            .toThrowError(invalid('prompt_envelope_invalid'))
        expect(() => parseIllustrationPromptEnvelopeV2(flatEnvelope({
            layout: 'native-character-slots',
            subjectPositives: ['a', 'b'],
            subjectNegatives: ['a'],
        }))).toThrowError(invalid('prompt_envelope_invalid'))

        const accessor = [] as string[]
        Object.defineProperty(accessor, 0, { enumerable: true, get: () => 'surprise' })
        accessor.length = 1
        expect(() => parseIllustrationPromptEnvelopeV2(flatEnvelope({
            layout: 'native-character-slots',
            subjectPositives: accessor,
            subjectNegatives: ['neg'],
        }))).toThrowError(invalid('prompt_envelope_invalid'))

        expect(() => parseIllustrationPromptEnvelopeV2(flatEnvelope({ schemaVersion: 1 as never })))
            .toThrowError(invalid('prompt_envelope_invalid'))
        expect(() => parseIllustrationPromptEnvelopeV2(flatEnvelope({ tagProfileId: '' })))
            .toThrowError(invalid('prompt_envelope_invalid'))
        expect(() => parseIllustrationPromptEnvelopeV2(flatEnvelope({
            basePositive: 'a'.repeat(MAX_ILLUSTRATION_ENVELOPE_BYTES + 1),
        }))).toThrowError(invalid('prompt_envelope_invalid'))
    })
})

describe('envelope hash covers strings, refs, and array order (request §5)', () => {
    test('reordering subjects or changing any ref changes the hash', async () => {
        const a = parseIllustrationPromptEnvelopeV2(flatEnvelope({
            layout: 'native-character-slots',
            subjectPositives: ['alice', 'bob'],
            subjectNegatives: ['na', 'nb'],
        }))
        const reordered = parseIllustrationPromptEnvelopeV2(flatEnvelope({
            layout: 'native-character-slots',
            subjectPositives: ['bob', 'alice'],
            subjectNegatives: ['nb', 'na'],
        }))
        const refChanged = parseIllustrationPromptEnvelopeV2(flatEnvelope({
            layout: 'native-character-slots',
            subjectPositives: ['alice', 'bob'],
            subjectNegatives: ['na', 'nb'],
            assetCatalogDigest: 'cat-2',
        }))
        const [hashA, hashReordered, hashRefChanged, hashA2] = await Promise.all([
            computeEnvelopeHash(a),
            computeEnvelopeHash(reordered),
            computeEnvelopeHash(refChanged),
            computeEnvelopeHash(parseIllustrationPromptEnvelopeV2(flatEnvelope({
                layout: 'native-character-slots',
                subjectPositives: ['alice', 'bob'],
                subjectNegatives: ['na', 'nb'],
            }))),
        ])
        expect(hashA).toBe(hashA2)
        expect(hashReordered).not.toBe(hashA)
        expect(hashRefChanged).not.toBe(hashA)
        expect(hashA).toMatch(/^[0-9a-f]{64}$/)
    })
})

describe('envelope-to-target binding (request §5/§8/§10-17)', () => {
    test('rejects a layout the target does not accept (pipe on novelai-native)', () => {
        const pipe = parseIllustrationPromptEnvelopeV2(flatEnvelope({
            layout: 'pipe-slots',
            subjectPositives: ['a'],
            subjectNegatives: ['na'],
        }))
        expect(() => validateEnvelopeAgainstTarget(pipe, naiTarget))
            .toThrowError(invalid('prompt_layout_unsupported'))
    })

    test('rejects negative content on an unsupported negative channel, but allows none', () => {
        const noNegativeTarget: IllustrationPromptTargetV2 = {
            ...naiTarget,
            negativeChannel: 'unsupported',
            acceptedLayouts: ['flat'],
        }
        expect(() => validateEnvelopeAgainstTarget(flatEnvelope({ baseNegative: 'lowres' }), noNegativeTarget))
            .toThrowError(invalid('prompt_negative_channel_unsupported'))
        // No negative content at all is permitted.
        expect(() => validateEnvelopeAgainstTarget(flatEnvelope({ baseNegative: '' }), noNegativeTarget))
            .not.toThrow()
    })

    test('rejects too many subjects and a disallowed empty base positive', () => {
        const overCap = flatEnvelope({
            layout: 'native-character-slots',
            subjectPositives: Array.from({ length: 7 }, (_, i) => `p${i}`),
            subjectNegatives: Array.from({ length: 7 }, (_, i) => `n${i}`),
        })
        expect(() => validateEnvelopeAgainstTarget(overCap, naiTarget))
            .toThrowError(invalid('prompt_envelope_invalid'))
        expect(() => validateEnvelopeAgainstTarget(flatEnvelope({ basePositive: '' }), naiTarget))
            .toThrowError(invalid('prompt_envelope_invalid'))
    })

    function pipeTargetWith(negative: 'base-only' | 'base-then-subjects'): IllustrationPromptTargetV2 {
        return {
            ...naiTarget,
            transportId: 'nai-compatible-flat',
            acceptedLayouts: ['pipe-slots'],
            subjectSlots: {
                ...naiTarget.subjectSlots,
                maxSubjects: 4,
                pipeSerialization: {
                    revision: '1',
                    separator: ' | ',
                    positive: 'base-then-subjects',
                    negative,
                    rejectLiteralSeparator: true,
                },
            },
        }
    }

    test('re-validates a literal pipe conflict at the serializer boundary with position (§5/§9)', () => {
        const pipeTarget = pipeTargetWith('base-only')
        const conflicting = parseIllustrationPromptEnvelopeV2(flatEnvelope({
            layout: 'pipe-slots',
            basePositive: 'base | extra',
            subjectPositives: ['a'],
            subjectNegatives: [''],
        }))
        try {
            validateEnvelopeAgainstTarget(conflicting, pipeTarget)
            throw new Error('expected a pipe conflict')
        } catch (error) {
            expect((error as { code: string }).code).toBe('prompt_pipe_conflict')
            // Position info is carried: the '|' is at code-unit offset 5 of part[0].
            expect((error as Error).message).toContain('offset 5')
        }
    })

    test('base-only negative rejects subject-level negative content instead of silently dropping it (§4)', () => {
        const pipeTarget = pipeTargetWith('base-only')
        const dropping = parseIllustrationPromptEnvelopeV2(flatEnvelope({
            layout: 'pipe-slots',
            basePositive: 'base',
            subjectPositives: ['a'],
            subjectNegatives: ['na'],
        }))
        expect(() => validateEnvelopeAgainstTarget(dropping, pipeTarget))
            .toThrowError(invalid('prompt_negative_channel_unsupported'))
    })

    test('serializes base-then-subjects exactly, code-unit for code-unit (§5/§9)', () => {
        const pipeTarget = pipeTargetWith('base-then-subjects')
        const envelope = parseIllustrationPromptEnvelopeV2(flatEnvelope({
            layout: 'pipe-slots',
            basePositive: 'base 😀',
            subjectPositives: ['alice', '𐐷 bob'],
            baseNegative: 'lowres',
            subjectNegatives: ['blurry', ''],
        }))
        validateEnvelopeAgainstTarget(envelope, pipeTarget)
        expect(serializeEnvelopeForTransport(envelope, pipeTarget)).toEqual({
            positive: 'base 😀 | alice | 𐐷 bob',
            negative: 'lowres | blurry | ',
        })
    })

    test('base-only negative serializes just the base negative', () => {
        const pipeTarget = pipeTargetWith('base-only')
        const envelope = parseIllustrationPromptEnvelopeV2(flatEnvelope({
            layout: 'pipe-slots',
            basePositive: 'base',
            subjectPositives: ['a', 'b'],
            baseNegative: 'lowres',
            subjectNegatives: ['', ''],
        }))
        validateEnvelopeAgainstTarget(envelope, pipeTarget)
        expect(serializeEnvelopeForTransport(envelope, pipeTarget)).toEqual({
            positive: 'base | a | b',
            negative: 'lowres',
        })
    })
})

describe('envelope refs must match the prepared context (request §4)', () => {
    test('accepts matching refs and rejects any drift', () => {
        const context: IllustrationPromptContextV2 = {
            target: naiTarget,
            tagProfile: { id: 'nai-v4', revision: '1' },
            profileConfigRevision: 'cfg-1',
            assetCatalogDigest: 'cat-1',
        }
        expect(() => assertEnvelopeMatchesContext(flatEnvelope(), context)).not.toThrow()
        expect(() => assertEnvelopeMatchesContext(flatEnvelope({ tagProfileRevision: '2' }), context))
            .toThrowError(invalid('prompt_envelope_invalid'))
        expect(() => assertEnvelopeMatchesContext(flatEnvelope({ assetCatalogDigest: 'cat-2' }), context))
            .toThrowError(invalid('prompt_envelope_invalid'))
    })
})
