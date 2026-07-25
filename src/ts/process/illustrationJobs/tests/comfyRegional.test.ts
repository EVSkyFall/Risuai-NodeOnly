// ComfyUI regional prompting.
//
// Comfy expresses regions inside the workflow itself — several CLIPTextEncode
// nodes wired into conditioning-area/combine nodes — and only the workflow's
// author knows which arrangement they want. So the core does not build or
// patch a graph. It extends the documented {{risu_prompt}} placeholder
// contract with per-subject values the workflow pulls into whichever node it
// likes, and the workflow stays entirely the user's.

import { beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
    db: {} as any,
    globalFetch: vi.fn(),
    fetchNative: vi.fn(),
}))

vi.mock('svelte/store', () => ({ get: () => ({}) }))
vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => harness.db }))
vi.mock('src/ts/process/request/request', () => ({ requestChatData: vi.fn() }))
vi.mock('src/ts/alert', () => ({ alertError: vi.fn(), notifyError: vi.fn() }))
vi.mock('src/ts/globalApi.svelte', () => ({
    fetchNative: harness.fetchNative,
    globalFetch: harness.globalFetch,
    readImage: vi.fn(),
}))
vi.mock('src/ts/stores.svelte', () => ({ CharEmotion: { set: vi.fn() } }))
vi.mock('src/ts/process/processzip', () => ({ processZip: vi.fn() }))
vi.mock('lodash/random', () => ({ default: () => 12345 }))

const { generateAIImageTyped } = await import('../../stableDiff')

const CHARACTER = { chaId: 'character-1', image: '', newGenData: {} } as any

// A two-region workflow: one text node per subject, each feeding an area node
// whose x/y come from the same subject's centre.
function regionalWorkflow() {
    return JSON.stringify({
        '1': { inputs: { text: '{{risu_prompt}}' }, class_type: 'CLIPTextEncode' },
        '2': { inputs: { text: '{{risu_neg}}' }, class_type: 'CLIPTextEncode' },
        '3': { inputs: { text: '{{risu_subject_1}}' }, class_type: 'CLIPTextEncode' },
        '4': { inputs: { text: '{{risu_subject_2}}' }, class_type: 'CLIPTextEncode' },
        '5': { inputs: { x: '{{risu_subject_1_x}}', y: '{{risu_subject_1_y}}' }, class_type: 'ConditioningSetAreaPercentage' },
        '6': { inputs: { x: '{{risu_subject_2_x}}', y: '{{risu_subject_2_y}}' }, class_type: 'ConditioningSetAreaPercentage' },
        '7': { inputs: { seed: 1, note: 'subjects: {{risu_subject_count}}' }, class_type: 'KSampler' },
    })
}

beforeEach(() => {
    harness.db = {
        sdProvider: 'comfyui',
        comfyUiUrl: 'http://127.0.0.1:8188',
        comfyConfig: {
            workflow: regionalWorkflow(),
            posNodeID: '1', posInputName: 'text',
            negNodeID: '2', negInputName: 'text',
            timeout: 30,
        },
    }
    harness.globalFetch.mockReset()
    harness.fetchNative.mockReset()
    harness.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: 'p1' }, status: 200 })
    harness.fetchNative.mockImplementation(async (url: string) => {
        if (url.includes('/history')) {
            return {
                json: async () => ({ p1: { outputs: { a: { images: [{ filename: 'f.png', subfolder: '', type: 'output' }] } } } }),
            } as any
        }
        return { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as any
    })
})

async function dispatch(illustrationPrompt?: any) {
    await generateAIImageTyped(
        'base positive',
        CHARACTER,
        'base negative',
        'inlay',
        'background',
        { preservePromptText: true, ...(illustrationPrompt ? { illustrationPrompt } : {}) },
    )
    return harness.globalFetch.mock.calls[0][1].body.prompt
}

function twoSubjects(characterCenters?: Array<{ x: number, y: number } | null>) {
    return {
        schemaVersion: 1,
        layout: 'nai-v4-characters',
        basePositive: 'base positive',
        characterPositives: ['1girl, silver hair', '1boy, dark hair'],
        baseNegative: 'base negative',
        characterNegatives: ['blurry', ''],
        ...(characterCenters ? { characterCenters } : {}),
    }
}

