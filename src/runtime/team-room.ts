import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { AgentTeamError } from '../domain/errors.js'
import { mentionedSlotIds, orderedMembers } from '../domain/team-selectors.js'
import type { TeamAggregate, TeamConversation, TeamMemberSlot, TeamMessage } from '../domain/types.js'
import type { AgentTeamService } from '../service/agent-team-service.js'
import type {
  MemberConversationView,
  RoomView,
  TeamWorkbenchView,
} from '../transport/contracts.js'
import type { LiveStreamBuffer } from './live-stream-buffer.js'
import type { MemberRegistry } from './member-registry.js'
import type { OperationQueue } from './operation-queue.js'
import type { TeamInteractionBridge } from './team-interaction-bridge.js'
import {
  CONVERSATION_PAGE_SIZE,
  projectContextUsage,
  projectConversation,
  textOfContent,
} from './conversation-projector.js'
import { projectRoom } from './room-projector.js'
import { readStoredEvents } from './session-events.js'
import {
  createTeamMessage as teamMessage,
  requireMessageContent as requireContent,
} from './team-messages.js'

/**
 * The room: what a team said, to the reader and to each other.
 *
 * A member's own column is one Session's transcript; the room is the shared
 * one, assembled from every member's log, and it is also where the reader's
 * messages come in and go out. Both read the same team, and both need the same
 * lookups — a conversation by id, a member's Agent by slot — so those are
 * handed in rather than reached for.
 */

/** The runtime's own lookups, as the room needs them. */
export interface RoomHost {
  /** The conversation, or a refusal naming it. */
  requireConversation: (teamId: string, conversationId: string) => TeamConversation
  /** One member's Agent inside a conversation, when it is online. */
  resolveAgentIn: (conversation: TeamConversation, slotId: string) => Agent | undefined
  /** The same, refusing when the member is not online. */
  requireAgentIn: (conversation: TeamConversation, slotId: string) => Agent
  /** Bring the conversation's members online before it can be read or written. */
  ensureConversationOnline: (teamId: string, conversationId: string) => Promise<void>
  /** The team, refusing one that cannot be sent to. */
  requireSendableTeam: (teamId: string) => TeamAggregate
  /** The Session's own Agent, when it is live. */
  leaderAgent: (conversation: TeamConversation) => Agent | undefined
}

/** What the room needs from the runtime that owns it. */
export interface RoomDeps {
  ctx: Context
  service: AgentTeamService
  members: MemberRegistry
  interactions: TeamInteractionBridge
  liveStreams: LiveStreamBuffer
  operations: OperationQueue
  host: RoomHost
}

export async function getWorkbench(deps: RoomDeps, teamId: string, conversationId: string): Promise<TeamWorkbenchView> {
  const team = deps.service.getTeam(teamId)
  const conversation = deps.host.requireConversation(teamId, conversationId)
  // Opening the 团队 view is what brings the members online, exactly like
  // opening the old workbench did — but only when one is actually missing.
  // Re-reading a team that is already online is the common case, and
  // materializing an Agent is the expensive one; paying for activation on
  // every read is what made the view feel like it reloads forever.
  const offline = orderedMembers(team)
    .some(member => deps.host.resolveAgentIn(conversation, member.id) === undefined)
  if (offline) {
    // A Session the Harness has not materialized yet keeps the view readable
    // instead of failing the whole read.
    await deps.operations.run(teamId, () => deps.host.ensureConversationOnline(teamId, conversation.id))
      .catch(error => {
        deps.ctx.logger.warn(
          `agent-team: members of conversation '${conversation.id}' are not online yet`,
          error,
        )
      })
  }
  const stored = await storedSessionIds(deps, )
  const conversations = await Promise.all(orderedMembers(team).map(async member => {
    const events = await memberEvents(deps, conversation, member.id, stored)
    return projectMemberConversation(deps, team, member, conversation, events)
  }))
  return {
    schemaVersion: 1,
    teamId: team.id,
    revision: team.revision,
    conversation,
    conversations,
  }
}

