import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('src/ts/globalApi.svelte', () => ({
  forageStorage: {
    async createAuth() {
      return 'test-jwt'
    },
  },
}))

const { createComfySandboxApi, createDefaultComfySandboxApi } = await import('../comfyOrchestrator')

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('plugin Comfy orchestrator relay', () => {
  it('preserves typed server failures and marks a lost submit response as uncertain', async () => {
    const requests: any[] = []
    const api = createComfySandboxApi({
      transport: async body => {
        requests.push(body)
        if ((body as any).op === 'submit') throw new TypeError('connection reset')
        if ((body as any).op === 'poll') {
          return {
            status: 404,
            json: async () => ({
              ok: false,
              code: 'COMFY_JOB_NOT_FOUND',
              message: 'missing',
              uncertain: false,
            }),
          }
        }
        return { status: 200, json: async () => ({ ok: true }) }
      },
    })

    await expect(api.submit({
      operationKey: 'op-1',
      template: 'wan-i2v',
      slots: { positive: 'x', input_image: 'image-1', seed: 1 },
    })).resolves.toEqual({
      ok: false,
      code: 'COMFY_TRANSPORT_UNCERTAIN',
      message: 'connection reset',
      uncertain: true,
    })
    await expect(api.poll({ jobId: 'missing' })).resolves.toEqual({
      ok: false,
      code: 'COMFY_JOB_NOT_FOUND',
      message: 'missing',
      uncertain: false,
    })
    expect(requests).toEqual([
      {
        protocolVersion: 1,
        op: 'submit',
        operationKey: 'op-1',
        template: 'wan-i2v',
        slots: { positive: 'x', input_image: 'image-1', seed: 1 },
      },
      { protocolVersion: 1, op: 'poll', jobId: 'missing' },
    ])
  })

  it('treats a truncated submit response as uncertain after Core may have committed', async () => {
    const api = createComfySandboxApi({
      transport: async () => ({
        status: 200,
        json: async () => {
          throw new SyntaxError('truncated JSON')
        },
      }),
    })

    await expect(api.submit({
      operationKey: 'op-truncated',
      template: 'wan-i2v',
      slots: { positive: 'x', input_image: 'image-1', seed: 1 },
    })).resolves.toEqual({
      ok: false,
      code: 'COMFY_RESPONSE_INVALID',
      message: 'Core returned a non-JSON Comfy response',
      uncertain: true,
    })

    const oldCoreApi = createComfySandboxApi({
      transport: async () => ({
        status: 404,
        json: async () => {
          throw new SyntaxError('HTML 404')
        },
      }),
    })
    await expect(oldCoreApi.submit({
      operationKey: 'op-old-core',
      template: 'wan-i2v',
      slots: { positive: 'x', input_image: 'image-1', seed: 1 },
    })).resolves.toMatchObject({
      ok: false,
      code: 'COMFY_RESPONSE_INVALID',
      uncertain: false,
    })
  })

  it('treats structurally invalid submit envelopes as uncertain when Core may have committed', async () => {
    const responses = [
      { status: 502, body: { error: 'Bad Gateway' } },
      { status: 200, body: { ok: true } },
    ]
    const api = createComfySandboxApi({
      transport: async () => {
        const response = responses.shift()!
        return {
          status: response.status,
          json: async () => response.body,
        }
      },
    })
    const input = {
      operationKey: 'op-invalid-envelope',
      template: 'wan-i2v',
      slots: { positive: 'x', input_image: 'image-1', seed: 1 },
    }

    await expect(api.submit(input)).resolves.toMatchObject({
      ok: false,
      code: 'COMFY_RESPONSE_INVALID',
      uncertain: true,
    })
    await expect(api.submit(input)).resolves.toMatchObject({
      ok: false,
      code: 'COMFY_RESPONSE_INVALID',
      uncertain: true,
    })
  })

  it('sends the optional inlay target in the submit relay envelope', async () => {
    const requests: any[] = []
    const api = createComfySandboxApi({
      transport: async body => {
        requests.push(body)
        return {
          status: 200,
          json: async () => ({ ok: true, jobId: 'target-job' }),
        }
      },
    })

    await expect(api.submit({
      operationKey: 'target-submit',
      template: 'wan-i2v',
      slots: { positive: 'x', input_image: 'image-1', seed: 1 },
      target: { charId: 'character-1', chatId: 'chat-1' },
    })).resolves.toEqual({ ok: true, jobId: 'target-job' })
    expect(requests).toEqual([{
      protocolVersion: 1,
      op: 'submit',
      operationKey: 'target-submit',
      template: 'wan-i2v',
      slots: { positive: 'x', input_image: 'image-1', seed: 1 },
      target: { charId: 'character-1', chatId: 'chat-1' },
    }])
  })

  it('relays a timeline slot spec opaquely for the core to validate', async () => {
    const requests: any[] = []
    const api = createComfySandboxApi({
      transport: async body => {
        requests.push(body)
        return {
          status: 200,
          json: async () => ({ ok: true, jobId: 'timeline-job' }),
        }
      },
    })
    const timeline = {
      items: [
        { slot: 0, type: 'image' as const, assetId: 'plugin-inlay-anchor' },
        {
          // Videos address the top of the shared visual track, not slot 0.
          slot: 9,
          type: 'video' as const,
          assetId: 'comfy-reel',
          trim_start: 1,
          trim_end: 4,
          media_mode: 'video_audio' as const,
          source_width: 1152,
          source_height: 784,
        },
        { slot: 0, type: 'audio' as const, assetId: 'plugin-inlay-voice', source_duration: 6 },
      ],
    }

    await expect(api.submit({
      operationKey: 'timeline-submit',
      template: 'v16-ref2va',
      slots: { positive: 'a director document', seed: 5, timeline },
    })).resolves.toEqual({ ok: true, jobId: 'timeline-job' })
    expect(requests).toEqual([{
      protocolVersion: 1,
      op: 'submit',
      operationKey: 'timeline-submit',
      template: 'v16-ref2va',
      slots: { positive: 'a director document', seed: 5, timeline },
    }])
  })

  it('round-trips template registration operations and forwards the optional kind filter', async () => {
    const requests: any[] = []
    const graphJson = {
      text: { class_type: 'CLIPTextEncode', inputs: { text: '{{positive}}' } },
      sampler: { class_type: 'SamplerCustom', inputs: { seed: 1 } },
      save: { class_type: 'SaveImage', inputs: { images: ['sampler', 0] } },
    }
    const outputDescriptor = {
      nodeId: 'save',
      classType: 'SaveImage',
      historyKey: 'images',
      mediaType: 'image/png' as const,
    }
    const template = {
      id: 'a'.repeat(64),
      hash: 'A'.repeat(64),
      source: 'custom' as const,
      name: 'Relay still',
      kind: 'image' as const,
      mode: 't2i' as const,
      slots: [
        { name: 'positive', type: 'string' as const, required: true as const },
        { name: 'seed', type: 'integer' as const, required: true as const, minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      ],
      slotBindings: {
        positive: { nodeId: 'text', inputName: 'text' },
        inputImages: [],
        seeds: [{ nodeId: 'sampler', inputName: 'seed' }],
      },
      outputDescriptor,
      promptProfile: 'image-tags' as const,
      createdAt: 123,
    }
    const analysis = {
      ok: true,
      errors: [],
      warnings: [{
        code: 'COMFY_TEMPLATE_PLACEHOLDER_SUSPICIOUS',
        message: 'Possible template placeholder typo',
      }],
      slots: {
        positive: { nodeId: 'text', inputName: 'text' },
        negative: [{ nodeId: 'text', inputName: 'text' }],
        inputImages: [],
        seeds: [{ nodeId: 'sampler', inputName: 'seed' }],
      },
      output: outputDescriptor,
      stats: { bytes: 190, nodeCount: 3, linkCount: 1 },
    }
    const registration = {
      name: 'Relay still',
      kind: 'image' as const,
      mode: 't2i' as const,
      graphJson,
      promptProfile: 'image-tags' as const,
    }
    const api = createComfySandboxApi({
      transport: async body => {
        requests.push(body)
        switch ((body as any).op) {
          case 'analyzeTemplate':
            return { status: 200, json: async () => analysis }
          case 'registerTemplate':
            return { status: 200, json: async () => ({ ok: true, created: true, template }) }
          case 'removeTemplate':
            return { status: 200, json: async () => ({ ok: true, id: template.id, removed: true }) }
          case 'listTemplates':
            return { status: 200, json: async () => ({ ok: true, templates: [template] }) }
          default:
            throw new Error('unexpected operation')
        }
      },
    })

    await expect(api.analyzeTemplate(graphJson)).resolves.toEqual(analysis)
    await expect(api.registerTemplate(registration)).resolves.toEqual({ ok: true, created: true, template })
    await expect(api.removeTemplate(template.id)).resolves.toEqual({ ok: true, id: template.id, removed: true })
    await expect(api.listTemplates()).resolves.toEqual({ ok: true, templates: [template] })
    await expect(api.listTemplates('image')).resolves.toEqual({ ok: true, templates: [template] })
    expect(requests).toEqual([
      { protocolVersion: 1, op: 'analyzeTemplate', graphJson },
      { protocolVersion: 1, op: 'registerTemplate', ...registration },
      { protocolVersion: 1, op: 'removeTemplate', id: template.id },
      { protocolVersion: 1, op: 'listTemplates' },
      { protocolVersion: 1, op: 'listTemplates', kind: 'image' },
    ])
  })

  it('keeps invalid graph analysis separate from typed relay failures', async () => {
    const invalidAnalysis = {
      ok: false,
      errors: [{ code: 'COMFY_TEMPLATE_INVALID', message: 'invalid graph' }],
      slots: { positive: [], negative: [], inputImages: [], seeds: [] },
      output: null,
      stats: {},
    }
    const api = createComfySandboxApi({
      transport: async body => {
        if ((body as any).op === 'analyzeTemplate') {
          return { status: 200, json: async () => invalidAnalysis }
        }
        return {
          status: 409,
          json: async () => ({
            ok: false,
            code: 'COMFY_TEMPLATE_CONFLICT',
            message: 'conflicting registration',
            uncertain: false,
          }),
        }
      },
    })

    await expect(api.analyzeTemplate('{}')).resolves.toEqual(invalidAnalysis)
    await expect(api.registerTemplate({
      name: 'Conflict',
      kind: 'image',
      mode: 't2i',
      graphJson: '{}',
    })).resolves.toEqual({
      ok: false,
      code: 'COMFY_TEMPLATE_CONFLICT',
      message: 'conflicting registration',
      uncertain: false,
    })
  })

  it('rejects malformed successful analysis envelopes', async () => {
    const api = createComfySandboxApi({
      transport: async () => ({
        status: 200,
        json: async () => ({ ok: true }),
      }),
    })

    await expect(api.analyzeTemplate('{}')).resolves.toEqual({
      ok: false,
      code: 'COMFY_RESPONSE_INVALID',
      message: 'Core returned an invalid Comfy response envelope',
      uncertain: false,
    })
  })

  it('uses the authenticated default transport for template registration operations', async () => {
    const id = 'b'.repeat(64)
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => ({ ok: true, id, removed: true }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(createDefaultComfySandboxApi().removeTemplate(id)).resolves.toEqual({
      ok: true,
      id,
      removed: true,
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/comfy/orchestrator', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'risu-auth': 'test-jwt',
      },
      body: JSON.stringify({ protocolVersion: 1, op: 'removeTemplate', id }),
    })
  })

  it('wires every template registration host method into the comfy sandbox aliases', () => {
    const v3 = readFileSync('src/ts/plugins/apiV3/v3.svelte.ts', 'utf8')

    expect(v3).toContain('_analyzeComfyTemplate: (graphJson: any) => comfyApi.analyzeTemplate(graphJson)')
    expect(v3).toContain('_registerComfyTemplate: (input: any) => comfyApi.registerTemplate(input)')
    expect(v3).toContain('_removeComfyTemplate: (id: string) => comfyApi.removeTemplate(id)')
    expect(v3).toContain("_listComfyTemplates: (kind?: 'video' | 'image') => comfyApi.listTemplates(kind)")
    expect(v3).toContain("'analyzeTemplate': '_analyzeComfyTemplate'")
    expect(v3).toContain("'registerTemplate': '_registerComfyTemplate'")
    expect(v3).toContain("'removeTemplate': '_removeComfyTemplate'")
    expect(v3).toContain("'listTemplates': '_listComfyTemplates'")
    expect(v3).toContain('_updateComfyTemplateMetadata: (input: any) => comfyApi.updateTemplateMetadata(input)')
    expect(v3).toContain("'updateTemplateMetadata': '_updateComfyTemplateMetadata'")
  })
})
