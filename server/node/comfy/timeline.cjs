'use strict';

// The `{{timeline}}` slot: the plugin sends a SPEC naming its own inlay assets,
// the dispatcher uploads each one and resolves it, and this module assembles the
// single JSON document the MiniMax H3 Director expects on `timeline_data`.
//
// The limits below are the workflow's own contract — the Director addresses a
// fixed slot space (image 0..8, video 0..2, audio 0..2) and refuses more — not a
// policy cap this layer invented.

const { comfyError } = require('./errors.cjs');
const { isSafeAssetId } = require('./assetStore.cjs');

const TIMELINE_DOCUMENT_VERSION = 1;
const TIMELINE_MEDIA_TYPES = Object.freeze(['image', 'video', 'audio']);
const TIMELINE_SLOT_CONTRACT = Object.freeze({
    image: Object.freeze({ maxSlot: 8, maxItems: 9 }),
    video: Object.freeze({ maxSlot: 2, maxItems: 3 }),
    audio: Object.freeze({ maxSlot: 2, maxItems: 3 }),
});
const TIMELINE_MAX_ITEMS = 12;
const TIMELINE_MEDIA_MODES = new Set(['video_audio']);
const TIMELINE_ITEM_FIELDS = new Set([
    'slot', 'type', 'assetId', 'start', 'duration',
    'trim_start', 'trim_end', 'source_duration', 'media_mode',
    // Attached by the dispatcher once the asset is on Comfy, exactly as an
    // imageAsset slot carries the uploaded path by the time it instantiates.
    'value', 'source_width', 'source_height',
]);
const TIMELINE_ASSET_KEY_PREFIX = 'timeline#';

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message) {
    return comfyError('COMFY_SLOT_INVALID', message);
}

function overContract(message) {
    return comfyError('COMFY_SLOT_TIMELINE_LIMIT', message);
}

function assertOptionalNumber(item, field, label, accept) {
    if (item[field] === undefined) return;
    const value = item[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || !accept(value)) {
        throw invalid(`timeline ${label} must be ${describeNumber(field)}`);
    }
}

function describeNumber(field) {
    if (field === 'duration' || field === 'source_duration') return 'a positive finite number';
    if (field === 'trim_end') return 'a finite number greater than trim_start';
    return 'a non-negative finite number';
}

function validateTimelineItem(item, label, counts, addresses, typeByAsset) {
    if (!isPlainObject(item)) throw invalid(`timeline ${label} must be an object`);
    for (const field of Object.keys(item)) {
        if (!TIMELINE_ITEM_FIELDS.has(field)) throw invalid(`timeline ${label} has an unknown field: ${field}`);
    }
    if (!TIMELINE_MEDIA_TYPES.includes(item.type)) {
        throw invalid(`timeline ${label} type must be image, video, or audio`);
    }
    if (!isSafeAssetId(item.assetId)) throw invalid(`timeline ${label} assetId is invalid`);
    const known = typeByAsset.get(item.assetId);
    if (known !== undefined && known !== item.type) {
        throw invalid(`timeline ${label} reuses ${item.assetId} with a different media type`);
    }
    typeByAsset.set(item.assetId, item.type);

    const contract = TIMELINE_SLOT_CONTRACT[item.type];
    if (!Number.isSafeInteger(item.slot) || item.slot < 0) {
        throw invalid(`timeline ${label} slot must be a non-negative integer`);
    }
    if (item.slot > contract.maxSlot) {
        throw overContract(`timeline ${label} slot ${item.slot} is outside the ${item.type} range 0..${contract.maxSlot}`);
    }
    const address = `${item.type}:${item.slot}`;
    if (addresses.has(address)) throw invalid(`timeline slot ${address} is used more than once`);
    addresses.add(address);
    counts[item.type] += 1;
    if (counts[item.type] > contract.maxItems) {
        throw overContract(`timeline carries more than ${contract.maxItems} ${item.type} items`);
    }

    assertOptionalNumber(item, 'start', `${label} start`, value => value >= 0);
    assertOptionalNumber(item, 'duration', `${label} duration`, value => value > 0);
    assertOptionalNumber(item, 'trim_start', `${label} trim_start`, value => value >= 0);
    assertOptionalNumber(item, 'source_duration', `${label} source_duration`, value => value > 0);
    assertOptionalNumber(item, 'trim_end', `${label} trim_end`, value => value > (item.trim_start ?? 0));
    if (item.media_mode !== undefined) {
        if (item.type !== 'video') throw invalid(`timeline ${label} media_mode is only valid on video items`);
        if (!TIMELINE_MEDIA_MODES.has(item.media_mode)) throw invalid(`timeline ${label} media_mode is not supported`);
    }
    if (item.value !== undefined && (typeof item.value !== 'string' || item.value.length === 0)) {
        throw invalid(`timeline ${label} value must be a non-empty string`);
    }
    for (const field of ['source_width', 'source_height']) {
        if (item[field] === undefined) continue;
        if (!Number.isSafeInteger(item[field]) || item[field] <= 0) {
            throw invalid(`timeline ${label} ${field} must be a positive integer`);
        }
    }
}

