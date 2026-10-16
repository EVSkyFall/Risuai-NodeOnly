'use strict';

const { createReadStream } = require('node:fs');

async function* backupEntryChunks(entry) {
    const buffer = entry.kind === 'buffer' ? entry.buffer : null;
    const name = Buffer.from(entry.backupName, 'utf8');
    const header = Buffer.alloc(8 + name.length);
    header.writeUInt32LE(name.length, 0);
    name.copy(header, 4);
    header.writeUInt32LE(entry.size, 4 + name.length);
    yield header;
    if (buffer) yield buffer;
    else if (entry.size > 0) yield* createReadStream(entry.sourcePath, { start: 0, end: entry.size - 1 });
}

async function sendAsset(res, entry, contentType, headers = {}) {
    const iterator = entry.stream[Symbol.asyncIterator]();
    try {
        const first = await iterator.next();
        res.set(headers);
        res.set('Content-Type', typeof contentType === 'function' ? contentType(first.value || Buffer.alloc(0)) : contentType);
        res.set('Content-Length', String(entry.size));
        if (!first.done) await writeChunk(res, first.value);
        for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) await writeChunk(res, chunk);
        res.end();
    } finally {
        entry.stream.destroy();
    }
}

function writeChunk(destination, chunk) {
    if (destination.destroyed) return Promise.reject(new Error('Stream destination closed'));
    return new Promise((resolve, reject) => {
        const closed = () => finish(new Error('Stream destination closed'));
        const finish = error => {
            destination.removeListener('close', closed);
            if (error) reject(error);
            else resolve();
        };
        destination.once('close', closed);
        destination.write(chunk, finish);
    });
}

module.exports = { backupEntryChunks, sendAsset, writeChunk };
