import { describe, test, expect, vi } from 'vitest'

// Stub out the heavy reactive modules so loading chatStorage.ts doesn't trigger
// unrelated $effect chains that fail in a stripped-down test environment.
// Mirror the production isChatStub semantics including the hybrid guard so
// the chat-data-loss tests below exercise the real intent.
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: null } }))
vi.mock('./database.svelte', () => ({
    isChatStub: (chat: any) => chat
        && chat._stub === true
        && !Array.isArray(chat.message),
}))

const { chatToStub, stubToPlaceholder, convertStubsToPlaceholders, classifyChat, restoreChatShapeAfterRebase } = await import('./chatStorage')
type Chat = any
type ChatStub = any

// Round-trip tests for stub ↔ placeholder conversions. The server merge layer
// relies on key presence ('in' semantics) to distinguish "user cleared this
// field" from "field is absent". Both client converters must preserve key
// presence end-to-end, otherwise null clears get dropped on the way out and
// stale fullChat metadata resurfaces on the next persist.

const blankChat = (overrides: Partial<Chat> = {}): Chat => ({
    message: [],
    note: '',
    name: 'test',
    localLore: [],
    id: 'c1',
    ...overrides,
})

describe('chatToStub', () => {
    test('preserves explicit null folderId as a key', () => {
        const stub = chatToStub(blankChat({ folderId: null as any }))
        expect('folderId' in stub).toBe(true)
        expect(stub.folderId).toBeNull()
    })

    test('omits folderId when the chat has no such key', () => {
        const stub = chatToStub(blankChat())
        expect('folderId' in stub).toBe(false)
    })

    test('preserves a non-null folderId', () => {
        const stub = chatToStub(blankChat({ folderId: 'F1' }))
        expect(stub.folderId).toBe('F1')
    })

    test('same key-presence semantics applies to modules', () => {
        expect('modules' in chatToStub(blankChat({ modules: null as any }))).toBe(true)
        expect('modules' in chatToStub(blankChat({ modules: [] }))).toBe(true)
        expect('modules' in chatToStub(blankChat())).toBe(false)
    })

    test('same key-presence semantics applies to lastDate', () => {
        expect('lastDate' in chatToStub(blankChat({ lastDate: null as any }))).toBe(true)
        expect('lastDate' in chatToStub(blankChat({ lastDate: 0 }))).toBe(true)
        expect('lastDate' in chatToStub(blankChat())).toBe(false)
    })

    test('returns input untouched when already a stub', () => {
        const stub: ChatStub = { id: 'c1', name: 't', _stub: true }
        expect(chatToStub(stub)).toBe(stub)
    })
})

describe('stubToPlaceholder', () => {
    test('preserves explicit null folderId from server', () => {
        const stub: ChatStub = {
            id: 'c1',
            name: 't',
            _stub: true,
            folderId: null as any,
        }
        const placeholder = stubToPlaceholder(stub)
        expect('folderId' in placeholder).toBe(true)
        expect(placeholder.folderId).toBeNull()
    })

    test('omits folderId when stub has no such key', () => {
        const stub: ChatStub = { id: 'c1', name: 't', _stub: true }
        const placeholder = stubToPlaceholder(stub)
        expect('folderId' in placeholder).toBe(false)
    })

    test('marks placeholder for hydration', () => {
        const stub: ChatStub = { id: 'c1', name: 't', _stub: true }
        const placeholder = stubToPlaceholder(stub)
        expect(placeholder._placeholder).toBe(true)
        expect(placeholder.fmIndex).toBe(-1)
        expect(placeholder.message).toEqual([])
    })

    test('preserves modules key (null and array)', () => {
        const nullStub: ChatStub = { id: 'c1', name: 't', _stub: true, modules: null as any }
        expect('modules' in stubToPlaceholder(nullStub)).toBe(true)
        expect(stubToPlaceholder(nullStub).modules).toBeNull()

        const arrStub: ChatStub = { id: 'c1', name: 't', _stub: true, modules: ['m1'] }
        expect(stubToPlaceholder(arrStub).modules).toEqual(['m1'])
    })
})

