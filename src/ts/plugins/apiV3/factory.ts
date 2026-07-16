type MsgType =
    | 'CALL_ROOT'
    | 'CALL_INSTANCE'
    | 'INVOKE_CALLBACK'
    | 'CALLBACK_RETURN'
    | 'RESPONSE'
    | 'RELEASE_INSTANCE'
    | 'ABORT_SIGNAL';

interface RpcMessage {
    type: MsgType;
    reqId?: string;
    id?: string;
    method?: string;
    args?: any[];
    result?: any;
    error?: string;
    abortId?: string;
}

interface RemoteRef {
    __type: 'REMOTE_REF';
    id: string;
}

interface CallbackRef {
    __type: 'CALLBACK_REF';
    id: string;
}

interface AbortSignalRef {
    __type: 'ABORT_SIGNAL_REF';
    abortId: string;
    aborted: boolean;
}


const GUEST_BRIDGE_SCRIPT = `
await (async function() {
    const pendingRequests = new Map();
    const callbackRegistry = new Map();
    const callbackIdByFunction = new WeakMap();
    const proxyRefRegistry = new Map();
    const abortControllers = new Map();

    function serializeArg(arg) {
        if (typeof arg === 'function') {
            const existingId = callbackIdByFunction.get(arg);
            if (existingId) {
                return { __type: 'CALLBACK_REF', id: existingId };
            }
            const id = 'cb_' + Math.random().toString(36).substring(2);
            callbackRegistry.set(id, arg);
            callbackIdByFunction.set(arg, id);
            return { __type: 'CALLBACK_REF', id: id };
        }
        if (arg && typeof arg === 'object') {
            const refId = proxyRefRegistry.get(arg);
            if (refId) {
                return { __type: 'REMOTE_REF', id: refId };
            }
            if (arg.constructor === Object) {
                let out = null;
                for (const [key, val] of Object.entries(arg)) {
                    if (val instanceof AbortSignal) {
                        if (!out) out = { ...arg };
                        const abortId = 'abort_' + Math.random().toString(36).substring(2);

                        if (!val.aborted) {
                            val.addEventListener('abort', () => {
                                send({ type: 'ABORT_SIGNAL', abortId });
                            }, { once: true });
                        }

                        out[key] = { __type: 'ABORT_SIGNAL_REF', abortId, aborted: val.aborted };
                    }
                }
                if (out) return out;
            }
        }
        return arg;
    }

    function deserializeResult(val) {
        if (val && typeof val === 'object' && val.__type === 'REMOTE_REF') {
            const proxy = new Proxy({}, {
                get: (target, prop) => {
                    if (prop === 'then') return undefined;
                    if (prop === 'release') {
                        return () => send({ type: 'RELEASE_INSTANCE', id: val.id });
                    }
                    return (...args) => sendRequest('CALL_INSTANCE', {
                        id: val.id,
                        method: prop,
                        args: args
                    });
                }
            });
            // Store the mapping so we can serialize it back
            proxyRefRegistry.set(proxy, val.id);
            return proxy;
        }
        if (val && typeof val === 'object' && val.__type === 'CALLBACK_STREAMS') {
            //specialType, one of
            // - Response
            // - none
            const specialType = val.__specialType;
            if (specialType === 'Response') {
                return new Response(val.value, val.init);
            }
            return val.value;
        }
        return val;
    }

    function collectTransferables(obj, transferables = []) {
        // ReadableStream check must precede the first "return transferables" —
        // guest-source sniffers (e.g. CPM) lazily match up to that point to
        // decide whether transferable-stream bridging is supported.
        if (obj instanceof ReadableStream ||
            obj instanceof WritableStream ||
            obj instanceof TransformStream) {
            transferables.push(obj);
            return transferables;
        }
        if (!obj || typeof obj !== 'object') return transferables;

        if (obj instanceof ArrayBuffer ||
            obj instanceof MessagePort ||
            obj instanceof ImageBitmap ||
            (typeof OffscreenCanvas !== 'undefined' && obj instanceof OffscreenCanvas)) {
            transferables.push(obj);
        }
        else if (ArrayBuffer.isView(obj) && obj.buffer instanceof ArrayBuffer) {
            transferables.push(obj.buffer);
        }
        else if (Array.isArray(obj)) {
            obj.forEach(item => collectTransferables(item, transferables));
        }
        else if (obj.constructor === Object) {
            Object.values(obj).forEach(value => collectTransferables(value, transferables));
        }

        return transferables;
    }

    function send(payload, transferables = []) {
        window.parent.postMessage(payload, '*', transferables);
    }

    // Chromium cannot deserialize a ReadableStream transferred out of a
    // sandboxed (opaque-origin) iframe — the parent receives event.data === null.
    // Relay streams through a MessagePort instead: ports cross the origin
    // boundary reliably, and the host rebuilds a ReadableStream on its side.
    function portifyStreams(obj) {
        if (obj instanceof ReadableStream) {
            const channel = new MessageChannel();
            const reader = obj.getReader();
            const port = channel.port1;
            port.onmessage = function(ev) {
                if (ev.data && ev.data.c) { try { reader.cancel(); } catch (e) {} }
            };
            (async function() {
                try {
                    while (true) {
                        const r = await reader.read();
                        if (r.done) { port.postMessage({ d: 1 }); break; }
                        port.postMessage({ v: r.value });
                    }
                } catch (err) {
                    try { port.postMessage({ e: (err && err.message) || String(err) }); } catch (e2) {}
                }
            })();
            return { __type: 'STREAM_PORT', port: channel.port2 };
        }
        if (!obj || typeof obj !== 'object') return obj;
        if (Array.isArray(obj)) {
            for (let i = 0; i < obj.length; i++) obj[i] = portifyStreams(obj[i]);
            return obj;
        }
        if (obj.constructor === Object) {
            for (const key of Object.keys(obj)) obj[key] = portifyStreams(obj[key]);
            return obj;
        }
        return obj;
    }

    function sendRequest(type, payload) {
        return new Promise((resolve, reject) => {
            const reqId = Math.random().toString(36).substring(7);
            pendingRequests.set(reqId, { resolve, reject });


            if (payload.args) {
                payload.args = payload.args.map(serializeArg);
            }

            const message = { type: type, reqId: reqId, ...payload };
            const transferables = collectTransferables(message);
            send(message, transferables);
        });
    }

    
    
    
    window.addEventListener('message', async (event) => {
        const data = event.data;
        if (!data) return;


        if (data.type === 'RESPONSE' && data.reqId) {
            const req = pendingRequests.get(data.reqId);
            if (req) {
                if (data.error) req.reject(new Error(data.error));
                else req.resolve(deserializeResult(data.result));
                pendingRequests.delete(data.reqId);
            }
        }

        else if (data.type === 'EXECUTE_CODE' && data.reqId) {
            const response = { type: 'EXEC_RESULT', reqId: data.reqId };
            try {
                const result = await eval('(async () => {' + data.code + '})()');
                response.result = result;
            } catch (e) {
                response.error = e.message || String(e);
            }
            send(response);
        }

        else if (data.type === 'ABORT_SIGNAL' && data.abortId) {
            const controller = abortControllers.get(data.abortId);
            if (controller) {
                controller.abort();
                abortControllers.delete(data.abortId);
            }
        }

        else if (data.type === 'INVOKE_CALLBACK' && data.id) {
            const fn = callbackRegistry.get(data.id);
            const response = { type: 'CALLBACK_RETURN', reqId: data.reqId };
            const usedAbortIds = [];

            try {
                if (!fn) throw new Error("Callback not found or released");
                const deserializedArgs = (data.args || []).map(function(a) {
                    if (a && typeof a === 'object' && a.__type === 'ABORT_SIGNAL_REF') {
                        const controller = new AbortController();
                        abortControllers.set(a.abortId, controller);
                        usedAbortIds.push(a.abortId);
                        if (a.aborted) { controller.abort(); }
                        return controller.signal;
                    }
                    return a;
                });
                const result = await fn(...deserializedArgs);
                response.result = result;
            } catch (e) {
                response.error = e.message || "Guest callback error";
            }
            // Clean up abort controllers after callback completes
            for (const id of usedAbortIds) {
                abortControllers.delete(id);
            }
            if (response.result) response.result = portifyStreams(response.result);
            // If posting fails (e.g. DataCloneError), the host would await this
            // reqId forever — degrade instead of hanging: drain a stream result
            // to text, and as a last resort send an error.
            try {
                send(response, collectTransferables(response));
            } catch (err) {
                console.error('[RisuBridge] CALLBACK_RETURN transfer failed, buffering result:', err);
                try {
                    const r = response.result;
                    if (r && typeof r === 'object' && r.content instanceof ReadableStream) {
                        let text = '';
                        const reader = r.content.getReader();
                        const decoder = new TextDecoder();
                        while (true) {
                            const chunk = await reader.read();
                            if (chunk.done) break;
                            text += typeof chunk.value === 'string' ? chunk.value : decoder.decode(chunk.value, { stream: true });
                        }
                        response.result = Object.assign({}, r, { content: text });
                    }
                    send(response, collectTransferables(response));
                } catch (err2) {
                    send({ type: 'CALLBACK_RETURN', reqId: data.reqId, error: 'plugin bridge transfer failed: ' + (err2 && err2.message || err2) });
                }
            }
        }
    });





    const propertyCache = new Map();

    window.risuai = new Proxy({}, {
        get: (target, prop) => {
            if (propertyCache.has(prop)) {
                return propertyCache.get(prop);
            }
            return (...args) => sendRequest('CALL_ROOT', { method: prop, args: args });
        }
    });
    window.Risuai = window.risuai;

    try {
        // Initialize cached properties
        const propsToInit = await window.risuai._getPropertiesForInitialization();
        console.log('Initializing risuai properties:', JSON.stringify(propsToInit.list));
        for (let i = 0; i < propsToInit.list.length; i++) {
            const key = propsToInit.list[i];
            const value = propsToInit[key];
            propertyCache.set(key, value);
        }

        // Initialize aliases
        const aliases = await window.risuai._getAliases();
        const aliasKeys = Object.keys(aliases);
        for (let i = 0; i < aliasKeys.length; i++) {
            const aliasKey = aliasKeys[i];
            const childrens = Object.keys(aliases[aliasKey]);
            const aliasObj = {};
            for (let j = 0; j < childrens.length; j++) {
                const childKey = childrens[j];
                aliasObj[childKey] = risuai[aliases[aliasKey][childKey]];
            }
            propertyCache.set(aliasKey, aliasObj);
        }

        // Initialize helper functions defined in the guest

        propertyCache.set('unwarpSafeArray', async (safeArray) => {
            const length = await safeArray.length();
            const result = [];
            for (let i = 0; i < length; i++) {
                const item = await safeArray.at(i);
                result.push(item);
            }
            return result;
        });
    } catch (e) {
        console.error('Failed to initialize risuai properties:', e);
    }

    window.initOldApiGlobal = () => {
        const keys = risuai._getOldKeys()
        for(const key of keys){
            window[key] = risuai[key];
        }
    }

    Object.freeze(window.postMessage);
})();
`;

