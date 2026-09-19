import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { sandboxModeOf } from './sandbox-authority.js'
import type { AgentTeamService } from '../service/agent-team-service.js'
import type { TeamConversation } from '../domain/types.js'
import type { MemberRegistry } from './member-registry.js'
import type { TeamCommandHandler } from './team-command-handler.js'
import type { TeamInteractionBridge } from './team-interaction-bridge.js'
import { LEADER_ANSWER_TIMEOUT_MS } from './team-interaction-bridge.js'
import { memberRequestContent } from './team-messages.js'
import { withinLeaderAuthority } from './sandbox-authority.js'

/** How many times a hand-off is retried before the request is refused. */
const HANDOFF_ATTEMPTS = 3
/** Backoff between hand-off attempts, growing linearly per attempt. */
const HANDOFF_RETRY_MS = 500

/** What the relay needs to reach a Leader and settle what it cannot. */
export interface HandoffDeps {
  ctx: Context
  service: AgentTeamService
  commands: TeamCommandHandler
  interactions: TeamInteractionBridge
  members: MemberRegistry
  /** The Agent behind one member slot, when that conversation is online. */
  resolveAgent: (conversation: TeamConversation, slotId: string) => Agent | undefined
  /** Retry budget and answer window; overridable so a test need not wait. */
  options: { attempts?: number; retryMs?: number; answerWindowMs?: number }
}

/**
 * Handing a member's request to the Leader.
 *
 * A member cannot reach the reader, so a question or an approval it raises has
 * to be answered by the Leader. This is that relay: it watches the requests a
 * member is waiting on, tells the Leader about each one once, retries a
 * delivery the Host was too busy to take, and settles the request outright when
 * the Leader cannot be reached at all — because a member blocked on a question
 * nobody will answer is worse than one told no.
 *
 * It owns the set of requests already relayed, which is why it is an object
 * rather than four functions.
 */
export class HandoffRelay {
  /** Requests already told to the Leader, so none is sent twice. */
  private readonly handed = new Set<string>()

  constructor(private readonly deps: HandoffDeps) {}

relay(sessionId: string): void {
  const pending = new Set(this.deps.interactions.pendingIds())
  for (const id of [...this.handed]) {
    if (!pending.has(id)) this.handed.delete(id)
  }
  const owned = this.deps.members.agentOf(sessionId)
  if (owned === undefined) return
  const team = this.deps.service.getTeam(owned.teamId)
  const member = team.members[owned.slotId]
  const leader = this.deps.resolveAgent(
    this.deps.service.getConversation(owned.teamId, owned.conversationId),
    team.leaderSlotId,
  )
  if (member === undefined || leader === undefined) {
    // Nothing can be handed over right now. Refusing would deny a request the
    // Leader may well be able to grant once it exists again, so the request
    // stays pending — but the reason is logged, because a member stuck behind
    // an unanswerable request looks exactly like one that is still working.
    this.deps.ctx.logger.warn(
      `agent-team: member '${owned.slotId}' is waiting, but `
      + (member === undefined ? 'it is no longer a team member' : 'the Leader is not online'),
    )
    return
  }
  const leaderMode = this.leaderSandboxMode(owned.teamId, owned.conversationId)
  // «替我审批»: every request of this conversation is the Leader's to answer,
  // so none of them may be left waiting for the reader to click.
  const delegated = this.deps.service.getConversation(owned.teamId, owned.conversationId).delegateInteractions === true
  for (const interaction of this.deps.interactions.list(sessionId)) {
    if (this.handed.has(interaction.id)) continue
    this.handed.add(interaction.id)
    // A Leader answers only within the access it holds itself: a wider
    // request is the reader's, and the interface opens it right away.
    const beyondLeader = interaction.kind === 'approval'
      && !withinLeaderAuthority(leaderMode, interaction.requestedMode)
    if (delegated) {
      this.deps.interactions.markLeaderOnly(interaction.id)
      // Nobody could grant it either, so it is refused now instead of being
      // held for a card that will never open.
      if (beyondLeader) this.deps.interactions.refuse(interaction.id)
    } else if (beyondLeader) {
      this.deps.interactions.markUserOnly(interaction.id)
    }
    const content = memberRequestContent(member.displayName, interaction, { leaderMode, beyondLeader, delegated })
    // The member's wait is bounded: a request nobody answers is refused
    // rather than left to hang, which is the one outcome a member cannot
    // recover from.
    this.deps.interactions.armDeadline(
      interaction.id,
      this.deps.options.answerWindowMs ?? LEADER_ANSWER_TIMEOUT_MS,
    )
    void this.deliver({
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
private async deliver(handoff: {
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
  const attempts = this.deps.options.attempts ?? HANDOFF_ATTEMPTS
  const retryMs = this.deps.options.retryMs ?? HANDOFF_RETRY_MS
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await this.deps.commands.sendMemberMessage(
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
  this.handed.delete(handoff.interactionId)
  this.deps.ctx.logger.warn('agent-team: handing a member request to the Leader failed', lastError)
  this.refuseEvery(handoff.sessionId, `无法把请求转交给 Leader：${String(lastError)}`)
}
private refuseEvery(sessionId: string, reason: string): void {
  const waiting = this.deps.interactions.list(sessionId)
  if (waiting.length === 0) return
  this.deps.ctx.logger.warn(`agent-team: refusing ${waiting.length} waiting member request(s): ${reason}`)
  for (const interaction of waiting) {
    this.handed.delete(interaction.id)
    this.deps.interactions.refuse(interaction.id)
  }
}
/** The sandbox level the Leader itself runs at, read from its own Session. */
leaderSandboxMode(teamId: string, conversationId: string): string | undefined {
  const conversation = this.deps.service.getConversation(teamId, conversationId)
  if (conversation.sessionId === undefined) return undefined
  const agent = this.deps.ctx.agents.get(SessionId(conversation.sessionId))
  return agent === undefined ? undefined : sandboxModeOf(agent.session.snapshotEvents())
}
}
