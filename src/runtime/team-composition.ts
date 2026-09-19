import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TeamAggregate, TeamMemberSlot } from '../domain/types.js'
import type { AgentTeamService } from '../service/agent-team-service.js'
import type { RuleDocumentContent } from './rule-documents.js'
import type { TeamCommandHandler } from './team-command-handler.js'
import { memberPrompt, rosterPrompt } from './team-prompts.js'
import { registerTeamTools, type TeamToolHandlers } from './team-tools.js'

/**
 * The composition a team puts on an Agent: who is in the team, and what that
 * Agent may do about it.
 *
 * The Leader and a member get the same two prompt sections and the same team
 * tools — the Leader's own Agent, and each member's Agent, are both Agents that
 * act for one slot in one conversation. The two were written out separately, so
 * the section names, their order, and the tool contract had to be kept equal by
 * hand; only two things ever differed, and both are parameters here: which slot
 * the Agent acts as, and whose task board it reads.
 */
export interface CompositionDeps {
  service: AgentTeamService
  commands: TeamCommandHandler
  rulesFor: (member: TeamMemberSlot) => RuleDocumentContent[]
  assertToolIdentity: (
    agent: Agent | undefined,
    teamId: string,
    conversationId: string,
    slotId: string,
  ) => void
}

export interface CompositionParams {
  team: TeamAggregate
  conversationId: string
  /** The slot this composition names, fixed for as long as it is attached. */
  slotId: string
  /**
   * The slot this Agent acts as, resolved each time rather than captured: the
   * Leader's slot changes when the team changes leader.
   */
  actorSlotId: () => string
  /** The member whose prompt describes this Agent, resolved when it is read. */
  promptMember: (team: TeamAggregate) => TeamMemberSlot | undefined
}

/** The prompt sections and tools an Agent of a team is given. */
export interface TeamComposition {
  identitySection: string
  rosterSection: string
  /** The tool callbacks, for a caller that adds tools of its own. */
  tools: TeamToolHandlers
}

export function teamComposition(deps: CompositionDeps, params: CompositionParams): TeamComposition {
  const { team, conversationId, slotId, actorSlotId, promptMember } = params
  const identitySection = `agent-team:identity:${slotId}`
  const rosterSection = `agent-team:roster:${team.id}`
  return {
    identitySection,
    rosterSection,
    tools: {
      assertIdentity: caller => {
        deps.assertToolIdentity(caller, team.id, conversationId, actorSlotId())
      },
      getTaskBoard: () => {
        const latest = deps.service.getTeam(team.id)
        const tasks = Object.values(latest.tasks)
          .filter(task => task.conversationId === conversationId)
          .map(task => JSON.parse(JSON.stringify(task)) as Record<string, string | number | string[]>)
        return { teamId: latest.id, revision: latest.revision, tasks }
      },
      createTask: input => deps.commands.createTask(team.id, conversationId, actorSlotId(), input),
      updateTask: input => deps.commands.updateTask(team.id, conversationId, actorSlotId(), input),
      sendMessage: (recipientSlotId, content, type, taskId) => (
        deps.commands.sendMemberMessage(
          team.id,
          conversationId,
          actorSlotId(),
          recipientSlotId,
          content,
          type,
          taskId,
        )
      ),
    },
  }
}

/** Install the two prompt sections on an Agent, returning their removers. */
export function installCompositionSections(
  agentCtx: Context,
  deps: CompositionDeps,
  params: CompositionParams,
  identitySection: string,
  rosterSection: string,
): Array<() => void> {
  const { team, promptMember } = params
  return [
    agentCtx.systemPrompt.section({
      name: identitySection,
      order: 10,
      text: () => {
        const latest = deps.service.getTeam(team.id)
        const latestMember = promptMember(latest)
        return latestMember === undefined
          ? 'This team membership is no longer active.'
          : memberPrompt(
            latest,
            latestMember,
            deps.service.assistantForMember(latestMember).instructions,
            deps.rulesFor(latestMember),
          )
      },
    }),
    agentCtx.systemPrompt.section({
      name: rosterSection,
      order: 11,
      text: () => rosterPrompt(deps.service.getTeam(team.id)),
    }),
  ]
}
