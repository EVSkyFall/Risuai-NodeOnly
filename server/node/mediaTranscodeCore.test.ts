import { beforeAll, describe, expect, it } from 'vitest'
import path from 'node:path'
import zlib from 'node:zlib'
import { Worker } from 'node:worker_threads'
import { once } from 'node:events'
import Vips from 'wasm-vips'
import core from './mediaTranscodeCore.cjs'

const { pngFacts, hasMarker, encodeChecked, isPng } = core

const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type: string, data: Buffer) {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 'latin1')
    data.copy(out, 8)
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
    return out
}
function chunksOf(png: Buffer) {
    const list: Array<{ type: string, data: Buffer }> = []
    for (let o = 8; o + 12 <= png.length;) {
        const length = png.readUInt32BE(o)
        list.push({ type: png.toString('latin1', o + 4, o + 8), data: png.subarray(o + 8, o + 8 + length) })
        o += 12 + length
    }
    return list
}
const build = (list: Array<{ type: string, data: Buffer }>) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...list.map(c => chunk(c.type, c.data))])
// position 1 is right after IHDR; -1 is right before IEND (after the pixel data).
function insert(png: Buffer, type: string, data: Buffer, position = 1) {
    const list = chunksOf(png)
    list.splice(position < 0 ? list.length + position : position, 0, { type, data })
    return build(list)
}
const text = (keyword: string, value: string) => Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')])

let vips: any
let base: Buffer
let edge: Buffer
beforeAll(async () => {
    vips = await Vips()
    const xyz = vips.Image.xyz(640, 480)
    const r = xyz.extractBand(0).multiply(3).add(xyz.extractBand(1)).linear(0.2, 0).cast('uchar')
    const g = xyz.extractBand(1).linear(0.3, 10).cast('uchar')
    const b = xyz.extractBand(0).linear(0.1, 40).cast('uchar')
    const a = xyz.extractBand(0).linear(0, 255).cast('uchar')
    base = Buffer.from(r.bandjoin([g, b, a]).writeToBuffer('.png'))
    // 1015 px wide (not a multiple of 16): a 7 px strip of 1 px red/blue stripes at the right
    // edge, which lossy chroma handling ruins while the mean over the image stays small.
    const w = 1015, h = 256, raw = Buffer.alloc(w * h * 3, 255)
    for (let y = 0; y < h; y++) for (let x = w - 7; x < w; x++) {
        const o = (y * w + x) * 3, red = (x + y) % 2 === 0
        raw[o] = red ? 255 : 0; raw[o + 1] = 0; raw[o + 2] = red ? 0 : 255
    }
    edge = Buffer.from(vips.Image.newFromMemory(raw, w, h, 3, 'uchar').writeToBuffer('.png'))
})

describe('pngFacts', () => {
    it('accepts a plain PNG and reports no keywords', () => {
        expect(isPng(base)).toBe(true)
        expect(pngFacts(base)).toEqual({ reason: null, keywords: [] })
    })

    it('reads the keyword of tEXt, zTXt and iTXt chunks wherever they sit', () => {
        let png = insert(base, 'tEXt', text('AssetMaidActorBindings', '{"secret":1}'))
        png = insert(png, 'zTXt', Buffer.concat([Buffer.from('Comment\0\0', 'latin1'), zlib.deflateSync(Buffer.from('hidden'))]))
        png = insert(png, 'iTXt', text('AssetMaid', '\0\0\0\0value'), -1)
        const facts = pngFacts(png)
        expect(facts.reason).toBeNull()
        // Each insert at position 1 lands in front of the previous one; -1 lands after the pixel data.
        expect(facts.keywords).toEqual(['Comment', 'AssetMaidActorBindings', 'AssetMaid'])
        expect(hasMarker(facts.keywords, ['AssetMaid'])).toBe(true)
        expect(hasMarker(['Comment', 'parameters'], ['AssetMaid'])).toBe(false)
        expect(hasMarker(['AssetMaid'], [])).toBe(false)
        expect(hasMarker(['AssetMaid'], [''])).toBe(false)
    })

    it('names why a file is not a plain PNG', () => {
        expect(pngFacts(Buffer.from('not a png')).reason).toBe('not a png')
        expect(pngFacts(base.subarray(0, base.length - 20)).reason).toBe('truncated chunk')
        expect(pngFacts(build(chunksOf(base).filter(c => c.type !== 'IEND'))).reason).toBe('incomplete png')
        expect(pngFacts(insert(base, 'acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]))).reason).toBe('has acTL')
        expect(pngFacts(insert(base, 'gAMA', Buffer.from([0, 1, 0x86, 0xa0]))).reason).toBe('has gAMA')
        const deep = chunksOf(base).map(c => c.type === 'IHDR' ? { type: 'IHDR', data: Buffer.from(c.data).fill(16, 8, 9) } : c)
        expect(pngFacts(build(deep)).reason).toBe('16-bit')
    })
})

describe('encodeChecked', () => {
    it('returns a smaller WebP that decodes to nearly the same picture', () => {
        const result = encodeChecked(vips, base, { quality: 90, maxDiff: 4, maxBlockDiff: 40 })
        expect(result.skip).toBeUndefined()
        expect(result.webp.length).toBeLessThan(base.length)
        expect(result.webp.subarray(8, 12).toString('latin1')).toBe('WEBP')
        expect(result.diff).toBeLessThanOrEqual(4)
        expect(result.blockDiff).toBeLessThanOrEqual(40)
    })

    it('rejects a picture whose small region the encoder ruins', () => {
        expect(encodeChecked(vips, edge, { quality: 90, maxDiff: 4, maxBlockDiff: 40 }).skip).toMatch(/one area/)
    })

    it('rejects on the mean when the limit is tighter than the loss', () => {
        expect(encodeChecked(vips, base, { quality: 1, maxDiff: 0, maxBlockDiff: 255 }).skip).toMatch(/mean/)
    })

    it('says when the WebP is not smaller', () => {
        // A hand-made 1x1 RGB PNG (69 bytes): no WebP container is that small.
        const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])
        const tiny = build([
            { type: 'IHDR', data: header },
            { type: 'IDAT', data: zlib.deflateSync(Buffer.from([0, 10, 200, 30])) },
            { type: 'IEND', data: Buffer.alloc(0) },
        ])
        expect(pngFacts(tiny).reason).toBeNull()
        expect(encodeChecked(vips, tiny, {})).toEqual({ notSmaller: true })
    })
})

describe('media transcode worker', () => {
    it('encodes in a thread and classifies an undecodable image as a skip', async () => {
        const worker = new Worker(path.join(__dirname, 'mediaTranscodeWorker.cjs'))
        try {
            worker.postMessage({ bytes: new Uint8Array(base), options: { quality: 90, maxDiff: 4, maxBlockDiff: 40 } })
            const [good] = await once(worker, 'message')
            expect(good.error).toBeUndefined()
            expect(Buffer.from(good.webp).subarray(8, 12).toString('latin1')).toBe('WEBP')
            expect(good.webp.byteLength).toBeLessThan(base.length)

            // Valid framing and CRCs, but the pixel stream is cut short.
            const damaged = build(chunksOf(base).map(c => c.type === 'IDAT' ? { type: 'IDAT', data: zlib.deflateSync(Buffer.alloc(64)) } : c))
            worker.postMessage({ bytes: new Uint8Array(damaged), options: {} })
            const [bad] = await once(worker, 'message')
            expect(bad.skip).toMatch(/could not be encoded/)
        } finally {
            await worker.terminate()
        }
    })
})
