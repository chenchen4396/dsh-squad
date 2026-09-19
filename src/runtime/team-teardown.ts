import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { AgentTeamError } from '../domain/errors.js'
import type { OwnedAgent } from './member-registry.js'
import type { AgentTeamService } from '../service/agent-team-service.js'
import type { MemberConversationView } from '../transport/contracts.js'
import { taskAssigneeIds } from '../domain/team-selectors.js'
import { createSystemTeamMessage as systemTeamMessage } from './team-messages.js'
import type { TeamAggregate, TeamConversation, TeamMemberSlot } from '../domain/types.js'
import type { MemberRegistry } from './member-registry.js'
import type { OperationQueue } from './operation-queue.js'
import type { TeamInteractionBridge } from './team-interaction-bridge.js'
import type { TeamMessageDispatcher } from './team-message-dispatcher.js'

/**
 * Taking a team apart: one member, a whole team, or a conversation's members.
 *
 * The order matters more than it looks. A member with work still open is
 * refused rather than removed, because a task owned by somebody who is gone is
 * a task nobody can finish; a conversation's members are stopped before their
 * records go; and dissolving a team leaves its records readable until the last
 * step. Each of those is a decision about what state the rest of the runtime
 * must never observe.
 */

/** The runtime's own lookups and updates, as teardown needs them. */
export interface TeardownHost {
  /** Remove the team composition from a Session's Agent. */
  detachLeader: (sessionId: string) => void
  /** One member's projected view, for the conversation update that follows. */
  projectMemberConversation: (
    team: TeamAggregate,
    member: TeamMemberSlot,
    conversation: TeamConversation,
    events: readonly SessionEvent[],
  ) => MemberConversationView
  /** One member's Agent inside a conversation, refusing when it is offline. */
  requireAgentIn: (conversation: TeamConversation, slotId: string) => Agent
  /** The conversation, or a refusal naming it. */
  requireConversation: (teamId: string, conversationId: string) => TeamConversation
  /** The team, or a refusal naming it. */
  requireSendableTeam: (teamId: string) => TeamAggregate
  /** A member's Agent changed state, so the record follows. */
  setMemberRuntimeState: (teamId: string, slotId: string, state: 'idle' | 'running') => Promise<void>
}

/** What taking a team apart needs from the runtime that owns it. */
export interface TeardownDeps {
  ctx: Context
  service: AgentTeamService
  members: MemberRegistry
  interactions: TeamInteractionBridge
  messages: TeamMessageDispatcher
  operations: OperationQueue
  host: TeardownHost
}

export async function stopConversationMembers(deps: TeardownDeps, conversation: TeamConversation): Promise<void> {
  const sessionIds = Object.values(conversation.memberSessions)
  const ownedEntries = sessionIds
    .map(sessionId => [sessionId, deps.members.agentOf(sessionId)] as const)
    .filter((entry): entry is readonly [string, OwnedAgent] => entry[1] !== undefined)
  for (const [, entry] of ownedEntries) entry.handle.agent.cancel({ kind: 'user' }, { keepInbox: false })
  await Promise.all(ownedEntries.map(([, entry]) => entry.handle.agent.whenIdle()))
  for (const [sessionId, entry] of ownedEntries) {
    try {
      await deps.ctx.sessions.flush(entry.handle.agent.session)
    } catch (error) {
      deps.ctx.logger.warn(`agent-team: session flush failed for ${sessionId}`, error)
    }
    deps.members.detach(sessionId)
    deps.interactions.forget(sessionId)
    await entry.handle.dispose()
  }
}

export async function stopMember(deps: TeardownDeps, teamId: string, slotId: string, conversationId: string): Promise<void> {
  const team = deps.host.requireSendableTeam(teamId)
  const member = team.members[slotId]
  if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
  const conversation = deps.host.requireConversation(teamId, conversationId)
  const agent = deps.host.requireAgentIn(conversation, slotId)
  agent.cancel({ kind: 'user' })
  await agent.whenIdle()
  await deps.host.setMemberRuntimeState(teamId, slotId, 'idle')
  const current = deps.service.getTeam(teamId)
  const currentMember = current.members[slotId]
  if (currentMember !== undefined) {
    deps.service.publishConversation(
      teamId,
      current.revision,
      deps.host.projectMemberConversation(
        current,
        currentMember,
        conversation,
        agent.session.snapshotEvents(),
      ),
    )
  }
}

