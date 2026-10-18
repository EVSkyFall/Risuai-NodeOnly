// @vitest-environment node
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createStreamRelayBridge, GUEST_BRIDGE_SCRIPT, SandboxHost } from './factory';

const bridge = createStreamRelayBridge();
const NativeMessageChannel = MessageChannel;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const bytes = (...chunks: number[][]) => new ReadableStream<Uint8Array>({
    start(controller) {
        for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
        controller.close();
    }
});

function relay(source: ReadableStream) {
    const relays: Parameters<typeof bridge.portifyStreams>[1] = [];
    const descriptor = bridge.portifyStreams(source, relays);
    const received = structuredClone(descriptor, { transfer: bridge.transferables(descriptor) });
    const stream = bridge.reviveStreamPorts(received) as ReadableStream;
    relays.forEach((item) => item.start());
    return { stream, received, finished: Promise.all(relays.map((item) => item.finished)) };
}

function captureChannels() {
    const channels: MessageChannel[] = [];
    vi.stubGlobal('MessageChannel', class {
        constructor() {
            const channel = new NativeMessageChannel();
            channels.push(channel);
            return channel;
        }
    });
    return channels;
}

function hostHarness(api: any, failPost?: (message: any) => void, Host = SandboxHost) {
    let handler: (event: any) => Promise<void>;
    let guestHandler: (event: any) => void;
    const guestEvents = new Map<string, () => void>();
    const answers: any[] = [];
    const hostPosts: { message: any, transfer: Transferable[] }[] = [];
    const guestPosts: { message: any, transfer: Transferable[] }[] = [];
    class Frame {
        style = {};
        sandbox = { add() {} };
        srcdoc = '';
        setAttribute() {}
        removed = false;
        remove() {
            if (this.removed) return;
            this.removed = true;
            guestEvents.get('unload')?.();
        }
        contentWindow = {
            postMessage(message: any, _origin: string, transfer: Transferable[] = []) {
                hostPosts.push({ message: { ...message }, transfer: [...transfer] });
                failPost?.(message);
                const received = structuredClone(message, { transfer });
                answers.push(received);
                if (guestHandler) queueMicrotask(() => guestHandler({ data: received }));
            }
        };
    }
    vi.stubGlobal('HTMLIFrameElement', Frame);
    vi.stubGlobal('ImageBitmap', class {});
    vi.stubGlobal('window', {
        addEventListener(_name: string, fn: typeof handler) { handler = fn; },
        removeEventListener() {}
    });
    const host = new Host(api);
    const frame = new Frame();
    host.run(frame as unknown as HTMLIFrameElement, '');
    const dispatch = (data: any) => handler({ source: frame.contentWindow, data });
    return {
        host, frame, answers, dispatch, hostPosts, guestPosts,
        controllers: (host as any).abortControllers as Map<string, AbortController>,
        async guest(script = GUEST_BRIDGE_SCRIPT, failSend?: (message: any) => void) {
            const guestWindow: any = {
                walkCalls: 0,
                postMessage() {},
                addEventListener(name: string, fn: any) {
                    if (name === 'message') guestHandler = fn;
                    else guestEvents.set(name, fn);
                },
                parent: {
                    postMessage(message: any, _origin: string, transfer: Transferable[] = []) {
                        guestPosts.push({ message: { ...message }, transfer: [...transfer] });
                        failSend?.(message);
                        const data = structuredClone(message, { transfer });
                        queueMicrotask(() => { void dispatch(data); });
                    }
                }
            };
            const instrumented = script
                .replace(/function mapValue[^\n]*\{/, '$& window.walkCalls++;')
                .replace('const abortControllers = new Map();', 'const abortControllers = new Map(); window.controllers = abortControllers;')
                .replace('const pendingRequests = new Map();', 'const pendingRequests = new Map(); window.pendingRequests = pendingRequests;');
            await new Function('window', 'return (async () => {' + instrumented + '})()')(guestWindow);
            return {
                api: guestWindow.Risuai,
                controllers: guestWindow.controllers as Map<string, AbortController>,
                pendingRequests: guestWindow.pendingRequests as Map<string, unknown>,
                get walkCalls() { return guestWindow.walkCalls as number; },
                teardown: (event: string) => guestEvents.get(event)?.()
            };
        }
    };
}

const call = (method = 'fetch', args: any[] = []) => ({ type: 'CALL_ROOT', reqId: 'request', method, args });
const abortArgs = [{ signal: { __type: 'ABORT_SIGNAL_REF', abortId: 'signal', aborted: false } }];
const initialization = { _getPropertiesForInitialization: () => ({ list: [] }), _getAliases: () => ({}) };
afterEach(() => vi.unstubAllGlobals());

describe('shared MessagePort stream relay', () => {
    test('transfers a multi-chunk body byte-identically without detaching producer buffers', async () => {
        const retained = new Uint8Array([0, 255, 128, 3, 4]);
        const source = new ReadableStream({
            start(controller) {
                controller.enqueue(retained.subarray(0, 3));
                controller.enqueue(retained.subarray(3));
                controller.close();
            }
        });
        const result = relay(source);
        expect(new Uint8Array(await new Response(result.stream).arrayBuffer())).toEqual(retained);
        expect(retained.byteLength).toBe(5);
        await result.finished;
        expect(source.locked).toBe(false);
    });

    test('an empty body settles', async () => {
        const result = relay(bytes());
        expect((await new Response(result.stream).arrayBuffer()).byteLength).toBe(0);
        await result.finished;
    });

    test('three reads from a synchronous infinite source only pull a few chunks before cancellation', async () => {
        let produced = 0;
        const cancel = vi.fn();
        const source = new ReadableStream({
            pull(controller) { controller.enqueue(new Uint8Array([++produced])); },
            cancel
        });
        const result = relay(source);
        const reader = result.stream.getReader();
        for (let value = 1; value <= 3; value++) {
            expect((await reader.read()).value).toEqual(new Uint8Array([value]));
        }
        await reader.cancel('enough');
        await result.finished;
        expect(cancel).toHaveBeenCalledWith('enough');
        expect(produced).toBeLessThanOrEqual(5);
        const stoppedAt = produced;
        await tick();
        expect(produced).toBe(stoppedAt);
        expect(source.locked).toBe(false);
    });

    test('a sender reads exactly once per pull request', async () => {
        let reads = 0;
        const source = new ReadableStream({ pull(c) { c.enqueue(++reads); } }, { highWaterMark: 0 });
        const relays: Parameters<typeof bridge.portifyStreams>[1] = [];
        const { port } = bridge.portifyStreams(source, relays);
        const next = () => new Promise<any>((resolve) => { port.onmessage = (event: MessageEvent) => resolve(event.data); });
        relays[0].start();
        await tick();
        expect(reads).toBe(0);
        for (let value = 1; value <= 3; value++) {
            const chunk = next();
            port.postMessage({ p: 1 });
            expect(await chunk).toEqual({ v: value });
            await tick();
            expect(reads).toBe(value);
        }
        port.postMessage({ c: 1 });
        await relays[0].finished;
        port.close();
        expect(source.locked).toBe(false);
    });

    test('a reader error rejects arrayBuffer and releases its reader', async () => {
        const source = new ReadableStream({ pull() { throw new Error('upstream failed'); } });
        const result = relay(source);
        await expect(new Response(result.stream).arrayBuffer()).rejects.toThrow('upstream failed');
        await result.finished;
        expect(source.locked).toBe(false);
    });

    test('receiver cancellation reaches the producer, even when cancellation rejects', async () => {
        const cancel = vi.fn().mockRejectedValue(new Error('cancel failed'));
        const source = new ReadableStream({ cancel });
        const result = relay(source);
        await result.stream.cancel('consumer stopped');
        await result.finished;
        await tick();
        expect(cancel).toHaveBeenCalledWith('consumer stopped');
        expect(source.locked).toBe(false);
    });

    test('receiver messageerror rejects pending reads and cancels the producer', async () => {
        const cancel = vi.fn();
        const result = relay(new ReadableStream({ cancel }));
        const reading = new Response(result.stream).arrayBuffer();
        result.received.port.dispatchEvent(new MessageEvent('messageerror'));
        await expect(reading).rejects.toThrow('could not be deserialized');
        await result.finished;
        expect(cancel).toHaveBeenCalledOnce();
    });

    test('sender messageerror rejects the receiver and cancels its pending read', async () => {
        const channels = captureChannels();
        const cancel = vi.fn();
        const result = relay(new ReadableStream({ cancel }));
        const reading = new Response(result.stream).arrayBuffer();
        channels[0].port1.dispatchEvent(new MessageEvent('messageerror'));
        await expect(reading).rejects.toThrow('could not be deserialized');
        await result.finished;
        expect(cancel).toHaveBeenCalledOnce();
    });

    test('chunk posting failure sends an error and cancels the source', async () => {
        const channels = captureChannels();
        const cancel = vi.fn();
        const source = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel });
        const result = relay(source);
        const port = channels[0].port1;
        const post = port.postMessage.bind(port);
        vi.spyOn(port, 'postMessage').mockImplementation((message: any, transfer: any) => {
            if ('v' in message) throw new Error('chunk clone failed');
            post(message, transfer);
        });
        await expect(new Response(result.stream).arrayBuffer()).rejects.toThrow('chunk clone failed');
        await result.finished;
        expect(cancel).toHaveBeenCalledOnce();
    });

    test('nested streams, aliases and cycles are preserved across structured clone', async () => {
        const source = bytes([1, 2]);
        const input: any = { array: [source], map: new Map([['body', source]]), set: new Set([source]) };
        input.self = input;
        const relays: Parameters<typeof bridge.portifyStreams>[1] = [];
        const prepared = bridge.portifyStreams(input, relays);
        const received = bridge.reviveStreamPorts(structuredClone(prepared, { transfer: bridge.transferables(prepared) }));
        relays.forEach((item) => item.start());
        expect(received.self).toBe(received);
        expect(received.map.get('body')).toBe(received.array[0]);
        expect([...received.set][0]).toBe(received.array[0]);
        expect(new Uint8Array(await new Response(received.array[0]).arrayBuffer())).toEqual(new Uint8Array([1, 2]));
        expect(relays).toHaveLength(1);
    });

    test('an early sender close errors the receiving stream', async () => {
        const channel = new NativeMessageChannel();
        const stream = bridge.reviveStreamPorts({ __type: 'STREAM_PORT', port: channel.port2 }) as ReadableStream;
        const reading = stream.getReader().read();
        channel.port1.close();
        await expect(reading).rejects.toThrow('closed before the body ended');
    });

    test('an early receiver close cancels the source', async () => {
        const cancel = vi.fn();
        const relays: Parameters<typeof bridge.portifyStreams>[1] = [];
        const descriptor = bridge.portifyStreams(new ReadableStream({ cancel }), relays);
        relays.forEach((item) => item.start());
        descriptor.port.close();
        await relays[0].finished;
        expect(cancel).toHaveBeenCalledOnce();
    });

    test('a source error with no pending pull settles the relay and reaches the receiver', async () => {
        let source!: ReadableStreamDefaultController;
        const relays: Parameters<typeof bridge.portifyStreams>[1] = [];
        const descriptor = bridge.portifyStreams(new ReadableStream({ start(controller) { source = controller; } }), relays);
        const received = bridge.reviveStreamPorts(structuredClone(descriptor, { transfer: [descriptor.port] })) as ReadableStream;
        relays.forEach((item) => item.start());
        source.error(new Error('network down'));
        await relays[0].finished;
        await expect(received.getReader().read()).rejects.toThrow('network down');
    });

    test('a normal end is not reported as an early close', async () => {
        const { stream } = relay(bytes([1, 2], [3]));
        expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
        await tick();
    });

    test('stream-free results pass through without copying, and only changed branches are copied', () => {
        const shared = { text: 'x' };
        const input: any = { list: [shared, { n: 1 }], map: new Map([['k', shared]]), set: new Set([shared]), stream: bytes([1]) };
        const plain = { db: input.list, meta: shared };
        const relays: Parameters<typeof bridge.portifyStreams>[1] = [];
        expect(bridge.portifyStreams(plain, relays)).toBe(plain);
        expect(relays).toHaveLength(0);
        const prepared = bridge.portifyStreams(input, relays);
        expect(prepared).not.toBe(input);
        expect(prepared.list).toBe(input.list);
        expect(prepared.map).toBe(input.map);
        expect(prepared.stream.__type).toBe('STREAM_PORT');
        relays.forEach((item) => item.abandon());
    });

    test('a cycle through a copied container never leaks the original stream', () => {
        const input: any = { body: bytes([1]), child: {} };
        input.child.parent = input;
        const relays: Parameters<typeof bridge.portifyStreams>[1] = [];
        const prepared = bridge.portifyStreams(input, relays);
        expect(prepared.child.parent).toBe(prepared);
        expect(bridge.transferables(prepared).some((item) => item instanceof ReadableStream)).toBe(false);
        relays.forEach((item) => item.abandon());
    });

    test('lazy backfill preserves Map keys, Set entries, sparse arrays and own __proto__', () => {
        const before = { unchanged: true };
        const source = bytes([9]);
        const sparse: any[] = new Array(5);
        sparse[1] = before;
        sparse[4] = source;
        Object.defineProperty(sparse, '__proto__', { value: before, enumerable: true });
        const input: any = {
            map: new Map<any, any>([[before, before], [source, source]]),
            set: new Set([before, source]), sparse
        };
        input.self = input;
        const relays: Parameters<typeof bridge.portifyStreams>[1] = [];
        const transfers = new Set<Transferable>();
        const result = bridge.portifyStreams(input, relays, transfers);
        expect(result.self).toBe(result);
        expect(result.map.get(before)).toBe(before);
        expect([...result.map.keys()][1]).toBe(result.sparse[4]);
        expect([...result.set]).toEqual([before, result.sparse[4]]);
        expect(0 in result.sparse).toBe(false);
        expect(3 in result.sparse).toBe(false);
        expect(result.sparse.length).toBe(5);
        expect(Object.getOwnPropertyDescriptor(result.sparse, '__proto__')?.value).toBe(before);
        expect([...transfers]).toEqual([result.sparse[4].port]);
        relays.forEach((item) => item.abandon());
    });
});

