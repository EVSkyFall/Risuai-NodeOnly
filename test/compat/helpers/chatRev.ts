import type { RisuClient } from './client.js'

/**
 * Revision the server holds for a chat, or null when it holds none.
 * A chat-content save replaces an existing chat only when it carries this
 * value as x-chat-base-rev.
 */
export async function chatRevisionOf(
  client: RisuClient,
  charId: string,
  chatIndex: number,
  chatId: string,
): Promise<string | null> {
  const res = await client.fetch(`/api/chat-content/${charId}/${chatIndex}`, {
    headers: { 'x-chat-id': chatId },
  })
  await res.arrayBuffer().catch(() => undefined)
  return res.ok ? res.headers.get('x-chat-rev') : null
}

/** Headers for a save that builds on whatever the server holds now. */
export async function chatBaseRevHeader(
  client: RisuClient,
  charId: string,
  chatIndex: number,
  chatId: string,
): Promise<Record<string, string>> {
  const revision = await chatRevisionOf(client, charId, chatIndex, chatId)
  return revision ? { 'x-chat-base-rev': revision } : {}
}