// The bug this branch fixes: a user clearing folderId would round-trip into
// a "remove" patch op once the placeholder dropped the null key. With key
// presence preserved end-to-end, the explicit null survives placeholder →
// stub conversion and reaches the server merge layer as a real value.
describe('chat → stub → placeholder → stub round-trip', () => {
    test('null folderId survives the full round-trip', () => {
        const original = blankChat({ folderId: null as any })
        const stub1 = chatToStub(original)
        const placeholder = stubToPlaceholder({ ...stub1, _stub: true })
        const stub2 = chatToStub(placeholder)
        expect('folderId' in stub2).toBe(true)
        expect(stub2.folderId).toBeNull()
    })

    test('null modules survives the full round-trip', () => {
        const original = blankChat({ modules: null as any })
        const stub1 = chatToStub(original)
        const placeholder = stubToPlaceholder({ ...stub1, _stub: true })
        const stub2 = chatToStub(placeholder)
        expect('modules' in stub2).toBe(true)
        expect(stub2.modules).toBeNull()
    })

    test('absent folderId stays absent through the round-trip', () => {
        const original = blankChat()
        const stub1 = chatToStub(original)
        const placeholder = stubToPlaceholder({ ...stub1, _stub: true })
        const stub2 = chatToStub(placeholder)
        expect('folderId' in stub2).toBe(false)
    })

    test('non-null folderId survives the round-trip unchanged', () => {
        const original = blankChat({ folderId: 'F1' })
        const stub1 = chatToStub(original)
        const placeholder = stubToPlaceholder({ ...stub1, _stub: true })
        const stub2 = chatToStub(placeholder)
        expect(stub2.folderId).toBe('F1')
    })
})

// Hybrid corruption: a chat with `_stub: true` AND a real message array.
// Came from v1.4.x disk corruption. The lazy-loading invariants assume
// `_stub: true` means "metadata only", so the hybrid leaks Chat fields into
// patcher diffs and trips the chat-data guard. The fix self-heals by
// excluding hybrids from isChatStub (so chatToStub strips them properly)
// and by stripping the corrupt _stub flag in convertStubsToPlaceholders
// (preserving the real message data instead of resetting to placeholder).
describe('hybrid corruption (chat with _stub:true + message)', () => {
    const hybridChat = (overrides: any = {}): any => ({
        message: [{ role: 'user', data: 'hello' }],
        note: 'old note',
        name: 'h',
        localLore: [{ key: 'k' }],
        id: 'c-hybrid',
        _stub: true,
        ...overrides,
    })

    test('classifyChat tags _stub + message as "hybrid"', () => {
        expect(classifyChat(hybridChat())).toBe('hybrid')
    })

    test('chatToStub collapses hybrid down to a real stub (drops message)', () => {
        const result = chatToStub(hybridChat()) as any
        expect(result._stub).toBe(true)
        expect('message' in result).toBe(false)
        expect('note' in result).toBe(false)
        expect('localLore' in result).toBe(false)
        expect(result.id).toBe('c-hybrid')
        expect(result.name).toBe('h')
    })

    test('convertStubsToPlaceholders keeps hybrid as a Chat with message preserved', () => {
        const [recovered] = convertStubsToPlaceholders([hybridChat()])
        // _stub flag must be gone — leaving it would re-enter the hybrid loop.
        expect((recovered as any)._stub).toBeUndefined()
        // Original message must survive — converting to a placeholder would
        // reset it to [], which IS the data-loss bug we're guarding against.
        expect(Array.isArray(recovered.message)).toBe(true)
        expect(recovered.message.length).toBe(1)
        expect(recovered.message[0].data).toBe('hello')
        expect(recovered.note).toBe('old note')
        expect(recovered.localLore.length).toBe(1)
    })

    test('convertStubsToPlaceholders still converts real stubs to placeholders', () => {
        const realStub: ChatStub = { id: 'c1', name: 't', _stub: true }
        const [result] = convertStubsToPlaceholders([realStub])
        expect((result as any)._placeholder).toBe(true)
        expect(result.message).toEqual([])
        expect(result.fmIndex).toBe(-1)
    })

    test('convertStubsToPlaceholders leaves real Chats alone', () => {
        const realChat: Chat = {
            message: [], note: '', name: 'x', localLore: [], id: 'c2',
        }
        const [result] = convertStubsToPlaceholders([realChat])
        expect(result).toBe(realChat)   // same reference, untouched
    })

    test('hybrid round-trip self-heals: convert → chatToStub → no message leakage', () => {
        // Simulate the actual v1.4.x bug path:
        //   disk → decoded chat is hybrid → convertStubsToPlaceholders → patcher diff
        const [recovered] = convertStubsToPlaceholders([hybridChat()])
        const stub = chatToStub(recovered) as any
        expect(stub._stub).toBe(true)
        expect('message' in stub).toBe(false)
        expect('note' in stub).toBe(false)
        // Once stripped, the chat-data guard would see no chat-internal field
        // ops in a baseline-vs-current diff between two of these stubs.
    })
})

