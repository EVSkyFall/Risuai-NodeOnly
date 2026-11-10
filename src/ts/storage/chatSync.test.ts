import { describe, expect, test } from 'vitest'
import { createChatSync, type ChatSyncEnv, type LiveChat } from './chatSync'
import { createChatDeltaSync, type ChatFetchResult, type ChatSaveOptions, type ChatSaveOutcome } from './chatDeltaSync'
import { canon, chatFingerprints, hash64, messageFingerprints } from './chatFingerprint'

// Two tabs on one server, reduced to what chat sync sees: a server that
// replaces a chat only for the revision it holds (like POST /api/chat-content)
// and one tab's live state. "The other tab" writes to the server directly.

type AnyChat = any
const CHA = 'char'

const msg = (data: string, role: 'user' | 'char' = 'char', extra: Record<string, unknown> = {}) => ({ role, data, chatId: `id-${data}`, ...extra })
const chatOf = (id: string, messages: AnyChat[], extra: Record<string, unknown> = {}): AnyChat =>
    ({ id, name: `Chat ${id}`, note: '', localLore: [], fmIndex: -1, message: messages, ...extra })
const texts = (chat: AnyChat) => chat.message.map((m: AnyChat) => m.data)

function world() {
    const stored = new Map<string, AnyChat>()
    const listed: string[] = []
    const posts: { chatId: string, options: ChatSaveOptions, chat: AnyChat }[] = []
    const revisionOf = (chat: AnyChat) => {
        const { id: _id, name: _name, lastDate: _l, folderId: _f, modules: _m, isStreaming: _s, ...owned } = chat
        return hash64(canon(owned))
    }
    const hooks = {
        /** Runs once the next POST has been applied (or refused), before it answers. */
        afterPost: null as null | ((chatId: string) => void | Promise<void>),
        /** Runs before the next GET answers. */
        beforeFetch: null as null | ((chatId: string) => void | Promise<void>),
        /** Runs before the next POST is looked at. */
        beforePost: null as null | ((chatId: string) => void | Promise<void>),
        /** The next POST is stored but its answer is lost. */
        loseAnswer: false,
        /** The next strict POST is stored in memory but answers "not flushed". */
        failFlush: false,
    }
    const live = { chats: [] as AnyChat[], chatPage: 0 }
    const generating = new Set<string>()
    const scheduled: (() => void)[] = []
    const sleeps: number[] = []
    const notices: string[] = []
    const tracked: string[] = []
    const replaced: string[] = []
    const guarded: string[] = []
    const queues = new Map<string, Promise<unknown>>()
    let ids = 0

    const env: ChatSyncEnv = {
        enqueue(chaId, chatId, run) {
            const key = `${chaId}|${chatId}`
            const next = (queues.get(key) ?? Promise.resolve()).then(run, run)
            queues.set(key, next.catch(() => {}))
            return next
        },
        async fetchChat(_chaId, _index, chatId, baseRev): Promise<ChatFetchResult> {
            const hook = hooks.beforeFetch
            hooks.beforeFetch = null
            if (hook) await hook(chatId)
            const chat = stored.get(chatId)
            if (!chat) return { kind: 'missing' }
            const revision = revisionOf(chat)
            if (baseRev && baseRev === revision) return { kind: 'same', revision }
            return { kind: 'ok', chat: structuredClone(chat), revision }
        },
        async postChat(_chaId, _index, chatId, chat, options): Promise<ChatSaveOutcome> {
            const body = structuredClone(chat)
            const before = hooks.beforePost
            hooks.beforePost = null
            if (before) await before(chatId)
            posts.push({ chatId, options: { ...options, fingerprints: undefined }, chat: body })
            const existing = stored.get(chatId)
            let outcome: ChatSaveOutcome
            if (existing && (options.baseRev ?? null) !== revisionOf(existing)) {
                outcome = { status: 'conflict', revision: revisionOf(existing) }
            } else {
                stored.set(chatId, body)
                if (options.forkOf && !listed.includes(chatId)) listed.push(chatId)
                outcome = { status: 'ok', revision: revisionOf(body), ...(options.strict ? { durable: { success: true, durable: true } as const } : {}) }
            }
            const hook = hooks.afterPost
            hooks.afterPost = null
            if (hook) await hook(chatId)
            if (hooks.loseAnswer) { hooks.loseAnswer = false; throw new TypeError('network') }
            if (hooks.failFlush && options.strict) { hooks.failFlush = false; throw new Error('not flushed') }
            return outcome
        },
        findLive(_chaId, chatId): LiveChat | null {
            const index = live.chats.findIndex((c) => c?.id === chatId)
            if (index === -1) return null
            return { chats: live.chats, index, chat: live.chats[index], isOpen: live.chatPage === index, open: (i) => { live.chatPage = i } }
        },
        isGenerating: (chatId) => generating.has(chatId),
        snapshot: (chat) => structuredClone(chat),
        placeholderOf: (chat) => ({ id: chat.id, name: chat.name, message: [], note: '', localLore: [], _placeholder: true }) as AnyChat,
        newId: () => `new-${++ids}`,
        forkName: (name) => `${name} (diverged)`,
        notifyForked: (name) => { notices.push(name) },
        trackCharacter: (chaId) => { tracked.push(chaId) },
        replaceLive: (_chaId, chatId, replace) => { guarded.push(chatId); replace() },
        contentReplaced: (_chaId, chatId) => { replaced.push(chatId) },
        schedule: (run) => { scheduled.push(run) },
        sleep: async (delayMs) => { sleeps.push(delayMs) },
    }
    const sync = createChatSync(env)

    return {
        sync, stored, listed, posts, hooks, live, generating, notices, tracked, replaced, guarded, sleeps,
        /** Open a chat in this tab the way hydration does. */
        open(chat: AnyChat, at = 0) {
            stored.set(chat.id, structuredClone(chat))
            live.chats.splice(at, 0, structuredClone(chat))
            sync.noteServerContent(CHA, chat.id, live.chats[at], revisionOf(chat))
            return live.chats[at]
        },
        /** The other tab saves the chat (it always holds the current revision). */
        otherTab(chatId: string, change: (chat: AnyChat) => void) {
            const chat = structuredClone(stored.get(chatId))
            change(chat)
            stored.set(chatId, chat)
        },
        save: (chatId: string, strict = false) => {
            const index = live.chats.findIndex((c) => c?.id === chatId)
            return sync.save(CHA, index, chatId, live.chats[index], { strict })
        },
        /** Run what was scheduled (the macrotask after a generation ended), until quiet. */
        async settle() {
            for (let round = 0; round < 20; round++) {
                while (scheduled.length > 0) scheduled.shift()!()
                await Promise.all([...queues.values()])
                await new Promise((r) => setTimeout(r, 0))
                if (scheduled.length === 0) return
            }
        },
        postsTo: (chatId: string) => posts.filter((p) => p.chatId === chatId),
    }
}

