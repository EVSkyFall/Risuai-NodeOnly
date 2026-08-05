'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { comfyError } = require('./errors.cjs');

const TERMINAL_STATES = new Set(['succeeded', 'cancelled', 'failed', 'orphaned']);
const OPERATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DEFAULT_TIMEOUT_MS = 600_000;

const COLUMN_BY_FIELD = Object.freeze({
    state: 'state',
    promptId: 'prompt_id',
    remoteInputName: 'remote_input_name',
    remoteOutput: 'remote_output_json',
    resultAssetId: 'result_asset_id',
    resultMimeType: 'result_mime_type',
    terminalIntent: 'terminal_intent',
    cancelAction: 'cancel_action',
    cancelRequestedAt: 'cancel_requested_at',
    absenceCount: 'absence_count',
    absenceConfirmedAt: 'absence_confirmed_at',
    errorCode: 'error_code',
    errorMessage: 'error_message',
    endpointUrl: 'endpoint_url',
    endpointGeneration: 'endpoint_generation',
    startedAt: 'started_at',
    finishedAt: 'finished_at',
    deadlineAt: 'deadline_at',
    materializeAttempts: 'materialize_attempts',
    materializeRetryAt: 'materialize_retry_at',
    remoteInputs: 'remote_inputs_json',
    promptAttemptedAt: 'prompt_attempted_at',
});

function canonicalJson(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw comfyError('COMFY_BINDING_INVALID', 'Binding contains a non-finite number');
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    throw comfyError('COMFY_BINDING_INVALID', 'Binding contains an unsupported value');
}

function computeBindingHash(binding) {
    return crypto.createHash('sha256').update(canonicalJson(binding)).digest('hex').toUpperCase();
}

function parseJson(value) {
    return value == null ? null : JSON.parse(value);
}

function isSafeDirectory(value) {
    if (typeof value !== 'string' || !value) return false;
    try {
        const stat = fs.lstatSync(value);
        return stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
        return false;
    }
}

function rowToJob(row) {
    if (!row) return null;
    const inputAssets = parseJson(row.input_assets_json)
        ?? (row.input_asset_id ? { input_image: { assetId: row.input_asset_id, hash: row.input_hash } } : {});
    const remoteInputs = parseJson(row.remote_inputs_json)
        ?? (row.remote_input_name ? { input_image: row.remote_input_name } : {});
    return {
        jobId: row.job_id,
        operationKey: row.operation_key,
        bindingHash: row.binding_hash,
        templateId: row.template_id,
        templateHash: row.template_hash,
        templateJson: row.template_json,
        templateKind: row.template_kind ?? 'video',
        templateSlots: parseJson(row.template_slots_json),
        outputDescriptor: parseJson(row.output_descriptor_json),
        slots: parseJson(row.slots_json),
        inputAssetId: row.input_asset_id,
        inputHash: row.input_hash,
        inputAssets,
        endpointUrl: row.endpoint_url,
        endpointGeneration: row.endpoint_generation,
        timeoutMs: row.timeout_ms,
        target: parseJson(row.target_json),
        state: row.state,
        revision: row.revision,
        promptId: row.prompt_id,
        remoteInputName: row.remote_input_name,
        remoteInputs,
        promptAttemptedAt: row.prompt_attempted_at,
        remoteOutput: parseJson(row.remote_output_json),
        resultAssetId: row.result_asset_id,
        resultMimeType: row.result_mime_type,
        terminalIntent: row.terminal_intent,
        cancelAction: row.cancel_action,
        cancelRequestedAt: row.cancel_requested_at,
        absenceCount: row.absence_count,
        absenceConfirmedAt: row.absence_confirmed_at,
        materializeAttempts: row.materialize_attempts,
        materializeRetryAt: row.materialize_retry_at,
        deadlineAt: row.deadline_at,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
    };
}

function rowToCustomTemplate(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        mode: row.mode,
        graphJson: row.graph_json,
        slots: parseJson(row.slots_json),
        outputDescriptor: parseJson(row.output_descriptor_json),
        promptProfile: row.prompt_profile,
        createdAt: row.created_at,
    };
}

