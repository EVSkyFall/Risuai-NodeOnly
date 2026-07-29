// @vitest-environment node

import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import assetPkg from './assetStore.cjs'
import orchestratorPkg from './orchestrator.cjs'
import storePkg from './store.cjs'
import registryPkg from './templateRegistry.cjs'

const { createComfyAssetStore } = assetPkg as any
const { createComfyOrchestrator } = orchestratorPkg as any
const { createComfyStore } = storePkg as any
const { createTemplateRegistry } = registryPkg as any

const templateDir = fileURLToPath(new URL('./templates/', import.meta.url))
const dirs: string[] = []
const dbs: any[] = []

async function seedRemoteJob(
  store: any,
  input: { operationKey: string; promptId: string; state?: string; endpointUrl?: string },
) {
  const templateJson = await readFile(path.join(templateDir, 'wan-i2v.json'), 'utf8')
  const templateHash = createHash('sha256').update(templateJson).digest('hex').toUpperCase()
  const created = store.createOrReplayJob({
    operationKey: input.operationKey,
    binding: { templateId: 'wan-i2v', templateHash, inputHash: 'A', endpointGeneration: 1 },
    job: {
      templateId: 'wan-i2v',
      templateHash,
      templateJson,
      slots: { positive: 'seeded', input_image: 'source', seed: 1 },
      inputAssetId: 'source',
      inputHash: 'A',
      endpointUrl: input.endpointUrl ?? 'http://127.0.0.1:8188',
      endpointGeneration: 1,
      timeoutMs: 600_000,
    },
  }).job
  return store.updateJob(created.jobId, created.revision, 'queued', {
    state: input.state ?? 'remote_queued',
    promptId: input.promptId,
    remoteInputName: 'risu-comfy/source.png',
    startedAt: created.createdAt,
  })
}

afterEach(async () => {
  for (const db of dbs.splice(0)) db.close()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })))
})