describe('comfy per-subject placeholders', () => {
    test('each subject caption lands in its own node', async () => {
        const graph = await dispatch(twoSubjects([{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }]))

        expect(graph['3'].inputs.text).toBe('1girl, silver hair')
        expect(graph['4'].inputs.text).toBe('1boy, dark hair')
        // The flat prompt still reaches the nodes that asked for it, so a
        // workflow can use both the combined and the per-subject form.
        expect(graph['1'].inputs.text).toBe('base positive')
        expect(graph['2'].inputs.text).toBe('base negative')
    })

    test('a coordinate placeholder becomes a number, because area nodes take numbers', async () => {
        const graph = await dispatch(twoSubjects([{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.1 }]))

        expect(graph['5'].inputs.x).toBe(0.25)
        expect(graph['5'].inputs.y).toBe(0.5)
        expect(graph['6'].inputs.x).toBe(0.75)
        expect(graph['6'].inputs.y).toBe(0.1)
        for (const value of [graph['5'].inputs.x, graph['5'].inputs.y]) {
            expect(typeof value).toBe('number')
        }
    })

    test('region geometry is a rectangle, because area nodes take a top-left corner and a size', async () => {
        harness.db.comfyConfig.workflow = JSON.stringify({
            '1': {
                inputs: {
                    x: '{{risu_subject_1_left}}', y: '{{risu_subject_1_top}}',
                    width: '{{risu_subject_1_width}}', height: '{{risu_subject_1_height}}',
                },
                class_type: 'ConditioningSetAreaPercentage',
            },
            '2': {
                inputs: {
                    x: '{{risu_subject_2_left}}', y: '{{risu_subject_2_top}}',
                    width: '{{risu_subject_2_width}}', height: '{{risu_subject_2_height}}',
                },
                class_type: 'ConditioningSetAreaPercentage',
            },
        })
        // Feeding the CENTRE straight into these nodes would shift every region
        // down and right by half a column.
        const graph = await dispatch(twoSubjects([{ x: 0.25, y: 0.72 }, { x: 0.75, y: 0.5 }]))

        // Full-height columns, sized by how many subjects are placed. Both
        // halves of that were measured against real generations:
        //
        // Banding the vertical axis as well confined two standing figures to
        // the bottom third and made them small rather than near — the opposite
        // of what foreground means. The vertical coordinate is depth, not
        // height on screen.
        //
        // Quantizing the horizontal axis to fixed thirds left the middle third
        // owned by nobody, and the base conditioning filled that gap with extra
        // people. Sizing by subject count closes it.
        expect(graph['1'].inputs.x).toBeCloseTo(0)
        expect(graph['1'].inputs.width).toBeCloseTo(0.5)
        expect(graph['1'].inputs.y).toBe(0)
        expect(graph['1'].inputs.height).toBe(1)

        expect(graph['2'].inputs.x).toBeCloseTo(0.5)
        expect(graph['2'].inputs.width).toBeCloseTo(0.5)
        expect(graph['2'].inputs.y).toBe(0)
        expect(graph['2'].inputs.height).toBe(1)

        // No gap and no overlap: the two columns tile the canvas exactly.
        expect(graph['1'].inputs.x + graph['1'].inputs.width).toBeCloseTo(graph['2'].inputs.x)
        expect(graph['2'].inputs.x + graph['2'].inputs.width).toBeCloseTo(1)

        for (const value of Object.values(graph['1'].inputs)) expect(typeof value).toBe('number')
    })

    test('two subjects sharing a position share a column instead of being pushed apart', async () => {
        harness.db.comfyConfig.workflow = JSON.stringify({
            '1': { inputs: { x: '{{risu_subject_1_left}}', width: '{{risu_subject_1_width}}' }, class_type: 'ConditioningSetAreaPercentage' },
            '2': { inputs: { x: '{{risu_subject_2_left}}', width: '{{risu_subject_2_width}}' }, class_type: 'ConditioningSetAreaPercentage' },
        })
        // A clinch: the Planner put both in the same place, and the region
        // sizing must not invent a separation it never asked for.
        const graph = await dispatch(twoSubjects([{ x: 0.25, y: 0.5 }, { x: 0.25, y: 0.5 }]))

        expect(graph['1'].inputs.x).toBeCloseTo(graph['2'].inputs.x)
        expect(graph['1'].inputs.width).toBeCloseTo(graph['2'].inputs.width)
    })

    test('a lone placed subject owns the whole width', async () => {
        harness.db.comfyConfig.workflow = JSON.stringify({
            '1': { inputs: { x: '{{risu_subject_1_left}}', width: '{{risu_subject_1_width}}', text: '{{risu_subject_2}}' }, class_type: 'ConditioningSetAreaPercentage' },
        })
        const graph = await dispatch(twoSubjects([{ x: 0.25, y: 0.5 }, null]))

        expect(graph['1'].inputs.x).toBe(0)
        expect(graph['1'].inputs.width).toBe(1)
    })

    test('a region for a subject the scene does not have contributes nothing', async () => {
        harness.db.comfyConfig.workflow = JSON.stringify({
            '1': { inputs: { text: '{{risu_subject_1}}', strength: '{{risu_subject_1_strength}}' }, class_type: 'ConditioningSetAreaPercentage' },
            '2': { inputs: { text: '{{risu_subject_2}}', strength: '{{risu_subject_2_strength}}' }, class_type: 'ConditioningSetAreaPercentage' },
            '3': { inputs: { text: '{{risu_subject_3}}', strength: '{{risu_subject_3_strength}}' }, class_type: 'ConditioningSetAreaPercentage' },
        })
        const graph = await dispatch(twoSubjects([{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }]))

        // This is what lets one workflow with a fixed number of regions serve
        // scenes with fewer subjects: the spare regions would otherwise apply
        // an empty caption over the whole canvas at full weight.
        expect(graph['1'].inputs.strength).toBe(1)
        expect(graph['2'].inputs.strength).toBe(1)
        expect(graph['3'].inputs.strength).toBe(0)
        expect(graph['3'].inputs.text).toBe('')
    })

    test('an unplaced subject gets the whole canvas, not a corner', async () => {
        harness.db.comfyConfig.workflow = JSON.stringify({
            '1': {
                inputs: {
                    x: '{{risu_subject_2_left}}', y: '{{risu_subject_2_top}}',
                    width: '{{risu_subject_2_width}}', height: '{{risu_subject_2_height}}',
                    text: '{{risu_subject_1}}{{risu_subject_2}}',
                },
                class_type: 'ConditioningSetAreaPercentage',
            },
        })
        const graph = await dispatch(twoSubjects([{ x: 0.25, y: 0.72 }, null]))

        // A region node then degrades to "no restriction" rather than pinning
        // the subject somewhere nobody asked for.
        expect(graph['1'].inputs.x).toBe(0)
        expect(graph['1'].inputs.y).toBe(0)
        expect(graph['1'].inputs.width).toBe(1)
        expect(graph['1'].inputs.height).toBe(1)
    })

    test('a placeholder embedded in a larger string stays text', async () => {
        const graph = await dispatch(twoSubjects())

        expect(graph['7'].inputs.note).toBe('subjects: 2')
        expect(typeof graph['7'].inputs.note).toBe('string')
    })

    test('a region the scene has no subject for resolves to empty, not to a leftover placeholder', async () => {
        harness.db.comfyConfig.workflow = JSON.stringify({
            '1': { inputs: { text: '{{risu_subject_1}}' }, class_type: 'CLIPTextEncode' },
            '2': { inputs: { text: '{{risu_subject_2}}' }, class_type: 'CLIPTextEncode' },
            '3': { inputs: { text: '{{risu_subject_3}}' }, class_type: 'CLIPTextEncode' },
            '4': { inputs: { x: '{{risu_subject_3_x}}' }, class_type: 'ConditioningSetAreaPercentage' },
        })
        const graph = await dispatch(twoSubjects([{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }]))

        // One workflow can serve scenes with fewer subjects than it has
        // regions; an unresolved placeholder reaching the provider would be
        // sent as literal text.
        expect(graph['1'].inputs.text).toBe('1girl, silver hair')
        expect(graph['2'].inputs.text).toBe('1boy, dark hair')
        expect(graph['3'].inputs.text).toBe('')
        expect(graph['4'].inputs.x).toBe(0)
    })

    test('a subject with no region anywhere in the workflow refuses before anything is posted', async () => {
        harness.db.comfyConfig.workflow = JSON.stringify({
            '1': { inputs: { text: '{{risu_subject_1}}' }, class_type: 'CLIPTextEncode' },
        })
        const attempt = await generateAIImageTyped(
            'base positive', CHARACTER, 'base negative', 'inlay', 'background',
            { preservePromptText: true, illustrationPrompt: twoSubjects() as any },
        )

        // The reverse direction is the dangerous one: a caption nothing asked
        // for is a subject dropped from the picture with no trace.
        expect(attempt.result.ok).toBe(false)
        // `strict` is off in this project, which weakens discriminated union
        // narrowing; name the failure member explicitly.
        const failure = attempt.result as Extract<typeof attempt.result, { ok: false }>
        expect(failure.certainty).toBe('definite')
        expect(failure.reason).toMatch(/subject 2/)
        // Nothing was posted, so nothing was paid.
        expect(harness.globalFetch).not.toHaveBeenCalled()
    })

    test('per-subject negatives are addressable too', async () => {
        harness.db.comfyConfig.workflow = JSON.stringify({
            '1': { inputs: { text: '{{risu_subject_1_neg}}' }, class_type: 'CLIPTextEncode' },
            '2': { inputs: { text: '{{risu_subject_2_neg}}' }, class_type: 'CLIPTextEncode' },
        })
        const graph = await dispatch(twoSubjects())

        expect(graph['1'].inputs.text).toBe('blurry')
        expect(graph['2'].inputs.text).toBe('')
    })

    test('an unplaced subject reports centre zero rather than failing the graph', async () => {
        const graph = await dispatch(twoSubjects([{ x: 0.25, y: 0.5 }, null]))

        expect(graph['5'].inputs.x).toBe(0.25)
        expect(graph['6'].inputs.x).toBe(0)
        expect(graph['6'].inputs.y).toBe(0)
    })

    test('a workflow written before regional placement keeps working on a flat prompt', async () => {
        harness.db.comfyConfig.workflow = JSON.stringify({
            '1': { inputs: { text: '{{risu_prompt}}' }, class_type: 'CLIPTextEncode' },
            '2': { inputs: { text: '{{risu_neg}}' }, class_type: 'CLIPTextEncode' },
            '3': { inputs: { seed: 7 }, class_type: 'KSampler' },
        })
        // Flat is what such a workflow is sent, and it carries no captions to
        // lose — so the whole extension is invisible to it.
        const graph = await dispatch({
            schemaVersion: 1,
            layout: 'flat',
            basePositive: 'base positive',
            characterPositives: [],
            baseNegative: 'base negative',
            characterNegatives: [],
        })

        expect(graph['1'].inputs.text).toBe('base positive')
        expect(graph['2'].inputs.text).toBe('base negative')
        // Seed randomization is pre-existing behaviour and must survive.
        expect(typeof graph['3'].inputs.seed).toBe('number')
        expect(graph['3'].inputs.seed).not.toBe(7)
    })

    test('a flat prompt leaves every per-subject placeholder empty', async () => {
        const graph = await dispatch({
            schemaVersion: 1,
            layout: 'flat',
            basePositive: 'base positive',
            characterPositives: [],
            baseNegative: 'base negative',
            characterNegatives: [],
        })

        expect(graph['3'].inputs.text).toBe('')
        expect(graph['5'].inputs.x).toBe(0)
        expect(graph['7'].inputs.note).toBe('subjects: 0')
    })
})
