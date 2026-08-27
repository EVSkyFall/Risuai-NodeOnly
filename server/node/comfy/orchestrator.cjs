'use strict';

const { comfyError, isComfyError } = require('./errors.cjs');
const {
    collectTimelineAssets,
    isTimelineAssetKey,
    resolveTimelineSpec,
    timelineAssetKey,
} = require('./timeline.cjs');

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_PROMPT_SETTLEMENT_WINDOW_MS = 120_000;
const DEFAULT_SETTLEMENT_SCAN_INTERVAL_MS = 5_000;
const DEFAULT_SUBMISSION_PROOF_RETRY_DELAY_MS = 30_000;
const GLOBAL_HISTORY_PAGE_LIMIT = 200;
const MAX_MATERIALIZE_ATTEMPTS = 5;
const MATERIALIZE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];
const DISPATCH_WAIT_MESSAGE = 'ComfyUI 연결 대기 — 터널 혼잡/끊김, 자동 재시도 중';
const WORKER_PREEMPTED_MESSAGE = 'ComfyUI 작업 전환 대기 — 자동으로 다시 확인 중';
const SUBMISSION_PROOF_WAIT_MESSAGE = 'ComfyUI 원격 접수 여부를 증명할 수 없어요 — 대기 중이며 취소할 수 있어요';
const CANCEL_PENDING_MESSAGE = 'ComfyUI 취소 진행 중 — 원격 작업을 확인하고 있어요';

// A timeline can name twelve references; a bare COMFY_INPUT_* leaves the plugin
// guessing which one it was. ComfyError has no details channel, so the item goes
// in the message and the code carries through untouched.
function describeTimelineItem({ type, slot, assetId }) {
    const address = Number.isSafeInteger(slot) ? `${type} slot ${slot}` : String(type ?? 'item');
    return `timeline ${address} (${assetId})`;
}

