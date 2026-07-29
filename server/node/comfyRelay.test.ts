// @vitest-environment node

import { createServer, type Server } from 'node:http'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnServer, type ServerHandle } from '../../test/compat/helpers/spawnServer.js'
import { createClient, type RisuClient } from '../../test/compat/helpers/client.js'

const coreServers: ServerHandle[] = []
const mockServers: Server[] = []

afterEach(async () => {
  await Promise.all(coreServers.splice(0).map(server => server.cleanup()))
  await Promise.all(mockServers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

async function relay(client: RisuClient, body: any) {
  const response = await client.fetch('/api/comfy/orchestrator', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, ...body }),
  })
  return { status: response.status, body: await response.json() }
}

async function listenMockComfy() {
  let submitted: any = null
  const mp4 = Buffer.from('000000186674797069736F6D0000000069736F6D', 'hex')
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks)

    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/system_stats') return res.end(JSON.stringify({ system: { test: true } }))
    if (url.pathname === '/upload/image') {
      const multipart = body.toString('latin1')
      expect(multipart).toContain('name="type"')
      expect(multipart).toContain('input')
      expect(multipart).toContain('name="overwrite"')
      expect(multipart).toContain('false')
      return res.end(JSON.stringify({ name: 'renamed by comfy.png', subfolder: 'risu-comfy', type: 'input' }))
    }
    if (url.pathname === '/prompt') {
      submitted = JSON.parse(body.toString('utf8'))
      return res.end(JSON.stringify({ prompt_id: 'integration-prompt' }))
    }
    if (url.pathname === '/history/integration-prompt') {
      return res.end(JSON.stringify({
        'integration-prompt': {
          prompt: [1, 'integration-prompt', submitted?.prompt ?? {}, { client_id: submitted?.client_id }, ['63']],
          outputs: {
            '288': { images: [{ filename: 'preview.png', subfolder: '', type: 'temp' }] },
            '63': { gifs: [{ filename: 'result.mp4', subfolder: 'video out', type: 'output' }] },
          },
          status: { status_str: 'success', completed: true, messages: [] },
        },
      }))
    }
    if (url.pathname === '/queue') {
      return res.end(JSON.stringify({ queue_running: [], queue_pending: [] }))
    }
    if (url.pathname === '/view') {
      expect(url.searchParams.get('filename')).toBe('result.mp4')
      expect(url.searchParams.get('subfolder')).toBe('video out')
      expect(url.searchParams.get('type')).toBe('output')
      res.statusCode = 200
      res.setHeader('content-type', 'video/mp4')
      res.setHeader('content-length', String(mp4.length))
      return res.end(mp4)
    }
    res.statusCode = 404
    return res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  mockServers.push(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock Comfy did not bind')
  return { url: `http://127.0.0.1:${address.port}`, mp4 }
}

describe('Comfy relay over the real NodeOnly server', { timeout: 30_000 }, () => {
  it('authenticates, submits through a node HTTP Comfy stub, and serves the resulting MP4', async () => {
    const mock = await listenMockComfy()
    const core = await spawnServer({
      env: {
        RISU_TUNNEL_DISABLED: 'true',
        RISU_UPDATE_CHECK: 'false',
      },
    })
    coreServers.push(core)
    const client = await createClient(core.port, core.password)
    const inlayDir = path.join(core.cwd, 'save', 'inlays')
    await mkdir(inlayDir, { recursive: true })
    await writeFile(path.join(inlayDir, 'source.png'), Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex'))
    await writeFile(path.join(inlayDir, 'source.meta.json'), JSON.stringify({
      ext: 'png',
      name: 'source.png',
      type: 'image',
    }))

    for (const invalid of [
      { op: 'poll', jobId: {} },
      { op: 'findByOperationKey', operationKey: false },
      { op: 'cancel', jobId: true },
    ]) {
      const response = await relay(client, invalid)
      expect(response).toMatchObject({
        status: 400,
        body: {
          ok: false,
          code: 'COMFY_REQUEST_INVALID',
          uncertain: false,
        },
      })
    }

    const updated = await relay(client, { op: 'updateEndpoint', url: mock.url })
    expect(updated.status).toBe(200)
    expect(updated.body).toMatchObject({
      ok: true,
      config: { url: mock.url, configured: true, health: { reachable: true } },
    })

    const submitted = await relay(client, {
      op: 'submit',
      operationKey: 'integration-op',
      template: 'wan-i2v',
      slots: { positive: 'integration', input_image: 'source', seed: 77 },
      target: { charId: 'integration-character', chatId: 'integration-chat' },
    })
    expect(submitted.status).toBe(200)
    expect(submitted.body).toMatchObject({ ok: true, jobId: expect.any(String) })

    let job: any = null
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const polled = await relay(client, { op: 'poll', jobId: submitted.body.jobId })
      job = polled.body.job
      if (job?.state === 'succeeded') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(job).toMatchObject({
      state: 'succeeded',
      resultAssetId: `comfy-${submitted.body.jobId}`,
      mimeType: 'video/mp4',
    })

    expect(await readFile(path.join(inlayDir, `${job.resultAssetId}.mp4`))).toEqual(mock.mp4)

    await unlink(path.join(inlayDir, 'source.png'))
    await unlink(path.join(inlayDir, 'source.meta.json'))
    const replay = await relay(client, {
      op: 'submit',
      operationKey: 'integration-op',
      template: 'wan-i2v',
      slots: { positive: 'integration', input_image: 'source', seed: 77 },
      target: { charId: 'integration-character', chatId: 'integration-chat' },
    })
    expect(replay).toEqual({
      status: 200,
      body: { ok: true, jobId: submitted.body.jobId },
    })
    expect(await relay(client, {
      op: 'submit',
      operationKey: 'integration-op',
      template: 'wan-i2v',
      slots: { positive: 'integration', input_image: 'source', seed: 77 },
      target: { charId: 'integration-character', chatId: 'different-chat' },
    })).toMatchObject({
      status: 409,
      body: { ok: false, code: 'COMFY_OPERATION_KEY_CONFLICT' },
    })
  })

  it('keeps the server live with a typed unavailable relay after Comfy startup fails', async () => {
    const core = await spawnServer({
      env: {
        RISU_TUNNEL_DISABLED: 'true',
        RISU_UPDATE_CHECK: 'false',
      },
      seedSave: async saveDir => {
        await writeFile(path.join(saveDir, 'comfy-staging'), 'not a directory')
      },
    })
    coreServers.push(core)
    const client = await createClient(core.port, core.password)

    expect(await relay(client, { op: 'getConfig' })).toMatchObject({
      status: 503,
      body: {
        ok: false,
        code: 'COMFY_UNAVAILABLE',
        uncertain: false,
      },
    })
  })
})
