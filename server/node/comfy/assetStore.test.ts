// @vitest-environment node

import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import pkg from './assetStore.cjs'

const { createComfyAssetStore, validateOutputDescriptor } = pkg as {
  createComfyAssetStore: (options: {
    inlayDir: string
    stagingDir: string
    maxInputBytes?: number
    maxOutputBytes?: number
    transferTimeoutMs?: number
    uploadIdleTimeoutMs?: number
    multipartBoundaryFactory?: () => string
    fetchImpl?: typeof fetch
    kvSet?: (key: string, value: Buffer) => void
    kvDel?: (key: string) => void
    rename?: typeof rename
    now?: () => number
  }) => {
    readInputAsset: (assetId: string, mediaType?: string) => Promise<any>
    uploadInput: (endpointUrl: string, jobId: string, input: any, options?: any) => Promise<string>
    materializeOutput: (endpointUrl: string, jobId: string, output: any, options?: any) => Promise<any>
    recoverMaterialization: (jobId: string, options?: any) => Promise<any>
    removeMaterializedAsset: (assetId: string) => Promise<void>
  }
  validateOutputDescriptor: (output: any) => any
}

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })))
})

describe('Comfy input asset admission', () => {
  it('rejects preview descriptors before any output request', () => {
    expect(() => validateOutputDescriptor({
      filename: 'preview.png',
      subfolder: '',
      type: 'temp',
    })).toThrowError(expect.objectContaining({
      code: 'COMFY_OUTPUT_DESCRIPTOR_INVALID',
    }))
  })

  it('opens a canonical image inlay once and returns its immutable content identity', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-assets-'))
    dirs.push(root)
    const inlayDir = path.join(root, 'inlays')
    const stagingDir = path.join(root, 'staging')
    await writeFile(path.join(root, '.keep'), '')
    await import('node:fs/promises').then(fs => fs.mkdir(inlayDir, { recursive: true }))

    const bytes = Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex')
    await writeFile(path.join(inlayDir, 'input-1.png'), bytes)
    await writeFile(path.join(inlayDir, 'input-1.meta.json'), JSON.stringify({
      ext: 'png',
      name: 'source.png',
      type: 'image',
      width: 128,
      height: 96,
    }))

    const assets = createComfyAssetStore({ inlayDir, stagingDir, maxInputBytes: 1024 })
    await expect(assets.readInputAsset('input-1')).resolves.toMatchObject({
      assetId: 'input-1',
      ext: 'png',
      mimeType: 'image/png',
      name: 'source.png',
      width: 128,
      height: 96,
      size: bytes.length,
      hash: createHash('sha256').update(bytes).digest('hex').toUpperCase(),
      bytes,
    })
  })

  it.each([
    ['video', 'mp4', 'video/mp4', Buffer.from('000000186674797069736F6D0000000069736F6D', 'hex')],
    ['video', 'webm', 'video/webm', Buffer.from('1A45DFA30000000000000000', 'hex')],
    ['audio', 'mp3', 'audio/mpeg', Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16)])],
    ['audio', 'mp3', 'audio/mpeg', Buffer.from('FFFB90640000000000000000', 'hex')],
    ['audio', 'ogg', 'audio/ogg', Buffer.concat([Buffer.from('OggS'), Buffer.alloc(16)])],
    ['audio', 'wav', 'audio/wav', Buffer.concat([
      Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '),
    ])],
  ])('admits a %s inlay stored as .%s through the same five gates', async (mediaType, ext, mimeType, bytes) => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-media-input-'))
    dirs.push(root)
    const inlayDir = path.join(root, 'inlays')
    await mkdir(inlayDir, { recursive: true })
    await writeFile(path.join(inlayDir, `media-1.${ext}`), bytes)
    await writeFile(path.join(inlayDir, 'media-1.meta.json'), JSON.stringify({
      ext, name: `source.${ext}`, type: mediaType,
    }))

    const assets = createComfyAssetStore({ inlayDir, stagingDir: path.join(root, 'staging') })
    await expect(assets.readInputAsset('media-1', mediaType)).resolves.toMatchObject({
      assetId: 'media-1',
      ext,
      mediaType,
      mimeType,
      name: `source.${ext}`,
      size: bytes.length,
      hash: createHash('sha256').update(bytes).digest('hex').toUpperCase(),
      bytes,
    })
  })

  it('keeps the media gates type-honest in both directions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-media-gates-'))
    dirs.push(root)
    const inlayDir = path.join(root, 'inlays')
    await mkdir(inlayDir, { recursive: true })
    const png = Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex')
    await writeFile(path.join(inlayDir, 'still.png'), png)
    await writeFile(path.join(inlayDir, 'still.meta.json'), JSON.stringify({
      ext: 'png', name: 'still.png', type: 'image',
    }))
    await writeFile(path.join(inlayDir, 'reel.mp4'), png)
    await writeFile(path.join(inlayDir, 'reel.meta.json'), JSON.stringify({
      ext: 'mp4', name: 'reel.mp4', type: 'video',
    }))

    const assets = createComfyAssetStore({ inlayDir, stagingDir: path.join(root, 'staging') })
    // An image asked for as video, and the legacy code for an image slot.
    await expect(assets.readInputAsset('still', 'video')).rejects.toMatchObject({
      code: 'COMFY_INPUT_NOT_VIDEO',
    })
    await expect(assets.readInputAsset('reel')).rejects.toMatchObject({
      code: 'COMFY_INPUT_NOT_IMAGE',
    })
    await expect(assets.readInputAsset('reel', 'audio')).rejects.toMatchObject({
      code: 'COMFY_INPUT_NOT_AUDIO',
    })
    // Declared video, PNG bytes.
    await expect(assets.readInputAsset('reel', 'video')).rejects.toMatchObject({
      code: 'COMFY_INPUT_MAGIC_INVALID',
    })
    await expect(assets.readInputAsset('still', 'signature')).rejects.toMatchObject({
      code: 'COMFY_INPUT_MEDIA_TYPE_INVALID',
    })
  })

  it('uploads an immutable job-scoped filename and trusts only the returned Comfy path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-upload-'))
    dirs.push(root)
    let capturedUrl = ''
    let capturedBody: FormData | null = null
    let capturedContentLength: string | null = null
    let capturedWireBytes = 0
    const assets = createComfyAssetStore({
      inlayDir: path.join(root, 'inlays'),
      stagingDir: path.join(root, 'staging'),
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url)
        const request = new Request(url, {
          method: init?.method,
          headers: init?.headers,
          body: init?.body,
          duplex: 'half',
        } as RequestInit)
        capturedContentLength = request.headers.get('content-length')
        capturedWireBytes = (await request.clone().arrayBuffer()).byteLength
        capturedBody = await request.formData()
        return new Response(JSON.stringify({
          name: 'server-selected.png',
          subfolder: 'risu-comfy',
          type: 'input',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
    })

    const input = {
      assetId: 'input-1',
      ext: 'png',
      mimeType: 'image/png',
      name: 'source.png',
      size: 8,
      hash: '0123456789ABCDEFFEDCBA9876543210',
      bytes: Buffer.from('89504E470D0A1A0A', 'hex'),
    }
    const remotePath = await assets.uploadInput(
      'http://127.0.0.1:8188/',
      '11111111-1111-4111-8111-111111111111',
      input,
    )

    expect(capturedUrl).toBe('http://127.0.0.1:8188/upload/image')
    expect(capturedBody?.get('type')).toBe('input')
    expect(capturedBody?.get('subfolder')).toBe('risu-comfy')
    expect(capturedBody?.get('overwrite')).toBe('true')
    expect(capturedContentLength).toBe(String(capturedWireBytes))
    const uploaded = capturedBody?.get('image') as File
    expect(uploaded.name).toBe(
      'risu-11111111-1111-4111-8111-111111111111-0123456789ABCDEFFEDCBA9876543210.png',
    )
    expect(await uploaded.arrayBuffer()).toEqual(input.bytes.buffer.slice(
      input.bytes.byteOffset,
      input.bytes.byteOffset + input.bytes.byteLength,
    ))
    expect(remotePath).toBe('risu-comfy/server-selected.png')
  })

  it('sends the exact multipart Content-Length on the wire', async () => {
    let declaredLength: string | undefined
    let receivedLength = 0
    const server = createServer((request, response) => {
      declaredLength = request.headers['content-length']
      request.on('data', chunk => { receivedLength += chunk.length })
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ name: 'wire.png', subfolder: 'risu-comfy', type: 'input' }))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const address = server.address() as { port: number }
      const assets = createComfyAssetStore({
        inlayDir: path.join(tmpdir(), 'unused-inlays'),
        stagingDir: path.join(tmpdir(), 'unused-staging'),
      })
      await expect(assets.uploadInput(
        `http://127.0.0.1:${address.port}`,
        '12121212-1212-4212-8212-121212121212',
        {
          ext: 'png',
          mimeType: 'image/png',
          hash: 'WIRE',
          bytes: Buffer.alloc(128 * 1024, 7),
        },
      )).resolves.toBe('risu-comfy/wire.png')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }

    expect(declaredLength).toBe(String(receivedLength))
    expect(receivedLength).toBeGreaterThan(128 * 1024)
  })

  it('streams bounded multipart segments and regenerates a boundary that collides with payload data', async () => {
    const collidingBoundary = '----risu-comfy-collision'
    const safeBoundary = '----risu-comfy-safe'
    const candidates = [collidingBoundary, safeBoundary]
    let boundaryCalls = 0
    let maximumChunkBytes = 0
    let capturedContentType = ''
    let capturedBody = Buffer.alloc(0)
    const assets = createComfyAssetStore({
      inlayDir: path.join(tmpdir(), 'unused-inlays'),
      stagingDir: path.join(tmpdir(), 'unused-staging'),
      multipartBoundaryFactory: () => {
        boundaryCalls += 1
        return candidates.shift()!
      },
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        capturedContentType = new Headers(init?.headers).get('content-type') ?? ''
        const chunks: Buffer[] = []
        let total = 0
        const reader = (init?.body as ReadableStream<Uint8Array>).getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = Buffer.from(value)
          maximumChunkBytes = Math.max(maximumChunkBytes, chunk.length)
          total += chunk.length
          chunks.push(chunk)
        }
        capturedBody = Buffer.concat(chunks, total)
        expect(new Headers(init?.headers).get('content-length')).toBe(String(total))
        const parsed = await new Request(url, {
          method: 'POST',
          headers: init?.headers,
          body: capturedBody,
        }).formData()
        expect(parsed.get('type')).toBe('input')
        expect(parsed.get('subfolder')).toBe('risu-comfy')
        expect(parsed.get('overwrite')).toBe('true')
        expect(Buffer.from(await (parsed.get('image') as File).arrayBuffer())).toEqual(input.bytes)
        return Response.json({ name: 'streamed.png', subfolder: 'risu-comfy', type: 'input' })
      }) as typeof fetch,
    })
    const input = {
      ext: 'png',
      mimeType: 'image/png',
      hash: `HASH"\\\r\n${collidingBoundary}`,
      bytes: Buffer.concat([
        Buffer.from(`payload-${collidingBoundary}-`),
        Buffer.alloc(140 * 1024, 5),
      ]),
    }

    await expect(assets.uploadInput(
      'http://127.0.0.1:8188',
      '14141414-1414-4414-8414-141414141414',
      input,
    )).resolves.toBe('risu-comfy/streamed.png')

    expect(boundaryCalls).toBe(2)
    expect(capturedContentType).toBe(`multipart/form-data; boundary=${safeBoundary}`)
    expect(maximumChunkBytes).toBeLessThanOrEqual(64 * 1024)
    expect(capturedBody.includes(Buffer.from(`--${safeBoundary}\r\n`))).toBe(true)
    expect(capturedBody.includes(Buffer.from('HASH"\r\n'))).toBe(false)
    expect(capturedBody.includes(Buffer.from('HASH%22\\%0D%0A'))).toBe(true)
  })

  it('does not start the network transfer when the parent was aborted during local encoding', async () => {
    const parent = new AbortController()
    const abortReason = Object.assign(new Error('endpoint changed'), {
      code: 'COMFY_WORKER_PREEMPTED',
      uncertain: true,
    })
    parent.abort(abortReason)
    let fetchCalls = 0
    const assets = createComfyAssetStore({
      inlayDir: path.join(tmpdir(), 'unused-inlays'),
      stagingDir: path.join(tmpdir(), 'unused-staging'),
      fetchImpl: (async () => {
        fetchCalls += 1
        return Response.json({ name: 'must-not-upload.png', subfolder: 'risu-comfy', type: 'input' })
      }) as typeof fetch,
    })

    await expect(assets.uploadInput(
      'http://127.0.0.1:8188',
      '13131313-1313-4313-8313-131313131313',
      {
        ext: 'png',
        mimeType: 'image/png',
        hash: 'ABORTED',
        bytes: Buffer.alloc(128 * 1024, 3),
      },
      { signal: parent.signal },
    )).rejects.toBe(abortReason)
    expect(fetchCalls).toBe(0)
  })

  it('does not abort an input upload because its body transfer outlives the flat transfer timeout', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-slow-upload-'))
    dirs.push(root)
    const assets = createComfyAssetStore({
      inlayDir: path.join(root, 'inlays'),
      stagingDir: path.join(root, 'staging'),
      transferTimeoutMs: 5,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 30)
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(init.signal?.reason)
          }, { once: true })
        })
        return Response.json({ name: 'slow.png', subfolder: 'risu-comfy', type: 'input' })
      }) as typeof fetch,
    })

    await expect(assets.uploadInput(
      'http://127.0.0.1:8188',
      '45454545-4545-4545-8545-454545454545',
      {
        ext: 'png',
        mimeType: 'image/png',
        hash: 'SLOW',
        bytes: Buffer.from('89504E470D0A1A0A', 'hex'),
      },
    )).resolves.toBe('risu-comfy/slow.png')
  })

  it('aborts a half-open upload after byte progress stays idle', async () => {
    const assets = createComfyAssetStore({
      inlayDir: path.join(tmpdir(), 'unused-inlays'),
      stagingDir: path.join(tmpdir(), 'unused-staging'),
      uploadIdleTimeoutMs: 20,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => (
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
      )) as typeof fetch,
    })

    await expect(assets.uploadInput(
      'http://127.0.0.1:8188',
      '46464646-4646-4646-8646-464646464646',
      {
        ext: 'png',
        mimeType: 'image/png',
        hash: 'IDLE',
        bytes: Buffer.from('89504E470D0A1A0A', 'hex'),
      },
    )).rejects.toMatchObject({
      code: 'COMFY_UPLOAD_FAILED',
      uncertain: true,
      message: expect.stringContaining('no byte progress'),
    })
  })

  it('allows an upload to outlive the idle interval while body and response bytes keep moving', async () => {
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    let bodyChunks = 0
    let responseChunks = 0
    const responseParts = [
      Buffer.from('{"name":"progress.png","subfolder":"risu-comfy",'),
      Buffer.from('"type":"input"}'),
    ]
    const assets = createComfyAssetStore({
      inlayDir: path.join(tmpdir(), 'unused-inlays'),
      stagingDir: path.join(tmpdir(), 'unused-staging'),
      uploadIdleTimeoutMs: 500,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        for await (const _chunk of init?.body as any) {
          bodyChunks += 1
          await delay(100)
        }
        let index = 0
        return new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            await delay(100)
            if (index >= responseParts.length) {
              controller.close()
              return
            }
            responseChunks += 1
            controller.enqueue(responseParts[index++])
          },
        }))
      }) as typeof fetch,
    })

    const startedAt = Date.now()
    await expect(assets.uploadInput(
      'http://127.0.0.1:8188',
      '47474747-4747-4747-8747-474747474747',
      {
        ext: 'png',
        mimeType: 'image/png',
        hash: 'PROGRESS',
        bytes: Buffer.alloc(256 * 1024, 1),
      },
    )).resolves.toBe('risu-comfy/progress.png')

    expect(Date.now() - startedAt).toBeGreaterThan(500)
    expect(bodyChunks).toBeGreaterThan(1)
    expect(responseChunks).toBe(2)
  })

  it('marks upload transport and HTTP 5xx failures uncertain while keeping HTTP 4xx definitive', async () => {
    const input = {
      ext: 'png',
      mimeType: 'image/png',
      hash: 'FAILURE',
      bytes: Buffer.from('89504E470D0A1A0A', 'hex'),
    }
    for (const [fetchImpl, uncertain] of [
      [(async () => { throw new TypeError('connect failed') }) as typeof fetch, true],
      [(async () => new Response('upstream down', { status: 503 })) as typeof fetch, true],
      [(async () => new Response('bad input', { status: 413 })) as typeof fetch, false],
    ] as const) {
      const assets = createComfyAssetStore({
        inlayDir: path.join(tmpdir(), 'unused-inlays'),
        stagingDir: path.join(tmpdir(), 'unused-staging'),
        fetchImpl,
      })
      await expect(assets.uploadInput(
        'http://127.0.0.1:8188',
        '56565656-5656-4656-8656-565656565656',
        input,
      )).rejects.toMatchObject({
        code: 'COMFY_UPLOAD_FAILED',
        uncertain,
      })
    }
  })

  it('preserves the typed lifecycle abort while reading an upload response body', async () => {
    let signalBodyStarted!: () => void
    const bodyStarted = new Promise<void>(resolve => { signalBodyStarted = resolve })
    const parent = new AbortController()
    const abortReason = Object.assign(new Error('worker stopped'), {
      code: 'COMFY_WORKER_ABORTED',
      uncertain: true,
    })
    const assets = createComfyAssetStore({
      inlayDir: path.join(tmpdir(), 'unused-inlays'),
      stagingDir: path.join(tmpdir(), 'unused-staging'),
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        let streamController!: ReadableStreamDefaultController<Uint8Array>
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller
            controller.enqueue(Buffer.from('{'))
            signalBodyStarted()
          },
        })
        init?.signal?.addEventListener('abort', () => {
          streamController.error(new DOMException('The operation was aborted', 'AbortError'))
        }, { once: true })
        return new Response(body, {
          headers: { 'content-type': 'application/json' },
        })
      }) as typeof fetch,
    })
    const upload = assets.uploadInput(
      'http://127.0.0.1:8188',
      '23232323-2323-4232-8232-232323232323',
      {
        ext: 'png',
        mimeType: 'image/png',
        hash: 'HASH',
        bytes: Buffer.from('89504E470D0A1A0A', 'hex'),
      },
      { signal: parent.signal },
    )
    await bodyStarted
    parent.abort(abortReason)

    await expect(upload).rejects.toBe(abortReason)
  })

  it('streams the selected MP4 into a deterministic inlay and publishes payload last', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-output-'))
    dirs.push(root)
    const inlayDir = path.join(root, 'inlays')
    const stagingDir = path.join(root, 'staging')
    const kv = new Map<string, Buffer>()
    let requestedUrl = ''
    const mp4 = Buffer.from('000000186674797069736F6D0000000069736F6D', 'hex')
    const assets = createComfyAssetStore({
      inlayDir,
      stagingDir,
      fetchImpl: (async (url: string | URL | Request) => {
        requestedUrl = String(url)
        return new Response(mp4, {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': String(mp4.length) },
        })
      }) as typeof fetch,
      kvSet: (key, value) => kv.set(key, value),
      kvDel: key => kv.delete(key),
    })

    const result = await assets.materializeOutput(
      'http://127.0.0.1:8188',
      '33333333-3333-4333-8333-333333333333',
      { filename: 'result.mp4', subfolder: 'video/out', type: 'output' },
    )

    expect(requestedUrl).toBe(
      'http://127.0.0.1:8188/view?filename=result.mp4&subfolder=video%2Fout&type=output',
    )
    expect(result).toEqual({
      resultAssetId: 'comfy-33333333-3333-4333-8333-333333333333',
      mimeType: 'video/mp4',
      hash: createHash('sha256').update(mp4).digest('hex').toUpperCase(),
      size: mp4.length,
    })
    expect(await readFile(path.join(inlayDir, `${result.resultAssetId}.mp4`))).toEqual(mp4)
    expect(JSON.parse(await readFile(
      path.join(inlayDir, `${result.resultAssetId}.meta.json`),
      'utf8',
    ))).toEqual({
      ext: 'mp4',
      name: 'result.mp4',
      type: 'video',
    })
    expect(JSON.parse(kv.get(`inlay_meta/${result.resultAssetId}`)!.toString('utf8'))).toEqual({
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    })

    await expect(assets.recoverMaterialization(
      '33333333-3333-4333-8333-333333333333',
    )).resolves.toEqual(result)
  })

  it('rejects WebM output without the exact EBML magic bytes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-webm-magic-'))
    dirs.push(root)
    const assets = createComfyAssetStore({
      inlayDir: path.join(root, 'inlays'),
      stagingDir: path.join(root, 'staging'),
      fetchImpl: (async () => new Response(
        Buffer.from('1A45DF0000000000', 'hex'),
        { headers: { 'content-type': 'video/webm' } },
      )) as typeof fetch,
    })

    await expect(assets.materializeOutput(
      'http://127.0.0.1:8188',
      'webm-invalid-magic',
      { filename: 'result.webm', subfolder: '', type: 'output' },
      { mediaType: 'video/webm' },
    )).rejects.toMatchObject({ code: 'COMFY_OUTPUT_MAGIC_INVALID' })
  })

  it('crash-recovers WebM through the version 2 marker and video sidecar', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-webm-recovery-'))
    dirs.push(root)
    const inlayDir = path.join(root, 'inlays')
    const stagingDir = path.join(root, 'staging')
    const webm = Buffer.from('1A45DFA300000000', 'hex')
    let failPayloadRename = true
    const assets = createComfyAssetStore({
      inlayDir,
      stagingDir,
      fetchImpl: (async () => new Response(webm, {
        headers: { 'content-type': 'video/webm' },
      })) as typeof fetch,
      rename: async (from, to) => {
        if (failPayloadRename && String(to).endsWith('.webm')) {
          failPayloadRename = false
          throw new Error('simulated WebM payload publish crash')
        }
        await rename(from, to)
      },
    })
    const jobId = 'webm-recovery'
    const output = { filename: 'result.webm', subfolder: 'video', type: 'output' }

    await expect(assets.materializeOutput(
      'http://127.0.0.1:8188',
      jobId,
      output,
      { mediaType: 'video/webm' },
    )).rejects.toMatchObject({ code: 'COMFY_OUTPUT_PUBLISH_RETRY', retryMaterialization: true })
    expect(JSON.parse(await readFile(path.join(stagingDir, jobId, 'ready.json'), 'utf8'))).toMatchObject({
      version: 2,
      ext: 'webm',
      mediaType: 'video/webm',
      assetType: 'video',
    })

    const recovered = await assets.recoverMaterialization(jobId, { mediaType: 'video/webm', output })
    expect(recovered).toMatchObject({ mimeType: 'video/webm', resultAssetId: `comfy-${jobId}` })
    expect(await readFile(path.join(inlayDir, `${recovered.resultAssetId}.webm`))).toEqual(webm)
    expect(JSON.parse(await readFile(
      path.join(inlayDir, `${recovered.resultAssetId}.meta.json`),
      'utf8',
    ))).toEqual({ ext: 'webm', name: 'result.webm', type: 'video' })
  })

  it.each([
    ['png', 'image/png', Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex')],
    ['jpg', 'image/jpeg', Buffer.from('FFD8FFE000104A4649460001', 'hex')],
    ['webp', 'image/webp', Buffer.from('52494646040000005745425056503820', 'hex')],
  ])('materializes and crash-recovers allowlisted %s images with exact sidecars', async (ext, mimeType, bytes) => {
    const root = await mkdtemp(path.join(tmpdir(), `comfy-image-${ext}-`))
    dirs.push(root)
    const inlayDir = path.join(root, 'inlays')
    const stagingDir = path.join(root, 'staging')
    let failPayloadRename = true
    const assets = createComfyAssetStore({
      inlayDir,
      stagingDir,
      fetchImpl: (async () => new Response(bytes, {
        headers: { 'content-type': mimeType },
      })) as typeof fetch,
      rename: async (from, to) => {
        if (failPayloadRename && String(to).endsWith(`.${ext}`)) {
          failPayloadRename = false
          throw new Error('simulated image payload publish crash')
        }
        await rename(from, to)
      },
    })
    const jobId = `image-${ext}`
    const output = { filename: `result.${ext}`, subfolder: 'images', type: 'output' }

    await expect(assets.materializeOutput(
      'http://127.0.0.1:8188',
      jobId,
      output,
      { mediaType: mimeType },
    )).rejects.toMatchObject({ code: 'COMFY_OUTPUT_PUBLISH_RETRY', retryMaterialization: true })

    const recovered = await assets.recoverMaterialization(jobId, { mediaType: mimeType, output })
    expect(recovered).toMatchObject({ mimeType, resultAssetId: `comfy-${jobId}` })
    expect(await readFile(path.join(inlayDir, `${recovered.resultAssetId}.${ext}`))).toEqual(bytes)
    expect(JSON.parse(await readFile(
      path.join(inlayDir, `${recovered.resultAssetId}.meta.json`),
      'utf8',
    ))).toEqual({ ext, name: `result.${ext}`, type: 'image' })

    await assets.removeMaterializedAsset(recovered.resultAssetId)
    await expect(access(path.join(inlayDir, `${recovered.resultAssetId}.${ext}`))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects disagreement between descriptor media type, extension, response MIME, and magic', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-image-mismatch-'))
    dirs.push(root)
    const assets = createComfyAssetStore({
      inlayDir: path.join(root, 'inlays'),
      stagingDir: path.join(root, 'staging'),
      fetchImpl: (async () => new Response(
        Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex'),
        { headers: { 'content-type': 'image/png' } },
      )) as typeof fetch,
    })
    await expect(assets.materializeOutput(
      'http://127.0.0.1:8188',
      'mismatch-image',
      { filename: 'result.webp', subfolder: '', type: 'output' },
      { mediaType: 'image/png' },
    )).rejects.toMatchObject({ code: 'COMFY_OUTPUT_DESCRIPTOR_INVALID' })
  })

  it('rejects an image recovery marker that disagrees with the snapshotted history filename and extension', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-image-marker-mismatch-'))
    dirs.push(root)
    const bytes = Buffer.from('FFD8FFE000104A4649460001', 'hex')
    let failPayloadRename = true
    const assets = createComfyAssetStore({
      inlayDir: path.join(root, 'inlays'),
      stagingDir: path.join(root, 'staging'),
      fetchImpl: (async () => new Response(bytes, {
        headers: { 'content-type': 'image/jpeg' },
      })) as typeof fetch,
      rename: async (from, to) => {
        if (failPayloadRename && String(to).endsWith('.jpg')) {
          failPayloadRename = false
          throw new Error('leave ready marker for mismatch test')
        }
        await rename(from, to)
      },
    })
    const jobId = 'image-marker-mismatch'
    await expect(assets.materializeOutput(
      'http://127.0.0.1:8188',
      jobId,
      { filename: 'original.jpg', subfolder: '', type: 'output' },
      { mediaType: 'image/jpeg' },
    )).rejects.toMatchObject({ code: 'COMFY_OUTPUT_PUBLISH_RETRY' })

    await expect(assets.recoverMaterialization(jobId, {
      mediaType: 'image/jpeg',
      output: { filename: 'different.jpeg', subfolder: '', type: 'output' },
    })).rejects.toMatchObject({ code: 'COMFY_OUTPUT_MARKER_INVALID' })
  })

  it('normalizes Windows backslash subfolders from Comfy while still rejecting traversal', async () => {
    // Live incident 2026-07-30: Windows-hosted ComfyUI reports history output
    // subfolders with backslashes (e.g. "WanVideo\\2026_07_30\\원본"), which
    // the validator treated as unsafe and the completed clip was never fetched.
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-winpath-'))
    dirs.push(root)
    const inlayDir = path.join(root, 'inlays')
    const stagingDir = path.join(root, 'staging')
    const kv = new Map<string, Buffer>()
    let requestedUrl = ''
    const mp4 = Buffer.from('000000186674797069736F6D0000000069736F6D', 'hex')
    const assets = createComfyAssetStore({
      inlayDir,
      stagingDir,
      fetchImpl: (async (url: string | URL | Request) => {
        requestedUrl = String(url)
        return new Response(mp4, {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': String(mp4.length) },
        })
      }) as typeof fetch,
      kvSet: (key, value) => kv.set(key, value),
      kvDel: key => kv.delete(key),
    })

    const result = await assets.materializeOutput(
      'http://127.0.0.1:8188',
      '55555555-5555-4555-8555-555555555555',
      { filename: 'clip.mp4', subfolder: 'WanVideo\\2026_07_30\\원본', type: 'output' },
    )

    expect(requestedUrl).toBe(
      'http://127.0.0.1:8188/view?filename=clip.mp4'
      + `&subfolder=${encodeURIComponent('WanVideo/2026_07_30/원본')}&type=output`,
    )
    expect(result.mimeType).toBe('video/mp4')

    for (const traversal of ['..\\up', 'WanVideo\\..\\..\\etc', 'C:\\abs', '\\\\server\\share', '/abs']) {
      await expect(assets.materializeOutput(
        'http://127.0.0.1:8188',
        '55555555-5555-4555-8555-555555555555',
        { filename: 'clip.mp4', subfolder: traversal, type: 'output' },
      )).rejects.toMatchObject({ code: 'COMFY_UPLOAD_RESPONSE_INVALID' })
    }
  })

  it('rejects symlinked roots and declared transfers above the byte cap', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-bounds-'))
    dirs.push(root)
    const realInlays = path.join(root, 'real-inlays')
    const linkedInlays = path.join(root, 'linked-inlays')
    await mkdir(realInlays, { recursive: true })
    await writeFile(path.join(realInlays, 'input.png'), Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex'))
    await writeFile(path.join(realInlays, 'input.meta.json'), JSON.stringify({
      ext: 'png',
      name: 'input.png',
      type: 'image',
    }))
    await symlink(realInlays, linkedInlays, 'junction')

    const linked = createComfyAssetStore({
      inlayDir: linkedInlays,
      stagingDir: path.join(root, 'staging-linked'),
    })
    await expect(linked.readInputAsset('input')).rejects.toMatchObject({
      code: 'COMFY_INPUT_UNSAFE',
    })

    const cappedInput = createComfyAssetStore({
      inlayDir: realInlays,
      stagingDir: path.join(root, 'staging-input'),
      maxInputBytes: 8,
    })
    await expect(cappedInput.readInputAsset('input')).rejects.toMatchObject({
      code: 'COMFY_INPUT_TOO_LARGE',
    })

    const cappedOutput = createComfyAssetStore({
      inlayDir: realInlays,
      stagingDir: path.join(root, 'staging-output'),
      maxOutputBytes: 8,
      fetchImpl: (async () => new Response(
        Buffer.from('000000186674797069736F6D0000000069736F6D', 'hex'),
        {
          headers: {
            'content-type': 'video/mp4',
            'content-length': '20',
          },
        },
      )) as typeof fetch,
    })
    await expect(cappedOutput.materializeOutput(
      'http://127.0.0.1:8188',
      '44444444-4444-4444-8444-444444444444',
      { filename: 'large.mp4', subfolder: '', type: 'output' },
    )).rejects.toMatchObject({ code: 'COMFY_OUTPUT_TOO_LARGE' })
  })

  it('keeps a durable ready marker retryable when payload publication fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-publish-retry-'))
    dirs.push(root)
    const inlayDir = path.join(root, 'inlays')
    const stagingDir = path.join(root, 'staging')
    const jobId = '45454545-4545-4454-8454-454545454545'
    const mp4 = Buffer.from('000000186674797069736F6D0000000069736F6D', 'hex')
    let failPayloadRename = true
    const assets = createComfyAssetStore({
      inlayDir,
      stagingDir,
      fetchImpl: (async () => new Response(mp4, {
        headers: { 'content-type': 'video/mp4' },
      })) as typeof fetch,
      rename: async (source, destination) => {
        if (failPayloadRename && path.basename(String(source)) === 'payload.part') {
          failPayloadRename = false
          throw Object.assign(new Error('injected rename failure'), { code: 'EIO' })
        }
        await rename(source, destination)
      },
    })

    await expect(assets.materializeOutput(
      'http://127.0.0.1:8188',
      jobId,
      { filename: 'retry.mp4', subfolder: '', type: 'output' },
    )).rejects.toMatchObject({
      code: 'COMFY_OUTPUT_PUBLISH_RETRY',
      retryMaterialization: true,
    })
    await expect(access(path.join(stagingDir, jobId, 'ready.json'))).resolves.toBeUndefined()

    await expect(assets.recoverMaterialization(jobId)).resolves.toMatchObject({
      resultAssetId: `comfy-${jobId}`,
      mimeType: 'video/mp4',
    })
    await expect(readFile(path.join(inlayDir, `comfy-${jobId}.mp4`))).resolves.toEqual(mp4)
  })

  it('enforces the streaming cap without Content-Length and removes the partial file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-stream-cap-'))
    dirs.push(root)
    const inlayDir = path.join(root, 'inlays')
    const stagingDir = path.join(root, 'staging')
    const jobId = '46464646-4646-4464-8464-464646464646'
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('0000001866747970', 'hex'))
        controller.enqueue(Buffer.alloc(32, 1))
        controller.close()
      },
    })
    const assets = createComfyAssetStore({
      inlayDir,
      stagingDir,
      maxOutputBytes: 16,
      fetchImpl: (async () => new Response(stream, {
        headers: { 'content-type': 'video/mp4' },
      })) as typeof fetch,
    })

    await expect(assets.materializeOutput(
      'http://127.0.0.1:8188',
      jobId,
      { filename: 'large-stream.mp4', subfolder: '', type: 'output' },
    )).rejects.toMatchObject({ code: 'COMFY_OUTPUT_TOO_LARGE' })
    await expect(access(path.join(stagingDir, jobId, 'payload.part'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('enforces the 256 MiB default cap from Content-Length without allocating the body', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-default-output-cap-'))
    dirs.push(root)
    const inlayDir = path.join(root, 'inlays')
    const stagingDir = path.join(root, 'staging')
    const jobId = '47474747-4747-4474-8474-474747474747'
    const tinyMp4 = Buffer.from('000000186674797069736F6D0000000069736F6D', 'hex')
    const assets = createComfyAssetStore({
      inlayDir,
      stagingDir,
      fetchImpl: (async () => new Response(tinyMp4, {
        headers: {
          'content-type': 'video/mp4',
          'content-length': '268435457',
        },
      })) as typeof fetch,
    })

    expect(assets.maxOutputBytes).toBe(256 * 1024 * 1024)
    await expect(assets.materializeOutput(
      'http://127.0.0.1:8188',
      jobId,
      { filename: 'too-large.mp4', subfolder: '', type: 'output' },
    )).rejects.toMatchObject({ code: 'COMFY_OUTPUT_TOO_LARGE' })
    await expect(access(path.join(inlayDir, `comfy-${jobId}.mp4`))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('publishes charId and chatId metadata during initial and recovery materialization', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-target-meta-'))
    dirs.push(root)
    const inlayDir = path.join(root, 'inlays')
    const stagingDir = path.join(root, 'staging')
    const jobId = '48484848-4848-4484-8484-484848484848'
    const mp4 = Buffer.from('000000186674797069736F6D0000000069736F6D', 'hex')
    const kv = new Map<string, Buffer>()
    const assets = createComfyAssetStore({
      inlayDir,
      stagingDir,
      now: () => 123_456,
      fetchImpl: (async () => new Response(mp4, {
        headers: { 'content-type': 'video/mp4' },
      })) as typeof fetch,
      kvSet: (key, value) => kv.set(key, value),
    })
    const target = { charId: 'character-1', chatId: 'chat-1' }

    await assets.materializeOutput(
      'http://127.0.0.1:8188',
      jobId,
      { filename: 'target.mp4', subfolder: '', type: 'output' },
      { target },
    )
    expect(JSON.parse(kv.get(`inlay_meta/comfy-${jobId}`)!.toString('utf8'))).toEqual({
      createdAt: 123_456,
      updatedAt: 123_456,
      charId: 'character-1',
      chatId: 'chat-1',
    })

    kv.clear()
    await assets.recoverMaterialization(jobId, { target })
    expect(JSON.parse(kv.get(`inlay_meta/comfy-${jobId}`)!.toString('utf8'))).toMatchObject(target)
  })

  it('removes a partial download when the worker aborts its transfer', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-abort-output-'))
    dirs.push(root)
    const inlayDir = path.join(root, 'inlays')
    const stagingDir = path.join(root, 'staging')
    const jobId = '49494949-4949-4494-8494-494949494949'
    let signalStreamStarted!: () => void
    const streamStarted = new Promise<void>(resolve => { signalStreamStarted = resolve })
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      let streamController!: ReadableStreamDefaultController<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller
          controller.enqueue(Buffer.from('000000186674797069736F6D0000000069736F6D', 'hex'))
          signalStreamStarted()
        },
      })
      init?.signal?.addEventListener('abort', () => {
        streamController.error(init.signal?.reason)
      }, { once: true })
      return new Response(stream, { headers: { 'content-type': 'video/mp4' } })
    }) as typeof fetch
    const assets = createComfyAssetStore({ inlayDir, stagingDir, fetchImpl })
    const controller = new AbortController()
    const transfer = assets.materializeOutput(
      'http://127.0.0.1:8188',
      jobId,
      { filename: 'abort.mp4', subfolder: '', type: 'output' },
      { signal: controller.signal },
    )
    await streamStarted
    const abortError = Object.assign(new Error('worker stopped'), {
      code: 'COMFY_WORKER_ABORTED',
      uncertain: true,
    })
    controller.abort(abortError)

    await expect(transfer).rejects.toBe(abortError)
    await expect(access(path.join(stagingDir, jobId, 'payload.part'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
