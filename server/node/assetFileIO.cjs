'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function generationPath(root, generationId) {
    return path.join(root, generationId.slice(0, 2), `${generationId}.blob`);
}

async function syncDirectory(directory, io = fsp) {
    let handle;
    try {
        handle = await io.open(directory, 'r');
        await handle.sync();
    } catch (error) {
        if (!['EPERM', 'EINVAL', 'EISDIR'].includes(error.code)) throw error;
    } finally {
        if (handle) await handle.close();
    }
}

async function writeGeneration(root, value, { io = fsp, checkpoint = async () => {}, generationId = crypto.randomBytes(32).toString('hex') } = {}) {
    const target = generationPath(root, generationId);
    const directory = path.dirname(target);
    await io.mkdir(directory, { recursive: true });
    const handle = await io.open(`${target}.tmp`, 'wx');
    try {
        await handle.writeFile(value);
        await checkpoint('temp-write', { generationId });
        await handle.sync();
    } finally {
        await handle.close();
    }
    await io.rename(`${target}.tmp`, target);
    const expectedHash = crypto.createHash('sha256').update(value).digest('hex');
    try {
        await checkpoint('post-rename', { generationId });
        await syncDirectory(directory, io);
        await syncDirectory(root, io);
        const hash = crypto.createHash('sha256');
        let size = 0;
        for await (const chunk of fs.createReadStream(target)) {
            size += chunk.length;
            hash.update(chunk);
        }
        const sha256 = hash.digest('hex');
        if (size !== value.length || sha256 !== expectedHash) {
            throw new Error(`Asset generation verification failed: ${generationId}`);
        }
        return { generationId, size, sha256 };
    } catch (error) {
        let size = value.length;
        try { size = (await fsp.stat(target)).size; } catch {}
        error.generation = { generationId, size, sha256: expectedHash };
        throw error;
    }
}

module.exports = { generationPath, writeGeneration };
