import { describe, expect, it } from 'vitest'
import { MemberRegistry, type LeaderAttachment, type OwnedAgent } from '../src/runtime/member-registry.js'

function member(teamId: string, slotId: string, conversationId = 'c1'): OwnedAgent {
  return {
    teamId,
    conversationId,
    slotId,
    handle: { agent: { id: `agent:${slotId}` }, dispose: async () => {} } as never,
    modelSelection: {} as never,
  }
}

function leader(teamId: string, slotId: string): LeaderAttachment {
  return { teamId, conversationId: 'c1', slotId, dispose: () => {} }
}

/**
 * These three records were three maps reached into from forty places, so
 * nothing stated what "is this Session ours" or "which member is this" meant.
 * The registry exists to state it; these tests pin it.
 */
describe('MemberRegistry', () => {
  it('answers whether a Session is ours for a member or for a Leader', () => {
    const registry = new MemberRegistry()
    registry.attach('m1', member('t1', 'slot-1'))
    registry.attachLeader('l1', leader('t1', 'leader-slot'))

    expect(registry.has('m1')).toBe(true)
    expect(registry.has('l1')).toBe(true)
    expect(registry.has('someone-else')).toBe(false)
  })

  it('does not count a Session that is only being activated', () => {
    const registry = new MemberRegistry()
    registry.beginActivation('a1', { teamId: 't1', conversationId: 'c1', slotId: 'slot-1' })
    // It has no Agent yet, so it cannot answer a request or receive a message.
    expect(registry.has('a1')).toBe(false)
    expect(registry.activationOf('a1')?.slotId).toBe('slot-1')
    registry.endActivation('a1')
    expect(registry.activationOf('a1')).toBeUndefined()
  })

  it('resolves identity in the order that matters: member, then Leader, then activating', () => {
    const registry = new MemberRegistry()
    registry.beginActivation('s1', { teamId: 't-activating', conversationId: 'c1', slotId: 'slot-activating' })
    expect(registry.identityOf('s1')?.teamId).toBe('t-activating')

    registry.attachLeader('s1', leader('t-leader', 'slot-leader'))
    expect(registry.identityOf('s1')?.slotId).toBe('slot-leader')

    registry.attach('s1', member('t-member', 'slot-member'))
    // An owned member wins: it is the record the runtime acts on.
    expect(registry.identityOf('s1')?.slotId).toBe('slot-member')
  })

  it('returns undefined for a Session it has never seen', () => {
    expect(new MemberRegistry().identityOf('nobody')).toBeUndefined()
  })

  it('filters by slot and by team without exposing the underlying maps', () => {
    const registry = new MemberRegistry()
    registry.attach('a', member('t1', 'slot-1', 'c1'))
    registry.attach('b', member('t1', 'slot-1', 'c2'))
    registry.attach('c', member('t1', 'slot-2', 'c1'))
    registry.attach('d', member('t2', 'slot-1', 'c3'))

    expect(registry.agentsForSlot('t1', 'slot-1').map(entry => entry.conversationId))
      .toEqual(['c1', 'c2'])
    expect(registry.agentsInTeam('t1').map(([id]) => id)).toEqual(['a', 'b', 'c'])
    expect(registry.agents()).toHaveLength(4)
  })

  it('detaching returns what was recorded, so the caller can dispose it', () => {
    const registry = new MemberRegistry()
    const entry = member('t1', 'slot-1')
    registry.attach('m1', entry)
    expect(registry.detach('m1')).toBe(entry)
    expect(registry.detach('m1')).toBeUndefined()
    expect(registry.has('m1')).toBe(false)
  })

  it('detaching a Leader returns its attachment', () => {
    const registry = new MemberRegistry()
    const attachment = leader('t1', 'leader-slot')
    registry.attachLeader('l1', attachment)
    expect(registry.detachLeader('l1')).toBe(attachment)
    expect(registry.leaderOf('l1')).toBeUndefined()
  })

  it('forgets every record about one Session, whichever kind it is', () => {
    const registry = new MemberRegistry()
    registry.attach('s1', member('t1', 'slot-1'))
    registry.attachLeader('s1', leader('t1', 'leader-slot'))
    registry.beginActivation('s1', { teamId: 't1', conversationId: 'c1', slotId: 'slot-1' })

    registry.forget('s1')
    // A stale entry would make a later Session with the same id look owned.
    expect(registry.has('s1')).toBe(false)
    expect(registry.agentOf('s1')).toBeUndefined()
    expect(registry.leaderOf('s1')).toBeUndefined()
    expect(registry.activationOf('s1')).toBeUndefined()
  })

  it('clears members without touching Leaders', () => {
    const registry = new MemberRegistry()
    registry.attach('m1', member('t1', 'slot-1'))
    registry.attachLeader('l1', leader('t1', 'leader-slot'))
    registry.clear()
    expect(registry.agents()).toEqual([])
    expect(registry.has('l1')).toBe(true)
  })

  it('lists Leader ids for shutdown', () => {
    const registry = new MemberRegistry()
    registry.attachLeader('l1', leader('t1', 'a'))
    registry.attachLeader('l2', leader('t1', 'b'))
    expect(registry.leaderIds()).toEqual(['l1', 'l2'])
  })
})
