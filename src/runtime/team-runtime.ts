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
const HANDOFF_ATTEMPTS = 3
/** Backoff between hand-off attempts, growing linearly per attempt. */
const HANDOFF_RETRY_MS = 500

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
  private readonly disposeStatusListener: () => void
  private readonly disposeConversationListener: () => void
  private readonly disposeStreamListener: () => void
  private readonly disposeCreatedListener: () => void
  private readonly disposeDisposedListener: () => void
  private readonly disposeUserMessageListener: () => void
  private readonly conversationPublishes = new PublishCoalescer()
  /** Transient live assistant output per member session, keyed by session id. */
  private readonly liveStreams = new LiveStreamBuffer()
  /** Member requests already handed to the Leader, so each is announced once. */
  private readonly handedRequests = new Set<string>()
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
          this.handToLeader(sessionId)
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
    // A Session's own Agent is the Leader of whichever team that Session has
    // enabled, so the composition is installed when the Agent appears — on the
    // first conversation view, on a reload, or after a Harness restart — and
    // dropped when it goes away.
    this.disposeCreatedListener = ctx.on('agent/created', ({ agent }) => {
      this.attachLeaderForSession(String(agent.id))
    })
    this.disposeDisposedListener = ctx.on('agent/disposed', ({ agent }) => {
      this.members.detachLeader(String(agent.id))
    })
    // Everything the user types goes through the Harness composer now, so a
    // bound Session's own user message is what the room must show — and what
    // routes to a member the message mentions.
    this.disposeUserMessageListener = ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      this.observeUserMessage(String(session.id), event)
    })
    this.disposeStatusListener = ctx.on('agent/status', ({ agent, status }) => {
      const owned = this.members.agentOf(String(agent.id))
      if (owned === undefined) return
      void this.setMemberRuntimeState(owned.teamId, owned.slotId, status)
        .catch(error => this.ctx.logger.warn('agent-team: failed to persist agent status', error))
    })
    this.disposeConversationListener = ctx.on('session/event', (session) => {
      const sessionId = String(session.id)
      if (this.members.agentOf(sessionId) === undefined && this.members.leaderOf(sessionId) === undefined) return
      this.conversationPublishes.schedule(sessionId, () => {
        try {
          this.publishOwnedConversation(sessionId)
        } catch (error) {
          this.ctx.logger.warn('agent-team: failed to publish conversation update', error)
        }
      })
    })
    this.disposeStreamListener = ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      const sessionId = String(agent.id)
      if (!this.members.has(sessionId)) return
      // What each frame means is this listener's business; holding the
      // in-progress text is the buffer's.
      if (frame.type === 'start') {
        this.liveStreams.begin(sessionId)
      } else if (frame.type === 'chunk') {
        const chunk = frame.chunk
        if (chunk.type === 'text-delta') this.liveStreams.append(sessionId, { text: chunk.text })
        if (chunk.type === 'reasoning-delta') this.liveStreams.append(sessionId, { reasoning: chunk.text })
        if (chunk.type === 'block-end' && chunk.block.type === 'text') {
          this.liveStreams.replace(sessionId, { text: chunk.block.text })
        }
        if (chunk.type === 'block-end' && chunk.block.type === 'reasoning') {
          this.liveStreams.replace(sessionId, { reasoning: chunk.block.text })
        }
      } else {
        this.liveStreams.end(sessionId)
      }
    })
  }

  interactionBridge(): TeamInteractionBridge {
    return this.interactions
  }

  async getWorkbench(teamId: string, conversationId: string): Promise<TeamWorkbenchView> {
    const team = this.service.getTeam(teamId)
    const conversation = this.requireConversation(teamId, conversationId)
    // Opening the 团队 view is what brings the members online, exactly like
    // opening the old workbench did — but only when one is actually missing.
    // Re-reading a team that is already online is the common case, and
    // materializing an Agent is the expensive one; paying for activation on
    // every read is what made the view feel like it reloads forever.
    const offline = orderedMembers(team)
      .some(member => this.resolveAgentIn(conversation, member.id) === undefined)
    if (offline) {
      // A Session the Harness has not materialized yet keeps the view readable
      // instead of failing the whole read.
      await this.operations.run(teamId, () => this.ensureConversationOnline(teamId, conversation.id))
        .catch(error => {
          this.ctx.logger.warn(
            `agent-team: members of conversation '${conversation.id}' are not online yet`,
            error,
          )
        })
    }
    const stored = await this.storedSessionIds()
    const conversations = await Promise.all(orderedMembers(team).map(async member => {
      const events = await this.memberEvents(conversation, member.id, stored)
      return this.projectMemberConversation(team, member, conversation, events)
    }))
    return {
      schemaVersion: 1,
      teamId: team.id,
      revision: team.revision,
      conversation,
      conversations,
    }
  }

  /** Resolve one bound conversation, failing loudly when it does not exist. */
  private requireConversation(teamId: string, conversationId: string): TeamConversation {
    return this.service.getConversation(teamId, conversationId)
  }

  /**
   * One member's durable events inside a conversation. The Leader runs on the
   * Session Agent itself, so its events are the Session's own log — the same
   * conversation the 对话 view shows.
   */
  private async memberEvents(
    conversation: TeamConversation,
    slotId: string,
    stored?: Set<string>,
  ): Promise<readonly SessionEvent[]> {
    const sessionId = this.memberSessionId(conversation, slotId)
    if (sessionId === undefined) return []
    const leader = this.leaderAgent(conversation)
    if (leader !== undefined && String(leader.id) === sessionId) {
      return leader.session.snapshotEvents()
    }
    const owned = this.members.agentOf(sessionId)
    if (owned !== undefined) return owned.handle.agent.session.snapshotEvents()
    const materialized = stored ?? await this.storedSessionIds()
    if (!materialized.has(sessionId)) return []
    try {
      return await readStoredEvents(this.ctx, sessionId)
    } catch {
      return []
    }
  }

  /**
   * The Session behind one member slot: the Leader is the bound Harness
   * Session, every other member is its subagent.
   */
  private memberSessionId(conversation: TeamConversation, slotId: string): string | undefined {
    const team = this.service.getTeam(conversation.teamId)
    if (slotId === team.leaderSlotId) return conversation.sessionId
    return conversation.memberSessions[slotId]
  }

  /** Read a durable log for a member that is not currently online. */
  private async storedSessionIds(): Promise<Set<string>> {
    const snapshots = await this.ctx.sessionPersistence.list()
    return new Set(snapshots.map(snapshot => String(snapshot.header.id)))
  }

  /**
   * A member's live state. A Session that is online reports its Agent status;
   * an offline one reports the last state this team recorded for the member.
   */
  private memberStatus(
    sessionId: string | undefined,
    lastRuntimeState: TeamMemberSlot['lastRuntimeState'],
  ): MemberConversationView['status'] {
    if (sessionId === undefined) return 'offline'
    const owned = this.members.agentOf(sessionId)
    if (owned !== undefined) return owned.handle.agent.status
    const leader = this.ctx.agents.get(SessionId(sessionId))
    if (leader !== undefined) return leader.status
    return lastRuntimeState
  }

  /** Build the shared room timeline for one bound Session. */
  async getRoom(teamId: string, conversationId: string, beforeTime?: number): Promise<RoomView> {
    const team = this.service.getTeam(teamId)
    const conversation = this.requireConversation(teamId, conversationId)
    const stored = await this.storedSessionIds()
    const messages = this.service.listMessages(teamId).items
      .filter(message => message.conversationId === conversation.id)
    const sources = await Promise.all(Object.values(team.members).map(async member => ({
      member,
      events: await this.memberEvents(conversation, member.id, stored),
    })))
    const projected = projectRoom(
      team,
      sources,
      messages,
      beforeTime === undefined
        ? { conversationId: conversation.id }
        : { beforeTime, limit: CONVERSATION_PAGE_SIZE, conversationId: conversation.id },
    )
    return {
      schemaVersion: 1,
      teamId,
      conversation,
      participants: orderedMembers(team).map(member => ({
        slotId: member.id,
        displayName: member.displayName,
        role: member.role,
        status: this.memberStatus(
          this.memberSessionId(conversation, member.id),
          member.lastRuntimeState,
        ),
      })),
      messages: projected.messages,
      throughSeq: projected.throughSeq,
      hasMore: projected.hasMore,
      ...(projected.oldestTime === undefined ? {} : { oldestTime: projected.oldestTime }),
    }
  }

  /**
   * One member's page of nodes immediately before `beforeSeq`.
   *
   * The view keeps the newer window it already shows and prepends this page,
   * the way the Harness pages a Session's history.
   */
  async getOlderMemberConversation(
    teamId: string,
    conversationId: string,
    slotId: string,
    beforeSeq: number,
  ): Promise<MemberConversationView> {
    const team = this.service.getTeam(teamId)
    const member = team.members[slotId]
    if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    const conversation = this.requireConversation(teamId, conversationId)
    const stored = await this.storedSessionIds()
    const events = await this.memberEvents(conversation, member.id, stored)
    return this.projectMemberConversation(team, member, conversation, events, beforeSeq)
  }

  /**
   * Enable a team in one Harness Session: its Agent becomes the Leader and the
   * other members run as that Agent's subagents. Enabling is what starts the
   * team, so a draft team becomes active here.
   */
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

  /**
   * Record one message the user typed into the Harness composer as a room
   * message, and hand a mentioned member the message directly.
   *
   * The room keeps no composer of its own, so without this the discussion
   * would read one-sided: the Session's own transcript holds the user's line,
   * while the room merges the members' turns. A message carrying `@name`
   * addresses that member, so the plugin delivers it instead of waiting for
   * the Leader to relay it — the Leader is told not to dispatch it twice.
   */
  private observeUserMessage(sessionId: string, event: SessionEvent): void {
    if (event.type !== 'user/message') return
    const conversation = this.service.findConversationBySession(sessionId)
    if (conversation === undefined) return
    // Team relays carry plugin provenance and member Sessions are not bound at
    // all, so only what the user typed reaches here.
    if (event.data.source.kind !== 'user') return
    const text = textOfContent(event.data.content).trim()
    if (text.length === 0) return
    const id = String(event.data.id)
    // A message the room composer already recorded keeps its record.
    if (this.service.listMessages(conversation.teamId).items.some(message => message.id === id)) return
    const team = this.service.getTeam(conversation.teamId)
    // A message naming members wakes exactly those members. One that names
    // nobody belongs to the Leader: it owns this Session's turns, and it is the
    // reader's own Agent. Talking to one member privately means opening that
    // member's Session, whose composer the Leader never sees.
    const targets = mentionedSlotIds(team, text)
    const record = teamMessage({
      id,
      teamId: conversation.teamId,
      conversationId: conversation.id,
      ...(targets.length === 0 ? {} : { mentions: targets }),
      sender: { kind: 'user', id: 'local-user' },
      recipient: { kind: 'broadcast' },
      type: 'instruction',
      content: text,
      idempotencyKey: id,
    })
    void this.operations.run(conversation.teamId, async () => {
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'delivered' })
      if (targets.length === 0) return
      await this.ensureConversationOnline(conversation.teamId, conversation.id)
      for (const slotId of targets) {
        if (this.service.getTeam(conversation.teamId).members[slotId] === undefined) continue
        // The Leader is this Session's own Agent: the message the user typed is
        // already in its log and already drives its turn, so relaying it back
        // would hand the Leader the same message twice.
        if (slotId === team.leaderSlotId) continue
        this.resolveAgentIn(conversation, slotId)?.followup(roomRelayMessage(text))
      }
    }).catch(error => {
      this.ctx.logger.warn('agent-team: failed to relay a mentioned room message', error)
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

  /**
   * Post a user message into the active room. Mentioned members are woken with
   * the message; with no mention the leader is addressed, matching direct chat.
   * A member's reply needs no special tool — its Session output is projected
   * into the room automatically.
   */
  async sendRoomMessage(
    teamId: string,
    rawContent: string,
    conversationId: string,
    mentions: readonly string[] = [],
  ): Promise<TeamMessage> {
    const team = this.requireSendableTeam(teamId)
    const content = requireContent(rawContent)
    const conversation = this.requireConversation(teamId, conversationId)
    const targets = mentions.length > 0 ? [...new Set(mentions)] : [team.leaderSlotId]
    for (const slotId of targets) {
      if (team.members[slotId] === undefined) {
        throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
      }
    }
    await this.operations.run(teamId, () => this.ensureConversationOnline(teamId, conversation.id))
    const message = createUserMessage({
      content: [{ type: 'text', text: content }],
      source: { kind: 'user' },
    })
    const record = teamMessage({
      id: String(message.id),
      teamId,
      conversationId: conversation.id,
      mentions: targets,
      sender: { kind: 'user', id: 'local-user' },
      recipient: { kind: 'broadcast' },
      type: 'instruction',
      content,
      idempotencyKey: String(message.id),
    })
    await this.service.putRuntimeMessage(record)
    try {
      for (const slotId of targets) {
        if (team.members[slotId] === undefined) continue
        this.requireAgentIn(conversation, slotId).followup(roomRelayMessage(content))
      }
      const delivered = { ...record, deliveryState: 'delivered' as const }
      await this.service.putRuntimeMessage(delivered)
      return delivered
    } catch (error) {
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'failed' })
      throw error
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


  /**
   * Fail with an actionable message before creating an Agent whose model this
   * deployment cannot route.
   *
   * Without this the failure surfaces from the LLM layer as
   * `no adapter registered for provider "x"`, which names neither the member nor
   * the assistant to fix.
   */
  private async assertModelAvailable(
    member: TeamMemberSlot,
    provider: string,
    model: string,
  ): Promise<void> {
    const registered = new Set(this.ctx.llm.listProviders().map(info => info.id))
    if (!registered.has(provider)) {
      throw new AgentTeamError(
        'MODEL_REFERENCE_INVALID',
        `成员「${member.displayName}」的模型 provider「${provider}」在当前环境中未注册，`
        + `请在助手库中改用可用的 provider（当前可用：${[...registered].join('、') || '无'}）`,
        { memberId: member.id, provider, model, registeredProviders: [...registered] },
      )
    }
    try {
      await this.ctx.llm.resolveModelInfo(provider, model)
    } catch (error) {
      throw new AgentTeamError(
        'MODEL_REFERENCE_INVALID',
        `成员「${member.displayName}」的模型「${provider}/${model}」无法解析，请检查助手配置`,
        { memberId: member.id, provider, model },
        { cause: error },
      )
    }
  }

  private projectMemberConversation(
    team: TeamAggregate,
    member: TeamMemberSlot,
    conversation: TeamConversation,
    events: readonly SessionEvent[],
    /**
     * Show only this member's nodes older than the given seq. The view opens on
     * its newest page and pages backwards, exactly like a Harness Session.
     */
    beforeSeq?: number,
  ): MemberConversationView {
    const sessionId = this.memberSessionId(conversation, member.id)
    const status = this.memberStatus(sessionId, member.lastRuntimeState)
    const contextUsage = projectContextUsage(events)
    const visible = beforeSeq === undefined
      ? events
      : events.filter(event => event.seq < beforeSeq)
    const projected = projectConversation(visible, CONVERSATION_PAGE_SIZE, {
      team,
      messages: this.service.listMessages(team.id).items
        .filter(message => message.conversationId === conversation.id),
      // The Leader's column is this Session's own log: the relay copies an
      // earlier bug appended there read as the user's own messages.
      ...(member.id === team.leaderSlotId ? { hideRelayEchoes: true } : {}),
    })
    const live = sessionId === undefined ? undefined : this.liveStreams.nonEmpty(sessionId)
    return {
      slotId: member.id,
      conversationId: conversation.id,
      ...(sessionId === undefined ? {} : { sessionId }),
      status,
      pendingInteractions: sessionId === undefined ? [] : this.interactions.list(sessionId),
      ...(live === undefined
        ? projected
        : {
            throughSeq: projected.throughSeq,
            nodes: [...projected.nodes, {
              id: `stream:${sessionId ?? member.id}`,
              kind: 'assistant' as const,
              seq: projected.throughSeq + 1,
              time: Date.now(),
              text: live.text,
              ...(live.reasoning.length === 0 ? {} : { reasoning: live.reasoning }),
              streaming: true,
            }],
          }),
      ...(contextUsage === undefined ? {} : { contextUsage }),
    }
  }

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
  freshMemberContext(teamId: string, conversationId: string, slotId: string): Promise<void> {
    return this.operations.run(teamId, async () => {
      const team = this.service.getTeam(teamId)
      const member = team.members[slotId]
      if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
      if (slotId === team.leaderSlotId) return
      let conversation = this.service.getConversation(teamId, conversationId)
      const previous = conversation.memberSessions[slotId]
      if (previous !== undefined) {
        await this.service.forgetMemberSessions(teamId, slotId)
        conversation = await this.service.assignMemberSessions(teamId, conversationId, {
          [slotId]: `agent-team:${randomUUID()}`,
        })
        const active = this.members.agentOf(previous)
        if (active !== undefined) {
          this.members.detach(previous)
          await active.handle.dispose().catch(() => undefined)
        }
      }
      await this.ensureConversationOnline(teamId, conversation.id)
    })
  }

  activateMember(teamId: string, slotId: string): Promise<TeamAggregate> {
    return this.operations.run(teamId, async () => {
      const team = this.service.getTeam(teamId)
      const member = team.members[slotId]
      if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
      const conversations = this.service.listConversations(teamId).items
      for (const conversation of conversations) {
        await this.ensureConversationOnline(teamId, conversation.id)
      }
      const first = conversations[0]
      if (first !== undefined) {
        const current = this.service.getTeam(teamId)
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
            `模型：${this.service.assistantForMember(readyMember).provider} / ${this.service.assistantForMember(readyMember).model}`,
            '状态：已就绪，可以分配任务。',
          ].join('\n'),
        })
        await this.service.updateRuntimeTeam(
          teamId,
          latest => ({ ...latest, outbox: { ...latest.outbox, [notice.id]: notice } }),
          'team.member_ready',
          `Member ${readyMember.displayName} is ready`,
        )
        await this.messages.deliver(teamId, notice.id)
      }
      return this.service.getTeam(teamId)
    })
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

  async sendUserMessage(
    teamId: string,
    rawContent: string,
    conversationId: string,
    targetSlotId?: string,
  ): Promise<TeamMessage> {
    const team = this.requireSendableTeam(teamId)
    const slotId = targetSlotId ?? team.leaderSlotId
    const target = team.members[slotId]
    if (target === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    if (slotId !== team.leaderSlotId && !team.directMemberChat) {
      throw new AgentTeamError('INVALID_REQUEST', 'Direct member chat is disabled for this team')
    }
    const content = requireContent(rawContent)
    const conversation = this.requireConversation(teamId, conversationId)
    await this.operations.run(teamId, () => this.ensureConversationOnline(teamId, conversation.id))
    const agent = this.requireAgentIn(conversation, slotId)
    const message = createUserMessage({
      content: [{ type: 'text', text: content }],
      source: { kind: 'user' },
    })
    const record = teamMessage({
      id: String(message.id),
      teamId,
      conversationId: conversation.id,
      sender: { kind: 'user', id: 'local-user' },
      recipient: slotId === team.leaderSlotId
        ? { kind: 'leader', slotId }
        : { kind: 'member', slotId },
      type: 'instruction',
      content,
      idempotencyKey: String(message.id),
    })
    await this.service.putRuntimeMessage(record)
    try {
      agent.followup(message)
      const delivered = { ...record, deliveryState: 'delivered' as const }
      await this.service.putRuntimeMessage(delivered)
      return delivered
    } catch (error) {
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'failed' })
      throw error
    }
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
    this.disposeStatusListener()
    this.disposeConversationListener()
    this.disposeStreamListener()
    this.disposeCreatedListener()
    this.disposeDisposedListener()
    this.disposeUserMessageListener()
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
  private handToLeader(sessionId: string): void {
    const pending = new Set(this.interactions.pendingIds())
    for (const id of [...this.handedRequests]) {
      if (!pending.has(id)) this.handedRequests.delete(id)
    }
    const owned = this.members.agentOf(sessionId)
    if (owned === undefined) return
    const team = this.service.getTeam(owned.teamId)
    const member = team.members[owned.slotId]
    const leader = this.resolveAgentIn(
      this.service.getConversation(owned.teamId, owned.conversationId),
      team.leaderSlotId,
    )
    if (member === undefined || leader === undefined) {
      // Nothing can be handed over right now. Refusing would deny a request the
      // Leader may well be able to grant once it exists again, so the request
      // stays pending — but the reason is logged, because a member stuck behind
      // an unanswerable request looks exactly like one that is still working.
      this.ctx.logger.warn(
        `agent-team: member '${owned.slotId}' is waiting, but `
        + (member === undefined ? 'it is no longer a team member' : 'the Leader is not online'),
      )
      return
    }
    const leaderMode = this.leaderSandboxMode(owned.teamId, owned.conversationId)
    // «替我审批»: every request of this conversation is the Leader's to answer,
    // so none of them may be left waiting for the reader to click.
    const delegated = this.service.getConversation(owned.teamId, owned.conversationId).delegateInteractions === true
    for (const interaction of this.interactions.list(sessionId)) {
      if (this.handedRequests.has(interaction.id)) continue
      this.handedRequests.add(interaction.id)
      // A Leader answers only within the access it holds itself: a wider
      // request is the reader's, and the interface opens it right away.
      const beyondLeader = interaction.kind === 'approval'
        && !withinLeaderAuthority(leaderMode, interaction.requestedMode)
      if (delegated) {
        this.interactions.markLeaderOnly(interaction.id)
        // Nobody could grant it either, so it is refused now instead of being
        // held for a card that will never open.
        if (beyondLeader) this.interactions.refuse(interaction.id)
      } else if (beyondLeader) {
        this.interactions.markUserOnly(interaction.id)
      }
      const content = memberRequestContent(member.displayName, interaction, { leaderMode, beyondLeader, delegated })
      // The member's wait is bounded: a request nobody answers is refused
      // rather than left to hang, which is the one outcome a member cannot
      // recover from.
      this.interactions.armDeadline(
        interaction.id,
        this.handoff.answerWindowMs ?? LEADER_ANSWER_TIMEOUT_MS,
      )
      void this.deliverHandoff({
        sessionId,
        teamId: owned.teamId,
        conversationId: owned.conversationId,
        senderSlotId: member.id,
        recipientSlotId: team.leaderSlotId,
        content,
        type: interaction.kind === 'approval' ? 'warning' : 'question',
        interactionId: interaction.id,
      })
    }
  }

  /**
   * Deliver one hand-off, retrying the transient failures a busy Host produces.
   *
   * A delivery that keeps failing means the Leader cannot be reached at all, and
   * a member waiting on a request nobody will answer is worse than a refusal it
   * can react to — so the request is settled rather than left pending.
   */
  private async deliverHandoff(handoff: {
    sessionId: string
    teamId: string
    conversationId: string
    senderSlotId: string
    recipientSlotId: string
    content: string
    type: 'warning' | 'question'
    interactionId: string
  }): Promise<void> {
    let lastError: unknown
    const attempts = this.handoff.attempts ?? HANDOFF_ATTEMPTS
    const retryMs = this.handoff.retryMs ?? HANDOFF_RETRY_MS
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.commands.sendMemberMessage(
          handoff.teamId,
          handoff.conversationId,
          handoff.senderSlotId,
          handoff.recipientSlotId,
          handoff.content,
          handoff.type,
        )
        return
      } catch (error) {
        lastError = error
        await new Promise(resolve => setTimeout(resolve, retryMs * (attempt + 1)))
      }
    }
    this.handedRequests.delete(handoff.interactionId)
    this.ctx.logger.warn('agent-team: handing a member request to the Leader failed', lastError)
    this.refuseEvery(handoff.sessionId, `无法把请求转交给 Leader：${String(lastError)}`)
  }

  /**
   * Settle every request one Session is waiting on. Called when no answerer is
   * reachable at all, where leaving the request pending would block the member
   * for good; `reason` goes to the Host log so the cause stays diagnosable.
   */
  private refuseEvery(sessionId: string, reason: string): void {
    const waiting = this.interactions.list(sessionId)
    if (waiting.length === 0) return
    this.ctx.logger.warn(`agent-team: refusing ${waiting.length} waiting member request(s): ${reason}`)
    for (const interaction of waiting) {
      this.handedRequests.delete(interaction.id)
      this.interactions.refuse(interaction.id)
    }
  }

  /** The sandbox level the Leader itself runs at, read from its own Session. */
  private leaderSandboxMode(teamId: string, conversationId: string): string | undefined {
    const conversation = this.service.getConversation(teamId, conversationId)
    if (conversation.sessionId === undefined) return undefined
    const agent = this.ctx.agents.get(SessionId(conversation.sessionId))
    return agent === undefined ? undefined : sandboxModeOf(agent.session.snapshotEvents())
  }

  private publishOwnedConversation(sessionId: string): void {
    try {
      const owned = this.members.agentOf(sessionId)
      if (owned !== undefined) {
        const team = this.service.getTeam(owned.teamId)
        const member = team.members[owned.slotId]
        if (member === undefined) return
        this.service.publishConversation(
          team.id,
          team.revision,
          this.projectMemberConversation(
            team,
            member,
            this.service.getConversation(owned.teamId, owned.conversationId),
            owned.handle.agent.session.snapshotEvents(),
          ),
        )
        return
      }
      // The bound Session's own Agent is the Leader, so its activity is what the
      // 团队 view shows for that member column.
      const leader = this.members.leaderOf(sessionId)
      if (leader === undefined) return
      const team = this.service.getTeam(leader.teamId)
      const member = team.members[leader.slotId]
      const agent = this.ctx.agents.get(SessionId(sessionId))
      if (member === undefined || agent === undefined) return
      this.service.publishConversation(
        team.id,
        team.revision,
        this.projectMemberConversation(
          team,
          member,
          this.service.getConversation(leader.teamId, leader.conversationId),
          agent.session.snapshotEvents(),
        ),
      )
    } catch (error) {
      this.ctx.logger.warn('agent-team: failed to publish interaction update', error)
    }
  }

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

  /**
   * Bring one conversation's member Sessions online. Other conversations keep
   * whatever Session state they already had, so several conversations can run
   * concurrently without interrupting each other.
   */
  private async ensureConversationOnline(teamId: string, conversationId: string): Promise<void> {
    const team = this.service.getTeam(teamId)
    const conversation = this.service.getConversation(teamId, conversationId)
    // Only members that are supposed to be running and are not on yet need
    // starting. Nothing to start means nothing to open, and a draft team must
    // stay dormant when its 团队 view is touched.
    // The Leader is the Session's own Agent, so it is never one of the member
    // Sessions this brings online.
    const starting = Object.values(team.members).filter(member => {
      if (member.id === team.leaderSlotId) return false
      if (member.desiredState !== 'online') return false
      const sessionId = conversation.memberSessions[member.id]
      return sessionId === undefined || !this.members.has(sessionId)
    })
    if (starting.length === 0) return
    // Members are subagents of the Session's own Agent, so that Agent has to be
    // live: it is the parent the Harness records for every child Session.
    const leader = this.requireLeaderAgent(conversation)
    const target = conversationWorkspace(team, conversation)
    if (target === undefined) {
      throw new AgentTeamError(
        'WORKSPACE_UNAVAILABLE',
        `Session '${conversation.sessionId ?? conversation.id}' has no Workspace`,
      )
    }
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(target.id))
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
      : await this.service.assignMemberSessions(teamId, conversationId, pending)
    const materialized = await this.storedSessionIds()
    await mapConcurrent(Object.values(team.members), this.config.runtimeConcurrency, async member => {
      if (member.id === team.leaderSlotId) return
      if (member.desiredState !== 'online') return
      const sessionId = assigned.memberSessions[member.id]
      if (sessionId === undefined) return
      await this.ensureMemberOnline(team, member, conversation, sessionId, materialized, target, leader)
    })
    // Members are online, so whatever made the team 'error' — a startup
    // recovery that lost a session race, say — is over. Keeping the stale
    // state would keep refusing every later message.
    const online = this.service.getTeam(teamId)
    if (online.state === 'error') {
      await this.service.updateRuntimeTeam(
        teamId,
        current => ({ ...current, state: 'active' }),
        'team.recovered',
        `Team ${online.name} recovered by opening a conversation`,
      )
    }
  }

  /**
   * A team in `error` is recoverable, not unusable: the send paths open its
   * conversation again and lift it back to `active`. Every other state
   * (draft, starting, deleting) really cannot take a message yet, and says so.
   */
  private requireSendableTeam(teamId: string): TeamAggregate {
    const team = this.service.getTeam(teamId)
    if (team.state !== 'active' && team.state !== 'error') {
      throw new AgentTeamError(
        'TEAM_NOT_ACTIVE',
        `Team '${team.name}' cannot take messages while it is '${team.state}'`,
      )
    }
    return team
  }

  /**
   * The Harness Session Agent that leads one conversation. Members are its
   * subagents, so it must be live before they can be created.
   */
  private requireLeaderAgent(conversation: TeamConversation): Agent {
    const sessionId = conversation.sessionId
    const agent = sessionId === undefined ? undefined : this.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) {
      throw new AgentTeamError(
        'SESSION_UNAVAILABLE',
        '该团队所在的会话尚未打开，请先打开该会话再继续',
      )
    }
    return agent
  }

  private leaderAgent(conversation: TeamConversation): Agent | undefined {
    const sessionId = conversation.sessionId
    return sessionId === undefined ? undefined : this.ctx.agents.get(SessionId(sessionId))
  }

  private async ensureMemberOnline(
    team: TeamAggregate,
    member: TeamMemberSlot,
    conversation: TeamConversation,
    sessionIdValue: string,
    materialized: Set<string>,
    workspace: TeamWorkspace,
    leader: Agent,
  ): Promise<void> {
    const prior = this.members.agentOf(sessionIdValue)
    if (prior !== undefined) {
      // A member that is already live still gets the identity record: catalogs
      // read the log, and one written before this release has none.
      identifyMemberAsSubagent(prior.handle.agent, member.displayName)
      return
    }
    const sessionId = SessionId(sessionIdValue)
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) {
      await this.service.updateRuntimeTeam(
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
    const assistant = this.service.assistantForMember(member)
    await this.assertModelAvailable(member, assistant.provider, assistant.model)

    try {
      this.members.beginActivation(sessionIdValue, { teamId: team.id, conversationId, slotId: member.id })
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
          ctx: this.ctx,
          service: this.service,
          interactions: this.interactions,
          commands: this.commands,
          rulesFor: (target: TeamMemberSlot) => this.rulesFor(target),
          assertToolIdentity: (agent: Agent | undefined, teamId: string, convId: string, slotId: string) => {
            this.assertToolIdentity(agent, teamId, convId, slotId)
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
        ? await this.ctx.agents.resume({ resumeSessionId: sessionId, parentAgent: leader, agentOptions, setup })
        : await this.ctx.agents.create({
          sessionId,
          parentAgent: leader,
          meta: childMeta,
          agentOptions,
          setup,
        })
      this.members.attach(sessionIdValue, {
        teamId: team.id,
        conversationId,
        slotId: member.id,
        handle,
        modelSelection,
      })
      this.members.endActivation(sessionIdValue)
      await this.setMemberRuntimeState(team.id, member.id, handle.agent.status)
    } catch (error) {
      this.members.endActivation(sessionIdValue)
      const causeMessage = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(
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
  private attachLeaderForSession(sessionId: string): void {
    const conversation = this.service.findConversationBySession(sessionId)
    if (conversation !== undefined) this.attachLeader(conversation)
  }

  /**
   * Make one Session's own Agent act as the team Leader: its instructions and
   * the roster are added to the Agent's prompt, and the team tools are exposed
   * so it can create tasks and message members from the 对话 view itself.
   *
   * The Leader keeps the Session's own model, preset and permissions — only the
   * team composition is added, and only for as long as the binding lasts.
   */
  private attachLeader(conversation: TeamConversation): void {
    const sessionId = conversation.sessionId
    if (sessionId === undefined) return
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) return
    const team = this.service.getTeam(conversation.teamId)
    const member = team.members[team.leaderSlotId]
    if (member === undefined) return
    const existing = this.members.leaderOf(sessionId)
    if (
      existing !== undefined
      && existing.teamId === team.id
      && existing.conversationId === conversation.id
      && existing.slotId === member.id
    ) {
      return
    }
    this.detachLeader(sessionId)
    const agentCtx = agent.ctx
    const disposers: Array<() => void> = []
    try {
      const composition = teamComposition(        {
          service: this.service,
          commands: this.commands,
          rulesFor: (target: TeamMemberSlot) => this.rulesFor(target),
          assertToolIdentity: (agent: Agent | undefined, teamId: string, convId: string, slotId: string) => {
            this.assertToolIdentity(agent, teamId, convId, slotId)
          },
        },         {
          team,
          conversationId: conversation.id,
          slotId: member.id,
          // The Leader slot moves when the team changes leader, so it is read
          // when a tool is called rather than captured here.
          actorSlotId: () => this.service.getTeam(team.id).leaderSlotId,
          promptMember: (latest: TeamAggregate) => latest.members[latest.leaderSlotId],
        })
      disposers.push(...installCompositionSections(
        agentCtx,
                {
          service: this.service,
          commands: this.commands,
          rulesFor: (target: TeamMemberSlot) => this.rulesFor(target),
          assertToolIdentity: (agent: Agent | undefined, teamId: string, convId: string, slotId: string) => {
            this.assertToolIdentity(agent, teamId, convId, slotId)
          },
        },
                {
          team,
          conversationId: conversation.id,
          slotId: member.id,
          // The Leader slot moves when the team changes leader, so it is read
          // when a tool is called rather than captured here.
          actorSlotId: () => this.service.getTeam(team.id).leaderSlotId,
          promptMember: (latest: TeamAggregate) => latest.members[latest.leaderSlotId],
        },
        composition.identitySection,
        composition.rosterSection,
      ))
      disposers.push(registerTeamTools(agentCtx, {
        ...composition.tools,
        answerMember: async input => {
          const pending = this.interactions.pending(input.interactionId)
          if (pending === undefined) {
            throw new AgentTeamError('INTERACTION_NOT_FOUND', '该交互请求已结束或不存在')
          }
          const decision = decideLeaderAnswer({
            pending,
            ...(input.decision === undefined ? {} : { decision: input.decision }),
            leaderMode: this.leaderSandboxMode(team.id, conversation.id),
            delegated: this.service.getConversation(team.id, conversation.id).delegateInteractions === true,
          })
          if (decision.userOnly) this.interactions.markUserOnly(pending.id)
          if (decision.refusal !== undefined) {
            throw new AgentTeamError('INVALID_REQUEST', decision.refusal)
          }
          const answered = this.interactions.answerAsLeader(input.interactionId, input)
          return { interactionId: input.interactionId, answered }
        },
      }))
      // Registered so «替我审批» can answer the Leader's own requests; while it
      // is off the scope does not accept this Session and the Harness interface
      // answers them instead.
      this.interactions.attach(agentCtx, agent)
      const dispose = (): void => {
        for (const disposer of disposers.reverse()) {
          try {
            disposer()
          } catch (error) {
            this.ctx.logger.warn('agent-team: failed to remove a Leader registration', error)
          }
        }
      }
      this.members.attachLeader(sessionId, {
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
  private detachLeader(sessionId: string): void {
    const attachment = this.members.leaderOf(sessionId)
    if (attachment === undefined) return
    this.members.detachLeader(sessionId)
    attachment.dispose()
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
 * Session write ownership is a cross-process lock, so a member that cannot
 * start because some other DSH process still holds its Session is the one
 * activation failure the user can actually do something about.
 */
function sessionBusyHint(error: unknown): string {
  return error instanceof Error && error.name === 'SessionAlreadyOwnedError'
    ? '（该成员的 Session 正被另一个 DSH 进程占用，请关掉重复实例后重试）'
    : ''
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
function roomRelayMessage(content: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: content }],
    source: { kind: 'plugin', plugin: 'dsh-squad', form: 'relay' },
  })
}

function withReasoningEffort(
  member: TeamMemberSlot,
  reasoningEffort: string | undefined,
): TeamMemberSlot {
  const { reasoningEffort: _current, ...rest } = member
  return reasoningEffort === undefined ? rest : { ...rest, reasoningEffort }
}


async function mapConcurrent<T>(
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
