import type { Context } from '@deepseek-ai/cordis'
import {
  assembleContextFor,
  type Agent,
  type ModelSelectionRef,
  installModelSelection,
} from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { isModelInvocable, isUserInvocable } from '@deepseek-ai/dsh-skill'
import { AgentTeamError } from '../domain/errors.js'
import { mcpServerFromToolName } from '../domain/mcp.js'
import type { AssistantTemplate, TeamAggregate, TeamConversation, TeamMemberSlot } from '../domain/types.js'
import type { AgentTeamService } from '../service/agent-team-service.js'
import type { TeamCommandHandler } from './team-command-handler.js'
import type { TeamInteractionBridge } from './team-interaction-bridge.js'
import { memberPrompt, rosterPrompt } from './team-prompts.js'
import { registerTeamTools } from './team-tools.js'
import type { TeamWorkspace } from '../domain/team-selectors.js'
import type { RuleDocumentContent } from './rule-documents.js'
import { identifyMemberAsSubagent } from './member-descriptor.js'
import { registerScopedSkillProvider } from './scoped-skills.js'

/** What a member's Agent is given when it is brought online. */
export interface MemberSetupArgs {
  team: TeamAggregate
  conversation: TeamConversation
  member: TeamMemberSlot
  assistant: AssistantTemplate
  modelSelection: ModelSelectionRef
  workspace: TeamWorkspace
}

/** The runtime pieces the setup needs, passed rather than reached for. */
export interface MemberSetupDeps {
  ctx: Context
  service: AgentTeamService
  interactions: TeamInteractionBridge
  commands: TeamCommandHandler
  rulesFor: (member: TeamMemberSlot) => RuleDocumentContent[]
  assertToolIdentity: (agent: Agent | undefined, teamId: string, conversationId: string, slotId: string) => void
}

/**
 * Prepare the Agent a member runs as.
 *
 * This is where a member's whole configuration lands: the preset it mounts,
 * the two prompt sections the runtime owns and checks for afterwards, the team
 * tools bound to its own identity, the MCP and Skill guards that keep it to
 * what its assistant selected, and the permission it runs under. None of that
 * is team lifecycle, which is why it lives apart from the runtime that calls
 * it.
 */
