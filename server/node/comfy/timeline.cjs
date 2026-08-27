'use strict';

// The `{{timeline}}` slot: the plugin sends a SPEC naming its own inlay assets,
// the dispatcher uploads each one and resolves it, and this module assembles the
// single JSON document the MiniMax H3 Director expects on `timeline_data`.
//
// The addresses below are the workflow's own contract, read off the vendor
// export: the Director owns ONE 12-slot visual track — images at 0..8, videos
// at 9..11 — plus a SEPARATE 3-slot audio track at 0..2. (The shipped export
// puts its two videos at slots 9 and 10 and its two audio clips at 0 and 1.)
// Capacity therefore falls out of the addressing — 9 images, 3 videos, 3 audio,
// 15 items in all — rather than from any cap this layer invented.

const { comfyError } = require('./errors.cjs');
const { isSafeAssetId } = require('./assetStore.cjs');

const TIMELINE_DOCUMENT_VERSION = 1;
const TIMELINE_MEDIA_TYPES = Object.freeze(['image', 'video', 'audio']);
const TIMELINE_SLOT_CONTRACT = Object.freeze({
    image: Object.freeze({ track: 'visual', minSlot: 0, maxSlot: 8 }),
    video: Object.freeze({ track: 'visual', minSlot: 9, maxSlot: 11 }),
    audio: Object.freeze({ track: 'audio', minSlot: 0, maxSlot: 2 }),
});
const TIMELINE_MEDIA_MODES = new Set(['video_audio']);
// What a plugin may send. `value` is deliberately absent: the uploaded Comfy
// name is the dispatcher's to write, and a caller-supplied one would only be
// overwritten.
const TIMELINE_ITEM_FIELDS = new Set([
    'slot', 'type', 'assetId', 'start', 'duration',
    'trim_start', 'trim_end', 'source_duration', 'media_mode',
    // Vendor emits these on video, and ref_image_size='match' scaling may read
    // them, so a caller can supply them for video. For images the sidecar
    // dimensions captured at submit win; audio has no frame to size.
    'source_width', 'source_height',
]);
// What the dispatcher hands back once every asset is on Comfy.
const TIMELINE_RESOLVED_ITEM_FIELDS = new Set([...TIMELINE_ITEM_FIELDS, 'value']);
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

function validateTimelineItem(item, label, addresses, typeByAsset, resolved) {
    if (!isPlainObject(item)) throw invalid(`timeline ${label} must be an object`);
    const accepted = resolved ? TIMELINE_RESOLVED_ITEM_FIELDS : TIMELINE_ITEM_FIELDS;
    for (const field of Object.keys(item)) {
        if (!accepted.has(field)) throw invalid(`timeline ${label} has an unknown field: ${field}`);
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
    if (item.slot < contract.minSlot || item.slot > contract.maxSlot) {
        throw overContract(
            `timeline ${label} slot ${item.slot} is outside the ${item.type} range `
            + `${contract.minSlot}..${contract.maxSlot}`,
        );
    }
    // Images and videos share one visual address space, so the uniqueness domain
    // is the TRACK, not the media type. Audio addresses itself separately.
    const address = `${contract.track}:${item.slot}`;
    if (addresses.has(address)) throw invalid(`timeline ${contract.track} slot ${item.slot} is used more than once`);
    addresses.add(address);

    assertOptionalNumber(item, 'start', `${label} start`, value => value >= 0);
    assertOptionalNumber(item, 'duration', `${label} duration`, value => value > 0);
    assertOptionalNumber(item, 'trim_start', `${label} trim_start`, value => value >= 0);
    assertOptionalNumber(item, 'source_duration', `${label} source_duration`, value => value > 0);
    assertOptionalNumber(item, 'trim_end', `${label} trim_end`, value => value > (item.trim_start ?? 0));
    if (item.media_mode !== undefined) {
        if (item.type !== 'video') throw invalid(`timeline ${label} media_mode is only valid on video items`);
        if (!TIMELINE_MEDIA_MODES.has(item.media_mode)) throw invalid(`timeline ${label} media_mode is not supported`);
    }
    if (resolved && (typeof item.value !== 'string' || item.value.length === 0)) {
        throw invalid(`timeline ${label} value must be a non-empty string`);
    }
    for (const field of ['source_width', 'source_height']) {
        if (item[field] === undefined) continue;
        if (item.type === 'audio') throw invalid(`timeline ${label} ${field} is only valid on visual items`);
        if (!Number.isSafeInteger(item[field]) || item[field] <= 0) {
            throw invalid(`timeline ${label} ${field} must be a positive integer`);
        }
    }
}

// `resolved` selects the field set: a submitted spec is items only, while the
// document the dispatcher assembles from also carries each uploaded `value` and
// the job's own timestamp. Keeping them apart is what stops a caller from
// smuggling either past the submit-time whitelist.
function validateTimelineSpec(value, { resolved = false } = {}) {
    if (!isPlainObject(value) || !Array.isArray(value.items)) {
        throw invalid('timeline must be an object carrying an items array');
    }
    for (const field of Object.keys(value)) {
        if (field === 'items') continue;
        if (resolved && field === 'createdAt') continue;
        throw invalid(`timeline has an unknown field: ${field}`);
    }
    if (resolved && !Number.isSafeInteger(value.createdAt)) {
        throw invalid('timeline createdAt must be the job timestamp');
    }
    if (value.items.length === 0) throw invalid('timeline must carry at least one item');
    const addresses = new Set();
    const typeByAsset = new Map();
    value.items.forEach((item, index) => {
        validateTimelineItem(item, `item ${index}`, addresses, typeByAsset, resolved);
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

// The slot rides along so a read failure can name the item that caused it; the
// first slot to claim an asset is enough, since one asset is read once.
function collectTimelineAssets(spec) {
    const unique = new Map();
    for (const item of spec.items) {
        if (!unique.has(item.assetId)) {
            unique.set(item.assetId, { assetId: item.assetId, type: item.type, slot: item.slot });
        }
    }
    return [...unique.values()];
}

function resolveTimelineSpec(spec, inputAssets, remoteInputs, createdAt) {
    return {
        createdAt,
        items: spec.items.map(item => {
            const key = timelineAssetKey(item.assetId);
            const remoteName = remoteInputs?.[key];
            if (typeof remoteName !== 'string' || remoteName.length === 0) {
                throw invalid(`timeline item ${item.type}:${item.slot} was not uploaded to Comfy`);
            }
            const snapshot = inputAssets?.[key];
            // Images are sized from the sidecar pinned at submit, which wins over
            // anything the caller guessed; video keeps whatever it declared.
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
    // The builder reads an item's kind back off `id.split('-')[0]`, so the id
    // keeps the vendor's `<type>-<ms>-<counter>` shape. The ms is the job's own
    // creation timestamp, which makes the document identical on every dispatch
    // attempt of that job; the pre-dispatch dry run has no job yet and assembles
    // from zero rather than reaching for the clock.
    const createdAt = spec.createdAt ?? 0;
    return JSON.stringify({
        version: TIMELINE_DOCUMENT_VERSION,
        items: spec.items.map((item, index) => ({
            id: `${item.type}-${createdAt}-${index}`,
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
        // Vendor always carries this alongside the items and a builder that
        // indexes it unguarded would fault on its absence; we author no blocks.
        prompt_blocks: [],
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
    TIMELINE_SLOT_CONTRACT,
};
