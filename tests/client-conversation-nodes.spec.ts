import { describe, expect, it } from 'vitest'
import {
  mergeConversationNodes,
  mergeMemberConversation,
  mergeRoomView,
  prependMemberPage,
  prependRoomPage,
} from '../src/client/conversation-nodes.js'
import type {
  ConversationNode,
  MemberConversationView,
  RoomMessageView,
  RoomView,
} from '../src/transport/contracts.js'

function userNode(id: string, text: string, seq = 1): ConversationNode {
  return {
    id,
    kind: 'user',
    seq,
    time: seq,
    text,
  }
}

function conversationView(
  nodes: ConversationNode[],
  extra: { hasMore?: boolean; oldestSeq?: number } = {},
): MemberConversationView {
  return {
    slotId: 'slot-1',
    conversationId: 'conversation-1',
    throughSeq: nodes.at(-1)?.seq ?? -1,
    status: 'idle',
    nodes,
    pendingInteractions: [],
    ...extra,
  }
}

function roomMessage(id: string, time: number): RoomMessageView {
  return { id, kind: 'agent', seq: time, time, text: id, senderName: 'SE', senderRole: 'member' }
}

function roomView(
  messages: RoomMessageView[],
  extra: { hasMore?: boolean; oldestTime?: number } = {},
): RoomView {
  return {
    schemaVersion: 1,
    teamId: 'team-1',
    conversation: {
      schemaVersion: 1,
      id: 'conversation-1',
      teamId: 'team-1',
      title: '',
      titleSource: 'auto',
      state: 'active',
      memberSessions: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      revision: 1,
    },
    participants: [],
    messages,
    throughSeq: 1,
    hasMore: false,
    ...extra,
  }
}

describe('mergeConversationNodes', () => {
  it('removes an optimistic message after the committed message with the same id arrives', () => {
    const committed = userNode('message-1', '重新获取团队成员')
    const pending = userNode('message-1', '重新获取团队成员')

    expect(mergeConversationNodes([committed], [pending])).toEqual([committed])
  })

  it('keeps an optimistic message until its committed message arrives', () => {
    const pending = userNode('pending:1', '重新获取团队成员')

    expect(mergeConversationNodes([], [pending])).toEqual([pending])
  })
})

describe('member conversation windows', () => {
  it('keeps the pages a reader pulled in when a newer window arrives', () => {
    const loaded = conversationView([userNode('n1', '旧', 1), userNode('n2', '更旧', 0)], {
      hasMore: false,
      oldestSeq: 0,
    })
    const incoming = conversationView([userNode('n3', '新', 3)], {
      hasMore: true,
      oldestSeq: 3,
    })

    expect(mergeMemberConversation(loaded, incoming)).toMatchObject({
      nodes: [expect.objectContaining({ id: 'n2' }), expect.objectContaining({ id: 'n1' }), expect.objectContaining({ id: 'n3' })],
      hasMore: false,
      oldestSeq: 0,
    })
  })

  it('takes the incoming window when nothing older is on screen', () => {
    const incoming = conversationView([userNode('n3', '新', 3)], { hasMore: true, oldestSeq: 3 })
    expect(mergeMemberConversation(conversationView([userNode('n9', '别的会话', 9)]), incoming)).toBe(incoming)
  })

  it('prepends one older page and hands the boundary back', () => {
    const current = conversationView([userNode('n3', '新', 3)], { hasMore: true, oldestSeq: 3 })
    const page = conversationView([userNode('n1', '旧', 1), userNode('n2', '更旧', 0)], {
      hasMore: false,
      oldestSeq: 0,
    })

    expect(prependMemberPage(current, page)).toMatchObject({
      nodes: [expect.objectContaining({ id: 'n2' }), expect.objectContaining({ id: 'n1' }), expect.objectContaining({ id: 'n3' })],
      hasMore: false,
      oldestSeq: 0,
    })
  })
})

describe('room windows', () => {
  it('keeps paged older entries when a newer window arrives', () => {
    const loaded = roomView([roomMessage('m1', 1), roomMessage('m2', 2)], { hasMore: false, oldestTime: 1 })
    const incoming = roomView([roomMessage('m4', 4)], { hasMore: true, oldestTime: 4 })

    expect(mergeRoomView(loaded, incoming)).toMatchObject({
      messages: [expect.objectContaining({ id: 'm1' }), expect.objectContaining({ id: 'm2' }), expect.objectContaining({ id: 'm4' })],
      hasMore: false,
      oldestTime: 1,
    })
  })

  it('prepends one older room page in time order', () => {
    const current = roomView([roomMessage('m4', 4)], { hasMore: true, oldestTime: 4 })
    const page = roomView([roomMessage('m1', 1), roomMessage('m2', 2)], { hasMore: false, oldestTime: 1 })

    expect(prependRoomPage(current, page)).toMatchObject({
      messages: [expect.objectContaining({ id: 'm1' }), expect.objectContaining({ id: 'm2' }), expect.objectContaining({ id: 'm4' })],
      hasMore: false,
      oldestTime: 1,
    })
  })
})
