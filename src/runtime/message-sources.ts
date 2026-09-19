import type { MessageSource } from '@deepseek-ai/dsh-llm'

/** The plugin id that marks this plugin's own relays. */
const RELAY_PLUGIN_IDS: ReadonlySet<string> = new Set(['dsh-squad'])

/**
 * Which of a Session's inputs came from the reader.
 *
 * Three questions get asked of every input the projector sees, and they are
 * not the same question: whether it is one of this plugin's relays, whether it
 * is the *reader* speaking, and whether it should be shown as a user turn at
 * all. A relay carries both the reader's own room messages and the team
 * messages this plugin delivers, and only the text tells them apart — the
 * relay copies a reader's message verbatim, while a team message arrives with
 * its `[Team message from …]` header.
 */

export function isRoomRelaySource(source: MessageSource): boolean {
  return source.kind === 'plugin' && RELAY_PLUGIN_IDS.has(source.plugin) && source.form === 'relay'
}

/**
 * Whether this input is the reader speaking.
 *
 * A member answers the reader either because the reader typed into the
 * Session's own composer (`kind: 'user'`) or because the room relayed their
 * message. Both of the plugin's relays share one form, so a relay counts as the
 * reader's own only when its text is one of the reader's room records, which the
 * relay copies verbatim; a team message carries its `[Team message from …]`
 * header instead.
 */
export function isReaderSource(
  source: MessageSource,
  text: string,
  readerLines: ReadonlySet<string>,
): boolean {
  if (source.kind === 'user') return true
  return isRoomRelaySource(source) && readerLines.has(text.trim())
}

export function isVisibleUserSource(source: MessageSource): boolean {
  return source.kind === 'user' || isRoomRelaySource(source)
}
