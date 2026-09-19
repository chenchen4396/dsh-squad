import { describe, expect, it, vi } from 'vitest'
import type { RoomDeps } from '../src/runtime/team-room.js'
import { sendRoomMessage, sendUserMessage } from '../src/runtime/team-room.js'

/**
 * Writing into the room, and to one member.
 *
 * The room is what the team said to the reader and to each other, so a message
 * that is not addressed to anybody, or to somebody who has left, has to be
 * refused before it is recorded — a stored message nobody can answer is worse
 * than an error the reader can act on.
 */
function harness(options: { directMemberChat?: boolean; members?: string[] } = {}): {
  deps: RoomDeps
  stored: unknown[]
  followedUp: string[]
} {
  const stored: unknown[] = []
  const followedUp: string[] = []
  const slots = options.members ?? ['slot-leader', 'slot-se']
  const members = Object.fromEntries(slots.map(id => [id, { id, displayName: id }]))
  const team = {
    id: 't1',
    leaderSlotId: 'slot-leader',
    directMemberChat: options.directMemberChat ?? true,
    members,
  }
  const conversation = { id: 'c1', teamId: 't1', sessionId: 'session-1' }
  const deps = {
    ctx: { logger: { warn: vi.fn() } },
    service: { putRuntimeMessage: vi.fn(async (m: unknown) => { stored.push(m) }) },
    members: {},
    interactions: {},
    liveStreams: {},
    operations: { run: async (_key: string, op: () => Promise<void>) => await op() },
    host: {
      requireSendableTeam: () => team,
      requireConversation: () => conversation,
      ensureConversationOnline: vi.fn(async () => {}),
      requireAgentIn: () => ({ followup: (m: unknown) => { followedUp.push(String((m as { id?: string }).id ?? 'x')) } }),
      resolveAgentIn: () => undefined,
      leaderAgent: () => undefined,
    },
  } as unknown as RoomDeps
  return { deps, stored, followedUp }
}

describe('sending into the room', () => {
  it('records the message and tells the leader', async () => {
    const { deps, stored, followedUp } = harness()
    await sendRoomMessage(deps, 't1', '开始吧', 'c1')
    // Stored once, then again with its delivery state.
    expect(stored.length).toBeGreaterThanOrEqual(1)
    expect(stored[0]).toMatchObject({ content: '开始吧', recipient: { kind: 'broadcast' } })
    expect(followedUp).toHaveLength(1)
  })

  it('addresses the mentioned members instead of the leader', async () => {
    const { deps, stored, followedUp } = harness()
    await sendRoomMessage(deps, 't1', 'SE 看一下', 'c1', ['slot-se'])
    expect(stored[0]).toMatchObject({ content: 'SE 看一下', mentions: ['slot-se'] })
    expect(followedUp).toHaveLength(1)
  })

  it('refuses a message to somebody who is not on the team', async () => {
    const { deps, stored } = harness()
    await expect(sendRoomMessage(deps, 't1', '在吗', 'c1', ['slot-gone']))
      .rejects.toThrowError(/slot-gone/)
    // Nothing is recorded: a message to nobody cannot be answered.
    expect(stored).toEqual([])
  })

  it('refuses empty content rather than storing it', async () => {
    const { deps, stored } = harness()
    await expect(sendRoomMessage(deps, 't1', '   ', 'c1')).rejects.toThrow()
    expect(stored).toEqual([])
  })
})

describe('sending to one member', () => {
  it('reaches the member directly when the team allows it', async () => {
    const { deps, stored } = harness({ directMemberChat: true })
    await sendUserMessage(deps, 't1', '你来做', 'c1', 'slot-se')
    expect(stored[0]).toMatchObject({ content: '你来做', recipient: { kind: 'member', slotId: 'slot-se' } })
  })

  it('refuses a direct message when the team has that turned off', async () => {
    const { deps, stored } = harness({ directMemberChat: false })
    await expect(sendUserMessage(deps, 't1', '你来做', 'c1', 'slot-se'))
      .rejects.toThrowError(/disabled/)
    expect(stored).toEqual([])
  })

  it('reaches the leader even with direct chat off', async () => {
    const { deps, stored } = harness({ directMemberChat: false })
    // The leader is the reader's own counterpart, not a side channel.
    await sendUserMessage(deps, 't1', '继续', 'c1')
    expect(stored[0]).toMatchObject({ content: '继续', recipient: { kind: 'leader' } })
  })

  it('refuses a member who is not on the team', async () => {
    const { deps, stored } = harness()
    await expect(sendUserMessage(deps, 't1', '在吗', 'c1', 'slot-gone'))
      .rejects.toThrowError(/slot-gone/)
    expect(stored).toEqual([])
  })
})
