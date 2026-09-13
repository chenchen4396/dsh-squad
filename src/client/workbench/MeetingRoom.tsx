import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ConversationView,
  RoomMessageView,
  RoomView,
  TeamView,
} from '../../transport/contracts.js'
import { callAgentTeam, subscribeAgentTeam, subscribeAgentTeamConversation } from '../api.js'
import { PendingInteractionCard } from './PendingInteractionCard.js'
import { mergeRoomView, prependRoomPage } from '../conversation-nodes.js'
import { markdownLabels } from '../native-locale.js'
import { blankConversationLabel } from '../native-locale.js'
import type { PendingAction } from '../pending-actions.js'
import { roomSpeech } from '../room-feed.js'
import { cacheRoom, cachedRoom } from '../view-cache.js'
import css from '../AgentTeam.module.css'

function clockOf(time: number): string {
  return new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/**
 * A message the user sent. It sits on the right in the Harness's own bubble,
 * the way every chat client draws the reader's own turn.
 */
function UserMessageRow({ message }: { message: RoomMessageView }): JSX.Element {
  return (
    <li className={css.roomTurn} data-self="true">
      <div className={css.roomBubble}>{message.text}</div>
      <time className={css.roomBubbleTime}>{clockOf(message.time)}</time>
    </li>
  )
}

/**
 * What a member said, drawn as one chat bubble: the member's avatar, the name
 * line that opens its column, and the answer. The room is the team's
 * conversation, so reasoning and tool calls stay out of it — the column behind
 * the name button is where a reader goes for the process.
 */
function AgentMessageRow({
  message,
  onOpenMember,
}: {
  message: RoomMessageView
  onOpenMember: (slotId: string) => void
}): JSX.Element {
  const slotId = message.senderSlotId

  return (
    <li className={css.roomTurn}>
      <span className={css.roomAgentAvatar} aria-hidden="true">
        {message.senderName.slice(0, 1).toLocaleUpperCase()}
      </span>
      <div className={css.roomAgentColumn}>
        <div className={css.roomAgentHeader}>
          {slotId === undefined
            ? <strong className={css.roomAgentName}>{message.senderName}</strong>
            : (
                <button
                  type="button"
                  className={css.roomAgentNameButton}
                  title={`查看 ${message.senderName} 的执行详情`}
                  onClick={() => { onOpenMember(slotId) }}
                >
                  {message.senderName}
                </button>
              )}
          {message.senderRole === 'leader' && <span className={css.roomAgentBadge}>Leader</span>}
          {message.streaming === true && <span className={css.roomStreamingPulse} aria-label="正在输出" />}
          <time className={css.roomAgentTime}>{clockOf(message.time)}</time>
        </div>
        <div className={css.roomAgentBubble}>
          <MarkdownText
            text={message.text}
            {...(message.streaming === true ? { streaming: true } : {})}
            labels={markdownLabels()}
          />
        </div>
      </div>
    </li>
  )
}

/** The team's shared meeting room: one time-ordered discussion across members. */
export function MeetingRoom({
  team,
  conversationId,
  conversation,
  pendingActions,
  onOpenMember,
  onChanged,
}: {
  team: TeamView
  /** Binding this room shows; the Session the team is enabled in. */
  conversationId: string
  conversation: ConversationView | undefined
  /**
   * Members blocked on a question or an approval. The room shows them at the
   * top: a member that waits for the reader looks exactly like one that is
   * working, so without this the team reads as stuck with nothing to answer.
   */
  pendingActions: readonly PendingAction[]
  onOpenMember: (slotId: string) => void
  onChanged: () => Promise<void>
}): JSX.Element {
  // A cached read paints what the reader just left; the load below refreshes it.
  const [room, setRoom] = useState<RoomView | undefined>(() => cachedRoom(team.id, conversationId))
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [error, setError] = useState<string>()
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  /** Distance from the bottom, kept across an older page so the reader stays put. */
  const olderAnchor = useRef<number>()

  const load = useCallback(async () => {
    try {
      const view = await callAgentTeam('team.room.get', { teamId: team.id, conversationId })
      setRoom(current => {
        const merged = mergeRoomView(current, view)
        cacheRoom(merged)
        return merged
      })
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [team.id, conversationId])

  /** Page the room's history back, the way the Harness pages a Session. */
  async function loadOlder(): Promise<void> {
    const beforeTime = room?.oldestTime
    if (beforeTime === undefined) return
    const element = scrollRef.current
    if (element !== null) olderAnchor.current = element.scrollHeight - element.scrollTop
    setLoadingOlder(true)
    try {
      const page = await callAgentTeam('team.room.older', {
        teamId: team.id,
        conversationId,
        beforeTime,
      })
      setRoom(current => {
        if (current === undefined) return current
        const merged = prependRoomPage(current, page)
        cacheRoom(merged)
        return merged
      })
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoadingOlder(false)
    }
  }

  useEffect(() => {
    const element = scrollRef.current
    if (element === null || olderAnchor.current === undefined) return
    // A prepended page must not move what the reader was looking at.
    element.scrollTop = element.scrollHeight - olderAnchor.current
    olderAnchor.current = undefined
  }, [room?.oldestTime])

  /**
   * Reload the room at most this often.
   *
   * A running team publishes a member's conversation many times a second, and
   * the room is a merge over every member's Session: reloading it per publish
   * kept the Host reading all of them. A quarter second is still live for a
   * reader, at a fraction of the reads.
   */
  const ROOM_RELOAD_MS = 250
  const reloadTimer = useRef<ReturnType<typeof setTimeout>>()
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current !== undefined) return
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = undefined
      void load()
    }, ROOM_RELOAD_MS)
  }, [load])

  useEffect(() => { void load() }, [load, team.revision])
  useEffect(() => {
    const timer = reloadTimer
    return () => { if (timer.current !== undefined) clearTimeout(timer.current) }
  }, [])
  useEffect(
    () => subscribeAgentTeamConversation(team.id, () => { scheduleReload() }, () => undefined),
    [scheduleReload, team.id],
  )
  useEffect(
    () => subscribeAgentTeam(
      kinds => {
        // Member turns arrive through the conversation channel above; this one
        // only needs the events that can change the team itself.
        if ([...kinds].some(kind => kind === 'team')) scheduleReload()
      },
      () => undefined,
    ),
    [scheduleReload],
  )

  useEffect(() => {
    const element = scrollRef.current
    if (element === null || !stickToBottom.current) return
    element.scrollTop = element.scrollHeight
  }, [room])

  const messages = room?.messages ?? []
  const speech = useMemo(() => roomSpeech(messages), [messages])

  return (
    <div className={css.room}>
      <div className={css.roomDigestBar}>
        <span>{speech.length} 条发言</span>
        <span className={css.roomDigestHint}>点击成员名称查看其执行详情</span>
      </div>

      {pendingActions.length > 0 && (
        <div className={css.roomActions} role="status">
          <p className={css.roomActionsHint}>
            下面这些请求在等**你**：成员卡在这里，它的一轮不会结束。批准只对这一次生效；
            要让某个成员长期可写，去工作台改它的权限预设（或改助手模板的默认权限）。
          </p>
          {pendingActions.map(action => (
            <PendingInteractionCard
              key={action.interaction.id}
              interaction={action.interaction}
              memberName={action.displayName}
              awaitsLeader
              onRespond={async response => {
                await callAgentTeam('team.interaction.respond', {
                  teamId: team.id,
                  conversationId,
                  slotId: action.slotId,
                  interactionId: action.interaction.id,
                  response,
                })
                await onChanged()
              }}
            />
          ))}
        </div>
      )}

      {error !== undefined && <div role="alert" className={css.workbenchError}>{error}</div>}

      <div
        className={css.roomTimeline}
        ref={scrollRef}
        onScroll={event => {
          const element = event.currentTarget
          stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40
        }}
      >
        {room?.hasMore === true && (
          <div className={css.roomOlder}>
            <button type="button" disabled={loadingOlder} onClick={() => { void loadOlder() }}>
              {loadingOlder ? '加载中…' : '加载更早'}
            </button>
          </div>
        )}
        {speech.length === 0
          ? (
              <div className={css.roomEmpty}>
                <strong>这是「{conversation === undefined || conversation.title === '' ? blankConversationLabel() : conversation.title}」的开始。</strong>
                <span>用下方 Harness 的输入框发言；输入 @ 选择成员，被提及的成员会收到这条消息并在这里回应。</span>
              </div>
            )
          : (
              <ul className={css.roomFeed}>
                {speech.map(message => message.senderRole === 'user'
                  ? <UserMessageRow key={message.id} message={message} />
                  : (
                      <AgentMessageRow
                        key={message.id}
                        message={message}
                        onOpenMember={onOpenMember}
                      />
                    ))}
              </ul>
            )}
      </div>

    </div>
  )
}
