import { useEffect, useRef, useState } from 'react'
import {
  DisclosureRow,
  IconApiOutline14,
  IconBrowseOutline16,
  IconCloseOutline16,
  IconRightUpOutline16,
  IconCodeOutline16,
  IconEditOutline16,
  IconSearchOutline16,
  IconSparkle16,
  IconThinkOutline14,
  MarkdownText,
  StateDot,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AssistantView,
  ConversationNode,
  MemberConversationView,
  TeamView,
} from '../../transport/contracts.js'
import { callAgentTeam } from '../api.js'
import css from './ConversationColumn.module.css'
import { mergeConversationNodes } from '../conversation-nodes.js'
import { CrownIcon } from '../icons/CrownIcon.js'
import { memberStatusLabel } from '../labels.js'
import type { MemberModelLabel } from '../labels.js'
import {
  reasoningEffortLabel,
  useModelCapabilities,
} from '../model-reasoning.js'
import { ConversationNodeView } from './ConversationNodeView.js'
import { PendingInteractionCard } from './PendingInteractionCard.js'

export function ConversationColumn({
  team,
  conversationId,
  member,
  assistant,
  model,
  conversation,
  onLoadOlder,
  onSent,
  onOpenSession,
  expanded,
  onExpandedChange,
}: {
  team: TeamView
  /** Binding this column belongs to; the Session the team is enabled in. */
  conversationId: string
  member: TeamView['members'][string]
  /** The assistant this member runs, for its model capabilities. */
  assistant: AssistantView | undefined
  /**
   * How this column names its model: the Harness's own short display name, so
   * the header reads like the app's model selector instead of a long
   * `provider / model` route.
   */
  model: MemberModelLabel
  conversation: MemberConversationView | undefined
  /** Pull one older page of this member's Session, like the Harness does. */
  onLoadOlder: () => Promise<void>
  onSent: () => Promise<void>
  /**
   * Open this member's own Session, where the Harness composer addresses the
   * member alone. Absent for the Leader (this Session) and for a member that is
   * not running yet.
   */
  onOpenSession?: () => void
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}): JSX.Element {
  const modelCapabilities = useModelCapabilities(assistant?.provider ?? '', assistant?.model ?? '')
  const defaultReasoningEffort = modelCapabilities.value?.reasoning?.defaultEffort
  const reasoningModeLabel = member.reasoningEffort
    ? reasoningEffortLabel(modelCapabilities.value, member.reasoningEffort)
    : defaultReasoningEffort
      ? reasoningEffortLabel(modelCapabilities.value, defaultReasoningEffort)
      : '默认'
  const [pendingMessages, setPendingMessages] = useState<ConversationNode[]>([])
  const [loadingOlder, setLoadingOlder] = useState(false)
  /** Distance from the bottom, kept across an older page so the reader stays put. */
  const olderAnchor = useRef<number>()
  const timelineRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const visibleNodes = mergeConversationNodes(conversation?.nodes ?? [], pendingMessages)
  const pendingInteractions = conversation?.pendingInteractions ?? []
  const statusLabel = pendingInteractions.some(interaction => interaction.kind === 'approval')
    ? '等待审批'
    : pendingInteractions.length > 0
      ? '等待回答'
      : memberStatusLabel(conversation?.status ?? member.lastRuntimeState)

  useEffect(() => {
    const committedIds = new Set(conversation?.nodes.map(node => node.id) ?? [])
    setPendingMessages(current => {
      const next = current.filter(node => !committedIds.has(node.id))
      return next.length === current.length ? current : next
    })
  }, [conversation?.throughSeq])

  useEffect(() => {
    if (!stickToBottom.current) return
    const frame = requestAnimationFrame(() => {
      const timeline = timelineRef.current
      if (timeline !== null) timeline.scrollTop = timeline.scrollHeight
    })
    return () => { cancelAnimationFrame(frame) }
  }, [conversation?.throughSeq, pendingInteractions.length, pendingMessages.length])

  /** Page this member's history back, the way the Harness pages a Session. */
  async function loadOlder(): Promise<void> {
    const element = timelineRef.current
    if (element !== null) olderAnchor.current = element.scrollHeight - element.scrollTop
    setLoadingOlder(true)
    try {
      await onLoadOlder()
    } finally {
      setLoadingOlder(false)
    }
  }

  useEffect(() => {
    const element = timelineRef.current
    if (element === null || olderAnchor.current === undefined) return
    // A prepended page must not move what the reader was looking at.
    element.scrollTop = element.scrollHeight - olderAnchor.current
    olderAnchor.current = undefined
  }, [conversation?.oldestSeq])

  return (
    <section
      className={`${css.conversationColumn} ${expanded ? css.conversationColumnExpanded : ''}`}
      aria-label={`${member.displayName} 对话`}
      role={expanded ? 'dialog' : undefined}
      aria-modal={expanded || undefined}
    >
      <header
        className={css.columnHeader}
        title={expanded ? undefined : '双击放大对话'}
        onDoubleClick={() => { if (!expanded) onExpandedChange(true) }}
      >
        <div className={css.columnIdentity}>
          <span className={css.memberAvatar}>{member.displayName.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{member.displayName} {member.role === 'leader' && <CrownIcon size={15} className={css.leaderCrown} title="Leader" />}</strong>
            <div
              className={css.columnModelMeta}
              title={model.showEffort
                ? `${model.title} · 思考模式：${reasoningModeLabel}`
                : model.title}
            >
              <span className={css.columnModelName}>{model.name}</span>
              {model.showEffort && <span className={css.reasoningModeBadge}>{reasoningModeLabel}</span>}
            </div>
          </div>
        </div>
        <div className={css.columnHeaderActions}>
          <span className={css.columnStatus}>{statusLabel}</span>
          {onOpenSession !== undefined && (
            <Tooltip label="打开该成员的会话，单独给它发消息" side="bottom" delayMs={400}>
              <button
                type="button"
                className={css.columnOpenSession}
                aria-label={`打开 ${member.displayName} 的会话`}
                onDoubleClick={event => { event.stopPropagation() }}
                onClick={() => { onOpenSession() }}
              >
                <IconRightUpOutline16 size={16} />
              </button>
            </Tooltip>
          )}
          {expanded && (
            <Tooltip label="关闭放大对话" side="bottom" delayMs={400}>
              <button
                type="button"
                className={css.columnExpandClose}
                aria-label="关闭放大对话"
                onDoubleClick={event => { event.stopPropagation() }}
                onClick={() => { onExpandedChange(false) }}
              >
                <IconCloseOutline16 size={16} />
              </button>
            </Tooltip>
          )}
        </div>
      </header>
      <div
        className={css.timeline}
        ref={timelineRef}
        onScroll={event => {
          const timeline = event.currentTarget
          stickToBottom.current = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80
        }}
      >
        <div className={css.timelineInner}>
          {conversation?.hasMore === true && (
            <div className={css.timelineOlder}>
              <button type="button" disabled={loadingOlder} onClick={() => { void loadOlder() }}>
                {loadingOlder ? '加载中…' : '加载更早'}
              </button>
            </div>
          )}
          {visibleNodes.length === 0 && pendingInteractions.length === 0
            ? <div className={css.columnEmpty}>
              <span className={css.emptyAvatar}>{member.displayName.slice(0, 1).toUpperCase()}</span>
              <strong>{member.displayName}</strong>
              <span>{member.role === 'leader' ? '向 Leader 描述目标，由它组织团队协作。' : '等待 Leader 分配任务，或直接向该成员发送消息。'}</span>
            </div>
            : <>
              {visibleNodes.map(node => <ConversationNodeView key={node.id} node={node} />)}
              {pendingInteractions.map(interaction => (
                <PendingInteractionCard
                  key={interaction.id}
                  interaction={interaction}
                  awaitsLeader={member.role !== 'leader'}
                  onRespond={async response => {
                    await callAgentTeam('team.interaction.respond', {
                      teamId: team.id,
                      conversationId,
                      slotId: member.id,
                      interactionId: interaction.id,
                      response,
                    })
                    await onSent()
                  }}
                />
              ))}
            </>}
        </div>
      </div>
    </section>
  )
}

