import { describe, expect, it, vi } from 'vitest'

// Every test injects its own dependencies; these mocks only keep the heavy
// browser/provider modules out of the import graph. No provider is ever
// reached, so no test here can spend money.
vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => ({}),
    getCurrentCharacter: () => ({ chaId: 'test-char' }),
}))
vi.mock('../../stableDiff', () => ({
    generateAIImageTyped: async () => {
        throw new Error('the default provider path must never run in tests')
    },
}))
vi.mock('../../files/inlays', () => ({
    writeInlayImage: async () => {
        throw new Error('the default inlay path must never run in tests')
    },
    removeInlayAsset: async () => {
        throw new Error('the default inlay path must never run in tests')
    },
}))
vi.mock('../../illustrationJobs/imagePromptMeasurement', () => ({
    measureImagePrompt: async () => {
        throw new Error('the default measurement path must never run in tests')
    },
}))
vi.mock('../../illustrationJobs/settingsFingerprint', () => ({
    canonicalizeNaiSettings: () => ({}),
    computeCanonicalNaiSettingsFingerprint: async () => 'nai-fingerprint',
}))

const { createPluginImagesApi } = await import('../pluginImages')
type PluginImagesDependencies = import('../pluginImages').PluginImagesDependencies

const FLAT_PROMPT = {
    layout: 'flat' as const,
    positive: '1girl, silver hair, standing by the window',
    negative: 'lowres',
}

const NAI_SETTINGS = {
    sdProvider: 'novelai',
    NAIImgModel: 'nai-diffusion-4-5-full',
    NAIImgConfig: { width: 1024, height: 1024 },
    NAIImgUrl: 'https://image.novelai.net/ai/generate-image',
}

function makeDeps(overrides: Partial<PluginImagesDependencies> = {}): PluginImagesDependencies & {
    generated: any[]
    written: any[]
    removed: string[]
} {
    const generated: any[] = []
    const written: any[] = []
    const removed: string[] = []
    const deps: any = {
        generated,
        written,
        removed,
        getDatabase: () => ({ ...NAI_SETTINGS }),
        getCurrentCharacter: () => ({ chaId: 'char-1' }) as any,
        async generateImage(positive: string, _char: any, negative: string, prompt: any) {
            generated.push({ positive, negative, prompt })
            return {
                result: { ok: true, bytesOrDataUrl: 'data:image/png;base64,AAAA', providerStatus: 200 },
                compatibilityValue: 'data:image/png;base64,AAAA',
            }
        },
        async measure() {
            return {
                positiveTokens: 40,
                negativeTokens: 5,
                maxPositiveTokens: 512,
                maxNegativeTokens: 512,
                model: 'nai-diffusion-4-5-full',
                tokenizer: 't5-spiece-v1',
            }
        },
        async writeInlay(dataUrl: string, assetId: string) {
            written.push({ dataUrl, assetId })
            return assetId
        },
        async removeInlay(assetId: string) {
            removed.push(assetId)
        },
        ...overrides,
    }
    return deps
}

function generateInput(overrides: Record<string, any> = {}) {
    return {
        operationKey: 'op-1',
        prompt: FLAT_PROMPT,
        output: { kind: 'inlay' as const, assetId: 'ri-asset-1' },
        ...overrides,
    }
}

