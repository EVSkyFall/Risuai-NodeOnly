export type ImageType = 'JPEG' | 'PNG' | 'GIF' | 'BMP' | 'AVIF' | 'WEBP' | 'Unknown'

export function getImageType(arr: Uint8Array): ImageType {
    switch (true) {
        case arr[0] === 0xff && arr[1] === 0xd8 && arr[arr.length - 2] === 0xff && arr[arr.length - 1] === 0xd9:
            return 'JPEG'
        case arr[0] === 0x89 &&
            arr[1] === 0x50 &&
            arr[2] === 0x4e &&
            arr[3] === 0x47 &&
            arr[4] === 0x0d &&
            arr[5] === 0x0a &&
            arr[6] === 0x1a &&
            arr[7] === 0x0a:
            return 'PNG'
        case arr[0] === 0x47 &&
            arr[1] === 0x49 &&
            arr[2] === 0x46 &&
            arr[3] === 0x38 &&
            (arr[4] === 0x37 || arr[4] === 0x39) &&
            arr[5] === 0x61:
            return 'GIF'
        case arr[0] === 0x42 && arr[1] === 0x4d:
            return 'BMP'
        case arr[4] === 0x66 &&
            arr[5] === 0x74 &&
            arr[6] === 0x79 &&
            arr[7] === 0x70 &&
            arr[8] === 0x61 &&
            arr[9] === 0x76 &&
            arr[10] === 0x69 &&
            // 'avif' for a still picture, 'avis' for an image sequence
            (arr[11] === 0x66 || arr[11] === 0x73):
            return 'AVIF'
        case arr[0] === 0x52 &&
            arr[1] === 0x49 &&
            arr[2] === 0x46 &&
            arr[3] === 0x46 &&
            arr[8] === 0x57 &&
            arr[9] === 0x45 &&
            arr[10] === 0x42 &&
            arr[11] === 0x50:
            return 'WEBP'
    }

    return 'Unknown'
}

const IMAGE_FORMATS: Record<Exclude<ImageType, 'Unknown'>, { mime: string, exts: string[] }> = {
    JPEG: { mime: 'image/jpeg', exts: ['jpg', 'jpeg'] },
    PNG: { mime: 'image/png', exts: ['png'] },
    GIF: { mime: 'image/gif', exts: ['gif'] },
    BMP: { mime: 'image/bmp', exts: ['bmp'] },
    AVIF: { mime: 'image/avif', exts: ['avif'] },
    WEBP: { mime: 'image/webp', exts: ['webp'] },
}
const IMAGE_EXTS = new Set(Object.values(IMAGE_FORMATS).flatMap((format) => format.exts))

// A stored image keeps its name when its bytes change format (server-side
// transcoding, lossy compression), so a label has to come from the bytes.
export function getImageMime(arr: Uint8Array, fallback = 'image/png'): string {
    const type = getImageType(arr)
    return type === 'Unknown' ? fallback : IMAGE_FORMATS[type].mime
}

// The extension a file holding these bytes should carry. `recorded` is kept when it
// already names the bytes' format, when the bytes are not a known image, or when it
// is not an image extension at all.
export function getImageExt(arr: Uint8Array, recorded: string): string {
    const type = getImageType(arr)
    if (type === 'Unknown') return recorded
    const lower = recorded.toLowerCase()
    if (!IMAGE_EXTS.has(lower) || IMAGE_FORMATS[type].exts.includes(lower)) return recorded
    return IMAGE_FORMATS[type].exts[0]
}
