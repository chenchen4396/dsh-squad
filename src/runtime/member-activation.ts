import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AgentTeamError } from '../domain/errors.js'
import type {
  TeamAggregate,
  TeamConversation,
  TeamMemberSlot,
} from '../domain/types.js'
import { conversationWorkspace, type TeamWorkspace } from '../domain/team-selectors.js'
import { randomUUID } from 'node:crypto'
import type { AgentTeamService } from '../service/agent-team-service.js'
import type { Config } from '../config.js'
import type { MemberRegistry } from './member-registry.js'
import type { OperationQueue } from './operation-queue.js'
import type { RuleDocumentContent } from './rule-documents.js'
import type { TeamCommandHandler } from './team-command-handler.js'
import type { TeamInteractionBridge } from './team-interaction-bridge.js'
import type { TeamMessageDispatcher } from './team-message-dispatcher.js'
import { createSystemTeamMessage as systemTeamMessage } from './team-messages.js'
import { identifyMemberAsSubagent } from './member-descriptor.js'
import { memberAgentSetup } from './member-context.js'
import { LiveStreamBuffer } from './live-stream-buffer.js'

/**
 * Bringing a team online: the conversation, and every member in it.
 *
 * This is where a member stops being a row in the store and becomes an Agent —
 * resolving its assistant, checking the model exists, mounting the preset,
 * installing the composition from `member-context`, and recording the handle so
 * the rest of the runtime can reach it. It is also where a second Session for
 * the same member is refused, because two Agents for one slot is the one state
 * nothing here can recover from.
 */

/** What bringing a team online needs from the runtime that owns it. */
export interface ActivationDeps {
  ctx: Context
  config: Config
  service: AgentTeamService
  members: MemberRegistry
  interactions: TeamInteractionBridge
  commands: TeamCommandHandler
  messages: TeamMessageDispatcher
  operations: OperationQueue
  /** A member's Agent changed state, so the record follows. */
  setMemberRuntimeState: (teamId: string, slotId: string, state: 'idle' | 'running') => Promise<void>
  /** Session ids the store has seen, so a resume is not attempted blindly. */
  storedSessionIds: () => Promise<Set<string>>
  /** Refuse a tool call that is not this member's to make. */
  assertToolIdentity: (
    agent: Agent | undefined,
    teamId: string,
    conversationId: string,
    slotId: string,
  ) => void
  /** The rule documents one member loads. */
  rulesFor: (member: TeamMemberSlot) => RuleDocumentContent[]
}

/**
 * Bring one conversation's member Sessions online. Other conversations keep
 * whatever Session state they already had, so several conversations can run
 * concurrently without interrupting each other.
 */