export function removeMember(deps: TeardownDeps, teamId: string, slotId: string): Promise<TeamAggregate> {
  return deps.operations.run(teamId, async () => {
    const team = deps.service.getTeam(teamId)
    if (team.state !== 'active' && team.state !== 'error') {
      throw new AgentTeamError('TEAM_NOT_ACTIVE', `Cannot remove a runtime member while team is '${team.state}'`)
    }
    const member = team.members[slotId]
    if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    if (slotId === team.leaderSlotId) {
      throw new AgentTeamError('MEMBER_IS_LEADER', 'Choose a successor before removing the current leader')
    }
    const openTasks = Object.values(team.tasks).filter(task =>
      taskAssigneeIds(task).includes(slotId) && !['completed', 'failed', 'cancelled'].includes(task.status))
    if (openTasks.length > 0) {
      throw new AgentTeamError('MEMBER_BUSY', 'Resolve this member’s open tasks before removal', {
        taskIds: openTasks.map(task => task.id),
      })
    }

    // A member owns one Session per conversation, so removal must tear down
    // every Session that member ever materialized.
    const sessionIds = [...new Set(
      deps.service.listConversations(teamId).items
        .map(conversation => conversation.memberSessions[slotId])
        .filter((value): value is string => value !== undefined),
    )]
    for (const sessionId of sessionIds) {
      if (deps.members.agentOf(sessionId) === undefined && deps.ctx.agents.get(SessionId(sessionId)) !== undefined) {
        throw new AgentTeamError(
          'AGENT_HANDLE_OWNERSHIP_CONFLICT',
          `Session '${sessionId}' is live without this plugin's AgentHandle`,
        )
      }
    }
    for (const sessionId of sessionIds) {
      const owned = deps.members.agentOf(sessionId)
      if (owned === undefined) continue
      owned.handle.agent.cancel({ kind: 'user' }, { keepInbox: false })
      await owned.handle.agent.whenIdle()
      await deps.ctx.sessions.flush(owned.handle.agent.session)
      deps.members.detach(sessionId)
      deps.interactions.forget(sessionId)
      await owned.handle.dispose()
    }
    await deps.service.forgetMemberSessions(teamId, slotId)
    const removedAt = new Date().toISOString()
    const target = deps.service.listConversations(teamId).items[0]
    const notice = target === undefined
      ? undefined
      : systemTeamMessage({
        team,
        conversationId: target.id,
        recipientSlotId: team.leaderSlotId,
        content: `团队成员「${member.displayName}」（成员 ID：${member.id}）已被移出团队，其 Session 已停止并归档。后续任务请重新分配给其他成员。`,
      })
    await deps.service.updateRuntimeTeam(
      teamId,
      current => {
        const members = { ...current.members }
        delete members[slotId]
        return {
          ...current,
          members,
          retiredSessions: {
            ...current.retiredSessions,
            ...Object.fromEntries(sessionIds.map(sessionId => [
              sessionId,
              {
                formerSlotId: member.id,
                sessionId,
                displayName: member.displayName,
                removedAt,
              },
            ])),
          },
          ...(notice === undefined ? {} : { outbox: { ...current.outbox, [notice.id]: notice } }),
        }
      },
      'team.member_removed',
      `Member ${member.displayName} removed; Session history retained`,
    )
    if (notice !== undefined) await deps.messages.deliver(teamId, notice.id)
    return deps.service.getTeam(teamId)
  })
}

export function dissolveTeam(deps: TeardownDeps, teamId: string): Promise<void> {
  return deps.operations.run(teamId, async () => {
    let team = deps.service.getTeam(teamId)
    const conversations = deps.service.listConversations(teamId).items
    const sessionIds = [...new Set([
      ...conversations.flatMap(conversation => Object.values(conversation.memberSessions)),
      ...Object.keys(team.retiredSessions),
    ])]
    for (const conversation of conversations) {
      if (conversation.sessionId !== undefined) deps.host.detachLeader(conversation.sessionId)
    }
    for (const sessionId of sessionIds) {
      if (deps.members.agentOf(sessionId) === undefined && deps.ctx.agents.get(SessionId(sessionId)) !== undefined) {
        throw new AgentTeamError(
          'AGENT_HANDLE_OWNERSHIP_CONFLICT',
          `Session '${sessionId}' is live without this plugin's AgentHandle`,
        )
      }
    }

    if (team.state !== 'deleting') {
      team = await deps.service.updateRuntimeTeam(
        teamId,
        current => ({ ...current, state: 'deleting' }),
        'team.deleting',
        `Team ${team.name} dissolution started`,
      )
    }

    try {
      const ownedEntries = deps.members.agentsInTeam(teamId)
      for (const [, entry] of ownedEntries) {
        entry.handle.agent.cancel({ kind: 'user' }, { keepInbox: false })
      }
      await Promise.all(ownedEntries.map(([, entry]) => entry.handle.agent.whenIdle()))

      for (const [sessionId, entry] of ownedEntries) {
        try {
          await deps.ctx.sessions.flush(entry.handle.agent.session)
        } catch (error) {
          deps.ctx.logger.warn(`agent-team: final session flush failed during dissolution for ${sessionId}`, error)
        }
        await entry.handle.dispose()
        deps.members.detach(sessionId)
        deps.interactions.forget(sessionId)
      }

      await deps.service.deleteTeamRecords(teamId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        await deps.service.updateRuntimeTeam(
          teamId,
          current => ({ ...current, state: 'delete_blocked' }),
          'team.delete_blocked',
          message,
        )
      } catch (updateError) {
        deps.ctx.logger.warn(`agent-team: failed to persist blocked dissolution for ${teamId}`, updateError)
      }
      throw error instanceof AgentTeamError
        ? error
        : new AgentTeamError(
          'TEAM_DELETE_FAILED',
          `团队“${team.name}”解散失败：${message}`,
          { teamId, cause: message },
          { cause: error },
        )
    }
  })
}