describe('SandboxHost RESPONSE lifecycle', () => {
    test('mid-body abort still reaches the host controller after the RPC returned', async () => {
        let signal: AbortSignal;
        const harness = hostHarness({ fetch(options: any) {
            signal = options.signal;
            return new Response(new ReadableStream({ start(controller) {
                controller.enqueue(new Uint8Array([1]));
                signal.addEventListener('abort', () => controller.error(new DOMException('Body aborted', 'AbortError')));
            } }));
        } });
        await harness.dispatch(call('fetch', abortArgs));
        expect(harness.controllers.has('signal')).toBe(true);
        const body = bridge.reviveStreamPorts(harness.answers[0].result.value);
        const reading = new Response(body).arrayBuffer();
        const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
        await harness.dispatch({ type: 'ABORT_SIGNAL', abortId: 'signal' });
        expect(signal!.aborted).toBe(true);
        await rejected;
        expect(harness.controllers.size).toBe(0);
    });

    test.each(['done', 'error', 'cancel'] as const)('keeps controllers until every nested stream ends: %s', async (ending) => {
        let last: ReadableStreamDefaultController;
        const canceled = vi.fn();
        const harness = hostHarness({ fetch: () => ({ first: bytes([7]), last: new ReadableStream({ start(c) { last = c; }, cancel: canceled }) }) });
        await harness.dispatch(call('fetch', abortArgs));
        const result = bridge.reviveStreamPorts(harness.answers[0].result);
        await new Response(result.first).arrayBuffer();
        expect(harness.controllers.has('signal')).toBe(true);
        if (ending === 'cancel') {
            await result.last.cancel();
            await vi.waitFor(() => expect(canceled).toHaveBeenCalledOnce());
        } else {
            const reading = new Response(result.last).arrayBuffer();
            if (ending === 'done') { last!.close(); await reading; }
            else { last!.error(new Error('last failed')); await expect(reading).rejects.toThrow('last failed'); }
        }
        expect(harness.controllers.size).toBe(0);
    });

    test('calls without streams clean controllers up immediately', async () => {
        const harness = hostHarness({ fetch: () => 42 });
        await harness.dispatch(call('fetch', abortArgs));
        expect(harness.answers[0].result).toBe(42);
        expect(harness.controllers.size).toBe(0);
    });

    test('failed port posting buffers all original bytes and preserves Response metadata', async () => {
        const post = vi.fn((message: any) => {
            if (message.result?.value?.__type === 'STREAM_PORT') throw new Error('port clone failed');
        });
        const harness = hostHarness({ fetch: () => new Response(bytes([0, 255], [128, 9]), { status: 201, statusText: 'Created', headers: { 'x-test': 'kept' } }) }, post);
        await harness.dispatch(call('fetch', abortArgs));
        expect(post).toHaveBeenCalledTimes(3);
        expect(harness.answers).toHaveLength(1);
        expect(harness.hostPosts.map(({ message }) => message.relay)).toEqual([undefined, 1, undefined]);
        expect(harness.answers[0]).not.toHaveProperty('relay');
        const result = harness.answers[0].result;
        expect(result.value).toBeInstanceOf(ArrayBuffer);
        const response = new Response(result.value, result.init);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255, 128, 9]));
        expect(response.status).toBe(201);
        expect(response.statusText).toBe('Created');
        expect(response.headers.get('x-test')).toBe('kept');
        expect(harness.controllers.size).toBe(0);
    });

    test('partial relay preparation failure releases earlier readers before buffering', async () => {
        let created = 0;
        vi.stubGlobal('MessageChannel', class {
            constructor() {
                if (++created === 2) throw new Error('channel allocation failed');
                return new NativeMessageChannel();
            }
        });
        const harness = hostHarness({ fetch: () => ({ first: bytes([1]), second: bytes([2]) }) });
        await harness.dispatch(call('fetch', abortArgs));
        expect(harness.answers).toHaveLength(1);
        expect(harness.answers[0].error).toBeUndefined();
        expect(new Uint8Array(harness.answers[0].result.first)).toEqual(new Uint8Array([1]));
        expect(new Uint8Array(harness.answers[0].result.second)).toEqual(new Uint8Array([2]));
        expect(harness.controllers.size).toBe(0);
    });

    test.each(['buffer read', 'buffer post'])('failed %s produces exactly one error answer', async (failure) => {
        const harness = hostHarness({ fetch: () => new Response(failure === 'buffer read'
            ? new ReadableStream({ pull() { throw new Error('read failed'); } }) : bytes([1])) }, (message) => {
            if (!message.error) throw new Error('post failed');
        });
        await harness.dispatch(call('fetch', abortArgs));
        expect(harness.answers).toHaveLength(1);
        expect(harness.answers[0]).toMatchObject({ type: 'RESPONSE', reqId: 'request', error: expect.stringContaining('failed') });
        expect(harness.controllers.size).toBe(0);
    });

    test('CALL_INSTANCE also relays Response bodies', async () => {
        const harness = hostHarness({});
        (harness.host as any).instanceRegistry.set('instance', { fetch: () => new Response(bytes([4, 5])) });
        await harness.dispatch({ ...call(), type: 'CALL_INSTANCE', id: 'instance' });
        const body = bridge.reviveStreamPorts(harness.answers[0].result.value);
        expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(new Uint8Array([4, 5]));
    });

    test('embedded guest consumes binary Responses and callback SSE in both directions', async () => {
        const harness = hostHarness({
            _getPropertiesForInitialization: () => ({ list: [] }),
            _getAliases: () => ({}),
            fetch: () => new Response(bytes([0, 255], [3]), { status: 202, statusText: 'Accepted', headers: { 'x-test': 'ok' } }),
            callback: async (fn: any) => new Response(await fn())
        });
        const { api: guest } = await harness.guest();
        const response = await guest.fetch();
        expect(response.status).toBe(202);
        expect(response.statusText).toBe('Accepted');
        expect(response.headers.get('x-test')).toBe('ok');
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255, 3]));
        const sse = await guest.callback(() => bytes([...new TextEncoder().encode('data: hello\n\n')], [...new TextEncoder().encode('data: end\n\n')]));
        expect(await sse.text()).toBe('data: hello\n\ndata: end\n\n');
    });

    test.each(['string', 'bytes'])('guest callback fallback preserves provider content text: %s', async (kind) => {
        let received: any;
        const harness = hostHarness({
            _getPropertiesForInitialization: () => ({ list: [] }), _getAliases: () => ({}),
            callback: async (fn: any) => { received = await fn(); return received; }
        });
        const failSend = vi.fn((message: any) => {
            if (message.type === 'CALLBACK_RETURN' && message.result?.content?.__type === 'STREAM_PORT') throw new Error('port post failed');
        });
        const { api: guest } = await harness.guest(GUEST_BRIDGE_SCRIPT, failSend);
        const text = 'data: 한글\n\n';
        const encoded = new TextEncoder().encode(text);
        const content = new ReadableStream({ start(controller) {
            if (kind === 'string') {
                controller.enqueue(text.slice(0, 7));
                controller.enqueue(text.slice(7));
            } else {
                controller.enqueue(encoded.subarray(0, 7));
                controller.enqueue(encoded.subarray(7));
            }
            controller.close();
        } });
        expect(await guest.callback(() => ({ content }))).toEqual({ content: text });
        expect(received).toEqual({ content: text });
        expect(failSend.mock.calls.filter(([message]) => message.type === 'CALLBACK_RETURN')).toHaveLength(3);
        expect(harness.guestPosts.filter(({ message }) => message.type === 'CALLBACK_RETURN')
            .map(({ message }) => message.relay)).toEqual([undefined, 1, undefined]);
        expect(content.locked).toBe(false);
    });

    test('embedded guest revives shared stream references and preserves top-level null Response bodies', async () => {
        const harness = hostHarness({
            _getPropertiesForInitialization: () => ({ list: [] }), _getAliases: () => ({}),
            fetch: () => {
                const body = bytes([5, 6]);
                return { body, alias: body };
            },
            empty: () => new Response(null, { status: 204 })
        });
        const { api: guest } = await harness.guest();
        const result = await guest.fetch();
        expect(result.alias).toBe(result.body);
        expect(new Uint8Array(await new Response(result.body).arrayBuffer())).toEqual(new Uint8Array([5, 6]));
        const empty = await guest.empty();
        expect(empty.status).toBe(204);
        expect(empty.body).toBeNull();
    });

    test('embedded guest aborts while reading the body through the full RPC path', async () => {
        let hostSignal: AbortSignal;
        const harness = hostHarness({
            _getPropertiesForInitialization: () => ({ list: [] }), _getAliases: () => ({}),
            fetch: ({ signal }: { signal: AbortSignal }) => {
                hostSignal = signal;
                return new Response(new ReadableStream({ start(controller) {
                    controller.enqueue(new Uint8Array([1]));
                    signal.addEventListener('abort', () => controller.error(signal.reason));
                } }));
            }
        });
        const { api: guest } = await harness.guest();
        const controller = new AbortController();
        const response = await guest.fetch({ signal: controller.signal });
        expect(harness.controllers.size).toBe(1);
        const reading = response.arrayBuffer();
        const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
        controller.abort();
        await rejected;
        expect(hostSignal!.aborted).toBe(true);
        expect(harness.controllers.size).toBe(0);
    });

    test('the embedded factory works after the production minifier', async () => {
        const { build } = await import('vite');
        const output: any = await build({
            configFile: false, envFile: false, logLevel: 'silent',
            build: {
                write: false, target: 'baseline-widely-available', minify: 'oxc',
                lib: { entry: new URL('./factory.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), name: 'RelayFactory', formats: ['iife'] }
            }
        });
        const bundle = (Array.isArray(output) ? output[0] : output).output.find((item: any) => item.type === 'chunk').code;
        const built = new Function(bundle + '; return RelayFactory;')();
        const harness = hostHarness({ _getPropertiesForInitialization: () => ({ list: [] }), _getAliases: () => ({}), fetch: () => new Response(bytes([6, 7])) }, undefined, built.SandboxHost);
        const { api: guest } = await harness.guest(built.GUEST_BRIDGE_SCRIPT);
        expect(new Uint8Array(await (await guest.fetch()).arrayBuffer())).toEqual(new Uint8Array([6, 7]));
    });
});

