'use strict';

const { isMainThread } = require('node:worker_threads');
const path = require('node:path');
const fs = require('node:fs');

if (!isMainThread) {
    const io = require('../assetFileIO.cjs');
    const write = io.writeGeneration;
    io.writeGeneration = (root, bytes) => write(root, bytes, {
        checkpoint: async stage => {
            const desired = fs.readFileSync(path.join(root, '..', 'crash-stage'), 'utf8');
            if (stage !== desired) return;
            fs.writeFileSync(path.join(root, '..', 'crash-reached'), stage);
            await new Promise(() => {});
        },
    });
} else {
    const Database = require('better-sqlite3');
    const { createAssetFileStore } = require('../assetFileStore.cjs');
    const [dir, stage] = process.argv.slice(2);
    if (stage !== 'recover') fs.writeFileSync(path.join(dir, 'crash-stage'), stage);
    const db = new Database(path.join(dir, 'test.db'));
    const store = createAssetFileStore(db, {
        saveDir: dir,
        checkpoint: async current => {
            if (current !== stage) return;
            process.send({ stage });
            await new Promise(() => {});
        },
    });
    if (stage === 'recover') {
        store.migrateOne('assets/crash').then(async migrated => {
            await store.close();
            db.close();
            process.send({ migrated }, () => process.disconnect());
        }).catch(error => { console.error(error); process.exit(1); });
    } else {
    const watch = setInterval(() => {
        if (fs.existsSync(path.join(dir, 'crash-reached'))) {
            clearInterval(watch);
            process.send({ stage });
        }
    }, 10);
    store.migrateOne('assets/crash').catch(error => { console.error(error); process.exit(1); });
    }
}
