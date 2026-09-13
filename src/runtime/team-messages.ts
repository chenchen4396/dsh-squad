import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { AgentTeamError } from '../domain/errors.js'
import type { TeamAggregate, TeamMessage } from '../domain/types.js'
import type { PendingInteractionView } from '../transport/contracts.js'

type TaskStatus = 'pending' | 'assigned' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled'

export function requireMessageContent(value: string): string {
  const content = value.trim()
  if (content.length === 0) throw new AgentTeamError('INVALID_REQUEST', 'Message content cannot be empty')
  if (content.length > 100_000) throw new AgentTeamError('INVALID_REQUEST', 'Message content is too large')
  return content
}

export function createTeamMessage(
  input: Omit<TeamMessage, 'schemaVersion' | 'attachments' | 'deliveryState' | 'createdAt'>,
): TeamMessage {
  return {
    schemaVersion: 1,
    ...input,
    attachments: [],
    deliveryState: 'queued',
    createdAt: new Date().toISOString(),
  }
}

export function createTaskDispatchMessage(input: {
  team: TeamAggregate
  conversationId: string
  senderSlotId: string
  recipientSlotId: string
  taskId: string
  type: 'instruction' | 'progress' | 'result' | 'question' | 'warning'
  content: string
}): TeamMessage {
  const id = String(MessageId(`agent-team:${randomUUID()}`))
  return createTeamMessage({
    id,
    teamId: input.team.id,
    conversationId: input.conversationId,
    sender: { kind: 'member', id: input.senderSlotId },
    recipient: input.recipientSlotId === input.team.leaderSlotId
      ? { kind: 'leader', slotId: input.recipientSlotId }
      : { kind: 'member', slotId: input.recipientSlotId },
    type: input.type,
    content: input.content,
    relatedTaskId: input.taskId,
    idempotencyKey: id,
  })
}

export function createSystemTeamMessage(input: {
  team: TeamAggregate
  conversationId?: string
  recipientSlotId: string
  content: string
}): TeamMessage {
  const id = String(MessageId(`agent-team:${randomUUID()}`))
  return createTeamMessage({
    id,
    teamId: input.team.id,
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    sender: { kind: 'system', id: 'dsh-squad' },
    recipient: input.recipientSlotId === input.team.leaderSlotId
      ? { kind: 'leader', slotId: input.recipientSlotId }
      : { kind: 'member', slotId: input.recipientSlotId },
    type: 'system',
    content: input.content,
    idempotencyKey: id,
  })
}

export function assignmentContent(
  title: string,
  description: string,
  fileScopes: readonly string[],
  collaborators: readonly string[] = [],
): string {
  return [
    `A team task has been assigned to you: ${title}`,
    description.length === 0 ? undefined : `Description: ${description}`,
    fileScopes.length === 0 ? undefined : `File scopes: ${fileScopes.join(', ')}`,
    collaborators.length === 0
      ? undefined
      : `You share this task with: ${collaborators.join(', ')}. Work on your part in parallel, do not edit files another owner is editing, and report with team_update_task.`,
    'Read the task board for the task id, mark it running when you begin, and report progress or the final result with team_update_task.',
  ].filter((line): line is string => line !== undefined).join('\n')
}

export function reassignmentContent(title: string, result?: string, error?: string): string {
  return [
    `A team task has been reassigned to you: ${title}`,
    result === undefined ? undefined : `Prior result: ${result}`,
    error === undefined ? undefined : `Prior error: ${error}`,
    'Read the task board for details and update the task with team_update_task.',
  ].filter((line): line is string => line !== undefined).join('\n')
}

export function taskUpdateContent(
  title: string,
  status: TaskStatus,
  result?: string,
  error?: string,
): string {
  return [
    `Task update: ${title}`,
    `Status: ${status}`,
    result === undefined ? undefined : `Result: ${result}`,
    error === undefined ? undefined : `Error: ${error}`,
  ].filter((line): line is string => line !== undefined).join('\n')
}

export function taskMessageType(status: TaskStatus): 'progress' | 'result' | 'question' | 'warning' {
  if (status === 'completed') return 'result'
  if (status === 'blocked') return 'question'
  if (status === 'failed' || status === 'cancelled') return 'warning'
  return 'progress'
}

/** What one team message says to its recipient, header and all. */
export function teamMessageText(team: TeamAggregate, record: TeamMessage): string {
  if (record.sender.kind === 'system') return `[Team event]\n${record.content}`
  if (record.sender.kind === 'user') return record.content
  const sender = team.members[record.sender.id]
  const retiredSender = Object.values(team.retiredSessions)
    .find(session => session.formerSlotId === record.sender.id)
  const senderName = sender?.displayName ?? retiredSender?.displayName ?? '已移出成员'
  return `${teamMessageHeader(senderName, record.sender.id)}\n${record.content}`
}