export function projectMemberConversation(
  deps: RoomDeps,
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
  const sessionId = memberSessionId(deps, conversation, member.id)
  const status = memberStatus(deps, sessionId, member.lastRuntimeState)
  const contextUsage = projectContextUsage(events)
  const visible = beforeSeq === undefined
    ? events
    : events.filter(event => event.seq < beforeSeq)
  const projected = projectConversation(visible, CONVERSATION_PAGE_SIZE, {
    team,
    messages: deps.service.listMessages(team.id).items
      .filter(message => message.conversationId === conversation.id),
    // The Leader's column is this Session's own log: the relay copies an
    // earlier bug appended there read as the user's own messages.
    ...(member.id === team.leaderSlotId ? { hideRelayEchoes: true } : {}),
  })
  const live = sessionId === undefined ? undefined : deps.liveStreams.nonEmpty(sessionId)
  return {
    slotId: member.id,
    conversationId: conversation.id,
    ...(sessionId === undefined ? {} : { sessionId }),
    status,
    pendingInteractions: sessionId === undefined ? [] : deps.interactions.list(sessionId),
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

export function publishOwnedConversation(deps: RoomDeps, sessionId: string): void {
  try {
    const owned = deps.members.agentOf(sessionId)
    if (owned !== undefined) {
      const team = deps.service.getTeam(owned.teamId)
      const member = team.members[owned.slotId]
      if (member === undefined) return
      deps.service.publishConversation(
        team.id,
        team.revision,
        projectMemberConversation(deps, 
          team,
          member,
          deps.service.getConversation(owned.teamId, owned.conversationId),
          owned.handle.agent.session.snapshotEvents(),
        ),
      )
      return
    }
    // The bound Session's own Agent is the Leader, so its activity is what the
    // 团队 view shows for that member column.
    const leader = deps.members.leaderOf(sessionId)
    if (leader === undefined) return
    const team = deps.service.getTeam(leader.teamId)
    const member = team.members[leader.slotId]
    const agent = deps.ctx.agents.get(SessionId(sessionId))
    if (member === undefined || agent === undefined) return
    deps.service.publishConversation(
      team.id,
      team.revision,
      projectMemberConversation(deps, 
        team,
        member,
        deps.service.getConversation(leader.teamId, leader.conversationId),
        agent.session.snapshotEvents(),
      ),
    )
  } catch (error) {
    deps.ctx.logger.warn('agent-team: failed to publish interaction update', error)
  }
}

export async function getRoom(deps: RoomDeps, teamId: string, conversationId: string, beforeTime?: number): Promise<RoomView> {
  const team = deps.service.getTeam(teamId)
  const conversation = deps.host.requireConversation(teamId, conversationId)
  const stored = await storedSessionIds(deps, )
  const messages = deps.service.listMessages(teamId).items
    .filter(message => message.conversationId === conversation.id)
  const sources = await Promise.all(Object.values(team.members).map(async member => ({
    member,
    events: await memberEvents(deps, conversation, member.id, stored),
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
      status: memberStatus(deps, 
        memberSessionId(deps, conversation, member.id),
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
export async function getOlderMemberConversation(
  deps: RoomDeps,
  teamId: string,
  conversationId: string,
  slotId: string,
  beforeSeq: number,
): Promise<MemberConversationView> {
  const team = deps.service.getTeam(teamId)
  const member = team.members[slotId]
  if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
  const conversation = deps.host.requireConversation(teamId, conversationId)
  const stored = await storedSessionIds(deps, )
  const events = await memberEvents(deps, conversation, member.id, stored)
  return projectMemberConversation(deps, team, member, conversation, events, beforeSeq)
}

/**
 * Post a user message into the active room. Mentioned members are woken with
 * the message; with no mention the leader is addressed, matching direct chat.
 * A member's reply needs no special tool — its Session output is projected
 * into the room automatically.
 */
export async function sendRoomMessage(
  deps: RoomDeps,
  teamId: string,
  rawContent: string,
  conversationId: string,
  mentions: readonly string[] = [],
): Promise<TeamMessage> {
  const team = deps.host.requireSendableTeam(teamId)
  const content = requireContent(rawContent)
  const conversation = deps.host.requireConversation(teamId, conversationId)
  const targets = mentions.length > 0 ? [...new Set(mentions)] : [team.leaderSlotId]
  for (const slotId of targets) {
    if (team.members[slotId] === undefined) {
      throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    }
  }
  await deps.operations.run(teamId, () => deps.host.ensureConversationOnline(teamId, conversation.id))
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
  await deps.service.putRuntimeMessage(record)
  try {
    for (const slotId of targets) {
      if (team.members[slotId] === undefined) continue
      deps.host.requireAgentIn(conversation, slotId).followup(roomRelayMessage(content))
    }
    const delivered = { ...record, deliveryState: 'delivered' as const }
    await deps.service.putRuntimeMessage(delivered)
    return delivered
  } catch (error) {
    await deps.service.putRuntimeMessage({ ...record, deliveryState: 'failed' })
    throw error
  }
}

export async function sendUserMessage(
  deps: RoomDeps,
  teamId: string,
  rawContent: string,
  conversationId: string,
  targetSlotId?: string,
): Promise<TeamMessage> {
  const team = deps.host.requireSendableTeam(teamId)
  const slotId = targetSlotId ?? team.leaderSlotId
  const target = team.members[slotId]
  if (target === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
  if (slotId !== team.leaderSlotId && !team.directMemberChat) {
    throw new AgentTeamError('INVALID_REQUEST', 'Direct member chat is disabled for this team')
  }
  const content = requireContent(rawContent)
  const conversation = deps.host.requireConversation(teamId, conversationId)
  await deps.operations.run(teamId, () => deps.host.ensureConversationOnline(teamId, conversation.id))
  const agent = deps.host.requireAgentIn(conversation, slotId)
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
  await deps.service.putRuntimeMessage(record)
  try {
    agent.followup(message)
    const delivered = { ...record, deliveryState: 'delivered' as const }
    await deps.service.putRuntimeMessage(delivered)
    return delivered
  } catch (error) {
    await deps.service.putRuntimeMessage({ ...record, deliveryState: 'failed' })
    throw error
  }
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
export function observeUserMessage(deps: RoomDeps, sessionId: string, event: SessionEvent): void {
  if (event.type !== 'user/message') return
  const conversation = deps.service.findConversationBySession(sessionId)
  if (conversation === undefined) return
  // Team relays carry plugin provenance and member Sessions are not bound at
  // all, so only what the user typed reaches here.
  if (event.data.source.kind !== 'user') return
  const text = textOfContent(event.data.content).trim()
  if (text.length === 0) return
  const id = String(event.data.id)
  // A message the room composer already recorded keeps its record.
  if (deps.service.listMessages(conversation.teamId).items.some(message => message.id === id)) return
  const team = deps.service.getTeam(conversation.teamId)
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
  void deps.operations.run(conversation.teamId, async () => {
    await deps.service.putRuntimeMessage({ ...record, deliveryState: 'delivered' })
    if (targets.length === 0) return
    await deps.host.ensureConversationOnline(conversation.teamId, conversation.id)
    for (const slotId of targets) {
      if (deps.service.getTeam(conversation.teamId).members[slotId] === undefined) continue
      // The Leader is this Session's own Agent: the message the user typed is
      // already in its log and already drives its turn, so relaying it back
      // would hand the Leader the same message twice.
      if (slotId === team.leaderSlotId) continue
      deps.host.resolveAgentIn(conversation, slotId)?.followup(roomRelayMessage(text))
    }
  }).catch(error => {
    deps.ctx.logger.warn('agent-team: failed to relay a mentioned room message', error)
  })
}

/**
 * One member's durable events inside a conversation. The Leader runs on the
 * Session Agent itself, so its events are the Session's own log — the same
 * conversation the 对话 view shows.
 */
export async function memberEvents(
  deps: RoomDeps,
  conversation: TeamConversation,
  slotId: string,
  stored?: Set<string>,
): Promise<readonly SessionEvent[]> {
  const sessionId = memberSessionId(deps, conversation, slotId)
  if (sessionId === undefined) return []
  const leader = deps.host.leaderAgent(conversation)
  if (leader !== undefined && String(leader.id) === sessionId) {
    return leader.session.snapshotEvents()
  }
  const owned = deps.members.agentOf(sessionId)
  if (owned !== undefined) return owned.handle.agent.session.snapshotEvents()
  const materialized = stored ?? await storedSessionIds(deps, )
  if (!materialized.has(sessionId)) return []
  try {
    return await readStoredEvents(deps.ctx, sessionId)
  } catch {
    return []
  }
}

/**
 * The Session behind one member slot: the Leader is the bound Harness
 * Session, every other member is its subagent.
 */
export function memberSessionId(deps: RoomDeps, conversation: TeamConversation, slotId: string): string | undefined {
  const team = deps.service.getTeam(conversation.teamId)
  if (slotId === team.leaderSlotId) return conversation.sessionId
  return conversation.memberSessions[slotId]
}

/**
 * A member's live state. A Session that is online reports its Agent status;
 * an offline one reports the last state this team recorded for the member.
 */
export function memberStatus(
  deps: RoomDeps,
  sessionId: string | undefined,
  lastRuntimeState: TeamMemberSlot['lastRuntimeState'],
): MemberConversationView['status'] {
  if (sessionId === undefined) return 'offline'
  const owned = deps.members.agentOf(sessionId)
  if (owned !== undefined) return owned.handle.agent.status
  const leader = deps.ctx.agents.get(SessionId(sessionId))
  if (leader !== undefined) return leader.status
  return lastRuntimeState
}

export async function storedSessionIds(deps: RoomDeps, ): Promise<Set<string>> {
  const snapshots = await deps.ctx.sessionPersistence.list()
  return new Set(snapshots.map(snapshot => String(snapshot.header.id)))
}

function roomRelayMessage(content: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: content }],
    source: { kind: 'plugin', plugin: 'dsh-squad', form: 'relay' },
  })
}