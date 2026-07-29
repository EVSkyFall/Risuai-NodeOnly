'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { comfyError } = require('./errors.cjs');

const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEFAULT_MAX_TEMPLATE_BYTES = 5 * 1024 * 1024;
const SLOT_NAMES = new Set(['positive', 'input_image', 'seed']);

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertContained(root, candidate) {
    const relative = path.relative(root, candidate);
    if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
        throw comfyError('COMFY_TEMPLATE_PATH_INVALID', 'Template path escapes its configured directory');
    }
}

function scanPlaceholders(value, currentPath = [], slots = []) {
    if (typeof value === 'string') {
        if (!value.includes('{{') && !value.includes('}}')) return slots;
        const match = value.match(/^\{\{([a-z_]+)\}\}$/);
        if (!match || !SLOT_NAMES.has(match[1])) {
            throw comfyError('COMFY_TEMPLATE_PLACEHOLDER_INVALID', `Invalid template placeholder at ${currentPath.join('.')}`);
        }
        if (
            currentPath.length !== 3
            || currentPath[1] !== 'inputs'
            || currentPath[0] === '_meta'
            || currentPath[2] === 'class_type'
        ) {
            throw comfyError('COMFY_TEMPLATE_PLACEHOLDER_INVALID', `Template placeholder is not an input leaf at ${currentPath.join('.')}`);
        }
        slots.push({ name: match[1], path: currentPath });
        return slots;
    }

    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            scanPlaceholders(value[index], [...currentPath, index], slots);
        }
        return slots;
    }

    if (isPlainObject(value)) {
        for (const [key, child] of Object.entries(value)) {
            scanPlaceholders(child, [...currentPath, key], slots);
        }
    }
    return slots;
}

function validateSlots(slots) {
    if (!isPlainObject(slots)) {
        throw comfyError('COMFY_SLOTS_INVALID', 'Template slots must be an object');
    }
    for (const required of SLOT_NAMES) {
        if (!Object.prototype.hasOwnProperty.call(slots, required)) {
            throw comfyError('COMFY_SLOT_MISSING', `Required template slot is missing: ${required}`);
        }
    }
    for (const supplied of Object.keys(slots)) {
        if (!SLOT_NAMES.has(supplied)) {
            throw comfyError('COMFY_SLOT_UNKNOWN', `Template slot is not declared: ${supplied}`);
        }
    }
    if (typeof slots.positive !== 'string' || Buffer.byteLength(slots.positive, 'utf8') > 1024 * 1024) {
        throw comfyError('COMFY_SLOT_INVALID', 'positive must be a string no larger than 1 MiB');
    }
    if (
        typeof slots.input_image !== 'string'
        || slots.input_image.length === 0
        || slots.input_image.length > 1024
        || slots.input_image.includes('\\')
        || path.posix.isAbsolute(slots.input_image)
        || slots.input_image.split('/').includes('..')
    ) {
        throw comfyError('COMFY_SLOT_INVALID', 'input_image must be a safe Comfy input path');
    }
    if (!Number.isSafeInteger(slots.seed) || slots.seed < 0) {
        throw comfyError('COMFY_SLOT_INVALID', 'seed must be a non-negative safe integer');
    }
}

function setPath(target, slotPath, value) {
    let cursor = target;
    for (let index = 0; index < slotPath.length - 1; index += 1) {
        cursor = cursor[slotPath[index]];
    }
    cursor[slotPath[slotPath.length - 1]] = value;
}

function compileTemplate(document) {
    if (!isPlainObject(document) || Object.keys(document).length === 0) {
        throw comfyError('COMFY_TEMPLATE_INVALID', 'Template root must be a non-empty object');
    }

    for (const [nodeId, node] of Object.entries(document)) {
        if (!isPlainObject(node) || typeof node.class_type !== 'string' || !isPlainObject(node.inputs)) {
            throw comfyError('COMFY_TEMPLATE_INVALID', `Node ${nodeId} is malformed`);
        }
    }

    const slotPaths = scanPlaceholders(document);
    for (const required of SLOT_NAMES) {
        if (!slotPaths.some(slot => slot.name === required)) {
            throw comfyError('COMFY_TEMPLATE_INVALID', `Template is missing {{${required}}}`);
        }
    }

    const outputNodes = Object.entries(document)
        .filter(([, node]) => node.class_type === 'VHS_VideoCombine')
        .map(([nodeId]) => nodeId);
    if (outputNodes.length !== 1) {
        throw comfyError(
            'COMFY_TEMPLATE_OUTPUT_INVALID',
            'Templates must contain exactly one VHS_VideoCombine output',
        );
    }

    const manifest = [
        { name: 'input_image', type: 'imageAsset', required: true },
        { name: 'positive', type: 'string', required: true },
        {
            name: 'seed',
            type: 'integer',
            required: true,
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER,
        },
    ];
    return { slotPaths, manifest, outputNodeId: outputNodes[0], outputKey: 'gifs' };
}

