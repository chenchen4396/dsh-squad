import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isRoomRelayText } from '../domain/team-selectors.js'
import { isReaderSource, isRoomRelaySource, isVisibleUserSource } from './message-sources.js'
import type { TeamAggregate, TeamMemberSlot, TeamMessage, TeamTask } from '../domain/types.js'
import type { ConversationNode, MemberConversationView, RoomMessageView } from '../transport/contracts.js'

interface TeamProjectionContext {
  team: Pick<TeamAggregate, 'leaderSlotId' | 'members' | 'retiredSessions'>
  messages: readonly TeamMessage[]
  /**
   * Drop wake-up relays from the projection. The Leader's transcript is the
   * Session the user types into, so a relay an earlier bug appended there is
   * already represented by the message the user wrote.
   */
  hideRelayEchoes?: boolean
}

export function projectContextUsage(
  events: readonly SessionEvent[],
): MemberConversationView['contextUsage'] {
  let latestUsage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  } | undefined
  let contextWindow: number | undefined

  for (const event of events) {
    if (event.type === 'request/context') contextWindow = event.data.contextWindow

    const usage = event.type === 'assistant/message' ? event.data.usage : undefined
    if (usage !== undefined) latestUsage = usage
  }

  if (latestUsage === undefined) return undefined
  const cacheReadTokens = latestUsage.cacheReadTokens ?? 0
  const cacheWriteTokens = latestUsage.cacheWriteTokens ?? 0
  const inputTokens = latestUsage.inputTokens + cacheReadTokens + cacheWriteTokens
  const outputTokens = latestUsage.outputTokens
  return {
    usedTokens: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: latestUsage.reasoningTokens ?? 0,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  }
}

/**
 * How many transcript nodes one page holds.
 *
 * Mirrors the Harness's own history page (50 messages): the view opens on the
 * newest page and pulls earlier ones on demand, instead of laying out the whole
 * Session as one endless scrollback.
 */
export const CONVERSATION_PAGE_SIZE = 50

/** One conversation's transcript: the window, and where it sits in the log. */
export interface ProjectedConversation {
  throughSeq: number
  nodes: ConversationNode[]
  /** Seq of the window's oldest node; the cursor for the page before it. */
  oldestSeq?: number
  /** Whether nodes exist before the returned window. */
  hasMore: boolean
}

