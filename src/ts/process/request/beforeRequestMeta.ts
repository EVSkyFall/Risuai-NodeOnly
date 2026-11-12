import { stripIllustrationControlNodes } from "../illustrationJobs/controlNodes"

/**
 * Third argument of a plugin `beforeRequest` replacer. sendChat sets it on the
 * chat turn's main request; every other request leaves it `undefined`.
 */
export type BeforeRequestMeta = {
    lorebook?: {
        placed: boolean
        entries: { role: string, content: string, constant: boolean }[]
    }
}

/** The lorebook actives sendChat renders into its `lorebook` prompt slot. */
export function isNormalLoreActive(active: { pos: string, inject: unknown }): boolean {
    return active.pos === '' && active.inject === null
}

/**
 * Whether the assembled prompt contains the lorebook slot: a `lorebook` card
 * in prompt-template mode, or `lorebook` in the legacy format order. sendChat
 * passes the template it assembles from, which for a utility-bot character is
 * its built-in template with a `lorebook` card.
 */
export function isLorebookSlotPlaced(
    promptTemplate: readonly { type: string }[] | null | undefined,
    formatOrder: readonly string[] | null | undefined,
): boolean {
    if (promptTemplate) return promptTemplate.some(card => card.type === 'lorebook')
    return !!formatOrder?.includes('lorebook')
}

/**
 * `lorebookMessages` are the messages sendChat pushed for the normal actives,
 * one per normal active and in the same order. Each entry gets the steps
 * sendChat applies to the slot's message: left out when empty once trimmed
 * (pushPrompts skips it), otherwise trimmed and stripped of illustration
 * control nodes. requestChatData then unescapes the entries once, as it does
 * the prompt. A Lua `editRequest` listener edits the whole assembled prompt
 * and is not applied to the entries.
 */
export function buildBeforeRequestMeta(
    actives: readonly { pos: string, inject: unknown, constant: boolean }[],
    lorebookMessages: readonly { role: string, content: string }[],
    placed: boolean,
): BeforeRequestMeta {
    const entries: { role: string, content: string, constant: boolean }[] = []
    actives.filter(isNormalLoreActive).forEach((active, index) => {
        const message = lorebookMessages[index]
        const trimmed = message.content.trim()
        if (!trimmed) return
        entries.push({ role: message.role, content: stripIllustrationControlNodes(trimmed), constant: active.constant === true })
    })
    return { lorebook: { placed, entries } }
}
