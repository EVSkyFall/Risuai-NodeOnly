'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { comfyError, isComfyError } = require('./errors.cjs');

const DEFAULT_MAX_INPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_SIDECAR_BYTES = 64 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const DEFAULT_TRANSFER_TIMEOUT_MS = 10 * 60 * 1000;
const IMAGE_MIME_BY_EXT = Object.freeze({
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    avif: 'image/avif',
    bmp: 'image/bmp',
});
const OUTPUT_MEDIA_TYPES = Object.freeze({
    'video/mp4': Object.freeze({ extensions: new Set(['mp4']), defaultExt: 'mp4', assetType: 'video' }),
    'video/webm': Object.freeze({ extensions: new Set(['webm']), defaultExt: 'webm', assetType: 'video' }),
    'image/png': Object.freeze({ extensions: new Set(['png']), defaultExt: 'png', assetType: 'image' }),
    'image/jpeg': Object.freeze({ extensions: new Set(['jpg', 'jpeg']), defaultExt: 'jpg', assetType: 'image' }),
    'image/webp': Object.freeze({ extensions: new Set(['webp']), defaultExt: 'webp', assetType: 'image' }),
});
const OUTPUT_EXTENSIONS = Object.freeze(['mp4', 'webm', 'png', 'jpg', 'jpeg', 'webp']);

function isSafeAssetId(id) {
    return typeof id === 'string'
        && id.length > 0
        && !id.includes('\0')
        && !id.includes('/')
        && !id.includes('\\')
        && id !== '.'
        && id !== '..';
}

function normalizeExt(ext) {
    if (typeof ext !== 'string') return '';
    return ext.trim().toLowerCase().replace(/^\.+/, '');
}

function assertContained(root, candidate, code = 'COMFY_INPUT_UNSAFE') {
    const relative = path.relative(root, candidate);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw comfyError(code, 'Asset path escapes its configured directory');
    }
}

async function resolveSafeRoot(directory, code) {
    await fs.promises.mkdir(directory, { recursive: true });
    const stat = await fs.promises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw comfyError(code, 'Asset directory is not a canonical directory');
    }
    return fs.promises.realpath(directory);
}

async function readOpenedFile(root, filePath, maxBytes, errors) {
    assertContained(root, filePath, errors.unsafe);
    const before = await fs.promises.lstat(filePath).catch(() => null);
    if (!before || !before.isFile()) {
        throw comfyError(errors.missing, 'Asset file was not found', { httpStatus: 404 });
    }
    if (before.isSymbolicLink()) {
        throw comfyError(errors.unsafe, 'Symbolic links are not accepted for assets');
    }
    if (before.size > maxBytes) {
        throw comfyError(errors.tooLarge, 'Asset exceeds the configured size limit');
    }
    const real = await fs.promises.realpath(filePath);
    assertContained(root, real, errors.unsafe);

    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    let handle;
    try {
        handle = await fs.promises.open(real, fs.constants.O_RDONLY | noFollow);
    } catch (cause) {
        throw comfyError(errors.unsafe, 'Asset could not be opened safely', { cause });
    }
    try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size > maxBytes) {
            throw comfyError(opened.size > maxBytes ? errors.tooLarge : errors.unsafe, 'Asset changed while opening');
        }
        if (
            before.size !== opened.size
            || (before.dev !== undefined && opened.dev !== undefined && before.dev !== opened.dev)
            || (before.ino !== undefined && opened.ino !== undefined && before.ino !== opened.ino)
        ) {
            throw comfyError(errors.unsafe, 'Asset changed while opening');
        }
        const bytes = await handle.readFile();
        if (bytes.length !== opened.size) {
            throw comfyError(errors.unsafe, 'Asset changed while reading');
        }
        return bytes;
    } finally {
        await handle.close();
    }
}

function hasImageMagic(ext, bytes) {
    if (ext === 'png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504E470D0A1A0A', 'hex'));
    if (ext === 'jpg' || ext === 'jpeg') return bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
    if (ext === 'webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (ext === 'gif') return bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
    if (ext === 'bmp') return bytes.length >= 2 && bytes.toString('ascii', 0, 2) === 'BM';
    if (ext === 'avif') return bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp' && bytes.toString('ascii', 8, 12).includes('avif');
    return false;
}