function createComfyStore(db, options = {}) {
    const now = options.now ?? Date.now;
    const randomUUID = options.randomUUID ?? crypto.randomUUID;
    const defaultTemplateDir = options.defaultTemplateDir ?? '';
    const logger = options.logger ?? console;

    db.exec(`
      CREATE TABLE IF NOT EXISTS comfy_config (
        id                  INTEGER PRIMARY KEY CHECK (id = 1),
        endpoint_url        TEXT NOT NULL DEFAULT '',
        timeout_ms          INTEGER NOT NULL DEFAULT 600000,
        template_dir        TEXT NOT NULL,
        endpoint_generation INTEGER NOT NULL DEFAULT 1,
        restore_epoch       INTEGER NOT NULL DEFAULT 1,
        updated_at          INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS comfy_jobs (
        job_id               TEXT PRIMARY KEY,
        operation_key        TEXT NOT NULL UNIQUE,
        binding_hash         TEXT NOT NULL,
        template_id          TEXT NOT NULL,
        template_hash        TEXT NOT NULL,
        template_json        TEXT NOT NULL,
        template_kind        TEXT,
        template_slots_json  TEXT,
        output_descriptor_json TEXT,
        slots_json           TEXT NOT NULL,
        input_asset_id       TEXT NOT NULL,
        input_hash           TEXT NOT NULL,
        input_assets_json    TEXT,
        endpoint_url         TEXT NOT NULL,
        endpoint_generation  INTEGER NOT NULL,
        timeout_ms            INTEGER NOT NULL DEFAULT 600000,
        target_json           TEXT,
        state                TEXT NOT NULL,
        revision             INTEGER NOT NULL DEFAULT 0,
        prompt_id            TEXT,
        remote_input_name    TEXT,
        remote_inputs_json   TEXT,
        prompt_attempted_at  INTEGER,
        remote_output_json   TEXT,
        result_asset_id      TEXT,
        result_mime_type     TEXT,
        terminal_intent      TEXT,
        cancel_action        TEXT,
        cancel_requested_at  INTEGER,
        absence_count        INTEGER NOT NULL DEFAULT 0,
        absence_confirmed_at INTEGER,
        materialize_attempts  INTEGER NOT NULL DEFAULT 0,
        materialize_retry_at  INTEGER,
        deadline_at          INTEGER NOT NULL,
        error_code           TEXT,
        error_message        TEXT,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL,
        started_at           INTEGER,
        finished_at          INTEGER
      );

      CREATE TABLE IF NOT EXISTS comfy_receipts (
        operation_key TEXT PRIMARY KEY,
        binding_hash  TEXT NOT NULL,
        job_id        TEXT NOT NULL REFERENCES comfy_jobs(job_id) ON DELETE CASCADE,
        created_at    INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS comfy_custom_templates (
        id                     TEXT PRIMARY KEY,
        name                   TEXT NOT NULL,
        kind                   TEXT NOT NULL,
        mode                   TEXT NOT NULL,
        graph_json             TEXT NOT NULL,
        slots_json             TEXT NOT NULL,
        output_descriptor_json TEXT NOT NULL,
        prompt_profile         TEXT NOT NULL,
        created_at             INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS comfy_jobs_state_created
      ON comfy_jobs(state, created_at, job_id);
    `);

    db.prepare(`
      INSERT OR IGNORE INTO comfy_config (
        id, endpoint_url, timeout_ms, template_dir, endpoint_generation, restore_epoch, updated_at
      ) VALUES (1, '', ?, ?, 1, 1, ?)
    `).run(DEFAULT_TIMEOUT_MS, defaultTemplateDir, now());

    const persistedConfig = db.prepare(
        'SELECT template_dir FROM comfy_config WHERE id = 1',
    ).get();
    if (
        !isSafeDirectory(persistedConfig.template_dir)
        && isSafeDirectory(defaultTemplateDir)
        && persistedConfig.template_dir !== defaultTemplateDir
    ) {
        db.prepare(`
          UPDATE comfy_config
          SET template_dir = ?, updated_at = ?
          WHERE id = 1
        `).run(defaultTemplateDir, now());
        logger.warn?.(
            `[Comfy] Repaired invalid template directory: ${persistedConfig.template_dir}`,
        );
    }

    const migrateJobs = db.transaction(() => {
        const jobColumns = new Set(
            db.prepare('PRAGMA table_info(comfy_jobs)').all().map(column => column.name),
        );
        if (!jobColumns.has('cancel_action')) {
            db.exec('ALTER TABLE comfy_jobs ADD COLUMN cancel_action TEXT');
        }
        if (!jobColumns.has('timeout_ms')) {
            db.exec('ALTER TABLE comfy_jobs ADD COLUMN timeout_ms INTEGER');
            const fallbackTimeoutMs = db.prepare(
                'SELECT timeout_ms FROM comfy_config WHERE id = 1',
            ).get().timeout_ms;
            db.prepare(`
              UPDATE comfy_jobs
              SET timeout_ms = CASE
                WHEN deadline_at > created_at AND deadline_at - created_at <= 86400000
                  THEN deadline_at - created_at
                ELSE ?
              END
            `).run(fallbackTimeoutMs);
        }
        if (!jobColumns.has('target_json')) {
            db.exec('ALTER TABLE comfy_jobs ADD COLUMN target_json TEXT');
        }
        if (!jobColumns.has('materialize_attempts')) {
            db.exec('ALTER TABLE comfy_jobs ADD COLUMN materialize_attempts INTEGER NOT NULL DEFAULT 0');
        }
        if (!jobColumns.has('materialize_retry_at')) {
            db.exec('ALTER TABLE comfy_jobs ADD COLUMN materialize_retry_at INTEGER');
        }
        if (!jobColumns.has('template_kind')) {
            db.exec('ALTER TABLE comfy_jobs ADD COLUMN template_kind TEXT');
        }
        if (!jobColumns.has('template_slots_json')) {
            db.exec('ALTER TABLE comfy_jobs ADD COLUMN template_slots_json TEXT');
        }
        if (!jobColumns.has('output_descriptor_json')) {
            db.exec('ALTER TABLE comfy_jobs ADD COLUMN output_descriptor_json TEXT');
        }
        if (!jobColumns.has('input_assets_json')) {
            db.exec('ALTER TABLE comfy_jobs ADD COLUMN input_assets_json TEXT');
        }
        if (!jobColumns.has('remote_inputs_json')) {
            db.exec('ALTER TABLE comfy_jobs ADD COLUMN remote_inputs_json TEXT');
        }
        if (!jobColumns.has('prompt_attempted_at')) {
            db.exec('ALTER TABLE comfy_jobs ADD COLUMN prompt_attempted_at INTEGER');
        }
    });
    migrateJobs();

    const readJob = db.prepare('SELECT * FROM comfy_jobs WHERE job_id = ?');
    const readReceipt = db.prepare('SELECT * FROM comfy_receipts WHERE operation_key = ?');

    const createJobTransaction = db.transaction(input => {
        const bindingHash = computeBindingHash(input.binding);
        const prior = readReceipt.get(input.operationKey);
        if (prior) {
            if (prior.binding_hash !== bindingHash) {
                throw comfyError(
                    'COMFY_OPERATION_KEY_CONFLICT',
                    'operationKey was already used with different immutable inputs',
                    { httpStatus: 409 },
                );
            }
            const existing = rowToJob(readJob.get(prior.job_id));
            if (!existing) {
                throw comfyError('COMFY_RECEIPT_CORRUPT', 'Submission receipt points to a missing job', { httpStatus: 500 });
            }
            return { replayed: true, job: existing };
        }

        if (!OPERATION_KEY_PATTERN.test(input.operationKey)) {
            throw comfyError('COMFY_OPERATION_KEY_INVALID', 'operationKey is invalid');
        }
        if (!input.job || typeof input.job !== 'object') {
            throw comfyError('COMFY_JOB_INVALID', 'Job snapshot is required');
        }

        const createdAt = now();
        const timeoutMs = Number(input.job.timeoutMs);
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
            throw comfyError('COMFY_TIMEOUT_INVALID', 'timeoutMs must be a positive integer');
        }
        const inputAssets = input.job.inputAssets ?? (
            input.job.inputAssetId
                ? { input_image: { assetId: input.job.inputAssetId, hash: input.job.inputHash } }
                : {}
        );
        const firstInput = Object.values(inputAssets)[0] ?? { assetId: '', hash: '' };
        const jobId = randomUUID();
        db.prepare(`
          INSERT INTO comfy_jobs (
            job_id, operation_key, binding_hash, template_id, template_hash, template_json,
            template_kind, template_slots_json, output_descriptor_json,
            slots_json, input_asset_id, input_hash, input_assets_json, endpoint_url, endpoint_generation,
            timeout_ms, target_json, state, revision, deadline_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
        `).run(
            jobId,
            input.operationKey,
            bindingHash,
            input.job.templateId,
            input.job.templateHash,
            input.job.templateJson,
            input.job.templateKind ?? 'video',
            input.job.templateSlots == null ? null : canonicalJson(input.job.templateSlots),
            input.job.outputDescriptor == null ? null : canonicalJson(input.job.outputDescriptor),
            canonicalJson(input.job.slots),
            firstInput.assetId,
            firstInput.hash,
            canonicalJson(inputAssets),
            input.job.endpointUrl,
            input.job.endpointGeneration,
            timeoutMs,
            input.job.target == null ? null : canonicalJson(input.job.target),
            createdAt + timeoutMs,
            createdAt,
            createdAt,
        );
        db.prepare(`
          INSERT INTO comfy_receipts (operation_key, binding_hash, job_id, created_at)
          VALUES (?, ?, ?, ?)
        `).run(input.operationKey, bindingHash, jobId, createdAt);
        return { replayed: false, job: rowToJob(readJob.get(jobId)) };
    });

    function createOrReplayJob(input) {
        return createJobTransaction(input);
    }

    function getJob(jobId) {
        return rowToJob(readJob.get(jobId));
    }

    function findByOperationKey(operationKey) {
        const receipt = readReceipt.get(operationKey);
        return receipt ? getJob(receipt.job_id) : null;
    }

    function listNonterminalJobs() {
        const terminal = [...TERMINAL_STATES];
        const placeholders = terminal.map(() => '?').join(',');
        return db.prepare(`
          SELECT * FROM comfy_jobs
          WHERE state NOT IN (${placeholders})
          ORDER BY created_at ASC, job_id ASC
        `).all(...terminal).map(rowToJob);
    }

    function updateJob(jobId, expectedRevision, expectedStates, patch) {
        const states = Array.isArray(expectedStates) ? expectedStates : [expectedStates];
        if (states.length === 0 || !Number.isSafeInteger(expectedRevision)) {
            throw comfyError('COMFY_CAS_INVALID', 'Expected revision and state are required');
        }
        const assignments = [];
        const values = [];
        for (const [field, value] of Object.entries(patch ?? {})) {
            const column = COLUMN_BY_FIELD[field];
            if (!column) throw comfyError('COMFY_PATCH_INVALID', `Unsupported job patch field: ${field}`);
            assignments.push(`${column} = ?`);
            values.push(
                ['remoteOutput', 'remoteInputs'].includes(field) && value != null
                    ? canonicalJson(value)
                    : value,
            );
        }
        assignments.push('revision = revision + 1', 'updated_at = ?');
        values.push(now());
        const statePlaceholders = states.map(() => '?').join(',');
        const terminalStates = [...TERMINAL_STATES];
        const terminalPlaceholders = terminalStates.map(() => '?').join(',');
        const result = db.prepare(`
          UPDATE comfy_jobs
          SET ${assignments.join(', ')}
          WHERE job_id = ? AND revision = ? AND state IN (${statePlaceholders})
            AND state NOT IN (${terminalPlaceholders})
        `).run(...values, jobId, expectedRevision, ...states, ...terminalStates);
        if (result.changes !== 1) return null;
        return getJob(jobId);
    }

    function getConfig() {
        const row = db.prepare('SELECT * FROM comfy_config WHERE id = 1').get();
        return {
            endpointUrl: row.endpoint_url,
            timeoutMs: row.timeout_ms,
            templateDir: row.template_dir,
            endpointGeneration: row.endpoint_generation,
            restoreEpoch: row.restore_epoch,
            updatedAt: row.updated_at,
        };
    }

    function updateConfig(input = {}) {
        const current = getConfig();
        const endpointUrl = input.endpointUrl ?? current.endpointUrl;
        const timeoutMs = input.timeoutMs ?? current.timeoutMs;
        const templateDir = input.templateDir ?? current.templateDir;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 24 * 60 * 60 * 1000) {
            throw comfyError('COMFY_TIMEOUT_INVALID', 'timeoutMs is outside the supported range');
        }
        const endpointChanged = endpointUrl !== current.endpointUrl;
        db.prepare(`
          UPDATE comfy_config
          SET endpoint_url = ?, timeout_ms = ?, template_dir = ?,
              endpoint_generation = endpoint_generation + ?, updated_at = ?
          WHERE id = 1
        `).run(endpointUrl, timeoutMs, templateDir, endpointChanged ? 1 : 0, now());
        return getConfig();
    }

    const readCustomTemplate = db.prepare('SELECT * FROM comfy_custom_templates WHERE id = ?');

    function createCustomTemplate(input) {
        const slotsJson = canonicalJson(input.slots);
        const outputDescriptorJson = canonicalJson(input.outputDescriptor);
        const createdAt = now();
        const result = db.prepare(`
          INSERT OR IGNORE INTO comfy_custom_templates (
            id, name, kind, mode, graph_json, slots_json,
            output_descriptor_json, prompt_profile, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            input.id,
            input.name,
            input.kind,
            input.mode,
            input.graphJson,
            slotsJson,
            outputDescriptorJson,
            input.promptProfile,
            createdAt,
        );
        const stored = rowToCustomTemplate(readCustomTemplate.get(input.id));
        if (!stored) {
            throw comfyError('COMFY_TEMPLATE_STORE_FAILED', 'Custom template could not be stored', { httpStatus: 500 });
        }
        const identical = stored.name === input.name
            && stored.kind === input.kind
            && stored.mode === input.mode
            && stored.graphJson === input.graphJson
            && canonicalJson(stored.slots) === slotsJson
            && canonicalJson(stored.outputDescriptor) === outputDescriptorJson
            && stored.promptProfile === input.promptProfile;
        if (!identical) {
            throw comfyError(
                'COMFY_TEMPLATE_CONFLICT',
                'The same graph is already registered with different immutable metadata',
                { httpStatus: 409 },
            );
        }
        return { created: result.changes === 1, template: stored };
    }

    function getCustomTemplate(id) {
        return rowToCustomTemplate(readCustomTemplate.get(id));
    }

    function listCustomTemplates(kind = null) {
        const rows = kind == null
            ? db.prepare('SELECT * FROM comfy_custom_templates ORDER BY created_at ASC, id ASC').all()
            : db.prepare('SELECT * FROM comfy_custom_templates WHERE kind = ? ORDER BY created_at ASC, id ASC').all(kind);
        return rows.map(rowToCustomTemplate);
    }

    function removeCustomTemplate(id) {
        return db.prepare('DELETE FROM comfy_custom_templates WHERE id = ?').run(id).changes === 1;
    }

    function purgeForRestore() {
        const run = db.transaction(() => {
            const jobs = db.prepare('DELETE FROM comfy_jobs').run().changes;
            db.prepare('DELETE FROM comfy_receipts').run();
            db.prepare(`
              UPDATE comfy_config
              SET restore_epoch = restore_epoch + 1, updated_at = ?
              WHERE id = 1
            `).run(now());
            return jobs;
        });
        return run();
    }

    return {
        createOrReplayJob,
        getJob,
        findByOperationKey,
        listNonterminalJobs,
        updateJob,
        getConfig,
        updateConfig,
        createCustomTemplate,
        getCustomTemplate,
        listCustomTemplates,
        removeCustomTemplate,
        purgeForRestore,
        computeBindingHash,
        isTerminalState: state => TERMINAL_STATES.has(state),
    };
}

module.exports = {
    createComfyStore,
    computeBindingHash,
    TERMINAL_STATES,
    DEFAULT_TIMEOUT_MS,
};
