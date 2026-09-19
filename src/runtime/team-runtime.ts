import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  assembleContextFor,
  installModelSelection,
  type Agent,
  type AgentHandle,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { isModelInvocable, isUserInvocable } from '@deepseek-ai/dsh-skill'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Config } from '../config.js'
import { AgentTeamError } from '../domain/errors.js'
import { LiveStreamBuffer } from './live-stream-buffer.js'
import { decideLeaderAnswer } from './leader-answer.js'
import { memberAgentSetup } from './member-context.js'
import { HandoffRelay } from './handoff-relay.js'
import * as leaderAttachment from './leader-attachment.js'
import { mapConcurrent } from './member-activation.js'
import * as memberActivation from './member-activation.js'
import * as teamRoom from './team-room.js'
import { subscribeRuntimeEvents } from './runtime-events.js'
import { installCompositionSections, teamComposition } from './team-composition.js'
import { MemberRegistry } from './member-registry.js'
import { OperationQueue } from './operation-queue.js'
import { PublishCoalescer } from './publish-coalescer.js'
import {
  conversationWorkspace,
  mentionedSlotIds,
  orderedMembers,
  taskAssigneeIds,
} from '../domain/team-selectors.js'
import type { TeamWorkspace } from '../domain/team-selectors.js'
import { mcpServerFromToolName } from '../domain/mcp.js'
import type {
  AssistantTemplate,
  TeamAggregate,
  TeamConversation,
  TeamMemberSlot,
  TeamMessage,
} from '../domain/types.js'
import type { AgentTeamService } from '../service/agent-team-service.js'
import type {
  InteractionResponseInput,
  MemberConversationView,
  RoomView,
  TeamWorkbenchView,
} from '../transport/contracts.js'
import {
  CONVERSATION_PAGE_SIZE,
  projectContextUsage,
  projectConversation,
  textOfContent,
} from './conversation-projector.js'
import { projectRoom } from './room-projector.js'
import { readStoredEvents } from './session-events.js'
import { registerScopedSkillProvider } from './scoped-skills.js'
import { TeamCommandHandler } from './team-command-handler.js'
import { LEADER_ANSWER_TIMEOUT_MS, TeamInteractionBridge } from './team-interaction-bridge.js'
import { TeamMessageDispatcher } from './team-message-dispatcher.js'
import {
  createSystemTeamMessage as systemTeamMessage,
  createTeamMessage as teamMessage,
  memberRequestContent,
  requireMessageContent as requireContent,
} from './team-messages.js'
import type { RuleDocumentContent } from './rule-documents.js'
import { identifyMemberAsSubagent } from './member-descriptor.js'
import { sandboxModeOf, withinLeaderAuthority } from './sandbox-authority.js'
import { registerTeamTools } from './team-tools.js'

interface OwnedAgent {
  teamId: string
  conversationId: string
  slotId: string
  handle: AgentHandle
  modelSelection: ModelSelectionRef
}

/**
 * How often a member's hand-off to the Leader is retried before the request is
 * refused. The Host is one event loop shared with every member's run, so a
 * single failure is usually transient and worth another try.
 */

/**
 * The team composition installed on a Harness Session's own Agent.
 *
 * That Agent is the team Leader, so the team owns no Session for it: the
 * sections, tools and interaction handler live on the Agent's scope and are
 * removed through `dispose` when the team is disabled or dissolved.
 */
interface LeaderAttachment {
  teamId: string
  conversationId: string
  slotId: string
  dispose: () => void
}

