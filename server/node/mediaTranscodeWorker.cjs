'use strict';

// Runs the encode off the event loop: wasm-vips is synchronous and one image
// takes a second or more.

const { parentPort } = require('node:worker_threads');
const { encodeChecked } = require('./mediaTranscodeCore.cjs');

let vipsPromise = null;
function getVips() {
    if (!vipsPromise) {
        vipsPromise = require('wasm-vips')().then((vips) => {
            vips.concurrency(1);
            vips.Cache.max(0);
            return vips;
        });
        vipsPromise.catch(() => { vipsPromise = null; });
    }
    return vipsPromise;
}

parentPort.on('message', async ({ bytes, options }) => {
    let vips;
    // Not this image's fault: the scheduler waits and asks again.
    try { vips = await getVips(); }
    catch (error) { return parentPort.postMessage({ unavailable: String(error?.message || error) }); }
    try {
        let result;
        // What libvips refuses to decode or encode is a property of the image, not a fault to retry.
        try { result = encodeChecked(vips, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), options); }
        catch (error) { result = { skip: `could not be encoded: ${String(error?.message || error).trim()}` }; }
        if (!result.webp) return parentPort.postMessage(result);
        // A Buffer from the pool shares its ArrayBuffer; a copy can be transferred safely.
        const webp = new Uint8Array(result.webp);
        parentPort.postMessage({ webp, diff: result.diff, blockDiff: result.blockDiff }, [webp.buffer]);
    } catch (error) {
        parentPort.postMessage({ error: String(error?.message || error) });
    }
});