function validateTimelineSpec(value) {
    if (!isPlainObject(value) || !Array.isArray(value.items)) {
        throw invalid('timeline must be an object carrying an items array');
    }
    for (const field of Object.keys(value)) {
        if (field !== 'items') throw invalid(`timeline has an unknown field: ${field}`);
    }
    if (value.items.length === 0) throw invalid('timeline must carry at least one item');
    if (value.items.length > TIMELINE_MAX_ITEMS) {
        throw overContract(`timeline carries more than ${TIMELINE_MAX_ITEMS} items`);
    }
    const counts = { image: 0, video: 0, audio: 0 };
    const addresses = new Set();
    const typeByAsset = new Map();
    value.items.forEach((item, index) => {
        validateTimelineItem(item, `item ${index}`, counts, addresses, typeByAsset);
    });
    return value;
}

function timelineAssetKey(assetId) {
    return `${TIMELINE_ASSET_KEY_PREFIX}${assetId}`;
}

// `#` cannot appear in a slot name, so a timeline asset entry can share the
// job's inputAssets/remoteInputs maps without ever shadowing an image slot.
function isTimelineAssetKey(key) {
    return typeof key === 'string' && key.startsWith(TIMELINE_ASSET_KEY_PREFIX);
}

function collectTimelineAssets(spec) {
    const unique = new Map();
    for (const item of spec.items) {
        if (!unique.has(item.assetId)) unique.set(item.assetId, { assetId: item.assetId, type: item.type });
    }
    return [...unique.values()];
}

function resolveTimelineSpec(spec, inputAssets, remoteInputs) {
    return {
        items: spec.items.map(item => {
            const key = timelineAssetKey(item.assetId);
            const remoteName = remoteInputs?.[key];
            if (typeof remoteName !== 'string' || remoteName.length === 0) {
                throw invalid(`timeline item ${item.type}:${item.slot} was not uploaded to Comfy`);
            }
            const snapshot = inputAssets?.[key];
            const dimensions = item.type === 'image' ? snapshot : null;
            return {
                ...item,
                value: remoteName,
                ...(Number.isSafeInteger(dimensions?.width) && dimensions.width > 0
                    ? { source_width: dimensions.width }
                    : {}),
                ...(Number.isSafeInteger(dimensions?.height) && dimensions.height > 0
                    ? { source_height: dimensions.height }
                    : {}),
            };
        }),
    };
}

function timelineItemDuration(item) {
    if (item.duration !== undefined) return item.duration;
    if (item.type === 'image') return 1;
    if (item.trim_end !== undefined) return item.trim_end - (item.trim_start ?? 0);
    if (item.source_duration !== undefined) return item.source_duration;
    return 1;
}

// One function, one wire shape: the live probe may still tell us the Director
// wants a field we omit (thumbnail/waveform tolerance), and that has to stay a
// one-line change here rather than a hunt across the dispatcher.
function assembleTimelineDocument(spec) {
    return JSON.stringify({
        version: TIMELINE_DOCUMENT_VERSION,
        items: spec.items.map((item, index) => ({
            id: `risu-${item.type}-${item.slot}`,
            enabled: true,
            order: index,
            slot: item.slot,
            start: item.start ?? item.slot,
            duration: timelineItemDuration(item),
            type: item.type,
            // Before dispatch resolves it this is still the asset id, which is
            // exactly how an unresolved imageAsset slot instantiates too.
            value: item.value ?? item.assetId,
            thumbnail: null,
            ...(item.source_width !== undefined ? { source_width: item.source_width } : {}),
            ...(item.source_height !== undefined ? { source_height: item.source_height } : {}),
            ...(item.trim_start !== undefined ? { trim_start: item.trim_start } : {}),
            ...(item.trim_end !== undefined ? { trim_end: item.trim_end } : {}),
            ...(item.source_duration !== undefined ? { source_duration: item.source_duration } : {}),
            ...(item.media_mode !== undefined ? { media_mode: item.media_mode } : {}),
        })),
    });
}

module.exports = {
    assembleTimelineDocument,
    collectTimelineAssets,
    isTimelineAssetKey,
    resolveTimelineSpec,
    timelineAssetKey,
    validateTimelineSpec,
    TIMELINE_DOCUMENT_VERSION,
    TIMELINE_MAX_ITEMS,
    TIMELINE_SLOT_CONTRACT,
};
