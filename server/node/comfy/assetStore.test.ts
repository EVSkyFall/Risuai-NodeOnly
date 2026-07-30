// @vitest-environment node

import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
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
    fetchImpl?: typeof fetch
    kvSet?: (key: string, value: Buffer) => void
    kvDel?: (key: string) => void
    rename?: typeof rename
    now?: () => number
  }) => {
    readInputAsset: (assetId: string) => Promise<any>
    uploadInput: (endpointUrl: string, jobId: string, input: any) => Promise<string>
    materializeOutput: (endpointUrl: string, jobId: string, output: any, options?: any) => Promise<any>
    recoverMaterialization: (jobId: string, options?: any) => Promise<any>
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

  it('uploads an immutable job-scoped filename and trusts only the returned Comfy path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-upload-'))
    dirs.push(root)
    let capturedUrl = ''
    let capturedBody: FormData | null = null
    const assets = createComfyAssetStore({
      inlayDir: path.join(root, 'inlays'),
      stagingDir: path.join(root, 'staging'),
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url)
        capturedBody = init?.body as FormData
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
    expect(capturedBody?.get('overwrite')).toBe('false')
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