describe('fingerprints', () => {
    test('the delta fingerprints equal messageFingerprints, and ids do not count for content', () => {
        const messages = [msg('a', 'user'), msg('b'), { role: 'char', data: 'no id' }, null, 'odd']
        expect(chatFingerprints({ message: messages }).messages).toEqual(messageFingerprints(messages))
        const a = chatOf('c', [msg('a'), msg('b')])
        const b = chatOf('other-id', [{ ...msg('a'), chatId: 'x' }, { ...msg('b'), chatId: 'y' }], { name: 'renamed', lastDate: 5, folderId: 'f', modules: ['m'], isStreaming: true })
        expect(chatFingerprints(a).content).toBe(chatFingerprints(b).content)
        expect(chatFingerprints({ ...a, note: 'changed' }).content).not.toBe(chatFingerprints(a).content)
        expect(chatFingerprints(chatOf('c', [msg('a')])).content).not.toBe(chatFingerprints(a).content)
    })
})

describe('saving on top of a known revision', () => {
    test('an unchanged chat is not sent, a changed one is sent with its base and then is clean', async () => {
        const w = world()
        const chat = w.open(chatOf('c', [msg('a')]))
        await w.save('c')
        expect(w.posts).toHaveLength(0)
        chat.message.push(msg('b'))
        await w.save('c')
        expect(w.posts).toHaveLength(1)
        expect(w.posts[0].options.baseRev).toBeTruthy()
        expect(texts(w.stored.get('c'))).toEqual(['a', 'b'])
        expect(w.sync.isDirty(CHA, 'c')).toBe(false)
    })

    test('a new chat is saved without a base', async () => {
        const w = world()
        w.live.chats.push(chatOf('fresh', [msg('hello')]))
        await w.save('fresh')
        expect(w.posts[0].options.baseRev ?? null).toBeNull()
        expect(texts(w.stored.get('fresh'))).toEqual(['hello'])
    })

    // Trap 1
    test('a save whose answer was lost is confirmed on the retry: no fork, no duplicate', async () => {
        const w = world()
        const chat = w.open(chatOf('c', [msg('a')]))
        chat.message.push({ role: 'char', data: 'pushed without an id' })
        w.hooks.loseAnswer = true
        await expect(w.save('c')).rejects.toThrow()
        expect(chat.message[1].chatId).toBeTruthy()
        await w.save('c')
        expect(w.live.chats).toHaveLength(1)
        expect(w.notices).toEqual([])
        expect(w.stored.size).toBe(1)
        expect(w.stored.get('c').message).toEqual(chat.message)
        expect(w.sync.isDirty(CHA, 'c')).toBe(false)
    })

    test('a lost answer followed by more edits still builds on the lost save', async () => {
        const w = world()
        const chat = w.open(chatOf('c', [msg('a')]))
        chat.message.push(msg('b'))
        w.hooks.loseAnswer = true
        await expect(w.save('c')).rejects.toThrow()
        chat.message.push(msg('c'))
        await w.save('c')
        expect(w.live.chats).toHaveLength(1)
        expect(texts(w.stored.get('c'))).toEqual(['a', 'b', 'c'])
    })

    // Trap 2
    test('a strict save ends on a durable answer to a save of its own, not on "the content is already there"', async () => {
        const w = world()
        const chat = w.open(chatOf('c', [msg('a')]))
        chat.message.push(msg('b'))
        w.hooks.failFlush = true
        await expect(w.save('c', true)).rejects.toThrow('not flushed')
        const before = w.postsTo('c').length
        const result = await w.save('c', true)
        expect(result).toEqual({ success: true, durable: true })
        const after = w.postsTo('c').slice(before)
        expect(after.at(-1)!.options.strict).toBe(true)
        expect(after.at(-1)!.options.baseRev).toBeTruthy()
        expect(w.live.chats).toHaveLength(1)
    })

    // Trap 3
    test('a chat with an unknown revision and an unchanged server is saved normally', async () => {
        const w = world()
        const inline = chatOf('c', [{ role: 'user', data: 'legacy, no id' }, { role: 'char', data: 'reply' }])
        w.stored.set('c', structuredClone(inline))
        w.live.chats.push(structuredClone(inline))
        w.sync.noteInlineContent(CHA, 'c', w.live.chats[0])
        w.live.chats[0].message.push(msg('new'))
        await w.save('c')
        expect(w.live.chats).toHaveLength(1)
        expect(w.notices).toEqual([])
        expect(texts(w.stored.get('c'))).toEqual(['legacy, no id', 'reply', 'new'])
    })

    test('a refusal that does not name the server revision fails the save instead of spinning', async () => {
        const sync = createChatSync({
            ...({} as ChatSyncEnv),
            enqueue: (_a, _b, run) => run(),
            postChat: async () => ({ status: 'conflict', revision: null }),
            findLive: () => null,
            isGenerating: () => false,
            newId: () => 'x',
        } as ChatSyncEnv)
        await expect(sync.save(CHA, 0, 'c', chatOf('c', [msg('a')]), { strict: false })).rejects.toThrow(/without naming its revision/)
    })

    test('another writer flipping the chat in step with this save slows it down but never fails it', async () => {
        const w = world()
        const chat = w.open(chatOf('c', [msg('a')]))
        const original = structuredClone(w.stored.get('c'))
        const flipped = { ...structuredClone(original), note: 'flipped' }
        chat.message.push(msg('mine'))
        // POST (base: original) meets "flipped"; the GET sees "original" again;
        // the second POST meets "flipped" again: the same refusal twice.
        w.stored.set('c', structuredClone(flipped))
        w.hooks.beforeFetch = () => {
            w.stored.set('c', structuredClone(original))
            w.hooks.beforePost = () => { w.stored.set('c', structuredClone(flipped)) }
        }
        await w.save('c')
        expect(w.sleeps).toEqual([250])
        // It ends like any other "both changed": nothing lost on either side.
        expect(w.stored.get('c').note).toBe('flipped')
        expect(texts(w.live.chats.at(-1))).toEqual(['a', 'mine'])
    })
})

