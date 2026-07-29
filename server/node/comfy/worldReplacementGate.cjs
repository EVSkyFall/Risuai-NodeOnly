'use strict';

const { comfyError } = require('./errors.cjs');

function createComfyWorldReplacementGate(options) {
    const { orchestrator } = options;
    const logger = options.logger ?? console;
    let activeRelayOperations = 0;
    const relayDrainWaiters = new Set();
    let worldReplacementTail = Promise.resolve();

    function finishRelayOperation() {
        activeRelayOperations -= 1;
        if (activeRelayOperations !== 0) return;
        for (const resolve of relayDrainWaiters) resolve();
        relayDrainWaiters.clear();
    }

    async function withRelayOperation(action) {
        if (orchestrator.isWorldReplacementPaused()) {
            throw comfyError(
                'COMFY_WORLD_REPLACING',
                'Comfy orchestration is paused while server data is being replaced',
                { httpStatus: 503 },
            );
        }
        activeRelayOperations += 1;
        try {
            return await action();
        } finally {
            finishRelayOperation();
        }
    }

    async function waitForRelayDrain() {
        if (activeRelayOperations === 0) return;
        await new Promise(resolve => relayDrainWaiters.add(resolve));
    }

    async function withWorldReplacement(action) {
        const previous = worldReplacementTail;
        let release;
        worldReplacementTail = new Promise(resolve => { release = resolve; });
        await previous;
        let paused = false;
        try {
            await orchestrator.pauseForWorldReplacement();
            paused = true;
            await waitForRelayDrain();
            return await action();
        } finally {
            try {
                if (paused) {
                    try {
                        await orchestrator.resumeAfterWorldReplacement();
                    } catch (error) {
                        try {
                            logger.error?.('[Comfy] world-replacement resume failed:', error);
                        } catch {
                            // Logging must not replace the action result or error.
                        }
                    }
                }
            } finally {
                release();
            }
        }
    }

    return {
        withRelayOperation,
        withWorldReplacement,
    };
}

module.exports = { createComfyWorldReplacementGate };