export class TeamRuntime {
  private readonly members = new MemberRegistry()
  /** Team composition installed on a Session Agent, keyed by that session id. */
  private readonly operations = new OperationQueue()
  /** Handing a member's requests to the Leader, and settling what it cannot. */
  private readonly handoffRelay: HandoffRelay
  /** Every event subscription this runtime holds, removed together. */
  private subscriptions: () => void = () => {}
  private readonly conversationPublishes = new PublishCoalescer()
  /** Transient live assistant output per member session, keyed by session id. */
  private readonly liveStreams = new LiveStreamBuffer()
  /** Member requests already handed to the Leader, so each is announced once. */
  /**
   * Workspace rule text per team, refreshed when a member's selection changes.
   * Prompt sections resolve synchronously, so the file reads happen here.
   */
  private readonly messages: TeamMessageDispatcher
  private readonly commands: TeamCommandHandler
  private readonly interactions: TeamInteractionBridge
  private closing = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly service: AgentTeamService,
    private readonly handoff: { attempts?: number; retryMs?: number; answerWindowMs?: number } = {},
  ) {
    this.messages = new TeamMessageDispatcher(service, {
      resolveAgent: (teamId, conversationId, slotId) => (
        this.resolveOnlineAgent(teamId, conversationId, slotId)
      ),
      warn: (message, error) => { ctx.logger.warn(message, error) },
    })
    this.commands = new TeamCommandHandler(service, {
      deliverMessage: (teamId, messageId) => this.messages.deliver(teamId, messageId),
      followup: (teamId, conversationId, slotId, message) => {
        this.requireAgentIn(this.service.getConversation(teamId, conversationId), slotId)
          .followup(message)
      },
      freshContext: (teamId, conversationId, slotId) =>
        this.freshMemberContext(teamId, conversationId, slotId),
    })
    this.interactions = new TeamInteractionBridge(ctx, {
      // Members are this plugin's to answer. The Leader is the Session's own
      // Agent, so the reader is its counterpart and answers its questions and
      // approvals through the Harness interface — unless «替我审批» is on for
      // that binding, which leaves nobody to ask and answers them here.
      acceptsSession: sessionId => this.members.has(sessionId) || this.delegatesInteractions(sessionId),
      autoAnswer: sessionId => !this.members.has(sessionId) && this.delegatesInteractions(sessionId),
      onChange: sessionId => {
        // Handing the request to the Leader is what stops a member from waiting
        // forever, so it goes first: publishing the conversation view is only
        // cosmetic, and a failure there must never swallow the hand-off. Each
        // step also contains its own failure for the same reason.
        try {
          this.handoffRelay.relay(sessionId)
        } catch (error) {
          ctx.logger.warn('agent-team: handing a member request to the Leader failed', error)
        }
        try {
          this.publishOwnedConversation(sessionId)
        } catch (error) {
          ctx.logger.warn('agent-team: failed to publish interaction update', error)
        }
      },
    })
    this.handoffRelay = new HandoffRelay({
      ctx,
      service,
      commands: this.commands,
      interactions: this.interactions,
      members: this.members,
      resolveAgent: (conversation, slotId) => this.resolveAgentIn(conversation, slotId),
      options: this.handoff,
    })
    this.subscriptions = subscribeRuntimeEvents(ctx, {
      members: this.members,
      conversationPublishes: this.conversationPublishes,
      liveStreams: this.liveStreams,
      warn: (message, error) => { ctx.logger.warn(message, error) },
      attachLeaderForSession: sessionId => this.attachLeaderForSession(sessionId),
      observeUserMessage: (sessionId, event) => this.observeUserMessage(sessionId, event),
      setMemberRuntimeState: (teamId, slotId, state) => this.setMemberRuntimeState(teamId, slotId, state),
      publishOwnedConversation: sessionId => this.publishOwnedConversation(sessionId),
    })
  }

  interactionBridge(): TeamInteractionBridge {
    return this.interactions
  }

  // ── The room and its messages ───────────────────────────────────────────
  // These belong to `team-room`; the runtime hands each call on, and supplies
  // its own lookups through `host`.

  async getWorkbench(teamId: string, conversationId: string): Promise<TeamWorkbenchView> {
    return await teamRoom.getWorkbench(this.roomDeps(), teamId, conversationId)
  }

  async getRoom(
    teamId: string,
    conversationId: string,
    beforeTime?: number,
  ): Promise<RoomView> {
    return await teamRoom.getRoom(this.roomDeps(), teamId, conversationId, beforeTime)
  }

  async getOlderMemberConversation(
    teamId: string,
    conversationId: string,
    slotId: string,
    beforeSeq: number,
  ): Promise<MemberConversationView> {
    return await teamRoom.getOlderMemberConversation(
      this.roomDeps(), teamId, conversationId, slotId, beforeSeq,
    )
  }

  async sendRoomMessage(
    teamId: string,
    rawContent: string,
    conversationId: string,
    mentions: readonly string[] = [],
  ): Promise<TeamMessage> {
    return await teamRoom.sendRoomMessage(this.roomDeps(), teamId, rawContent, conversationId, mentions)
  }

  async sendUserMessage(
    teamId: string,
    rawContent: string,
    conversationId: string,
    targetSlotId?: string,
  ): Promise<TeamMessage> {
    return await teamRoom.sendUserMessage(
      this.roomDeps(), teamId, rawContent, conversationId, targetSlotId,
    )
  }

  private observeUserMessage(sessionId: string, event: SessionEvent): void {
    teamRoom.observeUserMessage(this.roomDeps(), sessionId, event)
  }

  private publishOwnedConversation(sessionId: string): void {
    teamRoom.publishOwnedConversation(this.roomDeps(), sessionId)
  }

  private projectMemberConversation(
    team: TeamAggregate,
    member: TeamMemberSlot,
    conversation: TeamConversation,
    events: readonly SessionEvent[],
    beforeSeq?: number,
  ): MemberConversationView {
    return teamRoom.projectMemberConversation(
      this.roomDeps(), team, member, conversation, events, beforeSeq,
    )
  }

  private memberSessionId(conversation: TeamConversation, slotId: string): string | undefined {
    return teamRoom.memberSessionId(this.roomDeps(), conversation, slotId)
  }

  private async storedSessionIds(): Promise<Set<string>> {
    return await teamRoom.storedSessionIds(this.roomDeps())
  }

  private async memberEvents(
    conversation: TeamConversation,
    slotId: string,
    stored?: Set<string>,
  ): Promise<readonly SessionEvent[]> {
    return await teamRoom.memberEvents(this.roomDeps(), conversation, slotId, stored)
  }

  private memberStatus(
    sessionId: string | undefined,
    lastRuntimeState: TeamMemberSlot['lastRuntimeState'],
  ): MemberConversationView['status'] {
    return teamRoom.memberStatus(this.roomDeps(), sessionId, lastRuntimeState)
  }

  /** One conversation, looked up by the ids the caller already has. */
  private requireConversation(teamId: string, conversationId: string): TeamConversation {
    return this.service.getConversation(teamId, conversationId)
  }

  /** What `team-room` needs from this runtime, gathered in one place. */
  private roomDeps(): teamRoom.RoomDeps {
    return {
      ctx: this.ctx,
      service: this.service,
      members: this.members,
      interactions: this.interactions,
      liveStreams: this.liveStreams,
      operations: this.operations,
      host: {
        requireConversation: (teamId, conversationId) => this.requireConversation(teamId, conversationId),
        resolveAgentIn: (conversation, slotId) => this.resolveAgentIn(conversation, slotId),
        requireAgentIn: (conversation, slotId) => this.requireAgentIn(conversation, slotId),
        ensureConversationOnline: (teamId, conversationId) =>
          this.ensureConversationOnline(teamId, conversationId),
        requireSendableTeam: teamId => this.requireSendableTeam(teamId),
        leaderAgent: conversation => this.leaderAgent(conversation),
      },
    }
  }

  // ── Team lifecycle ──────────────────────────────────────────────────────
  bindSession(sessionId: string, teamId: string): Promise<TeamConversation> {
    return this.operations.run(teamId, async () => {
      const team = this.service.getTeam(teamId)
      const existing = this.service.findConversationBySession(sessionId)
      if (existing !== undefined && existing.teamId !== teamId) {
        throw new AgentTeamError(
          'SESSION_ALREADY_BOUND',
          '该会话已启用另一个团队，请先在「团队」里停用后再启用',
        )
      }
      const agent = this.ctx.agents.get(SessionId(sessionId))
      if (agent === undefined) {
        throw new AgentTeamError('SESSION_UNAVAILABLE', '该会话尚未打开，请先打开会话再启用团队')
      }
      const cwd = agent.session.header.cwd
      if (cwd === undefined) {
        throw new AgentTeamError('WORKSPACE_UNAVAILABLE', '该会话没有工作目录，无法运行团队成员')
      }
      const workspace = this.ctx.workspaceRegistry.list().find(item => item.path === cwd)
      if (workspace === undefined) {
        throw new AgentTeamError('WORKSPACE_UNAVAILABLE', `会话目录「${cwd}」不在 Harness 工作区列表中`)
      }
      const conversation = existing ?? await this.service.createConversationRecord(teamId, {
        sessionId,
        workspaceId: String(workspace.id),
        workspacePath: cwd,
      })
      if (team.state === 'draft' || team.state === 'error') {
        await this.service.updateRuntimeTeam(
          teamId,
          current => ({
            ...current,
            state: 'active',
            members: mapMembers(current, member => ({ ...member, desiredState: 'online' })),
          }),
          'team.bound',
          `Team ${team.name} enabled in a session`,
        )
      }
      this.attachLeader(conversation)
      await this.ensureConversationOnline(teamId, conversation.id)
      return this.service.getConversation(teamId, conversation.id)
    })
  }

  /**
   * Move the Leader role onto another member.
   *
   * The new Leader is the Session's own Agent, so any subagent Session the
   * member had is released and the Leader composition is reinstalled under the
   * new slot; the previous Leader becomes an ordinary member and is started on
   * demand like every other one.
   */
  leaderChanged(teamId: string, nextLeaderSlotId: string): Promise<void> {
    return this.operations.run(teamId, async () => {
      for (const conversation of this.service.listConversations(teamId).items) {
        const sessionId = conversation.memberSessions[nextLeaderSlotId]
        const owned = sessionId === undefined ? undefined : this.members.agentOf(sessionId)
        if (owned !== undefined && sessionId !== undefined) {
          owned.handle.agent.cancel({ kind: 'user' }, { keepInbox: false })
          await owned.handle.agent.whenIdle()
          this.members.detach(sessionId)
          this.interactions.forget(sessionId)
          await owned.handle.dispose()
        }
        if (conversation.sessionId === undefined) continue
        this.detachLeader(conversation.sessionId)
        this.attachLeader(this.service.getConversation(teamId, conversation.id))
      }
      await this.service.forgetMemberSessions(teamId, nextLeaderSlotId)
    })
  }


  /** Disable the team enabled in one Harness Session and stop its members. */
  unbindSession(sessionId: string): Promise<void> {
    const conversation = this.service.findConversationBySession(sessionId)
    if (conversation === undefined) return Promise.resolve()
    return this.operations.run(conversation.teamId, async () => {
      this.detachLeader(sessionId)
      await this.stopConversationMembers(conversation)
      await this.service.deleteConversationRecord(conversation.teamId, conversation.id)
    })
  }

  /**
   * Turn «替我审批» on or off for one Session's binding.
   *
   * With it on, the Leader answers every interaction of that conversation —
   * its members' and its own — so the reader is never asked.
   */
  setSessionDelegation(sessionId: string, delegate: boolean): Promise<TeamConversation> {
    const conversation = this.service.findConversationBySession(sessionId)
    if (conversation === undefined) {
      return Promise.reject(new AgentTeamError('CONVERSATION_NOT_FOUND', '该会话尚未启用团队'))
    }
    return this.operations.run(conversation.teamId, async () => {
      const updated = await this.service.updateConversationRecord(conversation.id, current => ({
        ...current,
        delegateInteractions: delegate,
      }))
      this.publishOwnedConversation(sessionId)
      return updated
    })
  }

  /** Whether this Session's binding runs with «替我审批». */
  private delegatesInteractions(sessionId: string): boolean {
    return this.service.findConversationBySession(sessionId)?.delegateInteractions === true
  }

  /** Stop and release every member Agent of one conversation. */
  private async stopConversationMembers(conversation: TeamConversation): Promise<void> {
    const sessionIds = Object.values(conversation.memberSessions)
    const ownedEntries = sessionIds
      .map(sessionId => [sessionId, this.members.agentOf(sessionId)] as const)
      .filter((entry): entry is readonly [string, OwnedAgent] => entry[1] !== undefined)
    for (const [, entry] of ownedEntries) entry.handle.agent.cancel({ kind: 'user' }, { keepInbox: false })
    await Promise.all(ownedEntries.map(([, entry]) => entry.handle.agent.whenIdle()))
    for (const [sessionId, entry] of ownedEntries) {
      try {
        await this.ctx.sessions.flush(entry.handle.agent.session)
      } catch (error) {
        this.ctx.logger.warn(`agent-team: session flush failed for ${sessionId}`, error)
      }
      this.members.detach(sessionId)
      this.interactions.forget(sessionId)
      await entry.handle.dispose()
    }
  }


  async stopMember(teamId: string, slotId: string, conversationId: string): Promise<void> {
    const team = this.requireSendableTeam(teamId)
    const member = team.members[slotId]
    if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    const conversation = this.requireConversation(teamId, conversationId)
    const agent = this.requireAgentIn(conversation, slotId)
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    await this.setMemberRuntimeState(teamId, slotId, 'idle')
    const current = this.service.getTeam(teamId)
    const currentMember = current.members[slotId]
    if (currentMember !== undefined) {
      this.service.publishConversation(
        teamId,
        current.revision,
        this.projectMemberConversation(
          current,
          currentMember,
          conversation,
          agent.session.snapshotEvents(),
        ),
      )
    }
  }

  async respondToInteraction(
    teamId: string,
    slotId: string,
    interactionId: string,
    response: InteractionResponseInput,
    conversationId: string,
  ): Promise<void> {
    const team = this.service.getTeam(teamId)
    const member = team.members[slotId]
    if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    const conversation = this.requireConversation(teamId, conversationId)
    const sessionId = this.memberSessionId(conversation, slotId)
    if (sessionId === undefined) {
      throw new AgentTeamError('INTERACTION_NOT_FOUND', '该交互请求不属于指定的团队成员')
    }
    await this.interactions.respond(sessionId, interactionId, response)
  }

  /**
   * Follow an edited assistant onto the members running as it.
   *
   * Members inherit their assistant live, but a member whose permission was
   * edited directly no longer follows the template, and one that is already
   * running holds the sandbox it was created with — so the template's settings

  /**
   * Follow an edited assistant onto the members running as it.
   *
   * Members inherit their assistant live, but a member whose permission was
   * edited directly no longer follows the template, and one that is already
   * running holds the sandbox it was created with — so the template's settings
   * are pushed onto every running member that still follows it.
   *
   * @returns the teams whose members actually changed.
   */
  refreshAssistantSettings(assistant: AssistantTemplate): void {
    for (const owned of this.members.agents()) {
      const team = this.service.getTeam(owned.teamId)
      const member = team.members[owned.slotId]
      if (member === undefined || member.assistantId !== assistant.id) continue
      this.ctx.permissionPresets.set(owned.handle.agent.session, assistant.permissionPresetId)
      owned.modelSelection.current = {
        provider: assistant.provider,
        model: assistant.model,
        ...(assistant.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(assistant.reasoningEffort) }),
      }
    }
  }


  // ── What the view is shown ──────────────────────────────────────────────

  startTeam(teamId: string): Promise<TeamAggregate> {
    return this.operations.run(teamId, () => this.startTeamUnlocked(teamId))
  }

  /**
   * Give one member a Session with no history, replacing the one it had.
   *
   * The old Session is retired and its Agent disposed, so the next task cannot
   * reach even a cached context; the id is kept in `retiredSessions` so the
   * work that happened there stays accounted for. A member that never had a
   * Session here is simply brought online — there is nothing to forget.
   */
  // ── Bringing members online ─────────────────────────────────────────────

  /** What bringing a team online needs from this runtime. */
  private activationDeps(): memberActivation.ActivationDeps {
    return {
      ctx: this.ctx,
      config: this.config,
      service: this.service,
      members: this.members,
      interactions: this.interactions,
      commands: this.commands,
      messages: this.messages,
      operations: this.operations,
      setMemberRuntimeState: (teamId, slotId, status) => this.setMemberRuntimeState(teamId, slotId, status),
      storedSessionIds: () => this.storedSessionIds(),
      assertToolIdentity: (agent, teamId, conversationId, slotId) => {
        this.assertToolIdentity(agent, teamId, conversationId, slotId)
      },
      rulesFor: (target: TeamMemberSlot) => this.rulesFor(target),
    }
  }

  async activateMember(teamId: string, slotId: string): Promise<TeamAggregate> {
    return await memberActivation.activateMember(this.activationDeps(), teamId, slotId)
  }

  private async freshMemberContext(teamId: string, conversationId: string, slotId: string): Promise<void> {
    await memberActivation.freshMemberContext(this.activationDeps(), teamId, conversationId, slotId)
  }

  private async ensureConversationOnline(teamId: string, conversationId: string): Promise<void> {
    await memberActivation.ensureConversationOnline(this.activationDeps(), teamId, conversationId)
  }

  private leaderAgent(conversation: TeamConversation): Agent | undefined {
    return memberActivation.leaderAgent(this.activationDeps(), conversation)
  }

  private requireSendableTeam(teamId: string): TeamAggregate {
    return memberActivation.requireSendableTeam(this.activationDeps(), teamId)
  }


  removeMember(teamId: string, slotId: string): Promise<TeamAggregate> {
    return this.operations.run(teamId, async () => {
      const team = this.service.getTeam(teamId)
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
        this.service.listConversations(teamId).items
          .map(conversation => conversation.memberSessions[slotId])
          .filter((value): value is string => value !== undefined),
      )]
      for (const sessionId of sessionIds) {
        if (this.members.agentOf(sessionId) === undefined && this.ctx.agents.get(SessionId(sessionId)) !== undefined) {
          throw new AgentTeamError(
            'AGENT_HANDLE_OWNERSHIP_CONFLICT',
            `Session '${sessionId}' is live without this plugin's AgentHandle`,
          )
        }
      }
      for (const sessionId of sessionIds) {
        const owned = this.members.agentOf(sessionId)
        if (owned === undefined) continue
        owned.handle.agent.cancel({ kind: 'user' }, { keepInbox: false })
        await owned.handle.agent.whenIdle()
        await this.ctx.sessions.flush(owned.handle.agent.session)
        this.members.detach(sessionId)
        this.interactions.forget(sessionId)
        await owned.handle.dispose()
      }
      await this.service.forgetMemberSessions(teamId, slotId)
      const removedAt = new Date().toISOString()
      const target = this.service.listConversations(teamId).items[0]
      const notice = target === undefined
        ? undefined
        : systemTeamMessage({
          team,
          conversationId: target.id,
          recipientSlotId: team.leaderSlotId,
          content: `团队成员「${member.displayName}」（成员 ID：${member.id}）已被移出团队，其 Session 已停止并归档。后续任务请重新分配给其他成员。`,
        })
      await this.service.updateRuntimeTeam(
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
      if (notice !== undefined) await this.messages.deliver(teamId, notice.id)
      return this.service.getTeam(teamId)
    })
  }

  dissolveTeam(teamId: string): Promise<void> {
    return this.operations.run(teamId, async () => {
      let team = this.service.getTeam(teamId)
      const conversations = this.service.listConversations(teamId).items
      const sessionIds = [...new Set([
        ...conversations.flatMap(conversation => Object.values(conversation.memberSessions)),
        ...Object.keys(team.retiredSessions),
      ])]
      for (const conversation of conversations) {
        if (conversation.sessionId !== undefined) this.detachLeader(conversation.sessionId)
      }
      for (const sessionId of sessionIds) {
        if (this.members.agentOf(sessionId) === undefined && this.ctx.agents.get(SessionId(sessionId)) !== undefined) {
          throw new AgentTeamError(
            'AGENT_HANDLE_OWNERSHIP_CONFLICT',
            `Session '${sessionId}' is live without this plugin's AgentHandle`,
          )
        }
      }

      if (team.state !== 'deleting') {
        team = await this.service.updateRuntimeTeam(
          teamId,
          current => ({ ...current, state: 'deleting' }),
          'team.deleting',
          `Team ${team.name} dissolution started`,
        )
      }

      try {
        const ownedEntries = this.members.agentsInTeam(teamId)
        for (const [, entry] of ownedEntries) {
          entry.handle.agent.cancel({ kind: 'user' }, { keepInbox: false })
        }
        await Promise.all(ownedEntries.map(([, entry]) => entry.handle.agent.whenIdle()))

        for (const [sessionId, entry] of ownedEntries) {
          try {
            await this.ctx.sessions.flush(entry.handle.agent.session)
          } catch (error) {
            this.ctx.logger.warn(`agent-team: final session flush failed during dissolution for ${sessionId}`, error)
          }
          await entry.handle.dispose()
          this.members.detach(sessionId)
          this.interactions.forget(sessionId)
        }

        await this.service.deleteTeamRecords(teamId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        try {
          await this.service.updateRuntimeTeam(
            teamId,
            current => ({ ...current, state: 'delete_blocked' }),
            'team.delete_blocked',
            message,
          )
        } catch (updateError) {
          this.ctx.logger.warn(`agent-team: failed to persist blocked dissolution for ${teamId}`, updateError)
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


  /**
   * Startup recovery: drop records that predate the binding model, then make
   * every bound team usable again.
   *
   * No member Agent is created here. A team's Leader is a Harness Session's own
   * Agent, which the Harness materializes when the user opens that Session;
   * `agent/created` installs the team composition then, and members come online
   * the first time the Session's 团队 view is used.
   */
  async recoverTeams(): Promise<void> {
    await this.purgeLegacyTeams()
    // Members follow their assistants completely, so a team bound before that
    // rule is brought onto it now — its stored permission is what activation
    // would otherwise sandbox the member with.
    await this.service.followAssistants()
    const bound = this.service.listTeams().items.filter(team =>
      this.service.listConversations(team.id).items.some(item => item.sessionId !== undefined))
    await mapConcurrent(bound, this.config.runtimeConcurrency, async team => {
      try {
        await this.operations.run(team.id, async () => {
          await this.messages.recover(this.service.getTeam(team.id))
          if (team.state !== 'active') {
            await this.service.updateRuntimeTeam(
              team.id,
              current => ({ ...current, state: 'active' }),
              'team.recovered',
              `Team ${team.name} recovered after plugin startup`,
            )
          }
        })
      } catch (error) {
        this.ctx.logger.warn(`agent-team: failed to recover team ${team.id}`, error)
        await this.markTeamError(team.id, error)
      }
    })
  }

  /**
   * Teams stored before a team was enabled in a Session own their own member
   * Sessions, which the binding model has no way to map. Their records are
   * dropped so the domain stays openable; the user recreates the team.
   */
  private async purgeLegacyTeams(): Promise<void> {
    for (const team of this.service.listTeams().items) {
      if (isLegacyTeam(team)) {
        this.ctx.logger.warn(
          `agent-team: dropping team '${team.name}' (${team.id}); it predates per-session binding`,
        )
        await this.service.purgeTeamRecords(team.id)
        continue
      }
      // A conversation written before the binding model carries no Session and
      // can never be opened again, so it goes rather than confusing the UI.
      for (const conversation of this.service.listConversations(team.id).items) {
        if (conversation.sessionId !== undefined) continue
        await this.service.deleteConversationRecord(team.id, conversation.id)
      }
      const dropped = await this.service.dropRoomRelayEchoes(team.id)
      if (dropped > 0) {
        this.ctx.logger.warn(`agent-team: dropped ${dropped} duplicated room relay record(s)`)
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.operations.close()
    this.subscriptions()
    for (const sessionId of [...this.members.leaderIds()]) this.detachLeader(sessionId)
    await this.interactions.dispose()
    this.conversationPublishes.cancelAll()
    await this.operations.settled()
    const owned = [...this.members.agents()]
    for (const entry of owned) entry.handle.agent.cancel({ kind: 'disposed' }, { keepInbox: true })
    await Promise.allSettled(owned.map(entry => entry.handle.agent.whenIdle()))
    for (const entry of owned) {
      try {
        await this.ctx.sessions.flush(entry.handle.agent.session)
      } catch (error) {
        this.ctx.logger.warn(`agent-team: session flush failed for ${entry.handle.agent.id}`, error)
      }
    }
    await Promise.allSettled(owned.map(entry => entry.handle.dispose()))
    this.members.clear()
  }

  /**
   * Hand a member's request to the Leader.
   *
   * A member never talks to the reader: its question or sandbox escalation goes
   * to the Leader as a team message, and the Leader answers it with
   * `team_answer_member` — or decides the reader should hear about it and says
   * so in its own reply. Delivered once per request, so a member cannot flood
   * the Leader by asking repeatedly.
   *
   * A claimed request that never reaches the Leader hangs the member for good:
   * nothing else settles it, and the member keeps reporting `running`. Delivery
   * is therefore retried, and a request that still cannot be handed over is
   * refused with a reason the member can act on rather than left waiting.
   */

  /**
   * Deliver one hand-off, retrying the transient failures a busy Host produces.
   *
   * A delivery that keeps failing means the Leader cannot be reached at all, and
   * a member waiting on a request nobody will answer is worse than a refusal it
   * can react to — so the request is settled rather than left pending.
   */

  /**
   * Settle every request one Session is waiting on. Called when no answerer is
   * reachable at all, where leaving the request pending would block the member
   * for good; `reason` goes to the Host log so the cause stays diagnosable.
   */


  /**
   * Starting a team only validates it. A team has no Sessions of its own any
   * more: it becomes usable when it is enabled in a Harness Session, which is
   * where its Leader and members come from.
   */
  private async startTeamUnlocked(teamId: string): Promise<TeamAggregate> {
    const team = this.service.getTeam(teamId)
    if (team.state === 'active') return team
    if (team.state !== 'draft' && team.state !== 'error') {
      throw new AgentTeamError('TEAM_NOT_ACTIVE', `Cannot start team in state '${team.state}'`)
    }
    if (team.members[team.leaderSlotId] === undefined) {
      throw new AgentTeamError('INVALID_REQUEST', 'A team needs a leader before it can start')
    }
    return this.service.updateRuntimeTeam(
      teamId,
      current => ({
        ...current,
        state: 'active',
        members: mapMembers(current, member => ({ ...member, desiredState: 'online' })),
      }),
      'team.started',
      `Team ${team.name} started`,
    )
  }






  private assertToolIdentity(
    agent: Agent | undefined,
    teamId: string,
    conversationId: string,
    slotId: string,
  ): void {
    if (agent === undefined) throw new AgentTeamError('INVALID_REQUEST', 'Team tool requires an Agent caller')
    const identity = this.identityOf(String(agent.id))
    if (
      identity === undefined
      || identity.teamId !== teamId
      || identity.conversationId !== conversationId
      || identity.slotId !== slotId
    ) {
      throw new AgentTeamError('INVALID_REQUEST', 'Team tool caller identity does not match its scoped member')
    }
  }

  /** Which team member one live Agent acts as, whether subagent or Leader. */
  private identityOf(sessionId: string): { teamId: string; conversationId: string; slotId: string } | undefined {
    return this.members.identityOf(sessionId)
  }

  /** Install the team composition on a bound Session's own Agent. */
  // ── The Leader: the Session’s own Agent ─────────────────────────────────
  private attachLeaderForSession(sessionId: string): void {
    leaderAttachment.attachLeaderForSession(this.leaderDeps(), sessionId)
  }

  private attachLeader(conversation: TeamConversation): void {
    leaderAttachment.attachLeader(this.leaderDeps(), conversation)
  }

  private detachLeader(sessionId: string): void {
    leaderAttachment.detachLeader(this.leaderDeps(), sessionId)
  }

  /** What the Leader attachment needs from this runtime. */
  private leaderDeps(): leaderAttachment.LeaderDeps {
    return {
      ctx: this.ctx,
      service: this.service,
      members: this.members,
      interactions: this.interactions,
      commands: this.commands,
      handoffRelay: this.handoffRelay,
      rulesFor: (target: TeamMemberSlot) => this.rulesFor(target),
      assertToolIdentity: (agent, teamId, conversationId, slotId) => {
        this.assertToolIdentity(agent, teamId, conversationId, slotId)
      },
    }
  }

  /**
   * One member's Agent inside a conversation: the Leader is the Session's own
   * Agent, every other member is an online subagent.
   */
  private resolveAgentIn(conversation: TeamConversation, slotId: string): Agent | undefined {
    const team = this.service.getTeam(conversation.teamId)
    if (slotId === team.leaderSlotId) return this.leaderAgent(conversation)
    const sessionId = conversation.memberSessions[slotId]
    if (sessionId === undefined) return undefined
    return this.members.agentOf(sessionId)?.handle.agent
  }

  /** Resolve one member's Agent, failing loudly when it is not online. */
  private requireAgentIn(conversation: TeamConversation, slotId: string): Agent {
    const agent = this.resolveAgentIn(conversation, slotId)
    if (agent === undefined) {
      throw new AgentTeamError(
        'TEAM_NOT_ACTIVE',
        `Team member '${slotId}' is not online in conversation '${conversation.id}'`,
      )
    }
    return agent
  }

  /** Every Session currently online for one member, across all conversations. */
  private ownedForSlot(teamId: string, slotId: string): OwnedAgent[] {
    return this.members.agentsForSlot(teamId, slotId)
  }

  /**
   * Re-read the workspace rules selected by any member of a team. Missing files
   * are dropped rather than failing: a rule may be renamed after selection.
   */
  /** The imported documents one member loads, resolved from its live assistant. */
  private rulesFor(member: TeamMemberSlot): RuleDocumentContent[] {
    const assistant = this.service.assistantForMember(member)
    return this.service
      .listRuleDocuments()
      .items
      .filter(document => assistant.ruleDocumentAllowlist.includes(document.id))
      .map(document => ({ title: document.title, fileName: document.fileName, text: document.content }))
  }

  /** The recipient's Agent inside one conversation, when that conversation is online. */
  private resolveOnlineAgent(
    teamId: string,
    conversationId: string,
    slotId: string,
  ): Agent | undefined {
    const conversation = this.service.getConversation(teamId, conversationId)
    return this.resolveAgentIn(conversation, slotId)
  }

  private async setMemberRuntimeState(
    teamId: string,
    slotId: string,
    state: 'idle' | 'running',
  ): Promise<void> {
    const current = this.service.getTeam(teamId)
    if (current.members[slotId]?.lastRuntimeState === state) return
    await this.service.updateRuntimeTeam(
      teamId,
      team => ({
        ...team,
        members: mapMembers(team, member => member.id === slotId
          ? { ...member, desiredState: 'online', lastRuntimeState: state }
          : member),
      }),
      'team.member_status',
      `Member ${slotId} entered ${state}`,
    )
  }

  private async markTeamError(teamId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    await this.service.updateRuntimeTeam(
      teamId,
      team => ({ ...team, state: team.state === 'ownership_conflict' ? team.state : 'error' }),
      'team.runtime_error',
      message,
    )
  }

}

function mapMembers(
  team: TeamAggregate,
  map: (member: TeamMemberSlot) => TeamMemberSlot,
): TeamAggregate['members'] {
  return Object.fromEntries(Object.entries(team.members).map(([id, member]) => [id, map(member)]))
}


/**
 * A team is legacy when any member still carries a team-scoped `sessionId`.
 * Conversations own member Sessions now, so such a team cannot be mapped onto
 * the isolated model and is dropped at startup.
 */
function isLegacyTeam(team: TeamAggregate): boolean {
  return Object.values(team.members).some(member => member.sessionId !== undefined)
}

/**
 * One member's wake-up message: exactly what the reader sent, plus plugin
 * provenance. The provenance is what keeps the room from reading the relay back
 * as the reader's own line — that is what once made a mention relay itself
 * again, once per round. The text is not decorated, because a member's column
 * shows the message it received and a wake-up line there is not something the
 * reader wrote.
 */
/**
 * The reader's own room message, relayed to one member.
 *
 * It carries the reader's text verbatim. A team message the plugin passes on
 * arrives with the same `relay` form but a `[Team message from …]` header, and
 * the room tells them apart by matching the text against the reader's own room
 * records — it never decorates this one.
 */
function withReasoningEffort(
  member: TeamMemberSlot,
  reasoningEffort: string | undefined,
): TeamMemberSlot {
  const { reasoningEffort: _current, ...rest } = member
  return reasoningEffort === undefined ? rest : { ...rest, reasoningEffort }
}