export function projectConversation(
  events: readonly SessionEvent[],
  limit = CONVERSATION_PAGE_SIZE,
  teamContext?: TeamProjectionContext,
): ProjectedConversation {
  const nodes: ConversationNode[] = []
  const tools = new Map<string, number>()
  const teamMessages = new Map(teamContext?.messages.map(message => [message.id, message]) ?? [])
  // The reader's own lines, used to recognise an older build's unmarked relay.
  const readerLines = new Set(
    (teamContext?.messages ?? [])
      .filter(message => message.sender.kind === 'user')
      .map(message => message.content.trim()),
  )
  /**
   * Whether the reader's own input opened each turn. The room shows what a
   * member answers and what the team delivers, so it needs to know which turns
   * a reader question started and which ones the team's own traffic did.
   *
   * `turn/start` is written before the loop claims the input that the turn
   * runs on, so the turn's input is what follows it, not what precedes it.
   */
  const turnFromReader = new Map<number, boolean>()
  let openTurn: number | undefined

  for (const event of events) {
    switch (event.type) {
      case 'turn/start': {
        openTurn = event.data.turn
        turnFromReader.set(openTurn, false)
        break
      }
      case 'turn/end': {
        openTurn = undefined
        break
      }
      case 'user/message': {
        // Tracked before any skip: what opened the turn is what counts, whether
        // or not the message itself is drawn.
        if (openTurn !== undefined
          && isReaderSource(event.data.source, textOfContent(event.data.content), readerLines)) {
          turnFromReader.set(openTurn, true)
        }
        if (!isVisibleUserSource(event.data.source)) break
        const text = textOfContent(event.data.content)
        // The owning Session keeps what the reader typed; a relay copy of it —
        // current or from a version that decorated the text — is not their line.
        if (teamContext?.hideRelayEchoes === true
          && (isRoomRelaySource(event.data.source) || isRoomRelayText(text))) break
        if (text.length > 0) {
          const messageId = String(event.data.id)
          const teamMessage = teamMessages.get(messageId)
          if (teamContext !== undefined && teamMessage !== undefined && teamMessage.sender.kind !== 'user') {
            nodes.push(teamMessageNode(teamContext.team, teamMessage, event.seq, event.time))
          } else {
            nodes.push({
              id: messageId,
              kind: 'user',
              seq: event.seq,
              time: event.time,
              text,
            })
          }
        }
        break
      }
      case 'assistant/message': {
        const text = textOfContent(event.data.message.content)
        const reasoning = reasoningOf(event.data.message.content)
        if (text.length > 0 || reasoning.length > 0) nodes.push({
          id: String(event.data.message.id),
          kind: 'assistant',
          seq: event.seq,
          time: event.time,
          text,
          turn: event.data.turn,
          fromReader: openTurn !== undefined && turnFromReader.get(openTurn) === true,
          ...(reasoning.length === 0 ? {} : { reasoning }),
        })
        break
      }
      case 'tool/call': {
        const callId = String(event.data.callId)
        tools.set(callId, nodes.length)
        nodes.push({
          id: `tool:${callId}`,
          kind: 'tool',
          seq: event.seq,
          time: event.time,
          callId,
          name: event.data.name,
          arguments: event.data.arguments,
          status: 'running',
        })
        break
      }
      case 'tool/result': {
        const callId = String(event.data.message.content[0].toolCallId)
        const index = tools.get(callId)
        const result = textOfContent(event.data.message.content[0].content)
        const error = event.data.error === undefined
          ? undefined
          : `${event.data.error.name}: ${event.data.error.code}`
        if (index !== undefined) {
          const node = nodes[index]
          if (node?.kind === 'tool') nodes[index] = {
            ...node,
            seq: event.seq,
            status: event.data.message.content[0].isError === true || error !== undefined ? 'error' : 'success',
            ...(result.length === 0 ? {} : { result }),
            ...(error === undefined ? {} : { error }),
          }
        } else {
          nodes.push({
            id: `tool:${callId}`,
            kind: 'tool',
            seq: event.seq,
            time: event.time,
            callId,
            name: 'tool',
            arguments: '',
            status: event.data.message.content[0].isError === true || error !== undefined ? 'error' : 'success',
            ...(result.length === 0 ? {} : { result }),
            ...(error === undefined ? {} : { error }),
          })
        }
        break
      }
      case 'turn/end': {
        if (event.data.reason.kind === 'error') nodes.push({
          id: `turn-error:${event.seq}`,
          kind: 'notice',
          seq: event.seq,
          time: event.time,
          tone: 'error',
          text: event.data.reason.error.message,
        })
        if (event.data.reason.kind === 'max-tokens') nodes.push({
          id: `turn-warning:${event.seq}`,
          kind: 'notice',
          seq: event.seq,
          time: event.time,
          tone: 'warning',
          text: '本轮输出已达到模型长度上限。',
        })
        break
      }
    }
  }

  nodes.sort((left, right) => left.seq - right.seq)
  const window = nodes.slice(-limit)
  const oldest = window[0]
  return {
    throughSeq: events.at(-1)?.seq ?? -1,
    nodes: window,
    ...(oldest === undefined ? {} : { oldestSeq: oldest.seq }),
    hasMore: nodes.length > window.length,
  }
}

function teamMessageNode(
  team: TeamProjectionContext['team'],
  message: TeamMessage,
  seq: number,
  time: number,
): Extract<ConversationNode, { kind: 'team-message' }> {  if (message.sender.kind === 'system') {
    return {
      id: message.id,
      kind: 'team-message',
      seq,
      time,
      text: message.content,
      senderName: '团队事件',
      senderId: message.sender.id,
      senderRole: 'system',
      messageType: message.type,
      ...(message.relatedTaskId === undefined ? {} : { relatedTaskId: message.relatedTaskId }),
    }
  }
  const current = team.members[message.sender.id]
  const retired = Object.values(team.retiredSessions)
    .find(session => session.formerSlotId === message.sender.id)
  return {
    id: message.id,
    kind: 'team-message',
    seq,
    time,
    text: message.content,
    senderName: current?.displayName ?? retired?.displayName ?? '已移出成员',
    senderId: message.sender.id,
    senderRole: message.sender.id === team.leaderSlotId ? 'leader' : 'member',
    messageType: message.type,
    ...(message.relatedTaskId === undefined ? {} : { relatedTaskId: message.relatedTaskId }),
  }
}


/**
 * Plain text of one content-block list, with images and tool results folded in
 * the way the transcript shows them.
 *
 * @param blocks - model-facing content blocks.
 * @returns the joined text.
 */
export function textOfContent(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => {
    if (block.type === 'text') return [block.text]
    if (block.type === 'tool-result') return [textOfContent(block.content)]
    if (block.type === 'image') return ['[图片]']
    return []
  }).filter(Boolean).join('\n')
}

function reasoningOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => block.type === 'reasoning' ? [block.text] : []).join('\n')
}

/** One member's contribution window inside a task conversation. */
