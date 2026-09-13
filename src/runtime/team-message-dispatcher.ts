import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TeamAggregate, TeamMessage } from '../domain/types.js'
import type { AgentTeamService } from '../service/agent-team-service.js'
import { messageFromRecord, messagesFromRecords, sessionHasMessage } from './team-messages.js'

interface TeamMessageDispatcherPort {
  /** The recipient's Agent in one conversation, or undefined when it is not online. */
  resolveAgent: (teamId: string, conversationId: string, slotId: string) => Agent | undefined
  warn: (message: string, error: unknown) => void
}

interface Recipient {
  teamId: string
  conversationId: string
  slotId: string
}

interface Hold {
  recipient: Recipient
  records: TeamMessage[]
}

export class TeamMessageDispatcher {
  /**
   * Messages held for a recipient that is in the middle of a turn.
   *
   * DSH turns one follow-up into one queued item and then into one turn of its
   * own, so a busy recipient pays a whole turn per message: on a real team 1.8
   * messages arrived per minute while the Leader retired one queued turn per
   * minute, and its inbox grew by 30 items in half an hour — the Leader fell
   * further behind with every report. Holding the messages until the recipient
   * is free hands them over as a single turn instead, so the queue stays at one
   * item and that turn sees every report at once.
   */
  private readonly held = new Map<string, Hold>()
  /** One idle watch per recipient; it flushes whatever is held when it fires. */
  private readonly watching = new Set<string>()

  constructor(
    private readonly service: AgentTeamService,
    private readonly port: TeamMessageDispatcherPort,
  ) {}

  async recover(team: TeamAggregate): Promise<void> {
    for (const messageId of Object.keys(team.outbox)) {
      await this.deliver(team.id, messageId)
    }
    team = this.service.getTeam(team.id)
    const pending = this.service.listMessages(team.id).items.filter(message => message.deliveryState === 'queued')
    for (const record of pending) {
      const slotId = record.recipient.slotId
      const conversationId = record.conversationId
      if (slotId === undefined || conversationId === undefined) {
        await this.service.putRuntimeMessage({ ...record, deliveryState: 'failed' })
        continue
      }
      const agent = this.port.resolveAgent(team.id, conversationId, slotId)
      // A conversation that is not online yet keeps its mail queued rather than
      // failing it; switching to that conversation will deliver it.
      if (agent === undefined) continue
      if (!sessionHasMessage(agent, record.id)) agent.followup(messageFromRecord(team, record))
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'delivered' })
    }
  }

  async deliver(teamId: string, messageId: string): Promise<boolean> {
    const current = this.service.getTeam(teamId)
    const record = current.outbox[messageId]
    if (record === undefined) return true
    const slotId = record.recipient.slotId
    const conversationId = record.conversationId
    if (slotId === undefined || conversationId === undefined) {
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'failed' })
      return false
    }
    if (current.members[slotId] === undefined) {
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'failed' })
      return false
    }
    try {
      // Re-write queued before every retry so the durable message table reflects
      // that the aggregate outbox still owns delivery.
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'queued' })
      const agent = this.port.resolveAgent(teamId, conversationId, slotId)
      // Leave the message in the outbox so a later recovery can still deliver it.
      if (agent === undefined) return false
      // A busy recipient takes no new turn: hold the message for the one it will
      // take when it is free. It stays queued, so recovery still owns it. Only a
      // reported `running` counts — an Agent that does not say otherwise is
      // ready, and holding for it would delay mail for no reason.
      if (agent.status === 'running') {
        this.hold({ teamId, conversationId, slotId }, record)
        return false
      }
      if (!sessionHasMessage(agent, record.id)) agent.followup(messageFromRecord(current, record))
      await this.markDelivered(teamId, record)
      return true
    } catch (error) {
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'failed' })
      this.port.warn(`agent-team: queued message ${messageId} delivery failed`, error)
      return false
    }
  }

  private hold(recipient: Recipient, record: TeamMessage): void {
    const key = recipientKey(recipient)
    const hold = this.held.get(key) ?? { recipient, records: [] }
    /**
     * One task's later update replaces its earlier one.
     *
     * A task is reported repeatedly — a real board carried twelve completions
     * of the same task — and only its latest state tells the recipient
     * anything; the replaced update is dropped as delivered, because the one
     * that superseded it already carries the newer result.
     */
    const superseded = record.relatedTaskId === undefined
      ? []
      : hold.records.filter(held => held.relatedTaskId === record.relatedTaskId)
    hold.records = [
      ...hold.records.filter(held => !superseded.includes(held)),
      record,
    ]
    this.held.set(key, hold)
    for (const dropped of superseded) {
      void this.markDelivered(recipient.teamId, dropped).catch(error => {
        this.port.warn('agent-team: retiring a superseded team message failed', error)
      })
    }
    this.watch(key)
  }

  /** Wait for the recipient's current turn to end, then hand the batch over. */
  private watch(key: string): void {
    if (this.watching.has(key)) return
    const hold = this.held.get(key)
    if (hold === undefined) return
    const agent = this.resolve(hold.recipient)
    if (agent === undefined) return
    this.watching.add(key)
    void agent.whenIdle()
      .then(() => this.flush(key))
      .catch(error => {
        this.watching.delete(key)
        this.port.warn('agent-team: waiting to deliver held team messages failed', error)
      })
  }

  private async flush(key: string): Promise<void> {
    this.watching.delete(key)
    const hold = this.held.get(key)
    if (hold === undefined) return
    this.held.delete(key)
    const agent = this.resolve(hold.recipient)
    if (agent === undefined) {
      this.held.set(key, hold)
      this.watch(key)
      return
    }
    try {
      agent.followup(messagesFromRecords(this.service.getTeam(hold.recipient.teamId), hold.records))
      for (const record of hold.records) await this.markDelivered(hold.recipient.teamId, record)
    } catch (error) {
      this.held.set(key, hold)
      this.watch(key)
      this.port.warn('agent-team: delivering held team messages failed', error)
    }
  }

  private resolve(recipient: Recipient): Agent | undefined {
    return this.port.resolveAgent(recipient.teamId, recipient.conversationId, recipient.slotId)
  }

  private async markDelivered(teamId: string, record: TeamMessage): Promise<void> {
    await this.service.putRuntimeMessage({ ...record, deliveryState: 'delivered' })
    await this.service.updateRuntimeTeam(
      teamId,
      team => {
        if (team.outbox[record.id] === undefined) return team
        const outbox = { ...team.outbox }
        delete outbox[record.id]
        return { ...team, outbox }
      },
      'team.message_delivered',
      `Team message ${record.id} delivered`,
    )
  }
}

function recipientKey(recipient: Recipient): string {
  return `${recipient.teamId}:${recipient.conversationId}:${recipient.slotId}`
}
