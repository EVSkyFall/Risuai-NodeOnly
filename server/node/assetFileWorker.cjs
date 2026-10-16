'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3');
const { writeFile } = require('node:fs/promises');
const { generationPath, writeGeneration } = require('./assetFileIO.cjs');

const db = new Database(workerData.dbPath, { readonly: true });
db.pragma('busy_timeout = 5000');
const read = db.prepare(`SELECT kv.value, kv.updated_at, r.revision AS sourceRevision
    FROM kv LEFT JOIN asset_file_revisions r ON r.key = kv.key WHERE kv.key = ?`);
const live = db.prepare('SELECT * FROM asset_file_generations WHERE key = ? AND retired = 0');

parentPort.on('message', async ({ type, key, sourcePath, generationId }) => {
    try {
        // Only the synchronous reads share a snapshot; no filesystem await holds a WAL reader.
        const row = db.transaction(() => type === 'capture' ? live.get(key) || read.get(key) : read.get(key))();
        if (!row) return parentPort.postMessage({ type, result: null });
        if (type === 'capture') {
            if (row.generationId) {
                return parentPort.postMessage({ type, result: { ...row, kind: 'asset', sourcePath: generationPath(workerData.root, row.generationId) } });
            }
            await writeFile(sourcePath, row.value, { flag: 'wx' });
            return parentPort.postMessage({ type, result: { key, kind: 'spool', sourcePath,
                size: row.value.length, updated_at: row.updated_at, sourceRevision: row.sourceRevision } });
        }
        const generation = await writeGeneration(workerData.root, row.value, { generationId });
        parentPort.postMessage({ type, result: { key, ...generation, sourceRevision: row.sourceRevision } });
    } catch (error) {
        parentPort.postMessage({ type, error: { message: error.message, code: error.code,
            generation: error.generation && { key, ...error.generation } } });
    }
});
