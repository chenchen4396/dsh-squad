import type { AgentHandle, ModelSelectionRef } from '@deepseek-ai/dsh-agent'

/** One member Session this runtime owns, and where it belongs. */
export interface OwnedAgent {
  teamId: string
  conversationId: string
  slotId: string
  handle: AgentHandle
  modelSelection: ModelSelectionRef
}

/** The composition installed on one bound Session's own Agent. */
export interface LeaderAttachment {
  teamId: string
  conversationId: string
  slotId: string
  dispose: () => void
}

/** A Session being brought online, recorded before its Agent exists. */
export interface MemberActivation {
  teamId: string
  conversationId: string
  slotId: string
}

/**
 * Which live Session plays which part, and where.
 *
 * Three facts describe one thing: the members this runtime owns, the Leaders it
 * has attached to bound Sessions, and the members it is currently activating.
 * They were three maps on the runtime, reached into from forty places, so
 * nothing could say whether a Session was a member, a Leader, or neither
 * without reading three lookups in the right order.
 *
 * Keeping them together is what makes the questions answerable: `has` means
 * "this Session is ours in some form", `identityOf` means "which member is
 * this", and both consult all three in the order that matters — an owned
 * member, then an attached Leader, then one still being activated.
 */
export class MemberRegistry {
  private readonly members = new Map<string, OwnedAgent>()
  private readonly leaders = new Map<string, LeaderAttachment>()
  private readonly activations = new Map<string, MemberActivation>()

  /** Whether this Session is ours in any form. */
  has(sessionId: string): boolean {
    return this.members.has(sessionId) || this.leaders.has(sessionId)
  }

  /** The member behind a Session, when this runtime owns it. */
  agentOf(sessionId: string): OwnedAgent | undefined {
    return this.members.get(sessionId)
  }

  /** Which member a Session acts as, whether owned, Leader, or being activated. */
  identityOf(sessionId: string): { teamId: string; conversationId: string; slotId: string } | undefined {
    return this.members.get(sessionId) ?? this.leaders.get(sessionId) ?? this.activationOf(sessionId)
  }

  /** Every member Session this runtime owns. */
  agents(): OwnedAgent[] {
    return [...this.members.values()]
  }

  /** Every member Session this runtime owns, with its id. */
  agentsWithIds(): Array<[string, OwnedAgent]> {
    return [...this.members.entries()]
  }

  /** How many member Sessions this runtime owns. */
  memberCount(): number {
    return this.members.size
  }

  /** How many Sessions carry a Leader composition. */
  leaderCount(): number {
    return this.leaders.size
  }

  /** The member Sessions online for one member slot, across conversations. */
  agentsForSlot(teamId: string, slotId: string): OwnedAgent[] {
    return this.agents().filter(entry => entry.teamId === teamId && entry.slotId === slotId)
  }

  /** The member Sessions online for one team, across its conversations. */
  agentsInTeam(teamId: string): Array<[string, OwnedAgent]> {
    return this.agentsWithIds().filter(([, entry]) => entry.teamId === teamId)
  }

  /** Record a member Session as owned. */
  attach(sessionId: string, entry: OwnedAgent): void {
    this.members.set(sessionId, entry)
  }

  /** Forget a member Session, returning what was recorded for it. */
  detach(sessionId: string): OwnedAgent | undefined {
    const entry = this.members.get(sessionId)
    this.members.delete(sessionId)
    return entry
  }

  /** The composition attached to one Session's own Agent. */
  leaderOf(sessionId: string): LeaderAttachment | undefined {
    return this.leaders.get(sessionId)
  }

  /** Every Session carrying a Leader composition. */
  leaderIds(): string[] {
    return [...this.leaders.keys()]
  }

  attachLeader(sessionId: string, attachment: LeaderAttachment): void {
    this.leaders.set(sessionId, attachment)
  }

  detachLeader(sessionId: string): LeaderAttachment | undefined {
    const attachment = this.leaders.get(sessionId)
    this.leaders.delete(sessionId)
    return attachment
  }

  /** Note that a Session is being brought online, before its Agent exists. */
  beginActivation(sessionId: string, activation: MemberActivation): void {
    this.activations.set(sessionId, activation)
  }

  /** The activation in progress for a Session, when there is one. */
  activationOf(sessionId: string): MemberActivation | undefined {
    return this.activations.get(sessionId)
  }

  endActivation(sessionId: string): void {
    this.activations.delete(sessionId)
  }

  /** Drop every member record; used at shutdown. */
  clear(): void {
    this.members.clear()
  }
}
