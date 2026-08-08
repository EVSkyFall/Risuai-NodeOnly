'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { comfyError } = require('./errors.cjs');

const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CUSTOM_TEMPLATE_ID_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_TEMPLATE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_CUSTOM_TEMPLATE_BYTES = 2 * 1024 * 1024;
const LEGACY_SLOT_NAMES = new Set(['positive', 'input_image', 'seed']);
const OUTPUT_BY_CLASS = Object.freeze({
    VHS_VideoCombine: Object.freeze({ historyKey: 'gifs', mediaType: 'video/mp4' }),
    SaveVideo: Object.freeze({ historyKey: 'images', mediaType: 'video/mp4' }),
    SaveImage: Object.freeze({ historyKey: 'images', mediaType: 'image/png' }),
});
const ALLOWED_MEDIA_TYPES = new Set(['video/mp4', 'video/webm', 'image/png', 'image/jpeg', 'image/webp']);
const PROMPT_PROFILES = new Set(['wan-motion', 'h3-structured', 'image-tags']);
const MODES_BY_KIND = Object.freeze({
    video: new Set(['t2v', 'i2v', 'l2v', 'flf2v', 'ref2v']),
    image: new Set(['t2i', 'i2i']),
});
const IMAGE_ROLE_PATTERN = /^(?:input_image|keyframe|start_image|end_image|reference_[1-9][0-9]*)$/;
const EMBEDDED_IMAGE_LITERAL_PATTERN = /\.(?:png|jpe?g|webp)$/i;
const CUSTOM_SLOT_TOKEN_PATTERN = /\{\{([a-z_][a-z0-9_]*)\}\}/g;
const FIXED_CUSTOM_SLOT_NAMES = Object.freeze([
    'positive', 'negative', 'seed', 'input_image', 'keyframe', 'start_image', 'end_image',
]);
const SAFE_HISTORY_KEY_PATTERN = /^[A-Za-z0-9_:-]{1,128}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const BUILTIN_META = Object.freeze({
    'wan-i2v': Object.freeze({ name: 'Wan I2V', kind: 'video', mode: 'i2v', promptProfile: 'wan-motion' }),
    'wan22-flf2v-loop': Object.freeze({
        name: 'Wan 2.2 FLF2V Loop',
        kind: 'video',
        mode: 'flf2v',
        promptProfile: 'wan-motion',
    }),
});

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw comfyError('COMFY_TEMPLATE_INVALID', 'Template contains a non-finite number');
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (isPlainObject(value)) {
        const keys = Object.keys(value).sort();
        return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    throw comfyError('COMFY_TEMPLATE_INVALID', 'Template contains an unsupported JSON value');
}

function assertContained(root, candidate) {
    const relative = path.relative(root, candidate);
    if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
        throw comfyError('COMFY_TEMPLATE_PATH_INVALID', 'Template path escapes its configured directory');
    }
}

function errorEntry(error) {
    return {
        code: typeof error?.code === 'string' ? error.code : 'COMFY_TEMPLATE_INVALID',
        message: String(error?.message ?? error),
    };
}

function isKnownCustomSlotName(name) {
    return name === 'positive' || name === 'negative' || name === 'seed' || IMAGE_ROLE_PATTERN.test(name);
}

function getExactCustomSlotName(value) {
    const match = value.match(/^\{\{([a-z_][a-z0-9_]*)\}\}$/);
    return match && isKnownCustomSlotName(match[1]) ? match[1] : null;
}

function findKnownCustomSlotToken(value) {
    for (const match of value.matchAll(CUSTOM_SLOT_TOKEN_PATTERN)) {
        if (isKnownCustomSlotName(match[1])) return match[0];
    }
    return null;
}

function isSingleDamerauEdit(left, right) {
    if (left === right || Math.abs(left.length - right.length) > 1) return false;
    if (left.length === right.length) {
        const differences = [];
        for (let index = 0; index < left.length; index += 1) {
            if (left[index] !== right[index]) differences.push(index);
            if (differences.length > 2) return false;
        }
        if (differences.length === 1) return true;
        return differences.length === 2
            && differences[1] === differences[0] + 1
            && left[differences[0]] === right[differences[1]]
            && left[differences[1]] === right[differences[0]];
    }
    const shorter = left.length < right.length ? left : right;
    const longer = left.length < right.length ? right : left;
    let shortIndex = 0;
    let longIndex = 0;
    let skipped = false;
    while (shortIndex < shorter.length && longIndex < longer.length) {
        if (shorter[shortIndex] === longer[longIndex]) {
            shortIndex += 1;
            longIndex += 1;
        } else if (skipped) {
            return false;
        } else {
            skipped = true;
            longIndex += 1;
        }
    }
    return true;
}

function findReferenceSlotSuggestion(name) {
    const trailingDigits = name.match(/([1-9][0-9]*)$/)?.[1];
    if (trailingDigits) {
        const candidate = `reference_${trailingDigits}`;
        if (isSingleDamerauEdit(name, candidate)) return candidate;
    }
    if (!name.startsWith('reference_')) return null;
    const suffix = name.slice('reference_'.length);
    if (suffix === '') return 'reference_1';

    let invalidIndex = -1;
    for (let index = 0; index < suffix.length; index += 1) {
        const validDigit = index === 0
            ? suffix[index] >= '1' && suffix[index] <= '9'
            : suffix[index] >= '0' && suffix[index] <= '9';
        if (validDigit) continue;
        if (invalidIndex !== -1) return null;
        invalidIndex = index;
    }
    if (invalidIndex === -1) return null;

    const candidateSuffixes = [
        `${suffix.slice(0, invalidIndex)}${suffix.slice(invalidIndex + 1)}`,
        `${suffix.slice(0, invalidIndex)}${invalidIndex === 0 ? '1' : '0'}${suffix.slice(invalidIndex + 1)}`,
    ];
    for (const candidateSuffix of candidateSuffixes) {
        if (!/^[1-9][0-9]*$/.test(candidateSuffix)) continue;
        const candidate = `reference_${candidateSuffix}`;
        if (isSingleDamerauEdit(name, candidate)) return candidate;
    }
    return null;
}

function findCustomSlotSuggestion(name) {
    const referenceSuggestion = findReferenceSlotSuggestion(name);
    const candidates = referenceSuggestion
        ? [...FIXED_CUSTOM_SLOT_NAMES, referenceSuggestion]
        : FIXED_CUSTOM_SLOT_NAMES;
    return candidates.find(candidate => isSingleDamerauEdit(name, candidate)) ?? null;
}

function findUnrecognizedCustomSlotTokens(value) {
    const unrecognized = [];
    const seen = new Set();
    for (const match of value.matchAll(CUSTOM_SLOT_TOKEN_PATTERN)) {
        const name = match[1];
        if (isKnownCustomSlotName(name) || seen.has(name)) continue;
        seen.add(name);
        const suggestion = findCustomSlotSuggestion(name);
        unrecognized.push({
            token: match[0],
            ...(suggestion ? { suggestion: `{{${suggestion}}}` } : {}),
        });
    }
    return unrecognized;
}

