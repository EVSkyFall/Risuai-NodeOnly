'use strict';

const { isMainThread } = require('node:worker_threads');
if (isMainThread) {
    const fs = require('node:fs');
    const fsp = require('node:fs/promises');
    const path = require('node:path');
    const moduleUnderTest = require('../assetFileStore.cjs');
    const create = moduleUnderTest.createAssetFileStore;
    moduleUnderTest.createAssetFileStore = (...args) => {
        args[1].checkpoint = async stage => {
            const dir = args[1].saveDir;
            if (stage !== 'temp-write' || !fs.existsSync(path.join(dir, 'hold-write'))) return;
            await fsp.writeFile(path.join(dir, 'write-held'), 'ready');
            while (!fs.existsSync(path.join(dir, 'release-write'))) await new Promise(resolve => setTimeout(resolve, 10));
        };
        const store = create(...args);
        store.start = () => {
            void (async () => {
                const keys = (await store.list()).map(row => row.key);
                const count = Number(process.env.ASSET_TEST_MIGRATED || 0);
                for (const key of keys.slice(0, count)) await store.migrateOne(key);
            })().catch(error => { console.error(error); process.exitCode = 1; });
        };
        return store;
    };
}
