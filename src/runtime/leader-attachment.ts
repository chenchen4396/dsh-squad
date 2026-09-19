import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AgentTeamError } from '../domain/errors.js'
import type { TeamAggregate, TeamConversation, TeamMemberSlot } from '../domain/types.js'
import type { AgentTeamService } from '../service/agent-team-service.js'
import type { HandoffRelay } from './handoff-relay.js'
import type { MemberRegistry } from './member-registry.js'
import type { RuleDocumentContent } from './rule-documents.js'
import type { TeamCommandHandler } from './team-command-handler.js'
import type { TeamInteractionBridge } from './team-interaction-bridge.js'
import { decideLeaderAnswer } from './leader-answer.js'
import { installCompositionSections, teamComposition, type CompositionDeps } from './team-composition.js'
import { registerTeamTools } from './team-tools.js'

/**
 * The Leader: the Session's own Agent, acting for one team.
 *
 * The Leader owns no Session of its own — it is the Agent the reader is already
 * talking to. So the team composition is added to it when it appears (on the
 * first conversation view, on a reload, or after a Harness restart), kept for
 * as long as the binding lasts, and taken back off when it goes away or the
 * team changes underneath it.
 *
 * The Leader keeps the Session's own model, preset and permissions; only the
 * team composition is added.
 */

/** What attaching a Leader needs from the runtime that owns it. */
export interface LeaderDeps {
  ctx: Context
  service: AgentTeamService
  members: MemberRegistry
  interactions: TeamInteractionBridge
  commands: TeamCommandHandler
  /** The relay the Leader answers members through. */
  handoffRelay: HandoffRelay
  rulesFor: (member: TeamMemberSlot) => RuleDocumentContent[]
  assertToolIdentity: (
    agent: Agent | undefined,
    teamId: string,
    conversationId: string,
    slotId: string,
  ) => void
}

/** The composition callbacks, built from the runtime's own helpers. */
function compositionDeps(deps: LeaderDeps): CompositionDeps {
  return {
    service: deps.service,
    commands: deps.commands,
    rulesFor: deps.rulesFor,
    assertToolIdentity: deps.assertToolIdentity,
  }
}

export function attachLeaderForSession(deps: LeaderDeps, sessionId: string): void {
  const conversation = deps.service.findConversationBySession(sessionId)
  if (conversation !== undefined) attachLeader(deps, conversation)
}

/**
 * Make one Session's own Agent act as the team Leader: its instructions and
 * the roster are added to the Agent's prompt, and the team tools are exposed
 * so it can create tasks and message members from the 对话 view itself.
 *
 * The Leader keeps the Session's own model, preset and permissions — only the
 * team composition is added, and only for as long as the binding lasts.
 */
export function attachLeader(deps: LeaderDeps, conversation: TeamConversation): void {
  const sessionId = conversation.sessionId
  if (sessionId === undefined) return
  const agent = deps.ctx.agents.get(SessionId(sessionId))
  if (agent === undefined) return
  const team = deps.service.getTeam(conversation.teamId)
  const member = team.members[team.leaderSlotId]
  if (member === undefined) return
  const existing = deps.members.leaderOf(sessionId)
  if (
    existing !== undefined
    && existing.teamId === team.id
    && existing.conversationId === conversation.id
    && existing.slotId === member.id
  ) {
    return
  }
  detachLeader(deps, sessionId)
  const agentCtx = agent.ctx
  const disposers: Array<() => void> = []
  try {
    const composition = teamComposition(        {
        service: deps.service,
        commands: deps.commands,
        rulesFor: (target: TeamMemberSlot) => deps.rulesFor(target),
        assertToolIdentity: (agent: Agent | undefined, teamId: string, convId: string, slotId: string) => {
          deps.assertToolIdentity(agent, teamId, convId, slotId)
        },
      },         {
        team,
        conversationId: conversation.id,
        slotId: member.id,
        // The Leader slot moves when the team changes leader, so it is read
        // when a tool is called rather than captured here.
        actorSlotId: () => deps.service.getTeam(team.id).leaderSlotId,
        promptMember: (latest: TeamAggregate) => latest.members[latest.leaderSlotId],
      })
    disposers.push(...installCompositionSections(
      agentCtx,
              {
        service: deps.service,
        commands: deps.commands,
        rulesFor: (target: TeamMemberSlot) => deps.rulesFor(target),
        assertToolIdentity: (agent: Agent | undefined, teamId: string, convId: string, slotId: string) => {
          deps.assertToolIdentity(agent, teamId, convId, slotId)
        },
      },
              {
        team,
        conversationId: conversation.id,
        slotId: member.id,
        // The Leader slot moves when the team changes leader, so it is read
        // when a tool is called rather than captured here.
        actorSlotId: () => deps.service.getTeam(team.id).leaderSlotId,
        promptMember: (latest: TeamAggregate) => latest.members[latest.leaderSlotId],
      },
      composition.identitySection,
      composition.rosterSection,
    ))
    disposers.push(registerTeamTools(agentCtx, {
      ...composition.tools,
      answerMember: async input => {
        const pending = deps.interactions.pending(input.interactionId)
        if (pending === undefined) {
          throw new AgentTeamError('INTERACTION_NOT_FOUND', '该交互请求已结束或不存在')
        }
        const decision = decideLeaderAnswer({
          pending,
          ...(input.decision === undefined ? {} : { decision: input.decision }),
          leaderMode: deps.handoffRelay.leaderSandboxMode(team.id, conversation.id),
          delegated: deps.service.getConversation(team.id, conversation.id).delegateInteractions === true,
        })
        if (decision.userOnly) deps.interactions.markUserOnly(pending.id)
        if (decision.refusal !== undefined) {
          throw new AgentTeamError('INVALID_REQUEST', decision.refusal)
        }
        const answered = deps.interactions.answerAsLeader(input.interactionId, input)
        return { interactionId: input.interactionId, answered }
      },
    }))
    // Registered so «替我审批» can answer the Leader's own requests; while it
    // is off the scope does not accept this Session and the Harness interface
    // answers them instead.
    deps.interactions.attach(agentCtx, agent)
    const dispose = (): void => {
      for (const disposer of disposers.reverse()) {
        try {
          disposer()
        } catch (error) {
          deps.ctx.logger.warn('agent-team: failed to remove a Leader registration', error)
        }
      }
    }
    deps.members.attachLeader(sessionId, {
      teamId: team.id,
      conversationId: conversation.id,
      slotId: member.id,
      dispose,
    })
  } catch (error) {
    for (const disposer of disposers.reverse()) {
      try {
        disposer()
      } catch { /* rolling back a failed attach */ }
    }
    throw error
  }
}

/** Remove the team composition from one Session's Agent. */
export function detachLeader(deps: LeaderDeps, sessionId: string): void {
  const attachment = deps.members.leaderOf(sessionId)
  if (attachment === undefined) return
  deps.members.detachLeader(sessionId)
  attachment.dispose()
}
