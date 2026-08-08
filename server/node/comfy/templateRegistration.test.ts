// @vitest-environment node

import Database from 'better-sqlite3'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import registryPkg from './templateRegistry.cjs'
import storePkg from './store.cjs'

const { createTemplateRegistry } = registryPkg as any
const { createComfyStore } = storePkg as any
const templateDir = fileURLToPath(new URL('./templates/', import.meta.url))
const fl2vaFixturePath = fileURLToPath(new URL('./fixtures/DasiwaMinimaxH3WorkflowsT2VA_cMMH3V11_FL2VA.min.json', import.meta.url))
const dbs: any[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

function createRegistry(now = 1_000) {
  const db = new Database(':memory:')
  dbs.push(db)
  const store = createComfyStore(db, { defaultTemplateDir: templateDir, now: () => now })
  return { db, store, registry: createTemplateRegistry({ templateDir, store }) }
}

function graph(options: {
  positive?: string | null
  negative?: string | null
  images?: string[]
  seeds?: Array<[string, string, unknown]>
  outputs?: Array<[string, string]>
} = {}) {
  const result: Record<string, any> = {}
  if (options.positive !== null) {
    result.text = { class_type: 'CLIPTextEncode', inputs: { text: options.positive ?? '{{positive}}' } }
  }
  if (options.negative != null) {
    result.negative = { class_type: 'CLIPTextEncode', inputs: { text: options.negative } }
  }
  for (const nodeId of options.images ?? []) {
    result[nodeId] = { class_type: 'LoadImage', inputs: { image: `${nodeId}.png` } }
  }
  for (const [nodeId, inputName, value] of options.seeds ?? [['sampler', 'seed', 7]]) {
    result[nodeId] = { class_type: 'SamplerCustom', inputs: { [inputName]: value } }
  }
  const outputSource = (options.seeds ?? [['sampler', 'seed', 7]])[0]?.[0] ?? 'text'
  for (const [nodeId, classType] of options.outputs ?? [['output', 'VHS_VideoCombine']]) {
    result[nodeId] = { class_type: classType, inputs: { source: [outputSource, 0] } }
  }
  return result
}

describe('Comfy custom template analysis and registration', () => {
  it('analyzes embedded slots, image literals, and unknown tokens in the real FL2VA state strings', async () => {
    const { registry } = createRegistry()
    const graphJson = await readFile(fl2vaFixturePath, 'utf8')

    const analyzed = registry.analyzeTemplate(graphJson)
    expect(analyzed).toMatchObject({
      ok: true,
      errors: [],
      warnings: [
        { code: 'COMFY_TEMPLATE_PLACEHOLDER_UNKNOWN', message: expect.stringContaining('timeline_data') },
        { code: 'COMFY_TEMPLATE_PLACEHOLDER_UNKNOWN', message: expect.stringContaining('builder_state') },
      ],
      slots: {
        positive: expect.arrayContaining([{ nodeId: '2693', inputName: 'prompt' }]),
        inputImages: [],
        seeds: [{ nodeId: '1512:2600', inputName: 'noise_seed' }],
      },
      output: null,
      embeddedSlots: expect.arrayContaining([
        { nodeId: '2693', inputName: 'timeline_data', token: '{{positive}}', occurrences: 1 },
        { nodeId: '2693', inputName: 'builder_state', token: '{{positive}}', occurrences: 1 },
      ]),
      embeddedImageLiterals: [
        {
          nodeId: '2693',
          inputName: 'timeline_data',
          literal: 'img-204fe3a6-34ab-48a3-89d3-643ddf1543ac_00002_.png',
          pathHint: '/items/0/value',
          occurrences: 1,
        },
        {
          nodeId: '2693',
          inputName: 'timeline_data',
          literal: 'img-efa3e877-b3a1-42d8-9540-7a21240cc067_00014_.png',
          pathHint: '/items/1/value',
          occurrences: 1,
        },
      ],
    })
  })

  it('keeps non-JSON partial known tokens fatal while accepting JSON scalar string slots', () => {
    const { registry } = createRegistry()
    const partial = graph({ positive: 'prefix {{positive}} suffix' })
    expect(registry.analyzeTemplate(partial)).toMatchObject({
      ok: false,
      errors: [{ code: 'COMFY_TEMPLATE_PLACEHOLDER_INVALID' }],
    })
    const jsonKey = graph({
      positive: JSON.stringify({ '{{positive}}': 'key data', prompt: '{{negative}}' }),
    })
    expect(registry.analyzeTemplate(jsonKey)).toMatchObject({
      ok: false,
      errors: [{ code: 'COMFY_TEMPLATE_PLACEHOLDER_INVALID' }],
    })
    const unknownJsonKeys = graph({
      positive: JSON.stringify({ '{{soundscape}}': 'kept', '{{positve}}': 'also kept' }),
    })
    expect(registry.analyzeTemplate(unknownJsonKeys)).toMatchObject({
      ok: true,
      errors: [],
      warnings: expect.arrayContaining([
        { code: 'COMFY_TEMPLATE_PLACEHOLDER_UNKNOWN', message: expect.stringContaining('{{soundscape}}') },
        { code: 'COMFY_TEMPLATE_PLACEHOLDER_SUSPICIOUS', message: expect.stringContaining('{{positve}}') },
      ]),
    })

    const scalar = graph({ positive: JSON.stringify('prefix {{positive}} suffix') })
    expect(registry.analyzeTemplate(scalar)).toMatchObject({
      ok: true,
      errors: [],
      embeddedSlots: [{ nodeId: 'text', inputName: 'text', token: '{{positive}}', occurrences: 1 }],
    })
  })

  it('registers every real FL2VA embedded binding with one shared image role and a three-slot manifest', async () => {
    const { registry } = createRegistry()
    const graphJson = await readFile(fl2vaFixturePath, 'utf8')
    const metadata = {
      name: 'Dasiwa cMMH3 V11 FL2VA embedded',
      kind: 'video',
      mode: 'flf2v',
      graphJson,
      outputDescriptor: {
        nodeId: '2568',
        classType: 'DaSiWa_EnhancedVideoCombine',
        historyKey: 'gifs',
        mediaType: 'video/webm',
      },
      promptProfile: 'h3-structured',
    }
    await expect(registry.registerTemplate({
      ...metadata,
      slotResolution: { positive: { nodeId: '2693', inputName: 'prompt' } },
    })).rejects.toMatchObject({ code: 'COMFY_TEMPLATE_RESOLUTION_REQUIRED' })

    const embeddedResolution = {
      embedded: {
        slots: [
          { nodeId: '2693', inputName: 'timeline_data', token: '{{positive}}' },
          { nodeId: '2693', inputName: 'builder_state', token: '{{positive}}' },
        ],
        inputImages: [
          {
            nodeId: '2693',
            inputName: 'timeline_data',
            literal: 'img-204fe3a6-34ab-48a3-89d3-643ddf1543ac_00002_.png',
            name: 'input_image',
          },
          {
            nodeId: '2693',
            inputName: 'timeline_data',
            literal: 'img-efa3e877-b3a1-42d8-9540-7a21240cc067_00014_.png',
            name: 'input_image',
          },
        ],
      },
    }
    const registered = await registry.registerTemplate({
      ...metadata,
      slotResolution: embeddedResolution,
    })
    expect(registered).toMatchObject({
      created: true,
      template: {
        mode: 'flf2v',
        slots: [
          { name: 'input_image', type: 'imageAsset', required: true },
          { name: 'positive', type: 'string', required: true },
          {
            name: 'seed', type: 'integer', required: true,
            minimum: 0, maximum: Number.MAX_SAFE_INTEGER,
          },
        ],
        slotBindings: {
          positive: { nodeId: '2693', inputName: 'timeline_data', embedded: true },
          inputImages: [{
            nodeId: '2693', inputName: 'timeline_data', name: 'input_image', embedded: true,
          }],
          seeds: [{ nodeId: '1512:2600', inputName: 'noise_seed' }],
          embedded: {
            slots: expect.arrayContaining([
              {
                nodeId: '2693', inputName: 'timeline_data', token: '{{positive}}',
                occurrences: 1, name: 'positive',
              },
              {
                nodeId: '2693', inputName: 'builder_state', token: '{{positive}}',
                occurrences: 1, name: 'positive',
              },
            ]),
            inputImages: expect.arrayContaining([
              expect.objectContaining({
                literal: 'img-204fe3a6-34ab-48a3-89d3-643ddf1543ac_00002_.png',
                name: 'input_image',
              }),
              expect.objectContaining({
                literal: 'img-efa3e877-b3a1-42d8-9540-7a21240cc067_00014_.png',
                name: 'input_image',
              }),
            ]),
          },
        },
        outputDescriptor: metadata.outputDescriptor,
      },
    })

    const originalImageLiteral = 'img-204fe3a6-34ab-48a3-89d3-643ddf1543ac_00002_.png'
    const positive = [
      'Camera holds on "the quoted subject".',
      'A backslash \\ crosses the frame.\u0001',
      `Compile once: {{positive}} {{input_image}} ${originalImageLiteral}`,
    ].join('\n')
    const inputImage = 'risu-comfy/job/frame-"quoted".png'
    const instantiated = await registry.instantiate(registered.template.id, {
      positive,
      input_image: inputImage,
      seed: 123456,
    })
    const timeline = JSON.parse(instantiated.prompt['2693'].inputs.timeline_data)
    const builderState = JSON.parse(instantiated.prompt['2693'].inputs.builder_state)
    expect(timeline.builder_state.imd).toBe(positive)
    expect(builderState.imd).toBe(positive)
    expect(timeline.items.map((item: any) => item.value)).toEqual([inputImage, inputImage])
    expect(timeline.builder_state.soundscape).toBe('{{soundscape}}')
    expect(builderState.soundscape).toBe('{{soundscape}}')
    expect(instantiated.prompt['2693'].inputs.prompt).toBe('')
    expect(instantiated.prompt['1512:2600'].inputs.noise_seed).toBe(123456)
  })

  it('deduplicates semantic image literals across JSON escape spellings and rejects tampered occurrence metadata', async () => {
    const { registry } = createRegistry()
    const state = '{"prompt":"\\u007b\\u007bpositive}}","images":["folder\\/same.png","folder/same.png"]}'
    const custom = {
      director: { class_type: 'Director', inputs: { state } },
      output: { class_type: 'SaveVideo', inputs: { images: ['director', 0] } },
    }
    expect(registry.analyzeTemplate(custom)).toMatchObject({
      ok: true,
      embeddedSlots: [
        { nodeId: 'director', inputName: 'state', token: '{{positive}}', occurrences: 1 },
      ],
      embeddedImageLiterals: [
        {
          nodeId: 'director', inputName: 'state', literal: 'folder/same.png',
          pathHint: '/images/0', occurrences: 2,
        },
      ],
    })
    const registered = await registry.registerTemplate({
      name: 'Semantic escaped state',
      kind: 'video',
      mode: 'flf2v',
      graphJson: custom,
      slotResolution: {
        embedded: {
          slots: [{ nodeId: 'director', inputName: 'state', token: '{{positive}}' }],
          inputImages: [{
            nodeId: 'director', inputName: 'state', literal: 'folder/same.png', name: 'input_image',
          }],
        },
      },
      promptProfile: 'h3-structured',
    })
    const compiled = await registry.instantiate(registered.template.id, {
      positive: 'semantic prompt', input_image: 'risu/new.png',
    })
    expect(JSON.parse(compiled.prompt.director.inputs.state)).toEqual({
      prompt: 'semantic prompt', images: ['risu/new.png', 'risu/new.png'],
    })

    const loaded = await registry.loadTemplate(registered.template.id)
    const tamperedSlots = structuredClone(loaded.templateSlots)
    tamperedSlots.embedded.inputImages[0].occurrences = 3
    expect(() => registry.instantiateSnapshot(
      loaded.sourceText,
      loaded.hash,
      { positive: 'semantic prompt', input_image: 'risu/new.png' },
      loaded.id,
      { templateSlots: tamperedSlots, outputDescriptor: loaded.outputDescriptor },
    )).toThrow(expect.objectContaining({ code: 'COMFY_TEMPLATE_SNAPSHOT_INVALID' }))
  })

  it('supports embedded prompt, seed, and image token families without direct bindings', async () => {
    const { registry } = createRegistry()
    const custom = {
      director: {
        class_type: 'Director',
        inputs: {
          state: JSON.stringify({
            prompt: '{{positive}}',
            negative: '{{negative}}',
            seed: '{{seed}}',
            image: '{{input_image}}',
          }),
        },
      },
      output: { class_type: 'SaveVideo', inputs: { images: ['director', 0] } },
    }
    const slots = ['positive', 'negative', 'seed', 'input_image'].map(name => ({
      nodeId: 'director', inputName: 'state', token: `{{${name}}}`,
    }))
    const registered = await registry.registerTemplate({
      name: 'Embedded token families',
      kind: 'video',
      mode: 'i2v',
      graphJson: custom,
      slotResolution: { embedded: { slots } },
      promptProfile: 'h3-structured',
    })
    expect(registered.template.slots).toEqual([
      { name: 'input_image', type: 'imageAsset', required: true },
      { name: 'positive', type: 'string', required: true },
      { name: 'negative', type: 'string', required: true },
      {
        name: 'seed', type: 'integer', required: true,
        minimum: 0, maximum: Number.MAX_SAFE_INTEGER,
      },
    ])
    const compiled = await registry.instantiate(registered.template.id, {
      positive: 'p', negative: 'n', seed: 7, input_image: 'risu/token.png',
    })
    expect(JSON.parse(compiled.prompt.director.inputs.state)).toEqual({
      prompt: 'p', negative: 'n', seed: '7', image: 'risu/token.png',
    })

    const overlapping = structuredClone(custom)
    overlapping.director.inputs.state = JSON.stringify({ image: '{{positive}}.png' })
    await expect(registry.registerTemplate({
      name: 'Overlapping embedded sources',
      kind: 'video',
      mode: 'i2v',
      graphJson: overlapping,
      slotResolution: {
        embedded: {
          slots: [{ nodeId: 'director', inputName: 'state', token: '{{positive}}' }],
          inputImages: [{
            nodeId: 'director', inputName: 'state', literal: '{{positive}}.png', name: 'input_image',
          }],
        },
      },
      promptProfile: 'h3-structured',
    })).rejects.toMatchObject({ code: 'COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID' })
  })

  it('registers i2v when a direct LoadImage and an embedded literal share one image role', async () => {
    const { registry } = createRegistry()
    const custom = {
      loader: { class_type: 'LoadImage', inputs: { image: 'start.png' } },
      director: {
        class_type: 'Director',
        inputs: {
          state: JSON.stringify({ prompt: '{{positive}}', seed: '{{seed}}', items: [{ value: 'keyframe.png' }] }),
          image: ['loader', 0],
        },
      },
      output: { class_type: 'SaveVideo', inputs: { images: ['director', 0] } },
    }
    // Two DISTINCT roles still exceed i2v — cardinality counts roles, not bindings.
    await expect(registry.registerTemplate({
      name: 'Two roles under i2v',
      kind: 'video',
      mode: 'i2v',
      graphJson: custom,
      slotResolution: {
        embedded: {
          slots: ['positive', 'seed'].map(name => ({
            nodeId: 'director', inputName: 'state', token: `{{${name}}}`,
          })),
          inputImages: [{
            nodeId: 'director', inputName: 'state', literal: 'keyframe.png', name: 'end_image',
          }],
        },
      },
      promptProfile: 'h3-structured',
    })).rejects.toMatchObject({ code: 'COMFY_TEMPLATE_IMAGE_CARDINALITY' })

    const registered = await registry.registerTemplate({
      name: 'Dasiwa I2VA shared image role',
      kind: 'video',
      mode: 'i2v',
      graphJson: custom,
      slotResolution: {
        embedded: {
          slots: ['positive', 'seed'].map(name => ({
            nodeId: 'director', inputName: 'state', token: `{{${name}}}`,
          })),
          inputImages: [{
            nodeId: 'director', inputName: 'state', literal: 'keyframe.png', name: 'input_image',
          }],
        },
      },
      promptProfile: 'h3-structured',
    })
    expect(registered.template.mode).toBe('i2v')
    expect(registered.template.slots.filter((slot: { type: string }) => slot.type === 'imageAsset')).toEqual([
      { name: 'input_image', type: 'imageAsset', required: true },
    ])

    const compiled = await registry.instantiate(registered.template.id, {
      positive: 'p', seed: 3, input_image: 'risu-comfy/up.png',
    })
    expect(compiled.prompt.loader.inputs.image).toBe('risu-comfy/up.png')
    expect(JSON.parse(compiled.prompt.director.inputs.state)).toMatchObject({
      items: [{ value: 'risu-comfy/up.png' }],
    })

    // l2v mirrors i2v cardinality: exactly one image role, anchored at the end.
    const l2vGraph = structuredClone(custom)
    l2vGraph.director.inputs.state = JSON.stringify({
      prompt: '{{positive}}', seed: '{{seed}}', items: [{ value: 'endframe.png' }],
    })
    const l2v = await registry.registerTemplate({
      name: 'Dasiwa L2VA last-frame anchor',
      kind: 'video',
      mode: 'l2v',
      graphJson: l2vGraph,
      slotResolution: {
        embedded: {
          slots: ['positive', 'seed'].map(name => ({
            nodeId: 'director', inputName: 'state', token: `{{${name}}}`,
          })),
          inputImages: [{
            nodeId: 'director', inputName: 'state', literal: 'endframe.png', name: 'input_image',
          }],
        },
      },
      promptProfile: 'h3-structured',
    })
    expect(l2v.template.mode).toBe('l2v')

    await expect(registry.registerTemplate({
      name: 'L2VA needs exactly one image',
      kind: 'video',
      mode: 'l2v',
      graphJson: graph({ images: [] }),
      promptProfile: 'h3-structured',
    })).rejects.toMatchObject({ code: 'COMFY_TEMPLATE_IMAGE_CARDINALITY' })
  })

  it('distinguishes UI format, rejects blank class_type and dangling links, and accepts colon node ids', () => {
    const { registry } = createRegistry()

    expect(registry.analyzeTemplate({ nodes: [], links: [] })).toMatchObject({
      ok: false,
      errors: [{ code: 'COMFY_TEMPLATE_UI_FORMAT', message: expect.stringContaining('API Format') }],
      warnings: [],
    })
    expect(registry.analyzeTemplate({
      '2693': { class_type: '', inputs: {} },
    })).toMatchObject({
      ok: false,
      errors: [{ code: 'COMFY_TEMPLATE_CLASS_TYPE_MISSING' }],
      warnings: [],
    })
    expect(registry.analyzeTemplate({
      ...graph(),
      dangling: { class_type: 'PreviewImage', inputs: { images: ['missing:node', 0] } },
    })).toMatchObject({
      ok: false,
      errors: [{ code: 'COMFY_TEMPLATE_DANGLING_REFERENCE' }],
    })
    expect(registry.analyzeTemplate({
      '1512:2586': { class_type: 'CLIPTextEncode', inputs: { text: '{{positive}}' } },
      sampler: { class_type: 'SamplerCustom', inputs: { seed: 1 } },
      '1512:2694': { class_type: 'SaveVideo', inputs: { images: ['sampler', 0] } },
    })).toMatchObject({
      ok: true,
      slots: { positive: { nodeId: '1512:2586', inputName: 'text' } },
      output: {
        nodeId: '1512:2694',
        classType: 'SaveVideo',
        historyKey: 'images',
        mediaType: 'video/mp4',
      },
    })
    expect(registry.analyzeTemplate('{')).toMatchObject({
      ok: false,
      errors: [{ code: 'COMFY_TEMPLATE_INVALID_JSON' }],
      warnings: [],
    })
  })

  it('reports the positive, LoadImage, and multi-seed detection matrix without mutating the graph', () => {
    const { registry } = createRegistry()
    const noPositive = graph({ positive: 'ordinary text', images: [], seeds: [], outputs: [] })
    const onePositive = graph({ images: ['image'], seeds: [['a', 'seed', 1], ['b', 'noise_seed', ['a', 0]]] })
    const twoPositive = {
      ...onePositive,
      second: { class_type: 'Text', inputs: { value: '{{positive}}' } },
    }

    expect(registry.analyzeTemplate(noPositive)).toMatchObject({
      ok: true,
      slots: {
        positive: [{ nodeId: 'text', inputName: 'text' }],
        inputImages: [],
        seeds: [],
      },
    })
    expect(registry.analyzeTemplate(onePositive)).toMatchObject({
      ok: true,
      slots: {
        positive: { nodeId: 'text', inputName: 'text' },
        inputImages: [{ nodeId: 'image', inputName: 'image', name: 'input_image' }],
        seeds: [
          { nodeId: 'a', inputName: 'seed' },
          { nodeId: 'b', inputName: 'noise_seed' },
        ],
      },
    })
    expect(registry.analyzeTemplate(twoPositive)).toMatchObject({
      ok: false,
      errors: [{ code: 'COMFY_TEMPLATE_POSITIVE_AMBIGUOUS' }],
    })

    const manyImages = registry.analyzeTemplate(graph({ images: ['first', 'last'] }))
    expect(manyImages).toMatchObject({
      ok: true,
      slots: {
        inputImages: [
          { nodeId: 'first', inputName: 'image' },
          { nodeId: 'last', inputName: 'image' },
        ],
      },
    })
    expect(onePositive.b.inputs.noise_seed).toEqual(['a', 0])
  })

  it('keeps raw brace data intact and distinguishes unknown tokens from slot-like typos', async () => {
    const { registry } = createRegistry()
    const timelineData = JSON.stringify({
      version: 1,
      builder_state: { template: '{{unrelated_template_token}}', items: [] },
    })
    const custom = {
      director: {
        class_type: 'MiniMaxH3Director',
        inputs: {
          prompt: 'ordinary prompt',
          timeline_data: timelineData,
          builder_state: '{{positve}}',
          reference_zero: '{{reference_0}}',
          reference_missing: '{{reference_}}',
          reference_trailing: '{{reference_1x}}',
        },
      },
      output: { class_type: 'SaveVideo', inputs: { images: ['director', 0] } },
    }

    const analyzed = registry.analyzeTemplate(custom)
    expect(analyzed).toMatchObject({
      ok: true,
      errors: [],
      warnings: expect.arrayContaining([
        {
          code: 'COMFY_TEMPLATE_PLACEHOLDER_UNKNOWN',
          message: expect.stringMatching(/director\.inputs\.timeline_data.*\{\{unrelated_template_token\}\}/),
        },
        {
          code: 'COMFY_TEMPLATE_PLACEHOLDER_SUSPICIOUS',
          message: expect.stringMatching(/director\.inputs\.builder_state.*\{\{positve\}\}.*\{\{positive\}\}/),
        },
        {
          code: 'COMFY_TEMPLATE_PLACEHOLDER_SUSPICIOUS',
          message: expect.stringMatching(/director\.inputs\.reference_zero.*\{\{reference_0\}\}.*\{\{reference_1\}\}/),
        },
        {
          code: 'COMFY_TEMPLATE_PLACEHOLDER_SUSPICIOUS',
          message: expect.stringMatching(/director\.inputs\.reference_missing.*\{\{reference_\}\}.*\{\{reference_1\}\}/),
        },
        {
          code: 'COMFY_TEMPLATE_PLACEHOLDER_SUSPICIOUS',
          message: expect.stringMatching(/director\.inputs\.reference_trailing.*\{\{reference_1x\}\}.*\{\{reference_1\}\}/),
        },
      ]),
    })
    expect(analyzed.warnings).toHaveLength(5)

    const registered = await registry.registerTemplate({
      name: 'Raw widget state',
      kind: 'video',
      mode: 't2v',
      graphJson: custom,
      slotResolution: { positive: { nodeId: 'director', inputName: 'prompt' } },
      promptProfile: 'h3-structured',
    })
    const instantiated = await registry.instantiate(registered.template.id, { positive: 'resolved prompt' })
    expect(instantiated.prompt.director.inputs).toMatchObject({
      prompt: 'resolved prompt',
      timeline_data: timelineData,
      builder_state: '{{positve}}',
      reference_zero: '{{reference_0}}',
      reference_missing: '{{reference_}}',
      reference_trailing: '{{reference_1x}}',
    })

    const embeddedKnownLiteral = structuredClone(custom)
    embeddedKnownLiteral.director.inputs.builder_state = JSON.stringify({ prompt: '{{positive}}' })
    expect(registry.analyzeTemplate(embeddedKnownLiteral)).toMatchObject({
      ok: true,
      errors: [],
      embeddedSlots: [{
        nodeId: 'director', inputName: 'builder_state', token: '{{positive}}', occurrences: 1,
      }],
    })
  })

  it('binds exact image-role literals and rejects an explicit mapping that contradicts them', async () => {
    const { registry } = createRegistry()
    const single = {
      text: { class_type: 'Text', inputs: { value: '{{positive}}' } },
      image: { class_type: 'LoadImage', inputs: { image: '{{start_image}}' } },
      output: { class_type: 'SaveVideo', inputs: { images: ['image', 0] } },
    }
    expect(registry.analyzeTemplate(single)).toMatchObject({
      ok: true,
      slots: { inputImages: [{ nodeId: 'image', inputName: 'image', name: 'start_image' }] },
    })

    const registered = await registry.registerTemplate({
      name: 'Single exact image role',
      kind: 'video',
      mode: 'i2v',
      graphJson: single,
      promptProfile: 'wan-motion',
    })
    const instantiated = await registry.instantiate(registered.template.id, {
      positive: 'move', start_image: 'risu/start.png',
    })
    expect(instantiated.prompt.image.inputs.image).toBe('risu/start.png')

    const multiple = {
      ...single,
      last: { class_type: 'LoadImage', inputs: { image: '{{end_image}}' } },
    }
    await expect(registry.registerTemplate({
      name: 'Contradictory exact roles',
      kind: 'video',
      mode: 'flf2v',
      graphJson: multiple,
      slotResolution: {
        inputImages: [
          { nodeId: 'image', name: 'end_image' },
          { nodeId: 'last', name: 'start_image' },
        ],
      },
      promptProfile: 'wan-motion',
    })).rejects.toMatchObject({ code: 'COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID' })

    const exactMultiple = await registry.registerTemplate({
      name: 'Matching exact roles',
      kind: 'video',
      mode: 'flf2v',
      graphJson: multiple,
      slotResolution: {
        inputImages: [
          { nodeId: 'image', name: 'start_image' },
          { nodeId: 'last', name: 'end_image' },
        ],
      },
      promptProfile: 'wan-motion',
    })
    const exactMultipleInstance = await registry.instantiate(exactMultiple.template.id, {
      positive: 'move between frames',
      start_image: 'risu/start.png',
      end_image: 'risu/end.png',
    })
    expect(exactMultipleInstance.prompt.image.inputs.image).toBe('risu/start.png')
    expect(exactMultipleInstance.prompt.last.inputs.image).toBe('risu/end.png')

    const duplicateRole = structuredClone(multiple)
    duplicateRole.last.inputs.image = '{{start_image}}'
    expect(registry.analyzeTemplate(duplicateRole)).toMatchObject({
      ok: false,
      errors: [{ code: 'COMFY_TEMPLATE_IMAGE_ROLE_AMBIGUOUS' }],
    })
  })

  it('round-trips analyze, explicit ambiguity resolution, registration, load, and hard removal', async () => {
    const { registry } = createRegistry()
    const custom = graph({
      positive: 'describe this',
      images: ['start', 'end'],
      outputs: [['sink', 'DaSiWa_EnhancedVideoCombine']],
    })
    const analyzed = registry.analyzeTemplate(custom)
    expect(analyzed).toMatchObject({
      ok: true,
      slots: {
        positive: [{ nodeId: 'text', inputName: 'text' }],
        inputImages: expect.any(Array),
      },
      output: null,
    })

    await expect(registry.registerTemplate({
      name: 'DaSiWa H3',
      kind: 'video',
      mode: 'flf2v',
      graphJson: custom,
      promptProfile: 'h3-structured',
    })).rejects.toMatchObject({ code: 'COMFY_TEMPLATE_RESOLUTION_REQUIRED' })

    const registered = await registry.registerTemplate({
      name: 'DaSiWa H3',
      kind: 'video',
      mode: 'flf2v',
      graphJson: custom,
      slotResolution: {
        positive: { nodeId: 'text', inputName: 'text' },
        inputImages: [
          { nodeId: 'start', name: 'start_image' },
          { nodeId: 'end', name: 'end_image' },
        ],
      },
      outputDescriptor: {
        nodeId: 'sink',
        classType: 'DaSiWa_EnhancedVideoCombine',
        historyKey: 'videos',
        mediaType: 'video/mp4',
      },
      promptProfile: 'h3-structured',
    })
    expect(registered).toMatchObject({
      created: true,
      template: {
        id: expect.stringMatching(/^[a-f0-9]{64}$/),
        source: 'custom',
        name: 'DaSiWa H3',
        kind: 'video',
        mode: 'flf2v',
      },
    })

    const instantiated = await registry.instantiate(registered.template.id, {
      positive: 'resolved prompt',
      start_image: 'risu/start.png',
      end_image: 'risu/end.png',
      seed: 42,
    })
    expect(instantiated.prompt.text.inputs.text).toBe('resolved prompt')
    expect(instantiated.prompt.start.inputs.image).toBe('risu/start.png')
    expect(instantiated.prompt.end.inputs.image).toBe('risu/end.png')
    expect(instantiated.prompt.sampler.inputs.seed).toBe(42)
    expect(instantiated.outputDescriptor).toEqual(registered.template.outputDescriptor)

    await expect(registry.instantiate(registered.template.id, {
      positive: 'missing end', start_image: 'risu/start.png', seed: 42,
    })).rejects.toMatchObject({ code: 'COMFY_SLOT_MISSING' })
    await expect(registry.instantiate(registered.template.id, {
      positive: 'extra', start_image: 'risu/start.png', end_image: 'risu/end.png', seed: 42, typo: 'x',
    })).rejects.toMatchObject({ code: 'COMFY_SLOT_UNKNOWN' })
    await expect(registry.instantiate(registered.template.id, {
      positive: 'wrong type', start_image: 12, end_image: 'risu/end.png', seed: 1.5,
    })).rejects.toMatchObject({ code: 'COMFY_SLOT_INVALID' })

    await expect(registry.removeTemplate(registered.template.id)).resolves.toEqual({
      id: registered.template.id,
      removed: true,
    })
    await expect(registry.loadTemplate(registered.template.id)).rejects.toMatchObject({
      code: 'COMFY_TEMPLATE_NOT_FOUND',
    })
  })

  it('is idempotent only for the same immutable registration and rejects graph-hash metadata conflicts', async () => {
    const { registry } = createRegistry()
    const input = {
      name: 'Still image',
      kind: 'image',
      mode: 't2i',
      graphJson: graph({ images: [], outputs: [['save', 'SaveImage']] }),
      promptProfile: 'image-tags',
    }
    const first = await registry.registerTemplate(input)
    await expect(registry.registerTemplate(input)).resolves.toMatchObject({
      created: false,
      template: { id: first.template.id, createdAt: first.template.createdAt },
    })
    await expect(registry.registerTemplate({ ...input, name: 'Renamed' })).rejects.toMatchObject({
      code: 'COMFY_TEMPLATE_CONFLICT',
      httpStatus: 409,
    })
  })

  it('registers a numeric duration binding and exposes its captured default in template metadata', async () => {
    const { registry } = createRegistry()
    const custom = graph({ images: [] })
    custom.director = { class_type: 'DasiwaDirector', inputs: { duration: 5 } }

    const registered = await registry.registerTemplate({
      name: 'Duration video',
      kind: 'video',
      mode: 't2v',
      graphJson: custom,
      slotResolution: { duration: { nodeId: 'director', inputName: 'duration' } },
      promptProfile: 'h3-structured',
    })

    expect(registered.template).toMatchObject({
      slots: expect.arrayContaining([{
        name: 'duration',
        type: 'number',
        required: false,
        exclusiveMinimum: 0,
        defaultValue: 5,
      }]),
      slotBindings: {
        duration: { nodeId: 'director', inputName: 'duration', defaultValue: 5 },
      },
    })
    expect(await registry.listTemplates('video')).toContainEqual(expect.objectContaining({
      id: registered.template.id,
      slotBindings: expect.objectContaining({
        duration: { nodeId: 'director', inputName: 'duration', defaultValue: 5 },
      }),
    }))
  })

  it('compiles an explicit duration as a number and injects the registered default when omitted', async () => {
    const { registry } = createRegistry()
    const custom = graph({ images: [] })
    custom.director = { class_type: 'DasiwaDirector', inputs: { duration: 5 } }
    const registered = await registry.registerTemplate({
      name: 'Duration compile video',
      kind: 'video',
      mode: 't2v',
      graphJson: custom,
      slotResolution: { duration: { nodeId: 'director', inputName: 'duration' } },
      promptProfile: 'h3-structured',
    })

    const explicit = await registry.instantiate(registered.template.id, {
      positive: 'move', seed: 9, duration: 7.5,
    })
    expect(explicit.prompt.director.inputs.duration).toBe(7.5)
    expect(typeof explicit.prompt.director.inputs.duration).toBe('number')

    const defaulted = await registry.instantiate(registered.template.id, {
      positive: 'move', seed: 9,
    })
    expect(defaulted.prompt.director.inputs.duration).toBe(5)
    expect(typeof defaulted.prompt.director.inputs.duration).toBe('number')
  })

  it('rejects non-positive, non-finite, non-numeric, and explicitly undefined duration values', async () => {
    const { registry } = createRegistry()
    const custom = graph({ images: [] })
    custom.director = { class_type: 'DasiwaDirector', inputs: { duration: 5 } }
    const registered = await registry.registerTemplate({
      name: 'Validated duration video',
      kind: 'video',
      mode: 't2v',
      graphJson: custom,
      slotResolution: { duration: { nodeId: 'director', inputName: 'duration' } },
      promptProfile: 'h3-structured',
    })

    for (const duration of [0, -1, '5', Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      await expect(registry.instantiate(registered.template.id, {
        positive: 'move', seed: 9, duration,
      })).rejects.toMatchObject({ code: 'COMFY_SLOT_INVALID' })
    }
  })

  it('rejects duration resolutions that do not target a positive numeric graph input', async () => {
    const { registry } = createRegistry()
    for (const defaultValue of ['5', 0, -1]) {
      const custom = graph({ images: [] })
      custom.director = { class_type: 'DasiwaDirector', inputs: { duration: defaultValue } }

      await expect(registry.registerTemplate({
        name: 'Invalid duration video',
        kind: 'video',
        mode: 't2v',
        graphJson: custom,
        slotResolution: { duration: { nodeId: 'director', inputName: 'duration' } },
        promptProfile: 'h3-structured',
      })).rejects.toMatchObject({ code: 'COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID' })
    }
  })

  it('rejects a duration binding that overlaps an existing structural slot', async () => {
    const { registry } = createRegistry()

    await expect(registry.registerTemplate({
      name: 'Overlapping duration video',
      kind: 'video',
      mode: 't2v',
      graphJson: graph({ images: [] }),
      slotResolution: { duration: { nodeId: 'sampler', inputName: 'seed' } },
      promptProfile: 'h3-structured',
    })).rejects.toMatchObject({ code: 'COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID' })
  })

  it('enforces kind, mode, output family, image cardinality, and image role namespace together', async () => {
    const { registry } = createRegistry()
    await expect(registry.registerTemplate({
      name: 'Bad kind',
      kind: 'image',
      mode: 't2i',
      graphJson: graph({ images: [], outputs: [['save', 'SaveVideo']] }),
      promptProfile: 'image-tags',
    })).rejects.toMatchObject({ code: 'COMFY_TEMPLATE_KIND_OUTPUT_MISMATCH' })
    await expect(registry.registerTemplate({
      name: 'Bad mode',
      kind: 'video',
      mode: 't2v',
      graphJson: graph({ images: ['input'] }),
      promptProfile: 'wan-motion',
    })).rejects.toMatchObject({ code: 'COMFY_TEMPLATE_IMAGE_CARDINALITY' })
    await expect(registry.registerTemplate({
      name: 'Reference video without references',
      kind: 'video',
      mode: 'ref2v',
      graphJson: graph({ images: [] }),
      promptProfile: 'wan-motion',
    })).rejects.toMatchObject({ code: 'COMFY_TEMPLATE_IMAGE_CARDINALITY' })

    const ambiguous = graph({ images: ['first', 'second'] })
    for (const inputImages of [
      [{ nodeId: 'first', name: 'positive' }, { nodeId: 'second', name: 'end_image' }],
      [{ nodeId: 'first', name: 'start_image' }, { nodeId: 'second', name: 'start_image' }],
      [{ nodeId: 'first', name: 'arbitrary_role' }, { nodeId: 'second', name: 'end_image' }],
    ]) {
      await expect(registry.registerTemplate({
        name: 'Bad roles',
        kind: 'video',
        mode: 'flf2v',
        graphJson: ambiguous,
        slotResolution: { inputImages },
        promptProfile: 'wan-motion',
      })).rejects.toMatchObject({ code: 'COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID' })
    }
  })

  it('auto-detects all three standard output descriptors and requires an explicit safe custom descriptor', async () => {
    const { registry } = createRegistry()
    expect(registry.analyzeTemplate(graph({ outputs: [['vhs', 'VHS_VideoCombine']] })).output).toEqual({
      nodeId: 'vhs', classType: 'VHS_VideoCombine', historyKey: 'gifs', mediaType: 'video/mp4',
    })
    expect(registry.analyzeTemplate(graph({ outputs: [['video', 'SaveVideo']] })).output).toEqual({
      nodeId: 'video', classType: 'SaveVideo', historyKey: 'images', mediaType: 'video/mp4',
    })
    expect(registry.analyzeTemplate(graph({ outputs: [['image', 'SaveImage']] })).output).toEqual({
      nodeId: 'image', classType: 'SaveImage', historyKey: 'images', mediaType: 'image/png',
    })
    expect(registry.analyzeTemplate(graph({ outputs: [
      ['video', 'SaveVideo'],
      ['image', 'SaveImage'],
    ] })).output).toHaveLength(2)

    await expect(registry.registerTemplate({
      name: 'Unsafe history',
      kind: 'video',
      mode: 't2v',
      graphJson: graph({ outputs: [['sink', 'CustomSink']] }),
      outputDescriptor: {
        nodeId: 'sink', classType: 'CustomSink', historyKey: '__proto__', mediaType: 'video/mp4',
      },
      promptProfile: 'h3-structured',
    })).rejects.toMatchObject({ code: 'COMFY_TEMPLATE_OUTPUT_INVALID' })
  })

  it('rejects misplaced legacy placeholders and prompt paths that overlap image or seed bindings', async () => {
    const { registry } = createRegistry()
    for (const invalid of [
      {
        text: { class_type: 'Text', inputs: { value: '{{input_image}}' } },
        sampler: { class_type: 'SamplerCustom', inputs: { seed: 1 } },
        output: { class_type: 'SaveVideo', inputs: { images: ['sampler', 0] } },
      },
      {
        text: { class_type: 'Text', inputs: { value: '{{seed}}' } },
        sampler: { class_type: 'SamplerCustom', inputs: { seed: 1 } },
        output: { class_type: 'SaveVideo', inputs: { images: ['sampler', 0] } },
      },
      {
        text: { class_type: 'Text', inputs: { value: '{{start_image}}' } },
        sampler: { class_type: 'SamplerCustom', inputs: { seed: 1 } },
        output: { class_type: 'SaveVideo', inputs: { images: ['sampler', 0] } },
      },
    ]) {
      expect(registry.analyzeTemplate(invalid)).toMatchObject({
        ok: false,
        errors: [{ code: 'COMFY_TEMPLATE_PLACEHOLDER_INVALID' }],
      })
    }

    for (const invalid of [
      {
        sampler: { class_type: 'SamplerCustom', inputs: { seed: '{{positive}}' } },
        output: { class_type: 'SaveVideo', inputs: { images: ['sampler', 0] } },
      },
      {
        image: { class_type: 'LoadImage', inputs: { image: '{{positive}}' } },
        sampler: { class_type: 'SamplerCustom', inputs: { seed: 1 } },
        output: { class_type: 'SaveVideo', inputs: { images: ['sampler', 0] } },
      },
    ]) {
      expect(registry.analyzeTemplate(invalid)).toMatchObject({
        ok: false,
        errors: [{ code: 'COMFY_TEMPLATE_SLOT_OVERLAP' }],
      })
    }

    const mappedSeedCandidate = {
      text: { class_type: 'Text', inputs: { value: 'ordinary prompt' } },
      sampler: { class_type: 'SamplerCustom', inputs: { seed: 'not a prompt candidate' } },
      output: { class_type: 'SaveVideo', inputs: { images: ['sampler', 0] } },
    }
    await expect(registry.registerTemplate({
      name: 'Overlap by resolution',
      kind: 'video',
      mode: 't2v',
      graphJson: mappedSeedCandidate,
      slotResolution: { positive: { nodeId: 'sampler', inputName: 'seed' } },
      promptProfile: 'wan-motion',
    })).rejects.toMatchObject({ code: 'COMFY_TEMPLATE_RESOLUTION_REQUIRED' })

    const legacyPlaced = await registry.registerTemplate({
      name: 'Correct legacy placeholders',
      kind: 'video',
      mode: 'i2v',
      graphJson: {
        text: { class_type: 'Text', inputs: { value: '{{positive}}' } },
        image: { class_type: 'LoadImage', inputs: { image: '{{input_image}}' } },
        sampler: { class_type: 'SamplerCustom', inputs: { seed: '{{seed}}' } },
        output: { class_type: 'SaveVideo', inputs: { images: ['sampler', 0] } },
      },
      promptProfile: 'wan-motion',
    })
    const compiled = await registry.instantiate(legacyPlaced.template.id, {
      positive: 'placed correctly', input_image: 'risu/input.png', seed: 55,
    })
    expect(compiled.prompt.image.inputs.image).toBe('risu/input.png')
    expect(compiled.prompt.sampler.inputs.seed).toBe(55)
  })

  it('merges source-tagged built-ins and custom templates while preserving the legacy built-in manifest', async () => {
    const { registry } = createRegistry()
    await registry.registerTemplate({
      name: 'Still',
      kind: 'image',
      mode: 't2i',
      graphJson: graph({ images: [], outputs: [['save', 'SaveImage']] }),
      promptProfile: 'image-tags',
    })

    const all = await registry.listTemplates()
    expect(all.filter((item: any) => item.source === 'builtin').map((item: any) => item.id)).toEqual([
      'wan-i2v',
      'wan22-flf2v-loop',
    ])
    expect(all.find((item: any) => item.id === 'wan-i2v')).toMatchObject({
      source: 'builtin',
      kind: 'video',
      mode: 'i2v',
      slots: [
        { name: 'input_image', type: 'imageAsset', required: true },
        { name: 'positive', type: 'string', required: true },
        {
          name: 'seed',
          type: 'integer',
          required: true,
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
        },
      ],
    })
    expect(await registry.listTemplates('image')).toEqual([
      expect.objectContaining({ source: 'custom', kind: 'image', name: 'Still' }),
    ])
  })
})
