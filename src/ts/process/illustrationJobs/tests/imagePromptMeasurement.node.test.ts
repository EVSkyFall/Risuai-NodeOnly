// @vitest-environment node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test, vi } from 'vitest'
import { computeNaiSettingsFingerprint } from '../settingsFingerprint'

vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => ({}) }))

test('loads the shipped t5-base SentencePiece model and pins real token counts', async () => {
    const {
        createImagePromptMeasurementService,
        createImagePromptTokenizerLoader,
    } = await import('../imagePromptMeasurement')
    const bytes = await readFile(resolve(process.cwd(), 'public/token/t5/spiece.model'))
    const model = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    const loader = createImagePromptTokenizerLoader({ loadModel: async () => model })
    const tokenizer = await loader.load()

    expect(tokenizer.encode('hello world').length).toBe(2)
    expect([
        tokenizer.encode('masterpiece, best quality').length,
        tokenizer.encode('source#1 Alice').length,
        tokenizer.encode('target#2 Bob').length,
    ]).toEqual([4, 4, 4])

    const db = {
        sdProvider: 'novelai',
        NAIImgUrl: 'https://image.novelai.net/ai/generate-image',
        NAIImgModel: 'nai-diffusion-4-5-full',
        NAII2I: false,
        NAIImgConfig: {},
    } as any
    const service = createImagePromptMeasurementService({
        getDatabase: () => db,
        tokenizerLoader: loader,
    })
    const measurement = await service.measure({
        protocolVersion: 1,
        settingsFingerprint: await computeNaiSettingsFingerprint(db),
        prompt: {
            schemaVersion: 1,
            layout: 'nai-v4-characters',
            basePositive: 'masterpiece, best quality',
            characterPositives: ['source#1 Alice', 'target#2 Bob'],
            baseNegative: '',
            characterNegatives: ['', ''],
        },
    })
    expect(measurement.positiveTokens).toBe(12)
    expect(measurement.negativeTokens).toBe(0)
})