describe('RPC structured-clone fast path', () => {
    function trackHostWalks(host: SandboxHost) {
        const streamBridge = (host as any).streamBridge;
        return ['portifyStreams', 'reviveStreamPorts', 'bufferStreams', 'transferables']
            .map((method) => vi.spyOn(streamBridge, method));
    }

    test.each(['root', 'instance'])('a large %s result posts the original 200k-object graph without any bridge walk', async (kind) => {
        const result = { rows: Array.from({ length: 100_000 }, (_, index) => ({ index, nested: { value: index } })) };
        const getDatabase = () => result;
        const harness = hostHarness({ ...initialization, getDatabase,
            getInstance: () => ({ __classType: 'REMOTE_REQUIRED', getDatabase })
        });
        const walks = trackHostWalks(harness.host);
        const guest = await harness.guest();
        const target = kind === 'root' ? guest.api : await guest.api.getInstance();
        const received = await target.getDatabase();
        const posts = harness.hostPosts.filter(({ message }) => message.result === result);
        expect(posts).toHaveLength(1);
        expect(posts[0].message).not.toHaveProperty('relay');
        expect(posts[0].message.result.rows).toBe(result.rows);
        expect(posts[0].transfer).toEqual([]);
        expect(received.rows).toHaveLength(100_000);
        expect(received.rows[99_999]).toEqual({ index: 99_999, nested: { value: 99_999 } });
        for (const walk of walks) expect(walk).not.toHaveBeenCalled();
        expect(guest.walkCalls).toBe(0);
    });

    test('stream-free args and callback returns preserve graphs and buffers with zero walks in either direction', async () => {
        const buffer = new Uint8Array([1, 2, 255]);
        const shared = { value: 7 };
        const input: any = { buffer, shared, alias: shared, map: new Map([[shared, shared]]), set: new Set([shared]) };
        input.self = input;
        let hostInput: any, callbackInput: any;
        const harness = hostHarness({ ...initialization, callback: async (value: any, fn: any) => {
            hostInput = value;
            const result = await fn(value);
            expect(value.buffer.byteLength).toBe(3);
            return result;
        } });
        const walks = trackHostWalks(harness.host);
        const guest = await harness.guest();
        const result = await guest.api.callback(input, (value: any) => { callbackInput = value; return value; });
        for (const value of [input, hostInput, callbackInput, result]) {
            expect(value.self).toBe(value);
            expect(value.alias).toBe(value.shared);
            expect(value.map.get(value.shared)).toBe(value.shared);
            expect(value.set.has(value.shared)).toBe(true);
            expect(value.buffer).toEqual(new Uint8Array([1, 2, 255]));
        }
        const request = harness.guestPosts.find(({ message }) => message.method === 'callback')!;
        const invocation = harness.hostPosts.find(({ message }) => message.type === 'INVOKE_CALLBACK')!;
        const returned = harness.guestPosts.find(({ message }) => message.type === 'CALLBACK_RETURN')!;
        expect(request.message.args[0]).toBe(input);
        expect(invocation.message.args[0]).toBe(hostInput);
        expect(returned.message.result).toBe(callbackInput);
        for (const post of [...harness.hostPosts, ...harness.guestPosts]) {
            expect(post.message).not.toHaveProperty('relay');
            expect(post.transfer).toEqual([]);
        }
        for (const walk of walks) expect(walk).not.toHaveBeenCalled();
        expect(guest.walkCalls).toBe(0);
        expect(guest.pendingRequests.size).toBe(0);
        expect((harness.host as any).pendingCallbacks.size).toBe(0);
    });

    test('stream args, callback returns and Response bodies use flagged retries and deliver one answer per request', async () => {
        const harness = hostHarness({ ...initialization, callback: async (value: any, fn: any) => {
            const result = await fn(value);
            return new Response(result.body, { status: 202, headers: { 'x-test': 'kept' } });
        } });
        const guest = await harness.guest();
        const source = bytes([0, 255], [3, 4]);
        const response = await guest.api.callback({ body: source, alias: source }, (value: any) => {
            expect(value.body).toBeInstanceOf(ReadableStream);
            expect(value.alias).toBe(value.body);
            return value;
        });
        expect(response.status).toBe(202);
        expect(response.headers.get('x-test')).toBe('kept');
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255, 3, 4]));
        const calls = harness.guestPosts.filter(({ message }) => message.method === 'callback');
        const invocations = harness.hostPosts.filter(({ message }) => message.type === 'INVOKE_CALLBACK');
        const returns = harness.guestPosts.filter(({ message }) => message.type === 'CALLBACK_RETURN');
        const responses = harness.hostPosts.filter(({ message }) => message.reqId === calls[0].message.reqId);
        for (const attempts of [calls, invocations, returns, responses]) {
            expect(attempts.map(({ message }) => message.relay)).toEqual([undefined, 1]);
            expect(attempts[0].transfer).toEqual([]);
            expect(attempts[1].transfer).toHaveLength(1);
            expect(attempts[1].transfer[0]).toBeInstanceOf(MessagePort);
        }
        expect(harness.answers.filter((message) => message.reqId === calls[0].message.reqId)).toHaveLength(1);
        expect(guest.walkCalls).toBeGreaterThan(0);
        expect(guest.pendingRequests.size).toBe(0);
        expect((harness.host as any).pendingCallbacks.size).toBe(0);
        await vi.waitFor(() => expect(source.locked).toBe(false));
    });

    test('a transfer-only MessagePort triggers the flagged path without a ReadableStream', async () => {
        const channel = new NativeMessageChannel();
        const harness = hostHarness({ ...initialization, echo: (value: any) => value });
        const guest = await harness.guest();
        let received: MessagePort | undefined;
        try {
            received = await guest.api.echo(channel.port1);
            expect(received).toBeInstanceOf(MessagePort);
            const requests = harness.guestPosts.filter(({ message }) => message.method === 'echo');
            const responses = harness.hostPosts.filter(({ message }) => message.reqId === requests[0].message.reqId);
            for (const attempts of [requests, responses]) {
                expect(attempts.map(({ message }) => message.relay)).toEqual([undefined, 1]);
                expect(attempts[1].transfer).toHaveLength(1);
            }
        } finally {
            received?.close();
            channel.port1.close();
            channel.port2.close();
        }
    });

    test.each(['guest', 'host'])('a non-clone %s argument post failure does not start a walk', async (side) => {
        const cancel = vi.fn();
        const source = new ReadableStream({ cancel });
        const harness = hostHarness({ ...initialization, upload: vi.fn(), callback: (fn: any) => fn({ body: source }) }, (message) => {
            if (side === 'host' && message.type === 'INVOKE_CALLBACK') throw new Error('post unavailable');
        });
        const walks = trackHostWalks(harness.host);
        const guest = await harness.guest(GUEST_BRIDGE_SCRIPT, (message) => {
            if (side === 'guest' && message.method === 'upload') throw new Error('post unavailable');
        });
        const result = side === 'guest' ? guest.api.upload({ body: source }) : guest.api.callback(() => 1);
        await expect(result).rejects.toThrow('post unavailable');
        for (const walk of walks) expect(walk).not.toHaveBeenCalled();
        expect(guest.walkCalls).toBe(0);
        expect(source.locked).toBe(false);
        expect(cancel).not.toHaveBeenCalled();
        expect(guest.pendingRequests.size).toBe(0);
        expect((harness.host as any).pendingCallbacks.size).toBe(0);
        await source.cancel();
    });
});

