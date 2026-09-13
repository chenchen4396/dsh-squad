import type { MemberConversationView, PendingInteractionView } from '../transport/contracts.js'

/**
 * How long the Leader has to answer a member's request before the card opens to
 * the reader.
 *
 * The Leader is the only role a member may talk to, so its answer is the normal
 * path; the reader is the fallback for a Leader that is stopped, busy past the
 * window, or gone.
 */
export const LEADER_ANSWER_WINDOW_MS = 120_000

/** Whether a request is still the Leader's to answer, or the reader's. */
export function leaderAnswerState(askedAt: number, now: number): 'leader' | 'reader' {
  return now - askedAt < LEADER_ANSWER_WINDOW_MS ? 'leader' : 'reader'
}

/**
 * A member waiting for the reader to answer something.
 *
 * A member runs as a one-shot subagent record: its Session view is read-only
 * and cannot raise DSH's own approval prompt, so the plugin answers those
 * requests for it. Nothing else tells the reader that a member is blocked —
 * the member simply keeps showing as `running` — so the room and the member
 * tabs carry the request instead.
 */
export interface PendingAction {
  slotId: string
  displayName: string
  interaction: PendingInteractionView
}

/** Every interaction the reader still has to answer, in roster order. */
export function pendingActionsOf(
  members: readonly { id: string; displayName: string }[],
  conversations: ReadonlyMap<string, MemberConversationView>,
): PendingAction[] {
  return members.flatMap(member => (conversations.get(member.id)?.pendingInteractions ?? [])
    .map(interaction => ({ slotId: member.id, displayName: member.displayName, interaction })))
}