function hasOutputMagic(mediaType, bytes) {
    if (mediaType === 'video/mp4') {
        return bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
    }
    if (mediaType === 'video/webm') {
        return bytes.length >= 4
            && bytes[0] === 0x1A
            && bytes[1] === 0x45
            && bytes[2] === 0xDF
            && bytes[3] === 0xA3;
    }
    const ext = OUTPUT_MEDIA_TYPES[mediaType]?.defaultExt;
    return Boolean(ext) && hasImageMagic(ext, bytes);
}

async function readCappedBytes(response, maxBytes, tooLargeCode) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw comfyError(tooLargeCode, 'Remote response exceeds the configured size limit');
    }
    if (!response.body) return Buffer.alloc(0);
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk);
        total += bytes.length;
        if (total > maxBytes) {
            throw comfyError(tooLargeCode, 'Remote response exceeds the configured size limit');
        }
        chunks.push(bytes);
    }
    return Buffer.concat(chunks, total);
}

async function readCappedJson(response) {
    const bytes = await readCappedBytes(response, MAX_JSON_BYTES, 'COMFY_RESPONSE_TOO_LARGE');
    try {
        return JSON.parse(bytes.toString('utf8'));
    } catch (cause) {
        throw comfyError('COMFY_RESPONSE_INVALID', 'Comfy returned invalid JSON', { cause });
    }
}

function isSafeRemoteSegment(value) {
    return typeof value === 'string'
        && value.length > 0
        && value !== '.'
        && value !== '..'
        && !value.includes('\0')
        && !value.includes('/')
        && !value.includes('\\');
}

function normalizeRemoteSubfolder(value) {
    // Windows-hosted ComfyUI reports subfolders with backslash separators
    // (e.g. "WanVideo\2026_07_30\원본") — treat them as separators, not as
    // hostility. Absolute paths (posix, drive-letter, UNC) and dot segments
    // stay fatal.
    if (typeof value !== 'string' || value.includes('\0')) {
        throw comfyError('COMFY_UPLOAD_RESPONSE_INVALID', 'Comfy returned an unsafe subfolder');
    }
    const normalized = value.replace(/\\/g, '/');
    if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
        throw comfyError('COMFY_UPLOAD_RESPONSE_INVALID', 'Comfy returned an unsafe subfolder');
    }
    const parts = normalized.split('/').filter(Boolean);
    if (parts.some(part => part === '.' || part === '..')) {
        throw comfyError('COMFY_UPLOAD_RESPONSE_INVALID', 'Comfy returned an unsafe subfolder');
    }
    return parts.join('/');
}

function createAbortScope(parentSignal, timeoutMs) {
    const controller = new AbortController();
    const abort = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) abort();
    else parentSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Comfy transfer timed out')), timeoutMs);
    return {
        signal: controller.signal,
        cleanup() {
            clearTimeout(timer);
            parentSignal?.removeEventListener('abort', abort);
        },
    };
}

async function pathStat(pathname) {
    return fs.promises.lstat(pathname).catch(error => {
        if (error?.code === 'ENOENT') return null;
        throw error;
    });
}

async function hashFile(pathname, maxBytes) {
    const handle = await fs.promises.open(pathname, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > maxBytes) {
            throw comfyError('COMFY_OUTPUT_CONFLICT', 'Existing output is unsafe or too large');
        }
        const hash = crypto.createHash('sha256');
        let size = 0;
        const stream = handle.createReadStream({ autoClose: false });
        for await (const chunk of stream) {
            size += chunk.length;
            if (size > maxBytes) throw comfyError('COMFY_OUTPUT_TOO_LARGE', 'Output exceeds the configured size limit');
            hash.update(chunk);
        }
        return { size, hash: hash.digest('hex').toUpperCase() };
    } finally {
        await handle.close();
    }
}

