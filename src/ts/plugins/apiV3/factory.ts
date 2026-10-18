type MsgType =
    | 'CALL_ROOT'
    | 'CALL_INSTANCE'
    | 'INVOKE_CALLBACK'
    | 'CALLBACK_RETURN'
    | 'RESPONSE'
    | 'RELEASE_INSTANCE'
    | 'ABORT_SIGNAL'
    | 'SANDBOX_TERMINATED';

interface RpcMessage {
    type: MsgType;
    reqId?: string;
    id?: string;
    method?: string;
    args?: any[];
    result?: any;
    error?: string;
    abortId?: string;
    relay?: 1;
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


interface StreamRelay {
    start(): void;
    abandon(cancel?: boolean): void;
    finished: Promise<void>;
}

// Keep this factory self-contained: the same compiled implementation runs in
// the opaque-origin guest, without transferring native ReadableStreams.
export function createStreamRelayBridge() {
    const active = new Set<(error: Error) => void>();
    let terminated: Error | undefined;
    function register(stop: (error: Error) => void) {
        active.add(stop);
        if (terminated) stop(terminated);
        return () => active.delete(stop);
    }
    function terminate() {
        terminated ??= new Error('plugin sandbox terminated');
        for (const stop of active) stop(terminated);
        active.clear();
    }

    // Marks a container whose children are still being mapped; meeting it again
    // means a cycle, which forces that container to be copied.
    const IN_PROGRESS = {};
    function emptyLike(obj: any) {
        return Array.isArray(obj) ? new Array(obj.length) : obj instanceof Map ? new Map() : obj instanceof Set ? new Set() : {};
    }
    function put(out: any, key: any, value: any) {
        if (out instanceof Map) out.set(key, value);
        else if (out instanceof Set) out.add(value);
        else Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
    }
    function mapValue(obj: any, replace: (value: any) => any, seen = new Map<any, any>()): any {
        if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return obj;
        if (seen.has(obj)) {
            const known = seen.get(obj);
            if (known !== IN_PROGRESS) return known;
            const placeholder = emptyLike(obj);
            seen.set(obj, placeholder);
            return placeholder;
        }
        const replacement = replace(obj);
        if (replacement !== obj) {
            seen.set(obj, replacement);
            return replacement;
        }
        if (!Array.isArray(obj) && !(obj instanceof Map) && !(obj instanceof Set) &&
            Object.prototype.toString.call(obj) !== '[object Object]') return obj;
        seen.set(obj, IN_PROGRESS);
        let out: any;
        let visited = 0;
        const append = (key: any, value: any, changed: boolean) => {
            if (!out && (changed || seen.get(obj) !== IN_PROGRESS)) {
                const pending = seen.get(obj);
                out = pending === IN_PROGRESS ? emptyLike(obj) : pending;
                seen.set(obj, out);
                // Earlier children are unchanged. Backfill only when a copy
                // becomes necessary, preserving any cycle placeholder.
                let count = 0;
                if (obj instanceof Map) {
                    for (const [k, v] of obj) {
                        if (count++ === visited) break;
                        put(out, k, v);
                    }
                } else if (obj instanceof Set) {
                    for (const v of obj) {
                        if (count++ === visited) break;
                        put(out, v, v);
                    }
                } else {
                    for (const k in obj) {
                        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
                        if (count++ === visited) break;
                        put(out, k, obj[k]);
                    }
                }
            }
            if (out) put(out, key, value);
            visited++;
        };
        if (obj instanceof Map) {
            obj.forEach((value: any, key: any) => {
                const k = mapValue(key, replace, seen), v = mapValue(value, replace, seen);
                append(k, v, k !== key || v !== value);
            });
        } else if (obj instanceof Set) {
            for (const value of obj) {
                const v = mapValue(value, replace, seen);
                append(v, v, v !== value);
            }
        } else {
            for (const key in obj) {
                if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
                const value = obj[key];
                const v = mapValue(value, replace, seen);
                append(key, v, v !== value);
            }
        }
        seen.set(obj, out || obj);
        return out || obj;
    }

    function collectTransfer(value: any, values: Set<Transferable>) {
        if (value instanceof ArrayBuffer || value instanceof MessagePort ||
            value instanceof WritableStream || value instanceof TransformStream ||
            (typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap) ||
            (typeof OffscreenCanvas !== 'undefined' && value instanceof OffscreenCanvas)) values.add(value);
        else if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) values.add(value.buffer);
    }