export async function ensureConversationOnline(deps: ActivationDeps, teamId: string, conversationId: string): Promise<void> {
  const team = deps.service.getTeam(teamId)
  const conversation = deps.service.getConversation(teamId, conversationId)
  // Only members that are supposed to be running and are not on yet need
  // starting. Nothing to start means nothing to open, and a draft team must
  // stay dormant when its 团队 view is touched.
  // The Leader is the Session's own Agent, so it is never one of the member
  // Sessions this brings online.
  const starting = Object.values(team.members).filter(member => {
    if (member.id === team.leaderSlotId) return false
    if (member.desiredState !== 'online') return false
    const sessionId = conversation.memberSessions[member.id]
    return sessionId === undefined || !deps.members.has(sessionId)
  })
  if (starting.length === 0) return
  // Members are subagents of the Session's own Agent, so that Agent has to be
  // live: it is the parent the Harness records for every child Session.
  const leader = requireLeaderAgent(deps, conversation)
  const target = conversationWorkspace(team, conversation)
  if (target === undefined) {
    throw new AgentTeamError(
      'WORKSPACE_UNAVAILABLE',
      `Session '${conversation.sessionId ?? conversation.id}' has no Workspace`,
    )
  }
  const workspace = deps.ctx.workspaceRegistry.get(WorkspaceId(target.id))
  if (workspace === undefined || await workspace.status() !== 'ok' || workspace.path !== target.path) {
    throw new AgentTeamError('WORKSPACE_UNAVAILABLE', `Workspace '${target.id}' is unavailable or changed`)
  }
  // Assign a Session id to every member that does not have one yet, then
  // activate; ids are persisted before any Agent is created so a crash
  // mid-activation cannot orphan a Session.
  const pending: Record<string, string> = {}
  for (const member of Object.values(team.members)) {
    if (member.id === team.leaderSlotId) continue
    if (member.desiredState !== 'online') continue
    if (conversation.memberSessions[member.id] !== undefined) continue
    pending[member.id] = `agent-team:${randomUUID()}`
  }
  const assigned = Object.keys(pending).length === 0
    ? conversation
    : await deps.service.assignMemberSessions(teamId, conversationId, pending)
  const materialized = await deps.storedSessionIds()
  await mapConcurrent(Object.values(team.members), deps.config.runtimeConcurrency, async member => {
    if (member.id === team.leaderSlotId) return
    if (member.desiredState !== 'online') return
    const sessionId = assigned.memberSessions[member.id]
    if (sessionId === undefined) return
    await ensureMemberOnline(deps, team, member, conversation, sessionId, materialized, target, leader)
  })
  // Members are online, so whatever made the team 'error' — a startup
  // recovery that lost a session race, say — is over. Keeping the stale
  // state would keep refusing every later message.
  const online = deps.service.getTeam(teamId)
  if (online.state === 'error') {
    await deps.service.updateRuntimeTeam(
      teamId,
      current => ({ ...current, state: 'active' }),
      'team.recovered',
      `Team ${online.name} recovered by opening a conversation`,
    )
  }
}

export function activateMember(deps: ActivationDeps, teamId: string, slotId: string): Promise<TeamAggregate> {
  return deps.operations.run(teamId, async () => {
    const team = deps.service.getTeam(teamId)
    const member = team.members[slotId]
    if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    const conversations = deps.service.listConversations(teamId).items
    for (const conversation of conversations) {
      await ensureConversationOnline(deps, teamId, conversation.id)
    }
    const first = conversations[0]
    if (first !== undefined) {
      const current = deps.service.getTeam(teamId)
      const readyMember = current.members[slotId]
      if (readyMember === undefined) {
        throw new AgentTeamError('MEMBER_NOT_FOUND', `Member '${slotId}' disappeared during activation`)
      }
      const notice = systemTeamMessage({
        team: current,
        conversationId: first.id,
        recipientSlotId: current.leaderSlotId,
        content: [
          `新成员「${readyMember.displayName}」已加入团队。`,
          `成员 ID：${readyMember.id}`,
          `模型：${deps.service.assistantForMember(readyMember).provider} / ${deps.service.assistantForMember(readyMember).model}`,
          '状态：已就绪，可以分配任务。',
        ].join('\n'),
      })
      await deps.service.updateRuntimeTeam(
        teamId,
        latest => ({ ...latest, outbox: { ...latest.outbox, [notice.id]: notice } }),
        'team.member_ready',
        `Member ${readyMember.displayName} is ready`,
      )
      await deps.messages.deliver(teamId, notice.id)
    }
    return deps.service.getTeam(teamId)
  })
}

export function freshMemberContext(deps: ActivationDeps, teamId: string, conversationId: string, slotId: string): Promise<void> {
  return deps.operations.run(teamId, async () => {
    const team = deps.service.getTeam(teamId)
    const member = team.members[slotId]
    if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    if (slotId === team.leaderSlotId) return
    let conversation = deps.service.getConversation(teamId, conversationId)
    const previous = conversation.memberSessions[slotId]
    if (previous !== undefined) {
      await deps.service.forgetMemberSessions(teamId, slotId)
      conversation = await deps.service.assignMemberSessions(teamId, conversationId, {
        [slotId]: `agent-team:${randomUUID()}`,
      })
      const active = deps.members.agentOf(previous)
      if (active !== undefined) {
        deps.members.detach(previous)
        await active.handle.dispose().catch(() => undefined)
      }
    }
    await ensureConversationOnline(deps, teamId, conversation.id)
  })
}