export class SandboxHost {
    private iframe: HTMLIFrameElement;
    private apiFactory: any;
    private nonce = crypto.randomUUID();
    private csp = `connect-src 'none'; script-src 'nonce-${this.nonce}' 'wasm-unsafe-eval'; frame-src 'none'; object-src 'none'; style-src * 'unsafe-inline'; default-src 'none'; img-src * data: blob:; font-src * data: blob:; media-src * data: blob:; base-uri 'none';`;

    private instanceRegistry = new Map<string, any>();
    private abortControllers = new Map<string, AbortController>();
    private callbackWrapperCache = new Map<string, Function>();

    private pendingCallbacks = new Map<string, { resolve: Function, reject: Function }>();

    constructor(apiFactory: any) {
        this.apiFactory = apiFactory;
    }

    public executeInIframe(code: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const reqId = 'exec_' + Math.random().toString(36).substring(2);

            const handler = (event: MessageEvent) => {
                if (event.source !== this.iframe.contentWindow) return;
                const data = event.data;

                if (data.type === 'EXEC_RESULT' && data.reqId === reqId) {
                    window.removeEventListener('message', handler);
                    if (data.error) {
                        reject(new Error(data.error));
                    } else {
                        resolve(data.result);
                    }
                }
            };

            window.addEventListener('message', handler);

            this.iframe.contentWindow?.postMessage({
                type: 'EXECUTE_CODE',
                reqId,
                code
            }, '*');
        });
    }

    private collectTransferables(obj: any, transferables: Transferable[] = []): Transferable[] {
        if (!obj || typeof obj !== 'object') return transferables;

        if (obj instanceof ArrayBuffer ||
            obj instanceof MessagePort ||
            obj instanceof ImageBitmap ||
            obj instanceof ReadableStream ||
            obj instanceof WritableStream ||
            obj instanceof TransformStream ||
            (typeof OffscreenCanvas !== 'undefined' && obj instanceof OffscreenCanvas)) {
            transferables.push(obj);
        }
        else if (ArrayBuffer.isView(obj) && obj.buffer instanceof ArrayBuffer) {
            transferables.push(obj.buffer);
        }
        else if (Array.isArray(obj)) {
            obj.forEach(item => this.collectTransferables(item, transferables));
        }
        else if (obj.constructor === Object) {
            Object.values(obj).forEach(value => this.collectTransferables(value, transferables));
        }

        return transferables;
    }

    // Counterpart of the guest's portifyStreams(): a stream sent out of the
    // sandboxed iframe arrives as {__type:'STREAM_PORT', port} because Chromium
    // fails to deserialize a ReadableStream transferred across the opaque-origin
    // boundary (event.data arrives null). Rebuild a host-realm stream from the port.
    private reviveStreamPorts(obj: any): any {
        if (!obj || typeof obj !== 'object') return obj;
        if (obj.__type === 'STREAM_PORT' && obj.port instanceof MessagePort) {
            const port = obj.port as MessagePort;
            return new ReadableStream({
                start(controller) {
                    port.onmessage = (ev) => {
                        const m = ev.data;
                        if (!m) return;
                        if (m.d) { try { controller.close(); } catch (_) {} port.close(); }
                        else if (m.e !== undefined) { try { controller.error(new Error(String(m.e))); } catch (_) {} port.close(); }
                        else { try { controller.enqueue(m.v); } catch (_) {} }
                    };
                },
                cancel() {
                    try { port.postMessage({ c: 1 }); } catch (_) {}
                    try { port.close(); } catch (_) {}
                }
            });
        }
        if (Array.isArray(obj)) {
            for (let i = 0; i < obj.length; i++) obj[i] = this.reviveStreamPorts(obj[i]);
            return obj;
        }
        if (obj.constructor === Object) {
            for (const key of Object.keys(obj)) obj[key] = this.reviveStreamPorts(obj[key]);
            return obj;
        }
        return obj;
    }


    private serialize(val: any): any {
        if (
            val &&
            (typeof val === 'object' || typeof val === 'function') &&
            val.__classType === 'REMOTE_REQUIRED'
        ) {
            if (val === null) return null;
            if (Array.isArray(val)) return val;


            const id = 'ref_' + Math.random().toString(36).substring(2);
            this.instanceRegistry.set(id, val);
            return { __type: 'REMOTE_REF', id } as RemoteRef;
        }

        if(val instanceof Response) {
            return {
                __type: 'CALLBACK_STREAMS',
                __specialType: 'Response',
                value: val.body,
                init: {
                    status: val.status,
                    statusText: val.statusText,
                    headers: Array.from(val.headers.entries())
                }
            };
        }

        if(
            val instanceof ReadableStream
            || val instanceof WritableStream
            || val instanceof TransformStream
        ) {
            return {
                __type: 'CALLBACK_STREAMS',
                __specialType: 'none',
                value: val
            };
        }
        return val;
    }


    private deserializeArgs(args: any[], usedAbortIds?: string[]) {
        return args.map(arg => {
            if (arg && arg.__type === 'CALLBACK_REF') {
                const cbRef = arg as CallbackRef;

                const cached = this.callbackWrapperCache.get(cbRef.id);
                if (cached) return cached;

                const wrapper = async (...innerArgs: any[]) => {
                    return new Promise((resolve, reject) => {
                        // Stale-stub guard (D2): after a plugin reload the old factory's
                        // iframe is gone — its stubs may still sit in host Sets (e.g.
                        // pluginV2.replacer*). postMessage via `contentWindow?.` was a
                        // silent no-op, leaving the await pending forever. Reject fast
                        // instead so guarded callers fail open immediately.
                        if (!this.iframe || !this.iframe.contentWindow) {
                            reject(new Error('plugin iframe is gone (stale callback stub)'));
                            return;
                        }
                        const reqId = 'cb_req_' + Math.random().toString(36).substring(2);
                        this.pendingCallbacks.set(reqId, { resolve, reject });

                        // AbortSignal cannot be structured-cloned for postMessage.
                        // Convert to a serializable ref and forward abort events
                        // via a separate ABORT_SIGNAL message.
                        const sanitizedArgs = innerArgs.map(arg => {
                            if (arg instanceof AbortSignal) {
                                const abortId = 'abort_' + Math.random().toString(36).substring(2);
                                const ref: AbortSignalRef = {
                                    __type: 'ABORT_SIGNAL_REF',
                                    abortId,
                                    aborted: arg.aborted
                                };
                                if (!arg.aborted) {
                                    arg.addEventListener('abort', () => {
                                        try {
                                            this.iframe.contentWindow?.postMessage({
                                                type: 'ABORT_SIGNAL',
                                                abortId
                                            } as RpcMessage, '*');
                                        } catch (_) { /* iframe already removed */ }
                                    }, { once: true });
                                }
                                return ref;
                            }
                            return arg;
                        });

                        const message = {
                            type: 'INVOKE_CALLBACK',
                            id: cbRef.id,
                            reqId,
                            args: sanitizedArgs
                        };
                        // A postMessage throw (e.g. DataCloneError on the args) must
                        // reject AND release the pending slot — an executor throw
                        // rejects the promise but would leak the pendingCallbacks entry.
                        try {
                            const transferables = this.collectTransferables(message);
                            this.iframe.contentWindow.postMessage(message, '*', transferables);
                        } catch (e) {
                            this.pendingCallbacks.delete(reqId);
                            reject(e);
                        }
                    });
                };
                this.callbackWrapperCache.set(cbRef.id, wrapper);
                return wrapper;
            }
            if (arg && arg.__type === 'REMOTE_REF') {
                const remoteRef = arg as RemoteRef;
                const instance = this.instanceRegistry.get(remoteRef.id);
                if (instance) {
                    return instance;
                }
            }
            if (arg && typeof arg === 'object' && arg.constructor === Object) {
                let out: any = null;
                for (const [key, val] of Object.entries<any>(arg)) {
                    if (val && val.__type === 'ABORT_SIGNAL_REF') {
                        if (!out) out = { ...arg };
                        const abortRef = val as AbortSignalRef, controller = new AbortController();

                        if (abortRef.aborted) controller.abort();
                        else this.abortControllers.set(abortRef.abortId, controller);

                        usedAbortIds?.push(abortRef.abortId);
                        out[key] = controller.signal;
                    }
                }
                if (out) return out;
            }
            return arg;
        });
    }

    public run(container: HTMLElement|HTMLIFrameElement, userCode: string) {
        if(container instanceof HTMLIFrameElement) {
            this.iframe = container;
        } else {
            this.iframe = document.createElement('iframe');
            container.appendChild(this.iframe);
        }

        this.iframe.style.width = "100%";
        this.iframe.style.height = "100%";
        this.iframe.style.border = "none";

        this.iframe.style.backgroundColor = "transparent";
        this.iframe.setAttribute('allowTransparency', 'true');

        this.iframe.sandbox.add('allow-scripts');
        this.iframe.sandbox.add('allow-modals')
        this.iframe.sandbox.add('allow-downloads')

        this.iframe.setAttribute('csp', this.csp);

        const messageHandler = async (event: MessageEvent) => {
            if (event.source !== this.iframe.contentWindow) return;
            const data = event.data as RpcMessage;
            // event.data can be null when the sender transferred something this
            // realm cannot deserialize (e.g. a ReadableStream from the sandboxed
            // iframe) — guard instead of crashing the whole RPC handler.
            if (!data || typeof data.type !== 'string') return;

            if (data.type === 'CALLBACK_RETURN') {
                const req = this.pendingCallbacks.get(data.reqId!);
                if (req) {
                    if (data.error) req.reject(new Error(data.error));
                    else req.resolve(this.reviveStreamPorts(data.result));
                    this.pendingCallbacks.delete(data.reqId!);
                }
                return;
            }

            if (data.type === 'ABORT_SIGNAL') {
                const controller = this.abortControllers.get(data.abortId!);
                if (controller) {
                    controller.abort();
                    this.abortControllers.delete(data.abortId!);
                }
                return;
            }


            if (data.type === 'RELEASE_INSTANCE') {
                this.instanceRegistry.delete(data.id!);
                return;
            }


            if (data.type === 'CALL_ROOT' || data.type === 'CALL_INSTANCE') {
                const response: RpcMessage = { type: 'RESPONSE', reqId: data.reqId };
                const usedAbortIds: string[] = [];

                try {

                    const args = this.deserializeArgs(data.args || [], usedAbortIds);
                    let result: any;


                    if (data.type === 'CALL_ROOT') {
                        const fn = this.apiFactory[data.method!];
                        if (typeof fn !== 'function') throw new Error(`API method ${data.method} not found`);
                        result = await fn(...args);
                    } else {
                        const instance = this.instanceRegistry.get(data.id!);
                        if (!instance) throw new Error("Instance not found or released");
                        if (typeof instance[data.method!] !== 'function') throw new Error(`Method ${data.method} missing on instance`);
                        result = await instance[data.method!](...args);
                    }


                    // WebKit on iOS fails when Response.body (ReadableStream)
                    // is transferred through postMessage. Pre-read into an
                    // ArrayBuffer (preserves binary data) and send that instead.
                    const isWebKit = /Safari/.test(navigator.userAgent) && !/Chrome|Chromium/.test(navigator.userAgent);
                    if (isWebKit && result instanceof Response && result.body) {
                        try {
                            const buf = await result.arrayBuffer();
                            response.result = {
                                __type: 'CALLBACK_STREAMS',
                                __specialType: 'Response',
                                value: buf,
                                init: {
                                    status: result.status,
                                    statusText: result.statusText,
                                    headers: Array.from(result.headers.entries())
                                }
                            };
                        } catch (_) {
                            response.result = this.serialize(result);
                        }
                    } else {
                        response.result = this.serialize(result);
                    }

                } catch (err: any) {
                    response.error = err.message || "Host execution error";
                } finally {
                    for (const id of usedAbortIds) this.abortControllers.delete(id);
                }

                const transferables = this.collectTransferables(response);
                try {
                    this.iframe.contentWindow?.postMessage(response, '*', transferables);                    
                } catch (error) {
                    this.iframe.contentWindow?.postMessage({
                        type: 'RESPONSE',
                        reqId: data.reqId,
                        error: 'Failed to post message to iframe: ' + (error as Error).message
                    }, '*');
                    console.error('Failed to post message to iframe:', error);
                }
            }
        };

        window.addEventListener('message', messageHandler);


        const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="${this.csp}" id="csp-meta">
      </head>
      <body>
        <style>
            body {
                background-color: transparent;
            }
        </style>
        <script nonce="${this.nonce}">
            document.querySelector('meta#csp-meta')?.remove();
            (async () => {
                ${GUEST_BRIDGE_SCRIPT}
                    
                (async () => {
                    ${userCode}
                })()
            })();
        </script>
      </body>
      </html>
    `;

        this.iframe.srcdoc = html;

        return () => {
            window.removeEventListener('message', messageHandler);
            this.iframe.remove();
            this.instanceRegistry.clear();
            this.rejectPendingCallbacks('plugin unloaded');
            this.abortControllers.clear();
            this.callbackWrapperCache.clear();
        };
    }

    // D2 of the replacer hardening request: a bare pendingCallbacks.clear()
    // abandons in-flight callback awaits — whatever request was awaiting that
    // replacer freezes forever. Reject them so guarded callers fail open.
    private rejectPendingCallbacks(reason: string) {
        for (const { reject } of this.pendingCallbacks.values()) {
            try { reject(new Error(reason)); } catch (_) { /* already settled */ }
        }
        this.pendingCallbacks.clear();
    }

    public terminate() {
        if (this.iframe) {
            this.iframe.remove();
        }
        this.instanceRegistry.clear();
        this.rejectPendingCallbacks('plugin unloaded');
        this.abortControllers.clear();
        this.callbackWrapperCache.clear();
    }
}
