import { describe, expect, it, vi } from 'vitest'
import type { AgentTeamService } from '../src/service/agent-team-service.js'
import { attachLeader, attachLeaderForSession, detachLeader, type LeaderDeps } from '../src/runtime/leader-attachment.js'

/**
 * Attaching the Leader's composition.
 *
 * The Leader owns no Session: it is the Agent the reader is already talking to,
 * so the composition is added to it and taken off again as the binding changes.
 * Getting the guards wrong means either installing a team twice on somebody's
 * Agent or leaving one installed after the team is gone.
 */
function harness(options: {
  sessionId?: string | undefined
  hasAgent?: boolean
  hasMember?: boolean
  existing?: { teamId: string; conversationId: string; slotId: string } | undefined
  conversationForSession?: boolean
} = {}): { deps: LeaderDeps; detached: string[] } {
  const detached: string[] = []
  const member = { id: 'slot-leader', displayName: 'LD' }
  const team = {
    id: 't1',
    leaderSlotId: 'slot-leader',
    members: options.hasMember === false ? {} : { 'slot-leader': member },
  }
  const conversation = {
    id: 'c1',
    teamId: 't1',
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  }
  const deps = {
    ctx: {
      agents: {
        get: () => (options.hasAgent === false ? undefined : {
          ctx: {
            // Enough of an Agent scope for the composition to install itself.
            systemPrompt: { section: () => () => {} },
            tools: { register: () => () => {}, schemas: () => [] },
          },
          session: {},
        }),
      },
      logger: { warn: vi.fn() },
    },
    service: {
      getTeam: () => team,
      findConversationBySession: () => (options.conversationForSession === false ? undefined : conversation),
    },
    members: {
      leaderOf: () => (options.existing === undefined ? undefined : { ...options.existing, dispose: vi.fn() }),
      detachLeader: vi.fn((sessionId: string) => { detached.push(sessionId) }),
      attachLeader: vi.fn(),
    },
    interactions: { attach: vi.fn() },
    commands: {},
    handoffRelay: { leaderSandboxMode: () => undefined },
    rulesFor: () => [],
    assertToolIdentity: vi.fn(),
  } as unknown as LeaderDeps
  return { deps, detached }
}

describe('attaching the Leader', () => {
  it('does nothing for a conversation with no Session yet', () => {
    const { deps, detached } = harness({ sessionId: undefined })
    attachLeader(deps, { id: 'c1', teamId: 't1' } as never)
    expect(detached).toEqual([])
    expect(deps.members.attachLeader).not.toHaveBeenCalled()
  })

  it('does nothing when the Session has no Agent', () => {
    const { deps } = harness({ sessionId: 'session-1', hasAgent: false })
    attachLeader(deps, { id: 'c1', teamId: 't1', sessionId: 'session-1' } as never)
    expect(deps.members.attachLeader).not.toHaveBeenCalled()
  })

  it('does nothing when the team has no leader slot', () => {
    const { deps } = harness({ sessionId: 'session-1', hasMember: false })
    attachLeader(deps, { id: 'c1', teamId: 't1', sessionId: 'session-1' } as never)
    expect(deps.members.attachLeader).not.toHaveBeenCalled()
  })

  it('leaves an attachment that is already correct alone', () => {
    const { deps } = harness({
      sessionId: 'session-1',
      existing: { teamId: 't1', conversationId: 'c1', slotId: 'slot-leader' },
    })
    attachLeader(deps, { id: 'c1', teamId: 't1', sessionId: 'session-1' } as never)
    // Re-installing would add a second set of prompt sections and tools.
    expect(deps.members.attachLeader).not.toHaveBeenCalled()
  })

  it('replaces an attachment that points at another team', () => {
    const { deps, detached } = harness({
      sessionId: 'session-1',
      existing: { teamId: 'other-team', conversationId: 'c9', slotId: 'slot-old' },
    })
    attachLeader(deps, { id: 'c1', teamId: 't1', sessionId: 'session-1' } as never)
    // The old composition is taken off before the new one is added.
    expect(detached).toEqual(['session-1'])
  })

  it('attaches by Session, for the conversation that Session owns', () => {
    const { deps, detached } = harness({ sessionId: 'session-1' })
    attachLeaderForSession(deps, 'session-1')
    // Nothing was attached before, so nothing is taken off first.
    expect(detached).toEqual([])
    expect(deps.members.attachLeader).toHaveBeenCalled()
  })

  it('does nothing for a Session with no conversation', () => {
    const { deps } = harness({ sessionId: 'session-1', conversationForSession: false })
    attachLeaderForSession(deps, 'session-1')
    expect(deps.members.attachLeader).not.toHaveBeenCalled()
  })
})

describe('detaching the Leader', () => {
  it('removes the composition it installed', () => {
    const dispose = vi.fn()
    const { deps } = harness({ sessionId: 'session-1' })
    ;(deps.members as unknown as { leaderOf: unknown }).leaderOf = () => ({ dispose })
    detachLeader(deps, 'session-1')
    expect(deps.members.detachLeader).toHaveBeenCalledWith('session-1')
    // The prompt sections and tools go with it.
    expect(dispose).toHaveBeenCalled()
  })

  it('does nothing when no composition was installed', () => {
    const { deps } = harness({ sessionId: 'session-1' })
    detachLeader(deps, 'session-1')
    expect(deps.members.detachLeader).not.toHaveBeenCalled()
  })
})
