import { describe, expect, it, vi } from 'vitest'
import type { AgentTeamService } from '../src/service/agent-team-service.js'
import { HandoffRelay, type HandoffDeps } from '../src/runtime/handoff-relay.js'

/**
 * Handing a member's request to the Leader.
 *
 * A member cannot reach the reader, so a question it raises has to be answered
 * by the Leader — and a member blocked on a question nobody will answer is
 * worse than one that was told no. This decides, for each request, whether the
 * Leader may settle it, whether only the reader can, or whether nobody can and
 * it must be refused now.
 */
function harness(options: {
  interactions?: Array<{ id: string; kind: 'question' | 'approval'; requestedMode?: string }>
  delegated?: boolean
  leaderMode?: string
  owned?: boolean
  hasLeader?: boolean
  hasMember?: boolean
} = {}): {
  relay: HandoffRelay
  marks: { userOnly: string[]; leaderOnly: string[]; refused: string[]; armed: string[]; delivered: unknown[] }
  warnings: string[]
} {
  const interactions = options.interactions ?? [{ id: 'i1', kind: 'question' }]
  // `memberRequestContent` reads a question's own list; an approval reads its
  // tool. Built on each read, so a test that changes what is pending is seen.
  const full = (): Array<Record<string, unknown>> =>
    interactions.map(i => ({ questions: [], toolName: 'bash', ...i }))
  const marks = { userOnly: [] as string[], leaderOnly: [] as string[], refused: [] as string[], armed: [] as string[], delivered: [] as unknown[] }
  const warnings: string[] = []
  const member = { id: 'slot-se', displayName: 'SE' }
  const team = {
    id: 't1',
    leaderSlotId: 'slot-leader',
    members: options.hasMember === false ? {} : { 'slot-se': member, 'slot-leader': { id: 'slot-leader', displayName: 'LD' } },
  }
  const conversation = { id: 'c1', sessionId: 'session-1', delegateInteractions: options.delegated === true }
  const deps = {
    ctx: {
      logger: { warn: (message: string) => { warnings.push(message) } },
      agents: {
        get: () => ({
          session: {
            snapshotEvents: () => [
              { type: 'sandbox/mode', data: { mode: options.leaderMode ?? 'workspace-write' } },
            ],
          },
        }),
      },
    },
    service: {
      getTeam: () => team,
      getConversation: () => conversation,
    },
    commands: {
      sendMemberMessage: vi.fn(async (...args: unknown[]) => { marks.delivered.push(args) }),
    },
    interactions: {
      pendingIds: () => interactions.map(i => i.id),
      list: () => full(),
      markUserOnly: (id: string) => { marks.userOnly.push(id) },
      markLeaderOnly: (id: string) => { marks.leaderOnly.push(id) },
      refuse: (id: string) => { marks.refused.push(id) },
      armDeadline: (id: string) => { marks.armed.push(id) },
    },
    members: {
      agentOf: () => (options.owned === false ? undefined : { teamId: 't1', conversationId: 'c1', slotId: 'slot-se' }),
    },
    resolveAgent: () => (options.hasLeader === false ? undefined : {}),
    options: { attempts: 1, retryMs: 0 },
  } as unknown as HandoffDeps
  return { relay: new HandoffRelay(deps), marks, warnings }
}

describe('handoff relay', () => {
  it('does nothing for a Session this runtime does not own', () => {
    const { relay, marks } = harness({ owned: false })
    relay.relay('session-1')
    expect(marks.armed).toEqual([])
    expect(marks.delivered).toEqual([])
  })

  it('keeps a request pending rather than refusing it when the Leader is away', () => {
    const { relay, marks, warnings } = harness({ hasLeader: false })
    relay.relay('session-1')
    // The Leader may be back. Refusing now would deny a request it could grant.
    expect(marks.refused).toEqual([])
    expect(marks.armed).toEqual([])
    expect(warnings.join(' ')).toContain('Leader is not online')
  })

  it('says why a request is waiting when the member is gone', () => {
    const { relay, warnings } = harness({ hasMember: false })
    relay.relay('session-1')
    expect(warnings.join(' ')).toContain('no longer a team member')
  })

  it('hands each request to the Leader once, with a bounded wait', () => {
    const { relay, marks } = harness()
    relay.relay('session-1')
    relay.relay('session-1')
    expect(marks.delivered).toHaveLength(1)
    // Nobody answers forever: the wait is bounded.
    expect(marks.armed).toEqual(['i1'])
  })

  it('leaves a request wider than the Leader to the reader', () => {
    const { relay, marks } = harness({
      interactions: [{ id: 'i1', kind: 'approval', requestedMode: 'danger-full-access' }],
      leaderMode: 'workspace-write',
    })
    relay.relay('session-1')
    // Only the reader can grant it, so the Leader's screen must not offer it.
    expect(marks.userOnly).toEqual(['i1'])
    expect(marks.refused).toEqual([])
  })

  it('answers within the Leader\u2019s own authority without asking the reader', () => {
    const { relay, marks } = harness({
      interactions: [{ id: 'i1', kind: 'approval', requestedMode: 'read-only' }],
      leaderMode: 'workspace-write',
    })
    relay.relay('session-1')
    expect(marks.userOnly).toEqual([])
    expect(marks.delivered).toHaveLength(1)
  })

  it('refuses outright what nobody can grant when «替我审批» is on', () => {
    const { relay, marks } = harness({
      interactions: [{ id: 'i1', kind: 'approval', requestedMode: 'danger-full-access' }],
      leaderMode: 'workspace-write',
      delegated: true,
    })
    relay.relay('session-1')
    // The reader is out of the loop, so a card would never be answered.
    expect(marks.leaderOnly).toEqual(['i1'])
    expect(marks.refused).toEqual(['i1'])
  })

  it('forgets a request that is no longer pending, so a new one is not skipped', () => {
    const interactions = [{ id: 'i1', kind: 'question' as const }]
    const { relay, marks } = harness({ interactions })
    relay.relay('session-1')
    interactions.length = 0
    relay.relay('session-1')
    interactions.push({ id: 'i1', kind: 'question' })
    relay.relay('session-1')
    expect(marks.delivered).toHaveLength(2)
  })
})
