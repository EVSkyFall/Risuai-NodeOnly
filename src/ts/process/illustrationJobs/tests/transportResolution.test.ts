import { describe, expect, test, vi } from 'vitest'
import { IllustrationLedgerValidationError } from '../errors'
import {
    parseTransportConfig,
    resolvePromptTargetV2,
    targetFingerprintMatchesCurrentDb,
    type IllustrationTransportConfigV1,
    type IllustrationTransportElection,
    type PromptTargetDatabase,
} from '../promptContextV2'

// The pure target/config logic never reads the live DB module.
vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => ({}) }))

function db(overrides: Partial<Record<string, unknown>> = {}): PromptTargetDatabase {
    return {
        sdProvider: 'novelai',
        NAIImgUrl: 'https://image.novelai.net/ai/generate-image',
        NAIImgModel: 'nai-diffusion-4-5-full',
        webUiUrl: 'http://127.0.0.1:7860/',
        comfyUiUrl: 'http://localhost:8188',
        comfyConfig: {
            workflow: '{}',
            posNodeID: '6',
            posInputName: 'text',
            negNodeID: '7',
            negInputName: 'text',
            timeout: 30,
        },
        ...overrides,
    } as PromptTargetDatabase
}

function config(election: IllustrationTransportElection): IllustrationTransportConfigV1 {
    return { schemaVersion: 1, election }
}

const transportOnly = {
    mode: 'transport_only' as const,
    unit: 'utf8_byte' as const,
    positive: 1000,
    negative: 500,
    combined: null,
    allowTransportOnly: true as const,
}

describe('non-native transports resolve ONLY from an explicit election (request §2/§7)', () => {
    test('webui provider with NO election still fails closed (never inferred)', async () => {
        await expect(resolvePromptTargetV2(db({ sdProvider: 'webui' }), null))
            .rejects.toMatchObject({ code: 'prompt_target_unavailable', transportId: 'webui-flat' })
    })

    test('webui-flat resolves request-pinned checkpoint from an explicit election', async () => {
        const target = await resolvePromptTargetV2(db({ sdProvider: 'webui' }), config({
            transportId: 'webui-flat',
            binding: { mode: 'request-pinned', checkpoint: 'sdxl_illustrious.safetensors' },
            measurement: transportOnly,
            maxConcurrency: 2,
            priorityPolicy: 'interactive-first',
        }))
        expect(target).toMatchObject({
            transportId: 'webui-flat',
            providerId: 'webui',
            bindingMode: 'request-pinned',
            acceptedLayouts: ['flat'],
            negativeChannel: 'separate',
        })
        expect(target.checkpointFingerprint).toMatch(/^[0-9a-f]{64}$/)
        expect(target.measurement).toMatchObject({ mode: 'transport_only', tokenizerId: null, dispatchPolicy: 'allow-transport-only' })
        expect(target.queue).toMatchObject({ maxConcurrency: 2, priorityPolicy: 'interactive-first' })
    })

    test('an election that names webui while the provider is comfy fails closed (compat check)', async () => {
        await expect(resolvePromptTargetV2(db({ sdProvider: 'comfyui' }), config({
            transportId: 'webui-flat',
            binding: { mode: 'request-pinned', checkpoint: 'x' },
            measurement: transportOnly,
            maxConcurrency: 1,
            priorityPolicy: 'fifo',
        }))).rejects.toMatchObject({ code: 'prompt_target_unavailable', transportId: 'webui-flat' })
    })

    test('comfyui-flat resolves a workflow-pinned target with node bindings', async () => {
        const target = await resolvePromptTargetV2(db({ sdProvider: 'comfyui' }), config({
            transportId: 'comfyui-flat',
            workflowFingerprint: 'wf-abc',
            positiveNode: { nodeId: '6', inputName: 'text' },
            negativeNode: { nodeId: '7', inputName: 'text' },
            modelBindingRevision: 'ckpt-rev-1',
            measurement: { mode: 'unmeasured', allowUnmeasured: true },
            maxConcurrency: 1,
            priorityPolicy: 'fifo',
        }))
        expect(target).toMatchObject({
            transportId: 'comfyui-flat',
            bindingMode: 'workflow-pinned',
            workflowFingerprint: 'wf-abc',
            bindingRevision: 'ckpt-rev-1',
        })
        expect(target.measurement.mode).toBe('unmeasured')
    })

    test('nai-compatible-flat is elected explicitly on the novelai provider, NOT inferred from URL', async () => {
        const target = await resolvePromptTargetV2(db(), config({
            transportId: 'nai-compatible-flat',
            layout: 'pipe-slots',
            pipe: { revision: 'pipe-1', maxSubjects: 6, negative: 'base-then-subjects' },
            measurement: transportOnly,
            maxConcurrency: 1,
            priorityPolicy: 'interactive-first',
        }))
        expect(target).toMatchObject({
            transportId: 'nai-compatible-flat',
            providerId: 'novelai',
            bindingMode: 'opaque-remote',
            acceptedLayouts: ['pipe-slots'],
        })
        // NAI T5 is NEVER auto-applied on nai-compatible-flat (request §2/§7.2).
        expect(target.measurement.mode).not.toBe('model_exact')
        expect(target.measurement.tokenizerId).toBeNull()
        expect(target.subjectSlots.pipeSerialization).toMatchObject({
            separator: ' | ',
            positive: 'base-then-subjects',
            negative: 'base-then-subjects',
        })
    })
})