describe('round 2 RPC relay regressions', () => {
    test('nested descriptor-shaped JSON survives a guest-host round trip unchanged', async () => {
        const input = {
            nested: { __type: 'CALLBACK_STREAMS', value: 'x', other: 'keep' },
            list: [{ __type: 'REMOTE_REF', id: 'ordinary-data', other: 'keep' }],
            fakePort: { __type: 'STREAM_PORT', port: { ordinary: true } },
            nestedRemoteClass: { __classType: 'REMOTE_REQUIRED', value: 7 }
        };
        const harness = hostHarness({ ...initialization, echo: (value: any) => value });
        const { api } = await harness.guest();
        expect(await api.echo(input)).toEqual(input);
        expect((harness.host as any).instanceRegistry.size).toBe(0);
    });

    test.each(['done', 'error', 'cancel'] as const)('guest controllers live until every callback body finishes: %s', async (ending) => {
        let received: any;
        let last: ReadableStreamDefaultController;
        const controller = new AbortController();
        const harness = hostHarness({ ...initialization, callback: async (fn: any) => {
            received = await fn(controller.signal);
            return 42;
        } });
        const guest = await harness.guest();
        await guest.api.callback(() => ({ first: bytes([1]), last: new ReadableStream({ start(c) { last = c; } }) }));
        await new Response(received.first).arrayBuffer();
        expect(guest.controllers.size).toBe(1);
        if (ending === 'cancel') await received.last.cancel();
        else {
            const reading = new Response(received.last).arrayBuffer();
            if (ending === 'done') { last!.close(); await reading; }
            else { last!.error(new Error('body failed')); await expect(reading).rejects.toThrow('body failed'); }
        }
        await vi.waitFor(() => expect(guest.controllers.size).toBe(0));
    });

    test('a host abort mid-body reaches the guest callback signal', async () => {
        const controller = new AbortController();
        let signal: AbortSignal;
        let received: ReadableStream;
        const harness = hostHarness({ ...initialization, callback: async (fn: any) => {
            received = await fn(controller.signal);
            return 42;
        } });
        const guest = await harness.guest();
        await guest.api.callback((callbackSignal: AbortSignal) => {
            signal = callbackSignal;
            return new ReadableStream({ start(c) {
                c.enqueue(new Uint8Array([1]));
                callbackSignal.addEventListener('abort', () => c.error(callbackSignal.reason));
            } });
        });
        const reader = received!.getReader();
        expect((await reader.read()).value).toEqual(new Uint8Array([1]));
        const rejected = expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
        expect(guest.controllers.size).toBe(1);
        controller.abort();
        await rejected;
        expect(signal!.aborted).toBe(true);
        await vi.waitFor(() => expect(guest.controllers.size).toBe(0));
    });

    test.each(['host'])('%s teardown settles incoming and outgoing bodies on both sides', async (ending) => {
        const hostCancel = vi.fn(), guestCancel = vi.fn();
        const hostSource = new ReadableStream({ cancel: hostCancel });
        const guestSource = new ReadableStream({ cancel: guestCancel });
        let callbackBody: ReadableStream;
        const harness = hostHarness({ ...initialization,
            fetch: () => new Response(hostSource),
            callback: async (fn: any) => { callbackBody = await fn(); return 42; }
        });
        const guest = await harness.guest();
        const response = await guest.api.fetch();
        await guest.api.callback(() => guestSource);
        const guestReading = expect(response.body.getReader().read()).rejects.toThrow('plugin sandbox terminated');
        const hostReading = expect(callbackBody!.getReader().read()).rejects.toThrow('plugin sandbox terminated');
        if (ending === 'host') harness.host.terminate();
        else guest.teardown(ending);
        await Promise.all([guestReading, hostReading]);
        await vi.waitFor(() => {
            expect(hostCancel).toHaveBeenCalledOnce();
            expect(guestCancel).toHaveBeenCalledOnce();
        });
        expect(hostSource.locked).toBe(false);
        expect(guestSource.locked).toBe(false);
    });

    test('pagehide and unload do not tear the guest down', async () => {
        const harness = hostHarness({ ...initialization, fetch: () => new Response(bytes([9])) });
        const guest = await harness.guest();
        guest.teardown('pagehide');
        guest.teardown('unload');
        expect(new Uint8Array(await (await guest.api.fetch()).arrayBuffer())).toEqual(new Uint8Array([9]));
    });

    test('terminate rejects a pending executeInIframe', async () => {
        const harness = hostHarness(initialization);
        const running = harness.host.executeInIframe('1');
        harness.host.terminate();
        await expect(running).rejects.toThrow('plugin sandbox terminated');
    });

    test.each(['preparation', 'read'])('host fallback %s failure cancels sibling readers and cleans controllers', async (failure) => {
        const cancel = vi.fn();
        const first = new ReadableStream({ cancel });
        const second = failure === 'preparation' ? bytes([1]) : new ReadableStream({ pull() { throw new Error('read failed'); } });
        const locked = failure === 'preparation' ? second.getReader() : undefined;
        const harness = hostHarness({ fetch: () => ({ first, second }) }, (message) => {
            if (!message.error) throw new Error('force buffering');
        });
        try {
            await harness.dispatch(call('fetch', abortArgs));
            expect(harness.answers).toHaveLength(1);
            expect(harness.answers[0].error).toBeTruthy();
            expect(cancel).toHaveBeenCalledOnce();
            expect(first.locked).toBe(false);
            expect(harness.controllers.size).toBe(0);
        } finally { locked?.releaseLock(); }
    });

    test.each(['preparation', 'read'])('guest fallback %s failure cancels content and cleans controllers', async (failure) => {
        const cancel = vi.fn();
        const content = new ReadableStream({ cancel });
        const second = failure === 'preparation' ? bytes([1]) : new ReadableStream({ pull() { throw new Error('read failed'); } });
        const locked = failure === 'preparation' ? second.getReader() : undefined;
        const harness = hostHarness({ ...initialization, callback: (fn: any) => fn(new AbortController().signal) });
        const guest = await harness.guest(GUEST_BRIDGE_SCRIPT, (message) => {
            if (message.type === 'CALLBACK_RETURN' && !message.error) throw new Error('force buffering');
        });
        try {
            await expect(guest.api.callback(() => ({ content, second }))).rejects.toThrow('plugin bridge transfer failed');
            expect(cancel).toHaveBeenCalledOnce();
            expect(content.locked).toBe(false);
            expect(guest.controllers.size).toBe(0);
        } finally { locked?.releaseLock(); }
    });

    test('guest fallback retains its abort controller until body handling fails', async () => {
        const controller = new AbortController();
        let signal: AbortSignal;
        let started!: () => void;
        const buffering = new Promise<void>((resolve) => { started = resolve; });
        const harness = hostHarness({ ...initialization, callback: (fn: any) => fn(controller.signal) });
        const guest = await harness.guest(GUEST_BRIDGE_SCRIPT, (message) => {
            if (message.type === 'CALLBACK_RETURN' && !message.error) throw new Error('force buffering');
        });
        const response = guest.api.callback((s: AbortSignal) => {
            signal = s;
            return { content: new ReadableStream({
                start(c) { s.addEventListener('abort', () => c.error(s.reason)); },
                pull() { started(); }
            }, { highWaterMark: 0 }) };
        });
        const rejected = expect(response).rejects.toThrow('aborted');
        await buffering;
        expect(guest.controllers.size).toBe(1);
        controller.abort();
        await rejected;
        expect(signal!.aborted).toBe(true);
        expect(guest.controllers.size).toBe(0);
    });

    test.each(['host', 'guest'])('teardown cancels a stalled %s fallback', async (side) => {
        const cancel = vi.fn();
        let started!: () => void;
        const buffering = new Promise<void>((resolve) => { started = resolve; });
        const source = new ReadableStream({ pull() { started(); }, cancel }, { highWaterMark: 0 });
        const harness = hostHarness({ ...initialization,
            fetch: () => new Response(source), callback: (fn: any) => fn(new AbortController().signal)
        }, (message) => {
            if (side === 'host' && message.result?.value?.__type === 'STREAM_PORT') throw new Error('force buffering');
        });
        const guest = await harness.guest(GUEST_BRIDGE_SCRIPT, (message) => {
            if (side === 'guest' && message.type === 'CALLBACK_RETURN' && !message.error) throw new Error('force buffering');
        });
        const result = side === 'host' ? guest.api.fetch({ signal: new AbortController().signal }) : guest.api.callback(() => ({ content: source }));
        const rejected = expect(result).rejects.toThrow('plugin sandbox terminated');
        await buffering;
        harness.host.terminate();
        await rejected;
        expect(cancel).toHaveBeenCalledOnce();
        expect(source.locked).toBe(false);
        expect(harness.controllers.size).toBe(0);
        expect(guest.controllers.size).toBe(0);
    });

    test.each(['root', 'instance'])('nativeFetch(url, {body: stream}) relays %s arguments', async (kind) => {
        const nativeFetch = async (url: string, { body }: { body: ReadableStream }) => {
            expect(url).toBe('https://example.invalid/upload');
            expect(body).toBeInstanceOf(ReadableStream);
            return new Response(await new Response(body).arrayBuffer());
        };
        const harness = hostHarness({ ...initialization, nativeFetch,
            getInstance: () => ({ __classType: 'REMOTE_REQUIRED', nativeFetch })
        });
        const requests: any[] = [];
        const guest = await harness.guest(GUEST_BRIDGE_SCRIPT, (message) => {
            if (message.method === 'nativeFetch') requests.push(message);
        });
        const target = kind === 'root' ? guest.api : await guest.api.getInstance();
        const response = await target.nativeFetch('https://example.invalid/upload', { body: bytes([0, 255], [7]) });
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255, 7]));
        expect(requests).toHaveLength(2);
        expect(requests[0]).not.toHaveProperty('relay');
        expect(requests[0].args[1].body).toBeInstanceOf(ReadableStream);
        expect(requests[1].relay).toBe(1);
        expect(requests[1].args[1].body.__type).toBe('STREAM_PORT');
    });

    test('host callback arguments revive nested streams and aliases', async () => {
        const source = bytes([9, 0, 255]);
        const harness = hostHarness({ ...initialization, callback: (fn: any) => fn({ body: source, alias: source }) });
        const { api } = await harness.guest();
        expect(await api.callback(async ({ body, alias }: any) => {
            expect(body).toBe(alias);
            expect(body).toBeInstanceOf(ReadableStream);
            return Array.from(new Uint8Array(await new Response(body).arrayBuffer()));
        })).toEqual([9, 0, 255]);
    });

    test.each(['guest', 'host'])('failed %s argument posting cancels relays and rejects without pending slots', async (side) => {
        const cancel = vi.fn();
        const source = new ReadableStream({ cancel });
        const harness = hostHarness({ ...initialization,
            nativeFetch: vi.fn(), callback: (fn: any) => fn({ body: source })
        }, (message) => {
            if (side === 'host' && message.type === 'INVOKE_CALLBACK' && message.relay === 1) throw new Error('argument post failed');
        });
        const guest = await harness.guest(GUEST_BRIDGE_SCRIPT, (message) => {
            if (side === 'guest' && message.method === 'nativeFetch' && message.relay === 1) throw new Error('argument post failed');
        });
        const result = side === 'guest' ? guest.api.nativeFetch('url', { body: source }) : guest.api.callback(() => 1);
        await expect(result).rejects.toThrow('argument post failed');
        expect(cancel).toHaveBeenCalledOnce();
        expect(source.locked).toBe(false);
        expect(guest.pendingRequests.size).toBe(0);
        expect((harness.host as any).pendingCallbacks.size).toBe(0);
    });
});
