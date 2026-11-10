/**
 * Stub-related types and predicates extracted out of `database.svelte.ts` so
 * they can be unit-tested without dragging in the Svelte runtime ($state,
 * etc.). `database.svelte.ts` re-exports these to keep existing imports
 * working unchanged.
 */

/**
 * Minimal stub stored in database.bin — full chat data lives server-side.
 * Only exists in encoded/decoded data; at runtime stubs are converted to
 * placeholder Chats.
 */
export interface ChatStub {
    id: string
    name: string
    lastDate?: number
    folderId?: string
    modules?: string[]
    _stub: true
}

/**
 * A real stub has the `_stub: true` flag AND no `message` array. The two
 * checks are not redundant: legacy v1.4.x disk corruption can produce
 * "hybrid" objects that carry `_stub: true` while still holding the full
 * Chat payload (message etc). Treating those as stubs would either:
 *   - silently strip messages on the next round-trip (chatToStub fast-path
 *     returns input unchanged), or
 *   - cause the patcher to diff stub-vs-Chat and emit chat-internal field
 *     ops, which the chat-data guard then has to swallow.
 *
 * Excluding hybrids from `isChatStub` makes them flow through the normal
 * Chat code paths (stripped to a real stub by chatToStub, kept as Chat by
 * convertStubsToPlaceholders) — the corrupt flag self-heals.
 */
import { cloneUnitValue, normalizedDeepEqual, normalizeJsonForComparison } from './presetPersonaUnits'

export function isChatStub(chat: unknown): chat is ChatStub {
    if (chat == null || typeof chat !== 'object') return false
    const c = chat as Record<string, unknown>
    return c._stub === true && !Array.isArray(c.message)
}

export function projectChatStub(chat: any): ChatStub {
    if (isChatStub(chat)) return chat
    const stub: ChatStub = {
        id: chat?.id ?? '',
        name: chat?.name ?? '',
        _stub: true,
    }
    if (chat && typeof chat === 'object') {
        if ('lastDate' in chat) stub.lastDate = chat.lastDate
        if ('folderId' in chat) stub.folderId = chat.folderId
        if ('modules' in chat) stub.modules = chat.modules
    }
    return stub
}

const OPTIONAL_STUB_FIELDS = ['lastDate', 'folderId', 'modules'] as const

function hasOwnStubField(stub: any, field: string): boolean {
    return !!stub && typeof stub === 'object' && Object.prototype.hasOwnProperty.call(stub, field) && stub[field] !== undefined
}

export function didChatStubFieldsChange(
    localChat: any,
    baseChat: any,
    normalizeValue: (value: any) => any = normalizeJsonForComparison,
): boolean {
    if (!baseChat) return true
    const localStub = projectChatStub(localChat)
    const baseStub = projectChatStub(baseChat)
    if ((localStub.name ?? '') !== (baseStub.name ?? '')) {
        return true
    }
    for (const field of OPTIONAL_STUB_FIELDS) {
        const localHas = hasOwnStubField(localStub, field)
        const baseHas = hasOwnStubField(baseStub, field)
        if (localHas !== baseHas) return true
        if (localHas && !normalizedDeepEqual(localStub[field], baseStub[field], normalizeValue)) {
            return true
        }
    }
    return false
}

/**
 * Merge stub-level fields (`name`, `lastDate`, `folderId`, `modules`) from
 * `(base, local, remote)` onto `target` in place, preserving key-presence
 * (`in`) semantics for `null` clears vs absent keys.
 */
export function mergeChatStubFieldsOnto(
    target: any,
    baseChat: any | undefined,
    localChat: any,
    remoteChat: any,
    clone: <T>(value: T) => T = cloneUnitValue,
    normalizeValue: (value: any) => any = normalizeJsonForComparison,
): void {
    if (!target || typeof target !== 'object') return
    const localStub = projectChatStub(localChat)
    const remoteStub = projectChatStub(remoteChat)
    const baseStub = baseChat ? projectChatStub(baseChat) : undefined

    const localName = localStub.name ?? ''
    const remoteName = remoteStub.name ?? ''
    if (baseStub) {
        const baseName = baseStub.name ?? ''
        target.name = localName !== baseName ? localName : remoteName
    } else {
        target.name = localName
    }

    for (const field of OPTIONAL_STUB_FIELDS) {
        let winnerStub: any
        if (baseStub) {
            const localHas = hasOwnStubField(localStub, field)
            const baseHas = hasOwnStubField(baseStub, field)
            const localChanged = (localHas !== baseHas)
                || (localHas && !normalizedDeepEqual(localStub[field], baseStub[field], normalizeValue))
            winnerStub = localChanged ? localStub : remoteStub
        } else {
            winnerStub = localStub
        }
        if (hasOwnStubField(winnerStub, field)) {
            target[field] = clone(winnerStub[field])
        } else {
            delete target[field]
        }
    }
}