describe('measurePrompt', () => {
    it('reports an exact measurement with the configuration it was taken against', async () => {
        const api = createPluginImagesApi(makeDeps())
        const measurement = await api.measurePrompt({ prompt: FLAT_PROMPT })

        expect(measurement.exact).toBe(true)
        expect(measurement.units).toBe(40)
        expect(measurement.limit).toBe(512)
        expect(measurement.withinLimits).toBe(true)
        expect(measurement.accepted).toBe(true)
        expect(measurement.provider).toBe('novelai')
        expect(measurement.model).toBe('nai-diffusion-4-5-full')
        expect(measurement.configRevision).toMatch(/^[0-9a-f]{64}$/)
    })

    it('rejects a prompt over the model budget instead of letting it dispatch', async () => {
        const api = createPluginImagesApi(makeDeps({
            measure: async () => ({
                positiveTokens: 900,
                negativeTokens: 5,
                maxPositiveTokens: 512,
                maxNegativeTokens: 512,
                model: 'nai-diffusion-4-5-full',
                tokenizer: 't5-spiece-v1',
            }),
        }))
        const measurement = await api.measurePrompt({ prompt: FLAT_PROMPT })

        expect(measurement.withinLimits).toBe(false)
        expect(measurement.accepted).toBe(false)
        expect(measurement.units).toBe(900)
        expect(measurement.limit).toBe(512)
    })

    it('never invents a budget for a provider with no exact tokenizer', async () => {
        const api = createPluginImagesApi(makeDeps({
            getDatabase: () => ({ sdProvider: 'webui', webUiUrl: 'http://127.0.0.1:7860' }),
            measure: async () => {
                throw new Error('Exact image prompt measurement is supported only for NovelAI V4 models')
            },
        }))
        const measurement = await api.measurePrompt({ prompt: FLAT_PROMPT })

        expect(measurement.exact).toBe(false)
        expect(measurement.units).toBeNull()
        expect(measurement.limit).toBeNull()
        // A limit that cannot be computed must not become a limit of zero, or
        // every prompt on this provider would be rejected as over budget.
        expect(measurement.withinLimits).toBe(true)
        expect(measurement.accepted).toBe(true)
        expect(measurement.reason).toMatch(/NovelAI V4/)
        expect(measurement.configRevision).toMatch(/^[0-9a-f]{64}$/)
    })

    it('changes the config revision when image settings change and not otherwise', async () => {
        let db: Record<string, any> = { ...NAI_SETTINGS }
        const api = createPluginImagesApi(makeDeps({ getDatabase: () => ({ ...db }) }))

        const first = await api.measurePrompt({ prompt: FLAT_PROMPT })
        const unchanged = await api.measurePrompt({ prompt: FLAT_PROMPT })
        expect(unchanged.configRevision).toBe(first.configRevision)

        // Key insertion order must not matter.
        db = { NAIImgUrl: NAI_SETTINGS.NAIImgUrl, NAIImgConfig: { height: 1024, width: 1024 }, NAIImgModel: NAI_SETTINGS.NAIImgModel, sdProvider: 'novelai' }
        expect((await api.measurePrompt({ prompt: FLAT_PROMPT })).configRevision).toBe(first.configRevision)

        db = { ...NAI_SETTINGS, NAIImgConfig: { width: 832, height: 1216 } }
        expect((await api.measurePrompt({ prompt: FLAT_PROMPT })).configRevision).not.toBe(first.configRevision)
    })

    it('ignores credential changes so key rotation cannot strand a measurement', async () => {
        let db: Record<string, any> = { ...NAI_SETTINGS, NAIApiKey: 'key-one' }
        const api = createPluginImagesApi(makeDeps({ getDatabase: () => ({ ...db }) }))
        const before = await api.measurePrompt({ prompt: FLAT_PROMPT })

        db = { ...NAI_SETTINGS, NAIApiKey: 'key-two' }
        expect((await api.measurePrompt({ prompt: FLAT_PROMPT })).configRevision).toBe(before.configRevision)
    })
})

