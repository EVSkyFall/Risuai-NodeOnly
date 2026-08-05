'use strict';

const { comfyError, isComfyError } = require('./errors.cjs');

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const GLOBAL_HISTORY_PAGE_LIMIT = 200;
const MAX_MATERIALIZE_ATTEMPTS = 5;
const MATERIALIZE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];

function normalizeEndpoint(value) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw comfyError('COMFY_ENDPOINT_INVALID', 'Comfy endpoint is not a valid URL');
    }
    const loopback = parsed.hostname === 'localhost'
        || parsed.hostname === '127.0.0.1'
        || parsed.hostname === '[::1]'
        || parsed.hostname === '::1';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
        throw comfyError('COMFY_ENDPOINT_INVALID', 'Comfy endpoint must use HTTPS, except for loopback HTTP');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw comfyError('COMFY_ENDPOINT_INVALID', 'Comfy endpoint cannot contain credentials, query, or fragment');
    }
    return parsed.toString().replace(/\/+$/, '');
}

async function readJsonResponse(response) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
        throw comfyError('COMFY_RESPONSE_TOO_LARGE', 'Comfy JSON response exceeds the size limit');
    }
    if (!response.body) throw comfyError('COMFY_RESPONSE_INVALID', 'Comfy returned an empty response');
    const chunks = [];
    let size = 0;
    for await (const chunkValue of response.body) {
        const chunk = Buffer.from(chunkValue);
        size += chunk.length;
        if (size > MAX_JSON_BYTES) {
            throw comfyError('COMFY_RESPONSE_TOO_LARGE', 'Comfy JSON response exceeds the size limit');
        }
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    } catch (cause) {
        throw comfyError('COMFY_RESPONSE_INVALID', 'Comfy returned invalid JSON', { cause });
    }
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTarget(value) {
    if (value == null) return null;
    if (!isObject(value)) {
        throw comfyError('COMFY_SUBMIT_INVALID', 'Submit target must be an object');
    }
    const allowed = new Set(['charId', 'chatId']);
    if (Object.keys(value).some(key => !allowed.has(key))) {
        throw comfyError('COMFY_SUBMIT_INVALID', 'Submit target contains an unknown field');
    }
    const target = {};
    for (const key of ['charId', 'chatId']) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (typeof value[key] !== 'string' || value[key].length === 0 || value[key].length > 1024) {
            throw comfyError('COMFY_SUBMIT_INVALID', `Submit target ${key} must be a non-empty string`);
        }
        target[key] = value[key];
    }
    return Object.keys(target).length === 0 ? null : target;
}

function sameTarget(left, right) {
    return (left?.charId ?? null) === (right?.charId ?? null)
        && (left?.chatId ?? null) === (right?.chatId ?? null);
}

function createRequestAbortScope(parentSignal, timeoutMs) {
    const controller = new AbortController();
    const abort = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) abort();
    else parentSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Comfy request timed out')), timeoutMs);
    return {
        signal: controller.signal,
        cleanup() {
            clearTimeout(timer);
            parentSignal?.removeEventListener('abort', abort);
        },
    };
}

function toPublicJob(job) {
    if (!job) return null;
    const result = {
        jobId: job.jobId,
        operationKey: job.operationKey,
        template: job.templateId,
        templateHash: job.templateHash,
        templateKind: job.templateKind,
        endpointGeneration: job.endpointGeneration,
        state: job.state,
        revision: job.revision,
        createdAt: job.createdAt,
        deadlineAt: job.deadlineAt,
        updatedAt: job.updatedAt,
    };
    if (job.promptId) result.promptId = job.promptId;
    if (job.target) result.target = job.target;
    if (job.startedAt) result.startedAt = job.startedAt;
    if (job.finishedAt) result.finishedAt = job.finishedAt;
    if (job.errorCode) {
        result.error = { code: job.errorCode, message: job.errorMessage ?? job.errorCode };
    }
    if (job.state === 'succeeded') {
        result.resultAssetId = job.resultAssetId;
        result.mimeType = job.resultMimeType;
    }
    return result;
}

