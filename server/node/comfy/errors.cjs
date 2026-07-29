'use strict';

class ComfyError extends Error {
    constructor(code, message, options = {}) {
        super(message);
        this.name = 'ComfyError';
        this.code = code;
        this.httpStatus = options.httpStatus ?? 400;
        this.uncertain = options.uncertain === true;
        this.retryMaterialization = options.retryMaterialization === true;
        if (options.cause !== undefined) this.cause = options.cause;
    }
}

function comfyError(code, message, options) {
    return new ComfyError(code, message, options);
}

function isComfyError(error) {
    return error instanceof ComfyError
        || Boolean(error && typeof error === 'object' && typeof error.code === 'string' && error.code.startsWith('COMFY_'));
}

module.exports = { ComfyError, comfyError, isComfyError };
