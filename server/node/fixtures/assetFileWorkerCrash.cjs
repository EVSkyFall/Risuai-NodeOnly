'use strict';

const io = require('../assetFileIO.cjs');
const writeGeneration = io.writeGeneration;
io.writeGeneration = (root, value, options) => writeGeneration(root, value, {
    ...options,
    checkpoint: async stage => { if (stage === 'post-rename') process.exit(1); },
});
require('../assetFileWorker.cjs');