function createComfyOrchestrator(options) {
    const { store, registry, assets } = options;
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const now = options.now ?? Date.now;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const stopDrainTimeoutMs = options.stopDrainTimeoutMs ?? 5_000;
    const logger = options.logger ?? console;
    const setTimer = options.setTimer ?? setTimeout;
    const clearTimer = options.clearTimer ?? clearTimeout;
    let activeRun = null;
    let activeRunController = null;
    let timer = null;
    let started = false;
    let disabledCause = null;
    let worldReplacementPauseDepth = 0;
    let localGeneration = store.getConfig().restoreEpoch;

    function unavailableError() {
        return comfyError(
            'COMFY_UNAVAILABLE',
            'Comfy orchestration is unavailable because startup initialization failed',
            { httpStatus: 503, cause: disabledCause },
        );
    }

    function assertAvailable() {
        if (disabledCause) throw unavailableError();
    }

    function workerAbortError(reason) {
        return comfyError(
            'COMFY_WORKER_ABORTED',
            `Comfy worker was aborted for ${reason}`,
            { uncertain: true },
        );
    }

    async function drainActiveRun(timeoutMs = null) {
        const run = activeRun;
        if (!run) return;
        const observed = run.catch(() => undefined);
        if (timeoutMs == null) {
            await observed;
            return;
        }
        let timeout;
        try {
            await Promise.race([
                observed,
                new Promise(resolve => {
                    timeout = setTimer(resolve, timeoutMs);
                }),
            ]);
        } finally {
            if (timeout) clearTimer(timeout);
        }
    }

    async function requestJson(endpointUrl, route, init = {}) {
        const abortScope = createRequestAbortScope(init.signal, requestTimeoutMs);
        try {
            const response = await fetchImpl(`${endpointUrl}${route}`, {
                ...init,
                signal: abortScope.signal,
            });
            if (!response.ok) {
                throw comfyError('COMFY_HTTP_ERROR', `Comfy returned HTTP ${response.status}`, {
                    httpStatus: response.status >= 500 ? 502 : 400,
                    uncertain: response.status >= 500,
                });
            }
            return await readJsonResponse(response);
        } catch (cause) {
            if (isComfyError(cause)) throw cause;
            throw comfyError('COMFY_UNREACHABLE', 'Could not reach Comfy', { cause, uncertain: true });
        } finally {
            abortScope.cleanup();
        }
    }

    async function requestAck(endpointUrl, route, init = {}) {
        const abortScope = createRequestAbortScope(init.signal, requestTimeoutMs);
        try {
            const response = await fetchImpl(`${endpointUrl}${route}`, {
                ...init,
                signal: abortScope.signal,
            });
            if (!response.ok) {
                throw comfyError('COMFY_HTTP_ERROR', `Comfy returned HTTP ${response.status}`, {
                    httpStatus: response.status >= 500 ? 502 : 400,
                    uncertain: response.status >= 500,
                });
            }
        } catch (cause) {
            if (isComfyError(cause)) throw cause;
            throw comfyError('COMFY_UNREACHABLE', 'Could not reach Comfy', { cause, uncertain: true });
        } finally {
            abortScope.cleanup();
        }
    }

    async function probe(endpointUrl) {
        const startedAt = now();
        try {
            const stats = await requestJson(endpointUrl, '/system_stats');
            return { reachable: true, latencyMs: Math.max(0, now() - startedAt), stats };
        } catch (error) {
            return {
                reachable: false,
                latencyMs: Math.max(0, now() - startedAt),
                error: {
                    code: isComfyError(error) ? error.code : 'COMFY_UNREACHABLE',
                    message: String(error?.message ?? error),
                },
            };
        }
    }

    function requireConfiguredEndpoint(config = store.getConfig()) {
        if (!config.endpointUrl) {
            throw comfyError('COMFY_NOT_CONFIGURED', 'Comfy endpoint is not configured');
        }
        return normalizeEndpoint(config.endpointUrl);
    }

    async function getHealth() {
        assertAvailable();
        const config = store.getConfig();
        if (!config.endpointUrl) {
            return {
                reachable: false,
                endpointGeneration: config.endpointGeneration,
                error: { code: 'COMFY_NOT_CONFIGURED', message: 'Comfy endpoint is not configured' },
            };
        }
        const health = await probe(requireConfiguredEndpoint(config));
        return { ...health, endpointGeneration: config.endpointGeneration };
    }

    function toPublicConfig(config, health) {
        const result = {
            url: config.endpointUrl,
            timeoutMs: config.timeoutMs,
            templateDir: config.templateDir,
            endpointGeneration: config.endpointGeneration,
            configured: Boolean(config.endpointUrl),
        };
        if (health) result.health = health;
        return result;
    }

    async function submit(input) {
        assertAvailable();
        if (
            !isObject(input)
            || typeof input.operationKey !== 'string'
            || typeof input.template !== 'string'
            || !isObject(input.slots)
        ) {
            throw comfyError('COMFY_SUBMIT_INVALID', 'Submit request is invalid');
        }
        const target = normalizeTarget(input.target);
        const prior = store.findByOperationKey(input.operationKey);
        if (prior) {
            const requested = store.computeBindingHash({ templateId: input.template, slots: input.slots, target });
            const stored = store.computeBindingHash({ templateId: prior.templateId, slots: prior.slots, target: prior.target });
            if (requested !== stored || !sameTarget(target, prior.target)) {
                throw comfyError(
                    'COMFY_OPERATION_KEY_CONFLICT',
                    'operationKey was already used with different immutable inputs',
                    { httpStatus: 409 },
                );
            }
            return toPublicJob(prior);
        }
        const template = await registry.loadTemplate(input.template);
        registry.instantiateSnapshot(
            template.sourceText,
            template.hash,
            input.slots,
            template.id,
            { templateSlots: template.templateSlots, outputDescriptor: template.outputDescriptor },
        );
        const inputAssets = {};
        for (const imageSlot of template.templateSlots.inputImages ?? []) {
            const assetId = input.slots[imageSlot.name];
            const inputAsset = await assets.readInputAsset(assetId);
            inputAssets[imageSlot.name] = { assetId, hash: inputAsset.hash };
        }
        const config = store.getConfig();
        const endpointGeneration = config.endpointGeneration;
        const binding = {
            templateId: input.template,
            templateHash: template.hash,
            slots: input.slots,
            inputAssets,
            endpointGeneration,
            target,
        };

        const endpointUrl = requireConfiguredEndpoint(config);
        const health = await probe(endpointUrl);
        if (!health.reachable) {
            throw comfyError('COMFY_UNREACHABLE', health.error.message, { httpStatus: 503 });
        }
        const created = store.createOrReplayJob({
            operationKey: input.operationKey,
            binding,
            job: {
                templateId: input.template,
                templateHash: template.hash,
                templateJson: template.sourceText,
                templateKind: template.kind,
                templateSlots: template.templateSlots,
                outputDescriptor: template.outputDescriptor,
                slots: input.slots,
                inputAssets,
                endpointUrl,
                endpointGeneration,
                timeoutMs: config.timeoutMs,
                target,
            },
        });
        schedule(0);
        return toPublicJob(created.job);
    }

    async function poll(jobId) {
        assertAvailable();
        const job = store.getJob(jobId);
        if (!job) throw comfyError('COMFY_JOB_NOT_FOUND', 'Comfy job was not found', { httpStatus: 404 });
        return toPublicJob(job);
    }

    async function findByOperationKey(operationKey) {
        assertAvailable();
        return toPublicJob(store.findByOperationKey(operationKey));
    }

    function failJob(job, code, message) {
        return store.updateJob(job.jobId, job.revision, job.state, {
            state: 'failed',
            errorCode: code,
            errorMessage: message,
            finishedAt: now(),
        });
    }

    function markUnknown(job, error) {
        return store.updateJob(job.jobId, job.revision, job.state, {
            state: 'unknown',
            errorCode: isComfyError(error) ? error.code : 'COMFY_REMOTE_UNKNOWN',
            errorMessage: String(error?.message ?? error),
            absenceCount: 0,
            absenceConfirmedAt: null,
        });
    }

    async function dispatchQueued(job, generation, signal) {
        const dispatchNow = now();
        let current = store.updateJob(job.jobId, job.revision, 'queued', {
            state: 'submitting',
            startedAt: dispatchNow,
            deadlineAt: dispatchNow + job.timeoutMs,
            errorCode: null,
            errorMessage: null,
        });
        if (!current || generation !== localGeneration) return;

        try {
            const remoteInputs = { ...(current.remoteInputs ?? {}) };
            for (const [slotName, snapshot] of Object.entries(current.inputAssets ?? {})) {
                if (remoteInputs[slotName]) continue;
                const input = await assets.readInputAsset(snapshot.assetId);
                if (input.hash !== snapshot.hash) {
                    return failJob(current, 'COMFY_INPUT_CHANGED', 'Input asset changed after submission');
                }
                if (generation !== localGeneration || !store.getJob(current.jobId)) return;
                remoteInputs[slotName] = await assets.uploadInput(
                    current.endpointUrl,
                    current.jobId,
                    input,
                    { signal },
                );
                current = store.updateJob(current.jobId, current.revision, 'submitting', {
                    remoteInputs,
                    remoteInputName: Object.values(remoteInputs)[0] ?? null,
                });
                if (!current || generation !== localGeneration) return;
            }

            const compiledSlots = { ...current.slots };
            for (const [slotName, remoteName] of Object.entries(remoteInputs)) compiledSlots[slotName] = remoteName;
            const compiled = registry.instantiateSnapshot(
                current.templateJson,
                current.templateHash,
                compiledSlots,
                current.templateId,
                { templateSlots: current.templateSlots, outputDescriptor: current.outputDescriptor },
            );
            current = store.updateJob(current.jobId, current.revision, 'submitting', {
                promptAttemptedAt: now(),
            });
            if (!current || generation !== localGeneration) return;
            let response;
            try {
                response = await requestJson(current.endpointUrl, '/prompt', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ prompt: compiled.prompt, client_id: current.jobId }),
                    signal,
                });
            } catch (error) {
                if (
                    error?.uncertain
                    || error?.code === 'COMFY_RESPONSE_INVALID'
                    || error?.code === 'COMFY_RESPONSE_TOO_LARGE'
                ) {
                    return markUnknown(current, error);
                }
                return failJob(current, error?.code ?? 'COMFY_PROMPT_REJECTED', String(error?.message ?? error));
            }
            if (typeof response?.prompt_id !== 'string' || !response.prompt_id) {
                return markUnknown(current, comfyError(
                    'COMFY_PROMPT_ACK_INVALID',
                    'Comfy prompt response did not contain a recoverable prompt ID',
                    { uncertain: true },
                ));
            }
            store.updateJob(current.jobId, current.revision, 'submitting', {
                state: 'remote_queued',
                promptId: response.prompt_id,
                absenceCount: 0,
                absenceConfirmedAt: null,
                errorCode: null,
                errorMessage: null,
            });
        } catch (error) {
            const latest = store.getJob(job.jobId);
            if (!latest || store.isTerminalState(latest.state)) return;
            if (error?.uncertain) markUnknown(latest, error);
            else failJob(latest, error?.code ?? 'COMFY_SUBMIT_FAILED', String(error?.message ?? error));
        }
    }

    function historyHasExecutionError(entry) {
        if (entry?.status?.status_str === 'error') return true;
        return Array.isArray(entry?.status?.messages)
            && entry.status.messages.some(message => Array.isArray(message) && message[0] === 'execution_error');
    }

    function selectOutput(job, entry) {
        let outputDescriptor = job.outputDescriptor;
        if (!outputDescriptor) {
            const compiled = registry.instantiateSnapshot(
                job.templateJson,
                job.templateHash,
                { ...job.slots, input_image: job.remoteInputName ?? 'recovery/input.png' },
                job.templateId,
            );
            outputDescriptor = compiled.outputDescriptor;
        }
        const nodeOutput = entry?.outputs
            && Object.prototype.hasOwnProperty.call(entry.outputs, outputDescriptor.nodeId)
            ? entry.outputs[outputDescriptor.nodeId]
            : null;
        const candidates = nodeOutput
            && Object.prototype.hasOwnProperty.call(nodeOutput, outputDescriptor.historyKey)
            ? nodeOutput[outputDescriptor.historyKey]
            : null;
        if (!Array.isArray(candidates) || candidates.length !== 1) {
            throw comfyError('COMFY_NO_OUTPUT', 'Completed Comfy history has no unique expected output');
        }
        return candidates[0];
    }

    async function finishFromHistory(job, entry, generation, signal) {
        if (historyHasExecutionError(entry)) {
            if (job.terminalIntent && job.cancelAction) {
                if (job.terminalIntent === 'user_cancel') {
                    return store.updateJob(job.jobId, job.revision, job.state, {
                        state: 'cancelled',
                        errorCode: null,
                        errorMessage: null,
                        finishedAt: now(),
                    });
                }
                if (job.terminalIntent === 'timeout') {
                    return store.updateJob(job.jobId, job.revision, job.state, {
                        state: 'failed',
                        errorCode: 'COMFY_TIMEOUT',
                        errorMessage: 'Comfy job exceeded its deadline',
                        finishedAt: now(),
                    });
                }
            }
            return failJob(job, 'COMFY_EXECUTION_FAILED', 'Comfy reported an execution error');
        }
        if (entry?.status?.completed !== true && entry?.status?.status_str !== 'success') return null;
        let output;
        try {
            output = selectOutput(job, entry);
        } catch (error) {
            return failJob(job, error.code, error.message);
        }
        let current = store.updateJob(job.jobId, job.revision, job.state, {
            state: 'materializing',
            remoteOutput: output,
            materializeAttempts: 0,
            materializeRetryAt: null,
            absenceCount: 0,
            absenceConfirmedAt: null,
            errorCode: null,
            errorMessage: null,
        });
        if (!current || generation !== localGeneration) return null;
        return completeMaterialization(current, generation, signal);
    }

    async function completeMaterialization(job, generation, signal) {
        if (job.materializeRetryAt != null && now() < job.materializeRetryAt) return job;
        let materialized;
        try {
            materialized = await assets.recoverMaterialization(job.jobId, {
                signal,
                target: job.target,
                mediaType: job.outputDescriptor?.mediaType ?? 'video/mp4',
                output: job.remoteOutput,
            });
            if (!materialized) {
                materialized = await assets.materializeOutput(
                    job.endpointUrl,
                    job.jobId,
                    job.remoteOutput,
                    {
                        signal,
                        target: job.target,
                        mediaType: job.outputDescriptor?.mediaType ?? 'video/mp4',
                    },
                );
            }
        } catch (error) {
            const latest = store.getJob(job.jobId);
            if (!latest || store.isTerminalState(latest.state)) return;
            if (error?.retryMaterialization) {
                const attempts = (latest.materializeAttempts ?? 0) + 1;
                if (attempts < MAX_MATERIALIZE_ATTEMPTS) {
                    return store.updateJob(latest.jobId, latest.revision, latest.state, {
                        state: 'materializing',
                        materializeAttempts: attempts,
                        materializeRetryAt: now() + MATERIALIZE_RETRY_DELAYS_MS[attempts - 1],
                        errorCode: error.code,
                        errorMessage: error.message,
                    });
                }
                const rootCode = error?.cause?.code ?? error?.code ?? 'COMFY_OUTPUT_FAILED';
                const failed = store.updateJob(latest.jobId, latest.revision, latest.state, {
                    state: 'failed',
                    materializeAttempts: attempts,
                    materializeRetryAt: null,
                    errorCode: rootCode,
                    errorMessage: String(error?.cause?.message ?? error?.message ?? error),
                    finishedAt: now(),
                });
                if (!failed) return store.getJob(latest.jobId);
                for (const cleanup of [
                    () => assets.removeMaterializedAsset?.(`comfy-${latest.jobId}`),
                    () => assets.finalizeMaterialization?.(latest.jobId),
                ]) {
                    try {
                        await cleanup();
                    } catch (cleanupError) {
                        try {
                            logger.error?.('[Comfy] terminal materialization cleanup failed:', cleanupError);
                        } catch {
                            // Cleanup logging is best-effort after the terminal CAS.
                        }
                    }
                }
                return failed;
            }
            if (error?.uncertain) markUnknown(latest, error);
            else failJob(latest, error?.code ?? 'COMFY_OUTPUT_FAILED', String(error?.message ?? error));
            return;
        }
        if (generation !== localGeneration) {
            await assets.removeMaterializedAsset(materialized.resultAssetId);
            await assets.finalizeMaterialization(job.jobId);
            return;
        }
        const successPatch = {
            state: 'succeeded',
            resultAssetId: materialized.resultAssetId,
            resultMimeType: materialized.mimeType,
            errorCode: null,
            errorMessage: null,
            finishedAt: now(),
        };
        let succeeded = store.updateJob(job.jobId, job.revision, job.state, successPatch);
        if (!succeeded && generation === localGeneration) {
            const current = store.getJob(job.jobId);
            if (current && !store.isTerminalState(current.state)) {
                succeeded = store.updateJob(
                    current.jobId,
                    current.revision,
                    current.state,
                    successPatch,
                );
            }
        }
        if (!succeeded) {
            const current = store.getJob(job.jobId);
            if (current?.state === 'succeeded' && current.resultAssetId === materialized.resultAssetId) {
                succeeded = current;
            } else if (current && !store.isTerminalState(current.state) && generation === localGeneration) {
                return;
            } else {
                await assets.removeMaterializedAsset(materialized.resultAssetId);
                await assets.finalizeMaterialization(job.jobId);
                return;
            }
        }
        await assets.finalizeMaterialization(job.jobId);
        const finalJob = store.getJob(job.jobId);
        if (
            generation !== localGeneration
            || !finalJob
            || finalJob.state !== 'succeeded'
            || finalJob.resultAssetId !== materialized.resultAssetId
        ) {
            await assets.removeMaterializedAsset(materialized.resultAssetId);
        }
    }

    function queueEntries(queue) {
        if (!isObject(queue) || !Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) {
            throw comfyError('COMFY_QUEUE_RESPONSE_INVALID', 'Comfy queue response is invalid', { uncertain: true });
        }
        return {
            running: queue.queue_running,
            pending: queue.queue_pending,
        };
    }

    async function reconcileKnownPrompt(job, generation, signal, allowCancelAction = true) {
        let history;
        try {
            history = await requestJson(
                job.endpointUrl,
                `/history/${encodeURIComponent(job.promptId)}`,
                { signal },
            );
        } catch (error) {
            return markUnknown(job, error);
        }
        if (!isObject(history)) {
            return markUnknown(job, comfyError(
                'COMFY_HISTORY_RESPONSE_INVALID',
                'Comfy history response is not a prompt-keyed object',
                { uncertain: true },
            ));
        }
        const entry = history[job.promptId];
        if (entry) return finishFromHistory(job, entry, generation, signal);

        let queue;
        try {
            queue = queueEntries(await requestJson(job.endpointUrl, '/queue', { signal }));
        } catch (error) {
            return markUnknown(job, error);
        }
        const running = queue.running.find(item => Array.isArray(item) && item[1] === job.promptId);
        const pending = queue.pending.find(item => Array.isArray(item) && item[1] === job.promptId);
        if (job.terminalIntent && allowCancelAction && (running || pending)) {
            const cancelAction = pending
                ? 'delete'
                : (running && queue.running.length === 1 ? 'interrupt' : null);
            if (!cancelAction) {
                return store.updateJob(job.jobId, job.revision, job.state, {
                    state: 'cancel_requested',
                    absenceCount: 0,
                });
            }
            if (job.cancelAction !== cancelAction) {
                const armed = store.updateJob(job.jobId, job.revision, job.state, { cancelAction });
                if (!armed || generation !== localGeneration) return armed;
                job = armed;
            }
            try {
                if (pending) {
                    await requestAck(job.endpointUrl, '/queue', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ delete: [job.promptId] }),
                        signal,
                    });
                } else {
                    await requestAck(job.endpointUrl, '/interrupt', { method: 'POST', signal });
                }
            } catch (error) {
                const latest = store.getJob(job.jobId);
                if (!latest || store.isTerminalState(latest.state) || generation !== localGeneration) return latest;
                if (!error?.uncertain && latest.cancelAction === cancelAction) {
                    const cleared = store.updateJob(latest.jobId, latest.revision, latest.state, {
                        cancelAction: null,
                    });
                    if (!cleared) return store.getJob(latest.jobId);
                    return markUnknown(cleared, error);
                }
                return markUnknown(latest, error);
            }
            const latest = store.getJob(job.jobId);
            if (!latest || store.isTerminalState(latest.state) || generation !== localGeneration) return latest;
            return reconcileKnownPrompt(latest, generation, signal, false);
        }
        if (running || pending) {
            const nextState = job.terminalIntent ? 'cancel_requested' : (running ? 'running' : 'remote_queued');
            return store.updateJob(job.jobId, job.revision, job.state, {
                state: nextState,
                absenceCount: 0,
                absenceConfirmedAt: null,
                errorCode: null,
                errorMessage: null,
            });
        }
        return finishConfirmedAbsent(job);
    }

    function inspectGlobalHistory(history, jobId) {
        if (!isObject(history)) return { capable: false, matches: [] };
        const entries = Object.entries(history);
        const matches = [];
        for (const [key, entry] of entries) {
            if (!isObject(entry) || !Array.isArray(entry.prompt) || !isObject(entry.prompt[3])) {
                return { capable: false, matches: [] };
            }
            const promptId = typeof entry.prompt[1] === 'string' ? entry.prompt[1] : key;
            if (typeof promptId !== 'string' || !promptId) return { capable: false, matches: [] };
            if (entry.prompt[3].client_id === jobId) matches.push({ promptId, entry });
        }
        return {
            capable: true,
            matches,
            saturated: entries.length >= GLOBAL_HISTORY_PAGE_LIMIT,
        };
    }

    function inspectGlobalQueue(queue, jobId) {
        let entries;
        try {
            const parsed = queueEntries(queue);
            entries = [...parsed.running, ...parsed.pending];
        } catch {
            return { capable: false, matches: [] };
        }
        const matches = [];
        for (const entry of entries) {
            if (!Array.isArray(entry) || typeof entry[1] !== 'string' || !isObject(entry[3])) {
                return { capable: false, matches: [] };
            }
            if (entry[3].client_id === jobId) matches.push({ promptId: entry[1], entry });
        }
        return { capable: true, matches };
    }

    function finishConfirmedAbsent(job) {
        if (job.absenceCount < 1 || !job.absenceConfirmedAt) {
            return store.updateJob(job.jobId, job.revision, job.state, {
                absenceCount: 1,
                absenceConfirmedAt: now(),
            });
        }
        if (now() - job.absenceConfirmedAt < pollIntervalMs) return job;
        if (job.terminalIntent === 'user_cancel') {
            return store.updateJob(job.jobId, job.revision, job.state, {
                state: 'cancelled',
                finishedAt: now(),
            });
        }
        if (job.terminalIntent === 'timeout') {
            return store.updateJob(job.jobId, job.revision, job.state, {
                state: 'failed',
                errorCode: 'COMFY_TIMEOUT',
                errorMessage: 'Comfy job exceeded its deadline',
                finishedAt: now(),
            });
        }
        return store.updateJob(job.jobId, job.revision, job.state, {
            state: 'orphaned',
            errorCode: 'COMFY_REMOTE_ORPHANED',
            errorMessage: 'Comfy never exposed this submission marker',
            finishedAt: now(),
        });
    }

    async function reconcilePromptless(job, generation, signal) {
        let history;
        let queue;
        try {
            [history, queue] = await Promise.all([
                requestJson(
                    job.endpointUrl,
                    `/history?max_items=${GLOBAL_HISTORY_PAGE_LIMIT}`,
                    { signal },
                ),
                requestJson(job.endpointUrl, '/queue', { signal }),
            ]);
        } catch (error) {
            return markUnknown(job, error);
        }
        const historyScan = inspectGlobalHistory(history, job.jobId);
        const queueScan = inspectGlobalQueue(queue, job.jobId);
        if (!historyScan.capable || !queueScan.capable) {
            return markUnknown(job, comfyError(
                'COMFY_MARKER_UNAVAILABLE',
                'Comfy responses do not expose a recoverable client marker',
                { uncertain: true },
            ));
        }
        if (historyScan.matches.length === 0 && historyScan.saturated && queueScan.matches.length === 0) {
            return markUnknown(job, comfyError(
                'COMFY_HISTORY_TRUNCATED',
                'Bounded Comfy history is saturated, so remote absence cannot be proven',
                { uncertain: true },
            ));
        }

        const promptIds = new Set([
            ...historyScan.matches.map(match => match.promptId),
            ...queueScan.matches.map(match => match.promptId),
        ]);
        if (promptIds.size > 1) {
            return markUnknown(job, comfyError(
                'COMFY_MARKER_AMBIGUOUS',
                'Multiple Comfy prompts carry this job marker',
                { uncertain: true },
            ));
        }
        if (promptIds.size === 0) return finishConfirmedAbsent(job);

        const promptId = [...promptIds][0];
        const recovered = store.updateJob(job.jobId, job.revision, job.state, {
            state: 'unknown',
            promptId,
            absenceCount: 0,
            absenceConfirmedAt: null,
            errorCode: null,
            errorMessage: null,
        });
        if (!recovered || generation !== localGeneration) return recovered;
        const historyMatch = historyScan.matches.find(match => match.promptId === promptId);
        if (historyMatch) return finishFromHistory(recovered, historyMatch.entry, generation, signal);
        return reconcileKnownPrompt(recovered, generation, signal);
    }

    async function reconcileJob(job, generation, signal) {
        if (
            job.state === 'submitting'
            && job.promptId == null
            && job.promptAttemptedAt == null
            && (job.templateSlots != null || job.remoteInputName == null)
        ) {
            return store.updateJob(job.jobId, job.revision, 'submitting', {
                state: 'queued',
                startedAt: null,
                errorCode: null,
                errorMessage: null,
            }) ?? store.getJob(job.jobId);
        }
        if (job.remoteOutput) {
            if (job.state !== 'materializing') {
                job = store.updateJob(job.jobId, job.revision, job.state, {
                    state: 'materializing',
                });
                if (!job || generation !== localGeneration) return job;
            }
            return completeMaterialization(job, generation, signal);
        }
        if (job.promptId) return reconcileKnownPrompt(job, generation, signal);
        return reconcilePromptless(job, generation, signal);
    }

    async function runNext(signal) {
        const generation = localGeneration;
        const jobs = store.listNonterminalJobs();
        if (jobs.length === 0) return null;
        let job = jobs[0];
        if (
            job.state === 'submitting'
            && job.promptId == null
            && job.promptAttemptedAt == null
            && (job.templateSlots != null || job.remoteInputName == null)
        ) {
            return store.updateJob(job.jobId, job.revision, 'submitting', {
                state: 'queued',
                startedAt: null,
                errorCode: null,
                errorMessage: null,
            }) ?? store.getJob(job.jobId);
        }
        if (job.state !== 'queued' && now() >= job.deadlineAt && !job.terminalIntent) {
            job = store.updateJob(job.jobId, job.revision, job.state, {
                state: 'cancel_requested',
                terminalIntent: 'timeout',
                cancelRequestedAt: now(),
            }) ?? store.getJob(job.jobId);
        }
        if (!job || store.isTerminalState(job.state)) return job;
        if (job.state === 'queued') return dispatchQueued(job, generation, signal);
        return reconcileJob(job, generation, signal);
    }

    function runOnce() {
        if (worldReplacementPauseDepth > 0) return Promise.resolve(null);
        if (disabledCause) return Promise.resolve(null);
        if (activeRun) return activeRun;
        const controller = new AbortController();
        const run = Promise.resolve()
            .then(() => runNext(controller.signal))
            .finally(() => {
                if (activeRun === run) {
                    activeRun = null;
                    activeRunController = null;
                }
                if (started && store.listNonterminalJobs().length > 0) schedule(pollIntervalMs);
            });
        activeRun = run;
        activeRunController = controller;
        return run;
    }

    function schedule(delay = 0) {
        if (!started || worldReplacementPauseDepth > 0) return;
        if (timer) clearTimer(timer);
        timer = setTimer(() => {
            timer = null;
            runOnce().catch(error => logger.error?.('[Comfy] worker failed:', error));
        }, delay);
    }

    async function start() {
        if (started) return;
        if (disabledCause) throw unavailableError();
        started = true;
        localGeneration = store.getConfig().restoreEpoch;
        try {
            await assets.cleanupOrphanStaging?.(new Set(store.listNonterminalJobs().map(job => job.jobId)));
        } catch (error) {
            started = false;
            disabledCause = error;
            throw error;
        }
        schedule(0);
    }

    async function stop() {
        started = false;
        if (timer) clearTimer(timer);
        timer = null;
        activeRunController?.abort(workerAbortError('server stop'));
        await drainActiveRun(stopDrainTimeoutMs);
    }

    async function pauseForWorldReplacement() {
        worldReplacementPauseDepth += 1;
        const firstPause = worldReplacementPauseDepth === 1;
        if (firstPause) {
            if (timer) clearTimer(timer);
            timer = null;
            activeRunController?.abort(workerAbortError('world replacement'));
        }
        await drainActiveRun();
        if (firstPause) localGeneration += 1;
    }

    async function resumeAfterWorldReplacement() {
        if (worldReplacementPauseDepth === 0) return;
        if (worldReplacementPauseDepth > 1) {
            worldReplacementPauseDepth -= 1;
            return;
        }
        try {
            localGeneration = store.getConfig().restoreEpoch;
            if (!disabledCause) {
                await assets.cleanupOrphanStaging?.(
                    new Set(store.listNonterminalJobs().map(job => job.jobId)),
                );
            }
        } finally {
            worldReplacementPauseDepth = 0;
            schedule(0);
        }
    }

    function isWorldReplacementPaused() {
        return worldReplacementPauseDepth > 0;
    }

    function resolveCancelCas(jobId, updated) {
        if (updated) return updated;
        const latest = store.getJob(jobId);
        if (!latest) {
            throw comfyError('COMFY_JOB_NOT_FOUND', 'Comfy job was not found', { httpStatus: 404 });
        }
        if (store.isTerminalState(latest.state)) return latest;
        throw comfyError(
            'COMFY_JOB_STATE_CONFLICT',
            'Comfy job changed state while cancellation was being recorded',
            { httpStatus: 409 },
        );
    }

    async function cancel(jobId) {
        assertAvailable();
        let job = store.getJob(jobId);
        if (!job) throw comfyError('COMFY_JOB_NOT_FOUND', 'Comfy job was not found', { httpStatus: 404 });
        if (store.isTerminalState(job.state)) return toPublicJob(job);
        if (job.state === 'queued') {
            job = resolveCancelCas(job.jobId, store.updateJob(job.jobId, job.revision, 'queued', {
                state: 'cancelled',
                terminalIntent: 'user_cancel',
                cancelRequestedAt: now(),
                finishedAt: now(),
            }));
        } else if (!job.terminalIntent) {
            job = resolveCancelCas(job.jobId, store.updateJob(job.jobId, job.revision, job.state, {
                state: 'cancel_requested',
                terminalIntent: 'user_cancel',
                cancelRequestedAt: now(),
            }));
        }
        schedule(0);
        return toPublicJob(job);
    }

    async function updateEndpoint(value) {
        assertAvailable();
        const endpointUrl = normalizeEndpoint(value);
        const config = store.updateConfig({ endpointUrl });
        const jobs = store.listNonterminalJobs();
        for (const original of jobs) {
            let job = original;
            const patch = {
                endpointUrl,
                endpointGeneration: config.endpointGeneration,
                errorCode: null,
                errorMessage: null,
                absenceCount: 0,
                absenceConfirmedAt: null,
            };
            if (job.state !== 'queued') patch.state = job.state === 'cancel_requested' ? 'cancel_requested' : 'unknown';
            store.updateJob(job.jobId, job.revision, job.state, patch);
        }
        schedule(0);
        return toPublicConfig(config, await probe(endpointUrl));
    }

    async function analyzeTemplate(graphJson) {
        assertAvailable();
        return registry.analyzeTemplate(graphJson);
    }

    async function registerTemplate(input) {
        assertAvailable();
        return registry.registerTemplate(input);
    }

    async function removeTemplate(templateId) {
        assertAvailable();
        return registry.removeTemplate(templateId);
    }

    async function listTemplates(kind = null) {
        assertAvailable();
        return registry.listTemplates(kind);
    }

    async function getConfig() {
        assertAvailable();
        return toPublicConfig(store.getConfig());
    }

    function purgeForWorldReplacement() {
        localGeneration += 1;
        return store.purgeForRestore();
    }

    async function resetForWorldReplacement() {
        await pauseForWorldReplacement();
        try {
            const purged = purgeForWorldReplacement();
            await assets.cleanupStaging();
            return purged;
        } finally {
            await resumeAfterWorldReplacement();
        }
    }

    return {
        submit,
        poll,
        findByOperationKey,
        cancel,
        analyzeTemplate,
        registerTemplate,
        removeTemplate,
        listTemplates,
        getConfig,
        updateEndpoint,
        getHealth,
        runOnce,
        start,
        stop,
        pauseForWorldReplacement,
        resumeAfterWorldReplacement,
        isWorldReplacementPaused,
        purgeForWorldReplacement,
        resetForWorldReplacement,
        toPublicJob,
    };
}

module.exports = {
    createComfyOrchestrator,
    normalizeEndpoint,
    toPublicJob,
};
