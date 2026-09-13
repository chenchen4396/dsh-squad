import { describe, expect, it, vi } from 'vitest'
import { TeamMessageDispatcher } from '../src/runtime/team-message-dispatcher.js'
import type { TeamAggregate, TeamMessage } from '../src/domain/types.js'

/**
 * The dispatcher's job is one delivery decision: hand a message to an idle
 * recipient as its own turn, or hold it for the turn that recipient takes once
 * it is free. DSH turns every follow-up into its own queued item, so delivering
 * while the recipient is busy is what buried a real Leader thirty messages deep.
 */
function harness(status: 'idle' | 'running' = 'idle') {
  const outbox = new Map<string, TeamMessage>()
  const messageState = new Map<string, TeamMessage['deliveryState']>()
  let agent: Record<string, unknown> | undefined
  let idleResolvers: Array<() => void> = []
  const calls: Array<{ content: Array<{ text: string }> }> = []

  const makeAgent = (state: 'idle' | 'running') => ({
    status: state,
    followup: (message: { content: Array<{ text: string }> }) => { calls.push(message) },
    whenIdle: () => new Promise<void>(resolve => { idleResolvers.push(resolve) }),
    session: { snapshotEvents: () => [] },
  })

  agent = makeAgent(status)
  const wake = () => {
    const resolvers = idleResolvers
    idleResolvers = []
    for (const resolve of resolvers) resolve()
    return resolvers.length
  }

  const team = {
    id: 'team-1',
    leaderSlotId: 'lead',
    members: {
      lead: { id: 'lead', displayName: 'Leader', role: 'leader' as const },
      coder: { id: 'coder', displayName: 'Coder', role: 'member' as const },
    },
    retiredSessions: {},
    outbox: {} as Record<string, TeamMessage>,
  }
  const service = {
    getTeam: () => ({ ...team, outbox: Object.fromEntries(outbox) }),
    putRuntimeMessage: async (record: TeamMessage) => { messageState.set(record.id, record.deliveryState) },
    updateRuntimeTeam: async (
      _teamId: string,
      change: (current: typeof team) => typeof team,
    ) => {
      const next = change({ ...team, outbox: Object.fromEntries(outbox) })
      outbox.clear()
      for (const [id, record] of Object.entries(next.outbox)) outbox.set(id, record)
    },
    listMessages: () => ({ items: [...outbox.values()] }),
  }
  const dispatcher = new TeamMessageDispatcher(service as never, {
    resolveAgent: () => agent as never,
    warn: vi.fn(),
  })
  return {
    dispatcher,
    outbox,
    messageState,
    followups: () => calls,
    setAgent: (state: 'idle' | 'running') => { agent = makeAgent(state) },
    dropAgent: () => { agent = undefined },
    wake,
    hold: (record: TeamMessage) => { outbox.set(record.id, record) },
  }
}

function message(id: string, content: string, relatedTaskId?: string): TeamMessage {
  return {
    schemaVersion: 1,
    id,
    teamId: 'team-1',
    conversationId: 'c1',
    sender: { kind: 'member', id: 'lead' },
    recipient: { kind: 'member', slotId: 'coder' },
    type: relatedTaskId === undefined ? 'instruction' : 'progress',
    content,
    ...(relatedTaskId === undefined ? {} : { relatedTaskId }),
    attachments: [],
    deliveryState: 'queued',
    idempotencyKey: id,
    createdAt: '2026-01-01T00:00:00.000Z',
  } as TeamMessage
}

describe('TeamMessageDispatcher', () => {
  it('gives an idle recipient the message as its own turn', async () => {
    const h = harness('idle')
    h.hold(message('m1', '做完了'))

    await expect(h.dispatcher.deliver('team-1', 'm1')).resolves.toBe(true)

    expect(h.followups()).toHaveLength(1)
    expect(h.messageState.get('m1')).toBe('delivered')
    expect(h.outbox.has('m1')).toBe(false)
  })

  it('holds messages while the recipient is busy and hands them over together', async () => {
    const h = harness('running')
    h.hold(message('m1', '第一条'))
    h.hold(message('m2', '第二条'))

    // Held, not delivered, and still owned by the outbox so recovery can retry.
    await expect(h.dispatcher.deliver('team-1', 'm1')).resolves.toBe(false)
    await expect(h.dispatcher.deliver('team-1', 'm2')).resolves.toBe(false)
    expect(h.followups()).toHaveLength(0)
    expect(h.outbox.has('m1')).toBe(true)
    expect(h.outbox.has('m2')).toBe(true)

    expect(h.wake()).toBeGreaterThan(0)
    await new Promise(resolve => { setTimeout(resolve, 0) })

    // One turn carries both, in arrival order.
    expect(h.followups()).toHaveLength(1)
    const delivered = h.followups()[0]
    expect(delivered?.content[0]?.text).toContain('第一条')
    expect(delivered?.content[0]?.text).toContain('第二条')
    expect(h.messageState.get('m1')).toBe('delivered')
    expect(h.outbox.size).toBe(0)
  })

  it('replaces an earlier update of the same task with the later one', async () => {
    const h = harness('running')
    h.hold(message('m1', 'Task update: 修登录 Status: running', 'task-1'))
    h.hold(message('m2', 'Task update: 修登录 Status: completed', 'task-1'))

    await h.dispatcher.deliver('team-1', 'm1')
    await h.dispatcher.deliver('team-1', 'm2')

    h.wake()
    await new Promise(resolve => { setTimeout(resolve, 0) })

    expect(h.followups()).toHaveLength(1)
    const delivered = h.followups()[0]
    expect(delivered?.content[0]?.text).toContain('completed')
    expect(delivered?.content[0]?.text).not.toContain('running')
    // The superseded update is retired rather than left in the outbox.
    expect(h.outbox.size).toBe(0)
    expect(h.messageState.get('m1')).toBe('delivered')
  })

  it('keeps the mail while the recipient is not online', async () => {
    const h = harness('idle')
    h.hold(message('m1', '做完了'))
    h.dropAgent()

    await expect(h.dispatcher.deliver('team-1', 'm1')).resolves.toBe(false)

    expect(h.followups()).toHaveLength(0)
    expect(h.outbox.has('m1')).toBe(true)
  })
})