function appendJsonPointer(pathHint, segment) {
    return `${pathHint}/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

function visitJsonStringValues(value, visitor, pathHint = '') {
    if (typeof value === 'string') {
        visitor(value, pathHint || '/');
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((child, index) => visitJsonStringValues(child, visitor, appendJsonPointer(pathHint, index)));
        return;
    }
    if (isPlainObject(value)) {
        for (const [key, child] of Object.entries(value)) {
            visitJsonStringValues(child, visitor, appendJsonPointer(pathHint, key));
        }
    }
}

function visitJsonObjectKeys(value, visitor) {
    if (Array.isArray(value)) {
        value.forEach(child => visitJsonObjectKeys(child, visitor));
        return;
    }
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
        visitor(key);
        visitJsonObjectKeys(child, visitor);
    }
}

function inspectEmbeddedJsonInput(value) {
    let parsed;
    try {
        parsed = JSON.parse(value);
    } catch {
        return null;
    }
    const slotsByToken = new Map();
    const imagesByLiteral = new Map();
    const unrecognizedByToken = new Map();
    let knownTokenInKey = false;
    visitJsonStringValues(parsed, (leaf, pathHint) => {
        for (const match of leaf.matchAll(CUSTOM_SLOT_TOKEN_PATTERN)) {
            const token = match[0];
            const name = match[1];
            if (isKnownCustomSlotName(name)) {
                const current = slotsByToken.get(token);
                if (current) current.occurrences += 1;
                else slotsByToken.set(token, { token, occurrences: 1 });
                continue;
            }
            if (!unrecognizedByToken.has(token)) {
                const suggestion = findCustomSlotSuggestion(name);
                unrecognizedByToken.set(token, {
                    token,
                    ...(suggestion ? { suggestion: `{{${suggestion}}}` } : {}),
                });
            }
        }
        if (!EMBEDDED_IMAGE_LITERAL_PATTERN.test(leaf)) return;
        const current = imagesByLiteral.get(leaf);
        if (current) current.occurrences += 1;
        else imagesByLiteral.set(leaf, { literal: leaf, pathHint, occurrences: 1 });
    });
    visitJsonObjectKeys(parsed, key => {
        for (const match of key.matchAll(CUSTOM_SLOT_TOKEN_PATTERN)) {
            const token = match[0];
            const name = match[1];
            if (isKnownCustomSlotName(name)) {
                knownTokenInKey = true;
                continue;
            }
            if (!unrecognizedByToken.has(token)) {
                const suggestion = findCustomSlotSuggestion(name);
                unrecognizedByToken.set(token, {
                    token,
                    ...(suggestion ? { suggestion: `{{${suggestion}}}` } : {}),
                });
            }
        }
    });
    return {
        slots: [...slotsByToken.values()],
        imageLiterals: [...imagesByLiteral.values()],
        unrecognized: [...unrecognizedByToken.values()],
        knownTokenInKey,
    };
}

function parseGraphInput(graphJson, maxBytes) {
    let sourceText;
    let document;
    let inputBytes;
    if (typeof graphJson === 'string') {
        inputBytes = Buffer.byteLength(graphJson, 'utf8');
        if (inputBytes > maxBytes) {
            throw comfyError('COMFY_TEMPLATE_TOO_LARGE', 'Template graph exceeds the 2 MiB size limit');
        }
        try {
            document = JSON.parse(graphJson);
        } catch (cause) {
            throw comfyError('COMFY_TEMPLATE_INVALID_JSON', 'Template graph is not valid JSON', { cause });
        }
        sourceText = canonicalJson(document);
    } else if (isPlainObject(graphJson)) {
        sourceText = canonicalJson(graphJson);
        inputBytes = Buffer.byteLength(sourceText, 'utf8');
        if (inputBytes > maxBytes) {
            throw comfyError('COMFY_TEMPLATE_TOO_LARGE', 'Template graph exceeds the 2 MiB size limit');
        }
        document = JSON.parse(sourceText);
    } else {
        throw comfyError('COMFY_TEMPLATE_INVALID', 'Template graph must be a JSON object or JSON string');
    }
    return { document, sourceText, inputBytes };
}

function findDanglingReferences(document) {
    const dangling = [];
    function scan(value, inputPath) {
        if (Array.isArray(value)) {
            if (value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1])) {
                if (!Object.prototype.hasOwnProperty.call(document, value[0])) {
                    dangling.push({ inputPath, targetNodeId: value[0] });
                }
                return;
            }
            value.forEach((child, index) => scan(child, `${inputPath}.${index}`));
            return;
        }
        if (isPlainObject(value)) {
            for (const [key, child] of Object.entries(value)) scan(child, `${inputPath}.${key}`);
        }
    }
    for (const [nodeId, node] of Object.entries(document)) scan(node.inputs, `${nodeId}.inputs`);
    return dangling;
}

function inspectGraph(graphJson, maxBytes) {
    const parsed = parseGraphInput(graphJson, maxBytes);
    const { document } = parsed;
    if (Array.isArray(document?.nodes) || Array.isArray(document?.links)) {
        throw comfyError(
            'COMFY_TEMPLATE_UI_FORMAT',
            'ComfyUI에서 API Format으로 내보내 주세요',
        );
    }
    if (!isPlainObject(document) || Object.keys(document).length === 0) {
        throw comfyError('COMFY_TEMPLATE_INVALID', 'Template root must be a non-empty API-format object');
    }

    const errors = [];
    const warnings = [];
    for (const [nodeId, node] of Object.entries(document)) {
        if (!nodeId || nodeId.includes('\0') || DANGEROUS_KEYS.has(nodeId)) {
            errors.push(errorEntry(comfyError('COMFY_TEMPLATE_NODE_ID_INVALID', `Node id is unsafe: ${nodeId}`)));
            continue;
        }
        if (!isPlainObject(node) || !isPlainObject(node.inputs)) {
            errors.push(errorEntry(comfyError('COMFY_TEMPLATE_INVALID', `Node ${nodeId} is malformed`)));
            continue;
        }
        if (typeof node.class_type !== 'string' || node.class_type.trim() === '') {
            errors.push(errorEntry(comfyError(
                'COMFY_TEMPLATE_CLASS_TYPE_MISSING',
                `Node ${nodeId} has a blank or missing class_type`,
            )));
        }
        for (const inputName of Object.keys(node.inputs)) {
            if (!inputName || inputName.includes('\0') || DANGEROUS_KEYS.has(inputName)) {
                errors.push(errorEntry(comfyError(
                    'COMFY_TEMPLATE_INPUT_INVALID',
                    `Node ${nodeId} has an unsafe input name`,
                )));
            }
        }
    }
    if (errors.length > 0) {
        return {
            ...parsed,
            analysis: {
                ok: false,
                errors,
                warnings,
                slots: { positive: [], negative: [], inputImages: [], seeds: [] },
                output: null,
                stats: { bytes: parsed.inputBytes, nodeCount: Object.keys(document).length },
            },
        };
    }

    const dangling = findDanglingReferences(document);
    if (dangling.length > 0) {
        errors.push(errorEntry(comfyError(
            'COMFY_TEMPLATE_DANGLING_REFERENCE',
            `Template contains dangling node references: ${JSON.stringify(dangling)}`,
        )));
    }

    const textInputs = [];
    const positiveRefs = [];
    const negativeRefs = [];
    const loadImages = [];
    const seeds = [];
    const outputCandidates = [];
    const embeddedSlots = [];
    const embeddedImageLiterals = [];
    let linkCount = 0;
    for (const [nodeId, node] of Object.entries(document)) {
        const loadImage = node.class_type === 'LoadImage' ? { nodeId, inputName: 'image' } : null;
        if (loadImage) loadImages.push(loadImage);
        const automatic = OUTPUT_BY_CLASS[node.class_type];
        if (automatic) outputCandidates.push({ nodeId, classType: node.class_type, ...automatic });
        for (const [inputName, value] of Object.entries(node.inputs)) {
            if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1])) {
                linkCount += 1;
            }
            const isSeedInput = inputName === 'seed' || inputName === 'noise_seed';
            const isImageInput = node.class_type === 'LoadImage' && inputName === 'image';
            if (isSeedInput) seeds.push({ nodeId, inputName });
            if (typeof value !== 'string') continue;
            const ref = { nodeId, inputName };
            const exactSlotName = getExactCustomSlotName(value);
            const embeddedJson = inspectEmbeddedJsonInput(value);
            if (embeddedJson) {
                embeddedSlots.push(...embeddedJson.slots.map(candidate => ({ nodeId, inputName, ...candidate })));
                embeddedImageLiterals.push(...embeddedJson.imageLiterals.map(candidate => ({
                    nodeId, inputName, ...candidate,
                })));
            }
            if (!isImageInput && !isSeedInput) textInputs.push(ref);
            if (exactSlotName === 'positive' || exactSlotName === 'negative') {
                if (isImageInput || isSeedInput) {
                    errors.push(errorEntry(comfyError(
                        'COMFY_TEMPLATE_SLOT_OVERLAP',
                        `Prompt slot overlaps a structural slot at ${nodeId}.inputs.${inputName}`,
                    )));
                } else if (exactSlotName === 'positive') positiveRefs.push(ref);
                else negativeRefs.push(ref);
                continue;
            }
            if (exactSlotName && IMAGE_ROLE_PATTERN.test(exactSlotName)) {
                if (!isImageInput) {
                    errors.push(errorEntry(comfyError(
                        'COMFY_TEMPLATE_PLACEHOLDER_INVALID',
                        `{{${exactSlotName}}} is misplaced at ${nodeId}.inputs.${inputName}`,
                    )));
                } else {
                    loadImage.name = exactSlotName;
                }
                continue;
            }
            if (exactSlotName === 'seed') {
                if (!isSeedInput) {
                    errors.push(errorEntry(comfyError(
                        'COMFY_TEMPLATE_PLACEHOLDER_INVALID',
                        `{{seed}} is misplaced at ${nodeId}.inputs.${inputName}`,
                    )));
                }
                continue;
            }
            if (
                embeddedJson?.knownTokenInKey
                || (findKnownCustomSlotToken(value) && (!embeddedJson || embeddedJson.slots.length === 0))
            ) {
                errors.push(errorEntry(comfyError(
                    'COMFY_TEMPLATE_PLACEHOLDER_INVALID',
                    `Template placeholder is not an exact input value at ${nodeId}.inputs.${inputName}`,
                )));
                continue;
            }
            const unrecognized = embeddedJson?.unrecognized ?? findUnrecognizedCustomSlotTokens(value);
            for (const candidate of unrecognized) {
                warnings.push(errorEntry(candidate.suggestion
                    ? comfyError(
                        'COMFY_TEMPLATE_PLACEHOLDER_SUSPICIOUS',
                        `Possible template placeholder typo at ${nodeId}.inputs.${inputName}: ${candidate.token}; did you mean ${candidate.suggestion}?`,
                    )
                    : comfyError(
                        'COMFY_TEMPLATE_PLACEHOLDER_UNKNOWN',
                        `Unknown template placeholder at ${nodeId}.inputs.${inputName}: ${candidate.token}; value will be preserved`,
                    )));
            }
        }
    }
    if (positiveRefs.length > 1) {
        errors.push(errorEntry(comfyError(
            'COMFY_TEMPLATE_POSITIVE_AMBIGUOUS',
            'Template contains more than one {{positive}} literal',
        )));
    }
    if (negativeRefs.length > 1) {
        errors.push(errorEntry(comfyError(
            'COMFY_TEMPLATE_NEGATIVE_AMBIGUOUS',
            'Template contains more than one {{negative}} literal',
        )));
    }
    const declaredImageNames = new Set();
    for (const image of loadImages) {
        if (!image.name) continue;
        if (declaredImageNames.has(image.name)) {
            errors.push(errorEntry(comfyError(
                'COMFY_TEMPLATE_IMAGE_ROLE_AMBIGUOUS',
                `Template contains more than one {{${image.name}}} literal`,
            )));
        }
        declaredImageNames.add(image.name);
    }

    const inputImages = loadImages.length === 1
        ? [{ ...loadImages[0], name: loadImages[0].name ?? 'input_image' }]
        : loadImages;
    const analysis = {
        ok: errors.length === 0,
        errors,
        warnings,
        slots: {
            positive: positiveRefs.length === 1 ? positiveRefs[0] : textInputs,
            negative: negativeRefs.length === 1 ? negativeRefs[0] : textInputs,
            inputImages,
            seeds,
        },
        ...(embeddedSlots.length > 0 ? { embeddedSlots } : {}),
        ...(embeddedImageLiterals.length > 0 ? { embeddedImageLiterals } : {}),
        output: outputCandidates.length === 1
            ? outputCandidates[0]
            : (outputCandidates.length > 1 ? outputCandidates : null),
        stats: {
            bytes: parsed.inputBytes,
            nodeCount: Object.keys(document).length,
            linkCount,
            stringInputCount: textInputs.length,
            loadImageCount: loadImages.length,
            seedInputCount: seeds.length,
            outputCandidateCount: outputCandidates.length,
        },
    };
    return {
        ...parsed,
        analysis,
        textInputs,
        positiveRefs,
        negativeRefs,
        loadImages,
        outputCandidates,
        embeddedSlots,
        embeddedImageLiterals,
    };
}

function scanLegacyPlaceholders(value, currentPath = [], slots = []) {
    if (typeof value === 'string') {
        if (!value.includes('{{') && !value.includes('}}')) return slots;
        const match = value.match(/^\{\{([a-z_]+)\}\}$/);
        if (!match || !LEGACY_SLOT_NAMES.has(match[1])) {
            throw comfyError('COMFY_TEMPLATE_PLACEHOLDER_INVALID', `Invalid template placeholder at ${currentPath.join('.')}`);
        }
        if (currentPath.length !== 3 || currentPath[1] !== 'inputs') {
            throw comfyError('COMFY_TEMPLATE_PLACEHOLDER_INVALID', `Template placeholder is not an input leaf at ${currentPath.join('.')}`);
        }
        slots.push({ name: match[1], path: currentPath });
        return slots;
    }
    if (Array.isArray(value)) {
        value.forEach((child, index) => scanLegacyPlaceholders(child, [...currentPath, index], slots));
        return slots;
    }
    if (isPlainObject(value)) {
        for (const [key, child] of Object.entries(value)) scanLegacyPlaceholders(child, [...currentPath, key], slots);
    }
    return slots;
}

function compileBuiltin(document) {
    if (!isPlainObject(document) || Object.keys(document).length === 0) {
        throw comfyError('COMFY_TEMPLATE_INVALID', 'Template root must be a non-empty object');
    }
    for (const [nodeId, node] of Object.entries(document)) {
        if (!isPlainObject(node) || typeof node.class_type !== 'string' || !isPlainObject(node.inputs)) {
            throw comfyError('COMFY_TEMPLATE_INVALID', `Node ${nodeId} is malformed`);
        }
    }
    const slotPaths = scanLegacyPlaceholders(document);
    for (const required of LEGACY_SLOT_NAMES) {
        if (!slotPaths.some(slot => slot.name === required)) {
            throw comfyError('COMFY_TEMPLATE_INVALID', `Template is missing {{${required}}}`);
        }
    }
    const outputNodes = Object.entries(document)
        .filter(([, node]) => node.class_type === 'VHS_VideoCombine')
        .map(([nodeId]) => nodeId);
    if (outputNodes.length !== 1) {
        throw comfyError('COMFY_TEMPLATE_OUTPUT_INVALID', 'Templates must contain exactly one VHS_VideoCombine output');
    }
    const byName = Object.fromEntries(slotPaths.map(slot => [slot.name, slot.path]));
    return {
        templateSlots: {
            positive: { nodeId: byName.positive[0], inputName: byName.positive[2] },
            inputImages: [{ nodeId: byName.input_image[0], inputName: byName.input_image[2], name: 'input_image' }],
            seeds: [{ nodeId: byName.seed[0], inputName: byName.seed[2] }],
        },
        manifest: [
            { name: 'input_image', type: 'imageAsset', required: true },
            { name: 'positive', type: 'string', required: true },
            {
                name: 'seed', type: 'integer', required: true,
                minimum: 0, maximum: Number.MAX_SAFE_INTEGER,
            },
        ],
        outputDescriptor: {
            nodeId: outputNodes[0],
            classType: 'VHS_VideoCombine',
            historyKey: 'gifs',
            mediaType: 'video/mp4',
        },
    };
}

function expectedRuntimeSlots(templateSlots) {
    const expected = [];
    for (const image of templateSlots.inputImages ?? []) expected.push([image.name, 'imageAsset']);
    if (templateSlots.positive) expected.push(['positive', 'string']);
    if (templateSlots.negative) expected.push(['negative', 'string']);
    if ((templateSlots.seeds ?? []).length > 0) expected.push(['seed', 'integer']);
    if (templateSlots.duration) expected.push(['duration', 'positiveNumber', false]);
    return expected;
}

function validateRuntimeSlots(templateSlots, slots) {
    if (!isPlainObject(slots)) throw comfyError('COMFY_SLOTS_INVALID', 'Template slots must be an object');
    const expected = expectedRuntimeSlots(templateSlots);
    const names = new Set(expected.map(([name]) => name));
    for (const [name, , required = true] of expected) {
        if (!required) continue;
        if (!Object.prototype.hasOwnProperty.call(slots, name)) {
            throw comfyError('COMFY_SLOT_MISSING', `Required template slot is missing: ${name}`);
        }
    }
    for (const supplied of Object.keys(slots)) {
        if (!names.has(supplied)) throw comfyError('COMFY_SLOT_UNKNOWN', `Template slot is not declared: ${supplied}`);
    }
    for (const [name, type] of expected) {
        const value = slots[name];
        if (type === 'string' && (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1024 * 1024)) {
            throw comfyError('COMFY_SLOT_INVALID', `${name} must be a string no larger than 1 MiB`);
        }
        if (type === 'integer' && (!Number.isSafeInteger(value) || value < 0)) {
            throw comfyError('COMFY_SLOT_INVALID', `${name} must be a non-negative safe integer`);
        }
        if (type === 'positiveNumber' && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
            throw comfyError('COMFY_SLOT_INVALID', `${name} must be a positive finite number`);
        }
        if (
            type === 'imageAsset'
            && (
                typeof value !== 'string'
                || value.length === 0
                || value.length > 1024
                || value.includes('\\')
                || path.posix.isAbsolute(value)
                || value.split('/').includes('..')
            )
        ) {
            throw comfyError('COMFY_SLOT_INVALID', `${name} must be a safe Comfy input path or asset id`);
        }
    }
}

function resolveRuntimeSlots(templateSlots, slots) {
    if (!isPlainObject(slots)) throw comfyError('COMFY_SLOTS_INVALID', 'Template slots must be an object');
    const resolved = { ...slots };
    if (templateSlots.duration && !Object.prototype.hasOwnProperty.call(resolved, 'duration')) {
        resolved.duration = templateSlots.duration.defaultValue;
    }
    validateRuntimeSlots(templateSlots, resolved);
    return resolved;
}

function setInput(document, ref, value) {
    if (!Object.prototype.hasOwnProperty.call(document, ref.nodeId)) {
        throw comfyError('COMFY_TEMPLATE_SNAPSHOT_INVALID', `Stored slot node is missing: ${ref.nodeId}`);
    }
    document[ref.nodeId].inputs[ref.inputName] = value;
}

function embeddedRefKey(ref) {
    return JSON.stringify([ref.nodeId, ref.inputName]);
}

function assertEmbeddedSnapshotBindings(document, templateSlots) {
    const embedded = templateSlots.embedded;
    const representatives = [
        templateSlots.positive,
        templateSlots.negative,
        ...(templateSlots.inputImages ?? []),
        ...(templateSlots.seeds ?? []),
    ].filter(ref => ref?.embedded === true);
    if (embedded == null) {
        if (representatives.length > 0) {
            throw comfyError('COMFY_TEMPLATE_SNAPSHOT_INVALID', 'Stored embedded slot representative has no binding');
        }
        return;
    }
    if (!isPlainObject(embedded) || !Array.isArray(embedded.slots) || !Array.isArray(embedded.inputImages)) {
        throw comfyError('COMFY_TEMPLATE_SNAPSHOT_INVALID', 'Stored embedded slot bindings are malformed');
    }
    const seen = new Set();
    for (const [type, bindings] of [['slot', embedded.slots], ['image', embedded.inputImages]]) {
        for (const binding of bindings) {
            const source = type === 'slot' ? binding?.token : binding?.literal;
            const key = embeddedCandidateKey(binding?.nodeId, binding?.inputName, source);
            if (
                !isPlainObject(binding)
                || typeof binding.nodeId !== 'string'
                || typeof binding.inputName !== 'string'
                || typeof source !== 'string'
                || typeof binding.name !== 'string'
                || !Number.isSafeInteger(binding.occurrences)
                || binding.occurrences < 1
                || seen.has(key)
                || !Object.prototype.hasOwnProperty.call(document, binding.nodeId)
                || typeof document[binding.nodeId]?.inputs?.[binding.inputName] !== 'string'
            ) {
                throw comfyError('COMFY_TEMPLATE_SNAPSHOT_INVALID', 'Stored embedded slot binding is invalid');
            }
            if (
                (type === 'slot' && (getExactCustomSlotName(binding.token) !== binding.name))
                || (type === 'image' && (
                    !IMAGE_ROLE_PATTERN.test(binding.name)
                    || !EMBEDDED_IMAGE_LITERAL_PATTERN.test(binding.literal)
                    || typeof binding.pathHint !== 'string'
                ))
            ) {
                throw comfyError('COMFY_TEMPLATE_SNAPSHOT_INVALID', 'Stored embedded slot binding contradicts its source');
            }
            seen.add(key);
        }
    }
    for (const image of embedded.inputImages) {
        if (embedded.slots.some(slot => (
            slot.nodeId === image.nodeId
            && slot.inputName === image.inputName
            && image.literal.includes(slot.token)
        ))) {
            throw comfyError('COMFY_TEMPLATE_SNAPSHOT_INVALID', 'Stored embedded bindings overlap');
        }
    }

    const embeddedInputKeys = new Set([...embedded.slots, ...embedded.inputImages].map(embeddedRefKey));
    const directRefs = [
        templateSlots.positive,
        templateSlots.negative,
        ...(templateSlots.inputImages ?? []),
        ...(templateSlots.seeds ?? []),
    ].filter(ref => ref && ref.embedded !== true);
    if (directRefs.some(ref => embeddedInputKeys.has(embeddedRefKey(ref)))) {
        throw comfyError('COMFY_TEMPLATE_SNAPSHOT_INVALID', 'Stored direct slot overlaps an embedded input');
    }

    const representativeMatches = (ref, name, candidates) => candidates.some(candidate => (
        candidate.name === name
        && candidate.nodeId === ref.nodeId
        && candidate.inputName === ref.inputName
    ));
    if (
        (templateSlots.positive?.embedded === true
            && !representativeMatches(templateSlots.positive, 'positive', embedded.slots))
        || (templateSlots.negative?.embedded === true
            && !representativeMatches(templateSlots.negative, 'negative', embedded.slots))
        || (templateSlots.seeds ?? []).some(ref => (
            ref.embedded === true && !representativeMatches(ref, 'seed', embedded.slots)
        ))
        || (templateSlots.inputImages ?? []).some(ref => (
            ref.embedded === true
            && !representativeMatches(ref, ref.name, [...embedded.slots, ...embedded.inputImages])
        ))
    ) {
        throw comfyError('COMFY_TEMPLATE_SNAPSHOT_INVALID', 'Stored embedded slot representative is inconsistent');
    }
    for (const binding of embedded.slots) {
        const declared = binding.name === 'positive'
            ? Boolean(templateSlots.positive)
            : binding.name === 'negative'
                ? Boolean(templateSlots.negative)
                : binding.name === 'seed'
                    ? (templateSlots.seeds ?? []).length > 0
                    : (templateSlots.inputImages ?? []).some(image => image.name === binding.name);
        if (!declared) {
            throw comfyError('COMFY_TEMPLATE_SNAPSHOT_INVALID', 'Stored embedded slot has no logical runtime slot');
        }
    }
    for (const binding of embedded.inputImages) {
        if (!(templateSlots.inputImages ?? []).some(image => image.name === binding.name)) {
            throw comfyError('COMFY_TEMPLATE_SNAPSHOT_INVALID', 'Stored embedded image has no logical runtime slot');
        }
    }
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function transformEmbeddedJsonValue(value, tokenBindings, imageBindings, slots, counts) {
    if (typeof value === 'string') {
        const image = imageBindings.find(binding => binding.literal === value);
        if (image) {
            counts.set(image, (counts.get(image) ?? 0) + 1);
            return String(slots[image.name]);
        }
        if (tokenBindings.length === 0) return value;
        const byToken = new Map(tokenBindings.map(binding => [binding.token, binding]));
        const pattern = new RegExp([...byToken.keys()].map(escapeRegExp).join('|'), 'g');
        return value.replace(pattern, token => {
            const binding = byToken.get(token);
            counts.set(binding, (counts.get(binding) ?? 0) + 1);
            return String(slots[binding.name]);
        });
    }
    if (Array.isArray(value)) {
        return value.map(child => transformEmbeddedJsonValue(child, tokenBindings, imageBindings, slots, counts));
    }
    if (isPlainObject(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [
            key,
            transformEmbeddedJsonValue(child, tokenBindings, imageBindings, slots, counts),
        ]));
    }
    return value;
}

function applyEmbeddedInputs(document, templateSlots, slots) {
    const embedded = templateSlots.embedded;
    if (!embedded) return;
    const groups = new Map();
    for (const binding of [...embedded.slots, ...embedded.inputImages]) {
        const key = embeddedRefKey(binding);
        if (!groups.has(key)) groups.set(key, { ref: binding, tokens: [], images: [] });
        groups.get(key)[Object.prototype.hasOwnProperty.call(binding, 'token') ? 'tokens' : 'images'].push(binding);
    }
    for (const { ref, tokens, images } of groups.values()) {
        const source = document[ref.nodeId].inputs[ref.inputName];
        let parsed;
        try {
            parsed = JSON.parse(source);
        } catch (cause) {
            throw comfyError('COMFY_TEMPLATE_SNAPSHOT_INVALID', 'Stored embedded input is not valid JSON', { cause });
        }
        const counts = new Map();
        const transformed = transformEmbeddedJsonValue(parsed, tokens, images, slots, counts);
        for (const binding of [...tokens, ...images]) {
            if ((counts.get(binding) ?? 0) !== binding.occurrences) {
                throw comfyError('COMFY_TEMPLATE_SNAPSHOT_INVALID', 'Stored embedded occurrence count does not match');
            }
        }
        document[ref.nodeId].inputs[ref.inputName] = JSON.stringify(transformed);
    }
}

function instantiateDocument(document, templateSlots, slots, outputDescriptor) {
    assertEmbeddedSnapshotBindings(document, templateSlots);
    const resolvedSlots = resolveRuntimeSlots(templateSlots, slots);
    const prompt = structuredClone(document);
    if (templateSlots.positive && !templateSlots.positive.embedded) setInput(prompt, templateSlots.positive, resolvedSlots.positive);
    if (templateSlots.negative && !templateSlots.negative.embedded) setInput(prompt, templateSlots.negative, resolvedSlots.negative);
    for (const image of templateSlots.inputImages ?? []) {
        if (!image.embedded) setInput(prompt, image, resolvedSlots[image.name]);
    }
    for (const seed of templateSlots.seeds ?? []) {
        if (!seed.embedded) setInput(prompt, seed, resolvedSlots.seed);
    }
    if (templateSlots.duration) setInput(prompt, templateSlots.duration, resolvedSlots.duration);
    applyEmbeddedInputs(prompt, templateSlots, resolvedSlots);
    return {
        prompt,
        outputDescriptor,
        outputNodeId: outputDescriptor.nodeId,
        outputKey: outputDescriptor.historyKey,
    };
}

function selectNodeRef(value, candidates, code) {
    if (!isPlainObject(value) || typeof value.nodeId !== 'string' || typeof value.inputName !== 'string') {
        throw comfyError(code, 'Slot resolution must identify nodeId and inputName');
    }
    const match = candidates.find(candidate => candidate.nodeId === value.nodeId && candidate.inputName === value.inputName);
    if (!match) throw comfyError(code, 'Slot resolution does not match an analyzed candidate');
    return { nodeId: match.nodeId, inputName: match.inputName };
}

function resolveDurationSlot(document, value) {
    if (value == null) return undefined;
    if (!isPlainObject(value) || typeof value.nodeId !== 'string' || typeof value.inputName !== 'string') {
        throw comfyError(
            'COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID',
            'Duration resolution must identify nodeId and inputName',
        );
    }
    const node = Object.prototype.hasOwnProperty.call(document, value.nodeId)
        ? document[value.nodeId]
        : null;
    const defaultValue = node && Object.prototype.hasOwnProperty.call(node.inputs, value.inputName)
        ? node.inputs[value.inputName]
        : undefined;
    if (typeof defaultValue !== 'number' || !Number.isFinite(defaultValue) || defaultValue <= 0) {
        throw comfyError(
            'COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID',
            'Duration resolution must target a positive finite numeric input',
        );
    }
    return { nodeId: value.nodeId, inputName: value.inputName, defaultValue };
}

function embeddedCandidateKey(nodeId, inputName, source) {
    return JSON.stringify([nodeId, inputName, source]);
}

function resolveEmbeddedCandidates(candidates, supplied, type) {
    const sourceName = type === 'slot' ? 'token' : 'literal';
    const expected = new Map(candidates.map(candidate => [
        embeddedCandidateKey(candidate.nodeId, candidate.inputName, candidate[sourceName]),
        candidate,
    ]));
    if (expected.size === 0) {
        if (supplied != null && (!Array.isArray(supplied) || supplied.length > 0)) {
            throw comfyError('COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID', 'Embedded resolution contains an unanalyzed candidate');
        }
        return [];
    }
    if (!Array.isArray(supplied)) {
        throw comfyError('COMFY_TEMPLATE_RESOLUTION_REQUIRED', 'Every embedded template candidate requires approval');
    }
    const resolved = [];
    const seen = new Set();
    for (const item of supplied) {
        if (
            !isPlainObject(item)
            || typeof item.nodeId !== 'string'
            || typeof item.inputName !== 'string'
            || typeof item[sourceName] !== 'string'
        ) {
            throw comfyError('COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID', 'Embedded resolution is malformed');
        }
        if (type === 'image' && (typeof item.name !== 'string' || !IMAGE_ROLE_PATTERN.test(item.name))) {
            throw comfyError('COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID', 'Embedded image role is invalid');
        }
        const key = embeddedCandidateKey(item.nodeId, item.inputName, item[sourceName]);
        if (seen.has(key) || !expected.has(key)) {
            throw comfyError('COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID', 'Embedded resolution is duplicated or was not analyzed');
        }
        seen.add(key);
        const candidate = expected.get(key);
        resolved.push({
            ...candidate,
            name: type === 'slot' ? candidate.token.slice(2, -2) : item.name,
        });
    }
    if (seen.size !== expected.size) {
        throw comfyError('COMFY_TEMPLATE_RESOLUTION_REQUIRED', 'Every embedded template candidate requires approval');
    }
    return resolved;
}

function resolveEmbeddedBindings(inspected, value) {
    if (value != null && !isPlainObject(value)) {
        throw comfyError('COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID', 'slotResolution.embedded must be an object');
    }
    const resolution = value ?? {};
    const slots = resolveEmbeddedCandidates(inspected.embeddedSlots, resolution.slots, 'slot');
    const inputImages = resolveEmbeddedCandidates(
        inspected.embeddedImageLiterals,
        resolution.inputImages,
        'image',
    );
    for (const image of inputImages) {
        if (slots.some(slot => (
            slot.nodeId === image.nodeId
            && slot.inputName === image.inputName
            && image.literal.includes(slot.token)
        ))) {
            throw comfyError(
                'COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID',
                'Embedded token and image approvals overlap in the same JSON value',
            );
        }
    }
    return { slots, inputImages };
}

function isEmbeddedInputRef(embedded, ref) {
    return [...embedded.slots, ...embedded.inputImages].some(candidate => (
        candidate.nodeId === ref.nodeId && candidate.inputName === ref.inputName
    ));
}

function resolveTemplateSlots(inspected, slotResolution) {
    const resolution = slotResolution ?? {};
    if (!isPlainObject(resolution)) {
        throw comfyError('COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID', 'slotResolution must be an object');
    }
    const embedded = resolveEmbeddedBindings(inspected, resolution.embedded);
    const embeddedPositive = embedded.slots.find(slot => slot.name === 'positive');
    const positive = inspected.positiveRefs.length === 1
        ? inspected.positiveRefs[0]
        : resolution.positive != null
            ? selectNodeRef(
                resolution.positive,
                inspected.textInputs,
                'COMFY_TEMPLATE_RESOLUTION_REQUIRED',
            )
            : embeddedPositive
                ? { nodeId: embeddedPositive.nodeId, inputName: embeddedPositive.inputName, embedded: true }
                : selectNodeRef(
                    resolution.positive,
                    inspected.textInputs,
                    'COMFY_TEMPLATE_RESOLUTION_REQUIRED',
                );
    let negative;
    if (inspected.negativeRefs.length === 1) negative = inspected.negativeRefs[0];
    else if (resolution.negative != null) {
        negative = selectNodeRef(
            resolution.negative,
            inspected.textInputs,
            'COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID',
        );
    } else {
        const embeddedNegative = embedded.slots.find(slot => slot.name === 'negative');
        if (embeddedNegative) {
            negative = { nodeId: embeddedNegative.nodeId, inputName: embeddedNegative.inputName, embedded: true };
        }
    }
    if (
        negative
        && negative.nodeId === positive.nodeId
        && negative.inputName === positive.inputName
        && (!positive.embedded || !negative.embedded)
    ) {
        throw comfyError('COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID', 'positive and negative cannot use the same input');
    }

    let inputImages;
    if (inspected.loadImages.length === 0) {
        if (Array.isArray(resolution.inputImages) && resolution.inputImages.length > 0) {
            throw comfyError('COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID', 'Template has no LoadImage nodes to resolve');
        }
        inputImages = [];
    } else if (inspected.loadImages.length === 1) {
        if (Array.isArray(resolution.inputImages) && resolution.inputImages.length > 0) {
            throw comfyError('COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID', 'A single LoadImage is bound automatically');
        }
        inputImages = [{
            ...inspected.loadImages[0],
            name: inspected.loadImages[0].name ?? 'input_image',
        }];
    } else {
        if (!Array.isArray(resolution.inputImages) || resolution.inputImages.length !== inspected.loadImages.length) {
            throw comfyError('COMFY_TEMPLATE_RESOLUTION_REQUIRED', 'Every LoadImage node requires a role mapping');
        }
        const nodeIds = new Set();
        const names = new Set();
        inputImages = resolution.inputImages.map(item => {
            if (!isPlainObject(item) || typeof item.nodeId !== 'string' || typeof item.name !== 'string') {
                throw comfyError('COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID', 'Image slot mappings require nodeId and name');
            }
            if (!IMAGE_ROLE_PATTERN.test(item.name) || names.has(item.name) || nodeIds.has(item.nodeId)) {
                throw comfyError('COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID', 'Image slot role is invalid or duplicated');
            }
            const candidate = inspected.loadImages.find(entry => entry.nodeId === item.nodeId);
            if (!candidate) throw comfyError('COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID', 'Image slot node was not detected');
            if (candidate.name && candidate.name !== item.name) {
                throw comfyError('COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID', 'Image slot mapping contradicts an exact template literal');
            }
            names.add(item.name);
            nodeIds.add(item.nodeId);
            return { ...candidate, name: item.name };
        });
        if (nodeIds.size !== inspected.loadImages.length) {
            throw comfyError('COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID', 'Image slot mappings must cover every LoadImage once');
        }
    }
    const embeddedImageRefs = [
        ...embedded.slots.filter(slot => IMAGE_ROLE_PATTERN.test(slot.name)),
        ...embedded.inputImages,
    ];
    for (const candidate of embeddedImageRefs) {
        if (inputImages.some(image => image.name === candidate.name)) continue;
        inputImages.push({
            nodeId: candidate.nodeId,
            inputName: candidate.inputName,
            name: candidate.name,
            embedded: true,
        });
    }
    const seeds = [...inspected.analysis.slots.seeds];
    if (seeds.length === 0) {
        const embeddedSeed = embedded.slots.find(slot => slot.name === 'seed');
        if (embeddedSeed) {
            seeds.push({ nodeId: embeddedSeed.nodeId, inputName: embeddedSeed.inputName, embedded: true });
        }
    }
    const duration = resolveDurationSlot(inspected.document, resolution.duration);
    const structuralRefs = [positive, negative, ...inputImages, ...seeds].filter(Boolean);
    if (duration && (
        structuralRefs.some(ref => ref.nodeId === duration.nodeId && ref.inputName === duration.inputName)
        || isEmbeddedInputRef(embedded, duration)
    )) {
        throw comfyError(
            'COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID',
            'Duration cannot overwrite another template slot',
        );
    }
    for (const ref of structuralRefs) {
        if (!ref.embedded && isEmbeddedInputRef(embedded, ref)) {
            throw comfyError(
                'COMFY_TEMPLATE_SLOT_RESOLUTION_INVALID',
                'A direct slot cannot overwrite an embedded JSON input',
            );
        }
    }
    return {
        positive,
        ...(negative ? { negative } : {}),
        inputImages,
        seeds,
        ...(duration ? { duration } : {}),
        ...((embedded.slots.length > 0 || embedded.inputImages.length > 0) ? { embedded } : {}),
    };
}

function validateOutputDescriptor(document, descriptor) {
    if (
        !isPlainObject(descriptor)
        || typeof descriptor.nodeId !== 'string'
        || typeof descriptor.classType !== 'string'
        || !SAFE_HISTORY_KEY_PATTERN.test(descriptor.historyKey)
        || DANGEROUS_KEYS.has(descriptor.historyKey)
        || !ALLOWED_MEDIA_TYPES.has(descriptor.mediaType)
    ) {
        throw comfyError('COMFY_TEMPLATE_OUTPUT_INVALID', 'Output descriptor is invalid');
    }
    const node = Object.prototype.hasOwnProperty.call(document, descriptor.nodeId)
        ? document[descriptor.nodeId]
        : null;
    if (!node || node.class_type !== descriptor.classType) {
        throw comfyError('COMFY_TEMPLATE_OUTPUT_INVALID', 'Output descriptor node and class_type do not match');
    }
    return {
        nodeId: descriptor.nodeId,
        classType: descriptor.classType,
        historyKey: descriptor.historyKey,
        mediaType: descriptor.mediaType,
    };
}

function assertRegistrationShape(input, templateSlots, outputDescriptor) {
    if (typeof input.name !== 'string' || input.name.trim() === '' || input.name.length > 200) {
        throw comfyError('COMFY_TEMPLATE_METADATA_INVALID', 'Template name must be 1 to 200 characters');
    }
    if (!Object.prototype.hasOwnProperty.call(MODES_BY_KIND, input.kind) || !MODES_BY_KIND[input.kind].has(input.mode)) {
        throw comfyError('COMFY_TEMPLATE_MODE_INVALID', 'Template kind and mode are incompatible');
    }
    if (!PROMPT_PROFILES.has(input.promptProfile)) {
        throw comfyError('COMFY_TEMPLATE_PROMPT_PROFILE_INVALID', 'Template promptProfile is invalid');
    }
    const mediaKind = outputDescriptor.mediaType.startsWith('video/') ? 'video' : 'image';
    if (mediaKind !== input.kind) {
        throw comfyError('COMFY_TEMPLATE_KIND_OUTPUT_MISMATCH', 'Template kind does not match its output media type');
    }
    // Cardinality counts DISTINCT image roles, not bindings: execution uploads
    // one image per role name and substitutes it into every binding that
    // carries it, so a direct LoadImage plus an embedded literal sharing
    // input_image (Dasiwa I2VA) — or several literals on one role (the loop
    // recipe) — is still a one-image template.
    const imageRoles = new Set(templateSlots.inputImages.map(image => image.name));
    for (const slot of templateSlots.embedded?.slots ?? []) {
        if (IMAGE_ROLE_PATTERN.test(slot.name)) imageRoles.add(slot.name);
    }
    for (const binding of templateSlots.embedded?.inputImages ?? []) imageRoles.add(binding.name);
    const imageCount = imageRoles.size;
    const validCardinality = input.mode === 't2v' || input.mode === 't2i'
        ? imageCount === 0
        // l2v is i2v's mirror: one keyframe, anchored at the end instead of the start.
        : input.mode === 'i2v' || input.mode === 'i2i' || input.mode === 'l2v'
            ? imageCount === 1
            : input.mode === 'flf2v' || imageCount >= 1;
    if (!validCardinality) {
        throw comfyError('COMFY_TEMPLATE_IMAGE_CARDINALITY', 'Template mode does not match its LoadImage cardinality');
    }
}

function buildManifest(templateSlots) {
    const manifest = [];
    for (const image of templateSlots.inputImages ?? []) {
        manifest.push({ name: image.name, type: 'imageAsset', required: true });
    }
    if (templateSlots.positive) manifest.push({ name: 'positive', type: 'string', required: true });
    if (templateSlots.negative) manifest.push({ name: 'negative', type: 'string', required: true });
    if ((templateSlots.seeds ?? []).length > 0) {
        manifest.push({
            name: 'seed', type: 'integer', required: true,
            minimum: 0, maximum: Number.MAX_SAFE_INTEGER,
        });
    }
    if (templateSlots.duration) {
        manifest.push({
            name: 'duration', type: 'number', required: false,
            exclusiveMinimum: 0, defaultValue: templateSlots.duration.defaultValue,
        });
    }
    return manifest;
}

function createTemplateRegistry(options = {}) {
    const templateDir = path.resolve(options.templateDir);
    const store = options.store ?? null;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_TEMPLATE_BYTES;
    const maxCustomBytes = options.maxCustomBytes ?? DEFAULT_MAX_CUSTOM_TEMPLATE_BYTES;

    function compileWithContext(document, templateId) {
        try {
            return compileBuiltin(document);
        } catch (error) {
            if (typeof error?.code !== 'string' || !error.code.startsWith('COMFY_')) throw error;
            throw comfyError(error.code, `Template ${templateId}: ${error.message}`, {
                cause: error, httpStatus: error.httpStatus, uncertain: error.uncertain,
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

    function publicCustom(record) {
        return {
            id: record.id,
            hash: sha256(Buffer.from(record.graphJson, 'utf8')),
            source: 'custom',
            name: record.name,
            kind: record.kind,
            mode: record.mode,
            slots: buildManifest(record.slots),
            slotBindings: record.slots,
            outputDescriptor: record.outputDescriptor,
            promptProfile: record.promptProfile,
            createdAt: record.createdAt,
        };
    }

    async function loadBuiltin(templateId) {
        if (!TEMPLATE_ID_PATTERN.test(templateId)) throw comfyError('COMFY_TEMPLATE_ID_INVALID', 'Invalid template ID');
        const root = await resolveRoot();
        const candidate = path.join(root, `${templateId}.json`);
        assertContained(root, candidate);
        const stat = await fs.promises.lstat(candidate).catch(() => null);
        if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
            throw comfyError('COMFY_TEMPLATE_NOT_FOUND', `Template ${templateId} was not found`, { httpStatus: 404 });
        }
        if (stat.size > maxBytes) throw comfyError('COMFY_TEMPLATE_TOO_LARGE', `Template ${templateId} exceeds the size limit`);
        const real = await fs.promises.realpath(candidate);
        assertContained(root, real);
        const handle = await fs.promises.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
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
        const meta = BUILTIN_META[templateId] ?? {
            name: templateId, kind: 'video', mode: 'i2v', promptProfile: 'wan-motion',
        };
        return {
            id: templateId,
            hash: sha256(bytes),
            sourceText: bytes.toString('utf8'),
            document,
            source: 'builtin',
            ...meta,
            ...compiled,
        };
    }

    async function loadTemplate(templateId) {
        if (CUSTOM_TEMPLATE_ID_PATTERN.test(templateId) && store) {
            const record = store.getCustomTemplate(templateId);
            if (!record) throw comfyError('COMFY_TEMPLATE_NOT_FOUND', `Template ${templateId} was not found`, { httpStatus: 404 });
            const document = JSON.parse(record.graphJson);
            const outputDescriptor = validateOutputDescriptor(document, record.outputDescriptor);
            return {
                ...publicCustom(record),
                sourceText: record.graphJson,
                document,
                templateSlots: record.slots,
                manifest: buildManifest(record.slots),
                outputDescriptor,
            };
        }
        return loadBuiltin(templateId);
    }

    async function listTemplates(kind = null) {
        if (kind != null && !Object.prototype.hasOwnProperty.call(MODES_BY_KIND, kind)) {
            throw comfyError('COMFY_TEMPLATE_KIND_INVALID', 'Template kind filter is invalid');
        }
        const builtins = [];
        if (kind == null || kind === 'video') {
            const root = await resolveRoot();
            const entries = await fs.promises.readdir(root, { withFileTypes: true });
            const ids = entries
                .filter(entry => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json'))
                .map(entry => entry.name.slice(0, -5))
                .filter(id => TEMPLATE_ID_PATTERN.test(id))
                .sort();
            const loaded = await Promise.allSettled(ids.map(loadBuiltin));
            loaded.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                    const value = result.value;
                    builtins.push({
                        id: value.id,
                        hash: value.hash,
                        slots: value.manifest,
                        source: 'builtin',
                        name: value.name,
                        kind: value.kind,
                        mode: value.mode,
                        outputDescriptor: value.outputDescriptor,
                        promptProfile: value.promptProfile,
                    });
                } else {
                    builtins.push({ id: ids[index], source: 'builtin', error: errorEntry(result.reason) });
                }
            });
        }
        const custom = store ? store.listCustomTemplates(kind).map(publicCustom) : [];
        return [...builtins, ...custom];
    }

    function analyzeTemplate(graphJson) {
        try {
            return inspectGraph(graphJson, maxCustomBytes).analysis;
        } catch (error) {
            return {
                ok: false,
                errors: [errorEntry(error)],
                warnings: [],
                slots: { positive: [], negative: [], inputImages: [], seeds: [] },
                output: null,
                stats: {},
            };
        }
    }

    async function registerTemplate(input) {
        if (!store) throw comfyError('COMFY_TEMPLATE_STORE_UNAVAILABLE', 'Custom template storage is unavailable', { httpStatus: 503 });
        if (!isPlainObject(input)) throw comfyError('COMFY_TEMPLATE_METADATA_INVALID', 'Registration request is invalid');
        const normalizedInput = {
            ...input,
            promptProfile: input.promptProfile ?? (input.kind === 'image' ? 'image-tags' : 'wan-motion'),
        };
        const inspected = inspectGraph(input.graphJson, maxCustomBytes);
        if (!inspected.analysis.ok) {
            const first = inspected.analysis.errors[0];
            throw comfyError(first.code, first.message);
        }
        const templateSlots = resolveTemplateSlots(inspected, input.slotResolution);
        let outputDescriptor;
        if (input.outputDescriptor != null) {
            outputDescriptor = validateOutputDescriptor(inspected.document, input.outputDescriptor);
        } else if (inspected.outputCandidates.length === 1) {
            outputDescriptor = inspected.outputCandidates[0];
        } else {
            throw comfyError('COMFY_TEMPLATE_RESOLUTION_REQUIRED', 'An explicit outputDescriptor is required');
        }
        assertRegistrationShape(normalizedInput, templateSlots, outputDescriptor);
        const id = sha256(Buffer.from(inspected.sourceText, 'utf8')).toLowerCase();
        const stored = store.createCustomTemplate({
            id,
            name: normalizedInput.name,
            kind: normalizedInput.kind,
            mode: normalizedInput.mode,
            graphJson: inspected.sourceText,
            slots: templateSlots,
            outputDescriptor,
            promptProfile: normalizedInput.promptProfile,
        });
        return { created: stored.created, template: publicCustom(stored.template) };
    }

    async function removeTemplate(templateId) {
        if (Object.prototype.hasOwnProperty.call(BUILTIN_META, templateId)) {
            throw comfyError('COMFY_TEMPLATE_BUILTIN_IMMUTABLE', 'Built-in templates cannot be removed');
        }
        if (!CUSTOM_TEMPLATE_ID_PATTERN.test(templateId)) throw comfyError('COMFY_TEMPLATE_ID_INVALID', 'Invalid template ID');
        if (!store) throw comfyError('COMFY_TEMPLATE_STORE_UNAVAILABLE', 'Custom template storage is unavailable', { httpStatus: 503 });
        const removed = store.removeCustomTemplate(templateId);
        if (!removed) throw comfyError('COMFY_TEMPLATE_NOT_FOUND', `Template ${templateId} was not found`, { httpStatus: 404 });
        return { id: templateId, removed: true };
    }

    async function instantiate(templateId, slots) {
        const template = await loadTemplate(templateId);
        const compiled = instantiateDocument(
            template.document,
            template.templateSlots,
            slots,
            template.outputDescriptor,
        );
        return { ...compiled, templateHash: template.hash };
    }

    function instantiateSnapshot(sourceText, expectedHash, slots, templateId = 'stored snapshot', snapshot = {}) {
        if (typeof sourceText !== 'string' || sha256(Buffer.from(sourceText, 'utf8')) !== expectedHash) {
            throw comfyError('COMFY_TEMPLATE_SNAPSHOT_INVALID', 'Stored template snapshot hash does not match');
        }
        let document;
        try {
            document = JSON.parse(sourceText);
        } catch (cause) {
            throw comfyError('COMFY_TEMPLATE_SNAPSHOT_INVALID', 'Stored template snapshot is invalid JSON', { cause });
        }
        const compiled = snapshot.templateSlots && snapshot.outputDescriptor
            ? {
                templateSlots: snapshot.templateSlots,
                outputDescriptor: validateOutputDescriptor(document, snapshot.outputDescriptor),
            }
            : compileWithContext(document, templateId);
        return {
            ...instantiateDocument(document, compiled.templateSlots, slots, compiled.outputDescriptor),
            templateHash: expectedHash,
        };
    }

    return {
        listTemplates,
        analyzeTemplate,
        registerTemplate,
        removeTemplate,
        resolveRuntimeSlots,
        instantiate,
        instantiateSnapshot,
        loadTemplate,
    };
}

module.exports = {
    createTemplateRegistry,
    TEMPLATE_ID_PATTERN,
    CUSTOM_TEMPLATE_ID_PATTERN,
    DEFAULT_MAX_TEMPLATE_BYTES,
    DEFAULT_MAX_CUSTOM_TEMPLATE_BYTES,
};