    function portifyStreams(obj: any, relays: StreamRelay[], transfers = new Set<Transferable>()) {
        return mapValue(obj, (value) => {
            if (!(value instanceof ReadableStream)) {
                collectTransfer(value, transfers);
                return value;
            }
            const channel = new MessageChannel();
            let reader: ReadableStreamDefaultReader;
            try {
                reader = value.getReader();
            } catch (error) {
                channel.port1.close();
                channel.port2.close();
                throw error;
            }
            const port = channel.port1;
            let ended = false;
            let started = false;
            let unregister = () => {};
            let settle: () => void;
            const finished = new Promise<void>((resolve) => { settle = resolve; });
            const finish = (cancel = false, reason?: any) => {
                if (ended) return;
                ended = true;
                port.onmessage = null;
                port.onmessageerror = null;
                // After a normal end the receiver closes its side once it has
                // read {d}; closing here first could reach it as an early close.
                if (cancel) port.close();
                if (cancel) void reader.cancel(reason).catch(() => {});
                reader.releaseLock();
                unregister();
                settle();
            };
            const fail = (error: any) => {
                if (ended) return;
                try { port.postMessage({ e: error?.message || String(error), n: error?.name || 'Error' }); } catch (_) {}
                finish(true, error);
            };
            const readOne = async () => {
                if (ended) return;
                try {
                    const chunk = await reader.read();
                    if (ended) return;
                    if (chunk.done) {
                        port.postMessage({ d: 1 });
                        finish();
                        return;
                    }
                    let value = chunk.value;
                    const transfer: Transferable[] = [];
                    // Producers may reuse or retain chunk buffers. Transfer a
                    // copy so the relay never detaches their storage.
                    if (value instanceof ArrayBuffer) {
                        value = value.slice(0);
                        transfer.push(value);
                    } else if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) {
                        const buffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
                        value = value instanceof DataView ? new DataView(buffer) : new (value.constructor as any)(buffer);
                        transfer.push(buffer);
                    }
                    port.postMessage({ v: value }, transfer);
                } catch (error) {
                    fail(error);
                }
            };
            unregister = register(fail);
            if (ended) unregister();
            // A source that errors while no pull is pending would otherwise go
            // unnoticed until the receiver reads again. releaseLock() in finish()
            // also rejects this, after ended is set.
            reader.closed.catch((error) => fail(error));
            port.addEventListener('close', () => finish(true, new Error('Stream relay receiver closed')));
            port.onmessageerror = () => fail(new Error('Stream relay message could not be deserialized'));
            relays.push({
                finished,
                abandon(cancel = false) {
                    finish(cancel);
                    channel.port2.close();
                },
                start() {
                    if (started || ended) return;
                    started = true;
                    let reads = Promise.resolve();
                    port.onmessage = (event) => {
                        if (event.data?.c) finish(true, event.data.reason);
                        else if (event.data?.p) reads = reads.then(readOne);
                    };
                }
            });
            transfers.add(channel.port2);
            return { __type: 'STREAM_PORT', port: channel.port2 };
        });
    }

    function reviveStreamPorts(obj: any) {
        return mapValue(obj, (value) => {
            if (value.__type !== 'STREAM_PORT' || !(value.port instanceof MessagePort)) return value;
            const port = value.port as MessagePort;
            let ended = false;
            let completePull: (() => void) | undefined;
            let unregister = () => {};
            let fail: (error: Error) => void;
            const close = () => {
                ended = true;
                port.onmessage = null;
                port.onmessageerror = null;
                port.close();
                unregister();
                completePull?.();
                completePull = undefined;
            };
            const cancel = (reason?: any) => {
                if (ended) return;
                try { port.postMessage({ c: 1, reason: reason === undefined ? undefined : String(reason) }); } catch (_) {}
                close();
            };
            return new ReadableStream({
                start(controller) {
                    fail = (error: Error) => {
                        if (ended) return;
                        controller.error(error);
                        cancel(error.message);
                    };
                    port.onmessageerror = () => fail(new Error('Stream relay message could not be deserialized'));
                    port.addEventListener('close', () => fail(new Error('Stream relay closed before the body ended')));
                    port.onmessage = (event) => {
                        if (ended || !event.data) return;
                        const message = event.data;
                        try {
                            if (message.e !== undefined) {
                                const error = new Error(String(message.e));
                                error.name = message.n || 'Error';
                                fail(error);
                            } else if (message.d) {
                                controller.close();
                                close();
                            } else {
                                controller.enqueue(message.v);
                                completePull?.();
                                completePull = undefined;
                            }
                        } catch (error) {
                            fail(error as Error);
                        }
                    };
                    unregister = register(fail);
                    if (ended) unregister();
                },
                pull() {
                    if (ended) return;
                    return new Promise<void>((resolve) => {
                        completePull = resolve;
                        try { port.postMessage({ p: 1 }); }
                        catch (error) { fail(error as Error); }
                    });
                },
                cancel
            });
        });
    }

    async function bufferStreams(obj: any, textStream?: ReadableStream) {
        const buffers = new Map<ReadableStream, ArrayBuffer | string>();
        const readers = new Map<ReadableStream, ReadableStreamDefaultReader>();
        let stopped: Error | undefined;
        const stop = (error: Error) => {
            stopped = error;
            for (const reader of readers.values()) {
                void reader.cancel(error).catch(() => {});
                reader.releaseLock();
            }
            readers.clear();
        };
        const unregister = register(stop);
        try {
            mapValue(obj, (value) => {
                if (value instanceof ReadableStream && !readers.has(value)) readers.set(value, value.getReader());
                return value;
            });
            if (stopped) throw stopped;
            await Promise.all([...readers].map(async ([stream, reader]) => {
                const chunks: Uint8Array[] = [];
                const decoder = stream === textStream ? new TextDecoder() : undefined;
                let text = '', length = 0;
                while (true) {
                    const chunk = await reader.read();
                    if (stopped) throw stopped;
                    if (chunk.done) break;
                    if (decoder) text += typeof chunk.value === 'string' ? chunk.value : decoder.decode(chunk.value, { stream: true });
                    else {
                        if (!(chunk.value instanceof Uint8Array)) throw new TypeError('Body stream chunk must be a Uint8Array');
                        const bytes = chunk.value.slice();
                        chunks.push(bytes);
                        length += bytes.byteLength;
                    }
                }
                if (decoder) buffers.set(stream, text + decoder.decode());
                else {
                    const bytes = new Uint8Array(length);
                    let offset = 0;
                    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
                    buffers.set(stream, bytes.buffer);
                }
                reader.releaseLock();
                readers.delete(stream);
            }));
            return mapValue(obj, (value) => buffers.has(value) ? buffers.get(value) : value);
        } catch (error) {
            stop(error as Error);
            throw error;
        } finally {
            unregister();
        }
    }

    function transferables(obj: any): Transferable[] {
        const values = new Set<Transferable>();
        mapValue(obj, (value) => {
            collectTransfer(value, values);
            return value;
        });
        return [...values];
    }

    return { mapValue, portifyStreams, reviveStreamPorts, bufferStreams, transferables, terminate };
}

