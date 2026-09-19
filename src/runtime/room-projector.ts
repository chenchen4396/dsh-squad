import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { RoomMessageView } from '../transport/contracts.js'
import type { TeamAggregate, TeamMemberSlot, TeamMessage, TeamTask } from '../domain/types.js'
import { isRoomRelayText } from '../domain/team-selectors.js'
import { isRoomRelaySource } from './message-sources.js'
import { CONVERSATION_PAGE_SIZE, projectConversation, type ProjectedConversation } from './conversation-projector.js'

/** One member's log, as the room reads it. */
export interface RoomProjectionSource {
  member: Pick<TeamMemberSlot, 'id' | 'displayName' | 'role'>
  /**
   * Every event of the member's Session for this conversation. Sessions are
   * conversation-scoped now, so the whole log belongs to this room.
   */
  events: readonly SessionEvent[]
}

/**
 * The shared room: what every member of a team sees.
 *
 * Kept apart from the member projections because it answers a different
 * question. A member's column shows that member's own Session, while the room
 * shows what the team said to the reader and to each other — and it holds back
 * a turn a member has not finished writing, which a column does not do.
 */
/**
 * The turn a Session is inside right now, when one is still open.
 *
 * The open `turn/start` is what names the utterance a member has not finished
 * writing; the room holds that turn back until it ends.
 */
function runningTurn(events: readonly SessionEvent[]): number | undefined {
  let open: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') open = event.data.turn
    else if (event.type === 'turn/end') open = undefined
  }
  return open
}

/**
 * Task states a member is still expected to be working in.
 *
 * `blocked` counts as working: the task is not finished, and the member says so
 * through the task board, not through the room. Marking a task `completed`,
 * `failed` or `cancelled` is what lets its owner speak here again.
 */
const OPEN_TASK_STATUSES: readonly TeamTask['status'][] = ['pending', 'assigned', 'running', 'blocked']

/**
 * The stretches in which this conversation has work in flight.
 *
 * The room shows results, not the work: while a task is in flight the only
 * things that appear are the reader's own questions, the answers to them, and
 * the results that work produced. A window runs from a task's creation to the
 * moment it stops being open — the task's last update once it is done, or the
 * start of that owner's next task, so an abandoned `running` task cannot mute
 * the room for good.
 */
function busyWindows(
  tasks: Readonly<Record<string, TeamTask>> | undefined,
  conversationId: string | undefined,
): Array<{ from: number; to: number }> {
  const mine = Object.values(tasks ?? {}).filter(task =>
    task.conversationId === undefined || conversationId === undefined || task.conversationId === conversationId)
  const bySlot = new Map<string, TeamTask[]>()
  for (const task of mine) {
    const owners = task.ownerSlotIds.length > 0
      ? task.ownerSlotIds
      : task.ownerSlotId === undefined ? [] : [task.ownerSlotId]
    for (const slotId of owners) bySlot.set(slotId, [...(bySlot.get(slotId) ?? []), task])
  }
  const spans: Array<{ from: number; to: number }> = []
  for (const owned of bySlot.values()) {
    const ordered = [...owned].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    ordered.forEach((task, index) => {
      const next = ordered[index + 1]
      const done = OPEN_TASK_STATUSES.includes(task.status) ? undefined : Date.parse(task.updatedAt)
      spans.push({
        from: Date.parse(task.createdAt),
        to: done ?? (next === undefined ? Number.POSITIVE_INFINITY : Date.parse(next.createdAt)),
      })
    })
  }
  spans.sort((left, right) => left.from - right.from)
  const merged: Array<{ from: number; to: number }> = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last !== undefined && span.from <= last.to) last.to = Math.max(last.to, span.to)
    else merged.push({ ...span })
  }
  return merged
}

/**
 * Merge every participant's Session output with the durable conversation
 * messages into one time-ordered room timeline.
 *
 * The room is the reader's conversation, not a view of who is working: what
 * appears here is the reader's own messages, the turns they started, the results
 * a task delivered when the team was quiet, and nothing else. The process behind
 * an answer — reasoning, tool calls, the commentary between them, the task
 * board's own dispatches — belongs to the members' columns.
 */