describe('the other tab changed the chat', () => {
    // Trap 8
    test('a tab with no changes of its own takes the server copy on refresh and sends nothing', async () => {
        const w = world()
        const chat = w.open(chatOf('c', [msg('a')]))
        w.otherTab('c', (c) => { c.message.push(msg('theirs')); c.isStreaming = true })
        const result = await w.sync.refresh(CHA, 'c')
        expect(result).toEqual({ status: 'updated', messagesChanged: true })
        expect(w.live.chats[0]).toBe(chat)
        expect(texts(chat)).toEqual(['a', 'theirs'])
        expect(chat.isStreaming).toBeUndefined()
        expect(chat.name).toBe('Chat c')
        expect(w.replaced).toEqual(['c'])
        // The replacement ran inside the host's guard against being taken for an edit.
        expect(w.guarded).toEqual(['c'])
        await w.save('c')
        expect(w.posts).toHaveLength(0)
        expect(await w.sync.refresh(CHA, 'c')).toEqual({ status: 'unchanged', messagesChanged: false })
    })

    test('a change outside the messages refreshes without counting as a changed message list', async () => {
        const w = world()
        w.open(chatOf('c', [msg('a')]))
        w.otherTab('c', (c) => { c.note = 'their note' })
        expect(await w.sync.refresh(CHA, 'c')).toEqual({ status: 'updated', messagesChanged: false })
        expect(w.live.chats[0].note).toBe('their note')
    })

    test('a stale tab that saves without having refreshed takes the server copy when it has nothing of its own', async () => {
        const w = world()
        const chat = w.open(chatOf('c', [msg('a')]))
        w.otherTab('c', (c) => c.message.push(msg('theirs')))
        const result = await w.save('c', true)
        expect(result).toEqual({ success: true, durable: true })
        expect(texts(chat)).toEqual(['a', 'theirs'])
        expect(texts(w.stored.get('c'))).toEqual(['a', 'theirs'])
        expect(w.live.chats).toHaveLength(1)
    })

    test('both changed: this tab\'s version becomes a separate chat, the original takes the server copy', async () => {
        const w = world()
        w.live.chats.push(chatOf('other', [msg('unrelated')]))
        const chat = w.open(chatOf('c', [msg('a')]), 0)
        w.live.chatPage = 0
        w.otherTab('c', (c) => c.message.push(msg('theirs')))
        chat.message.push(msg('mine'))
        await w.save('c')

        expect(w.live.chats.map((c) => c.id)).toEqual(['c', 'other', 'new-1'])
        const fork = w.live.chats[2]
        expect(fork.name).toBe('Chat c (diverged)')
        expect(texts(fork)).toEqual(['a', 'mine'])
        expect(texts(w.live.chats[0])).toEqual(['a', 'theirs'])
        expect(w.live.chats[0]).toBe(chat)
        expect(w.live.chatPage).toBe(2)
        expect(w.notices).toEqual(['Chat c (diverged)'])
        expect(w.tracked).toEqual([CHA])
        // Server: the original is untouched, the fork is listed and has its body.
        expect(texts(w.stored.get('c'))).toEqual(['a', 'theirs'])
        expect(texts(w.stored.get('new-1'))).toEqual(['a', 'mine'])
        expect(w.listed).toEqual(['new-1'])
        expect(w.postsTo('new-1')[0].options.forkOf).toBe('c')
        // Message ids are the fork's own.
        expect(fork.message.map((m: AnyChat) => m.chatId)).not.toContain('id-a')
        // Both are clean afterwards.
        await w.save('c'); await w.save('new-1')
        expect(w.postsTo('c')).toHaveLength(1)
        expect(w.postsTo('new-1')).toHaveLength(1)
    })

    // Trap 5
    test('a fork of a chat that is not the open one leaves the open chat alone', async () => {
        const w = world()
        w.live.chats.push(chatOf('open', [msg('on screen')]))
        const chat = w.open(chatOf('c', [msg('a')]), 1)
        w.live.chatPage = 0
        w.otherTab('c', (c) => c.message.push(msg('theirs')))
        chat.message.push(msg('recovered reply'))
        expect(await w.save('c', true)).toEqual({ success: true, durable: true })
        expect(w.live.chatPage).toBe(0)
        expect(w.live.chats.map((c) => c.id)).toEqual(['open', 'c', 'new-1'])
        expect(w.listed).toEqual(['new-1'])
        expect(w.postsTo('new-1')[0].options).toMatchObject({ strict: true, forkOf: 'c' })
        expect(texts(w.stored.get('new-1'))).toEqual(['a', 'recovered reply'])
    })

    // Trap 4
    test('an edit made while the conflict is being settled is never dropped', async () => {
        const w = world()
        const chat = w.open(chatOf('c', [msg('a')]))
        w.otherTab('c', (c) => c.message.push(msg('theirs')))
        chat.message.push(msg('mine'))
        w.hooks.beforeFetch = () => { chat.message.push(msg('typed during the fetch')) }
        let lateEdit = false
        w.hooks.afterPost = () => {
            // the refused save of the original
            w.hooks.afterPost = (chatId) => {
                if (chatId !== 'c' && !lateEdit) { lateEdit = true; chat.message.push(msg('typed during the fork save')) }
            }
        }
        await w.save('c')
        const fork = w.live.chats.find((c) => c.id !== 'c')
        expect(texts(fork)).toEqual(['a', 'mine', 'typed during the fetch', 'typed during the fork save'])
        expect(texts(w.stored.get(fork.id))).toEqual(texts(fork))
        expect(texts(w.live.chats[0])).toEqual(['a', 'theirs'])
        // The second pass reused the first pass's ids for the messages it already had.
        const firstPass = w.postsTo(fork.id)[0].chat.message.map((m: AnyChat) => m.chatId)
        expect(fork.message.slice(0, firstPass.length).map((m: AnyChat) => m.chatId)).toEqual(firstPass)
    })

    test('a fork save whose answer was lost is not repeated under a second id', async () => {
        const w = world()
        const chat = w.open(chatOf('c', [msg('a')]))
        w.otherTab('c', (c) => c.message.push(msg('theirs')))
        chat.message.push(msg('mine'))
        // Order: POST c (refused) -> GET c -> POST fork (stored, answer lost).
        w.hooks.beforeFetch = () => { w.hooks.loseAnswer = true }
        await expect(w.save('c')).rejects.toThrow()
        expect(w.postsTo('new-1')).toHaveLength(1)
        expect(w.stored.size).toBe(2)
        expect(w.live.chats).toHaveLength(1)
        chat.message.push(msg('typed before the retry'))
        await w.save('c')
        await w.settle()
        expect(w.stored.size).toBe(2)
        expect(w.listed).toEqual(['new-1'])
        expect(w.live.chats.map((c) => c.id)).toEqual(['c', 'new-1'])
        expect(texts(w.live.chats[1])).toEqual(['a', 'mine', 'typed before the retry'])
        expect(texts(w.stored.get('new-1'))).toEqual(['a', 'mine', 'typed before the retry'])
        expect(texts(w.live.chats[0])).toEqual(['a', 'theirs'])
    })

    test('refresh with changes on both sides forks as well', async () => {
        const w = world()
        const chat = w.open(chatOf('c', [msg('a')]))
        w.otherTab('c', (c) => c.message.push(msg('theirs')))
        chat.note = 'my note'
        expect(await w.sync.refresh(CHA, 'c')).toEqual({ status: 'forked', messagesChanged: false, forkId: 'new-1' })
        expect(w.live.chats[1].note).toBe('my note')
        expect(w.live.chats[0].note).toBe('')
        expect(texts(w.live.chats[0])).toEqual(['a', 'theirs'])
    })

    test('refresh while only this tab changed keeps the change and lets the save go through', async () => {
        const w = world()
        const chat = w.open(chatOf('c', [msg('a')]))
        chat.message.push(msg('mine'))
        expect((await w.sync.refresh(CHA, 'c')).status).toBe('unchanged')
        await w.save('c')
        expect(texts(w.stored.get('c'))).toEqual(['a', 'mine'])
        expect(w.live.chats).toHaveLength(1)
    })

    test('a failing refresh never throws', async () => {
        const w = world()
        w.open(chatOf('c', [msg('a')]))
        w.hooks.beforeFetch = () => { throw new Error('offline') }
        expect(await w.sync.refresh(CHA, 'c')).toEqual({ status: 'skipped', messagesChanged: false })
    })
})