export function memberAgentSetup(
  deps: MemberSetupDeps,
  args: MemberSetupArgs,
): (agentCtx: Context, agent: Agent) => Promise<void> {
  const { member, team, conversation, assistant, modelSelection, workspace } = args
  const conversationId = conversation.id
  const identitySection = `agent-team:identity:${member.id}`
  const rosterSection = `agent-team:roster:${team.id}`
  return async (agentCtx, agent) => {
    deps.interactions.attach(agentCtx, agent)
    // The Harness counts this child as one of the Session's subagents from
    // its header alone; without the matching durable identity its subagent
    // switcher waits forever for a catalog entry that never arrives.
    identifyMemberAsSubagent(agent, member.displayName)
    await deps.ctx.agentPresets.mount(agentCtx, assistant.agentPresetId)
    installModelSelection(agentCtx, modelSelection)
    agentCtx.systemPrompt.section({
      name: identitySection,
      order: 10,
      text: () => {
        const latest = deps.service.getTeam(team.id)
        const latestMember = latest.members[member.id]
        return latestMember === undefined
          ? 'This team membership is no longer active.'
          : memberPrompt(
              latest,
              latestMember,
              deps.service.assistantForMember(latestMember).instructions,
              deps.rulesFor(latestMember),
            )
      },
    })
    agentCtx.systemPrompt.section({
      name: rosterSection,
      order: 11,
      text: () => rosterPrompt(deps.service.getTeam(team.id)),
    })
    registerTeamTools(agentCtx, {
      assertIdentity: agent => { deps.assertToolIdentity(agent, team.id, conversationId, member.id) },
      getTaskBoard: () => {
        const latest = deps.service.getTeam(team.id)
        const tasks = Object.values(latest.tasks)
          .filter(task => task.conversationId === conversationId)
          .map(task => JSON.parse(JSON.stringify(task)) as Record<string, string | number | string[]>)
        return { teamId: latest.id, revision: latest.revision, tasks }
      },
      createTask: input => deps.commands.createTask(team.id, conversationId, member.id, input),
      updateTask: input => deps.commands.updateTask(team.id, conversationId, member.id, input),
      sendMessage: (recipientSlotId, content, type, taskId) => (
        deps.commands.sendMemberMessage(
          team.id,
          conversationId,
          member.id,
          recipientSlotId,
          content,
          type,
          taskId,
        )
      ),
    })
    const selectedMcpServers = new Set(assistant.mcpServers)
    const mcpTools = agentCtx.tools.schemas(agent).flatMap(tool => {
      const serverName = mcpServerFromToolName(tool.name)
      return serverName === undefined ? [] : [{ name: tool.name, serverName }]
    })
    const availableMcpServers = new Set(mcpTools.map(tool => tool.serverName))
    const missingMcpServers = [...selectedMcpServers]
      .filter(serverName => !availableMcpServers.has(serverName))
    if (missingMcpServers.length > 0) {
      throw new AgentTeamError(
        'MCP_REFERENCE_INVALID',
        `Member '${member.displayName}' cannot access selected MCP Server(s): ${missingMcpServers.join(', ')}`,
        { memberId: member.id, missing: missingMcpServers },
      )
    }
    const deniedMcpTools = mcpTools
      .filter(tool => !selectedMcpServers.has(tool.serverName))
      .map(tool => tool.name)
    if (deniedMcpTools.length > 0) agentCtx.tools.restrict({ deny: deniedMcpTools })
    agentCtx.tools.guard(execution => {
      const serverName = mcpServerFromToolName(execution.name)
      return serverName === undefined || selectedMcpServers.has(serverName)
        ? undefined
        : 'This MCP Server is not selected for the assistant.'
    })
    const selectedSkills = new Set(assistant.skillAllowlist)
    const skills = await deps.ctx.skills.list({
      cwd: workspace.path,
      scope: agent,
    })
    const available = new Set(skills
      .filter(skill => isModelInvocable(skill) || isUserInvocable(skill))
      .map(skill => skill.name))
    const missing = [...selectedSkills].filter(name => !available.has(name))
    if (missing.length > 0) {
      throw new AgentTeamError(
        'SKILL_REFERENCE_INVALID',
        `Member '${member.displayName}' cannot access selected Skill(s): ${missing.join(', ')}`,
        { memberId: member.id, missing },
      )
    }
    if (selectedSkills.size > 0 && agentCtx.tools.get('skill', agent) === undefined) {
      throw new AgentTeamError(
        'SKILL_REFERENCE_INVALID',
        `Member '${member.displayName}' selected Skills, but its Agent Preset does not expose the skill loader`,
        { memberId: member.id },
      )
    }
    const presetScope = await deps.ctx.agentPresets.standingKeyFor(
      assistant.agentPresetId,
    )
    const skillSelectionProvider = `agent-team-selection-${member.id}`
    await registerScopedSkillProvider(agentCtx, () => ({
      name: skillSelectionProvider,
      list: async options => {
        const inherited = await deps.ctx.skills.list({
          cwd: options.cwd,
          signal: options.signal,
          scope: presetScope,
        })
        return inherited.filter(skill => !selectedSkills.has(skill.name)).map(skill => ({
          name: skill.name,
          description: skill.description,
          invocation: { modelInvocable: false, userInvocable: false },
          source: 'runtime',
          provider: skillSelectionProvider,
          rank: 0,
          locator: skill.name,
        }))
      },
      get: async candidate => ({
        name: candidate.name,
        description: candidate.description,
        invocation: { modelInvocable: false, userInvocable: false },
        source: 'runtime',
        provider: skillSelectionProvider,
        content: '',
      }),
    }))
    agentCtx.tools.guard(execution => {
      if (execution.name !== 'skill') return undefined
      const name = skillNameFromArguments(execution.arguments)
      return name !== undefined && selectedSkills.has(name)
        ? undefined
        : 'This Skill is not selected for the assistant.'
    })
    // The composition owns the permission: a member carries no settings of
    // its own, so a team cannot start on a value its assistant no longer
    // describes.
    const settings = deps.service.assistantSettingsFor(member)
    deps.ctx.permissionPresets.set(
      agent.session,
      settings?.permissionPresetId ?? member.permissionPresetId,
    )
    const assembly = await agentCtx.systemPrompt.assemble(assembleContextFor(agent))
    const names = new Set(assembly.sections.map(section => section.name))
    if (!names.has(identitySection) || !names.has(rosterSection)) {
      throw new AgentTeamError(
        'PRESET_PROMPT_INCOMPATIBLE',
        `Preset '${assistant.agentPresetId}' replaced dsh-squad prompt sections`,
      )
    }
  }
}

/** The Skill name a `skill` tool call asked for, when it named one. */
function skillNameFromArguments(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('name' in value)) return undefined
  return typeof (value as { name?: unknown }).name === 'string' ? (value as { name: string }).name : undefined
}
