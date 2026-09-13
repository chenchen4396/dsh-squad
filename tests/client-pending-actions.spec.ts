import { describe, expect, it } from 'vitest'
import {
  LEADER_ANSWER_WINDOW_MS,
  leaderAnswerState,
  pendingActionsOf,
} from '../src/client/pending-actions.js'
import type { MemberConversationView, PendingInteractionView } from '../src/transport/contracts.js'

const approval: PendingInteractionView = {
  id: 'approval:1',
  askedAt: 1_000,
  kind: 'approval',
  toolName: 'write',
  reason: 'escalate sandbox to workspace-write',
} as PendingInteractionView

function conversation(slotId: string, pending: PendingInteractionView[]): MemberConversationView {
  return { slotId, pendingInteractions: pending } as MemberConversationView
}

/**
 * A member blocked on an approval or a question looks exactly like a working
 * one, so the room and the member tabs read these out of the member
 * conversations they already hold.
 */
describe('pendingActionsOf', () => {
  it('lists what each member is waiting on, in roster order', () => {
    const members = [
      { id: 'lead', displayName: 'LD' },
      { id: 'tse', displayName: 'TSE' },
      { id: 'se', displayName: 'SE' },
    ]
    const conversations = new Map([
      ['tse', conversation('tse', [approval])],
      ['se', conversation('se', [])],
    ])

    expect(pendingActionsOf(members, conversations)).toEqual([
      { slotId: 'tse', displayName: 'TSE', interaction: approval },
    ])
  })

  it('says nothing for a member with no conversation yet', () => {
    expect(pendingActionsOf([{ id: 'se', displayName: 'SE' }], new Map())).toEqual([])
  })
})

/**
 * A member's request belongs to the Leader first: members never talk to the
 * reader, and the card only opens to the reader once the Leader has had its
 * window — a Leader that is stopped, busy, or gone must not park a member.
 */
describe('leaderAnswerState', () => {
  it('keeps the request with the Leader inside the window', () => {
    expect(leaderAnswerState(1_000, 1_000)).toBe('leader')
    expect(leaderAnswerState(1_000, 1_000 + LEADER_ANSWER_WINDOW_MS - 1)).toBe('leader')
  })

  it('opens it to the reader once the window has passed', () => {
    expect(leaderAnswerState(1_000, 1_000 + LEADER_ANSWER_WINDOW_MS)).toBe('reader')
    expect(leaderAnswerState(1_000, 1_000 + LEADER_ANSWER_WINDOW_MS * 10)).toBe('reader')
  })
})
