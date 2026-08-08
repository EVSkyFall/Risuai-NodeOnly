import { describe, expect, it, vi } from 'vitest'
import { zipSync } from 'fflate'

vi.mock('../globalApi.svelte', () => ({
    AppendableBuffer: class {},
    saveAsset: vi.fn(),
}))
vi.mock('../util', () => ({
    asBuffer: (value: Uint8Array) => Buffer.from(value),
    blobToUint8Array: vi.fn(),
    Semaphore: class {},
    sleep: vi.fn(),
}))
vi.mock('../characterCards', () => ({ hubURL: '' }))
vi.mock('../parser/parser.svelte', () => ({ hasher: vi.fn() }))
vi.mock('../alert', () => ({ alertStore: { set: vi.fn() } }))

import { PngChunk } from '../pngChunk'
import { processZipWithMetadata } from './processzip'

const ONE_PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64',
)

describe('processZipWithMetadata', () => {
    it('recovers a MAX_SAFE_INTEGER seed from NovelAI PNG Comment metadata', async () => {
        const png = await PngChunk.write(ONE_PIXEL_PNG, {
            Comment: JSON.stringify({ seed: 9007199254740991, steps: 28 }),
        })
        if (!(png instanceof Uint8Array)) throw new Error('expected PNG bytes')
        const zipped = zipSync({ 'image.png': png })

        const result = await processZipWithMetadata(zipped)

        expect(result.dataUrl).toMatch(/^data:image\/png;base64,/)
        expect(result.seedUsed).toBe(9007199254740991)
    })

    it('rejects an unsafe integer from NovelAI PNG Comment metadata', async () => {
        const png = await PngChunk.write(ONE_PIXEL_PNG, {
            Comment: JSON.stringify({ seed: 9007199254740992, steps: 28 }),
        })
        if (!(png instanceof Uint8Array)) throw new Error('expected PNG bytes')
        const zipped = zipSync({ 'image.png': png })

        const result = await processZipWithMetadata(zipped)

        expect(result.seedUsed).toBeNull()
    })
})