// 2026-07-21 multi-browser incident: the save loop's rebase merged a raw
// server decode (chats = `_stub` entries) straight into live UI state without
// the boot-time convertStubsToPlaceholders pass. Chat consumers crashed on
// `message.length`, and a raw stub flowed into the per-chat save path,
// poisoning the server's fullChatStore. restoreChatShapeAfterRebase is the
// rebase-side invariant restorer + local-hydration graft.
describe('restoreChatShapeAfterRebase', () => {
    const rawStub = (id: string): ChatStub => ({ id, name: 'n-' + id, _stub: true })
    const fullChat = (id: string, text: string): Chat => ({
        message: [{ role: 'char', data: text }],
        note: '', name: 'n-' + id, localLore: [], id,
    })

    test('converts raw server stubs to placeholders (no message-less chat survives)', () => {
        const merged = [{ chaId: 'A', chats: [rawStub('c1'), rawStub('c2')] }]
        restoreChatShapeAfterRebase(merged, [])
        for (const chat of merged[0].chats as any[]) {
            expect(chat._stub).toBeUndefined()
            expect(chat._placeholder).toBe(true)
            expect(Array.isArray(chat.message)).toBe(true)
        }
    })

    test('grafts the locally hydrated chat back over its placeholder slot', () => {
        const hydrated = fullChat('c1', 'hello from the open chat')
        const merged = [{ chaId: 'A', chats: [rawStub('c1'), rawStub('c2')] }]
        const local = [{ chaId: 'A', chats: [hydrated] }]
        restoreChatShapeAfterRebase(merged, local)
        expect((merged[0].chats[0] as any).message[0].data).toBe('hello from the open chat')
        expect((merged[0].chats[1] as any)._placeholder).toBe(true)
    })

    test('clears stale streaming state on a locally hydrated rebase graft', () => {
        const hydrated = { ...fullChat('c1', 'partial stream'), isStreaming: true }
        const merged = [{ chaId: 'A', chats: [rawStub('c1')] }]
        const local = [{ chaId: 'A', chats: [hydrated] }]

        restoreChatShapeAfterRebase(merged, local)

        expect((merged[0].chats[0] as any).isStreaming).toBe(false)
    })

    test('never grafts a local stub or placeholder over the slot', () => {
        const merged = [{ chaId: 'A', chats: [rawStub('c1'), rawStub('c2')] }]
        const local = [{
            chaId: 'A',
            chats: [rawStub('c1'), { ...fullChat('c2', 'x'), message: [], _placeholder: true }],
        }]
        restoreChatShapeAfterRebase(merged, local)
        expect((merged[0].chats[0] as any)._placeholder).toBe(true)
        expect((merged[0].chats[0] as any)._stub).toBeUndefined()
        expect((merged[0].chats[1] as any)._placeholder).toBe(true)
    })

    test('leaves already-correct characters untouched and self-heals hybrids', () => {
        const untouched = fullChat('c9', 'kept')
        const merged = [{
            chaId: 'B',
            chats: [untouched, { ...fullChat('c8', 'hybrid'), _stub: true }],
        }]
        restoreChatShapeAfterRebase(merged, [])
        expect(merged[0].chats[0]).toBe(untouched)
        expect((merged[0].chats[1] as any)._stub).toBeUndefined()
        expect((merged[0].chats[1] as any).message[0].data).toBe('hybrid')
    })

    test('characters missing locally get placeholders only (no graft, no crash)', () => {
        const merged = [{ chaId: 'C', chats: [rawStub('c3')] }, { chats: [rawStub('c4')] }]
        restoreChatShapeAfterRebase(merged as any, [{ chaId: 'Z', chats: [] }])
        expect((merged[0].chats![0] as any)._placeholder).toBe(true)
        expect((merged[1].chats![0] as any)._placeholder).toBe(true)
    })
})