export const GUEST_BRIDGE_SCRIPT = `
await (async function() {
    const { portifyStreams, reviveStreamPorts, bufferStreams, transferables: getTransferables, terminate } = (${createStreamRelayBridge.toString()})();
    const pendingRequests = new Map();
    const callbackRegistry = new Map();
    const callbackIdByFunction = new WeakMap();
    const proxyRefRegistry = new Map();
    const abortControllers = new Map();

    function teardown() {
        terminate();
        for (const controller of abortControllers.values()) controller.abort();
        abortControllers.clear();
        for (const request of pendingRequests.values()) request.reject(new Error('plugin sandbox terminated'));
        pendingRequests.clear();
    }
    // Teardown is driven only by the host's SANDBOX_TERMINATED. pagehide also
    // fires when the page enters the back/forward cache or is backgrounded on
    // mobile, and must not kill a plugin that will be resumed.

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
        if (obj instanceof ReadableStream) return transferables;
        for (const value of getTransferables(obj)) transferables.push(value);
        return transferables;
    }

    function send(payload, transferables = []) {
        window.parent.postMessage(payload, '*', transferables);
    }

    function sendRequest(type, payload) {
        return new Promise((resolve, reject) => {
            const reqId = Math.random().toString(36).substring(7);
            pendingRequests.set(reqId, { resolve, reject });


            const relays = [];
            try {
                if (payload.args) payload.args = payload.args.map(serializeArg);
                const message = { type, reqId, ...payload };
                try {
                    send(message);
                } catch (error) {
                    if (error?.name !== 'DataCloneError') throw error;
                    const transfers = new Set();
                    const prepared = portifyStreams(message, relays, transfers);
                    prepared.relay = 1;
                    send(prepared, [...transfers]);
                }
                for (const relay of relays) relay.start();
            } catch (error) {
                for (const relay of relays) relay.abandon(true);
                pendingRequests.delete(reqId);
                reject(error);
            }
        });
    }

    
    
    
    window.addEventListener('message', async (event) => {
        const data = event.data;
        if (!data) return;


        if (data.type === 'SANDBOX_TERMINATED') { teardown(); return; }

        if (data.type === 'RESPONSE' && data.reqId) {
            const req = pendingRequests.get(data.reqId);
            if (req) {
                if (data.error) req.reject(new Error(data.error));
                else {
                    try { req.resolve(deserializeResult(data.relay === 1 ? reviveStreamPorts(data.result) : data.result)); }
                    catch (error) { req.reject(error); }
                }
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
            }
        }

        else if (data.type === 'INVOKE_CALLBACK' && data.id) {
            const fn = callbackRegistry.get(data.id);
            const response = { type: 'CALLBACK_RETURN', reqId: data.reqId };
            const usedAbortIds = [];
            try {
                if (!fn) throw new Error("Callback not found or released");
                const deserializedArgs = (data.relay === 1 ? reviveStreamPorts(data.args || []) : data.args || []).map(function(a) {
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
            const cleanup = () => {
                for (const id of usedAbortIds) abortControllers.delete(id);
            };
            const original = response.result;
            const relays = [];
            let relayed = false;
            try {
                try {
                    send(response);
                } catch (error) {
                    if (error?.name !== 'DataCloneError') throw error;
                    const transfers = new Set();
                    response.result = portifyStreams(original, relays, transfers);
                    response.relay = 1;
                    send(response, [...transfers]);
                }
                if (relays.length) {
                    relayed = true;
                    void Promise.all(relays.map((relay) => relay.finished)).then(cleanup);
                    for (const relay of relays) relay.start();
                }
            } catch (err) {
                for (const relay of relays) relay.abandon();
                try {
                    // Provider callbacks consume content as text when it is
                    // not a stream; keep that existing fallback contract.
                    response.result = await bufferStreams(original, original && original.content);
                    delete response.relay;
                    send(response, collectTransferables(response));
                } catch (err2) {
                    send({ type: 'CALLBACK_RETURN', reqId: data.reqId, error: 'plugin bridge transfer failed: ' + (err2 && err2.message || err2) });
                }
            } finally {
                if (!relayed) cleanup();
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

    private streamBridge = createStreamRelayBridge();
    private instanceRegistry = new Map<string, any>();
    private abortControllers = new Map<string, AbortController>();
    private messageHandlerRef: ((event: MessageEvent) => void) | null = null;
    private callbackWrapperCache = new Map<string, Function>();

    private pendingCallbacks = new Map<string, { resolve: Function, reject: Function }>();
    private pendingExecutions = new Set<(error: Error) => void>();

    constructor(apiFactory: any) {
        this.apiFactory = apiFactory;
    }

    public executeInIframe(code: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const reqId = 'exec_' + Math.random().toString(36).substring(2);

            const abandon = (error: Error) => {
                window.removeEventListener('message', handler);
                this.pendingExecutions.delete(abandon);
                reject(error);
            };
            const handler = (event: MessageEvent) => {
                if (event.source !== this.iframe.contentWindow) return;
                const data = event.data;

                if (data?.type === 'EXEC_RESULT' && data.reqId === reqId) {
                    window.removeEventListener('message', handler);
                    this.pendingExecutions.delete(abandon);
                    if (data.error) {
                        reject(new Error(data.error));
                    } else {
                        resolve(data.result);
                    }
                }
            };

            window.addEventListener('message', handler);
            this.pendingExecutions.add(abandon);

            this.iframe.contentWindow?.postMessage({
                type: 'EXECUTE_CODE',
                reqId,
                code
            }, '*');
        });
    }

    private collectTransferables(obj: any): Transferable[] {
        return this.streamBridge.transferables(obj);
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
                        const relays: StreamRelay[] = [];
                        try {
                            try {
                                this.iframe.contentWindow.postMessage(message, '*', []);
                            } catch (error) {
                                if ((error as Error)?.name !== 'DataCloneError') throw error;
                                const transfers = new Set<Transferable>();
                                const prepared = this.streamBridge.portifyStreams(message, relays, transfers);
                                prepared.relay = 1;
                                this.iframe.contentWindow.postMessage(prepared, '*', [...transfers]);
                            }
                            for (const relay of relays) relay.start();
                        } catch (e) {
                            for (const relay of relays) relay.abandon(true);
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

        // Permissions Policy: let plugins keep the screen awake during
        // long-running streams (mobile Safari kills streaming on screen-off).
        this.iframe.setAttribute('allow', 'screen-wake-lock')

        this.iframe.setAttribute('csp', this.csp);

        const messageHandler = async (event: MessageEvent) => {
            if (event.source !== this.iframe.contentWindow) return;
            const data = event.data as RpcMessage;
            // event.data can be null when the sender transferred something this
            // realm cannot deserialize (e.g. a ReadableStream from the sandboxed
            // iframe) — guard instead of crashing the whole RPC handler.
            if (!data || typeof data.type !== 'string') return;

            if (data.type === 'SANDBOX_TERMINATED') {
                this.terminate();
                return;
            }

            if (data.type === 'CALLBACK_RETURN') {
                const req = this.pendingCallbacks.get(data.reqId!);
                if (req) {
                    if (data.error) req.reject(new Error(data.error));
                    else {
                        try { req.resolve(data.relay === 1 ? this.streamBridge.reviveStreamPorts(data.result) : data.result); }
                        catch (error) { req.reject(error); }
                    }
                    this.pendingCallbacks.delete(data.reqId!);
                }
                return;
            }

            if (data.type === 'ABORT_SIGNAL') {
                const controller = this.abortControllers.get(data.abortId!);
                if (controller) {
                    controller.abort();
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
                const relays: StreamRelay[] = [];
                let relayed = false;
                const cleanup = () => {
                    for (const id of usedAbortIds) this.abortControllers.delete(id);
                };
                try {

                    const args = this.deserializeArgs(data.relay === 1 ? this.streamBridge.reviveStreamPorts(data.args || []) : data.args || [], usedAbortIds);
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


                    // MessagePorts and ArrayBuffer chunks also work on WebKit;
                    // no native ReadableStream crosses the iframe boundary.
                    response.result = this.serialize(result);
                } catch (err: any) {
                    response.error = err.message || "Host execution error";
                }

                const original = response.result;
                try {
                    try {
                        try {
                            this.iframe.contentWindow!.postMessage(response, '*', []);
                        } catch (error) {
                            if ((error as Error)?.name !== 'DataCloneError') throw error;
                            const transfers = new Set<Transferable>();
                            response.result = this.streamBridge.portifyStreams(original, relays, transfers);
                            response.relay = 1;
                            this.iframe.contentWindow!.postMessage(response, '*', [...transfers]);
                        }
                    } catch (error) {
                        // Pumps have not started: release the readers before
                        // buffering, so fallback cannot lose any body bytes.
                        for (const relay of relays) relay.abandon();
                        response.result = await this.streamBridge.bufferStreams(original);
                        delete response.relay;
                        this.iframe.contentWindow!.postMessage(response, '*', this.collectTransferables(response));
                        return;
                    }
                    if (relays.length) {
                        relayed = true;
                        void Promise.all(relays.map((relay) => relay.finished)).then(cleanup);
                        for (const relay of relays) relay.start();
                    }
                } catch (error) {
                    console.error('Failed to post message to iframe:', error);
                    this.iframe.contentWindow?.postMessage({
                        type: 'RESPONSE',
                        reqId: data.reqId,
                        error: 'Failed to post message to iframe: ' + (error as Error).message
                    }, '*');
                } finally {
                    if (!relayed) cleanup();
                }
            }
        };

        this.messageHandlerRef = messageHandler;
        window.addEventListener('message', this.messageHandlerRef);


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
            this.terminate();
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
        this.streamBridge.terminate();
        for (const controller of this.abortControllers.values()) controller.abort();
        try { this.iframe?.contentWindow?.postMessage({ type: 'SANDBOX_TERMINATED' }, '*'); } catch (_) {}
        if (this.messageHandlerRef) {
            window.removeEventListener('message', this.messageHandlerRef);
            this.messageHandlerRef = null;
        }
        if (this.iframe) {
            this.iframe.remove();
        }
        this.instanceRegistry.clear();
        this.rejectPendingCallbacks('plugin sandbox terminated');
        for (const abandon of [...this.pendingExecutions]) abandon(new Error('plugin sandbox terminated'));
        this.abortControllers.clear();
        this.callbackWrapperCache.clear();
    }
}