export function projectRoom(
  team: Pick<TeamAggregate, 'leaderSlotId' | 'members' | 'retiredSessions' | 'tasks'>,
  sources: readonly RoomProjectionSource[],
  messages: readonly TeamMessage[],
  options: {
    /**
     * Show only entries older than this stamp. The room merges several member
     * Sessions plus the durable team mailbox, so its cursor is the oldest
     * rendered time rather than one Session's seq.
     */
    beforeTime?: number
    limit?: number
    /** Conversation this room belongs to; its own tasks are what gate speech. */
    conversationId?: string
  } = {},
): {
  messages: RoomMessageView[]
  throughSeq: number
  /** Stamp of the window's oldest entry; the cursor for the page before it. */
  oldestTime?: number
  /** Whether entries exist before the returned window. */
  hasMore: boolean
} {
  const limit = options.limit ?? CONVERSATION_PAGE_SIZE
  const beforeTime = options.beforeTime
  const inWindow = (time: number): boolean => beforeTime === undefined || time < beforeTime
  const room: RoomMessageView[] = []
  let throughSeq = -1
  /**
   * Whether the conversation had work in flight at that moment. While it did,
   * anything that is not an answer to the reader or a result is the team's own
   * process and stays out of the room.
   */
  const busy = busyWindows(team.tasks, options.conversationId)
  const busyAt = (time: number): boolean =>
    busy.some(window => time >= window.from && time < window.to)
  // A message has a durable room record when it came through the room itself;
  // the record is what the room shows, so its Session copy is skipped.
  const recorded = new Set(messages.map(message => message.id))
  // A wake-up relay carries the reader's own text, so the room recognises it by
  // the id of the event it injected rather than by what it says.
  const relayed = new Set(sources.flatMap(source => source.events.flatMap(event =>
    event.type === 'user/message' && isRoomRelaySource(event.data.source)
      ? [String(event.data.id)]
      : [])))

  for (const source of sources) {
    const events = beforeTime === undefined
      ? source.events
      : source.events.filter(event => event.time < beforeTime)
    const { nodes } = projectConversation(events, Number.MAX_SAFE_INTEGER, { team, messages })
    /**
     * The turn still in progress, if any. The room is a record of what was
     * said, not a live view of what is being said: a turn enters it only once
     * the member has stopped talking, so a reader never sees half an answer
     * that is about to be replaced.
     */
    const speaking = runningTurn(events)
    /**
     * One utterance per turn, keyed by turn.
     *
     * A turn is one interaction, and the model speaks between tool calls, so a
     * single turn carries a dozen assistant messages. The room keeps the turn's
     * last message that actually says something and drops the commentary that
     * led to it; that commentary stays in the member's own column.
     */
    const turns = new Map<string, RoomMessageView>()
    const order: string[] = []
    for (const node of nodes) {
      throughSeq = Math.max(throughSeq, node.seq)
      if (node.kind === 'assistant') {
        // A message with no text is the model calling a tool and nothing else:
        // it is not something the member said.
        if (node.text.trim().length === 0) continue
        if (node.turn !== undefined && node.turn === speaking) continue
        // A turn the reader's question started is always the room's business,
        // even while the team is busy with a task.
        if (node.fromReader !== true && busyAt(node.time)) continue
        const key = node.turn === undefined ? `message:${node.id}` : `turn:${node.turn}`
        if (!turns.has(key)) order.push(key)
        turns.set(key, {
          id: `${source.member.id}:${key}`,
          kind: 'agent',
          seq: node.seq,
          time: node.time,
          text: node.text,
          senderName: source.member.displayName,
          senderRole: source.member.role,
          senderSlotId: source.member.id,
          ...(node.reasoning === undefined ? {} : { reasoning: node.reasoning }),
        })
      } else if (node.kind === 'notice') {
        room.push({
          id: `${source.member.id}:${node.id}`,
          kind: 'notice',
          seq: node.seq,
          time: node.time,
          text: node.text,
          senderName: source.member.displayName,
          senderRole: source.member.role,
          senderSlotId: source.member.id,
        })
      } else if (node.kind === 'user' && !relayed.has(node.id) && !recorded.has(node.id) && !isRoomRelayText(node.text)) {
        // The user typed this one into the Harness composer, so the room shows
        // it beside every member's answer instead of leaving the discussion
        // one-sided. A relay the plugin injected is not the user's line: the
        // room shows that once, from the record the plugin wrote for it.
        room.push({
          id: node.id,
          kind: 'user',
          seq: node.seq,
          time: node.time,
          text: node.text,
          senderName: '你',
          senderRole: 'user',
        })
      }
    }
    for (const key of order) room.push(turns.get(key) as RoomMessageView)
  }

  for (const message of messages) {
    // The task board's own dispatches are not speech: an assignment notice and
    // its running status ticks are written by the board behind a member's back,
    // and the room would read them as if that member had said them. What the
    // member actually reports stays, because it carries no task reference.
    if (message.relatedTaskId !== undefined) continue
    const time = Date.parse(message.createdAt)
    if (!inWindow(time)) continue
    if (message.sender.kind === 'user') {
      room.push({
        id: message.id,
        kind: 'user',
        seq: -1,
        time,
        text: message.content,
        senderName: '你',
        senderRole: 'user',
        messageType: message.type,
        ...(message.mentions === undefined ? {} : { mentions: message.mentions }),
      })
      continue
    }
    if (message.sender.kind === 'system') {
      room.push({
        id: message.id,
        kind: 'system',
        seq: -1,
        time,
        text: message.content,
        senderName: '团队事件',
        senderRole: 'system',
        messageType: message.type,
      })
      continue
    }
    const member = team.members[message.sender.id]
    const retired = Object.values(team.retiredSessions)
      .find(session => session.formerSlotId === message.sender.id)
    // A member does not narrate its work in the room either, with one
    // exception: a `result` is what a task produced, and the room exists to
    // show those even when the member writes it before closing the task.
    if (message.type !== 'result' && busyAt(time)) continue
    room.push({
      id: message.id,
      kind: 'agent',
      seq: -1,
      time,
      text: message.content,
      senderName: member?.displayName ?? retired?.displayName ?? '已移出成员',
      senderRole: message.sender.id === team.leaderSlotId ? 'leader' : 'member',
      senderSlotId: message.sender.id,
      messageType: message.type,
    })
  }

  room.sort((left, right) => left.time - right.time || left.seq - right.seq)
  const window = room.slice(-limit)
  const oldest = window[0]
  return {
    messages: window,
    throughSeq,
    ...(oldest === undefined ? {} : { oldestTime: oldest.time }),
    hasMore: room.length > window.length,
  }
}