describe('fingerprint identity + drift (request §4/§6/§10-6/§10-20)', () => {
    const webuiElection: IllustrationTransportElection = {
        transportId: 'webui-flat',
        binding: { mode: 'request-pinned', checkpoint: 'ckptA' },
        measurement: transportOnly,
        maxConcurrency: 2,
        priorityPolicy: 'interactive-first',
    }

    test('queue max/priority tuning ALONE never changes the target fingerprint (§20)', async () => {
        const base = await resolvePromptTargetV2(db({ sdProvider: 'webui' }), config(webuiElection))
        const tuned = await resolvePromptTargetV2(db({ sdProvider: 'webui' }), config({
            ...webuiElection,
            maxConcurrency: 8,
            priorityPolicy: 'fifo',
        }))
        expect(tuned.targetFingerprint).toBe(base.targetFingerprint)
        expect(tuned.queue.maxConcurrency).toBe(8)
        // ...and matchesCurrentDb still holds despite the tuning change.
        expect(await targetFingerprintMatchesCurrentDb(
            db({ sdProvider: 'webui' }),
            base.targetFingerprint,
            config({ ...webuiElection, maxConcurrency: 8, priorityPolicy: 'fifo' }),
        )).toBe(true)
    })

    test('a checkpoint change makes the captured fingerprint no longer match (§7)', async () => {
        const base = await resolvePromptTargetV2(db({ sdProvider: 'webui' }), config(webuiElection))
        const drifted = config({ ...webuiElection, binding: { mode: 'request-pinned', checkpoint: 'ckptB' } })
        expect(await targetFingerprintMatchesCurrentDb(db({ sdProvider: 'webui' }), base.targetFingerprint, drifted))
            .toBe(false)
    })

    test('an endpoint change makes the captured fingerprint no longer match (§6)', async () => {
        const base = await resolvePromptTargetV2(db({ sdProvider: 'webui' }), config(webuiElection))
        expect(await targetFingerprintMatchesCurrentDb(
            db({ sdProvider: 'webui', webUiUrl: 'http://127.0.0.1:9999/' }),
            base.targetFingerprint,
            config(webuiElection),
        )).toBe(false)
    })

    test('dropping the election entirely is a definite mismatch, never a silent pass', async () => {
        const base = await resolvePromptTargetV2(db({ sdProvider: 'webui' }), config(webuiElection))
        expect(await targetFingerprintMatchesCurrentDb(db({ sdProvider: 'webui' }), base.targetFingerprint, null))
            .toBe(false)
    })
})