export function leaderAgent(deps: ActivationDeps, conversation: TeamConversation): Agent | undefined {
  const sessionId = conversation.sessionId
  return sessionId === undefined ? undefined : deps.ctx.agents.get(SessionId(sessionId))
}

/**
 * The Harness Session Agent that leads one conversation. Members are its
 * subagents, so it must be live before they can be created.
 */
export function requireLeaderAgent(deps: ActivationDeps, conversation: TeamConversation): Agent {
  const sessionId = conversation.sessionId
  const agent = sessionId === undefined ? undefined : deps.ctx.agents.get(SessionId(sessionId))
  if (agent === undefined) {
    throw new AgentTeamError(
      'SESSION_UNAVAILABLE',
      '该团队所在的会话尚未打开，请先打开该会话再继续',
    )
  }
  return agent
}

/**
 * A team in `error` is recoverable, not unusable: the send paths open its
 * conversation again and lift it back to `active`. Every other state
 * (draft, starting, deleting) really cannot take a message yet, and says so.
 */
export function requireSendableTeam(deps: ActivationDeps, teamId: string): TeamAggregate {
  const team = deps.service.getTeam(teamId)
  if (team.state !== 'active' && team.state !== 'error') {
    throw new AgentTeamError(
      'TEAM_NOT_ACTIVE',
      `Team '${team.name}' cannot take messages while it is '${team.state}'`,
    )
  }
  return team
}

/**
 * Fail with an actionable message before creating an Agent whose model this
 * deployment cannot route.
 *
 * Without this the failure surfaces from the LLM layer as
 * `no adapter registered for provider "x"`, which names neither the member nor
 * the assistant to fix.
 */
export async function assertModelAvailable(
  deps: ActivationDeps,
  member: TeamMemberSlot,
  provider: string,
  model: string,
): Promise<void> {
  const registered = new Set(deps.ctx.llm.listProviders().map(info => info.id))
  if (!registered.has(provider)) {
    throw new AgentTeamError(
      'MODEL_REFERENCE_INVALID',
      `成员「${member.displayName}」的模型 provider「${provider}」在当前环境中未注册，`
      + `请在助手库中改用可用的 provider（当前可用：${[...registered].join('、') || '无'}）`,
      { memberId: member.id, provider, model, registeredProviders: [...registered] },
    )
  }
  try {
    await deps.ctx.llm.resolveModelInfo(provider, model)
  } catch (error) {
    throw new AgentTeamError(
      'MODEL_REFERENCE_INVALID',
      `成员「${member.displayName}」的模型「${provider}/${model}」无法解析，请检查助手配置`,
      { memberId: member.id, provider, model },
      { cause: error },
    )
  }
}