function validateOutputDescriptor(output, mediaType = 'video/mp4') {
    const media = OUTPUT_MEDIA_TYPES[mediaType];
    if (!media) {
        throw comfyError('COMFY_OUTPUT_DESCRIPTOR_INVALID', 'Comfy output media type is unsupported');
    }
    if (!isSafeRemoteSegment(output?.filename)) {
        throw comfyError('COMFY_OUTPUT_DESCRIPTOR_INVALID', 'Comfy output filename is unsafe');
    }
    const ext = normalizeExt(path.posix.extname(output.filename).slice(1));
    if (!media.extensions.has(ext) || output.type !== 'output') {
        throw comfyError('COMFY_OUTPUT_DESCRIPTOR_INVALID', 'Comfy output extension or type does not match its descriptor');
    }
    return {
        filename: output.filename,
        subfolder: normalizeRemoteSubfolder(output.subfolder ?? ''),
        type: 'output',
        ext,
        mediaType,
        assetType: media.assetType,
    };
}

function createComfyAssetStore(options) {
    const inlayDir = path.resolve(options.inlayDir);
    const stagingDir = path.resolve(options.stagingDir);
    const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const transferTimeoutMs = options.transferTimeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
    const kvSet = options.kvSet ?? (() => {});
    const kvDel = options.kvDel ?? (() => {});
    const now = options.now ?? Date.now;
    const rename = options.rename ?? fs.promises.rename.bind(fs.promises);

    async function readInputAsset(assetId) {
        if (!isSafeAssetId(assetId)) {
            throw comfyError('COMFY_INPUT_ID_INVALID', 'Input asset ID is invalid');
        }
        const root = await resolveSafeRoot(inlayDir, 'COMFY_INPUT_UNSAFE');
        const sidecarPath = path.join(root, `${assetId}.meta.json`);
        const sidecarBytes = await readOpenedFile(root, sidecarPath, MAX_SIDECAR_BYTES, {
            unsafe: 'COMFY_INPUT_UNSAFE',
            missing: 'COMFY_INPUT_NOT_FOUND',
            tooLarge: 'COMFY_INPUT_SIDECAR_INVALID',
        });

        let sidecar;
        try {
            sidecar = JSON.parse(sidecarBytes.toString('utf8'));
        } catch (cause) {
            throw comfyError('COMFY_INPUT_SIDECAR_INVALID', 'Input asset sidecar is invalid JSON', { cause });
        }
        const ext = normalizeExt(sidecar?.ext);
        const mimeType = IMAGE_MIME_BY_EXT[ext];
        if (sidecar?.type !== 'image' || !mimeType) {
            throw comfyError('COMFY_INPUT_NOT_IMAGE', 'Comfy input asset must be a supported image');
        }

        const payloadPath = path.join(root, `${assetId}.${ext}`);
        const bytes = await readOpenedFile(root, payloadPath, maxInputBytes, {
            unsafe: 'COMFY_INPUT_UNSAFE',
            missing: 'COMFY_INPUT_NOT_FOUND',
            tooLarge: 'COMFY_INPUT_TOO_LARGE',
        });
        if (!hasImageMagic(ext, bytes)) {
            throw comfyError('COMFY_INPUT_MAGIC_INVALID', 'Input asset bytes do not match the declared image type');
        }

        return {
            assetId,
            ext,
            mimeType,
            name: typeof sidecar.name === 'string' && sidecar.name ? sidecar.name : `${assetId}.${ext}`,
            width: Number.isFinite(sidecar.width) ? sidecar.width : undefined,
            height: Number.isFinite(sidecar.height) ? sidecar.height : undefined,
            size: bytes.length,
            hash: crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase(),
            bytes,
        };
    }

    async function uploadInput(endpointUrl, jobId, input, requestOptions = {}) {
        if (!isSafeAssetId(jobId) || !input || !Buffer.isBuffer(input.bytes)) {
            throw comfyError('COMFY_UPLOAD_INVALID', 'Upload input is invalid');
        }
        const filename = `risu-${jobId}-${input.hash}.${input.ext}`;
        const form = new FormData();
        form.append('image', new Blob([input.bytes], { type: input.mimeType }), filename);
        form.append('type', 'input');
        form.append('subfolder', 'risu-comfy');
        form.append('overwrite', 'false');

        const abortScope = createAbortScope(requestOptions.signal, transferTimeoutMs);
        let response;
        try {
            response = await fetchImpl(`${endpointUrl.replace(/\/+$/, '')}/upload/image`, {
                method: 'POST',
                body: form,
                signal: abortScope.signal,
            });
        } catch (cause) {
            abortScope.cleanup();
            if (requestOptions.signal?.aborted && isComfyError(requestOptions.signal.reason)) {
                throw requestOptions.signal.reason;
            }
            throw comfyError('COMFY_UPLOAD_FAILED', 'Could not upload the input image to Comfy', { cause });
        }
        if (!response.ok) {
            abortScope.cleanup();
            throw comfyError('COMFY_UPLOAD_FAILED', `Comfy input upload failed with HTTP ${response.status}`);
        }
        let result;
        try {
            result = await readCappedJson(response);
        } catch (cause) {
            if (requestOptions.signal?.aborted && isComfyError(requestOptions.signal.reason)) {
                throw requestOptions.signal.reason;
            }
            throw cause;
        } finally {
            abortScope.cleanup();
        }
        if (!isSafeRemoteSegment(result?.name) || result?.type !== 'input') {
            throw comfyError('COMFY_UPLOAD_RESPONSE_INVALID', 'Comfy returned an invalid upload path');
        }
        const subfolder = normalizeRemoteSubfolder(result.subfolder ?? '');
        return subfolder ? path.posix.join(subfolder, result.name) : result.name;
    }

    async function getMaterializationPaths(jobId, ext = 'mp4') {
        if (!isSafeAssetId(jobId)) {
            throw comfyError('COMFY_JOB_ID_INVALID', 'Job ID is invalid');
        }
        if (!OUTPUT_EXTENSIONS.includes(ext)) {
            throw comfyError('COMFY_OUTPUT_MARKER_INVALID', 'Output extension is not allowlisted');
        }
        const finalRoot = await resolveSafeRoot(inlayDir, 'COMFY_OUTPUT_UNSAFE');
        const stagingRoot = await resolveSafeRoot(stagingDir, 'COMFY_OUTPUT_UNSAFE');
        const [finalStat, stagingStat] = await Promise.all([
            fs.promises.stat(finalRoot),
            fs.promises.stat(stagingRoot),
        ]);
        if (finalStat.dev !== stagingStat.dev) {
            throw comfyError('COMFY_OUTPUT_STAGING_VOLUME', 'Output staging must share a volume with the inlay directory');
        }
        const jobDir = path.join(stagingRoot, jobId);
        assertContained(stagingRoot, jobDir, 'COMFY_OUTPUT_UNSAFE');
        await fs.promises.mkdir(jobDir, { recursive: true });
        const jobDirStat = await fs.promises.lstat(jobDir);
        if (!jobDirStat.isDirectory() || jobDirStat.isSymbolicLink()) {
            throw comfyError('COMFY_OUTPUT_UNSAFE', 'Output staging directory is unsafe');
        }
        const realJobDir = await fs.promises.realpath(jobDir);
        assertContained(stagingRoot, realJobDir, 'COMFY_OUTPUT_UNSAFE');
        const assetId = `comfy-${jobId}`;
        return {
            finalRoot,
            stagingRoot,
            jobDir: realJobDir,
            assetId,
            stagedPayload: path.join(realJobDir, 'payload.part'),
            stagedSidecar: path.join(realJobDir, 'sidecar.part'),
            readyPath: path.join(realJobDir, 'ready.json'),
            readyTmpPath: path.join(realJobDir, 'ready.tmp'),
            finalPayload: path.join(finalRoot, `${assetId}.${ext}`),
            finalSidecar: path.join(finalRoot, `${assetId}.meta.json`),
        };
    }

    function markerHash(marker) {
        const value = { ...marker };
        delete value.markerHash;
        return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').toUpperCase();
    }

    async function writeSyncedFile(pathname, bytes, flags = 'wx') {
        const handle = await fs.promises.open(pathname, flags);
        try {
            await handle.writeFile(bytes);
            await handle.sync();
        } finally {
            await handle.close();
        }
    }

    async function publishReadyOutput(paths, marker, target, expectedMediaType = null) {
        const legacyMp4 = marker.version === 1;
        const mediaType = legacyMp4 ? 'video/mp4' : marker.mediaType;
        const media = OUTPUT_MEDIA_TYPES[mediaType];
        if (
            ![1, 2].includes(marker.version)
            || marker.jobId !== path.basename(paths.jobDir)
            || marker.assetId !== paths.assetId
            || !media
            || !media.extensions.has(marker.ext)
            || (legacyMp4 && marker.ext !== 'mp4')
            || (!legacyMp4 && marker.assetType !== media.assetType)
            || (expectedMediaType != null && mediaType !== expectedMediaType)
            || marker.payloadFile !== 'payload.part'
            || marker.sidecarFile !== 'sidecar.part'
            || marker.markerHash !== markerHash(marker)
            || !Number.isSafeInteger(marker.size)
            || marker.size < 0
            || typeof marker.hash !== 'string'
        ) {
            throw comfyError('COMFY_OUTPUT_MARKER_INVALID', 'Output recovery marker is invalid');
        }

        const stagedPayloadStat = await pathStat(paths.stagedPayload);
        const finalPayloadStat = await pathStat(paths.finalPayload);
        if (stagedPayloadStat?.isSymbolicLink() || finalPayloadStat?.isSymbolicLink()) {
            throw comfyError('COMFY_OUTPUT_UNSAFE', 'Output payload path is a symbolic link');
        }
        if (!stagedPayloadStat && !finalPayloadStat) {
            throw comfyError('COMFY_OUTPUT_RECOVERY_MISSING', 'Recovered output payload is missing');
        }

        if (stagedPayloadStat) {
            const staged = await hashFile(paths.stagedPayload, maxOutputBytes);
            if (staged.hash !== marker.hash || staged.size !== marker.size) {
                throw comfyError('COMFY_OUTPUT_CONFLICT', 'Staged output does not match its recovery marker');
            }
        }
        if (finalPayloadStat) {
            const final = await hashFile(paths.finalPayload, maxOutputBytes);
            if (final.hash !== marker.hash || final.size !== marker.size) {
                throw comfyError('COMFY_OUTPUT_CONFLICT', 'Existing output conflicts with recovered bytes');
            }
        }

        const expectedSidecar = JSON.stringify({
            ext: marker.ext,
            name: marker.name,
            type: media.assetType,
        });
        const finalSidecarStat = await pathStat(paths.finalSidecar);
        if (finalSidecarStat?.isSymbolicLink()) {
            throw comfyError('COMFY_OUTPUT_UNSAFE', 'Output sidecar path is a symbolic link');
        }
        if (finalSidecarStat) {
            const current = await readOpenedFile(paths.finalRoot, paths.finalSidecar, MAX_SIDECAR_BYTES, {
                unsafe: 'COMFY_OUTPUT_UNSAFE',
                missing: 'COMFY_OUTPUT_RECOVERY_MISSING',
                tooLarge: 'COMFY_OUTPUT_CONFLICT',
            });
            if (current.toString('utf8') !== expectedSidecar) {
                throw comfyError('COMFY_OUTPUT_CONFLICT', 'Existing output sidecar conflicts with recovered bytes');
            }
            await fs.promises.unlink(paths.stagedSidecar).catch(() => {});
        } else {
            const stagedSidecarStat = await pathStat(paths.stagedSidecar);
            if (!stagedSidecarStat || !stagedSidecarStat.isFile() || stagedSidecarStat.isSymbolicLink()) {
                throw comfyError('COMFY_OUTPUT_RECOVERY_MISSING', 'Staged output sidecar is missing');
            }
            const stagedSidecar = await fs.promises.readFile(paths.stagedSidecar, 'utf8');
            if (stagedSidecar !== expectedSidecar) {
                throw comfyError('COMFY_OUTPUT_CONFLICT', 'Staged output sidecar conflicts with recovered bytes');
            }
            await rename(paths.stagedSidecar, paths.finalSidecar);
        }

        if (finalPayloadStat) {
            await fs.promises.unlink(paths.stagedPayload).catch(() => {});
        } else {
            await rename(paths.stagedPayload, paths.finalPayload);
        }

        const timestamp = now();
        const metadata = {
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        if (typeof target?.charId === 'string') metadata.charId = target.charId;
        if (typeof target?.chatId === 'string') metadata.chatId = target.chatId;
        kvSet(`inlay_meta/${paths.assetId}`, Buffer.from(JSON.stringify(metadata)));
        return {
            resultAssetId: paths.assetId,
            mimeType: mediaType,
            hash: marker.hash,
            size: marker.size,
        };
    }

    async function recoverMaterialization(jobId, requestOptions = {}) {
        const expectedMediaType = requestOptions.mediaType ?? 'video/mp4';
        const expectedMedia = OUTPUT_MEDIA_TYPES[expectedMediaType];
        if (!expectedMedia) throw comfyError('COMFY_OUTPUT_DESCRIPTOR_INVALID', 'Comfy output media type is unsupported');
        const expectedDescriptor = requestOptions.output
            ? validateOutputDescriptor(requestOptions.output, expectedMediaType)
            : null;
        let paths = await getMaterializationPaths(jobId, expectedDescriptor?.ext ?? expectedMedia.defaultExt);
        const readyStat = await pathStat(paths.readyPath);
        if (!readyStat) {
            const [payload, sidecar] = await Promise.all([
                pathStat(paths.finalPayload),
                pathStat(paths.finalSidecar),
            ]);
            if (!payload || !sidecar) return null;
            throw comfyError('COMFY_OUTPUT_MARKER_MISSING', 'Committed output exists without a recovery marker');
        }
        if (!readyStat.isFile() || readyStat.isSymbolicLink() || readyStat.size > MAX_SIDECAR_BYTES) {
            throw comfyError('COMFY_OUTPUT_MARKER_INVALID', 'Output recovery marker is unsafe');
        }
        let marker;
        try {
            marker = JSON.parse(await fs.promises.readFile(paths.readyPath, 'utf8'));
        } catch (cause) {
            throw comfyError('COMFY_OUTPUT_MARKER_INVALID', 'Output recovery marker is invalid JSON', { cause });
        }
        if (!OUTPUT_EXTENSIONS.includes(marker?.ext)) {
            throw comfyError('COMFY_OUTPUT_MARKER_INVALID', 'Output recovery marker extension is invalid');
        }
        if (
            expectedDescriptor
            && (marker.name !== expectedDescriptor.filename || marker.ext !== expectedDescriptor.ext)
        ) {
            throw comfyError('COMFY_OUTPUT_MARKER_INVALID', 'Output recovery marker does not match the selected history output');
        }
        paths = await getMaterializationPaths(jobId, marker.ext);
        try {
            return await publishReadyOutput(paths, marker, requestOptions.target, expectedMediaType);
        } catch (cause) {
            if (isComfyError(cause)) throw cause;
            throw comfyError(
                'COMFY_OUTPUT_PUBLISH_RETRY',
                'A durable Comfy output is waiting for local publication retry',
                { cause, retryMaterialization: true },
            );
        }
    }

    async function materializeOutput(endpointUrl, jobId, output, requestOptions = {}) {
        const mediaType = requestOptions.mediaType ?? 'video/mp4';
        const descriptor = validateOutputDescriptor(output, mediaType);
        const paths = await getMaterializationPaths(jobId, descriptor.ext);
        const recovered = await recoverMaterialization(jobId, { ...requestOptions, mediaType, output });
        if (recovered) return recovered;

        for (const pathname of [
            paths.stagedPayload,
            paths.stagedSidecar,
            paths.readyTmpPath,
            paths.readyPath,
        ]) {
            await fs.promises.unlink(pathname).catch(error => {
                if (error?.code !== 'ENOENT') throw error;
            });
        }

        const query = new URLSearchParams();
        query.set('filename', descriptor.filename);
        query.set('subfolder', descriptor.subfolder);
        query.set('type', descriptor.type);
        const abortScope = createAbortScope(requestOptions.signal, transferTimeoutMs);
        let response;
        try {
            response = await fetchImpl(`${endpointUrl.replace(/\/+$/, '')}/view?${query}`, {
                method: 'GET',
                signal: abortScope.signal,
            });
        } catch (cause) {
            abortScope.cleanup();
            throw comfyError('COMFY_OUTPUT_DOWNLOAD_UNKNOWN', 'Comfy output download failed', { cause, uncertain: true });
        }
        if (!response.ok) {
            abortScope.cleanup();
            throw comfyError(
                response.status >= 500 ? 'COMFY_OUTPUT_DOWNLOAD_UNKNOWN' : 'COMFY_OUTPUT_DOWNLOAD_FAILED',
                `Comfy output download failed with HTTP ${response.status}`,
                { uncertain: response.status >= 500 },
            );
        }
        const contentType = String(response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
        if (contentType !== mediaType) {
            abortScope.cleanup();
            throw comfyError('COMFY_OUTPUT_MIME_INVALID', 'Comfy output response media type does not match its descriptor');
        }
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > maxOutputBytes) {
            abortScope.cleanup();
            throw comfyError('COMFY_OUTPUT_TOO_LARGE', 'Comfy output exceeds the configured size limit');
        }
        if (!response.body) {
            abortScope.cleanup();
            throw comfyError('COMFY_OUTPUT_DOWNLOAD_FAILED', 'Comfy output response has no body');
        }

        let handle;
        try {
            handle = await fs.promises.open(paths.stagedPayload, 'wx');
        } catch (error) {
            abortScope.cleanup();
            throw error;
        }
        const hash = crypto.createHash('sha256');
        const head = [];
        let headSize = 0;
        let size = 0;
        let transferError = null;
        try {
            for await (const chunkValue of response.body) {
                const chunk = Buffer.from(chunkValue);
                size += chunk.length;
                if (size > maxOutputBytes) {
                    throw comfyError('COMFY_OUTPUT_TOO_LARGE', 'Comfy output exceeds the configured size limit');
                }
                if (headSize < 32) {
                    const slice = chunk.subarray(0, 32 - headSize);
                    head.push(slice);
                    headSize += slice.length;
                }
                hash.update(chunk);
                await handle.writeFile(chunk);
            }
            await handle.sync();
        } catch (error) {
            transferError = error;
        } finally {
            try {
                await handle.close();
            } catch (error) {
                transferError ??= error;
            } finally {
                abortScope.cleanup();
            }
        }
        if (transferError) {
            await fs.promises.unlink(paths.stagedPayload).catch(() => {});
            if (isComfyError(transferError)) throw transferError;
            if (typeof transferError?.code === 'string' && transferError.code.startsWith('E')) {
                throw comfyError('COMFY_OUTPUT_STORE_FAILED', 'Could not store the Comfy output', {
                    cause: transferError,
                });
            }
            throw comfyError('COMFY_OUTPUT_DOWNLOAD_UNKNOWN', 'Comfy output stream ended unexpectedly', {
                cause: transferError,
                uncertain: true,
            });
        }

        const header = Buffer.concat(head, headSize);
        if (!hasOutputMagic(mediaType, header)) {
            await fs.promises.unlink(paths.stagedPayload).catch(() => {});
            throw comfyError('COMFY_OUTPUT_MAGIC_INVALID', 'Comfy output magic bytes do not match its descriptor');
        }
        const outputHash = hash.digest('hex').toUpperCase();
        const sidecar = JSON.stringify({
            ext: descriptor.ext,
            name: descriptor.filename,
            type: descriptor.assetType,
        });
        await writeSyncedFile(paths.stagedSidecar, sidecar);
        const marker = {
            version: mediaType === 'video/mp4' ? 1 : 2,
            jobId,
            assetId: paths.assetId,
            ext: descriptor.ext,
            name: descriptor.filename,
            hash: outputHash,
            size,
            payloadFile: 'payload.part',
            sidecarFile: 'sidecar.part',
        };
        if (marker.version === 2) {
            marker.mediaType = mediaType;
            marker.assetType = descriptor.assetType;
        }
        marker.markerHash = markerHash(marker);
        await writeSyncedFile(paths.readyTmpPath, JSON.stringify(marker));
        await rename(paths.readyTmpPath, paths.readyPath);
        try {
            return await publishReadyOutput(paths, marker, requestOptions.target, mediaType);
        } catch (cause) {
            if (isComfyError(cause)) throw cause;
            throw comfyError(
                'COMFY_OUTPUT_PUBLISH_RETRY',
                'A durable Comfy output is waiting for local publication retry',
                { cause, retryMaterialization: true },
            );
        }
    }

    async function removeMaterializedAsset(assetId) {
        if (!isSafeAssetId(assetId) || !assetId.startsWith('comfy-')) return;
        const root = await resolveSafeRoot(inlayDir, 'COMFY_OUTPUT_UNSAFE');
        for (const ext of OUTPUT_EXTENSIONS) {
            await fs.promises.unlink(path.join(root, `${assetId}.${ext}`)).catch(() => {});
        }
        await fs.promises.unlink(path.join(root, `${assetId}.meta.json`)).catch(() => {});
        kvDel(`inlay_meta/${assetId}`);
    }

    async function finalizeMaterialization(jobId) {
        const paths = await getMaterializationPaths(jobId);
        await fs.promises.unlink(paths.readyPath).catch(() => {});
        await fs.promises.unlink(paths.readyTmpPath).catch(() => {});
        await fs.promises.unlink(paths.stagedPayload).catch(() => {});
        await fs.promises.unlink(paths.stagedSidecar).catch(() => {});
        await fs.promises.rmdir(paths.jobDir).catch(() => {});
    }

    async function cleanupStaging() {
        const root = await resolveSafeRoot(stagingDir, 'COMFY_OUTPUT_UNSAFE');
        const entries = await fs.promises.readdir(root, { withFileTypes: true });
        for (const entry of entries) {
            const candidate = path.join(root, entry.name);
            assertContained(root, candidate, 'COMFY_OUTPUT_UNSAFE');
            const stat = await fs.promises.lstat(candidate);
            if (stat.isSymbolicLink()) {
                await fs.promises.unlink(candidate);
            } else {
                await fs.promises.rm(candidate, { recursive: true, force: true });
            }
        }
    }

    async function cleanupOrphanStaging(activeJobIds) {
        const keep = activeJobIds instanceof Set ? activeJobIds : new Set(activeJobIds ?? []);
        const root = await resolveSafeRoot(stagingDir, 'COMFY_OUTPUT_UNSAFE');
        const entries = await fs.promises.readdir(root, { withFileTypes: true });
        for (const entry of entries) {
            if (keep.has(entry.name)) continue;
            const candidate = path.join(root, entry.name);
            assertContained(root, candidate, 'COMFY_OUTPUT_UNSAFE');
            const stat = await fs.promises.lstat(candidate);
            if (stat.isSymbolicLink()) await fs.promises.unlink(candidate);
            else await fs.promises.rm(candidate, { recursive: true, force: true });
        }
    }

    return {
        readInputAsset,
        uploadInput,
        materializeOutput,
        recoverMaterialization,
        finalizeMaterialization,
        removeMaterializedAsset,
        cleanupStaging,
        cleanupOrphanStaging,
        inlayDir,
        stagingDir,
        maxInputBytes,
        maxOutputBytes,
    };
}

module.exports = {
    createComfyAssetStore,
    validateOutputDescriptor,
    DEFAULT_MAX_INPUT_BYTES,
    DEFAULT_MAX_OUTPUT_BYTES,
};
