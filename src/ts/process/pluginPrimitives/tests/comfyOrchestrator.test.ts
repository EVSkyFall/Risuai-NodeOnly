import { describe, expect, it, vi } from 'vitest'

vi.mock('src/ts/globalApi.svelte', () => ({
  forageStorage: {
    async createAuth() {
      return 'test-jwt'
    },
  },
}))

const { createComfySandboxApi } = await import('../comfyOrchestrator')

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
})