async function ensureMemberOnline(
  deps: ActivationDeps,
  team: TeamAggregate,
  member: TeamMemberSlot,
  conversation: TeamConversation,
  sessionIdValue: string,
  materialized: Set<string>,
  workspace: TeamWorkspace,
  leader: Agent,
): Promise<void> {
  const prior = deps.members.agentOf(sessionIdValue)
  if (prior !== undefined) {
    // A member that is already live still gets the identity record: catalogs
    // read the log, and one written before this release has none.
    identifyMemberAsSubagent(prior.handle.agent, member.displayName)
    return
  }
  const sessionId = SessionId(sessionIdValue)
  const live = deps.ctx.agents.get(sessionId)
  if (live !== undefined) {
    await deps.service.updateRuntimeTeam(
      team.id,
      current => ({ ...current, state: 'ownership_conflict' }),
      'team.ownership_conflict',
      `Session ${sessionIdValue} is live but not owned by dsh-squad`,
    )
    throw new AgentTeamError(
      'AGENT_HANDLE_OWNERSHIP_CONFLICT',
      `Session '${sessionIdValue}' is live without this plugin's AgentHandle`,
    )
  }
  const conversationId = conversation.id

  // Resolve the member's assistant once per activation. Members inherit the
  // template live, so this is the configuration that takes effect now; the
  // next activation picks up whatever the template says then.
  const assistant = deps.service.assistantForMember(member)
  await assertModelAvailable(deps, member, assistant.provider, assistant.model)

  try {
    deps.members.beginActivation(sessionIdValue, { teamId: team.id, conversationId, slotId: member.id })
    const modelSelection: ModelSelectionRef = {
      current: {
        provider: assistant.provider,
        model: assistant.model,
        ...(member.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(member.reasoningEffort) }),
      },
      assembled: undefined,
    }
    const setup = memberAgentSetup(
      {
        ctx: deps.ctx,
        service: deps.service,
        interactions: deps.interactions,
        commands: deps.commands,
        rulesFor: (target: TeamMemberSlot) => deps.rulesFor(target),
        assertToolIdentity: (agent: Agent | undefined, teamId: string, convId: string, slotId: string) => {
          deps.assertToolIdentity(agent, teamId, convId, slotId)
        },
      },
      { team, conversation, member, assistant, modelSelection, workspace },
    )
    const agentOptions = {
      provider: assistant.provider,
      model: assistant.model,
    }
    // The member is a subagent of the Session's own Agent: `parentAgent` is
    // the runtime owner and the child session's durable lineage names that
    // Session, which is what keeps the member out of the Harness sidebar.
    const childMeta = {
      cwd: workspace.path,
      parentSession: SessionId(conversation.sessionId ?? ''),
      origin: 'subagent' as const,
      delegationDepth: (leader.session.header.delegationDepth ?? 0) + 1,
      agentPreset: assistant.agentPresetId,
    }
    const handle = materialized.has(sessionIdValue)
      ? await deps.ctx.agents.resume({ resumeSessionId: sessionId, parentAgent: leader, agentOptions, setup })
      : await deps.ctx.agents.create({
        sessionId,
        parentAgent: leader,
        meta: childMeta,
        agentOptions,
        setup,
      })
    deps.members.attach(sessionIdValue, {
      teamId: team.id,
      conversationId,
      slotId: member.id,
      handle,
      modelSelection,
    })
    deps.members.endActivation(sessionIdValue)
    await deps.setMemberRuntimeState(team.id, member.id, handle.agent.status)
  } catch (error) {
    deps.members.endActivation(sessionIdValue)
    const causeMessage = error instanceof Error ? error.message : String(error)
    deps.ctx.logger.warn(
      `agent-team: member '${member.displayName}' activation failed: ${causeMessage}`,
      error,
    )
    throw error instanceof AgentTeamError
      ? error
      : new AgentTeamError(
        'SESSION_CREATE_FAILED',
        `成员“${member.displayName}”启动失败：${causeMessage}${sessionBusyHint(error)}`,
        { memberId: member.id, cause: causeMessage },
        { cause: error },
      )
  }
}

/**
 * Session write ownership is a cross-process lock, so a member that cannot
 * start because some other DSH process still holds its Session is the one
 * activation failure the user can actually do something about.
 */
function sessionBusyHint(error: unknown): string {
  return error instanceof Error && error.name === 'SessionAlreadyOwnedError'
    ? '（该成员的 Session 正被另一个 DSH 进程占用，请关掉重复实例后重试）'
    : ''
}

export async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++
      await run(values[index]!)
    }
  })
  await Promise.all(workers)
}