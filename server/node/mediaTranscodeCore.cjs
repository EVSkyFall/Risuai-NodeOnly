'use strict';

// Pure checks and the PNG -> WebP encode used by the media transcoder. No I/O here.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Chunks that change how the pixels are shown or timed; libvips does not carry
// them into the WebP, so such a file is left as it is.
const DISPLAY_CHUNKS = ['acTL', 'fcTL', 'fdAT', 'gAMA', 'cHRM', 'iCCP', 'cICP', 'mDCV', 'cLLI', 'sBIT'];
const TEXT_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt']);
// Bumped whenever a check in this file changes, so decisions taken under the old
// checks are taken again.
const CHECKS = 1;

function isPng(bytes) {
    return bytes.length >= 8 && PNG_SIGNATURE.equals(bytes.subarray(0, 8));
}

// reason: why the file is not a plain 8-bit PNG libvips reproduces faithfully, or null.
// keywords: the keyword of every text chunk (never the text itself).
function pngFacts(bytes) {
    const keywords = [];
    if (bytes.length < 33 || !isPng(bytes)) return { reason: 'not a png', keywords };
    const types = new Set();
    let bitDepth = 0;
    let ended = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString('latin1', offset + 4, offset + 8);
        if (offset + 12 + length > bytes.length) return { reason: 'truncated chunk', keywords };
        if (type === 'IHDR') bitDepth = bytes[offset + 16];
        if (TEXT_CHUNKS.has(type)) {
            const data = bytes.subarray(offset + 8, offset + 8 + Math.min(length, 80));
            const end = data.indexOf(0);
            keywords.push(data.toString('latin1', 0, end < 0 ? data.length : end));
        }
        types.add(type);
        if (type === 'IEND') { ended = true; break; }
        offset += 12 + length;
    }
    if (!types.has('IHDR') || !types.has('IDAT') || !ended) return { reason: 'incomplete png', keywords };
    if (bitDepth === 16) return { reason: '16-bit', keywords };
    for (const type of DISPLAY_CHUNKS) if (types.has(type)) return { reason: `has ${type}`, keywords };
    return { reason: null, keywords };
}

function hasMarker(keywords, markers) {
    return keywords.some(keyword => markers.some(marker => typeof marker === 'string' && marker && keyword.startsWith(marker)));
}

// Encodes one PNG and proves the WebP decodes, in full, to nearly the same picture:
// "diff" is the mean error of the whole image, "blockDiff" the worst 16x16 block,
// so a small region that went wrong cannot hide in the average.
// Returns { webp, diff, blockDiff }, or { skip: reason } / { notSmaller: true }.
function encodeChecked(vips, png, { quality = 90, maxDiff = 4, maxBlockDiff = 40 } = {}) {
    const held = [];
    const keep = (image) => { held.push(image); return image; };
    try {
        const source = keep(keep(vips.Image.newFromBuffer(png, '', { fail_on: 'warning' })).copyMemory());
        const webp = Buffer.from(source.writeToBuffer('.webp', { Q: quality, smart_subsample: true }));
        const decoded = keep(keep(vips.Image.newFromBuffer(webp, '', { fail_on: 'warning' })).copyMemory());
        if (decoded.width !== source.width || decoded.height !== source.height) return { skip: 'webp decoded to another size' };
        let a = source, b = decoded;
        if (source.hasAlpha() && decoded.hasAlpha() && source.bands === decoded.bands) {
            // Premultiplied, so colour under transparent pixels (which WebP may drop) does not count.
            a = keep(source.premultiply());
            b = keep(decoded.premultiply());
        } else if (source.hasAlpha() && decoded.bands === source.bands - 1) {
            // The encoder drops an alpha channel that is opaque everywhere, and only then.
            if (keep(source.extractBand(source.bands - 1)).min() !== 255) return { skip: 'webp lost a non-opaque alpha channel' };
            a = keep(source.extractBand(0, { n: source.bands - 1 }));
        } else if (source.bands !== decoded.bands) {
            return { skip: 'webp decoded to another shape' };
        }
        const error = keep(keep(a.subtract(b)).abs());
        const diff = error.avg();
        // ceil: blocks at the right and bottom edges count too, whatever the image size.
        const blockDiff = keep(error.shrink(16, 16, { ceil: true })).max();
        if (!(diff <= maxDiff)) return { skip: `webp differs from the png (mean ${Number(diff).toFixed(2)})` };
        if (!(blockDiff <= maxBlockDiff)) return { skip: `webp differs from the png in one area (block ${Number(blockDiff).toFixed(1)})` };
        if (webp.length >= png.length) return { notSmaller: true };
        return { webp, diff, blockDiff };
    } finally {
        for (const image of held) { try { image.delete(); } catch {} }
    }
}

module.exports = { CHECKS, isPng, pngFacts, hasMarker, encodeChecked };
