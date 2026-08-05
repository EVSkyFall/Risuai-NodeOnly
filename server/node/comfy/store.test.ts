// @vitest-environment node

import Database from 'better-sqlite3'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import pkg from './store.cjs'

const { createComfyStore } = pkg as {
  createComfyStore: (db: any, options?: {
    now?: () => number
    randomUUID?: () => string
    defaultTemplateDir?: string
    logger?: { warn?: (...args: any[]) => void }
  }) => {
    createOrReplayJob: (input: any) => { replayed: boolean; job: any }
    findByOperationKey: (operationKey: string) => any
    updateJob: (jobId: string, revision: number, states: string | string[], patch: any) => any
    getConfig: () => any
    updateConfig: (input: any) => any
    purgeForRestore: () => number
  }
}

const dbs: any[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const db of dbs.splice(0)) db.close()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })))
})

describe('Comfy durable submission receipts', () => {
  it('creates job and receipt atomically, replays the same binding, and rejects key reuse', () => {
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => 1_000,
      randomUUID: () => '11111111-1111-4111-8111-111111111111',
      defaultTemplateDir: 'C:\\templates',
    })
    const request = {
      operationKey: 'plugin-install:message-7:wan',
      binding: {
        templateId: 'wan-i2v',
        templateHash: 'ABC',
        slots: { positive: 'walk', input_image: 'inlay-1', seed: 9 },
        inputAssetId: 'inlay-1',
        inputHash: 'DEF',
        endpointGeneration: 1,
      },
      job: {
        templateId: 'wan-i2v',
        templateHash: 'ABC',
        templateJson: '{"6":{"inputs":{"text":"{{positive}}"}}}',
        slots: { positive: 'walk', input_image: 'inlay-1', seed: 9 },
        inputAssetId: 'inlay-1',
        inputHash: 'DEF',
        endpointUrl: 'http://127.0.0.1:8188',
        endpointGeneration: 1,
        timeoutMs: 600_000,
      },
    }

    const created = store.createOrReplayJob(request)
    expect(created.replayed).toBe(false)
    expect(created.job).toMatchObject({
      jobId: '11111111-1111-4111-8111-111111111111',
      operationKey: request.operationKey,
      state: 'queued',
      revision: 0,
      deadlineAt: 601_000,
    })

    const replay = store.createOrReplayJob({
      ...request,
      binding: {
        inputHash: 'DEF',
        endpointGeneration: 1,
        inputAssetId: 'inlay-1',
        slots: { seed: 9, input_image: 'inlay-1', positive: 'walk' },
        templateHash: 'ABC',
        templateId: 'wan-i2v',
      },
    })
    expect(replay.replayed).toBe(true)
    expect(replay.job.jobId).toBe(created.job.jobId)
    expect(store.findByOperationKey(request.operationKey).jobId).toBe(created.job.jobId)

    expect(() => store.createOrReplayJob({
      ...request,
      binding: { ...request.binding, inputHash: 'CHANGED' },
    })).toThrowError(expect.objectContaining({
      code: 'COMFY_OPERATION_KEY_CONFLICT',
      httpStatus: 409,
    }))

    expect(db.prepare('SELECT COUNT(*) AS count FROM comfy_jobs').get().count).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS count FROM comfy_receipts').get().count).toBe(1)
  })

  it('makes a terminal CAS result immutable', () => {
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => 2_000,
      randomUUID: () => '22222222-2222-4222-8222-222222222222',
    })
    const created = store.createOrReplayJob({
      operationKey: 'terminal-once',
      binding: { templateId: 'wan-i2v', inputHash: 'A' },
      job: {
        templateId: 'wan-i2v',
        templateHash: 'A',
        templateJson: '{}',
        slots: { positive: '', input_image: 'x.png', seed: 1 },
        inputAssetId: 'x',
        inputHash: 'A',
        endpointUrl: 'http://127.0.0.1:8188',
        endpointGeneration: 1,
        timeoutMs: 10_000,
      },
    }).job

    const succeeded = store.updateJob(created.jobId, 0, 'queued', {
      state: 'succeeded',
      resultAssetId: 'comfy-result',
      resultMimeType: 'video/mp4',
      finishedAt: 2_100,
    })
    expect(succeeded.state).toBe('succeeded')

    expect(store.updateJob(succeeded.jobId, succeeded.revision, 'succeeded', {
      state: 'failed',
      errorCode: 'late_error',
    })).toBeNull()
  })

  it('purges jobs and receipts atomically while retaining server-local configuration', () => {
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => 3_000,
      randomUUID: () => '33333333-3333-4333-8333-333333333333',
      defaultTemplateDir: 'C:\\templates',
    })
    store.updateConfig({ endpointUrl: 'https://example.trycloudflare.com' })
    store.createOrReplayJob({
      operationKey: 'restore-me',
      binding: { templateId: 'wan-i2v', inputHash: 'A' },
      job: {
        templateId: 'wan-i2v',
        templateHash: 'A',
        templateJson: '{}',
        slots: { positive: '', input_image: 'x.png', seed: 1 },
        inputAssetId: 'x',
        inputHash: 'A',
        endpointUrl: 'https://example.trycloudflare.com',
        endpointGeneration: 2,
        timeoutMs: 10_000,
      },
    })
    const before = store.getConfig()

    expect(() => db.transaction(() => {
      store.purgeForRestore()
      throw new Error('roll back the outer world replacement')
    })()).toThrow('roll back')
    expect(store.findByOperationKey('restore-me')).not.toBeNull()
    expect(store.getConfig().restoreEpoch).toBe(before.restoreEpoch)

    expect(store.purgeForRestore()).toBe(1)
    expect(store.findByOperationKey('restore-me')).toBeNull()
    expect(store.getConfig()).toMatchObject({
      endpointUrl: before.endpointUrl,
      endpointGeneration: before.endpointGeneration,
      templateDir: before.templateDir,
      restoreEpoch: before.restoreEpoch + 1,
    })
  })

  it('repairs only a stale template directory when the current bundled default is valid', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'comfy-store-template-dir-'))
    dirs.push(root)
    const oldCustom = path.join(root, 'custom')
    const currentDefault = path.join(root, 'bundled')
    await mkdir(oldCustom)
    await mkdir(currentDefault)
    const db = new Database(':memory:')
    dbs.push(db)
    let clock = 4_000
    const first = createComfyStore(db, {
      now: () => clock,
      defaultTemplateDir: oldCustom,
    })
    first.updateConfig({
      endpointUrl: 'https://example.trycloudflare.com',
      timeoutMs: 12_345,
    })
    db.prepare(`
      UPDATE comfy_config
      SET template_dir = ?, endpoint_generation = 7, restore_epoch = 9, updated_at = ?
      WHERE id = 1
    `).run(path.join(root, 'moved-away'), 4_100)
    clock = 5_000

    const repaired = createComfyStore(db, {
      now: () => clock,
      defaultTemplateDir: currentDefault,
      logger: { warn: () => {} },
    }).getConfig()
    expect(repaired).toMatchObject({
      templateDir: currentDefault,
      endpointUrl: 'https://example.trycloudflare.com',
      timeoutMs: 12_345,
      endpointGeneration: 7,
      restoreEpoch: 9,
      updatedAt: 5_000,
    })

    db.prepare('UPDATE comfy_config SET template_dir = ? WHERE id = 1').run(oldCustom)
    expect(createComfyStore(db, {
      defaultTemplateDir: currentDefault,
    }).getConfig().templateDir).toBe(oldCustom)

    db.prepare('UPDATE comfy_config SET template_dir = ? WHERE id = 1').run(path.join(root, 'still-stale'))
    expect(createComfyStore(db, {
      defaultTemplateDir: path.join(root, 'missing-default'),
    }).getConfig().templateDir).toBe(path.join(root, 'still-stale'))
  })

  it('migrates legacy jobs with their original timeout and durable materialization defaults', () => {
    const db = new Database(':memory:')
    dbs.push(db)
    db.exec(`
      CREATE TABLE comfy_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        endpoint_url TEXT NOT NULL DEFAULT '',
        timeout_ms INTEGER NOT NULL DEFAULT 600000,
        template_dir TEXT NOT NULL,
        endpoint_generation INTEGER NOT NULL DEFAULT 1,
        restore_epoch INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE comfy_jobs (
        job_id TEXT PRIMARY KEY,
        operation_key TEXT NOT NULL UNIQUE,
        binding_hash TEXT NOT NULL,
        template_id TEXT NOT NULL,
        template_hash TEXT NOT NULL,
        template_json TEXT NOT NULL,
        slots_json TEXT NOT NULL,
        input_asset_id TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        endpoint_url TEXT NOT NULL,
        endpoint_generation INTEGER NOT NULL,
        state TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        prompt_id TEXT,
        remote_input_name TEXT,
        remote_output_json TEXT,
        result_asset_id TEXT,
        result_mime_type TEXT,
        terminal_intent TEXT,
        cancel_requested_at INTEGER,
        absence_count INTEGER NOT NULL DEFAULT 0,
        absence_confirmed_at INTEGER,
        deadline_at INTEGER NOT NULL,
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE TABLE comfy_receipts (
        operation_key TEXT PRIMARY KEY,
        binding_hash TEXT NOT NULL,
        job_id TEXT NOT NULL REFERENCES comfy_jobs(job_id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      );
      INSERT INTO comfy_config VALUES (
        1, 'http://127.0.0.1:8188', 7777, 'missing-template-dir', 3, 4, 1000
      );
      INSERT INTO comfy_jobs (
        job_id, operation_key, binding_hash, template_id, template_hash, template_json,
        slots_json, input_asset_id, input_hash, endpoint_url, endpoint_generation,
        state, revision, deadline_at, created_at, updated_at
      ) VALUES (
        'legacy-job', 'legacy-operation', 'BINDING', 'wan-i2v', 'HASH', '{}',
        '{"positive":"x","input_image":"source","seed":1}', 'source', 'INPUT',
        'http://127.0.0.1:8188', 3, 'queued', 0, 5321, 1000, 1000
      );
      INSERT INTO comfy_receipts VALUES ('legacy-operation', 'BINDING', 'legacy-job', 1000);
    `)

    const store = createComfyStore(db, {
      now: () => 10_000,
      defaultTemplateDir: 'also-missing',
    })
    expect(store.findByOperationKey('legacy-operation')).toMatchObject({
      timeoutMs: 4_321,
      target: null,
      templateKind: 'video',
      templateSlots: null,
      outputDescriptor: null,
      inputAssets: { input_image: { assetId: 'source', hash: 'INPUT' } },
      remoteInputs: {},
      promptAttemptedAt: null,
      materializeAttempts: 0,
      materializeRetryAt: null,
    })
    expect(db.prepare('PRAGMA table_info(comfy_jobs)').all().map((column: any) => column.name))
      .toEqual(expect.arrayContaining([
        'timeout_ms',
        'target_json',
        'materialize_attempts',
        'materialize_retry_at',
        'template_kind',
        'template_slots_json',
        'output_descriptor_json',
        'input_assets_json',
        'remote_inputs_json',
        'prompt_attempted_at',
      ]))
  })

  it('stores zero-input job sentinels and retains immutable custom templates when jobs are purged', () => {
    const db = new Database(':memory:')
    dbs.push(db)
    const store = createComfyStore(db, {
      now: () => 20_000,
      randomUUID: () => '44444444-4444-4444-8444-444444444444',
    }) as any
    const custom = {
      id: 'a'.repeat(64),
      name: 'Still',
      kind: 'image',
      mode: 't2i',
      graphJson: '{"save":{"class_type":"SaveImage","inputs":{}}}',
      slots: { positive: { nodeId: 'text', inputName: 'text' }, inputImages: [], seeds: [] },
      outputDescriptor: { nodeId: 'save', classType: 'SaveImage', historyKey: 'images', mediaType: 'image/png' },
      promptProfile: 'image-tags',
    }
    expect(store.createCustomTemplate(custom)).toMatchObject({ created: true, template: custom })
    const job = store.createOrReplayJob({
      operationKey: 'zero-input',
      binding: { templateId: custom.id, slots: { positive: 'x' } },
      job: {
        templateId: custom.id,
        templateHash: 'HASH',
        templateJson: custom.graphJson,
        templateKind: 'image',
        templateSlots: custom.slots,
        outputDescriptor: custom.outputDescriptor,
        slots: { positive: 'x' },
        inputAssets: {},
        endpointUrl: 'http://127.0.0.1:8188',
        endpointGeneration: 1,
        timeoutMs: 10_000,
      },
    }).job
    expect(job).toMatchObject({ inputAssetId: '', inputHash: '', inputAssets: {} })
    expect(store.purgeForRestore()).toBe(1)
    expect(store.getCustomTemplate(custom.id)).toMatchObject(custom)
  })
})
