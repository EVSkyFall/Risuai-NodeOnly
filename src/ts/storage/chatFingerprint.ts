// Message fingerprints for chat delta sync. MUST stay byte-for-byte in step
// with server/node/chatFingerprint.cjs (a unit test compares the two).
//
// A fingerprint is a 64-bit hash of a canonical rendering of one message:
// object keys sorted, undefined/null object values dropped (msgpack and the
// client disagree on which one an absent field becomes), binary as hex. Two
// sides agreeing on a prefix fingerprint means the first k messages are the
// same content, so only the rest needs to cross the wire. Any disagreement
// (a legacy message without chatId, a field one side normalizes) only costs a
// full transfer — never a wrong merge.

export function canon(value: unknown): string {
    if (value === null || value === undefined) return 'null';
    const type = typeof value;
    if (type === 'string') return JSON.stringify(value);
    if (type === 'number') return Number.isFinite(value as number) ? JSON.stringify(value) : 'null';
    if (type === 'boolean') return value ? 'true' : 'false';
    if (type === 'bigint') return `"${(value as bigint).toString()}n"`;
    if (Array.isArray(value)) {
        let out = '[';
        for (let i = 0; i < value.length; i++) out += (i ? ',' : '') + canon(value[i]);
        return out + ']';
    }
    if (ArrayBuffer.isView(value)) {
        const view = value as ArrayBufferView;
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        let hex = '';
        for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
        return `"b:${hex}"`;
    }
    if (type === 'object') {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort();
        let out = '{';
        let first = true;
        for (const key of keys) {
            const v = record[key];
            if (v === undefined || v === null || typeof v === 'function') continue;
            out += (first ? '' : ',') + JSON.stringify(key) + ':' + canon(v);
            first = false;
        }
        return out + '}';
    }
    return 'null';
}

export function hash64(str: string): string {
    let h1 = 0xdeadbeef ^ str.length;
    let h2 = 0x41c6ce57 ^ str.length;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

export function messageFingerprint(message: unknown): string {
    return hash64(canon(message));
}

export function messageFingerprints(messages: readonly unknown[]): string[] {
    const out = new Array(messages.length);
    for (let i = 0; i < messages.length; i++) out[i] = messageFingerprint(messages[i]);
    return out;
}

// Fingerprint of the first `count` messages (count included, so a shorter
// prefix can never collide with a longer one).
export function prefixFingerprint(fingerprints: readonly string[], count: number): string {
    return hash64(`${count}|` + fingerprints.slice(0, count).join(''));
}


// ── Whole-chat content fingerprint (multi-tab sync) ─────────────────────────
// Client-only: compared only with another fingerprint computed here, never
// with anything the server computes.
//
// It covers what a chat-content save owns: the messages and every chat field
// except the ones the server takes from the database stub and the runtime
// flags. Message ids (`chatId`) are left out, so ids minted while loading
// (normalizeChat) never make two copies of the same content differ.

const NOT_OWNED_CHAT_FIELDS = new Set(['id', 'name', 'lastDate', 'folderId', 'modules', 'isStreaming', '_placeholder', '_stub', 'message'])

// canon(message) and the same rendering without the `chatId` entry, in one
// walk. The first must stay equal to canon(message) (a unit test checks).
function canonMessagePair(message: unknown): [withId: string, withoutId: string] {
    if (message === null || typeof message !== 'object' || Array.isArray(message) || ArrayBuffer.isView(message)) {
        const rendered = canon(message)
        return [rendered, rendered]
    }
    const record = message as Record<string, unknown>
    const keys = Object.keys(record).sort()
    let withId = '{'
    let withoutId = '{'
    let firstWith = true
    let firstWithout = true
    for (const key of keys) {
        const v = record[key]
        if (v === undefined || v === null || typeof v === 'function') continue
        const part = JSON.stringify(key) + ':' + canon(v)
        withId += (firstWith ? '' : ',') + part
        firstWith = false
        if (key !== 'chatId') {
            withoutId += (firstWithout ? '' : ',') + part
            firstWithout = false
        }
    }
    return [withId + '}', withoutId + '}']
}

export interface ChatFingerprints {
    /** Per message, ids included: the delta-sync fingerprints (messageFingerprints). */
    messages: string[]
    /** Per message, ids left out. */
    bare: string[]
    /** The whole owned content, ids left out. */
    content: string
}

export function chatFingerprints(chat: unknown): ChatFingerprints {
    const record = (chat !== null && typeof chat === 'object' ? chat : {}) as Record<string, unknown>
    const list = Array.isArray(record.message) ? record.message : []
    const messages = new Array<string>(list.length)
    const bare = new Array<string>(list.length)
    for (let i = 0; i < list.length; i++) {
        const [withId, withoutId] = canonMessagePair(list[i])
        messages[i] = hash64(withId)
        bare[i] = hash64(withoutId)
    }
    const rest: Record<string, unknown> = {}
    for (const key of Object.keys(record)) {
        if (!NOT_OWNED_CHAT_FIELDS.has(key)) rest[key] = record[key]
    }
    // Two independent 64-bit hashes of the same rendering: this value decides
    // whether content is replaced, so it gets more than the delta base does.
    const rendering = `${list.length}|${bare.join('')}|${canon(rest)}`
    const content = hash64(rendering) + hash64(`content:${rendering}`)
    return { messages, bare, content }
}

export function chatContentFingerprint(chat: unknown): string {
    return chatFingerprints(chat).content
}

/** True when two lists of per-message fingerprints describe the same messages. */
export function sameFingerprintList(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
}
