// @vitest-environment node

import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import orchestratorPkg from './orchestrator.cjs'
import storePkg from './store.cjs'
import registryPkg from './templateRegistry.cjs'

const { createComfyOrchestrator } = orchestratorPkg as any
const { createComfyStore } = storePkg as any
const { createTemplateRegistry } = registryPkg as any
const templateDir = fileURLToPath(new URL('./templates/', import.meta.url))
const dbs: any[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

async function seedJob(
  store: any,
  input: { operationKey: string; inputHash?: string; patch?: Record<string, unknown> },
) {
  const templateJson = await readFile(path.join(templateDir, 'wan-i2v.json'), 'utf8')
  const templateHash = createHash('sha256').update(templateJson).digest('hex').toUpperCase()
  const created = store.createOrReplayJob({
    operationKey: input.operationKey,
    binding: {
      templateId: 'wan-i2v',
      templateHash,
      inputHash: input.inputHash ?? 'A',
      endpointGeneration: 1,
    },
    job: {
      templateId: 'wan-i2v',
      templateHash,
      templateJson,
      slots: { positive: 'tunnel recovery', input_image: 'source', seed: 14 },
      inputAssetId: 'source',
      inputHash: input.inputHash ?? 'A',
      endpointUrl: 'http://127.0.0.1:8188',
      endpointGeneration: 1,
      timeoutMs: 600_000,
    },
  }).job
  if (!input.patch) return created
  return store.updateJob(created.jobId, created.revision, 'queued', input.patch)
}

describe('Comfy tunnel wedge regressions', () => {
  it('enforces a settlement window at least as long as the request timeout before absence proof', async () => {
    let clock = 100_000
    const attemptedAt = clock
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => '71717171-7171-4171-8171-717171717171',
      defaultTemplateDir: templateDir,
    })
    const job = await seedJob(store, {
      operationKey: 'settlement-window',
      patch: {
        promptAttemptedAt: attemptedAt,
        attemptSequenceHorizon: 100,
        remoteInputName: 'risu-comfy/source.png',
        remoteInputs: { input_image: 'risu-comfy/source.png' },
        dispatchRetryAt: clock - 1,
      },
    })
    let promptCalls = 0
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {},
      fetchImpl: (async (urlValue: string | URL | Request) => {
        const url = new URL(String(urlValue))
        if (url.pathname === '/queue') return Response.json({ queue_running: [], queue_pending: [] })
        if (url.pathname === '/history') return Response.json({})
        if (url.pathname === '/prompt') {
          promptCalls += 1
          return Response.json({ prompt_id: 'settled-retry' })
        }
        throw new Error(`Unexpected request: ${url.pathname}`)
      }) as typeof fetch,
      now: () => clock,
      pollIntervalMs: 100,
      dispatchRetryDelayMs: 100,
      requestTimeoutMs: 5_000,
      promptSettlementWindowMs: 1_000,
      settlementScanIntervalMs: 100,
    })

    for (let sweep = 0; sweep < 10; sweep += 1) {
      clock += 101
      await orchestrator.runOnce()
    }
    expect(store.getJob(job.jobId)).toMatchObject({ state: 'queued', absenceCount: 0 })
    expect(promptCalls).toBe(0)

    clock = attemptedAt + 5_000
    await orchestrator.runOnce()
    expect(store.getJob(job.jobId)).toMatchObject({ state: 'queued', absenceCount: 1 })
    expect(promptCalls).toBe(0)

    clock += 101
    await orchestrator.runOnce()
    expect(store.getJob(job.jobId)).toMatchObject({
      state: 'remote_queued',
      promptId: 'settled-retry',
    })
    expect(promptCalls).toBe(1)
  })

  it('settles an absent submission against a full latest-history page instead of wedging', async () => {
    let clock = 200_000
    const attemptedAt = clock - 5_000
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => '72727272-7272-4272-8272-727272727272',
      defaultTemplateDir: templateDir,
    })
    const job = await seedJob(store, {
      operationKey: 'saturated-latest-tail',
      patch: {
        promptAttemptedAt: attemptedAt,
        attemptSequenceHorizon: 100,
        remoteInputName: 'risu-comfy/source.png',
        remoteInputs: { input_image: 'risu-comfy/source.png' },
        dispatchRetryAt: clock - 1,
      },
    })
    const latestHistory: Record<string, unknown> = {}
    for (let i = 0; i < 200; i += 1) {
      latestHistory[`other-${i}`] = {
        prompt: [i, `other-${i}`, {}, { client_id: 'someone-else' }, ['63']],
        outputs: {},
        status: { status_str: 'success', completed: true, messages: [] },
      }
    }
    let promptCalls = 0
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {},
      fetchImpl: (async (urlValue: string | URL | Request) => {
        const url = new URL(String(urlValue))
        if (url.pathname === '/queue') return Response.json({ queue_running: [], queue_pending: [] })
        if (url.pathname === '/history') return Response.json(latestHistory)
        if (url.pathname === '/prompt') {
          promptCalls += 1
          return Response.json({ prompt_id: 'tail-settled-retry' })
        }
        throw new Error(`Unexpected request: ${url.pathname}`)
      }) as typeof fetch,
      now: () => clock,
      pollIntervalMs: 100,
      dispatchRetryDelayMs: 100,
      requestTimeoutMs: 1_000,
      promptSettlementWindowMs: 5_000,
      settlementScanIntervalMs: 100,
    })

    await orchestrator.runOnce()
    expect(store.getJob(job.jobId)).toMatchObject({ state: 'queued', absenceCount: 1 })
    expect(promptCalls).toBe(0)

    clock += 101
    await orchestrator.runOnce()
    expect(store.getJob(job.jobId)).toMatchObject({
      state: 'remote_queued',
      promptId: 'tail-settled-retry',
    })
    expect(promptCalls).toBe(1)
  })

  it('settles cancellation only after W and two clean scans on a full history tail', async () => {
    let clock = 300_000
    const attemptedAt = clock
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => '73737373-7373-4373-8373-737373737373',
      defaultTemplateDir: templateDir,
    })
    const job = await seedJob(store, {
      operationKey: 'cancel-saturated-tail',
      patch: {
        promptAttemptedAt: attemptedAt,
        remoteInputName: 'risu-comfy/source.png',
        remoteInputs: { input_image: 'risu-comfy/source.png' },
        dispatchRetryAt: clock - 1,
      },
    })
    const latestHistory: Record<string, unknown> = {}
    for (let i = 0; i < 200; i += 1) {
      latestHistory[`other-${i}`] = {
        prompt: [i, `other-${i}`, {}, { client_id: 'someone-else' }, ['63']],
        outputs: {},
        status: { status_str: 'success', completed: true, messages: [] },
      }
    }
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {},
      fetchImpl: (async (urlValue: string | URL | Request) => {
        const url = new URL(String(urlValue))
        if (url.pathname === '/queue') return Response.json({ queue_running: [], queue_pending: [] })
        if (url.pathname === '/history') return Response.json(latestHistory)
        throw new Error(`Unexpected request: ${url.pathname}`)
      }) as typeof fetch,
      now: () => clock,
      pollIntervalMs: 100,
      dispatchRetryDelayMs: 100,
      requestTimeoutMs: 1_000,
      promptSettlementWindowMs: 5_000,
      settlementScanIntervalMs: 100,
    })

    await orchestrator.cancel(job.jobId)
    for (let sweep = 0; sweep < 10; sweep += 1) {
      clock += 101
      await orchestrator.runOnce()
    }
    expect(store.getJob(job.jobId)).toMatchObject({
      state: 'queued',
      terminalIntent: 'user_cancel',
      absenceCount: 0,
    })

    clock = attemptedAt + 5_000
    await orchestrator.runOnce()
    expect(store.getJob(job.jobId)).toMatchObject({ state: 'queued', absenceCount: 1 })

    clock += 101
    await orchestrator.runOnce()
    expect(store.getJob(job.jobId)).toMatchObject({ state: 'cancelled' })
  })

  it.each([
    ['evicted horizon', 100, 101, '75757575-7575-4575-8575-757575757575'],
    ['missing legacy horizon', null, 0, '76767676-7676-4676-8676-767676767676'],
  ])('never reposts when a full history page cannot prove absence: %s', async (
    label,
    attemptSequenceHorizon,
    minimumSequence,
    jobId,
  ) => {
    let clock = 350_000
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => jobId,
      defaultTemplateDir: templateDir,
    })
    const job = await seedJob(store, {
      operationKey: `proof-unavailable-${String(label).replaceAll(' ', '-')}`,
      patch: {
        promptAttemptedAt: clock - 5_000,
        attemptSequenceHorizon,
        remoteInputName: 'risu-comfy/source.png',
        remoteInputs: { input_image: 'risu-comfy/source.png' },
        dispatchRetryAt: clock - 1,
      },
    })
    const latestHistory: Record<string, unknown> = {}
    for (let i = 0; i < 200; i += 1) {
      const sequence = minimumSequence + i
      latestHistory[`proof-other-${i}`] = {
        prompt: [sequence, `proof-other-${i}`, {}, { client_id: 'someone-else' }, ['63']],
        outputs: {},
        status: { status_str: 'success', completed: true, messages: [] },
      }
    }
    let promptCalls = 0
    let queueCalls = 0
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {},
      fetchImpl: (async (urlValue: string | URL | Request) => {
        const url = new URL(String(urlValue))
        if (url.pathname === '/queue') {
          queueCalls += 1
          return Response.json({ queue_running: [], queue_pending: [] })
        }
        if (url.pathname === '/history') return Response.json(latestHistory)
        if (url.pathname === '/prompt') {
          promptCalls += 1
          return Response.json({ prompt_id: 'must-not-repost' })
        }
        throw new Error(`Unexpected request: ${url.pathname}`)
      }) as typeof fetch,
      now: () => clock,
      pollIntervalMs: 100,
      dispatchRetryDelayMs: 100,
      requestTimeoutMs: 100,
      promptSettlementWindowMs: 1_000,
      submissionProofRetryDelayMs: 5_000,
    })

    await orchestrator.runOnce()
    expect(store.getJob(job.jobId)).toMatchObject({
      state: 'queued',
      absenceCount: 0,
      errorCode: 'COMFY_SUBMISSION_PROOF_UNAVAILABLE',
      errorMessage: expect.stringContaining('접수 여부를 증명할 수 없어요'),
      dispatchRetryAt: clock + 5_000,
    })
    expect(promptCalls).toBe(0)
    expect(queueCalls).toBe(1)

    clock += 1_000
    await orchestrator.runOnce()
    expect(queueCalls).toBe(1)
    expect(promptCalls).toBe(0)
  })

  it('services proof-wait cancellation on the next sweep and clears a repeated cancel gate', async () => {
    let clock = 290_000
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => '73737373-7373-4373-8373-737373737373',
      defaultTemplateDir: templateDir,
    })
    let job = await seedJob(store, {
      operationKey: 'cancel-proof-wait-immediately',
      patch: {
        promptAttemptedAt: clock - 5_000,
        attemptSequenceHorizon: 0,
        remoteInputName: 'risu-comfy/source.png',
        remoteInputs: { input_image: 'risu-comfy/source.png' },
        dispatchRetryAt: clock + 30_000,
        errorCode: 'COMFY_SUBMISSION_PROOF_UNAVAILABLE',
        errorMessage: 'ComfyUI 원격 접수 여부를 증명할 수 없어요 — 대기 중이며 취소할 수 있어요',
      },
    })
    let queueReads = 0
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {},
      fetchImpl: (async (urlValue: string | URL | Request) => {
        const url = new URL(String(urlValue))
        if (url.pathname === '/queue') {
          queueReads += 1
          return Response.json({ queue_running: [], queue_pending: [] })
        }
        if (url.pathname === '/history') return Response.json({})
        throw new Error(`Unexpected request: ${url.pathname}`)
      }) as typeof fetch,
      now: () => clock,
      pollIntervalMs: 100,
      dispatchRetryDelayMs: 100,
      requestTimeoutMs: 1_000,
      promptSettlementWindowMs: 1_000,
    })

    await expect(orchestrator.cancel(job.jobId)).resolves.toMatchObject({
      state: 'cancel_requested',
      error: {
        code: 'COMFY_CANCEL_PENDING',
        message: 'ComfyUI 취소 진행 중 — 원격 작업을 확인하고 있어요',
      },
    })
    expect(store.getJob(job.jobId).dispatchRetryAt).toBeNull()

    job = store.getJob(job.jobId)
    job = store.updateJob(job.jobId, job.revision, job.state, { dispatchRetryAt: clock + 30_000 })
    await orchestrator.cancel(job.jobId)
    expect(store.getJob(job.jobId).dispatchRetryAt).toBeNull()

    await orchestrator.runOnce()
    expect(queueReads).toBe(1)
    expect(store.getJob(job.jobId)).toMatchObject({
      terminalIntent: 'user_cancel',
      absenceCount: 1,
      dispatchRetryAt: clock + 100,
    })
  })

  it('parks before POST when the horizon snapshot fails and submits only after a finite retry snapshot', async () => {
    let clock = 295_000
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => '74747474-7474-4474-8474-747474747470',
      defaultTemplateDir: templateDir,
    })
    const job = await seedJob(store, { operationKey: 'snapshot-before-post-park' })
    let snapshotAttempts = 0
    let promptCalls = 0
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {
        readInputAsset: async () => ({ hash: 'A' }),
        uploadInput: async () => 'risu-comfy/snapshot-retry.png',
      },
      fetchImpl: (async (urlValue: string | URL | Request) => {
        const url = new URL(String(urlValue))
        if (url.pathname === '/queue') {
          snapshotAttempts += 1
          if (snapshotAttempts === 1) throw new TypeError('tunnel unavailable during horizon snapshot')
          return Response.json({ queue_running: [], queue_pending: [] })
        }
        if (url.pathname === '/history') return Response.json({})
        if (url.pathname === '/prompt') {
          promptCalls += 1
          return Response.json({ prompt_id: 'snapshot-retry-prompt' })
        }
        throw new Error(`Unexpected request: ${url.pathname}`)
      }) as typeof fetch,
      now: () => clock,
      pollIntervalMs: 100,
      dispatchRetryDelayMs: 100,
      requestTimeoutMs: 1_000,
    })

    await orchestrator.runOnce()
    expect(promptCalls).toBe(0)
    expect(store.getJob(job.jobId)).toMatchObject({
      state: 'queued',
      promptAttemptedAt: null,
      attemptSequenceHorizon: null,
      dispatchRetryAt: clock + 100,
      errorCode: 'COMFY_UNREACHABLE',
    })

    clock += 100
    await orchestrator.runOnce()
    expect(promptCalls).toBe(1)
    expect(store.getJob(job.jobId)).toMatchObject({
      state: 'remote_queued',
      promptId: 'snapshot-retry-prompt',
      promptAttemptedAt: clock,
      attemptSequenceHorizon: 0,
    })
    expect(Number.isFinite(store.getJob(job.jobId).attemptSequenceHorizon)).toBe(true)
  })

  it('persists the remote sequence horizon before sending a prompt', async () => {
    let clock = 375_000
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => '77777777-7777-4777-8777-777777777777',
      defaultTemplateDir: templateDir,
    })
    const job = await seedJob(store, { operationKey: 'snapshot-sequence-horizon' })
    let observedBeforePrompt: any = null
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {
        readInputAsset: async () => ({ hash: 'A' }),
        uploadInput: async () => 'risu-comfy/snapshot.png',
      },
      fetchImpl: (async (urlValue: string | URL | Request) => {
        const url = new URL(String(urlValue))
        if (url.pathname === '/queue') {
          return Response.json({
            queue_running: [[41, 'running-before-attempt', {}, {}, ['63']]],
            queue_pending: [[52.5, 'pending-before-attempt', {}, {}, ['63']]],
          })
        }
        if (url.pathname === '/history') {
          return Response.json({
            'history-before-attempt': {
              prompt: [50, 'history-before-attempt', {}, {}, ['63']],
              outputs: {},
            },
          })
        }
        if (url.pathname === '/prompt') {
          observedBeforePrompt = store.getJob(job.jobId)
          return Response.json({ prompt_id: 'snapshot-horizon-prompt' })
        }
        throw new Error(`Unexpected request: ${url.pathname}`)
      }) as typeof fetch,
      now: () => clock,
    })

    await orchestrator.runOnce()
    expect(observedBeforePrompt).toMatchObject({
      promptAttemptedAt: clock,
      attemptSequenceHorizon: 52.5,
    })
    expect(store.getJob(job.jobId)).toMatchObject({
      promptId: 'snapshot-horizon-prompt',
      attemptSequenceHorizon: 52.5,
    })
  })

  it('keeps the oldest duplicate submission and deletes later pending copies before adoption', async () => {
    let clock = 400_000
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => '74747474-7474-4474-8474-747474747474',
      defaultTemplateDir: templateDir,
    })
    const job = await seedJob(store, {
      operationKey: 'duplicate-pending-cleanup',
      patch: {
        promptAttemptedAt: clock - 5_000,
        remoteInputName: 'risu-comfy/source.png',
        remoteInputs: { input_image: 'risu-comfy/source.png' },
        dispatchRetryAt: clock - 1,
      },
    })
    let duplicatePresent = true
    const deleted: string[][] = []
    let promptCalls = 0
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {},
      fetchImpl: (async (urlValue: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(urlValue))
        if (url.pathname === '/queue' && init?.method === 'POST') {
          const ids = JSON.parse(String(init.body)).delete
          deleted.push(ids)
          duplicatePresent = false
          return new Response(null, { status: 200 })
        }
        if (url.pathname === '/queue') {
          return Response.json({
            queue_running: [],
            queue_pending: [
              [10, 'oldest-owned', {}, { risu_job_id: job.jobId }, ['63']],
              ...(duplicatePresent
                ? [[20, 'later-duplicate', {}, { risu_job_id: job.jobId }, ['63']]]
                : []),
            ],
          })
        }
        if (url.pathname === '/history') return Response.json({})
        if (url.pathname === '/prompt') {
          promptCalls += 1
          return Response.json({ prompt_id: 'must-not-repost' })
        }
        throw new Error(`Unexpected request: ${url.pathname}`)
      }) as typeof fetch,
      now: () => clock,
      pollIntervalMs: 100,
      dispatchRetryDelayMs: 100,
      requestTimeoutMs: 1_000,
      promptSettlementWindowMs: 5_000,
    })

    await orchestrator.runOnce()
    expect(deleted).toEqual([['later-duplicate']])
    expect(store.getJob(job.jobId)).toMatchObject({ state: 'queued', promptId: null })
    expect(promptCalls).toBe(0)

    clock += 101
    await orchestrator.runOnce()
    expect(store.getJob(job.jobId)).toMatchObject({
      state: 'remote_queued',
      promptId: 'oldest-owned',
    })
    expect(promptCalls).toBe(0)
  })

  it('cancels every active marker copy when the local job has terminal intent', async () => {
    let clock = 500_000
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => '75757575-7575-4575-8575-757575757575',
      defaultTemplateDir: templateDir,
    })
    const job = await seedJob(store, {
      operationKey: 'cancel-all-marker-copies',
      patch: {
        promptAttemptedAt: clock - 5_000,
        remoteInputName: 'risu-comfy/source.png',
        remoteInputs: { input_image: 'risu-comfy/source.png' },
        dispatchRetryAt: clock - 1,
      },
    })
    let active = true
    const deleted: string[][] = []
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {},
      fetchImpl: (async (urlValue: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(urlValue))
        if (url.pathname === '/queue' && init?.method === 'POST') {
          deleted.push(JSON.parse(String(init.body)).delete)
          active = false
          return new Response(null, { status: 200 })
        }
        if (url.pathname === '/queue') {
          return Response.json({
            queue_running: [],
            queue_pending: active
              ? [
                  [1, 'cancel-copy-1', {}, { risu_job_id: job.jobId }, ['63']],
                  [2, 'cancel-copy-2', {}, { risu_job_id: job.jobId }, ['63']],
                ]
              : [],
          })
        }
        if (url.pathname === '/history') return Response.json({})
        throw new Error(`Unexpected request: ${url.pathname}`)
      }) as typeof fetch,
      now: () => clock,
      pollIntervalMs: 100,
      dispatchRetryDelayMs: 100,
      requestTimeoutMs: 1_000,
      promptSettlementWindowMs: 5_000,
    })

    await orchestrator.cancel(job.jobId)
    await orchestrator.runOnce()
    expect(deleted).toEqual([['cancel-copy-1', 'cancel-copy-2']])
    expect(store.getJob(job.jobId)).toMatchObject({ state: 'queued', terminalIntent: 'user_cancel' })

    clock += 101
    await orchestrator.runOnce()
    expect(store.getJob(job.jobId)).toMatchObject({ state: 'queued', absenceCount: 1 })
    clock += 101
    await orchestrator.runOnce()
    expect(store.getJob(job.jobId)).toMatchObject({ state: 'cancelled' })
  })

  it('uses targeted running cleanup and refuses an unsafe legacy global interrupt', async () => {
    let clock = 600_000
    const ids = [
      '76767676-7676-4676-8676-767676767676',
      '77777777-7777-4777-8777-777777777777',
    ]
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => ids.shift()!,
      defaultTemplateDir: templateDir,
    })
    const targetedJob = await seedJob(store, {
      operationKey: 'targeted-running-cleanup',
      patch: {
        promptAttemptedAt: clock - 5_000,
        remoteInputName: 'risu-comfy/source.png',
        remoteInputs: { input_image: 'risu-comfy/source.png' },
        dispatchRetryAt: clock - 1,
      },
    })
    let targetedDuplicateRunning = true
    const targetedCalls: string[] = []
    let interruptCalls = 0
    const fetchImpl = (async (urlValue: string | URL | Request) => {
      const url = new URL(String(urlValue))
      if (url.pathname === '/api/jobs/running-duplicate/cancel') {
        targetedCalls.push(url.pathname)
        targetedDuplicateRunning = false
        return Response.json({ cancelled: true })
      }
      if (url.pathname === '/queue') {
        return Response.json({
          queue_running: targetedDuplicateRunning
            ? [[2, 'running-duplicate', {}, { risu_job_id: targetedJob.jobId }, ['63']]]
            : [],
          queue_pending: [],
        })
      }
      if (url.pathname === '/history') {
        return Response.json({
          'oldest-completed': {
            prompt: [1, 'oldest-completed', {}, { risu_job_id: targetedJob.jobId }, ['63']],
            outputs: {},
            status: { status_str: 'success', completed: true, messages: [] },
          },
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
      dispatchRetryDelayMs: 100,
      requestTimeoutMs: 1_000,
      promptSettlementWindowMs: 5_000,
    })

    await orchestrator.runOnce()
    expect(targetedCalls).toEqual(['/api/jobs/running-duplicate/cancel'])
    expect(interruptCalls).toBe(0)
    clock += 101
    await orchestrator.runOnce()
    expect(store.getJob(targetedJob.jobId)).toMatchObject({ promptId: 'oldest-completed' })

    const unsafeJob = await seedJob(store, {
      operationKey: 'unsafe-legacy-running-cleanup',
      patch: {
        promptAttemptedAt: clock - 5_000,
        remoteInputName: 'risu-comfy/source.png',
        remoteInputs: { input_image: 'risu-comfy/source.png' },
        dispatchRetryAt: clock - 1,
      },
    })
    const unsafeOrchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {},
      fetchImpl: (async (urlValue: string | URL | Request) => {
        const url = new URL(String(urlValue))
        if (url.pathname === '/api/jobs/unsafe-duplicate/cancel') {
          return new Response(null, { status: 404 })
        }
        if (url.pathname === '/queue') {
          return Response.json({
            queue_running: [
              [2, 'unsafe-duplicate', {}, { risu_job_id: unsafeJob.jobId }, ['63']],
              [3, 'unrelated-running', {}, { client_id: 'someone-else' }, ['63']],
            ],
            queue_pending: [],
          })
        }
        if (url.pathname === '/history') {
          return Response.json({
            'unsafe-keeper': {
              prompt: [1, 'unsafe-keeper', {}, { risu_job_id: unsafeJob.jobId }, ['63']],
              outputs: {},
              status: { status_str: 'success', completed: true, messages: [] },
            },
          })
        }
        if (url.pathname === '/interrupt') {
          interruptCalls += 1
          return new Response(null, { status: 200 })
        }
        throw new Error(`Unexpected request: ${url.pathname}`)
      }) as typeof fetch,
      now: () => clock,
      dispatchRetryDelayMs: 100,
      requestTimeoutMs: 1_000,
      promptSettlementWindowMs: 5_000,
    })

    await unsafeOrchestrator.runOnce()
    expect(store.getJob(unsafeJob.jobId)).toMatchObject({
      state: 'queued',
      errorCode: 'COMFY_DUPLICATE_CLEANUP_FAILED',
    })
    expect(interruptCalls).toBe(0)
  })

  it.each([403, 405])(
    'falls back to a safe legacy interrupt when targeted duplicate cancellation returns HTTP %i',
    async (remoteStatus) => {
      let clock = 650_000 + remoteStatus
      const db = new Database(':memory:')
      dbs.push(db)
      const store = createComfyStore(db, {
        now: () => clock,
        randomUUID: () => `79797979-7979-4979-8979-79797979${remoteStatus}`,
        defaultTemplateDir: templateDir,
      })
      const job = await seedJob(store, {
        operationKey: `legacy-targeted-${remoteStatus}`,
        patch: {
          promptAttemptedAt: clock - 5_000,
          attemptSequenceHorizon: 0,
          remoteInputName: 'risu-comfy/source.png',
          remoteInputs: { input_image: 'risu-comfy/source.png' },
          dispatchRetryAt: clock - 1,
        },
      })
      let targetedCalls = 0
      let queueReads = 0
      let interruptCalls = 0
      const orchestrator = createComfyOrchestrator({
        store,
        registry: createTemplateRegistry({ templateDir }),
        assets: {},
        fetchImpl: (async (urlValue: string | URL | Request) => {
          const url = new URL(String(urlValue))
          if (url.pathname === '/api/jobs/running-duplicate/cancel') {
            targetedCalls += 1
            return new Response(null, { status: remoteStatus })
          }
          if (url.pathname === '/queue') {
            queueReads += 1
            return Response.json({
              queue_running: [[2, 'running-duplicate', {}, { risu_job_id: job.jobId }, ['63']]],
              queue_pending: [],
            })
          }
          if (url.pathname === '/history') {
            return Response.json({
              keeper: {
                prompt: [1, 'keeper', {}, { risu_job_id: job.jobId }, ['63']],
                outputs: {},
                status: { status_str: 'success', completed: true, messages: [] },
              },
            })
          }
          if (url.pathname === '/interrupt') {
            interruptCalls += 1
            return new Response(null, { status: 200 })
          }
          throw new Error(`Unexpected request: ${url.pathname}`)
        }) as typeof fetch,
        now: () => clock,
        pollIntervalMs: 100,
        dispatchRetryDelayMs: 100,
        requestTimeoutMs: 1_000,
        promptSettlementWindowMs: 5_000,
      })

      await orchestrator.runOnce()

      expect(targetedCalls).toBe(1)
      expect(queueReads).toBe(2)
      expect(interruptCalls).toBe(1)
      expect(store.getJob(job.jobId)).toMatchObject({
        state: 'queued',
        errorCode: 'COMFY_DUPLICATE_CLEANUP_PENDING',
      })
    },
  )

  it('returns a concurrent operation-key replay without mutating the live remote job', async () => {
    let clock = 700_000
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => '78787878-7878-4878-8878-787878787878',
      defaultTemplateDir: templateDir,
    })
    let statsCalls = 0
    let signalFirstSubmitProbe!: () => void
    const firstSubmitProbe = new Promise<void>(resolve => { signalFirstSubmitProbe = resolve })
    let releaseProbe!: () => void
    const probeGate = new Promise<void>(resolve => { releaseProbe = resolve })
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {
        readInputAsset: async () => ({ hash: 'A' }),
        uploadInput: async () => 'risu-comfy/source.png',
      },
      fetchImpl: (async (urlValue: string | URL | Request) => {
        const url = new URL(String(urlValue))
        if (url.pathname === '/system_stats') {
          statsCalls += 1
          if (statsCalls === 2) signalFirstSubmitProbe()
          if (statsCalls === 3) {
            await probeGate
            throw new TypeError('tunnel congested')
          }
          return Response.json({ system: {} })
        }
        if (url.pathname === '/queue') return Response.json({ queue_running: [], queue_pending: [] })
        if (url.pathname === '/history') return Response.json({})
        if (url.pathname === '/prompt') return Response.json({ prompt_id: 'live-prompt' })
        throw new Error(`Unexpected request: ${url.pathname}`)
      }) as typeof fetch,
      now: () => clock,
    })
    await orchestrator.updateEndpoint('http://127.0.0.1:8188')
    const args = {
      operationKey: 'duplicate-submit-replay',
      template: 'wan-i2v',
      slots: { positive: 'duplicate', input_image: 'source', seed: 3 },
    }

    const first = orchestrator.submit(args)
    await firstSubmitProbe
    const second = orchestrator.submit({ ...args, slots: { ...args.slots } })
    const firstSnapshot = await first
    await orchestrator.runOnce()
    const beforeReplay = store.getJob(firstSnapshot.jobId)
    expect(beforeReplay).toMatchObject({ state: 'remote_queued', promptId: 'live-prompt' })

    releaseProbe()
    const replaySnapshot = await second
    const afterReplay = store.getJob(firstSnapshot.jobId)
    expect(afterReplay).toEqual(beforeReplay)
    expect(replaySnapshot).toMatchObject({ state: 'remote_queued', promptId: 'live-prompt' })
    expect(replaySnapshot.error).toBeUndefined()
  })

  it('routes a defensive queued-plus-promptId row to reconciliation without dispatch', async () => {
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      randomUUID: () => '79797979-7979-4979-8979-797979797979',
      defaultTemplateDir: templateDir,
    })
    const job = await seedJob(store, {
      operationKey: 'queued-known-prompt-defense',
      patch: {
        promptId: 'already-known-prompt',
        remoteInputName: 'risu-comfy/source.png',
        remoteInputs: { input_image: 'risu-comfy/source.png' },
      },
    })
    let promptCalls = 0
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {},
      fetchImpl: (async (urlValue: string | URL | Request) => {
        const url = new URL(String(urlValue))
        if (url.pathname === '/history/already-known-prompt') return Response.json({})
        if (url.pathname === '/queue') {
          return Response.json({
            queue_running: [],
            queue_pending: [[1, 'already-known-prompt', {}, { risu_job_id: job.jobId }, ['63']]],
          })
        }
        if (url.pathname === '/prompt') {
          promptCalls += 1
          return Response.json({ prompt_id: 'duplicate' })
        }
        throw new Error(`Unexpected request: ${url.pathname}`)
      }) as typeof fetch,
    })

    await orchestrator.runOnce()
    expect(store.getJob(job.jobId)).toMatchObject({
      state: 'remote_queued',
      promptId: 'already-known-prompt',
    })
    expect(promptCalls).toBe(0)
  })

  it('services a healthy dispatch behind a continuously running reconciliation job', async () => {
    let clock = 800_000
    const ids = [
      '81818181-8181-4181-8181-818181818181',
      '82828282-8282-4282-8282-828282828282',
    ]
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => ids.shift()!,
      defaultTemplateDir: templateDir,
    })
    const running = await seedJob(store, {
      operationKey: 'fairness-running-head',
      patch: {
        state: 'running',
        promptId: 'long-running-prompt',
        remoteInputName: 'risu-comfy/source-a.png',
        remoteInputs: { input_image: 'risu-comfy/source-a.png' },
      },
    })
    const healthy = await seedJob(store, {
      operationKey: 'fairness-healthy-dispatch',
      inputHash: 'B',
    })
    let promptCalls = 0
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {
        readInputAsset: async () => ({ hash: 'B' }),
        uploadInput: async () => 'risu-comfy/source-b.png',
      },
      fetchImpl: (async (urlValue: string | URL | Request) => {
        const url = new URL(String(urlValue))
        if (url.pathname === '/history/long-running-prompt') return Response.json({})
        if (url.pathname === '/history') return Response.json({})
        if (url.pathname === '/queue') {
          return Response.json({
            queue_running: [[1, 'long-running-prompt', {}, { risu_job_id: running.jobId }, ['63']]],
            queue_pending: [],
          })
        }
        if (url.pathname === '/prompt') {
          promptCalls += 1
          return Response.json({ prompt_id: 'healthy-prompt' })
        }
        throw new Error(`Unexpected request: ${url.pathname}`)
      }) as typeof fetch,
      now: () => clock,
    })

    await orchestrator.runOnce()
    clock += 1
    await orchestrator.runOnce()

    expect(promptCalls).toBe(1)
    expect(store.getJob(healthy.jobId)).toMatchObject({
      state: 'remote_queued',
      promptId: 'healthy-prompt',
    })
  })

  it('honors a cancelling job retry gate while servicing other due work', async () => {
    let clock = 900_000
    const ids = [
      '83838383-8383-4383-8383-838383838383',
      '84848484-8484-4484-8484-848484848484',
    ]
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => ids.shift()!,
      defaultTemplateDir: templateDir,
    })
    const cancelling = await seedJob(store, {
      operationKey: 'cancel-backoff-gate',
      patch: {
        promptAttemptedAt: clock,
        dispatchRetryAt: clock + 1_000,
        remoteInputName: 'risu-comfy/source-cancel.png',
        remoteInputs: { input_image: 'risu-comfy/source-cancel.png' },
      },
    })
    const healthy = await seedJob(store, {
      operationKey: 'cancel-backoff-healthy',
      inputHash: 'C',
    })
    let queueCalls = 0
    let promptCalls = 0
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {
        readInputAsset: async () => ({ hash: 'C' }),
        uploadInput: async () => 'risu-comfy/source-c.png',
      },
      fetchImpl: (async (urlValue: string | URL | Request) => {
        const url = new URL(String(urlValue))
        if (url.pathname === '/queue') {
          queueCalls += 1
          return Response.json({ queue_running: [], queue_pending: [] })
        }
        if (url.pathname === '/history') return Response.json({})
        if (url.pathname === '/prompt') {
          promptCalls += 1
          return Response.json({ prompt_id: 'healthy-after-cancel-backoff' })
        }
        throw new Error(`Unexpected request: ${url.pathname}`)
      }) as typeof fetch,
      now: () => clock,
      dispatchRetryDelayMs: 1_000,
      requestTimeoutMs: 100,
      promptSettlementWindowMs: 5_000,
    })

    await orchestrator.cancel(cancelling.jobId)
    await orchestrator.runOnce()
    await orchestrator.runOnce()

    expect(queueCalls).toBe(2)
    expect(promptCalls).toBe(1)
    expect(store.getJob(healthy.jobId)).toMatchObject({ promptId: 'healthy-after-cancel-backoff' })
    expect(store.getJob(cancelling.jobId)).toMatchObject({
      state: 'queued',
      terminalIntent: 'user_cancel',
      dispatchRetryAt: clock + 5_000,
    })
  })

  it('does not mistake a future materialization retry time for cancellation backoff', async () => {
    let clock = 950_000
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => '89898989-8989-4989-8989-898989898989',
      defaultTemplateDir: templateDir,
    })
    const job = await seedJob(store, {
      operationKey: 'cancel-materialize-backoff',
      patch: {
        state: 'remote_queued',
        promptId: 'materializing-cancel-prompt',
        materializeRetryAt: clock + 60_000,
      },
    })
    let deleteCalls = 0
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {},
      fetchImpl: (async (urlValue: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(urlValue))
        if (url.pathname === '/history/materializing-cancel-prompt') return Response.json({})
        if (url.pathname === '/queue' && init?.method === 'POST') {
          deleteCalls += 1
          return new Response(null, { status: 200 })
        }
        if (url.pathname === '/queue') {
          return Response.json({
            queue_running: [],
            queue_pending: [[1, job.promptId, {}, { risu_job_id: job.jobId }, ['63']]],
          })
        }
        throw new Error(`Unexpected request: ${url.pathname}`)
      }) as typeof fetch,
      now: () => clock,
    })

    await orchestrator.cancel(job.jobId)
    await orchestrator.runOnce()
    expect(deleteCalls).toBe(1)
  })

  it('finishes user cancellation immediately from materialization backoff and cleans local artifacts', async () => {
    const clock = 975_000
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => '90909090-9090-4090-8090-909090909090',
      defaultTemplateDir: templateDir,
    })
    const job = await seedJob(store, {
      operationKey: 'cancel-materializing-local',
      patch: {
        state: 'materializing',
        promptId: 'already-completed-prompt',
        remoteOutput: { filename: 'completed.mp4', subfolder: '', type: 'output' },
        materializeRetryAt: clock + 60_000,
      },
    })
    const removed: string[] = []
    const finalized: string[] = []
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {
        removeMaterializedAsset: async (assetId: string) => { removed.push(assetId) },
        finalizeMaterialization: async (jobId: string) => { finalized.push(jobId) },
      },
      fetchImpl: (async (urlValue: string | URL | Request) => {
        throw new Error(`Unexpected request: ${new URL(String(urlValue)).pathname}`)
      }) as typeof fetch,
      now: () => clock,
    })

    await orchestrator.cancel(job.jobId)
    await orchestrator.runOnce()

    expect(store.getJob(job.jobId)).toMatchObject({ state: 'cancelled' })
    expect(removed).toEqual([`comfy-${job.jobId}`])
    expect(finalized).toEqual([job.jobId])
  })

  it('rotates within the reconciliation lane even when the clock is fixed', async () => {
    const clock = 1_000_000
    const ids = [
      '85858585-8585-4585-8585-858585858585',
      '86868686-8686-4686-8686-868686868686',
    ]
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => ids.shift()!,
      defaultTemplateDir: templateDir,
    })
    const first = await seedJob(store, {
      operationKey: 'rotate-reconcile-first',
      patch: { state: 'running', promptId: 'rotate-prompt-1' },
    })
    const second = await seedJob(store, {
      operationKey: 'rotate-reconcile-second',
      inputHash: 'D',
      patch: { state: 'running', promptId: 'rotate-prompt-2' },
    })
    const serviced: string[] = []
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {},
      fetchImpl: (async (urlValue: string | URL | Request) => {
        const url = new URL(String(urlValue))
        if (url.pathname.startsWith('/history/')) {
          serviced.push(url.pathname)
          return Response.json({})
        }
        if (url.pathname === '/queue') {
          return Response.json({
            queue_running: [
              [1, first.promptId, {}, { risu_job_id: first.jobId }, ['63']],
              [2, second.promptId, {}, { risu_job_id: second.jobId }, ['63']],
            ],
            queue_pending: [],
          })
        }
        throw new Error(`Unexpected request: ${url.pathname}`)
      }) as typeof fetch,
      now: () => clock,
    })

    await orchestrator.runOnce()
    await orchestrator.runOnce()

    expect(serviced).toEqual(['/history/rotate-prompt-1', '/history/rotate-prompt-2'])
  })

  it('rescans a proof-parked queued job immediately after endpoint replacement without erasing its message', async () => {
    let clock = 995_000
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => '81818181-8181-4181-8181-818181818181',
      defaultTemplateDir: templateDir,
    })
    const proofMessage = 'ComfyUI 원격 접수 여부를 증명할 수 없어요 — 대기 중이며 취소할 수 있어요'
    const job = await seedJob(store, {
      operationKey: 'endpoint-proof-parked-rescan',
      patch: {
        promptAttemptedAt: clock - 5_000,
        attemptSequenceHorizon: 0,
        remoteInputName: 'risu-comfy/source.png',
        remoteInputs: { input_image: 'risu-comfy/source.png' },
        dispatchRetryAt: clock + 30_000,
        errorCode: 'COMFY_SUBMISSION_PROOF_UNAVAILABLE',
        errorMessage: proofMessage,
      },
    })
    let queueReads = 0
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {},
      fetchImpl: (async (urlValue: string | URL | Request) => {
        const url = new URL(String(urlValue))
        if (url.pathname === '/system_stats') return Response.json({ system: {} })
        if (url.pathname === '/queue') {
          expect(url.origin).toBe('http://127.0.0.1:8288')
          queueReads += 1
          return Response.json({ queue_running: [], queue_pending: [] })
        }
        if (url.pathname === '/history') return Response.json({})
        throw new Error(`Unexpected request: ${url.pathname}`)
      }) as typeof fetch,
      now: () => clock,
      pollIntervalMs: 100,
      dispatchRetryDelayMs: 100,
      requestTimeoutMs: 1_000,
      promptSettlementWindowMs: 1_000,
    })

    await orchestrator.updateEndpoint('http://127.0.0.1:8288')
    expect(store.getJob(job.jobId)).toMatchObject({
      state: 'queued',
      endpointUrl: 'http://127.0.0.1:8288',
      dispatchRetryAt: null,
      errorCode: 'COMFY_SUBMISSION_PROOF_UNAVAILABLE',
      errorMessage: proofMessage,
    })

    await orchestrator.runOnce()
    expect(queueReads).toBe(1)
  })

  it('aborts and detaches a stale hanging run when the Comfy endpoint changes', async () => {
    const ids = [
      '87878787-8787-4787-8787-878787878787',
      '88888888-8888-4888-8888-888888888888',
    ]
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      randomUUID: () => ids.shift()!,
      defaultTemplateDir: templateDir,
    })
    const hanging = await seedJob(store, { operationKey: 'endpoint-hanging-old-run' })
    let releaseUpload!: () => void
    const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve })
    let uploadStarted!: () => void
    const started = new Promise<void>(resolve => { uploadStarted = resolve })
    let hangingSignal: AbortSignal | undefined
    let promptCalls = 0
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {
        readInputAsset: async () => ({ hash: 'A' }),
        uploadInput: async (_endpoint: string, jobId: string, _input: unknown, options?: any) => {
          if (jobId === hanging.jobId) {
            hangingSignal = options?.signal
            uploadStarted()
            await uploadGate
            return 'risu-comfy/stale.png'
          }
          return 'risu-comfy/healthy.png'
        },
      },
      fetchImpl: (async (urlValue: string | URL | Request) => {
        const url = new URL(String(urlValue))
        if (url.pathname === '/system_stats') return Response.json({ system: {} })
        if (url.pathname === '/queue') return Response.json({ queue_running: [], queue_pending: [] })
        if (url.pathname === '/history') return Response.json({})
        if (url.pathname === '/prompt') {
          promptCalls += 1
          return Response.json({ prompt_id: 'post-switch-healthy' })
        }
        throw new Error(`Unexpected request: ${url.pathname}`)
      }) as typeof fetch,
      stopDrainTimeoutMs: 10,
    })

    const oldRun = orchestrator.runOnce()
    await started
    await orchestrator.updateEndpoint('http://127.0.0.1:8288')
    const healthy = await seedJob(store, {
      operationKey: 'endpoint-post-switch-healthy',
      patch: {
        endpointUrl: 'http://127.0.0.1:8288',
        endpointGeneration: store.getConfig().endpointGeneration,
      },
    })

    const postSwitch = orchestrator.runOnce()
    const serviceResult = await Promise.race([
      postSwitch.then(() => 'serviced'),
      new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 40)),
    ])
    const hangingBeforeLateCompletion = store.getJob(hanging.jobId)
    releaseUpload()
    await oldRun

    expect(hangingSignal?.aborted).toBe(true)
    expect(serviceResult).toBe('serviced')
    expect(promptCalls).toBe(1)
    expect(store.getJob(healthy.jobId)).toMatchObject({
      state: 'remote_queued',
      promptId: 'post-switch-healthy',
    })
    expect(store.getJob(hanging.jobId)).toEqual(hangingBeforeLateCompletion)
  })

  it('blocks stale marker cleanup side effects after endpoint replacement detaches a scan', async () => {
    let clock = 1_100_000
    const ids = [
      '91919191-9191-4191-8191-919191919191',
      '92929292-9292-4292-8292-929292929292',
    ]
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => ids.shift()!,
      defaultTemplateDir: templateDir,
    })
    const stale = await seedJob(store, {
      operationKey: 'stale-marker-cleanup',
      patch: {
        promptAttemptedAt: clock,
        remoteInputName: 'risu-comfy/stale.png',
        remoteInputs: { input_image: 'risu-comfy/stale.png' },
        dispatchRetryAt: clock - 1,
      },
    })
    let releaseOldQueue!: () => void
    const oldQueueGate = new Promise<void>(resolve => { releaseOldQueue = resolve })
    let signalOldQueue!: () => void
    const oldQueueStarted = new Promise<void>(resolve => { signalOldQueue = resolve })
    let oldHistoryCalls = 0
    let oldDeleteCalls = 0
    let newPromptCalls = 0
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {
        readInputAsset: async () => ({ hash: 'A' }),
        uploadInput: async () => 'risu-comfy/new.png',
      },
      fetchImpl: (async (urlValue: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(urlValue))
        if (url.port === '8188' && url.pathname === '/queue' && init?.method !== 'POST') {
          signalOldQueue()
          await oldQueueGate
          return Response.json({
            queue_running: [],
            queue_pending: [
              [1, 'stale-keeper', {}, { risu_job_id: stale.jobId }, ['63']],
              [2, 'stale-duplicate', {}, { risu_job_id: stale.jobId }, ['63']],
            ],
          })
        }
        if (url.port === '8188' && url.pathname === '/history') {
          oldHistoryCalls += 1
          return Response.json({})
        }
        if (url.port === '8188' && url.pathname === '/queue' && init?.method === 'POST') {
          oldDeleteCalls += 1
          return new Response(null, { status: 200 })
        }
        if (url.port === '8288' && url.pathname === '/system_stats') {
          return Response.json({ system: {} })
        }
        if (url.port === '8288' && url.pathname === '/queue') {
          return Response.json({ queue_running: [], queue_pending: [] })
        }
        if (url.port === '8288' && url.pathname === '/history') return Response.json({})
        if (url.port === '8288' && url.pathname === '/prompt') {
          newPromptCalls += 1
          return Response.json({ prompt_id: 'new-endpoint-healthy' })
        }
        throw new Error(`Unexpected request: ${url.toString()}`)
      }) as typeof fetch,
      now: () => clock,
      stopDrainTimeoutMs: 10,
    })

    const staleRun = orchestrator.runOnce()
    await oldQueueStarted
    await orchestrator.updateEndpoint('http://127.0.0.1:8288')
    expect(store.getJob(stale.jobId)).toMatchObject({
      state: 'queued',
      promptAttemptedAt: clock,
    })
    const healthy = await seedJob(store, {
      operationKey: 'post-marker-detach-healthy',
      patch: {
        endpointUrl: 'http://127.0.0.1:8288',
        endpointGeneration: store.getConfig().endpointGeneration,
      },
    })
    await orchestrator.runOnce()
    releaseOldQueue()
    await staleRun

    expect(oldHistoryCalls).toBe(0)
    expect(oldDeleteCalls).toBe(0)
    expect(newPromptCalls).toBe(1)
    expect(store.getJob(healthy.jobId)).toMatchObject({ promptId: 'new-endpoint-healthy' })
  })

  it('alternates a due cancellation with regular work and paces interrupt reissue', async () => {
    let clock = 1_200_000
    const ids = [
      '93939393-9393-4393-8393-939393939393',
      '94949494-9494-4494-8494-949494949494',
    ]
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => ids.shift()!,
      defaultTemplateDir: templateDir,
    })
    let cancelling = await seedJob(store, { operationKey: 'paced-running-cancel' })
    cancelling = store.updateJob(cancelling.jobId, cancelling.revision, 'queued', {
      state: 'running',
      promptId: 'paced-running-prompt',
    })
    const healthy = await seedJob(store, {
      operationKey: 'healthy-after-paced-cancel',
      inputHash: 'B',
    })
    let interruptCalls = 0
    let promptCalls = 0
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {
        readInputAsset: async () => ({ hash: 'B' }),
        uploadInput: async () => 'risu-comfy/healthy.png',
      },
      fetchImpl: (async (urlValue: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(urlValue))
        if (url.pathname === '/history/paced-running-prompt') return Response.json({})
        if (url.pathname === '/interrupt') {
          interruptCalls += 1
          return new Response(null, { status: 200 })
        }
        if (url.pathname === '/queue') {
          return Response.json({
            queue_running: [[1, 'paced-running-prompt', {}, { risu_job_id: cancelling.jobId }, ['63']]],
            queue_pending: [],
          })
        }
        if (url.pathname === '/history') return Response.json({})
        if (url.pathname === '/prompt') {
          promptCalls += 1
          return Response.json({ prompt_id: 'healthy-paced-prompt' })
        }
        throw new Error(`Unexpected request: ${url.pathname} ${init?.method ?? 'GET'}`)
      }) as typeof fetch,
      now: () => clock,
      pollIntervalMs: 50,
      dispatchRetryDelayMs: 100,
    })

    await orchestrator.cancel(cancelling.jobId)
    await orchestrator.runOnce()
    expect(interruptCalls).toBe(1)
    expect(store.getJob(cancelling.jobId).dispatchRetryAt).toBe(clock + 100)

    await orchestrator.runOnce()
    expect(interruptCalls).toBe(1)
    expect(promptCalls).toBe(1)
    expect(store.getJob(healthy.jobId)).toMatchObject({
      state: 'remote_queued',
      promptId: 'healthy-paced-prompt',
    })

    clock += 101
    await orchestrator.runOnce()
    expect(interruptCalls).toBe(2)
    expect(store.getJob(cancelling.jobId).dispatchRetryAt).toBe(clock + 100)
  })

  it('lets materialization advance immediately after servicing a cancellation', async () => {
    let clock = 1_250_000
    const ids = [
      'a3a3a3a3-a3a3-43a3-83a3-a3a3a3a3a3a3',
      'a4a4a4a4-a4a4-44a4-84a4-a4a4a4a4a4a4',
    ]
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => ids.shift()!,
      defaultTemplateDir: templateDir,
    })
    let cancelling = await seedJob(store, { operationKey: 'cancel-before-materialize' })
    cancelling = store.updateJob(cancelling.jobId, cancelling.revision, 'queued', {
      state: 'running',
      promptId: 'cancel-before-materialize-prompt',
    })
    let materializing = await seedJob(store, {
      operationKey: 'materialize-after-cancel',
      inputHash: 'B',
    })
    materializing = store.updateJob(materializing.jobId, materializing.revision, 'queued', {
      state: 'materializing',
      promptId: 'materialize-after-cancel-prompt',
      remoteOutput: { filename: 'after-cancel.mp4', subfolder: '', type: 'output' },
    })
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {
        recoverMaterialization: async () => ({
          resultAssetId: `comfy-${materializing.jobId}`,
          mimeType: 'video/mp4',
        }),
        finalizeMaterialization: async () => {},
      },
      fetchImpl: (async (urlValue: string | URL | Request) => {
        const url = new URL(String(urlValue))
        if (url.pathname === '/history/cancel-before-materialize-prompt') return Response.json({})
        if (url.pathname === '/queue') {
          return Response.json({
            queue_running: [[1, cancelling.promptId, {}, { risu_job_id: cancelling.jobId }, ['63']]],
            queue_pending: [],
          })
        }
        if (url.pathname === '/interrupt') return new Response(null, { status: 200 })
        throw new Error(`Unexpected request: ${url.pathname}`)
      }) as typeof fetch,
      now: () => clock,
      dispatchRetryDelayMs: 100,
    })

    await orchestrator.cancel(cancelling.jobId)
    await orchestrator.runOnce()
    await orchestrator.runOnce()

    expect(store.getJob(materializing.jobId)).toMatchObject({
      state: 'succeeded',
      resultAssetId: `comfy-${materializing.jobId}`,
    })
  })

  it('does not locally finish a queued legacy row that still owns a remote prompt', async () => {
    let clock = 1_300_000
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => '95959595-9595-4595-8595-959595959595',
      defaultTemplateDir: templateDir,
    })
    let job = await seedJob(store, { operationKey: 'legacy-queued-prompt-cancel' })
    job = store.updateJob(job.jobId, job.revision, 'queued', {
      promptId: 'legacy-owned-prompt',
    })
    let pending = true
    let deleteCalls = 0
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {},
      fetchImpl: (async (urlValue: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(urlValue))
        if (url.pathname === '/history/legacy-owned-prompt') return Response.json({})
        if (url.pathname === '/queue' && init?.method === 'POST') {
          deleteCalls += 1
          pending = false
          return new Response(null, { status: 200 })
        }
        if (url.pathname === '/queue') {
          return Response.json({
            queue_running: [],
            queue_pending: pending
              ? [[1, 'legacy-owned-prompt', {}, { risu_job_id: job.jobId }, ['63']]]
              : [],
          })
        }
        throw new Error(`Unexpected request: ${url.pathname}`)
      }) as typeof fetch,
      now: () => clock,
      dispatchRetryDelayMs: 100,
    })

    await expect(orchestrator.cancel(job.jobId)).resolves.toMatchObject({
      state: 'cancel_requested',
      promptId: 'legacy-owned-prompt',
    })
    await orchestrator.runOnce()
    expect(deleteCalls).toBe(1)
  })

  it('does not abort another jobs active transfer when cancellation targets a different job', async () => {
    const ids = [
      '96969696-9696-4696-8696-969696969696',
      '97979797-9797-4797-8797-979797979797',
    ]
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      randomUUID: () => ids.shift()!,
      defaultTemplateDir: templateDir,
    })
    const healthy = await seedJob(store, { operationKey: 'active-healthy-transfer' })
    let unrelated = await seedJob(store, { operationKey: 'unrelated-cancel-target', inputHash: 'B' })
    unrelated = store.updateJob(unrelated.jobId, unrelated.revision, 'queued', {
      state: 'running',
      promptId: 'unrelated-running-prompt',
      dispatchRetryAt: Date.now() + 60_000,
    })
    let releaseUpload!: () => void
    const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve })
    let signalUploadStarted!: () => void
    const uploadStarted = new Promise<void>(resolve => { signalUploadStarted = resolve })
    let uploadSignal: AbortSignal | undefined
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {
        readInputAsset: async () => ({ hash: 'A' }),
        uploadInput: async (_endpoint: string, _jobId: string, _input: unknown, options?: any) => {
          uploadSignal = options?.signal
          signalUploadStarted()
          await uploadGate
          if (uploadSignal?.aborted) throw uploadSignal.reason
          return 'risu-comfy/healthy-active.png'
        },
      },
      fetchImpl: (async (urlValue: string | URL | Request) => {
        const url = new URL(String(urlValue))
        if (url.pathname === '/prompt') return Response.json({ prompt_id: 'healthy-active-prompt' })
        if (url.pathname === '/queue') return Response.json({ queue_running: [], queue_pending: [] })
        if (url.pathname === '/history') return Response.json({})
        throw new Error(`Unexpected request: ${url.pathname}`)
      }) as typeof fetch,
    })

    const activeRun = orchestrator.runOnce()
    await uploadStarted
    await orchestrator.cancel(unrelated.jobId)
    const unrelatedCancelAbortedUpload = uploadSignal?.aborted
    releaseUpload()
    await activeRun

    expect(unrelatedCancelAbortedUpload).toBe(false)
    expect(store.getJob(healthy.jobId)).toMatchObject({
      state: 'remote_queued',
      promptId: 'healthy-active-prompt',
    })
  })

  it('keeps a nonterminal legacy promptless attempt inside the settlement window', async () => {
    let clock = 1_400_000
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => clock,
      randomUUID: () => '98989898-9898-4898-8898-989898989898',
      defaultTemplateDir: templateDir,
    })
    let job = await seedJob(store, { operationKey: 'legacy-promptless-settlement' })
    job = store.updateJob(job.jobId, job.revision, 'queued', {
      state: 'unknown',
      promptAttemptedAt: clock,
      remoteInputName: 'risu-comfy/legacy.png',
      remoteInputs: { input_image: 'risu-comfy/legacy.png' },
      dispatchRetryAt: clock - 1,
    })
    let promptCalls = 0
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: {},
      fetchImpl: (async (urlValue: string | URL | Request) => {
        const url = new URL(String(urlValue))
        if (url.pathname === '/queue') return Response.json({ queue_running: [], queue_pending: [] })
        if (url.pathname === '/history') return Response.json({})
        if (url.pathname === '/prompt') {
          promptCalls += 1
          return Response.json({ prompt_id: 'legacy-promptless-retried' })
        }
        throw new Error(`Unexpected request: ${url.pathname}`)
      }) as typeof fetch,
      now: () => clock,
      pollIntervalMs: 100,
      dispatchRetryDelayMs: 100,
      requestTimeoutMs: 50,
      promptSettlementWindowMs: 1_000,
    })

    await orchestrator.runOnce()
    expect(store.getJob(job.jobId)).toMatchObject({
      state: 'queued',
      absenceCount: 0,
      errorCode: 'COMFY_SUBMISSION_SETTLING',
      dispatchRetryAt: clock + 5_000,
    })

    clock += 5_001
    await orchestrator.runOnce()
    expect(store.getJob(job.jobId)).toMatchObject({ state: 'queued', absenceCount: 1 })
    clock += 101
    await orchestrator.runOnce()
    expect(store.getJob(job.jobId)).toMatchObject({
      state: 'remote_queued',
      promptId: 'legacy-promptless-retried',
    })
    expect(promptCalls).toBe(1)
  })

  it('skips a real timer poll before the default two-poll retry cadence is due', async () => {
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      randomUUID: () => '99999999-9999-4999-8999-999999999999',
      defaultTemplateDir: templateDir,
    })
    let job = await seedJob(store, { operationKey: 'real-timer-cancel-cadence' })
    job = store.updateJob(job.jobId, job.revision, 'queued', {
      state: 'running',
      promptId: 'real-timer-running-prompt',
    })
    let interruptCalls = 0
    let signalFirstInterrupt!: () => void
    const firstInterrupt = new Promise<void>(resolve => { signalFirstInterrupt = resolve })
    const orchestrator = createComfyOrchestrator({
      store,
      registry: createTemplateRegistry({ templateDir }),
      assets: { cleanupOrphanStaging: async () => {} },
      fetchImpl: (async (urlValue: string | URL | Request) => {
        const url = new URL(String(urlValue))
        if (url.pathname === '/history/real-timer-running-prompt') return Response.json({})
        if (url.pathname === '/queue') {
          return Response.json({
            queue_running: [[1, job.promptId, {}, { risu_job_id: job.jobId }, ['63']]],
            queue_pending: [],
          })
        }
        if (url.pathname === '/interrupt') {
          interruptCalls += 1
          if (interruptCalls === 1) signalFirstInterrupt()
          return new Response(null, { status: 200 })
        }
        throw new Error(`Unexpected request: ${url.pathname}`)
      }) as typeof fetch,
      pollIntervalMs: 40,
    })

    await orchestrator.cancel(job.jobId)
    await orchestrator.start()
    await firstInterrupt
    await new Promise(resolve => setTimeout(resolve, 65))
    await orchestrator.stop()

    expect(interruptCalls).toBe(1)
  })
})
