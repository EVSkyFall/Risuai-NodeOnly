// PNG building blocks shared by the media transcode tests.
import Vips from 'wasm-vips'

const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

export type Chunk = { type: string, data: Buffer }

export function chunk(type: string, data: Buffer) {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 'latin1')
    data.copy(out, 8)
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
    return out
}

export function chunksOf(png: Buffer) {
    const list: Chunk[] = []
    for (let o = 8; o + 12 <= png.length;) {
        const length = png.readUInt32BE(o)
        list.push({ type: png.toString('latin1', o + 4, o + 8), data: png.subarray(o + 8, o + 8 + length) })
        o += 12 + length
    }
    return list
}

export const build = (list: Chunk[]) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...list.map(c => chunk(c.type, c.data))])

// position 1 is right after IHDR; -1 is right before IEND (after the pixel data).
export function insert(png: Buffer, type: string, data: Buffer, position = 1) {
    const list = chunksOf(png)
    list.splice(position < 0 ? list.length + position : position, 0, { type, data })
    return build(list)
}

export const text = (keyword: string, value: string) => Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')])

let vipsPromise: Promise<any> | null = null
export const getVips = () => (vipsPromise ||= Vips())

// A colourful RGBA picture; `seed` makes different pictures.
export async function picture(width = 640, height = 480, seed = 3) {
    const vips = await getVips()
    const xyz = vips.Image.xyz(width, height)
    const r = xyz.extractBand(0).multiply(seed).add(xyz.extractBand(1)).linear(0.2, 0).cast('uchar')
    const g = xyz.extractBand(1).linear(0.3, 10).cast('uchar')
    const b = xyz.extractBand(0).linear(0.1, 40).cast('uchar')
    const a = xyz.extractBand(0).linear(0, 255).cast('uchar')
    return Buffer.from(r.bandjoin([g, b, a]).writeToBuffer('.png'))
}

// The PNG an illustration plugin stores: a picture with its marker in a text chunk.
export async function markedPicture(seed = 3, keyword = 'AssetMaidActorBindings') {
    return insert(await picture(640, 480, seed), 'tEXt', text(keyword, '{"actors":[]}'))
}

export const isWebp = (bytes: Buffer) => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP'