// Trap 7
describe('job recovery around a lost answer', () => {
    test('save stored, answer lost, the other tab appends, recovery reads back and saves again: nothing of either is lost', async () => {
        const w = world()
        const chat = w.open(chatOf('c', [msg('question', 'user')]))
        chat.message.push(msg('recovered reply'))
        w.hooks.loseAnswer = true
        await expect(w.save('c', true)).rejects.toThrow()
        w.otherTab('c', (c) => c.message.push(msg('theirs')))
        // The read-back is a plain fetch that enters neither live state nor the
        // sync state (fetchChatFromServer); then recovery saves again.
        expect(await w.save('c', true)).toEqual({ success: true, durable: true })
        // The other tab's append stays where it was written.
        expect(texts(w.stored.get('c'))).toEqual(['question', 'recovered reply', 'theirs'])
        expect(texts(w.live.chats[0])).toEqual(['question', 'recovered reply', 'theirs'])
        // This tab cannot tell that its own lost save is what the other tab
        // built on, so its copy is kept as a fork as well: one chat more than
        // needed, nothing less.
        expect(w.live.chats).toHaveLength(2)
        expect(texts(w.stored.get(w.live.chats[1].id))).toEqual(['question', 'recovered reply'])
    })
})

// The save path as wired in the app: chat sync on top of delta sync.
describe('with delta sync underneath', () => {
    test('a chat that changes while a refused delta is under way is not recorded as saved in a state it was never sent in', async () => {
        const server = { chat: chatOf('c', [msg('a'), msg('b')]) as AnyChat, rev: 1 }
        const live = { chats: [structuredClone(server.chat)] as AnyChat[] }
        let duringDelta: (() => void) | null = null
        const bodies: AnyChat[] = []
        const delta = createChatDeltaSync({
            fetchChatContentDelta: async () => ({ chat: structuredClone(server.chat), deltaBase: null, revision: String(server.rev) }),
            saveChatContentDelta: async () => 'ok',
            postChatContent: async (_a, _i, _c, body, options) => {
                const sent = structuredClone(body)
                if (options.deltaBase) {
                    // The server holds the messages under other ids: the prefix does not verify.
                    const hook = duringDelta
                    duringDelta = null
                    hook?.()
                    return { status: 'base-mismatch' }
                }
                bodies.push(sent)
                server.chat = sent
                server.rev += 1
                return { status: 'ok', revision: String(server.rev) }
            },
        }, { get: async () => null, put: async () => {} })
        const sync = createChatSync({
            ...({} as ChatSyncEnv),
            enqueue: (_a, _b, run) => run(),
            fetchChat: (a, i, c, rev) => delta.fetchChatRev(a, i, c, rev),
            postChat: (a, i, c, chat, options) => delta.postChat(a, i, c, chat, options),
            findLive: () => ({ chats: live.chats, index: 0, chat: live.chats[0], isOpen: true, open: () => {} }),
            isGenerating: () => false,
            newId: () => 'id',
        } as ChatSyncEnv)
        // Opened: delta sync remembers the server's fingerprints, chat sync the revision.
        const opened = await delta.fetchChatRev(CHA, 0, 'c')
        if (opened.kind !== 'ok') throw new Error('unreachable')
        sync.noteServerContent(CHA, 'c', live.chats[0], opened.revision)

        live.chats[0].message.push(msg('first edit'))
        duringDelta = () => { live.chats[0].message.push(msg('typed during the request')) }
        await sync.save(CHA, 0, 'c', live.chats[0], { strict: false })
        expect(texts(bodies.at(-1))).toEqual(['a', 'b', 'first edit', 'typed during the request'])
        expect(sync.isDirty(CHA, 'c')).toBe(false)
        // Back to the state at the first attempt: that is a change against what
        // the server holds, and it is seen as one.
        live.chats[0].message.pop()
        expect(sync.isDirty(CHA, 'c')).toBe(true)
        await sync.save(CHA, 0, 'c', live.chats[0], { strict: false })
        expect(texts(server.chat)).toEqual(['a', 'b', 'first edit'])
    })
})