export function messageFromRecord(team: TeamAggregate, record: TeamMessage): UserMessage {
  return freezeMessage({
    id: MessageId(record.id),
    role: 'user',
    content: [{ type: 'text', text: teamMessageText(team, record) }],
    source: record.sender.kind === 'user'
      ? { kind: 'user' }
      : { kind: 'plugin', plugin: 'dsh-squad', form: 'relay' },
  })
}

/**
 * Several team messages as the one turn that carries them.
 *
 * A recipient that is busy takes no new turn, so the messages that arrived
 * while it worked are handed over together the moment it is free: one queued
 * item, one turn, every report in it. The batch keeps the first record's id so
 * the delivery stays identifiable in the Session.
 */
export function messagesFromRecords(team: TeamAggregate, records: readonly TeamMessage[]): UserMessage {
  if (records.length === 1) return messageFromRecord(team, records[0] as TeamMessage)
  return freezeMessage({
    id: MessageId(String((records[0] as TeamMessage).id)),
    role: 'user',
    content: [{ type: 'text', text: records.map(record => teamMessageText(team, record)).join('\n\n') }],
    source: { kind: 'plugin', plugin: 'dsh-squad', form: 'relay' },
  })
}

/**
 * The message that hands a member's request to the Leader.
 *
 * Members never reach the reader, so their question or sandbox escalation waits
 * for the Leader to answer it with `team_answer_member`; this is what tells the
 * Leader what is waiting, and what it has to name.
 */
export function memberRequestContent(
  displayName: string,
  interaction: PendingInteractionView,
  authority: {
    leaderMode?: string | undefined
    beyondLeader: boolean
    /** «替我审批» is on for this conversation: the user is never asked. */
    delegated?: boolean
  } = { beyondLeader: false },
): string {
  const lines = [
    `【${displayName} 需要你裁决】${interaction.kind === 'approval' ? '沙箱提权审批' : '提问'}`,
  ]
  if (interaction.kind === 'approval') {
    lines.push(`工具：${interaction.toolName}`)
    if (interaction.reason !== undefined) lines.push(`理由：${interaction.reason}`)
  } else {
    interaction.questions.forEach((question, index) => {
      lines.push(`问题 ${index + 1}/${interaction.questions.length}：${question.question}`)
      if (question.detail !== undefined) lines.push(`  说明：${question.detail}`)
      const options = question.options ?? []
      if (options.length > 0) lines.push(`  选项：${options.map(option => option.label).join('、')}`)
    })
  }
  // A request wider than the Leader's own level has no answerer at all under
  // «替我审批»: it is refused rather than handed over.
  const refused = authority.beyondLeader && authority.delegated === true
  if (interaction.kind === 'approval') {
    if (refused) {
      lines.push(
        `这超出你当前的权限（你：${authority.leaderMode ?? '未知'}，请求：${interaction.requestedMode ?? '未知'}）。`
        + '本会话开启了「替我审批」，超出你权限的请求不交给用户，已按拒绝处理——请改用你权限内的方案，'
        + '或让用户关掉「替我审批」后再试。',
      )
    } else if (authority.beyondLeader) {
      lines.push(
        `这超出你当前的权限（你：${authority.leaderMode ?? '未知'}，请求：${interaction.requestedMode ?? '未知'}），`
        + '只有用户能批准——插件已经把卡片直接开放给用户，你可以 deny，或在自己的回复里说明理由让用户决定。',
      )
    } else {
      lines.push(`你当前权限：${authority.leaderMode ?? '未知'}，本次请求：${interaction.requestedMode ?? '未知'}，在你权限之内。`)
    }
  }
  if (refused) {
    lines.push(`这一项已经结束（interactionId=${interaction.id}），不需要再回答。`)
    return lines.join('\n')
  }
  lines.push(
    `请用 team_answer_member 回答：interactionId=${interaction.id}`,
    interaction.kind === 'approval'
      ? '  decision=allow 同意，decision=deny 拒绝'
      : '  answers=[…] 按上面的问题顺序，答选项就写选项文字',
    authority.delegated === true
      ? '成员会一直卡到这一步。本会话开启了「替我审批」，用户不会介入，只有你能解开。'
      : '成员会一直卡到这一步；两分钟内没有答复，界面会把这张卡开放给用户直接处理。',
  )
  return lines.join('\n')
}

export function teamMessageHeader(displayName: string, slotId: string): string {
  return `[Team message from ${displayName}; slotId=${slotId}]`
}

export function sessionHasMessage(agent: Agent, messageId: string): boolean {
  return agent.session.snapshotEvents().some(event => {
    if (event.type !== 'agent/inbox/spliced') return false
    return event.data.inserted.some(message => String(message.id) === messageId)
  })
}