function createTemplateRegistry(options = {}) {
    const templateDir = path.resolve(options.templateDir);
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_TEMPLATE_BYTES;

    function compileWithContext(document, templateId) {
        try {
            return compileTemplate(document);
        } catch (error) {
            if (typeof error?.code !== 'string' || !error.code.startsWith('COMFY_')) throw error;
            throw comfyError(error.code, `Template ${templateId}: ${error.message}`, {
                cause: error,
                httpStatus: error.httpStatus,
                uncertain: error.uncertain,
            });
        }
    }

    async function resolveRoot() {
        const stat = await fs.promises.lstat(templateDir).catch(() => null);
        if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
            throw comfyError('COMFY_TEMPLATE_DIR_INVALID', 'Template directory is missing or unsafe');
        }
        return fs.promises.realpath(templateDir);
    }

    async function loadTemplate(templateId) {
        if (!TEMPLATE_ID_PATTERN.test(templateId)) {
            throw comfyError('COMFY_TEMPLATE_ID_INVALID', 'Invalid template ID');
        }

        const root = await resolveRoot();
        const candidate = path.join(root, `${templateId}.json`);
        assertContained(root, candidate);
        const stat = await fs.promises.lstat(candidate).catch(() => null);
        if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
            throw comfyError('COMFY_TEMPLATE_NOT_FOUND', `Template ${templateId} was not found`, { httpStatus: 404 });
        }
        if (stat.size > maxBytes) {
            throw comfyError('COMFY_TEMPLATE_TOO_LARGE', `Template ${templateId} exceeds the size limit`);
        }

        const real = await fs.promises.realpath(candidate);
        assertContained(root, real);
        const noFollow = fs.constants.O_NOFOLLOW ?? 0;
        const handle = await fs.promises.open(real, fs.constants.O_RDONLY | noFollow);
        let bytes;
        try {
            const opened = await handle.stat();
            if (
                !opened.isFile()
                || opened.size > maxBytes
                || opened.size !== stat.size
                || (opened.dev !== undefined && stat.dev !== undefined && opened.dev !== stat.dev)
                || (opened.ino !== undefined && stat.ino !== undefined && opened.ino !== stat.ino)
            ) {
                throw comfyError('COMFY_TEMPLATE_CHANGED', `Template ${templateId} changed while loading`);
            }
            bytes = await handle.readFile();
            const after = await handle.stat();
            if (
                bytes.length !== opened.size
                || bytes.length > maxBytes
                || after.size !== opened.size
                || (after.dev !== undefined && opened.dev !== undefined && after.dev !== opened.dev)
                || (after.ino !== undefined && opened.ino !== undefined && after.ino !== opened.ino)
                || (after.mtimeMs !== undefined && opened.mtimeMs !== undefined && after.mtimeMs !== opened.mtimeMs)
            ) {
                throw comfyError('COMFY_TEMPLATE_CHANGED', `Template ${templateId} changed while loading`);
            }
        } finally {
            await handle.close();
        }

        let document;
        try {
            document = JSON.parse(bytes.toString('utf8'));
        } catch (cause) {
            throw comfyError('COMFY_TEMPLATE_INVALID', `Template ${templateId} is not valid JSON`, { cause });
        }
        const compiled = compileWithContext(document, templateId);
        return {
            id: templateId,
            hash: sha256(bytes),
            sourceText: bytes.toString('utf8'),
            document,
            ...compiled,
        };
    }

    async function listTemplates() {
        const root = await resolveRoot();
        const entries = await fs.promises.readdir(root, { withFileTypes: true });
        const ids = entries
            .filter(entry => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json'))
            .map(entry => entry.name.slice(0, -5))
            .filter(id => TEMPLATE_ID_PATTERN.test(id))
            .sort();
        const loaded = await Promise.allSettled(ids.map(loadTemplate));
        return loaded.map((result, index) => {
            if (result.status === 'fulfilled') {
                return {
                    id: result.value.id,
                    hash: result.value.hash,
                    slots: result.value.manifest,
                };
            }
            return {
                id: ids[index],
                error: {
                    code: typeof result.reason?.code === 'string'
                        ? result.reason.code
                        : 'COMFY_TEMPLATE_INVALID',
                    message: String(result.reason?.message ?? result.reason),
                },
            };
        });
    }

    async function instantiate(templateId, slots) {
        validateSlots(slots);
        const template = await loadTemplate(templateId);
        const prompt = structuredClone(template.document);
        for (const slot of template.slotPaths) {
            setPath(prompt, slot.path, slots[slot.name]);
        }
        return {
            prompt,
            templateHash: template.hash,
            outputNodeId: template.outputNodeId,
            outputKey: template.outputKey,
        };
    }

    function instantiateSnapshot(sourceText, expectedHash, slots, templateId = 'stored snapshot') {
        if (typeof sourceText !== 'string' || sha256(Buffer.from(sourceText, 'utf8')) !== expectedHash) {
            throw comfyError('COMFY_TEMPLATE_SNAPSHOT_INVALID', 'Stored template snapshot hash does not match');
        }
        let document;
        try {
            document = JSON.parse(sourceText);
        } catch (cause) {
            throw comfyError('COMFY_TEMPLATE_SNAPSHOT_INVALID', 'Stored template snapshot is invalid JSON', { cause });
        }
        validateSlots(slots);
        const compiled = compileWithContext(document, templateId);
        const prompt = structuredClone(document);
        for (const slot of compiled.slotPaths) {
            setPath(prompt, slot.path, slots[slot.name]);
        }
        return {
            prompt,
            templateHash: expectedHash,
            outputNodeId: compiled.outputNodeId,
            outputKey: compiled.outputKey,
        };
    }

    return { listTemplates, instantiate, instantiateSnapshot, loadTemplate };
}

module.exports = {
    createTemplateRegistry,
    TEMPLATE_ID_PATTERN,
    DEFAULT_MAX_TEMPLATE_BYTES,
};