describe('Comfy orchestrator', () => {
  it('runs one durable WAN job from authenticated submission to a video inlay', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-orchestrator-'))
    dirs.push(root)
    const inlayDir = path.join(root, 'inlays')
    await mkdir(inlayDir, { recursive: true })
    const png = Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex')
    await writeFile(path.join(inlayDir, 'source.png'), png)
    await writeFile(path.join(inlayDir, 'source.meta.json'), JSON.stringify({
      ext: 'png',
      name: 'source.png',
      type: 'image',
    }))

    const mp4 = Buffer.from('000000186674797069736F6D0000000069736F6D', 'hex')
    const promptBodies: any[] = []
    const fetchImpl = (async (urlValue: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(urlValue))
      if (url.pathname === '/system_stats') {
        return Response.json({ system: { comfyui_version: 'test' } })
      }
      if (url.pathname === '/upload/image') {
        return Response.json({ name: 'uploaded.png', subfolder: 'risu-comfy', type: 'input' })
      }
      if (url.pathname === '/prompt') {
        promptBodies.push(JSON.parse(String(init?.body)))
        return Response.json({ prompt_id: 'prompt-1', number: 1 })
      }
      if (url.pathname === '/history/prompt-1') {
        return Response.json({
          'prompt-1': {
            prompt: [1, 'prompt-1', {}, { client_id: promptBodies[0].client_id }, ['63']],
            outputs: {
              '63': {
                gifs: [{ filename: 'result.mp4', subfolder: 'video', type: 'output' }],
              },
            },
            status: { status_str: 'success', completed: true, messages: [] },
          },
        })
      }
      if (url.pathname === '/view') {
        return new Response(mp4, {
          headers: { 'content-type': 'video/mp4', 'content-length': String(mp4.length) },
        })
      }
      throw new Error(`Unexpected mock Comfy request: ${url.pathname}`)
    }) as typeof fetch

    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, { defaultTemplateDir: templateDir })
    const registry = createTemplateRegistry({ templateDir })
    const assets = createComfyAssetStore({
      inlayDir,
      stagingDir: path.join(root, 'staging'),
      fetchImpl,
    })
    const orchestrator = createComfyOrchestrator({
      store,
      registry,
      assets,
      fetchImpl,
      now: () => 10_000,
    })

    await orchestrator.updateEndpoint('http://127.0.0.1:8188')
    const submitted = await orchestrator.submit({
      operationKey: 'plugin-a:message-1',
      template: 'wan-i2v',
      slots: { positive: 'walking forward', input_image: 'source', seed: 123 },
    })
    expect(submitted).toMatchObject({ state: 'queued', operationKey: 'plugin-a:message-1' })

    await orchestrator.runOnce()
    expect(await orchestrator.poll(submitted.jobId)).toMatchObject({
      state: 'remote_queued',
      promptId: 'prompt-1',
    })
    await orchestrator.runOnce()

    const completed = await orchestrator.poll(submitted.jobId)
    expect(completed).toMatchObject({
      state: 'succeeded',
      resultAssetId: `comfy-${submitted.jobId}`,
      mimeType: 'video/mp4',
    })
    expect(promptBodies).toHaveLength(1)
    expect(promptBodies[0].client_id).toBe(submitted.jobId)
    expect(promptBodies[0].prompt['6'].inputs.text).toBe('walking forward')
    expect(promptBodies[0].prompt['52'].inputs.image).toBe('risu-comfy/uploaded.png')
    expect(promptBodies[0].prompt['335'].inputs.seed).toBe(123)
  })

  it('recovers a lost prompt acknowledgement from completed global history without resubmitting', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-lost-ack-'))
    dirs.push(root)
    const inlayDir = path.join(root, 'inlays')
    await mkdir(inlayDir, { recursive: true })
    const png = Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex')
    await writeFile(path.join(inlayDir, 'source.png'), png)
    await writeFile(path.join(inlayDir, 'source.meta.json'), JSON.stringify({
      ext: 'png',
      name: 'source.png',
      type: 'image',
    }))

    const mp4 = Buffer.from('000000186674797069736F6D0000000069736F6D', 'hex')
    let acceptedClientId = ''
    let promptCalls = 0
    const fetchImpl = (async (urlValue: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(urlValue))
      if (url.pathname === '/system_stats') return Response.json({ system: {} })
      if (url.pathname === '/upload/image') {
        return Response.json({ name: 'uploaded.png', subfolder: 'risu-comfy', type: 'input' })
      }
      if (url.pathname === '/prompt') {
        promptCalls += 1
        acceptedClientId = JSON.parse(String(init?.body)).client_id
        throw new TypeError('socket closed after Comfy accepted the prompt')
      }
      if (url.pathname === '/history') {
        return Response.json({
          'lost-prompt': {
            prompt: [1, 'lost-prompt', {}, { client_id: acceptedClientId }, ['63']],
            outputs: {
              '63': {
                gifs: [{ filename: 'lost.mp4', subfolder: '', type: 'output' }],
              },
            },
            status: { status_str: 'success', completed: true, messages: [] },
          },
        })
      }
      if (url.pathname === '/queue') {
        return Response.json({ queue_running: [], queue_pending: [] })
      }
      if (url.pathname === '/view') {
        return new Response(mp4, { headers: { 'content-type': 'video/mp4' } })
      }
      throw new Error(`Unexpected mock Comfy request: ${url.pathname}`)
    }) as typeof fetch

    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, { defaultTemplateDir: templateDir })
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: createComfyAssetStore({
        inlayDir,
        stagingDir: path.join(root, 'staging'),
        fetchImpl,
      }),
      fetchImpl,
      now: () => 20_000,
    })

    await orchestrator.updateEndpoint('http://127.0.0.1:8188')
    const submitted = await orchestrator.submit({
      operationKey: 'lost-ack',
      template: 'wan-i2v',
      slots: { positive: 'recover me', input_image: 'source', seed: 456 },
    })
    await orchestrator.runOnce()
    expect(await orchestrator.poll(submitted.jobId)).toMatchObject({
      state: 'unknown',
      error: { code: 'COMFY_UNREACHABLE' },
    })

    await orchestrator.runOnce()
    expect(await orchestrator.poll(submitted.jobId)).toMatchObject({
      state: 'succeeded',
      promptId: 'lost-prompt',
      resultAssetId: `comfy-${submitted.jobId}`,
    })
    expect(promptCalls).toBe(1)
  })

  it('cancels only its own pending prompt and waits for confirmed remote absence', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-cancel-'))
    dirs.push(root)
    const inlayDir = path.join(root, 'inlays')
    await mkdir(inlayDir, { recursive: true })
    const png = Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex')
    await writeFile(path.join(inlayDir, 'source.png'), png)
    await writeFile(path.join(inlayDir, 'source.meta.json'), JSON.stringify({
      ext: 'png',
      name: 'source.png',
      type: 'image',
    }))

    let deleted = false
    let deleteCalls = 0
    let interruptCalls = 0
    let clock = 30_000
    const fetchImpl = (async (urlValue: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(urlValue))
      if (url.pathname === '/system_stats') return Response.json({ system: {} })
      if (url.pathname === '/upload/image') {
        return Response.json({ name: 'uploaded.png', subfolder: 'risu-comfy', type: 'input' })
      }
      if (url.pathname === '/prompt') return Response.json({ prompt_id: 'prompt-cancel' })
      if (url.pathname === '/history/prompt-cancel') return Response.json({})
      if (url.pathname === '/queue' && init?.method === 'POST') {
        deleteCalls += 1
        expect(JSON.parse(String(init.body))).toEqual({ delete: ['prompt-cancel'] })
        deleted = true
        return new Response(null, { status: 200 })
      }
      if (url.pathname === '/queue') {
        return Response.json({
          queue_running: [],
          queue_pending: deleted
            ? []
            : [[1, 'prompt-cancel', {}, { client_id: 'owned' }, []]],
        })
      }
      if (url.pathname === '/interrupt') {
        interruptCalls += 1
        return new Response(null, { status: 200 })
      }
      throw new Error(`Unexpected mock Comfy request: ${url.pathname}`)
    }) as typeof fetch

    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, { defaultTemplateDir: templateDir })
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: createComfyAssetStore({
        inlayDir,
        stagingDir: path.join(root, 'staging'),
        fetchImpl,
      }),
      fetchImpl,
      now: () => clock,
    })
    await orchestrator.updateEndpoint('http://127.0.0.1:8188')
    const submitted = await orchestrator.submit({
      operationKey: 'cancel-pending',
      template: 'wan-i2v',
      slots: { positive: 'cancel', input_image: 'source', seed: 1 },
    })
    await orchestrator.runOnce()
    await orchestrator.cancel(submitted.jobId)
    await orchestrator.runOnce()

    expect(deleteCalls).toBe(1)
    expect(interruptCalls).toBe(0)
    expect((await orchestrator.poll(submitted.jobId)).state).toBe('cancel_requested')

    await orchestrator.runOnce()
    expect((await orchestrator.poll(submitted.jobId)).state).toBe('cancel_requested')

    clock += 1_000
    await orchestrator.runOnce()
    expect((await orchestrator.poll(submitted.jobId)).state).toBe('cancelled')
  })

  it('treats an execution error as failure before considering preview or GIF outputs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-execution-error-'))
    dirs.push(root)
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      randomUUID: () => '55555555-5555-4555-8555-555555555555',
      defaultTemplateDir: templateDir,
    })
    const job = await seedRemoteJob(store, {
      operationKey: 'execution-error',
      promptId: 'failed-prompt',
    })
    let viewCalls = 0
    const fetchImpl = (async (urlValue: string | URL | Request) => {
      const url = new URL(String(urlValue))
      if (url.pathname === '/history/failed-prompt') {
        return Response.json({
          'failed-prompt': {
            outputs: {
              '288': { images: [{ filename: 'preview.png', subfolder: '', type: 'temp' }] },
              '63': { gifs: [{ filename: 'must-not-use.mp4', subfolder: '', type: 'output' }] },
            },
            status: {
              status_str: 'error',
              completed: true,
              messages: [['execution_error', { exception_message: 'boom' }]],
            },
          },
        })
      }
      if (url.pathname === '/view') viewCalls += 1
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: createComfyAssetStore({
        inlayDir: path.join(root, 'inlays'),
        stagingDir: path.join(root, 'staging'),
        fetchImpl,
      }),
      fetchImpl,
    })

    await orchestrator.runOnce()
    expect(await orchestrator.poll(job.jobId)).toMatchObject({
      state: 'failed',
      error: { code: 'COMFY_EXECUTION_FAILED' },
    })
    expect(viewCalls).toBe(0)
  })

  it.each([
    {
      name: 'preview-only history',
      outputs: {
        '63': { images: [{ filename: 'preview.png', subfolder: '', type: 'temp' }] },
      },
    },
    {
      name: 'multiple video outputs',
      outputs: {
        '63': {
          gifs: [
            { filename: 'one.mp4', subfolder: '', type: 'output' },
            { filename: 'two.mp4', subfolder: '', type: 'output' },
          ],
        },
      },
    },
  ])('rejects $name without requesting /view', async ({ outputs }) => {
    const db = new Database(':memory:')
    dbs.push(db)
    const operationKey = `invalid-output-${dbs.length}`
    const store = createComfyStore(db, {
      randomUUID: () => `57575757-5757-4757-8757-57575757575${dbs.length}`,
      defaultTemplateDir: templateDir,
    })
    const job = await seedRemoteJob(store, {
      operationKey,
      promptId: 'invalid-output-prompt',
    })
    let viewCalls = 0
    const fetchImpl = (async (urlValue: string | URL | Request) => {
      const url = new URL(String(urlValue))
      if (url.pathname === '/history/invalid-output-prompt') {
        return Response.json({
          'invalid-output-prompt': {
            outputs,
            status: { status_str: 'success', completed: true, messages: [] },
          },
        })
      }
      if (url.pathname === '/view') viewCalls += 1
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {},
      fetchImpl,
    })

    await orchestrator.runOnce()
    expect(await orchestrator.poll(job.jobId)).toMatchObject({
      state: 'failed',
      error: { code: 'COMFY_NO_OUTPUT' },
    })
    expect(viewCalls).toBe(0)
  })

  it('cancels a queued job immediately without dispatching a prompt', async () => {
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      randomUUID: () => '58585858-5858-4858-8858-585858585858',
      defaultTemplateDir: templateDir,
    })
    const templateJson = await readFile(path.join(templateDir, 'wan-i2v.json'), 'utf8')
    const templateHash = createHash('sha256').update(templateJson).digest('hex').toUpperCase()
    const job = store.createOrReplayJob({
      operationKey: 'queued-cancel-immediate',
      binding: { templateId: 'wan-i2v', templateHash, inputHash: 'A', endpointGeneration: 1 },
      job: {
        templateId: 'wan-i2v',
        templateHash,
        templateJson,
        slots: { positive: 'cancel', input_image: 'source', seed: 1 },
        inputAssetId: 'source',
        inputHash: 'A',
        endpointUrl: 'http://127.0.0.1:8188',
        endpointGeneration: 1,
        timeoutMs: 600_000,
      },
    }).job
    let promptCalls = 0
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {},
      fetchImpl: (async () => {
        promptCalls += 1
        throw new Error('network should not be used')
      }) as typeof fetch,
    })

    await expect(orchestrator.cancel(job.jobId)).resolves.toMatchObject({ state: 'cancelled' })
    await orchestrator.runOnce()
    expect(promptCalls).toBe(0)
  })

  it('returns a typed conflict when queued-cancel CAS loses to a nonterminal state', async () => {
    const db = new Database(':memory:')
    dbs.push(db)
    const baseStore = createComfyStore(db, {
      randomUUID: () => '59595959-5959-4959-8959-595959595959',
      defaultTemplateDir: templateDir,
    })
    const templateJson = await readFile(path.join(templateDir, 'wan-i2v.json'), 'utf8')
    const templateHash = createHash('sha256').update(templateJson).digest('hex').toUpperCase()
    const job = baseStore.createOrReplayJob({
      operationKey: 'queued-cancel-conflict',
      binding: { templateId: 'wan-i2v', templateHash, inputHash: 'A', endpointGeneration: 1 },
      job: {
        templateId: 'wan-i2v',
        templateHash,
        templateJson,
        slots: { positive: 'cancel', input_image: 'source', seed: 1 },
        inputAssetId: 'source',
        inputHash: 'A',
        endpointUrl: 'http://127.0.0.1:8188',
        endpointGeneration: 1,
        timeoutMs: 600_000,
      },
    }).job
    let intercept = true
    const store = {
      ...baseStore,
      updateJob(...args: any[]) {
        if (intercept && args[0] === job.jobId && args[3]?.state === 'cancelled') {
          intercept = false
          baseStore.updateJob(job.jobId, job.revision, 'queued', { state: 'submitting' })
          return null
        }
        return baseStore.updateJob(...args)
      },
    }
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {},
      fetchImpl: async () => {
        throw new Error('network should not be used')
      },
    })

    await expect(orchestrator.cancel(job.jobId)).rejects.toMatchObject({
      code: 'COMFY_JOB_STATE_CONFLICT',
      httpStatus: 409,
    })
  })

  it('withholds global interrupt when the currently running prompt belongs to a browser job', async () => {
    let clock = 40_000
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => '66666666-6666-4666-8666-666666666666',
      defaultTemplateDir: templateDir,
    })
    const job = await seedRemoteJob(store, {
      operationKey: 'browser-race',
      promptId: 'our-prompt',
      state: 'running',
    })
    let interruptCalls = 0
    const fetchImpl = (async (urlValue: string | URL | Request) => {
      const url = new URL(String(urlValue))
      if (url.pathname === '/history/our-prompt') return Response.json({})
      if (url.pathname === '/queue') {
        return Response.json({
          queue_running: [[1, 'browser-prompt', {}, { client_id: 'browser' }, []]],
          queue_pending: [],
        })
      }
      if (url.pathname === '/interrupt') {
        interruptCalls += 1
        return new Response(null, { status: 200 })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {},
      fetchImpl,
      now: () => clock,
    })

    await orchestrator.cancel(job.jobId)
    await orchestrator.runOnce()
    expect(interruptCalls).toBe(0)
    expect((await orchestrator.poll(job.jobId)).state).toBe('cancel_requested')

    clock += 1_000
    await orchestrator.runOnce()
    expect(interruptCalls).toBe(0)
    expect((await orchestrator.poll(job.jobId)).state).toBe('cancelled')
  })

  it('turns an expired running job into a targeted interrupt and only then a timeout failure', async () => {
    let clock = 50_000
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => '77777777-7777-4777-8777-777777777777',
      defaultTemplateDir: templateDir,
    })
    const job = await seedRemoteJob(store, {
      operationKey: 'timeout-running',
      promptId: 'timeout-prompt',
      state: 'running',
    })
    clock = job.deadlineAt + 1
    let interrupted = false
    let interruptCalls = 0
    const fetchImpl = (async (urlValue: string | URL | Request) => {
      const url = new URL(String(urlValue))
      if (url.pathname === '/history/timeout-prompt') return Response.json({})
      if (url.pathname === '/queue') {
        return Response.json({
          queue_running: interrupted
            ? []
            : [[1, 'timeout-prompt', {}, { client_id: job.jobId }, []]],
          queue_pending: [],
        })
      }
      if (url.pathname === '/interrupt') {
        interruptCalls += 1
        interrupted = true
        return new Response(null, { status: 200 })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {},
      fetchImpl,
      now: () => clock,
    })

    await orchestrator.runOnce()
    expect(interruptCalls).toBe(1)
    expect(await orchestrator.poll(job.jobId)).toMatchObject({ state: 'cancel_requested' })

    clock += 1_000
    await orchestrator.runOnce()
    expect(await orchestrator.poll(job.jobId)).toMatchObject({
      state: 'failed',
      error: { code: 'COMFY_TIMEOUT' },
    })
  })

  it('reconciles persisted jobs on boot, resuming completion before confirming an orphan', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-restart-'))
    dirs.push(root)
    const dbPath = path.join(root, 'jobs.sqlite')
    const firstDb = new Database(dbPath)
    const ids = [
      '88888888-8888-4888-8888-888888888888',
      '99999999-9999-4999-8999-999999999999',
    ]
    const firstStore = createComfyStore(firstDb, {
      randomUUID: () => ids.shift()!,
      defaultTemplateDir: templateDir,
    })
    const recoverable = await seedRemoteJob(firstStore, {
      operationKey: 'boot-complete',
      promptId: 'boot-complete-prompt',
    })
    const missing = await seedRemoteJob(firstStore, {
      operationKey: 'boot-orphan',
      promptId: 'boot-orphan-prompt',
    })
    firstDb.close()

    const mp4 = Buffer.from('000000186674797069736F6D0000000069736F6D', 'hex')
    const fetchImpl = (async (urlValue: string | URL | Request) => {
      const url = new URL(String(urlValue))
      if (url.pathname === '/history/boot-complete-prompt') {
        return Response.json({
          'boot-complete-prompt': {
            outputs: {
              '63': { gifs: [{ filename: 'boot.mp4', subfolder: '', type: 'output' }] },
            },
            status: { status_str: 'success', completed: true, messages: [] },
          },
        })
      }
      if (url.pathname === '/history/boot-orphan-prompt') return Response.json({})
      if (url.pathname === '/queue') {
        return Response.json({ queue_running: [], queue_pending: [] })
      }
      if (url.pathname === '/view') {
        return new Response(mp4, { headers: { 'content-type': 'video/mp4' } })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch

    const restartedDb = new Database(dbPath)
    dbs.push(restartedDb)
    const restartedStore = createComfyStore(restartedDb, { defaultTemplateDir: templateDir })
    const orchestrator = createComfyOrchestrator({
      store: restartedStore,
      registry: createTemplateRegistry({ templateDir }),
      assets: createComfyAssetStore({
        inlayDir: path.join(root, 'inlays'),
        stagingDir: path.join(root, 'staging'),
        fetchImpl,
      }),
      fetchImpl,
      pollIntervalMs: 10,
    })
    await orchestrator.start()
    try {
      let completed: any
      let orphaned: any
      for (let attempt = 0; attempt < 100; attempt += 1) {
        completed = await orchestrator.poll(recoverable.jobId)
        orphaned = await orchestrator.poll(missing.jobId)
        if (completed.state === 'succeeded' && orphaned.state === 'orphaned') break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(completed).toMatchObject({
        state: 'succeeded',
        resultAssetId: `comfy-${recoverable.jobId}`,
      })
      expect(orphaned).toMatchObject({
        state: 'orphaned',
        error: { code: 'COMFY_REMOTE_ORPHANED' },
      })
    } finally {
      await orchestrator.stop()
    }
  })

  it('preserves a disconnected job as unknown and reconciles it after endpoint rotation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-rotation-'))
    dirs.push(root)
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      defaultTemplateDir: templateDir,
    })
    const job = await seedRemoteJob(store, {
      operationKey: 'rotate-me',
      promptId: 'rotated-prompt',
      endpointUrl: 'http://127.0.0.1:8188',
    })
    const mp4 = Buffer.from('000000186674797069736F6D0000000069736F6D', 'hex')
    const fetchImpl = (async (urlValue: string | URL | Request) => {
      const url = new URL(String(urlValue))
      if (url.port === '8188') throw new TypeError('old tunnel disconnected')
      if (url.pathname === '/system_stats') return Response.json({ system: { rotated: true } })
      if (url.pathname === '/history/rotated-prompt') {
        return Response.json({
          'rotated-prompt': {
            outputs: {
              '63': { gifs: [{ filename: 'rotated.mp4', subfolder: '', type: 'output' }] },
            },
            status: { status_str: 'success', completed: true, messages: [] },
          },
        })
      }
      if (url.pathname === '/view') {
        return new Response(mp4, { headers: { 'content-type': 'video/mp4' } })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: createComfyAssetStore({
        inlayDir: path.join(root, 'inlays'),
        stagingDir: path.join(root, 'staging'),
        fetchImpl,
      }),
      fetchImpl,
    })

    await orchestrator.runOnce()
    expect(await orchestrator.poll(job.jobId)).toMatchObject({
      state: 'unknown',
      endpointGeneration: 1,
    })

    await orchestrator.updateEndpoint('http://127.0.0.1:8288')
    expect(await orchestrator.poll(job.jobId)).toMatchObject({
      state: 'unknown',
      endpointGeneration: 2,
    })
    await orchestrator.runOnce()
    expect(await orchestrator.poll(job.jobId)).toMatchObject({
      state: 'succeeded',
      endpointGeneration: 2,
      resultAssetId: `comfy-${job.jobId}`,
    })
  })

  it('serializes concurrent worker wakes so only the oldest queued job is dispatched', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-serial-'))
    dirs.push(root)
    const inlayDir = path.join(root, 'inlays')
    await mkdir(inlayDir, { recursive: true })
    const png = Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex')
    for (const id of ['source-a', 'source-b']) {
      await writeFile(path.join(inlayDir, `${id}.png`), png)
      await writeFile(path.join(inlayDir, `${id}.meta.json`), JSON.stringify({
        ext: 'png',
        name: `${id}.png`,
        type: 'image',
      }))
    }
    const ids = [
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ]
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      randomUUID: () => ids.shift()!,
      defaultTemplateDir: templateDir,
    })
    let promptCalls = 0
    const fetchImpl = (async (urlValue: string | URL | Request) => {
      const url = new URL(String(urlValue))
      if (url.pathname === '/system_stats') return Response.json({ system: {} })
      if (url.pathname === '/upload/image') {
        return Response.json({ name: `uploaded-${promptCalls}.png`, subfolder: 'risu-comfy', type: 'input' })
      }
      if (url.pathname === '/prompt') {
        promptCalls += 1
        return Response.json({ prompt_id: `serial-prompt-${promptCalls}` })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: createComfyAssetStore({
        inlayDir,
        stagingDir: path.join(root, 'staging'),
        fetchImpl,
      }),
      fetchImpl,
    })
    await orchestrator.updateEndpoint('http://127.0.0.1:8188')
    const first = await orchestrator.submit({
      operationKey: 'serial-a',
      template: 'wan-i2v',
      slots: { positive: 'a', input_image: 'source-a', seed: 1 },
    })
    const second = await orchestrator.submit({
      operationKey: 'serial-b',
      template: 'wan-i2v',
      slots: { positive: 'b', input_image: 'source-b', seed: 2 },
    })

    await Promise.all([
      orchestrator.runOnce(),
      orchestrator.runOnce(),
      orchestrator.runOnce(),
    ])
    expect(promptCalls).toBe(1)
    expect((await orchestrator.poll(first.jobId)).state).toBe('remote_queued')
    expect((await orchestrator.poll(second.jobId)).state).toBe('queued')
  })

  it('recovers a prompt accepted behind an HTTP 502 without submitting it twice', async () => {
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      randomUUID: () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      defaultTemplateDir: templateDir,
    })
    let promptCalls = 0
    let clientId = ''
    const fetchImpl = (async (urlValue: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(urlValue))
      if (url.pathname === '/system_stats') return Response.json({ system: {} })
      if (url.pathname === '/prompt') {
        promptCalls += 1
        clientId = JSON.parse(String(init?.body)).client_id
        return new Response('Bad Gateway', { status: 502 })
      }
      if (url.pathname === '/history') {
        return Response.json({
          'accepted-prompt': {
            prompt: [1, 'accepted-prompt', {}, { client_id: clientId }, ['63']],
            outputs: {
              '63': { gifs: [{ filename: 'accepted.mp4', subfolder: '', type: 'output' }] },
            },
            status: { status_str: 'success', completed: true, messages: [] },
          },
        })
      }
      if (url.pathname === '/queue') {
        return Response.json({ queue_running: [], queue_pending: [] })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch
    const assets = {
      readInputAsset: async () => ({
        assetId: 'source',
        ext: 'png',
        mimeType: 'image/png',
        hash: 'INPUT',
        bytes: Buffer.from('image'),
      }),
      uploadInput: async () => 'risu-comfy/source.png',
      recoverMaterialization: async () => null,
      materializeOutput: async () => ({
        resultAssetId: 'comfy-dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        mimeType: 'video/mp4',
      }),
      finalizeMaterialization: async () => {},
      removeMaterializedAsset: async () => {},
    }
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets,
      fetchImpl,
    })

    await orchestrator.updateEndpoint('http://127.0.0.1:8188')
    const submitted = await orchestrator.submit({
      operationKey: 'http-502-lost-ack',
      template: 'wan-i2v',
      slots: { positive: 'recover', input_image: 'source', seed: 1 },
    })
    await orchestrator.runOnce()
    expect(await orchestrator.poll(submitted.jobId)).toMatchObject({
      state: 'unknown',
      error: { code: 'COMFY_HTTP_ERROR' },
    })

    await orchestrator.runOnce()
    expect(await orchestrator.poll(submitted.jobId)).toMatchObject({
      state: 'succeeded',
      promptId: 'accepted-prompt',
    })
    expect(promptCalls).toBe(1)
  })

  it('lets a materialized completion win a concurrent nonterminal state change', async () => {
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      randomUUID: () => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      defaultTemplateDir: templateDir,
    })
    let job = await seedRemoteJob(store, {
      operationKey: 'materialization-cas',
      promptId: 'materialization-prompt',
    })
    job = store.updateJob(job.jobId, job.revision, 'remote_queued', {
      state: 'materializing',
      remoteOutput: { filename: 'ready.mp4', subfolder: '', type: 'output' },
    })
    let removed = 0
    let finalized = 0
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {
        recoverMaterialization: async () => null,
        materializeOutput: async () => {
          const current = store.getJob(job.jobId)
          store.updateJob(current.jobId, current.revision, 'materializing', { state: 'unknown' })
          return { resultAssetId: `comfy-${job.jobId}`, mimeType: 'video/mp4' }
        },
        removeMaterializedAsset: async () => { removed += 1 },
        finalizeMaterialization: async () => { finalized += 1 },
      },
      fetchImpl: async () => {
        throw new Error('network should not be used')
      },
    })

    await orchestrator.runOnce()
    expect(await orchestrator.poll(job.jobId)).toMatchObject({
      state: 'succeeded',
      resultAssetId: `comfy-${job.jobId}`,
    })
    expect(removed).toBe(0)
    expect(finalized).toBe(1)
  })

  it('classifies an acknowledged interrupt execution_error by its durable cancel intent', async () => {
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      randomUUID: () => 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      defaultTemplateDir: templateDir,
    })
    const job = await seedRemoteJob(store, {
      operationKey: 'interrupt-intent',
      promptId: 'interrupt-prompt',
      state: 'running',
    })
    let interrupted = false
    const fetchImpl = (async (urlValue: string | URL | Request) => {
      const url = new URL(String(urlValue))
      if (url.pathname === '/history/interrupt-prompt') {
        if (!interrupted) return Response.json({})
        return Response.json({
          'interrupt-prompt': {
            outputs: {},
            status: {
              status_str: 'error',
              completed: true,
              messages: [['execution_error', { exception_message: 'interrupted' }]],
            },
          },
        })
      }
      if (url.pathname === '/queue') {
        return Response.json({
          queue_running: [[1, 'interrupt-prompt', {}, { client_id: job.jobId }, []]],
          queue_pending: [],
        })
      }
      if (url.pathname === '/interrupt') {
        interrupted = true
        return new Response(null, { status: 200 })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {},
      fetchImpl,
    })

    await orchestrator.cancel(job.jobId)
    await orchestrator.runOnce()
    expect(await orchestrator.poll(job.jobId)).toMatchObject({ state: 'cancelled' })
    expect(store.getJob(job.jobId).cancelAction).toBe('interrupt')
  })

  it('does not classify a natural execution error as cancelled after interrupt is rejected', async () => {
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      randomUUID: () => 'abababab-abab-4bab-8bab-abababababab',
      defaultTemplateDir: templateDir,
    })
    const job = await seedRemoteJob(store, {
      operationKey: 'interrupt-rejected',
      promptId: 'interrupt-rejected-prompt',
      state: 'running',
    })
    let reportExecutionError = false
    const fetchImpl = (async (urlValue: string | URL | Request) => {
      const url = new URL(String(urlValue))
      if (url.pathname === '/history/interrupt-rejected-prompt') {
        if (!reportExecutionError) return Response.json({})
        return Response.json({
          'interrupt-rejected-prompt': {
            outputs: {},
            status: {
              status_str: 'error',
              completed: true,
              messages: [['execution_error', { exception_message: 'natural failure' }]],
            },
          },
        })
      }
      if (url.pathname === '/queue') {
        return Response.json({
          queue_running: [[1, 'interrupt-rejected-prompt', {}, { client_id: job.jobId }, []]],
          queue_pending: [],
        })
      }
      if (url.pathname === '/interrupt') return new Response(null, { status: 400 })
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {},
      fetchImpl,
    })

    await orchestrator.cancel(job.jobId)
    await orchestrator.runOnce()
    expect(store.getJob(job.jobId)).toMatchObject({
      state: 'unknown',
      cancelAction: null,
      errorCode: 'COMFY_HTTP_ERROR',
    })

    reportExecutionError = true
    await orchestrator.runOnce()
    expect(await orchestrator.poll(job.jobId)).toMatchObject({
      state: 'failed',
      error: { code: 'COMFY_EXECUTION_FAILED' },
    })
  })

  it('keeps promptless recovery unknown when the bounded global history page is saturated', async () => {
    let clock = 70_000
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => '12121212-1212-4212-8212-121212121212',
      defaultTemplateDir: templateDir,
    })
    const seeded = store.createOrReplayJob({
      operationKey: 'saturated-history',
      binding: { templateId: 'wan-i2v', templateHash: 'HASH', inputHash: 'A', endpointGeneration: 1 },
      job: {
        templateId: 'wan-i2v',
        templateHash: 'HASH',
        templateJson: '{}',
        slots: { positive: 'x', input_image: 'source', seed: 1 },
        inputAssetId: 'source',
        inputHash: 'A',
        endpointUrl: 'http://127.0.0.1:8188',
        endpointGeneration: 1,
        timeoutMs: 600_000,
      },
    }).job
    const job = store.updateJob(seeded.jobId, seeded.revision, 'queued', {
      state: 'unknown',
      remoteInputName: 'risu-comfy/source.png',
    })
    const history = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [
      `other-${index}`,
      {
        prompt: [index, `other-${index}`, {}, { client_id: `other-${index}` }, []],
        outputs: {},
        status: { status_str: 'success', completed: true, messages: [] },
      },
    ]))
    const fetchImpl = (async (urlValue: string | URL | Request) => {
      const url = new URL(String(urlValue))
      if (url.pathname === '/history') return Response.json(history)
      if (url.pathname === '/queue') {
        return Response.json({ queue_running: [], queue_pending: [] })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {},
      fetchImpl,
      now: () => clock,
      pollIntervalMs: 10,
    })

    await orchestrator.runOnce()
    clock += 10
    await orchestrator.runOnce()
    expect(await orchestrator.poll(job.jobId)).toMatchObject({
      state: 'unknown',
      error: { code: 'COMFY_HISTORY_TRUNCATED' },
    })
  })

  it('removes a just-published asset if world replacement wins after success CAS', async () => {
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      randomUUID: () => '13131313-1313-4313-8313-131313131313',
      defaultTemplateDir: templateDir,
    })
    let job = await seedRemoteJob(store, {
      operationKey: 'restore-after-cas',
      promptId: 'restore-prompt',
    })
    job = store.updateJob(job.jobId, job.revision, 'remote_queued', {
      state: 'materializing',
      remoteOutput: { filename: 'restore.mp4', subfolder: '', type: 'output' },
    })
    let removed = 0
    let orchestrator: any
    const assets = {
      recoverMaterialization: async () => ({
        resultAssetId: `comfy-${job.jobId}`,
        mimeType: 'video/mp4',
      }),
      finalizeMaterialization: async () => {
        orchestrator.purgeForWorldReplacement()
      },
      removeMaterializedAsset: async () => { removed += 1 },
      cleanupStaging: async () => {},
    }
    orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets,
      fetchImpl: async () => {
        throw new Error('network should not be used')
      },
    })

    await orchestrator.runOnce()
    expect(store.getJob(job.jobId)).toBeNull()
    expect(removed).toBe(1)
  })

  it('pauses and drains the worker before a world-replacement transaction begins', async () => {
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      randomUUID: () => '14141414-1414-4414-8414-141414141414',
      defaultTemplateDir: templateDir,
    })
    const job = await seedRemoteJob(store, {
      operationKey: 'pause-worker',
      promptId: 'pause-prompt',
    })
    let historyCalls = 0
    const fetchImpl = (async (urlValue: string | URL | Request) => {
      const url = new URL(String(urlValue))
      if (url.pathname === '/history/pause-prompt') {
        historyCalls += 1
        return Response.json({})
      }
      if (url.pathname === '/queue') {
        return Response.json({ queue_running: [], queue_pending: [] })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: { cleanupOrphanStaging: async () => {} },
      fetchImpl,
    })

    await orchestrator.pauseForWorldReplacement()
    expect(orchestrator.isWorldReplacementPaused()).toBe(true)
    await orchestrator.runOnce()
    expect(historyCalls).toBe(0)
    expect((await orchestrator.poll(job.jobId)).state).toBe('remote_queued')
    await orchestrator.resumeAfterWorldReplacement()
    await orchestrator.runOnce()
    expect(historyCalls).toBe(1)
  })

  it('defers staging cleanup until a world-replacement transaction has finished', async () => {
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      randomUUID: () => '15151515-1515-4515-8515-151515151515',
      defaultTemplateDir: templateDir,
    })
    const job = await seedRemoteJob(store, {
      operationKey: 'rollback-preserves-staging',
      promptId: 'rollback-prompt',
    })
    let unsafeCleanupCalls = 0
    const orphanCleanupSnapshots: string[][] = []
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {
        cleanupStaging: async () => { unsafeCleanupCalls += 1 },
        cleanupOrphanStaging: async (liveJobIds: Set<string>) => {
          orphanCleanupSnapshots.push([...liveJobIds])
        },
      },
      fetchImpl: async () => {
        throw new Error('network should not be used')
      },
    })

    await orchestrator.pauseForWorldReplacement()
    db.exec('BEGIN')
    orchestrator.purgeForWorldReplacement()
    db.exec('ROLLBACK')
    await Promise.resolve()

    expect(store.getJob(job.jobId)).not.toBeNull()
    expect(unsafeCleanupCalls).toBe(0)
    expect(orphanCleanupSnapshots).toEqual([])

    await orchestrator.resumeAfterWorldReplacement()
    expect(orphanCleanupSnapshots).toEqual([[job.jobId]])
  })

  it('keeps a world-replacement pause acquired when worker drain fails', async () => {
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      randomUUID: () => '16161616-1616-4616-8616-161616161616',
      defaultTemplateDir: templateDir,
    })
    let job = await seedRemoteJob(store, {
      operationKey: 'pause-drain-failure',
      promptId: 'pause-drain-prompt',
    })
    job = store.updateJob(job.jobId, job.revision, 'remote_queued', {
      state: 'materializing',
      remoteOutput: { filename: 'pause-drain.mp4', subfolder: '', type: 'output' },
    })
    let rejectFinalize!: (error: Error) => void
    let signalFinalizeStarted!: () => void
    const finalizeStarted = new Promise<void>(resolve => { signalFinalizeStarted = resolve })
    const finalizeLatch = new Promise<void>((_resolve, reject) => { rejectFinalize = reject })
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {
        recoverMaterialization: async () => ({
          resultAssetId: `comfy-${job.jobId}`,
          mimeType: 'video/mp4',
        }),
        finalizeMaterialization: async () => {
          signalFinalizeStarted()
          await finalizeLatch
        },
        removeMaterializedAsset: async () => {},
      },
      fetchImpl: async () => {
        throw new Error('network should not be used')
      },
    })

    const activeRun = orchestrator.runOnce()
    await finalizeStarted
    const pause = orchestrator.pauseForWorldReplacement()
    rejectFinalize(new Error('simulated finalize failure'))

    await expect(activeRun).rejects.toThrow('simulated finalize failure')
    await expect(pause).resolves.toBeUndefined()
    expect(orchestrator.isWorldReplacementPaused()).toBe(true)
    await orchestrator.resumeAfterWorldReplacement()
    expect(orchestrator.isWorldReplacementPaused()).toBe(false)
  })

  it('keeps world replacement paused until post-transaction staging cleanup finishes', async () => {
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, { defaultTemplateDir: templateDir })
    let releaseCleanup!: () => void
    let signalCleanupStarted!: () => void
    const cleanupStarted = new Promise<void>(resolve => { signalCleanupStarted = resolve })
    const cleanupLatch = new Promise<void>(resolve => { releaseCleanup = resolve })
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {
        cleanupOrphanStaging: async () => {
          signalCleanupStarted()
          await cleanupLatch
        },
      },
      fetchImpl: async () => {
        throw new Error('network should not be used')
      },
    })

    await orchestrator.pauseForWorldReplacement()
    const resume = orchestrator.resumeAfterWorldReplacement()
    await cleanupStarted
    expect(orchestrator.isWorldReplacementPaused()).toBe(true)

    releaseCleanup()
    await resume
    expect(orchestrator.isWorldReplacementPaused()).toBe(false)
  })

  it('aborts an in-flight worker before pause and starts the replacement with a fresh signal', async () => {
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      randomUUID: () => '17171717-1717-4717-8717-171717171717',
      defaultTemplateDir: templateDir,
    })
    const job = await seedRemoteJob(store, {
      operationKey: 'pause-aborts-worker',
      promptId: 'pause-aborts-prompt',
    })
    const signals: AbortSignal[] = []
    let requestStarted!: () => void
    const started = new Promise<void>(resolve => { requestStarted = resolve })
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal
      signals.push(signal)
      requestStarted()
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }) as typeof fetch
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: { cleanupOrphanStaging: async () => {} },
      fetchImpl,
    })

    const activeRun = orchestrator.runOnce()
    await started
    await orchestrator.pauseForWorldReplacement()
    await activeRun
    expect(signals[0].aborted).toBe(true)
    expect(store.getJob(job.jobId)).toMatchObject({
      state: 'unknown',
      errorCode: 'COMFY_WORKER_ABORTED',
    })

    await orchestrator.resumeAfterWorldReplacement()
    const replacementRun = orchestrator.runOnce()
    await Promise.resolve()
    expect(signals).toHaveLength(2)
    expect(signals[1]).not.toBe(signals[0])
    expect(signals[1].aborted).toBe(false)
    await orchestrator.stop()
    await replacementRun
  })

  it('bounds stop drain after aborting a worker that ignores its signal', async () => {
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      randomUUID: () => '18181818-1818-4818-8818-181818181818',
      defaultTemplateDir: templateDir,
    })
    await seedRemoteJob(store, {
      operationKey: 'bounded-stop',
      promptId: 'bounded-stop-prompt',
    })
    let requestStarted!: () => void
    const started = new Promise<void>(resolve => { requestStarted = resolve })
    const never = new Promise<Response>(() => {})
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {},
      fetchImpl: (async () => {
        requestStarted()
        return never
      }) as typeof fetch,
      stopDrainTimeoutMs: 20,
    })

    void orchestrator.runOnce()
    await started
    const stopStartedAt = performance.now()
    await orchestrator.stop()
    expect(performance.now() - stopStartedAt).toBeLessThan(250)
  })

  it('does not spend execution budget while queued and reanchors the deadline on dispatch', async () => {
    let clock = 1_000
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => '19191919-1919-4919-8919-191919191919',
      defaultTemplateDir: templateDir,
    })
    const templateJson = await readFile(path.join(templateDir, 'wan-i2v.json'), 'utf8')
    const templateHash = createHash('sha256').update(templateJson).digest('hex').toUpperCase()
    const job = store.createOrReplayJob({
      operationKey: 'queued-budget',
      binding: { templateId: 'wan-i2v', templateHash, inputHash: 'A', endpointGeneration: 1 },
      job: {
        templateId: 'wan-i2v',
        templateHash,
        templateJson,
        slots: { positive: 'queued', input_image: 'source', seed: 1 },
        inputAssetId: 'source',
        inputHash: 'A',
        endpointUrl: 'http://127.0.0.1:8188',
        endpointGeneration: 1,
        timeoutMs: 2_000,
      },
    }).job
    clock = 50_000
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {
        readInputAsset: async () => ({ hash: 'A' }),
        uploadInput: async () => 'risu-comfy/source.png',
      },
      fetchImpl: (async () => Response.json({ prompt_id: 'budget-prompt' })) as typeof fetch,
      now: () => clock,
    })

    await orchestrator.runOnce()
    expect(store.getJob(job.jobId)).toMatchObject({
      state: 'remote_queued',
      startedAt: 50_000,
      deadlineAt: 52_000,
      timeoutMs: 2_000,
    })
  })

  it('enters typed degraded mode when startup cleanup fails', async () => {
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, { defaultTemplateDir: templateDir })
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {
        cleanupOrphanStaging: async () => {
          const error = new Error('staging is not a directory') as NodeJS.ErrnoException
          error.code = 'ENOTDIR'
          throw error
        },
      },
      fetchImpl: async () => {
        throw new Error('network should not be used')
      },
    })

    await expect(orchestrator.start()).rejects.toMatchObject({ code: 'ENOTDIR' })
    const calls = [
      () => orchestrator.submit({}),
      () => orchestrator.poll('job'),
      () => orchestrator.findByOperationKey('operation'),
      () => orchestrator.cancel('job'),
      () => orchestrator.listTemplates(),
      () => orchestrator.getConfig(),
      () => orchestrator.updateEndpoint('http://127.0.0.1:8188'),
      () => orchestrator.getHealth(),
    ]
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        code: 'COMFY_UNAVAILABLE',
        httpStatus: 503,
        uncertain: false,
      })
    }
    await expect(orchestrator.stop()).resolves.toBeUndefined()
    await expect(orchestrator.pauseForWorldReplacement()).resolves.toBeUndefined()
    expect(orchestrator.isWorldReplacementPaused()).toBe(true)
    await expect(orchestrator.resumeAfterWorldReplacement()).resolves.toBeUndefined()
  })

  it('binds normalized target metadata to early operation-key replay', async () => {
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, { defaultTemplateDir: templateDir })
    store.updateConfig({ endpointUrl: 'http://127.0.0.1:8188' })
    let reads = 0
    let inputAvailable = true
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {
        readInputAsset: async () => {
          reads += 1
          if (!inputAvailable) throw new Error('input was removed')
          return { hash: 'INPUT-HASH' }
        },
      },
      fetchImpl: (async () => Response.json({ system: {} })) as typeof fetch,
    })
    const input = {
      operationKey: 'target-replay',
      template: 'wan-i2v',
      slots: { positive: 'target', input_image: 'source', seed: 1 },
      target: { charId: 'character-1', chatId: 'chat-1' },
    }

    const created = await orchestrator.submit(input)
    inputAvailable = false
    await expect(orchestrator.submit(input)).resolves.toEqual(created)
    await expect(orchestrator.submit({
      ...input,
      target: { charId: 'character-1', chatId: 'different-chat' },
    })).rejects.toMatchObject({
      code: 'COMFY_OPERATION_KEY_CONFLICT',
      httpStatus: 409,
    })
    expect(reads).toBe(1)
    expect(store.getJob(created.jobId).target).toEqual(input.target)
    expect(created.target).toEqual(input.target)
  })

  it('requeues only an uncommitted submitting job and preserves its original timeout budget', async () => {
    let clock = 1_000
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => '20202020-2020-4020-8020-202020202020',
      defaultTemplateDir: templateDir,
    })
    const templateJson = await readFile(path.join(templateDir, 'wan-i2v.json'), 'utf8')
    const templateHash = createHash('sha256').update(templateJson).digest('hex').toUpperCase()
    let job = store.createOrReplayJob({
      operationKey: 'requeue-uncommitted',
      binding: { templateId: 'wan-i2v', templateHash, inputHash: 'A', endpointGeneration: 1 },
      job: {
        templateId: 'wan-i2v',
        templateHash,
        templateJson,
        slots: { positive: 'requeue', input_image: 'source', seed: 1 },
        inputAssetId: 'source',
        inputHash: 'A',
        endpointUrl: 'http://127.0.0.1:8188',
        endpointGeneration: 1,
        timeoutMs: 2_000,
      },
    }).job
    job = store.updateJob(job.jobId, job.revision, 'queued', {
      state: 'submitting',
      startedAt: 1_000,
    })
    let networkCalls = 0
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {
        readInputAsset: async () => ({ hash: 'A' }),
        uploadInput: async () => 'risu-comfy/source.png',
      },
      fetchImpl: (async () => {
        networkCalls += 1
        return Response.json({ prompt_id: 'requeued-prompt' })
      }) as typeof fetch,
      now: () => clock,
    })

    clock = 10_000
    await orchestrator.runOnce()
    expect(store.getJob(job.jobId)).toMatchObject({
      state: 'queued',
      startedAt: null,
      timeoutMs: 2_000,
    })
    expect(networkCalls).toBe(0)

    store.updateConfig({ timeoutMs: 99_000 })
    clock = 20_000
    await orchestrator.runOnce()
    expect(store.getJob(job.jobId)).toMatchObject({
      state: 'remote_queued',
      startedAt: 20_000,
      deadlineAt: 22_000,
      timeoutMs: 2_000,
    })
    expect(networkCalls).toBe(1)
  })

  it('caps durable materialization retries at five and releases the FIFO after cleanup', async () => {
    let clock = 30_000
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-materialize-cap-'))
    dirs.push(root)
    const inlayDir = path.join(root, 'inlays')
    const stagingDir = path.join(root, 'staging')
    await mkdir(inlayDir, { recursive: true })
    const png = Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex')
    await writeFile(path.join(inlayDir, 'source.png'), png)
    await writeFile(path.join(inlayDir, 'source.meta.json'), JSON.stringify({
      ext: 'png',
      name: 'source.png',
      type: 'image',
    }))
    const db = new Database(':memory:')
    dbs.push(db)
    const ids = [
      '21212121-2121-4121-8121-212121212121',
      '22222222-2222-4222-8222-222222222223',
    ]
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => ids.shift()!,
      defaultTemplateDir: templateDir,
    })
    let first = await seedRemoteJob(store, {
      operationKey: 'materialize-cap-first',
      promptId: 'materialize-cap-prompt',
    })
    first = store.updateJob(first.jobId, first.revision, 'remote_queued', {
      state: 'materializing',
      remoteOutput: { filename: 'retry.mp4', subfolder: '', type: 'output' },
    })
    const templateJson = await readFile(path.join(templateDir, 'wan-i2v.json'), 'utf8')
    const templateHash = createHash('sha256').update(templateJson).digest('hex').toUpperCase()
    const second = store.createOrReplayJob({
      operationKey: 'materialize-cap-second',
      binding: { templateId: 'wan-i2v', templateHash, inputHash: 'A', endpointGeneration: 1 },
      job: {
        templateId: 'wan-i2v',
        templateHash,
        templateJson,
        slots: { positive: 'next', input_image: 'source', seed: 2 },
        inputAssetId: 'source',
        inputHash: createHash('sha256').update(png).digest('hex').toUpperCase(),
        endpointUrl: 'http://127.0.0.1:8188',
        endpointGeneration: 1,
        timeoutMs: 600_000,
      },
    }).job
    const mp4 = Buffer.from('000000186674797069736F6D0000000069736F6D', 'hex')
    let viewCalls = 0
    let kvCalls = 0
    const publishError = Object.assign(new Error('metadata disk full'), { code: 'ENOSPC' })
    const fetchImpl = (async (urlValue: string | URL | Request) => {
      const url = new URL(String(urlValue))
      if (url.pathname === '/view') {
        viewCalls += 1
        return new Response(mp4, { headers: { 'content-type': 'video/mp4' } })
      }
      if (url.pathname === '/upload/image') {
        return Response.json({ name: 'source.png', subfolder: 'risu-comfy', type: 'input' })
      }
      if (url.pathname === '/prompt') return Response.json({ prompt_id: 'next-prompt' })
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch
    const assets = createComfyAssetStore({
      inlayDir,
      stagingDir,
      fetchImpl,
      now: () => clock,
      kvSet: () => {
        kvCalls += 1
        throw publishError
      },
      kvDel: () => {},
    })
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets,
      fetchImpl,
      now: () => clock,
      logger: { error: () => {} },
    })

    await orchestrator.runOnce()
    expect(store.getJob(first.jobId)).toMatchObject({
      state: 'materializing',
      materializeAttempts: 1,
      materializeRetryAt: 31_000,
    })
    await orchestrator.runOnce()
    expect(kvCalls).toBe(1)

    for (const nextClock of [31_000, 33_000, 37_000, 45_000]) {
      clock = nextClock
      await orchestrator.runOnce()
    }
    expect(store.getJob(first.jobId)).toMatchObject({
      state: 'failed',
      materializeAttempts: 5,
      materializeRetryAt: null,
      errorCode: 'ENOSPC',
    })
    expect(viewCalls).toBe(1)
    expect(kvCalls).toBe(5)
    await expect(access(path.join(inlayDir, `comfy-${first.jobId}.mp4`))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(access(path.join(inlayDir, `comfy-${first.jobId}.meta.json`))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(access(path.join(stagingDir, first.jobId))).rejects.toMatchObject({
      code: 'ENOENT',
    })

    clock = 46_000
    await orchestrator.runOnce()
    expect(store.getJob(second.jobId)).toMatchObject({
      state: 'remote_queued',
      promptId: 'next-prompt',
    })
  })
})
