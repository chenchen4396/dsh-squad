import type { RoomMessageView } from '../transport/contracts.js'

/**
 * What the room shows: the conversation, not the process.
 *
 * The room is where the team talks, so it keeps speech only — what the reader
 * sent and what a member answered. Reasoning and tool calls are a member's own
 * working detail and stay in that member's column. An answer that reasoned or
 * called tools without saying anything has nothing to show here.
 *
 * One turn arrives as one entry already: the projection keeps a turn's last
 * message and drops the rest, so this only filters what the Host sent.
 */
export function roomSpeech(messages: readonly RoomMessageView[]): RoomMessageView[] {
  return messages.filter(message =>
    (message.kind === 'user' || message.kind === 'agent') && message.text.trim().length > 0)
}