function attributeTimelineError(error, item) {
    if (!isComfyError(error)) return error;
    return comfyError(error.code, `${describeTimelineItem(item)}: ${error.message}`, {
        httpStatus: error.httpStatus,
        uncertain: error.uncertain,
        retryMaterialization: error.retryMaterialization,
        cause: error,
    });
}

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
    const dispatchRetryDelayMs = options.dispatchRetryDelayMs ?? (2 * pollIntervalMs);
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const promptSettlementWindowMs = Math.max(
        requestTimeoutMs,
        options.promptSettlementWindowMs ?? DEFAULT_PROMPT_SETTLEMENT_WINDOW_MS,
    );
    const settlementScanIntervalMs = options.settlementScanIntervalMs
        ?? DEFAULT_SETTLEMENT_SCAN_INTERVAL_MS;
    const submissionProofRetryDelayMs = options.submissionProofRetryDelayMs
        ?? DEFAULT_SUBMISSION_PROOF_RETRY_DELAY_MS;
    const stopDrainTimeoutMs = options.stopDrainTimeoutMs ?? 5_000;
    const logger = options.logger ?? console;
    const setTimer = options.setTimer ?? setTimeout;
    const clearTimer = options.clearTimer ?? clearTimeout;
    let activeRun = null;
    let activeRunController = null;
    let activeRunJobId = null;
    let timer = null;
    let started = false;
    let disabledCause = null;
    let worldReplacementPauseDepth = 0;
    let localGeneration = store.getConfig().restoreEpoch;
    const lastServedJobId = {
        cancel: null,
        reconcile: null,
        dispatch: null,
    };
    let lastRegularLane = null;
    let lastTopLevelLane = null;

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

    function workerAbortError(reason, code = 'COMFY_WORKER_ABORTED') {
        return comfyError(
            code,
            `Comfy worker was aborted for ${reason}`,
            { uncertain: true },
        );
    }

    async function drainActiveRun(timeoutMs = null) {
        const run = activeRun;
        if (!run) return true;
        let settled = false;
        const observed = run.catch(() => undefined).then(() => {
            settled = true;
        });
        if (timeoutMs == null) {
            await observed;
            return true;
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
        return settled;
    }

    // Comfy's non-2xx bodies name the exact failing node ("node_errors"); dropping
    // them left only "Comfy returned HTTP 400" in job records, which is
    // undiagnosable without replaying the prompt by hand. Best-effort: an
    // unreadable body still produces the bare status message.
    async function readErrorDetail(response) {
        let text = '';
        try {
            text = await response.text();
        } catch {
            return '';
        }
        if (!text) return '';
        try {
            const parsed = JSON.parse(text);
            const parts = [];
            const top = parsed?.error?.message ?? parsed?.error;
            if (typeof top === 'string' && top) parts.push(top);
            for (const [nodeId, entry] of Object.entries(parsed?.node_errors ?? {})) {
                for (const nodeError of entry?.errors ?? []) {
                    const detail = typeof nodeError?.details === 'string' && nodeError.details
                        ? ` (${nodeError.details})`
                        : '';
                    parts.push(`${entry?.class_type ?? '?'}#${nodeId}: ${nodeError?.message ?? nodeError?.type ?? 'error'}${detail}`);
                }
            }
            if (parts.length > 0) text = parts.join(' · ');
        } catch { /* not JSON — keep the raw body */ }
        return text.replace(/\s+/g, ' ').trim().slice(0, 600);
    }

    async function httpStatusError(response) {
        const detail = await readErrorDetail(response);
        const error = comfyError(
            'COMFY_HTTP_ERROR',
            `Comfy returned HTTP ${response.status}${detail ? ` — ${detail}` : ''}`,
            {
                httpStatus: response.status >= 500 ? 502 : 400,
                uncertain: response.status >= 500,
            },
        );
        error.remoteStatus = response.status;
        return error;
    }

    async function requestJson(endpointUrl, route, init = {}) {
        const abortScope = createRequestAbortScope(init.signal, requestTimeoutMs);
        try {
            const response = await fetchImpl(`${endpointUrl}${route}`, {
                ...init,
                signal: abortScope.signal,
            });
            if (!response.ok) {
                throw await httpStatusError(response);
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
                throw await httpStatusError(response);
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
                    uncertain: error?.uncertain === true,
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
            const requestedSlots = prior.templateSlots == null
                ? input.slots
                : registry.resolveRuntimeSlots(prior.templateSlots, input.slots);
            const requested = store.computeBindingHash({ templateId: input.template, slots: requestedSlots, target });
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
        const resolvedSlots = registry.resolveRuntimeSlots(template.templateSlots, input.slots);
        registry.instantiateSnapshot(
            template.sourceText,
            template.hash,
            resolvedSlots,
            template.id,
            { templateSlots: template.templateSlots, outputDescriptor: template.outputDescriptor },
        );
        const inputAssets = {};
        for (const imageSlot of template.templateSlots.inputImages ?? []) {
            const assetId = resolvedSlots[imageSlot.name];
            const inputAsset = await assets.readInputAsset(assetId);
            inputAssets[imageSlot.name] = { assetId, hash: inputAsset.hash };
        }
        if (template.templateSlots.timeline) {
            for (const { assetId, type, slot } of collectTimelineAssets(resolvedSlots.timeline)) {
                let inputAsset;
                try {
                    inputAsset = await assets.readInputAsset(assetId, type);
                } catch (error) {
                    throw attributeTimelineError(error, { type, slot, assetId });
                }
                // The sidecar dimensions are pinned here rather than re-read at
                // dispatch: a resumed dispatch skips the read for anything it
                // already uploaded, and the assembled document must not depend
                // on how far a previous attempt got.
                inputAssets[timelineAssetKey(assetId)] = {
                    assetId,
                    hash: inputAsset.hash,
                    type,
                    slot,
                    ...(Number.isSafeInteger(inputAsset.width) ? { width: inputAsset.width } : {}),
                    ...(Number.isSafeInteger(inputAsset.height) ? { height: inputAsset.height } : {}),
                };
            }
        }
        const config = store.getConfig();
        const endpointGeneration = config.endpointGeneration;
        const binding = {
            templateId: input.template,
            templateHash: template.hash,
            slots: resolvedSlots,
            inputAssets,
            endpointGeneration,
            target,
        };

        const endpointUrl = requireConfiguredEndpoint(config);
        const health = await probe(endpointUrl);
        if (!health.reachable && !health.error.uncertain) {
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
                slots: resolvedSlots,
                inputAssets,
                endpointUrl,
                endpointGeneration,
                timeoutMs: config.timeoutMs,
                target,
            },
        });
        if (created.replayed) {
            schedule(0);
            return toPublicJob(created.job);
        }
        const queued = health.reachable
            ? created.job
            : queueDispatchRetry(created.job, comfyError(
                health.error.code,
                health.error.message,
                { uncertain: true },
            ));
        schedule(0);
        return toPublicJob(queued ?? store.getJob(created.job.jobId));
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
        const errorMessage = error?.code === 'COMFY_WORKER_ABORTED'
            || error?.code === 'COMFY_WORKER_PREEMPTED'
            ? WORKER_PREEMPTED_MESSAGE
            : String(error?.message ?? error);
        return store.updateJob(job.jobId, job.revision, job.state, {
            state: 'unknown',
            errorCode: isComfyError(error) ? error.code : 'COMFY_REMOTE_UNKNOWN',
            errorMessage,
            absenceCount: 0,
            absenceConfirmedAt: null,
        });
    }

    function isRetryableDispatchConnectionError(error) {
        if (error?.code === 'COMFY_WORKER_ABORTED' || error?.code === 'COMFY_WORKER_PREEMPTED') return false;
        return error?.code === 'COMFY_UNREACHABLE'
            || (error?.code === 'COMFY_UPLOAD_FAILED' && error?.uncertain === true)
            || (error?.code === 'COMFY_HTTP_ERROR' && error?.uncertain === true);
    }

    function isRetryablePromptSubmissionError(error) {
        return isRetryableDispatchConnectionError(error)
            || error?.code === 'COMFY_RESPONSE_INVALID'
            || error?.code === 'COMFY_RESPONSE_TOO_LARGE'
            || error?.code === 'COMFY_PROMPT_ACK_INVALID';
    }

    function isRetryableUploadError(error) {
        return isRetryableDispatchConnectionError(error)
            || error?.code === 'COMFY_RESPONSE_INVALID'
            || error?.code === 'COMFY_RESPONSE_TOO_LARGE'
            || error?.code === 'COMFY_UPLOAD_RESPONSE_INVALID';
    }

    function dispatchWaitMessage(error) {
        if (error?.code === 'COMFY_WORKER_ABORTED' || error?.code === 'COMFY_WORKER_PREEMPTED') {
            return WORKER_PREEMPTED_MESSAGE;
        }
        let detail = String(error?.message ?? '').trim();
        if (detail.startsWith(DISPATCH_WAIT_MESSAGE)) {
            detail = detail.slice(DISPATCH_WAIT_MESSAGE.length).replace(/^\s*—\s*/, '').trim();
        }
        return detail ? `${DISPATCH_WAIT_MESSAGE} — ${detail}` : DISPATCH_WAIT_MESSAGE;
    }

    function queueDispatchRetry(job, error, absence = null, retryDelayMs = dispatchRetryDelayMs) {
        return store.updateJob(job.jobId, job.revision, job.state, {
            state: 'queued',
            startedAt: null,
            dispatchRetryAt: now() + retryDelayMs,
            errorCode: isComfyError(error) || typeof error?.code === 'string'
                ? error.code
                : 'COMFY_UNREACHABLE',
            errorMessage: dispatchWaitMessage(error),
            absenceCount: absence?.count ?? 0,
            absenceConfirmedAt: absence?.confirmedAt ?? null,
        });
    }

    function queueSubmissionProofWait(job) {
        return store.updateJob(job.jobId, job.revision, job.state, {
            state: 'queued',
            startedAt: null,
            dispatchRetryAt: now() + submissionProofRetryDelayMs,
            errorCode: 'COMFY_SUBMISSION_PROOF_UNAVAILABLE',
            errorMessage: SUBMISSION_PROOF_WAIT_MESSAGE,
            absenceCount: 0,
            absenceConfirmedAt: null,
        });
    }

    function markerScanRetryDelay(error) {
        return typeof error?.code === 'string' && error.code.startsWith('COMFY_DUPLICATE_')
            ? dispatchRetryDelayMs
            : settlementScanIntervalMs;
    }

    function handleDispatchInterruption(job, error) {
        if (error?.code !== 'COMFY_WORKER_ABORTED' && error?.code !== 'COMFY_WORKER_PREEMPTED') {
            return null;
        }
        if (job.terminalIntent === 'user_cancel') {
            if (job.promptAttemptedAt == null) {
                return store.updateJob(job.jobId, job.revision, job.state, {
                    state: 'cancelled',
                    dispatchRetryAt: null,
                    errorCode: null,
                    errorMessage: null,
                    finishedAt: now(),
                });
            }
            return store.updateJob(job.jobId, job.revision, job.state, {
                state: 'cancel_requested',
                startedAt: null,
                dispatchRetryAt: now() + dispatchRetryDelayMs,
                errorCode: error.code,
                errorMessage: WORKER_PREEMPTED_MESSAGE,
                absenceCount: 0,
                absenceConfirmedAt: null,
            });
        }
        if (job.promptAttemptedAt != null) return queueDispatchRetry(job, error);
        return store.updateJob(job.jobId, job.revision, job.state, {
            state: 'queued',
            startedAt: null,
            dispatchRetryAt: null,
            errorCode: null,
            errorMessage: null,
            absenceCount: 0,
            absenceConfirmedAt: null,
        });
    }

    async function dispatchQueued(job, generation, signal) {
        if (job.promptId != null || job.remoteOutput != null) {
            return reconcileJob(job, generation, signal);
        }
        const dispatchNow = now();
        let current = store.updateJob(job.jobId, job.revision, 'queued', {
            state: 'submitting',
            startedAt: dispatchNow,
            deadlineAt: dispatchNow + job.timeoutMs,
            dispatchRetryAt: null,
            errorCode: null,
            errorMessage: null,
        });
        if (!current || generation !== localGeneration) return;

        try {
            if (current.promptAttemptedAt != null) {
                let markerScan;
                try {
                    markerScan = await scanSubmissionMarker(current, signal, generation);
                } catch (error) {
                    if (generation !== localGeneration) return;
                    return queueDispatchRetry(current, error, null, markerScanRetryDelay(error));
                }
                if (generation !== localGeneration) return;
                const marker = markerScan?.marker;
                if (marker) {
                    if (marker.terminalSettled) {
                        return store.updateJob(current.jobId, current.revision, 'submitting', {
                            state: 'cancelled',
                            dispatchRetryAt: null,
                            errorCode: null,
                            errorMessage: null,
                            finishedAt: now(),
                        });
                    }
                    const recovered = store.updateJob(current.jobId, current.revision, 'submitting', {
                        state: 'remote_queued',
                        promptId: marker.promptId,
                        dispatchRetryAt: null,
                        absenceCount: 0,
                        absenceConfirmedAt: null,
                        errorCode: null,
                        errorMessage: null,
                    });
                    if (!recovered || generation !== localGeneration) return recovered;
                    if (marker.historyEntry) {
                        return finishFromHistory(recovered, marker.historyEntry, generation, signal);
                    }
                    return recovered;
                }
                if (now() - current.promptAttemptedAt < promptSettlementWindowMs) {
                    return queueDispatchRetry(current, comfyError(
                        'COMFY_SUBMISSION_SETTLING',
                        'Comfy submission is still inside its acknowledgement settlement window',
                        { uncertain: true },
                    ), null, settlementScanIntervalMs);
                }
                if (!current.terminalIntent && !markerAbsenceIsProvable(current, markerScan)) {
                    return queueSubmissionProofWait(current);
                }
                if (current.absenceCount < 1 || !current.absenceConfirmedAt) {
                    return queueDispatchRetry(
                        current,
                        comfyError(
                            'COMFY_SUBMISSION_UNCONFIRMED',
                            'Comfy has not exposed the attempted submission yet',
                            { uncertain: true },
                        ),
                        { count: 1, confirmedAt: now() },
                    );
                }
                if (now() - current.absenceConfirmedAt < dispatchRetryDelayMs) {
                    return queueDispatchRetry(
                        current,
                        comfyError(
                            'COMFY_SUBMISSION_UNCONFIRMED',
                            'Comfy submission absence is awaiting confirmation',
                            { uncertain: true },
                        ),
                        { count: current.absenceCount, confirmedAt: current.absenceConfirmedAt },
                    );
                }
                if (current.terminalIntent) {
                    return finishConfirmedAbsent(current, dispatchRetryDelayMs);
                }
            }

            const remoteInputs = { ...(current.remoteInputs ?? {}) };
            for (const [slotName, snapshot] of Object.entries(current.inputAssets ?? {})) {
                if (remoteInputs[slotName]) continue;
                const timelineItem = isTimelineAssetKey(slotName) ? snapshot : null;
                let input;
                try {
                    input = await assets.readInputAsset(snapshot.assetId, snapshot.type ?? 'image');
                } catch (error) {
                    if (!timelineItem) throw error;
                    throw attributeTimelineError(error, timelineItem);
                }
                if (generation !== localGeneration) return;
                if (input.hash !== snapshot.hash) {
                    const changed = 'Input asset changed after submission';
                    return failJob(
                        current,
                        'COMFY_INPUT_CHANGED',
                        timelineItem ? `${describeTimelineItem(timelineItem)}: ${changed}` : changed,
                    );
                }
                if (generation !== localGeneration || !store.getJob(current.jobId)) return;
                try {
                    remoteInputs[slotName] = await assets.uploadInput(
                        current.endpointUrl,
                        current.jobId,
                        input,
                        { signal },
                    );
                } catch (error) {
                    if (generation !== localGeneration) return;
                    const attributed = timelineItem ? attributeTimelineError(error, timelineItem) : error;
                    if (isRetryableUploadError(error)) return queueDispatchRetry(current, attributed);
                    throw attributed;
                }
                if (generation !== localGeneration) return;
                current = store.updateJob(current.jobId, current.revision, 'submitting', {
                    remoteInputs,
                    remoteInputName: Object.values(remoteInputs)[0] ?? null,
                });
                if (!current || generation !== localGeneration) return;
            }

            const compiledSlots = { ...current.slots };
            for (const [slotName, remoteName] of Object.entries(remoteInputs)) {
                if (!isTimelineAssetKey(slotName)) compiledSlots[slotName] = remoteName;
            }
            if (current.templateSlots?.timeline) {
                // The job's own creation timestamp — persisted at submit — is what
                // stamps the assembled item ids, so a retried or resumed dispatch
                // rebuilds the identical document.
                compiledSlots.timeline = resolveTimelineSpec(
                    current.slots.timeline,
                    current.inputAssets,
                    remoteInputs,
                    current.createdAt,
                );
            }
            const compiled = registry.instantiateSnapshot(
                current.templateJson,
                current.templateHash,
                compiledSlots,
                current.templateId,
                { templateSlots: current.templateSlots, outputDescriptor: current.outputDescriptor },
                { timelineResolved: Boolean(current.templateSlots?.timeline) },
            );
            let attemptSequenceHorizon;
            try {
                attemptSequenceHorizon = await snapshotSubmissionSequenceHorizon(
                    current,
                    signal,
                    generation,
                );
            } catch (error) {
                if (generation !== localGeneration) return;
                const latest = store.getJob(current.jobId);
                if (!latest || store.isTerminalState(latest.state)) return latest;
                if (handleDispatchInterruption(latest, error)) return;
                return queueDispatchRetry(latest, error);
            }
            if (generation !== localGeneration) return;
            if (!Number.isFinite(attemptSequenceHorizon)) {
                return queueDispatchRetry(current, comfyError(
                    'COMFY_SUBMISSION_HORIZON_UNAVAILABLE',
                    'Comfy did not expose a finite submission sequence horizon',
                    { uncertain: true },
                ));
            }
            current = store.updateJob(current.jobId, current.revision, 'submitting', {
                promptAttemptedAt: now(),
                attemptSequenceHorizon,
                absenceCount: 0,
                absenceConfirmedAt: null,
            });
            if (!current || generation !== localGeneration) return;
            let response;
            try {
                response = await requestJson(current.endpointUrl, '/prompt', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        prompt: compiled.prompt,
                        client_id: current.jobId,
                        extra_data: { risu_job_id: current.jobId },
                    }),
                    signal,
                });
            } catch (error) {
                if (generation !== localGeneration) return;
                if (error?.code === 'COMFY_WORKER_ABORTED' || error?.code === 'COMFY_WORKER_PREEMPTED') {
                    const latest = store.getJob(current.jobId);
                    if (!latest || store.isTerminalState(latest.state)) return latest;
                    return handleDispatchInterruption(latest, error);
                }
                if (isRetryablePromptSubmissionError(error)) return queueDispatchRetry(current, error);
                return failJob(current, error?.code ?? 'COMFY_PROMPT_REJECTED', String(error?.message ?? error));
            }
            if (generation !== localGeneration) return;
            if (typeof response?.prompt_id !== 'string' || !response.prompt_id) {
                return queueDispatchRetry(current, comfyError(
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
            if (generation !== localGeneration) return;
            const latest = store.getJob(job.jobId);
            if (!latest || store.isTerminalState(latest.state)) return;
            if (handleDispatchInterruption(latest, error)) return;
            if (isRetryableDispatchConnectionError(error)) queueDispatchRetry(latest, error);
            else if (error?.uncertain) markUnknown(latest, error);
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
        if (generation !== localGeneration) return null;
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
            if (generation !== localGeneration) return;
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

    async function snapshotSubmissionSequenceHorizon(job, signal, generation) {
        const queue = queueEntries(await requestJson(job.endpointUrl, '/queue', { signal }));
        if (generation !== localGeneration) return null;
        const history = await requestJson(job.endpointUrl, '/history?max_items=1', { signal });
        if (generation !== localGeneration) return null;
        if (!isObject(history)) throw comfyError(
            'COMFY_HISTORY_RESPONSE_INVALID',
            'Comfy history response is not a prompt-keyed object',
            { uncertain: true },
        );
        const sequences = [];
        for (const entry of [...queue.running, ...queue.pending]) {
            if (!Array.isArray(entry) || !Number.isFinite(Number(entry[0]))) {
                throw comfyError('COMFY_QUEUE_RESPONSE_INVALID', 'Comfy queue sequence is invalid', { uncertain: true });
            }
            sequences.push(Number(entry[0]));
        }
        for (const entry of Object.values(history)) {
            if (!isObject(entry) || !Array.isArray(entry.prompt) || !Number.isFinite(Number(entry.prompt[0]))) {
                throw comfyError('COMFY_HISTORY_RESPONSE_INVALID', 'Comfy history sequence is invalid', { uncertain: true });
            }
            sequences.push(Number(entry.prompt[0]));
        }
        return sequences.length > 0 ? Math.max(...sequences) : 0;
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
            if (generation !== localGeneration) return;
            if (job.terminalIntent === 'user_cancel') return queueDispatchRetry(job, error);
            return markUnknown(job, error);
        }
        if (generation !== localGeneration) return;
        if (!isObject(history)) {
            const error = comfyError(
                'COMFY_HISTORY_RESPONSE_INVALID',
                'Comfy history response is not a prompt-keyed object',
                { uncertain: true },
            );
            return job.terminalIntent === 'user_cancel'
                ? queueDispatchRetry(job, error)
                : markUnknown(job, error);
        }
        const entry = history[job.promptId];
        if (entry) return finishFromHistory(job, entry, generation, signal);

        let queue;
        try {
            queue = queueEntries(await requestJson(job.endpointUrl, '/queue', { signal }));
        } catch (error) {
            if (generation !== localGeneration) return;
            if (job.terminalIntent === 'user_cancel') return queueDispatchRetry(job, error);
            return markUnknown(job, error);
        }
        if (generation !== localGeneration) return;
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
                    return queueDispatchRetry(cleared, error);
                }
                return queueDispatchRetry(latest, error);
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
        if (!isObject(history)) return {
            capable: false,
            matches: [],
            full: false,
            minSequence: null,
        };
        const entries = Object.entries(history);
        const matches = [];
        const sequences = [];
        let sequencesComplete = true;
        for (const [key, entry] of entries) {
            if (!isObject(entry) || !Array.isArray(entry.prompt) || !isObject(entry.prompt[3])) {
                return { capable: false, matches: [], full: false, minSequence: null };
            }
            const promptId = typeof entry.prompt[1] === 'string' ? entry.prompt[1] : key;
            if (typeof promptId !== 'string' || !promptId) {
                return { capable: false, matches: [], full: false, minSequence: null };
            }
            const sequence = Number(entry.prompt[0]);
            if (Number.isFinite(sequence)) sequences.push(sequence);
            else sequencesComplete = false;
            if (submissionMarkerMatches(entry.prompt[3], jobId)) {
                matches.push({
                    promptId,
                    priority: sequence,
                    historyEntry: entry,
                    queueLocation: null,
                });
            }
        }
        return {
            capable: true,
            matches,
            full: entries.length >= GLOBAL_HISTORY_PAGE_LIMIT,
            minSequence: sequencesComplete && sequences.length > 0 ? Math.min(...sequences) : null,
        };
    }

    function inspectGlobalQueue(queue, jobId) {
        let parsed;
        try {
            parsed = queueEntries(queue);
        } catch {
            return { capable: false, matches: [] };
        }
        const matches = [];
        for (const [queueLocation, locationEntries] of [
            ['running', parsed.running],
            ['pending', parsed.pending],
        ]) {
            for (const entry of locationEntries) {
                if (!Array.isArray(entry) || typeof entry[1] !== 'string' || !isObject(entry[3])) {
                    return { capable: false, matches: [] };
                }
                if (submissionMarkerMatches(entry[3], jobId)) {
                    matches.push({
                        promptId: entry[1],
                        priority: Number(entry[0]),
                        historyEntry: null,
                        queueLocation,
                    });
                }
            }
        }
        return { capable: true, matches };
    }

    function submissionMarkerMatches(extraData, jobId) {
        if (Object.prototype.hasOwnProperty.call(extraData, 'risu_job_id')) {
            return extraData.risu_job_id === jobId;
        }
        return extraData.client_id === jobId;
    }

    function mergeSubmissionMatches(queueMatches, historyMatches) {
        const merged = new Map();
        for (const match of [...queueMatches, ...historyMatches]) {
            const prior = merged.get(match.promptId);
            if (!prior) {
                merged.set(match.promptId, { ...match });
                continue;
            }
            if (Number.isFinite(match.priority)) prior.priority = match.priority;
            if (match.historyEntry) prior.historyEntry = match.historyEntry;
            if (match.queueLocation) prior.queueLocation = match.queueLocation;
        }
        return [...merged.values()].sort((left, right) => {
            const leftPriority = Number.isFinite(left.priority) ? left.priority : Number.POSITIVE_INFINITY;
            const rightPriority = Number.isFinite(right.priority) ? right.priority : Number.POSITIVE_INFINITY;
            return leftPriority - rightPriority || left.promptId.localeCompare(right.promptId);
        });
    }

    async function cancelRunningDuplicate(job, match, keeperPromptId, signal, generation) {
        if (generation !== localGeneration) return false;
        try {
            await requestAck(
                job.endpointUrl,
                `/api/jobs/${encodeURIComponent(match.promptId)}/cancel`,
                { method: 'POST', signal },
            );
            return generation === localGeneration;
        } catch (error) {
            if (generation !== localGeneration) return false;
            if (!(error?.remoteStatus >= 400 && error.remoteStatus < 500)) throw error;
        }

        if (generation !== localGeneration) return false;
        const freshQueue = queueEntries(await requestJson(job.endpointUrl, '/queue', { signal }));
        if (generation !== localGeneration) return false;
        const soleRunning = freshQueue.running.length === 1 ? freshQueue.running[0] : null;
        if (
            !Array.isArray(soleRunning)
            || soleRunning[1] !== match.promptId
            || soleRunning[1] === keeperPromptId
        ) {
            throw comfyError(
                'COMFY_DUPLICATE_CLEANUP_UNSAFE',
                'Legacy Comfy cannot safely interrupt this duplicate while other prompts are running',
                { uncertain: true },
            );
        }
        if (generation !== localGeneration) return false;
        await requestAck(job.endpointUrl, '/interrupt', { method: 'POST', signal });
        return generation === localGeneration;
    }

    async function settleSubmissionMatches(job, matches, signal, generation) {
        if (generation !== localGeneration) return null;
        if (matches.length === 0) return null;
        const keeper = matches[0];
        const terminal = Boolean(job.terminalIntent);
        const activeTargets = matches.filter(match => (
            match.queueLocation
            && (terminal || match.promptId !== keeper.promptId)
        ));
        const pendingIds = activeTargets
            .filter(match => match.queueLocation === 'pending')
            .map(match => match.promptId);
        try {
            if (pendingIds.length > 0) {
                if (generation !== localGeneration) return null;
                await requestAck(job.endpointUrl, '/queue', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ delete: pendingIds }),
                    signal,
                });
                if (generation !== localGeneration) return null;
            }
            for (const match of activeTargets.filter(candidate => candidate.queueLocation === 'running')) {
                if (generation !== localGeneration) return null;
                const cancelled = await cancelRunningDuplicate(
                    job,
                    match,
                    terminal ? null : keeper.promptId,
                    signal,
                    generation,
                );
                if (!cancelled || generation !== localGeneration) return null;
            }
        } catch (cause) {
            if (generation !== localGeneration) return null;
            throw comfyError(
                'COMFY_DUPLICATE_CLEANUP_FAILED',
                `Could not safely cancel duplicate Comfy submissions: ${String(cause?.message ?? cause)}`,
                { cause, uncertain: true },
            );
        }
        if (generation !== localGeneration) return null;
        if (activeTargets.length > 0) {
            throw comfyError(
                'COMFY_DUPLICATE_CLEANUP_PENDING',
                'Duplicate Comfy submissions were cancelled and are awaiting queue reconciliation',
                { uncertain: true },
            );
        }
        if (terminal) return { terminalSettled: true };
        if (matches.length > 1) {
            logger.warn?.(
                `[Comfy] Job ${job.jobId} has completed duplicate submissions; adopting the oldest ${keeper.promptId}`,
            );
        }
        return {
            promptId: keeper.promptId,
            historyEntry: keeper.historyEntry,
        };
    }

    async function scanSubmissionMarker(job, signal, generation) {
        if (generation !== localGeneration) return null;
        const queue = await requestJson(job.endpointUrl, '/queue', { signal });
        if (generation !== localGeneration) return null;
        const queueScan = inspectGlobalQueue(queue, job.jobId);
        const history = await requestJson(
            job.endpointUrl,
            `/history?max_items=${GLOBAL_HISTORY_PAGE_LIMIT}`,
            { signal },
        );
        if (generation !== localGeneration) return null;
        const historyScan = inspectGlobalHistory(history, job.jobId);
        if (!queueScan.capable || !historyScan.capable) {
            throw comfyError(
                'COMFY_MARKER_UNAVAILABLE',
                'Comfy responses do not expose a recoverable client marker',
                { uncertain: true },
            );
        }
        const marker = await settleSubmissionMatches(
            job,
            mergeSubmissionMatches(queueScan.matches, historyScan.matches),
            signal,
            generation,
        );
        return {
            marker,
            historyFull: historyScan.full,
            minHistorySequence: historyScan.minSequence,
        };
    }

    function markerAbsenceIsProvable(job, scan) {
        // This horizon rule follows the dedicated-backend contract: Risu submits
        // with Comfy's default monotonic number and the retained tail brackets it.
        // The unfilled-page shortcut also assumes stock Comfy retains every
        // history entry until its configured history storage is explicitly pruned.
        if (!scan.historyFull) return true;
        return Number.isFinite(job.attemptSequenceHorizon)
            && Number.isFinite(scan.minHistorySequence)
            && scan.minHistorySequence <= job.attemptSequenceHorizon;
    }

    function finishConfirmedAbsent(job, confirmationDelayMs = pollIntervalMs) {
        if (job.absenceCount < 1 || !job.absenceConfirmedAt) {
            return store.updateJob(job.jobId, job.revision, job.state, {
                absenceCount: 1,
                absenceConfirmedAt: now(),
            });
        }
        if (now() - job.absenceConfirmedAt < confirmationDelayMs) return job;
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
        let markerScan;
        try {
            markerScan = await scanSubmissionMarker(job, signal, generation);
        } catch (error) {
            if (generation !== localGeneration) return;
            if (job.promptAttemptedAt != null) {
                return queueDispatchRetry(job, error, null, markerScanRetryDelay(error));
            }
            return markUnknown(job, error);
        }
        if (generation !== localGeneration) return;
        const marker = markerScan?.marker;
        if (!marker) {
            if (job.promptAttemptedAt == null) return finishConfirmedAbsent(job);
            if (
                now() - job.promptAttemptedAt < promptSettlementWindowMs
            ) {
                return queueDispatchRetry(job, comfyError(
                    'COMFY_SUBMISSION_SETTLING',
                    'Comfy submission is still inside its acknowledgement settlement window',
                    { uncertain: true },
                ), null, settlementScanIntervalMs);
            }
            if (!job.terminalIntent && !markerAbsenceIsProvable(job, markerScan)) {
                return queueSubmissionProofWait(job);
            }
            if (job.absenceCount < 1 || !job.absenceConfirmedAt) {
                return queueDispatchRetry(
                    job,
                    comfyError(
                        'COMFY_SUBMISSION_UNCONFIRMED',
                        'Comfy has not exposed the attempted submission yet',
                        { uncertain: true },
                    ),
                    { count: 1, confirmedAt: now() },
                );
            }
            if (now() - job.absenceConfirmedAt < dispatchRetryDelayMs) {
                return queueDispatchRetry(
                    job,
                    comfyError(
                        'COMFY_SUBMISSION_UNCONFIRMED',
                        'Comfy submission absence is awaiting confirmation',
                        { uncertain: true },
                    ),
                    { count: job.absenceCount, confirmedAt: job.absenceConfirmedAt },
                );
            }
            if (job.terminalIntent) return finishConfirmedAbsent(job, dispatchRetryDelayMs);
            return store.updateJob(job.jobId, job.revision, job.state, {
                state: 'queued',
                startedAt: null,
                promptAttemptedAt: null,
                attemptSequenceHorizon: null,
                dispatchRetryAt: now() + dispatchRetryDelayMs,
                absenceCount: 0,
                absenceConfirmedAt: null,
                errorCode: 'COMFY_SUBMISSION_RETRY_READY',
                errorMessage: DISPATCH_WAIT_MESSAGE,
            });
        }
        if (marker.terminalSettled) {
            return store.updateJob(job.jobId, job.revision, job.state, {
                state: 'cancelled',
                dispatchRetryAt: null,
                errorCode: null,
                errorMessage: null,
                finishedAt: now(),
            });
        }
        const recovered = store.updateJob(job.jobId, job.revision, job.state, {
            state: 'unknown',
            promptId: marker.promptId,
            absenceCount: 0,
            absenceConfirmedAt: null,
            errorCode: null,
            errorMessage: null,
        });
        if (!recovered || generation !== localGeneration) return recovered;
        if (marker.historyEntry) return finishFromHistory(recovered, marker.historyEntry, generation, signal);
        return reconcileKnownPrompt(recovered, generation, signal);
    }

    async function cancelMaterialization(job, generation) {
        if (generation !== localGeneration) return null;
        const cancelled = store.updateJob(job.jobId, job.revision, job.state, {
            state: 'cancelled',
            materializeRetryAt: null,
            dispatchRetryAt: null,
            errorCode: null,
            errorMessage: null,
            finishedAt: now(),
        });
        if (!cancelled) return store.getJob(job.jobId);
        for (const cleanup of [
            () => assets.removeMaterializedAsset?.(`comfy-${job.jobId}`),
            () => assets.finalizeMaterialization?.(job.jobId),
        ]) {
            try {
                await cleanup();
            } catch (error) {
                try {
                    logger.error?.('[Comfy] cancelled materialization cleanup failed:', error);
                } catch {
                    // Cleanup logging is best-effort after the terminal CAS.
                }
            }
        }
        return cancelled;
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
        if (job.terminalIntent === 'user_cancel' && job.remoteOutput) {
            return cancelMaterialization(job, generation);
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

    function compareServiceOrder(left, right) {
        return (left.updatedAt - right.updatedAt)
            || (left.createdAt - right.createdAt)
            || left.jobId.localeCompare(right.jobId);
    }

    function selectRotating(candidates, lane) {
        if (candidates.length === 0) return null;
        const ordered = [...candidates].sort(compareServiceOrder);
        const priorIndex = ordered.findIndex(job => job.jobId === lastServedJobId[lane]);
        const selected = ordered[priorIndex < 0 ? 0 : (priorIndex + 1) % ordered.length];
        lastServedJobId[lane] = selected.jobId;
        return selected;
    }

    function isDispatchRetryDue(job, timestamp) {
        if (job.dispatchRetryAt != null && job.dispatchRetryAt > timestamp) return false;
        return true;
    }

    function isServiceDue(job, timestamp) {
        if (!isDispatchRetryDue(job, timestamp)) return false;
        if (job.materializeRetryAt != null && job.materializeRetryAt > timestamp) return false;
        return true;
    }

    function selectRegularJob(dueRegular) {
        const reconcile = dueRegular.filter(job => (
            job.state !== 'queued'
            || job.promptId != null
            || job.remoteOutput != null
            || job.promptAttemptedAt != null
        ));
        const dispatch = dueRegular.filter(job => (
            job.state === 'queued'
            && job.promptId == null
            && job.remoteOutput == null
            && job.promptAttemptedAt == null
        ));

        const laneOrder = lastRegularLane === 'reconcile'
            ? ['dispatch', 'reconcile']
            : ['reconcile', 'dispatch'];
        for (const lane of laneOrder) {
            const selected = selectRotating(lane === 'reconcile' ? reconcile : dispatch, lane);
            if (!selected) continue;
            lastRegularLane = lane;
            return selected;
        }
        return null;
    }

    function selectNextJob(jobs) {
        const timestamp = now();
        const dueCancels = jobs.filter(job => (
            job.terminalIntent === 'user_cancel' && isDispatchRetryDue(job, timestamp)
        ));
        const dueRegular = jobs.filter(job => (
            job.terminalIntent !== 'user_cancel' && isServiceDue(job, timestamp)
        ));
        const chooseCancel = dueCancels.length > 0
            && (dueRegular.length === 0 || lastTopLevelLane !== 'cancel');
        if (chooseCancel) {
            const cancel = selectRotating(dueCancels, 'cancel');
            if (cancel) {
                lastTopLevelLane = 'cancel';
                return cancel;
            }
        }
        const regular = selectRegularJob(dueRegular);
        if (regular) {
            lastTopLevelLane = 'regular';
            return regular;
        }
        const cancel = selectRotating(dueCancels, 'cancel');
        if (cancel) lastTopLevelLane = 'cancel';
        return cancel;
    }

    function paceCancellation(jobId, generation) {
        if (generation !== localGeneration) return null;
        const latest = store.getJob(jobId);
        if (
            !latest
            || store.isTerminalState(latest.state)
            || latest.terminalIntent !== 'user_cancel'
        ) return latest;
        const nextDue = now() + dispatchRetryDelayMs;
        if (latest.dispatchRetryAt != null && latest.dispatchRetryAt >= nextDue) return latest;
        return store.updateJob(latest.jobId, latest.revision, latest.state, {
            dispatchRetryAt: nextDue,
        }) ?? store.getJob(latest.jobId);
    }

    async function serviceSelectedJob(job, signal, generation) {
        if (
            job.state === 'submitting'
            && job.promptId == null
            && job.promptAttemptedAt != null
        ) {
            return queueDispatchRetry(job, comfyError(
                'COMFY_SUBMISSION_RECOVERY',
                'A prior Comfy submission attempt requires marker reconciliation',
                { uncertain: true },
            ), null, settlementScanIntervalMs);
        }
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
        // No generation deadline: a high-quality render legitimately runs for
        // hours (user directive 2026-08-08 — connection timeouts only, never a
        // generation timeout). deadlineAt stays as dispatch metadata; a job
        // whose REMOTE vanished is still reaped by absence reconciliation, and
        // cancel remains available at any time.
        if (!job || store.isTerminalState(job.state)) return job;
        if (job.state === 'queued' && job.promptId == null && job.remoteOutput == null) {
            return dispatchQueued(job, generation, signal);
        }
        return reconcileJob(job, generation, signal);
    }

    async function runNext(signal, generation) {
        if (generation !== localGeneration) return null;
        const jobs = store.listNonterminalJobs();
        if (jobs.length === 0) return null;
        let job = selectNextJob(jobs);
        if (!job) return null;
        activeRunJobId = job.jobId;
        const result = await serviceSelectedJob(job, signal, generation);
        const latest = store.getJob(job.jobId);
        if (job.terminalIntent === 'user_cancel' || latest?.terminalIntent === 'user_cancel') {
            return paceCancellation(job.jobId, generation) ?? result;
        }
        return result;
    }

    function runOnce() {
        if (worldReplacementPauseDepth > 0) return Promise.resolve(null);
        if (disabledCause) return Promise.resolve(null);
        if (activeRun) return activeRun;
        const controller = new AbortController();
        const generation = localGeneration;
        const run = Promise.resolve()
            .then(() => runNext(controller.signal, generation))
            .finally(() => {
                let ownedActiveSlot = false;
                if (activeRun === run) {
                    ownedActiveSlot = true;
                    activeRun = null;
                    activeRunController = null;
                    activeRunJobId = null;
                }
                if (ownedActiveSlot && started && store.listNonterminalJobs().length > 0) {
                    schedule(pollIntervalMs);
                }
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
        localGeneration += 1;
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
            localGeneration += 1;
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
        let needsRemoteCancellation = false;
        if (
            job.state === 'queued'
            && job.promptAttemptedAt == null
            && job.promptId == null
            && job.remoteOutput == null
        ) {
            job = resolveCancelCas(job.jobId, store.updateJob(job.jobId, job.revision, 'queued', {
                state: 'cancelled',
                terminalIntent: 'user_cancel',
                cancelRequestedAt: now(),
                finishedAt: now(),
            }));
        } else {
            job = resolveCancelCas(job.jobId, store.updateJob(job.jobId, job.revision, job.state, {
                state: 'cancel_requested',
                terminalIntent: 'user_cancel',
                cancelRequestedAt: job.cancelRequestedAt ?? now(),
                dispatchRetryAt: null,
                errorCode: 'COMFY_CANCEL_PENDING',
                errorMessage: CANCEL_PENDING_MESSAGE,
            }));
            needsRemoteCancellation = true;
        }
        if (
            needsRemoteCancellation
            && activeRunJobId === jobId
            && activeRunController
            && !activeRunController.signal.aborted
        ) {
            activeRunController.abort(workerAbortError(
                `cancellation of ${jobId} while ${activeRunJobId ?? 'worker'} was active`,
                'COMFY_WORKER_PREEMPTED',
            ));
        }
        schedule(0);
        return toPublicJob(job);
    }

    async function updateEndpoint(value) {
        assertAvailable();
        const endpointUrl = normalizeEndpoint(value);
        const staleRun = activeRun;
        localGeneration += 1;
        activeRunController?.abort(workerAbortError(
            'Comfy endpoint replacement',
            'COMFY_WORKER_PREEMPTED',
        ));
        const config = store.updateConfig({ endpointUrl });
        const jobs = store.listNonterminalJobs();
        for (const original of jobs) {
            let job = original;
            const patch = {
                endpointUrl,
                endpointGeneration: config.endpointGeneration,
                absenceCount: 0,
                absenceConfirmedAt: null,
            };
            // Endpoint replacement normally rotates the tunnel to the same Comfy
            // backend, so the durable attempt horizon remains valid. A switch to
            // another backend stays conservatively proof-parked and cancellable.
            if (job.state === 'queued') {
                patch.dispatchRetryAt = null;
            } else if (job.state === 'submitting') {
                patch.state = 'queued';
                patch.startedAt = null;
                patch.dispatchRetryAt = null;
                patch.errorCode = null;
                patch.errorMessage = null;
            } else {
                patch.state = job.state === 'cancel_requested' ? 'cancel_requested' : 'unknown';
                patch.errorCode = null;
                patch.errorMessage = null;
            }
            store.updateJob(job.jobId, job.revision, job.state, patch);
        }
        if (staleRun) {
            const drained = await drainActiveRun(stopDrainTimeoutMs);
            if (!drained && activeRun === staleRun) {
                activeRun = null;
                activeRunController = null;
                activeRunJobId = null;
            }
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

    async function updateTemplateMetadata(templateId, patch) {
        assertAvailable();
        return registry.updateTemplateMetadata(templateId, patch);
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
        updateTemplateMetadata,
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
    DEFAULT_PROMPT_SETTLEMENT_WINDOW_MS,
};
