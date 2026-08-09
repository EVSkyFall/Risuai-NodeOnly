// @vitest-environment node

import Database from 'better-sqlite3'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import assetPkg from './assetStore.cjs'
import orchestratorPkg from './orchestrator.cjs'
import registryPkg from './templateRegistry.cjs'
import storePkg from './store.cjs'

const { createComfyAssetStore } = assetPkg as any
const { createComfyOrchestrator } = orchestratorPkg as any
const { createTemplateRegistry } = registryPkg as any
const { createComfyStore } = storePkg as any
const templateDir = fileURLToPath(new URL('./templates/', import.meta.url))
const dirs: string[] = []
const dbs: any[] = []

afterEach(async () => {
  for (const db of dbs.splice(0)) db.close()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })))
})

async function writeImage(inlayDir: string, id: string) {
  await mkdir(inlayDir, { recursive: true })
  await writeFile(path.join(inlayDir, `${id}.png`), Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex'))
  await writeFile(path.join(inlayDir, `${id}.meta.json`), JSON.stringify({
    ext: 'png', name: `${id}.png`, type: 'image',
  }))
}

describe('Comfy custom template orchestration', () => {
  it('runs a zero-input image template from its immutable snapshot after hard deletion', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-custom-image-'))
    dirs.push(root)
    const inlayDir = path.join(root, 'inlays')
    const png = Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex')
    let promptCalls = 0
    let uploadCalls = 0
    let submittedPrompt: any
    const fetchImpl = (async (urlValue: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(urlValue))
      if (url.pathname === '/system_stats') return Response.json({ system: {} })
      if (url.pathname === '/upload/image') {
        uploadCalls += 1
        throw new Error('t2i must not upload an input')
      }
      if (url.pathname === '/queue') return Response.json({ queue_running: [], queue_pending: [] })
      if (url.pathname === '/history') return Response.json({})
      if (url.pathname === '/prompt') {
        promptCalls += 1
        submittedPrompt = JSON.parse(String(init?.body)).prompt
        return Response.json({ prompt_id: 'image-prompt' })
      }
      if (url.pathname === '/history/image-prompt') {
        return Response.json({
          'image-prompt': {
            outputs: { save: { images: [{ filename: 'still.png', subfolder: 'art', type: 'output' }] } },
            status: { status_str: 'success', completed: true, messages: [] },
          },
        })
      }
      if (url.pathname === '/view') {
        expect(url.searchParams.get('filename')).toBe('still.png')
        expect(url.searchParams.get('subfolder')).toBe('art')
        expect(url.searchParams.get('type')).toBe('output')
        return new Response(png, { headers: { 'content-type': 'image/png' } })
      }
      throw new Error(`Unexpected request ${url.pathname}`)
    }) as typeof fetch

    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, { defaultTemplateDir: templateDir })
    const registry = createTemplateRegistry({ templateDir, store })
    const registered = await registry.registerTemplate({
      name: 'Custom still',
      kind: 'image',
      mode: 't2i',
      graphJson: {
        text: { class_type: 'CLIPTextEncode', inputs: { text: '{{positive}}' } },
        samplerA: { class_type: 'SamplerCustom', inputs: { seed: 1 } },
        samplerB: { class_type: 'RandomNoise', inputs: { noise_seed: 2 } },
        save: { class_type: 'SaveImage', inputs: { images: ['samplerA', 0] } },
      },
      promptProfile: 'image-tags',
    })
    const orchestrator = createComfyOrchestrator({
      store,
      registry,
      assets: createComfyAssetStore({ inlayDir, stagingDir: path.join(root, 'staging'), fetchImpl }),
      fetchImpl,
    })
    await orchestrator.updateEndpoint('http://127.0.0.1:8188')
    const submitted = await orchestrator.submit({
      operationKey: 'custom-still-op',
      template: registered.template.id,
      slots: { positive: 'a quiet portrait', seed: 1234 },
    })
    const raw = store.getJob(submitted.jobId)
    store.updateJob(raw.jobId, raw.revision, 'queued', { state: 'submitting' })
    await orchestrator.runOnce()
    expect(store.getJob(submitted.jobId)).toMatchObject({ state: 'queued', remoteInputs: {} })

    await registry.removeTemplate(registered.template.id)
    await orchestrator.runOnce()
    await orchestrator.runOnce()
    expect(await orchestrator.poll(submitted.jobId)).toMatchObject({
      state: 'succeeded',
      mimeType: 'image/png',
      resultAssetId: `comfy-${submitted.jobId}`,
    })
    expect(uploadCalls).toBe(0)
    expect(promptCalls).toBe(1)
    expect(submittedPrompt.text.inputs.text).toBe('a quiet portrait')
    expect(submittedPrompt.samplerA.inputs.seed).toBe(1234)
    expect(submittedPrompt.samplerB.inputs.noise_seed).toBe(1234)
    expect(await readFile(path.join(inlayDir, `comfy-${submitted.jobId}.png`))).toEqual(png)

    await expect(orchestrator.submit({
      operationKey: 'custom-still-op',
      template: registered.template.id,
      slots: { positive: 'a quiet portrait', seed: 1234 },
    })).resolves.toMatchObject({ jobId: submitted.jobId })
    await expect(orchestrator.submit({
      operationKey: 'custom-still-op',
      template: registered.template.id,
      slots: { positive: 'changed', seed: 1234 },
    })).rejects.toMatchObject({ code: 'COMFY_OPERATION_KEY_CONFLICT' })
  })

  it('resolves an omitted duration before storing and submits the numeric default', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-duration-default-'))
    dirs.push(root)
    let submittedPrompt: any
    const fetchImpl = (async (urlValue: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(urlValue))
      if (url.pathname === '/system_stats') return Response.json({ system: {} })
      if (url.pathname === '/queue') return Response.json({ queue_running: [], queue_pending: [] })
      if (url.pathname === '/history') return Response.json({})
      if (url.pathname === '/prompt') {
        submittedPrompt = JSON.parse(String(init?.body)).prompt
        return Response.json({ prompt_id: 'duration-default-prompt' })
      }
      throw new Error(`Unexpected request ${url.pathname}`)
    }) as typeof fetch

    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, { defaultTemplateDir: templateDir })
    const registry = createTemplateRegistry({ templateDir, store })
    const registered = await registry.registerTemplate({
      name: 'Duration default video',
      kind: 'video',
      mode: 't2v',
      graphJson: {
        text: { class_type: 'Text', inputs: { value: '{{positive}}' } },
        director: { class_type: 'DasiwaDirector', inputs: { duration: 5 } },
        sampler: { class_type: 'SamplerCustom', inputs: { seed: 1 } },
        output: { class_type: 'SaveVideo', inputs: { images: ['sampler', 0] } },
      },
      slotResolution: { duration: { nodeId: 'director', inputName: 'duration' } },
      promptProfile: 'h3-structured',
    })
    const orchestrator = createComfyOrchestrator({
      store,
      registry,
      assets: createComfyAssetStore({
        inlayDir: path.join(root, 'inlays'),
        stagingDir: path.join(root, 'staging'),
        fetchImpl,
      }),
      fetchImpl,
    })
    await orchestrator.updateEndpoint('http://127.0.0.1:8188')

    const submitted = await orchestrator.submit({
      operationKey: 'duration-default-op',
      template: registered.template.id,
      slots: { positive: 'move', seed: 12 },
    })
    expect(store.getJob(submitted.jobId).slots).toEqual({ positive: 'move', seed: 12, duration: 5 })

    await orchestrator.runOnce()
    expect(submittedPrompt.director.inputs.duration).toBe(5)
    expect(typeof submittedPrompt.director.inputs.duration).toBe('number')
  })

  it('rejects duration on a template that does not declare the slot', async () => {
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, { defaultTemplateDir: templateDir })
    const registry = createTemplateRegistry({ templateDir, store })
    const orchestrator = createComfyOrchestrator({ store, registry, assets: {} })

    await expect(orchestrator.submit({
      operationKey: 'undeclared-duration-op',
      template: 'wan-i2v',
      slots: { positive: 'move', input_image: 'missing', seed: 12, duration: 5 },
    })).rejects.toMatchObject({ code: 'COMFY_SLOT_UNKNOWN' })
  })

  it('accepts only positive finite duration values at submit', async () => {
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, { defaultTemplateDir: templateDir })
    const registry = createTemplateRegistry({ templateDir, store })
    const registered = await registry.registerTemplate({
      name: 'Validated submit duration',
      kind: 'video',
      mode: 't2v',
      graphJson: {
        text: { class_type: 'Text', inputs: { value: '{{positive}}' } },
        director: { class_type: 'DasiwaDirector', inputs: { duration: 5 } },
        sampler: { class_type: 'SamplerCustom', inputs: { seed: 1 } },
        output: { class_type: 'SaveVideo', inputs: { images: ['sampler', 0] } },
      },
      slotResolution: { duration: { nodeId: 'director', inputName: 'duration' } },
      promptProfile: 'h3-structured',
    })
    const orchestrator = createComfyOrchestrator({ store, registry, assets: {} })

    for (const [index, duration] of [0, -1, '5', Number.NaN, Number.POSITIVE_INFINITY, undefined].entries()) {
      await expect(orchestrator.submit({
        operationKey: `invalid-submit-duration-${index}`,
        template: registered.template.id,
        slots: { positive: 'move', seed: 12, duration },
      })).rejects.toMatchObject({ code: 'COMFY_SLOT_INVALID' })
    }
  })

  it('includes resolved duration in binding hashes and replay identity', async () => {
    const fetchImpl = (async (urlValue: string | URL | Request) => {
      const url = new URL(String(urlValue))
      if (url.pathname === '/system_stats') return Response.json({ system: {} })
      throw new Error(`Unexpected request ${url.pathname}`)
    }) as typeof fetch
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, { defaultTemplateDir: templateDir })
    const registry = createTemplateRegistry({ templateDir, store })
    const registered = await registry.registerTemplate({
      name: 'Duration binding video',
      kind: 'video',
      mode: 't2v',
      graphJson: {
        text: { class_type: 'Text', inputs: { value: '{{positive}}' } },
        director: { class_type: 'DasiwaDirector', inputs: { duration: 5 } },
        sampler: { class_type: 'SamplerCustom', inputs: { seed: 1 } },
        output: { class_type: 'SaveVideo', inputs: { images: ['sampler', 0] } },
      },
      slotResolution: { duration: { nodeId: 'director', inputName: 'duration' } },
      promptProfile: 'h3-structured',
    })
    const orchestrator = createComfyOrchestrator({ store, registry, assets: {}, fetchImpl })
    await orchestrator.updateEndpoint('http://127.0.0.1:8188')

    const first = await orchestrator.submit({
      operationKey: 'duration-binding-7',
      template: registered.template.id,
      slots: { positive: 'move', seed: 12, duration: 7 },
    })
    await expect(orchestrator.submit({
      operationKey: 'duration-binding-7',
      template: registered.template.id,
      slots: { positive: 'move', seed: 12, duration: 7 },
    })).resolves.toMatchObject({ jobId: first.jobId })
    await expect(orchestrator.submit({
      operationKey: 'duration-binding-7',
      template: registered.template.id,
      slots: { positive: 'move', seed: 12, duration: 8 },
    })).rejects.toMatchObject({ code: 'COMFY_OPERATION_KEY_CONFLICT' })

    const second = await orchestrator.submit({
      operationKey: 'duration-binding-8',
      template: registered.template.id,
      slots: { positive: 'move', seed: 12, duration: 8 },
    })
    expect(second.jobId).not.toBe(first.jobId)
    expect(store.getJob(second.jobId).bindingHash).not.toBe(store.getJob(first.jobId).bindingHash)

    const defaulted = await orchestrator.submit({
      operationKey: 'duration-binding-default',
      template: registered.template.id,
      slots: { positive: 'move', seed: 12 },
    })
    await expect(orchestrator.submit({
      operationKey: 'duration-binding-default',
      template: registered.template.id,
      slots: { positive: 'move', seed: 12, duration: 5 },
    })).resolves.toMatchObject({ jobId: defaulted.jobId })

    await registry.removeTemplate(registered.template.id)
    await expect(orchestrator.submit({
      operationKey: 'duration-binding-default',
      template: registered.template.id,
      slots: { positive: 'move', seed: 12 },
    })).resolves.toMatchObject({ jobId: defaulted.jobId })
  })

  it('preserves raw-slot replay compatibility for legacy jobs without a template-slot snapshot', async () => {
    const fetchImpl = (async (urlValue: string | URL | Request) => {
      const url = new URL(String(urlValue))
      if (url.pathname === '/system_stats') return Response.json({ system: {} })
      throw new Error(`Unexpected request ${url.pathname}`)
    }) as typeof fetch
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, { defaultTemplateDir: templateDir })
    const registry = createTemplateRegistry({ templateDir, store })
    const registered = await registry.registerTemplate({
      name: 'Legacy replay video',
      kind: 'video',
      mode: 't2v',
      graphJson: {
        text: { class_type: 'Text', inputs: { value: '{{positive}}' } },
        sampler: { class_type: 'SamplerCustom', inputs: { seed: 1 } },
        output: { class_type: 'SaveVideo', inputs: { images: ['sampler', 0] } },
      },
      promptProfile: 'h3-structured',
    })
    const orchestrator = createComfyOrchestrator({ store, registry, assets: {}, fetchImpl })
    await orchestrator.updateEndpoint('http://127.0.0.1:8188')
    const input = {
      operationKey: 'legacy-null-template-slots',
      template: registered.template.id,
      slots: { positive: 'move', seed: 12 },
    }
    const submitted = await orchestrator.submit(input)
    db.prepare('UPDATE comfy_jobs SET template_slots_json = NULL WHERE job_id = ?').run(submitted.jobId)

    await expect(orchestrator.submit(input)).resolves.toMatchObject({ jobId: submitted.jobId })
  })

  it('uses an explicit custom history key and persists multi-input upload progress before prompt submission', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-custom-video-'))
    dirs.push(root)
    const inlayDir = path.join(root, 'inlays')
    await writeImage(inlayDir, 'start')
    await writeImage(inlayDir, 'end')
    const uploads: string[] = []
    let submittedPrompt: any
    const mp4 = Buffer.from('000000186674797069736F6D0000000069736F6D', 'hex')
    const fetchImpl = (async (urlValue: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(urlValue))
      if (url.pathname === '/system_stats') return Response.json({ system: {} })
      if (url.pathname === '/upload/image') {
        uploads.push('upload')
        return Response.json({ name: `uploaded-${uploads.length}.png`, subfolder: 'risu-comfy', type: 'input' })
      }
      if (url.pathname === '/queue') return Response.json({ queue_running: [], queue_pending: [] })
      if (url.pathname === '/history') return Response.json({})
      if (url.pathname === '/prompt') {
        submittedPrompt = JSON.parse(String(init?.body)).prompt
        return Response.json({ prompt_id: 'custom-video-prompt' })
      }
      if (url.pathname === '/history/custom-video-prompt') {
        return Response.json({
          'custom-video-prompt': {
            outputs: { sink: { videos: [{ filename: 'custom.mp4', subfolder: '', type: 'output' }] } },
            status: { status_str: 'success', completed: true, messages: [] },
          },
        })
      }
      if (url.pathname === '/view') return new Response(mp4, { headers: { 'content-type': 'video/mp4' } })
      throw new Error(`Unexpected request ${url.pathname}`)
    }) as typeof fetch

    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, { defaultTemplateDir: templateDir })
    const registry = createTemplateRegistry({ templateDir, store })
    const registered = await registry.registerTemplate({
      name: 'Custom video',
      kind: 'video',
      mode: 'flf2v',
      graphJson: {
        text: { class_type: 'Text', inputs: { value: '{{positive}}' } },
        first: { class_type: 'LoadImage', inputs: { image: 'first.png' } },
        last: { class_type: 'LoadImage', inputs: { image: 'last.png' } },
        sampler: { class_type: 'SamplerCustom', inputs: { seed: 1 } },
        sink: { class_type: 'CustomVideoSink', inputs: { images: ['sampler', 0] } },
      },
      slotResolution: {
        inputImages: [
          { nodeId: 'first', name: 'start_image' },
          { nodeId: 'last', name: 'end_image' },
        ],
      },
      outputDescriptor: {
        nodeId: 'sink', classType: 'CustomVideoSink', historyKey: 'videos', mediaType: 'video/mp4',
      },
      promptProfile: 'h3-structured',
    })
    const orchestrator = createComfyOrchestrator({
      store,
      registry,
      assets: createComfyAssetStore({ inlayDir, stagingDir: path.join(root, 'staging'), fetchImpl }),
      fetchImpl,
    })
    await orchestrator.updateEndpoint('http://127.0.0.1:8188')
    const submitted = await orchestrator.submit({
      operationKey: 'custom-video-op',
      template: registered.template.id,
      slots: { positive: 'move', start_image: 'start', end_image: 'end', seed: 99 },
    })
    let job = store.getJob(submitted.jobId)
    job = store.updateJob(job.jobId, job.revision, 'queued', {
      state: 'submitting',
      remoteInputs: { start_image: 'risu-comfy/already-uploaded.png' },
      remoteInputName: 'risu-comfy/already-uploaded.png',
    })
    await orchestrator.runOnce()
    expect(store.getJob(job.jobId)).toMatchObject({
      state: 'queued',
      remoteInputs: { start_image: 'risu-comfy/already-uploaded.png' },
    })
    await orchestrator.runOnce()
    expect(uploads).toHaveLength(1)
    expect(store.getJob(job.jobId)).toMatchObject({
      state: 'remote_queued',
      promptAttemptedAt: expect.any(Number),
      remoteInputs: {
        start_image: 'risu-comfy/already-uploaded.png',
        end_image: 'risu-comfy/uploaded-1.png',
      },
    })
    expect(submittedPrompt.first.inputs.image).toBe('risu-comfy/already-uploaded.png')
    expect(submittedPrompt.last.inputs.image).toBe('risu-comfy/uploaded-1.png')
    await orchestrator.runOnce()
    expect(await orchestrator.poll(job.jobId)).toMatchObject({ state: 'succeeded', mimeType: 'video/mp4' })
  })

  it('ingests a Dasiwa WebM from the explicit gifs history key', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-dasiwa-webm-'))
    dirs.push(root)
    const inlayDir = path.join(root, 'inlays')
    const webm = Buffer.from('1A45DFA300000000', 'hex')
    const dasiwaOutput = {
      filename: '204924_00001-audio.webm',
      subfolder: 'video\\2026-08-06',
      type: 'output',
      format: 'video/webm',
      codec: 'AV1',
      container: 'WebM',
      width: 896,
      height: 608,
      fps: 24,
    }
    const dasiwaHistory = {
      gifs: [dasiwaOutput],
      images: [dasiwaOutput],
    }
    let requestedView: [string, string][] = []
    const fetchImpl = (async (urlValue: string | URL | Request) => {
      const url = new URL(String(urlValue))
      if (url.pathname === '/system_stats') return Response.json({ system: {} })
      if (url.pathname === '/queue') return Response.json({ queue_running: [], queue_pending: [] })
      if (url.pathname === '/history') return Response.json({})
      if (url.pathname === '/prompt') return Response.json({ prompt_id: 'dasiwa-webm-prompt' })
      if (url.pathname === '/history/dasiwa-webm-prompt') {
        return Response.json({
          'dasiwa-webm-prompt': {
            outputs: { '2568': dasiwaHistory },
            status: { status_str: 'success', completed: true, messages: [] },
          },
        })
      }
      if (url.pathname === '/view') {
        requestedView = [...url.searchParams.entries()]
        return new Response(webm, { headers: { 'content-type': 'video/webm' } })
      }
      throw new Error(`Unexpected request ${url.pathname}`)
    }) as typeof fetch

    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, { defaultTemplateDir: templateDir })
    const registry = createTemplateRegistry({ templateDir, store })
    const outputDescriptor = {
      nodeId: '2568',
      classType: 'DaSiWa_EnhancedVideoCombine',
      historyKey: 'gifs',
      mediaType: 'video/webm',
    }
    const registered = await registry.registerTemplate({
      name: 'Dasiwa cMMH3 V11 WebM',
      kind: 'video',
      mode: 't2v',
      graphJson: {
        text: { class_type: 'Text', inputs: { value: '{{positive}}' } },
        sampler: { class_type: 'SamplerCustom', inputs: { seed: 1 } },
        '2568': {
          class_type: 'DaSiWa_EnhancedVideoCombine',
          inputs: { images: ['sampler', 0] },
        },
      },
      outputDescriptor,
      promptProfile: 'h3-structured',
    })
    expect(registered.template.outputDescriptor).toEqual(outputDescriptor)

    const orchestrator = createComfyOrchestrator({
      store,
      registry,
      assets: createComfyAssetStore({ inlayDir, stagingDir: path.join(root, 'staging'), fetchImpl }),
      fetchImpl,
    })
    await orchestrator.updateEndpoint('http://127.0.0.1:8188')
    const submitted = await orchestrator.submit({
      operationKey: 'dasiwa-webm-op',
      template: registered.template.id,
      slots: { positive: 'move', seed: 24 },
    })
    const raw = store.getJob(submitted.jobId)
    store.updateJob(raw.jobId, raw.revision, 'queued', { state: 'submitting' })
    await orchestrator.runOnce()
    await orchestrator.runOnce()
    await orchestrator.runOnce()

    expect(await orchestrator.poll(submitted.jobId)).toMatchObject({
      state: 'succeeded',
      mimeType: 'video/webm',
      resultAssetId: `comfy-${submitted.jobId}`,
    })
    expect(requestedView).toEqual([
      ['filename', '204924_00001-audio.webm'],
      ['subfolder', 'video/2026-08-06'],
      ['type', 'output'],
    ])
    expect(await readFile(path.join(inlayDir, `comfy-${submitted.jobId}.webm`))).toEqual(webm)
    expect(JSON.parse(await readFile(
      path.join(inlayDir, `comfy-${submitted.jobId}.meta.json`),
      'utf8',
    ))).toEqual({
      ext: 'webm',
      name: '204924_00001-audio.webm',
      type: 'video',
    })
  })
})