describe('transport config validation is strict + credential-free (request §D5)', () => {
    test('transport_only requires an explicit allowTransportOnly opt-in', () => {
        expect(() => parseTransportConfig(config({
            transportId: 'webui-flat',
            binding: { mode: 'request-pinned', checkpoint: 'x' },
            // @ts-expect-error deliberately omit the opt-in
            measurement: { mode: 'transport_only', unit: 'utf8_byte', positive: 1, negative: 1, combined: null },
            maxConcurrency: 1,
            priorityPolicy: 'fifo',
        }))).toThrowError(IllustrationLedgerValidationError)
    })

    test('unmeasured requires an explicit allowUnmeasured opt-in (no auto opt-in)', () => {
        expect(() => parseTransportConfig(config({
            transportId: 'webui-flat',
            binding: { mode: 'request-pinned', checkpoint: 'x' },
            // @ts-expect-error deliberately omit the opt-in
            measurement: { mode: 'unmeasured' },
            maxConcurrency: 1,
            priorityPolicy: 'fifo',
        }))).toThrowError(IllustrationLedgerValidationError)
    })

    test('a webui-flat election with an unprovable binding mode is rejected (§7.3 label != proof)', () => {
        // A plain user label is not a valid binding proof; build it as opaque input
        // so the runtime validator (not the type-checker) is what rejects it.
        const malformed: unknown = {
            transportId: 'webui-flat',
            binding: { mode: 'user-label', checkpoint: 'My Model' },
            measurement: transportOnly,
            maxConcurrency: 1,
            priorityPolicy: 'fifo',
        }
        expect(() => parseTransportConfig({ schemaVersion: 1, election: malformed }))
            .toThrowError(IllustrationLedgerValidationError)
    })

    test('pipe-slots requires a pipe descriptor; flat must not carry one', () => {
        expect(() => parseTransportConfig(config({
            transportId: 'nai-compatible-flat',
            layout: 'pipe-slots',
            measurement: transportOnly,
            maxConcurrency: 1,
            priorityPolicy: 'fifo',
        }))).toThrowError(IllustrationLedgerValidationError)
        expect(() => parseTransportConfig(config({
            transportId: 'nai-compatible-flat',
            layout: 'flat',
            pipe: { revision: '1', maxSubjects: 2, negative: 'base-only' },
            measurement: transportOnly,
            maxConcurrency: 1,
            priorityPolicy: 'fifo',
        }))).toThrowError(IllustrationLedgerValidationError)
    })

    test('an empty election round-trips and a null election means "no election"', () => {
        expect(parseTransportConfig({ schemaVersion: 1, election: null }))
            .toEqual({ schemaVersion: 1, election: null })
        expect(parseTransportConfig({ schemaVersion: 1 }))
            .toEqual({ schemaVersion: 1, election: null })
    })
})

describe('concurrencyKey is credential-free (Sol #7 / request §D5)', () => {
    const secretEndpoint = 'https://user:SUPERSECRET@wellspring.example/ai/generate-image?token=TOPSECRET'
    const naiFlat: IllustrationTransportElection = {
        transportId: 'nai-compatible-flat',
        layout: 'flat',
        measurement: transportOnly,
        maxConcurrency: 2,
        priorityPolicy: 'interactive-first',
    }

    test('a wellspring endpoint with userinfo/query secrets never reaches the durable/projected concurrencyKey', async () => {
        const target = await resolvePromptTargetV2(
            db({ sdProvider: 'novelai', NAIImgUrl: secretEndpoint }),
            config(naiFlat),
        )
        // The public target (durable promptContext AND the sandbox-Plugin projection)
        // carries the concurrencyKey verbatim, so it must be credential-free.
        expect(target.queue.concurrencyKey).not.toContain('SUPERSECRET')
        expect(target.queue.concurrencyKey).not.toContain('TOPSECRET')
        expect(target.queue.concurrencyKey).toMatch(/^nai-compatible-flat:[0-9a-f]{64}$/)
    })

    test('two configs on the SAME endpoint still share a concurrencyKey (same backend => same queue)', async () => {
        const flat = await resolvePromptTargetV2(
            db({ sdProvider: 'novelai', NAIImgUrl: secretEndpoint }),
            config(naiFlat),
        )
        const pipe = await resolvePromptTargetV2(
            db({ sdProvider: 'novelai', NAIImgUrl: secretEndpoint }),
            config({
                ...naiFlat,
                layout: 'pipe-slots',
                pipe: { revision: 'pipe-1', maxSubjects: 6, negative: 'base-then-subjects' },
                maxConcurrency: 8,
                priorityPolicy: 'fifo',
            }),
        )
        expect(pipe.queue.concurrencyKey).toBe(flat.queue.concurrencyKey)
    })
})