describe('generateToInlay', () => {
    it('runs the configured provider and lands the result on the caller-supplied asset id', async () => {
        const deps = makeDeps()
        const api = createPluginImagesApi(deps)
        const response = await api.generateToInlay(generateInput())

        expect(response.status).toBe('succeeded')
        if (response.status !== 'succeeded') throw new Error('unreachable')
        expect(response.result.assetId).toBe('ri-asset-1')
        expect(response.result.inlayToken).toBe('{{inlay::ri-asset-1}}')
        expect(response.result.provider).toBe('novelai')
        expect(deps.written).toEqual([{ dataUrl: 'data:image/png;base64,AAAA', assetId: 'ri-asset-1' }])
        expect(deps.generated[0].positive).toBe(FLAT_PROMPT.positive)
        expect(deps.generated[0].negative).toBe(FLAT_PROMPT.negative)
    })

    it('refuses a stale config revision before spending anything', async () => {
        const deps = makeDeps()
        const api = createPluginImagesApi(deps)
        const response = await api.generateToInlay(generateInput({
            expectedConfigRevision: 'a-revision-from-before-the-user-changed-settings',
        }))

        expect(response.status).toBe('precondition_failed')
        expect(deps.generated).toHaveLength(0)
    })

    it('accepts the revision the measurement reported', async () => {
        const deps = makeDeps()
        const api = createPluginImagesApi(deps)
        const measurement = await api.measurePrompt({ prompt: FLAT_PROMPT })
        const response = await api.generateToInlay(generateInput({
            expectedConfigRevision: measurement.configRevision,
        }))

        expect(response.status).toBe('succeeded')
    })

    it('forwards per-character placement instead of dropping it', async () => {
        const deps = makeDeps()
        const api = createPluginImagesApi(deps)
        const response = await api.generateToInlay(generateInput({
            prompt: {
                layout: 'nai-v4-characters',
                positive: 'two figures',
                negative: '',
                characters: [
                    { positive: '1girl, silver hair', negative: '', center: { x: 0.25, y: 0.5 } },
                    { positive: '1girl, dark hair', negative: '', center: { x: 0.75, y: 0.5 } },
                ],
            },
        }))

        expect(response.status).toBe('succeeded')
        expect(deps.generated[0].prompt.characterCenters).toEqual([
            { x: 0.25, y: 0.5 },
            { x: 0.75, y: 0.5 },
        ])
    })

    it('keeps an unplaced character as an explicit null rather than shifting the others', async () => {
        const deps = makeDeps()
        const api = createPluginImagesApi(deps)
        await api.generateToInlay(generateInput({
            prompt: {
                layout: 'nai-v4-characters',
                positive: 'three figures',
                negative: '',
                characters: [
                    { positive: 'a', negative: '', center: { x: 0.2, y: 0.5 } },
                    { positive: 'b', negative: '' },
                    { positive: 'c', negative: '', center: { x: 0.8, y: 0.5 } },
                ],
            },
        }))

        // Centres are matched to captions by index, so a dropped entry would
        // place the wrong subject.
        expect(deps.generated[0].prompt.characterCenters).toEqual([
            { x: 0.2, y: 0.5 },
            null,
            { x: 0.8, y: 0.5 },
        ])
    })

    it('omits the placement field entirely when nobody is placed', async () => {
        const deps = makeDeps()
        const api = createPluginImagesApi(deps)
        await api.generateToInlay(generateInput({
            prompt: {
                layout: 'nai-v4-characters',
                positive: 'two figures',
                negative: '',
                characters: [{ positive: 'a', negative: '' }, { positive: 'b', negative: '' }],
            },
        }))

        // An unplaced request has to stay byte-identical to what it was before
        // regional placement existed.
        expect(Object.hasOwn(deps.generated[0].prompt, 'characterCenters')).toBe(false)
    })

    it('rejects a placement that is out of range or malformed', async () => {
        const deps = makeDeps()
        const api = createPluginImagesApi(deps)
        const cases = [
            { x: 1.5, y: 0.5 },
            { x: -0.1, y: 0.5 },
            { x: 0.5, y: Number.NaN },
            { x: 0.5 },
            { x: 0.5, y: 0.5, z: 0.5 },
        ]
        for (const center of cases) {
            const response = await api.generateToInlay(generateInput({
                prompt: {
                    layout: 'nai-v4-characters',
                    positive: 'two figures',
                    negative: '',
                    characters: [{ positive: 'a', negative: '', center }, { positive: 'b', negative: '' }],
                },
            }))
            expect(response.status).toBe('definite_failure')
        }
        expect(deps.generated).toHaveLength(0)
    })

    it('rejects placement on a flat prompt, where it would do nothing', async () => {
        const deps = makeDeps()
        const api = createPluginImagesApi(deps)
        const response = await api.generateToInlay(generateInput({
            prompt: { ...FLAT_PROMPT, characters: [{ positive: 'a', center: { x: 0.5, y: 0.5 } }] },
        }))

        expect(response.status).toBe('definite_failure')
        expect(deps.generated).toHaveLength(0)
    })

    it('carries character captions through when no placement is requested', async () => {
        const deps = makeDeps()
        const api = createPluginImagesApi(deps)
        const response = await api.generateToInlay(generateInput({
            prompt: {
                layout: 'nai-v4-characters',
                positive: 'two figures',
                negative: 'lowres',
                characters: [
                    { positive: '1girl, silver hair', negative: 'blurry' },
                    { positive: '1girl, dark hair', negative: '' },
                ],
            },
        }))

        expect(response.status).toBe('succeeded')
        expect(deps.generated[0].prompt.characterPositives).toEqual(['1girl, silver hair', '1girl, dark hair'])
        expect(deps.generated[0].prompt.characterNegatives).toEqual(['blurry', ''])
    })

    it('rejects an asset id that would corrupt the inlay token', async () => {
        const deps = makeDeps()
        const api = createPluginImagesApi(deps)
        for (const assetId of ['', 'has{brace}', 'has::colon', 'has\nnewline']) {
            const response = await api.generateToInlay(generateInput({
                output: { kind: 'inlay', assetId },
            }))
            expect(response.status).toBe('definite_failure')
            if (response.status === 'succeeded') throw new Error('unreachable')
            expect(response.code).toBe('image_asset_id_invalid')
        }
        expect(deps.generated).toHaveLength(0)
    })

    it('reports an uncertain provider failure as ambiguous, never as terminal', async () => {
        const api = createPluginImagesApi(makeDeps({
            generateImage: async () => ({
                result: { ok: false, certainty: 'uncertain', reason: 'connection dropped mid-request' },
                compatibilityValue: '',
            }) as any,
        }))
        const response = await api.generateToInlay(generateInput())

        expect(response.status).toBe('ambiguous')
        if (response.status === 'succeeded') throw new Error('unreachable')
        expect(response.code).toBe('image_dispatch_uncertain')
    })

    it('reports a definite provider rejection as terminal', async () => {
        const api = createPluginImagesApi(makeDeps({
            generateImage: async () => ({
                result: { ok: false, certainty: 'definite', reason: 'prompt rejected', providerStatus: 400 },
                compatibilityValue: '',
            }) as any,
        }))
        const response = await api.generateToInlay(generateInput())

        expect(response.status).toBe('definite_failure')
        if (response.status === 'succeeded') throw new Error('unreachable')
        expect(response.error).toBe('prompt rejected')
    })

    it('treats a throw out of the dispatch path as ambiguous', async () => {
        const api = createPluginImagesApi(makeDeps({
            generateImage: async () => { throw new Error('network stack exploded') },
        }))
        const response = await api.generateToInlay(generateInput())

        // The request may or may not have reached the provider, so this must
        // not be reported as "definitely did not run".
        expect(response.status).toBe('ambiguous')
    })

    it('treats a generated-but-unstorable image as ambiguous, not as a clean failure', async () => {
        const deps = makeDeps({
            writeInlay: async () => { throw new Error('quota exceeded') },
        })
        const api = createPluginImagesApi(deps)
        const response = await api.generateToInlay(generateInput())

        // The provider was already paid. Retrying costs again, so the caller
        // decides — this must never look like "nothing happened".
        expect(response.status).toBe('ambiguous')
        if (response.status === 'succeeded') throw new Error('unreachable')
        expect(response.code).toBe('inlay_write_failed')
        expect(deps.generated).toHaveLength(1)
    })

    it('reports an empty provider result as terminal', async () => {
        const api = createPluginImagesApi(makeDeps({
            generateImage: async () => ({
                result: { ok: true, bytesOrDataUrl: '', providerStatus: 200 },
                compatibilityValue: '',
            }) as any,
        }))
        const response = await api.generateToInlay(generateInput())

        expect(response.status).toBe('definite_failure')
        if (response.status === 'succeeded') throw new Error('unreachable')
        expect(response.code).toBe('image_result_empty')
    })

    it('rejects a non-inlay output kind', async () => {
        const api = createPluginImagesApi(makeDeps())
        const response = await api.generateToInlay(generateInput({
            output: { kind: 'asset', assetId: 'ri-asset-1' },
        }) as any)

        expect(response.status).toBe('definite_failure')
        if (response.status === 'succeeded') throw new Error('unreachable')
        expect(response.code).toBe('image_output_unsupported')
    })
})

describe('inlay removal', () => {
    it('removes the asset it was given', async () => {
        const deps = makeDeps()
        const api = createPluginImagesApi(deps)
        expect(await api.remove({ operationKey: 'op-2', assetId: 'ri-asset-1' })).toEqual({ status: 'succeeded' })
        expect(deps.removed).toEqual(['ri-asset-1'])
    })

    it('reports a removal failure as terminal so cleanup can be retried explicitly', async () => {
        const api = createPluginImagesApi(makeDeps({
            removeInlay: async () => { throw new Error('storage offline') },
        }))
        const response = await api.remove({ operationKey: 'op-2', assetId: 'ri-asset-1' })

        expect(response.status).toBe('definite_failure')
        if (response.status === 'succeeded') throw new Error('unreachable')
        expect(response.code).toBe('inlay_remove_failed')
    })
})
