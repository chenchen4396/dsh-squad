import { describe, expect, it } from 'vitest'
import { mergeWorkbenchLoad } from '../src/client/conversation-nodes.js'
import type { MemberConversationView, TeamWorkbenchView } from '../src/transport/contracts.js'

function memberConversation(
  slotId: string,
  conversationId: string,
  throughSeq: number,
): MemberConversationView {
  return {
    slotId,
    conversationId,
    throughSeq,
    status: 'running',
    nodes: [],
    pendingInteractions: [],
  }
}

function workbench(
  conversationId: string,
  conversations: MemberConversationView[],
): TeamWorkbenchView {
  return {
    schemaVersion: 1,
    teamId: 'team-1',
    revision: 3,
    conversation: {
      schemaVersion: 1,
      id: conversationId,
      teamId: 'team-1',
      title: '会话',
      titleSource: 'user',
      state: 'active',
      memberSessions: {},
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      revision: 1,
    },
    conversations,
  }
}

describe('mergeWorkbenchLoad', () => {
  it('takes the loaded view when nothing streamed while it was in flight', () => {
    const loaded = workbench('conversation-2', [memberConversation('slot-1', 'conversation-2', 4)])

    expect(mergeWorkbenchLoad(workbench('conversation-1', []), loaded, false)).toEqual(loaded)
  })

  it('keeps the pages a reader pulled in across a reload', () => {
    const paged: MemberConversationView = {
      ...memberConversation('slot-1', 'conversation-2', 30),
      nodes: [{ id: 'n1', kind: 'user', seq: 1, time: 1, text: '旧' }],
      hasMore: false,
      oldestSeq: 1,
    }
    const loaded = workbench('conversation-2', [{
      ...memberConversation('slot-1', 'conversation-2', 60),
      nodes: [{ id: 'n9', kind: 'user', seq: 9, time: 9, text: '新' }],
      hasMore: true,
      oldestSeq: 9,
    }])

    const merged = mergeWorkbenchLoad(workbench('conversation-2', [paged]), loaded, false)

    // Reloading must not throw the reader back to the newest page alone.
    expect(merged.conversations[0]?.nodes.map(node => node.id)).toEqual(['n1', 'n9'])
    expect(merged.conversations[0]?.hasMore).toBe(false)
    expect(merged.conversations[0]?.oldestSeq).toBe(1)
  })

  it('keeps streamed member state but takes the loaded conversation facts', () => {
    const streamed = memberConversation('slot-1', 'conversation-2', 9)
    const current = workbench('conversation-1', [streamed])
    const loaded = workbench('conversation-2', [memberConversation('slot-1', 'conversation-2', 4)])

    const merged = mergeWorkbenchLoad(current, loaded, true)

    // The session kept streaming, so its newest projection stays on screen...
    expect(merged.conversations).toEqual([streamed])
    // ...while the conversation the response describes is the one now shown.
    expect(merged.conversation.id).toBe('conversation-2')
  })

  it('never mixes one conversation\'s member state into another', () => {
    const current = workbench('conversation-1', [memberConversation('slot-1', 'conversation-1', 9)])
    const loaded = workbench('conversation-2', [memberConversation('slot-1', 'conversation-2', 4)])

    expect(mergeWorkbenchLoad(current, loaded, true)).toEqual(loaded)
  })
})