describe('a conflict while a generation is writing into the chat', () => {
    // Trap 6
    test('live state is left alone, saves land in the fork, and the swap happens once the generation is over', async () => {
        const w = world()
        w.live.chats.push(chatOf('other', [msg('unrelated')]))
        const chat = w.open(chatOf('c', [msg('a')]), 0)
        w.otherTab('c', (c) => c.message.push(msg('theirs')))
        // The send starts: the user's message is in, the reply is not there yet.
        w.generating.add('c')
        chat.message.push(msg('question', 'user'))
        await w.save('c')
        expect(w.sync.isDiverted(CHA, 'c')).toBe(true)
        expect(w.live.chats.map((c) => c.id)).toEqual(['c', 'other'])
        expect(w.live.chats[0]).toBe(chat)
        expect(texts(chat)).toEqual(['a', 'question'])
        expect(texts(w.stored.get('new-1'))).toEqual(['a', 'question'])
        expect(w.listed).toEqual(['new-1'])

        // The reply streams in; the autosave and the strict save at completion go to the fork.
        chat.message.push(msg('partial reply'))
        await w.save('c')
        chat.message[2].data = 'full reply'
        expect(await w.save('c', true)).toEqual({ success: true, durable: true })
        expect(texts(w.stored.get('new-1'))).toEqual(['a', 'question', 'full reply'])
        expect(texts(w.stored.get('c'))).toEqual(['a', 'theirs'])
        expect(w.postsTo('new-1').map((p) => p.options.forkOf)).toEqual(['c', undefined, undefined])
        expect(new Set(w.postsTo('new-1').map((p) => p.chat.message[1].chatId)).size).toBe(1)
        await w.settle()
        expect(w.live.chats.map((c) => c.id)).toEqual(['c', 'other'])

        // Reroll bookkeeping after the last save, then the generation ends.
        chat.message[2].swipes = ['old reply', 'full reply']
        w.generating.delete('c')
        w.sync.generationsChanged()
        await w.settle()

        expect(w.sync.isDiverted(CHA, 'c')).toBe(false)
        expect(w.live.chats.map((c) => c.id)).toEqual(['c', 'other', 'new-1'])
        expect(w.live.chatPage).toBe(2)
        const fork = w.live.chats[2]
        expect(texts(fork)).toEqual(['a', 'question', 'full reply'])
        expect(fork.message[2].swipes).toEqual(['old reply', 'full reply'])
        expect(w.stored.get('new-1').message[2].swipes).toEqual(['old reply', 'full reply'])
        expect(texts(w.live.chats[0])).toEqual(['a', 'theirs'])
        expect(w.notices).toEqual(['Chat c (diverged)'])
        expect(w.sync.isDirty(CHA, 'c')).toBe(false)
        expect(w.sync.isDirty(CHA, 'new-1')).toBe(false)
    })

    test('a failed reroll that restores the old messages ends up in the fork as restored', async () => {
        const w = world()
        const chat = w.open(chatOf('c', [msg('q', 'user'), msg('old reply')]))
        const original = structuredClone(chat.message)
        w.otherTab('c', (c) => c.message.push(msg('theirs')))
        w.generating.add('c')
        chat.message = [chat.message[0]]
        await w.save('c')
        chat.message = original
        w.generating.delete('c')
        w.sync.generationsChanged()
        await w.settle()
        const fork = w.live.chats.find((c) => c.id !== 'c')
        expect(texts(fork)).toEqual(['q', 'old reply'])
        expect(texts(w.stored.get(fork.id))).toEqual(['q', 'old reply'])
        expect(texts(w.live.chats[0])).toEqual(['q', 'old reply', 'theirs'])
    })

    test('a generation that restarts before the swap keeps the fork on the server only', async () => {
        const w = world()
        const chat = w.open(chatOf('c', [msg('a')]))
        w.otherTab('c', (c) => c.message.push(msg('theirs')))
        w.generating.add('c')
        chat.message.push(msg('first part'))
        await w.save('c')
        // auto-continue: the entry ends and a new one starts in the same task
        w.generating.delete('c')
        w.sync.generationsChanged()
        w.generating.add('c')
        await w.settle()
        expect(w.live.chats).toHaveLength(1)
        chat.message[1].data = 'first part, continued'
        await w.save('c')
        w.generating.delete('c')
        w.sync.generationsChanged()
        await w.settle()
        expect(w.live.chats).toHaveLength(2)
        expect(texts(w.live.chats[1])).toEqual(['a', 'first part, continued'])
        expect(w.stored.size).toBe(2)
    })

    test('a refresh does not touch a chat that is generating', async () => {
        const w = world()
        const chat = w.open(chatOf('c', [msg('a')]))
        w.otherTab('c', (c) => c.message.push(msg('theirs')))
        w.generating.add('c')
        expect((await w.sync.refresh(CHA, 'c')).status).toBe('skipped')
        expect(texts(chat)).toEqual(['a'])
    })

    test('a fork that was opened and edited here before the swap keeps its edit; the final content gets one new id', async () => {
        const w = world()
        const chat = w.open(chatOf('c', [msg('a')]))
        w.otherTab('c', (c) => c.message.push(msg('theirs')))
        w.generating.add('c')
        chat.message.push(msg('mine'))
        await w.save('c')
        // A database rebase lists the fork here and the user opens and edits it.
        w.live.chats.push(structuredClone(w.stored.get('new-1')))
        expect((await w.sync.refresh(CHA, 'new-1')).status).toBe('unchanged')
        expect(w.sync.isDirty(CHA, 'new-1')).toBe(false)
        w.live.chats[1].message.push(msg('typed in the fork'))
        chat.message.push(msg('reply'))
        w.generating.delete('c')
        w.sync.generationsChanged()
        await w.settle()
        const ids = w.live.chats.map((c) => c.id)
        expect(ids).toHaveLength(3)
        const final = w.live.chats[2]
        expect(texts(final)).toEqual(['a', 'mine', 'reply'])
        expect(texts(w.live.chats[1])).toEqual(['a', 'mine', 'typed in the fork'])
        // The final content went to the new id only.
        expect(w.postsTo('new-1').every((p) => !texts(p.chat).includes('reply'))).toBe(true)
        expect(texts(w.stored.get(final.id))).toEqual(['a', 'mine', 'reply'])
    })

    test('someone else writing to the fork id moves this tab to a fresh id', async () => {
        const w = world()
        const chat = w.open(chatOf('c', [msg('a')]))
        w.otherTab('c', (c) => c.message.push(msg('theirs')))
        w.generating.add('c')
        chat.message.push(msg('mine'))
        await w.save('c')
        w.otherTab('new-1', (c) => c.message.push(msg('edited in the fork elsewhere')))
        chat.message.push(msg('more'))
        await w.save('c')
        w.generating.delete('c')
        w.sync.generationsChanged()
        await w.settle()
        expect(texts(w.stored.get('new-1'))).toEqual(['a', 'mine', 'edited in the fork elsewhere'])
        const fork = w.live.chats.at(-1)
        expect(fork.id).not.toBe('new-1')
        expect(texts(fork)).toEqual(['a', 'mine', 'more'])
        expect(texts(w.stored.get(fork.id))).toEqual(['a', 'mine', 'more'])
    })
})

