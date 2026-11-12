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
 * in prompt-template mode, or `lorebook` in the legacy format order.
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
 * one per normal active and in the same order.
 */
export function buildBeforeRequestMeta(
    actives: readonly { pos: string, inject: unknown, constant: boolean }[],
    lorebookMessages: readonly { role: string, content: string }[],
    placed: boolean,
): BeforeRequestMeta {
    const entries = actives.filter(isNormalLoreActive).map((active, index) => {
        const message = lorebookMessages[index]
        return { role: message.role, content: message.content, constant: active.constant === true }
    })
    return { lorebook: { placed, entries } }
}
