'use strict';

const path = require('path');
const { createWriteStream } = require('fs');
const fs = require('fs/promises');
const zlib = require('zlib');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const PLUGIN_STORAGE_PREFIXES = [
    'plugin-custom-storage/',
    'plugin-blob-storage/',
];
const RESCUE_FILENAME_REGEX = /^plugin-rescue-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.ndjson\.gz$/;

function isPluginStorageKey(key) {
    return PLUGIN_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

async function preparePluginStorageImport({
    storageKey,
    pluginWipeDone,
    dumpPluginStorageRescue,
    kvDelPrefix,
}) {
    if (pluginWipeDone || !isPluginStorageKey(storageKey)) {
        return pluginWipeDone;
    }

    await dumpPluginStorageRescue();
    for (const prefix of PLUGIN_STORAGE_PREFIXES) {
        kvDelPrefix(prefix);
    }
    return true;
}

async function writePluginStorageRescue({ backupsDir, kvList, kvGet, now = new Date(), log = console.log }) {
    const timestamp = new Date(now).toISOString().replace(/:/g, '-');
    const filename = `plugin-rescue-${timestamp}.ndjson.gz`;
    const finalPath = path.join(backupsDir, filename);
    const tempPath = `${finalPath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;

    // Sweep temp files orphaned by a hard crash mid-dump (kill -9, power loss) —
    // the rotation regex deliberately excludes them, so nothing else cleans them up.
    try {
        for (const entry of await fs.readdir(backupsDir, { withFileTypes: true })) {
            if (entry.isFile() && /^plugin-rescue-.*\.tmp-/.test(entry.name)) {
                await fs.unlink(path.join(backupsDir, entry.name)).catch(() => {});
            }
        }
    } catch (_) { /* best-effort */ }
    const keys = PLUGIN_STORAGE_PREFIXES
        .flatMap((prefix) => kvList(prefix))
        .sort((a, b) => a.localeCompare(b));
    let rowCount = 0;
    let byteCount = 0;

    async function* lines() {
        for (const key of keys) {
            const value = kvGet(key);
            if (value === null || value === undefined) {
                throw new Error(`Plugin storage rescue could not read KV key: ${key}`);
            }
            // kvGet already returns an owned Buffer — avoid a redundant full copy
            // (matters for 20MB+ blob rows on the rescue path).
            const raw = Buffer.isBuffer(value) ? value : Buffer.from(value);
            rowCount++;
            byteCount += raw.length;
            yield Buffer.from(JSON.stringify({ key, b64: raw.toString('base64') }) + '\n', 'utf-8');
        }
    }

    try {
        await pipeline(
            Readable.from(lines()),
            zlib.createGzip(),
            createWriteStream(tempPath, { flags: 'wx' }),
        );
        await fs.rename(tempPath, finalPath);
    } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => {});
        throw error;
    }

    // Rotation is best-effort: the rescue file is already safely in place, so a
    // cleanup failure must not abort the caller's import (fail-closed applies
    // only to producing the rescue itself).
    try {
        const rescueFiles = (await fs.readdir(backupsDir, { withFileTypes: true }))
            .filter((entry) => entry.isFile() && RESCUE_FILENAME_REGEX.test(entry.name))
            .map((entry) => entry.name)
            .sort((a, b) => b.localeCompare(a));
        for (const oldFilename of rescueFiles.slice(3)) {
            await fs.unlink(path.join(backupsDir, oldFilename)).catch(() => {});
        }
    } catch (error) {
        log(`[Server] Plugin rescue rotation failed (rescue file kept): ${error?.message ?? error}`);
    }

    log(`[Server] Plugin storage rescue saved: ${finalPath} (${rowCount} rows, ${byteCount} bytes)`);
    return finalPath;
}

module.exports = {
    PLUGIN_STORAGE_PREFIXES,
    preparePluginStorageImport,
    writePluginStorageRescue,
};