describe('plugin writes to a chat that is not loaded', () => {
    // Trap 14
    test('a write built on the plugin\'s own read is accepted and leaves the chat clean', async () => {
        const w = world()
        const onServer = chatOf('c', [msg('a')])
        w.stored.set('c', structuredClone(onServer))
        w.live.chats.push({ id: 'c', name: 'Chat c', message: [], note: '', localLore: [], _placeholder: true })
        const read = (await (async () => structuredClone(w.stored.get('c')))())
        w.sync.notePluginRead(CHA, 'c', read, hash64(canon((({ id, name, ...rest }) => rest)(read))))
        read.message.push(msg('added by the plugin'))
        w.live.chats[0] = read
        expect(w.sync.adoptPluginRead(CHA, 'c')).toBe(true)
        await w.sync.save(CHA, 0, 'c', read, { strict: false })
        expect(texts(w.stored.get('c'))).toEqual(['a', 'added by the plugin'])
        // Another tab appends; opening the chat here later is a plain refresh, not a fork.
        w.otherTab('c', (c) => c.message.push(msg('theirs')))
        expect((await w.sync.refresh(CHA, 'c')).status).toBe('updated')
        expect(w.live.chats).toHaveLength(1)
        expect(texts(w.live.chats[0])).toEqual(['a', 'added by the plugin', 'theirs'])
    })

    test('what this tab remembered of a chat from an earlier load does not turn a plugin replacement into a fork', async () => {
        const w = world()
        // Loaded once, then unloaded again (character deactivated and reactivated).
        w.open(chatOf('c', [msg('a')]))
        w.otherTab('c', (c) => c.message.push(msg('theirs')))
        const built = chatOf('c', [msg('built from scratch')])
        w.live.chats[0] = built
        expect(w.sync.adoptPluginRead(CHA, 'c')).toBe(false)
        await w.sync.save(CHA, 0, 'c', built, { strict: false, replace: true })
        expect(texts(w.stored.get('c'))).toEqual(['built from scratch'])
        expect(w.live.chats).toHaveLength(1)
        expect(w.notices).toEqual([])
    })

    test('a chat the plugin never read is replaced outright', async () => {
        const w = world()
        w.stored.set('c', chatOf('c', [msg('a')]))
        const built = chatOf('c', [msg('built from scratch')])
        w.live.chats.push(built)
        expect(w.sync.adoptPluginRead(CHA, 'c')).toBe(false)
        await w.sync.save(CHA, 0, 'c', built, { strict: false, replace: true })
        expect(texts(w.stored.get('c'))).toEqual(['built from scratch'])
        expect(w.live.chats).toHaveLength(1)
    })
})
