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
import { markdownLabels } from '../native-locale.js'
import css from './ConversationColumn.module.css'
import { mergeConversationNodes } from '../conversation-nodes.js'
import { CrownIcon } from '../icons/CrownIcon.js'
import { memberStatusLabel } from '../labels.js'
import type { MemberModelLabel } from '../labels.js'
import {
  reasoningEffortLabel,
  useModelCapabilities,
} from '../model-reasoning.js'
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

export function ConversationNodeView({ node }: { node: ConversationNode }): JSX.Element {
  if (node.kind === 'tool') return <ToolCard node={node} />
  if (node.kind === 'notice') return <div className={`${css.noticeNode} ${node.tone === 'error' ? css.noticeError : ''}`}>{node.text}</div>
  if (node.kind === 'team-message') return <TeamMessageCard node={node} />
  return (
    <article className={`${css.messageNode} ${node.kind === 'user' ? css.userMessage : css.assistantMessage}`}>
      {node.reasoning && (
        <ReasoningBlock node={node} />
      )}
      {node.text && (node.kind === 'assistant'
        ? (
            <div className={css.messageText}>
              <MarkdownText text={node.text} streaming={node.streaming === true} labels={markdownLabels()} />
            </div>
          )
        : <p className={css.userText}>{node.text}</p>)}
      {node.streaming && <span className={css.streamingMark}>生成中…</span>}
    </article>
  )
}

/** The collapsed summary the Harness prints beside the Think title. */
function reasoningSummary(reasoning: string): string {
  const newline = reasoning.indexOf('\n')
  return (newline === -1 ? reasoning : reasoning.slice(0, newline)).replaceAll('**', '')
}

function ReasoningBlock({
  node,
}: {
  node: Extract<ConversationNode, { kind: 'user' | 'assistant' }>
}): JSX.Element {
  const reasoning = node.reasoning ?? ''
  const reasoningRunning = node.reasoningStartedAt !== undefined
    && node.reasoningCompletedAt === undefined
    && node.streaming === true
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!reasoningRunning) return
    setNow(Date.now())
    const timer = window.setInterval(() => { setNow(Date.now()) }, 200)
    return () => { window.clearInterval(timer) }
  }, [reasoningRunning])

  const elapsed = node.reasoningStartedAt === undefined
    ? undefined
    : Math.max(0, (node.reasoningCompletedAt ?? now) - node.reasoningStartedAt)
  const timing = elapsed === undefined
    ? undefined
    : reasoningRunning
      ? `思考中 · ${formatElapsedTime(elapsed)}`
      : `用时 ${formatElapsedTime(elapsed)}`

  return (
    <DisclosureRow
      className={`${css.reasoningBlock} ${expanded ? css.reasoningBlockOpen : ''}`}
      icon={<IconThinkOutline14 size={14} />}
      title="思考"
      open={expanded}
      expandable
      expandOnRowClick
      previewChevron
      onToggle={() => { setExpanded(value => !value) }}
      collapsedContent={(
        <>
          <span className={css.reasoningSep} aria-hidden="true" />
          <span className={css.reasoningSummary}>{reasoningSummary(reasoning)}</span>
          {timing !== undefined && <span className={css.reasoningTime}>{timing}</span>}
        </>
      )}
    >
      <div className={css.reasoningText}>{reasoning}</div>
    </DisclosureRow>
  )
}

function formatElapsedTime(milliseconds: number): string {
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} 秒`
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.floor((milliseconds % 60_000) / 1_000)
  return `${minutes} 分 ${seconds} 秒`
}

const TEAM_MESSAGE_TYPE_LABELS: Record<Extract<ConversationNode, { kind: 'team-message' }>['messageType'], string> = {
  instruction: '指令',
  progress: '进度',
  result: '结果',
  question: '问题',
  warning: '警告',
  system: '系统',
}

function TeamMessageCard({ node }: { node: Extract<ConversationNode, { kind: 'team-message' }> }): JSX.Element {
  const toneClass = node.messageType === 'result'
    ? css.teamMessageResult
    : node.messageType === 'question'
      ? css.teamMessageQuestion
      : node.messageType === 'warning'
        ? css.teamMessageWarning
        : node.messageType === 'instruction'
          ? css.teamMessageInstruction
          : node.messageType === 'system'
            ? css.teamMessageSystem
            : css.teamMessageProgress
  const category = node.senderRole === 'leader'
    ? 'Leader 消息'
    : node.senderRole === 'system'
      ? '团队事件'
      : '成员反馈'
  return (
    <article className={`${css.teamMessageCard} ${toneClass}`}>
      <header className={css.teamMessageHeader}>
        <span className={css.teamMessageIdentity}>
          <strong>{category}</strong>
          {node.senderRole !== 'system' && <span>{node.senderName}</span>}
          {node.senderRole !== 'system' && (
            <code className={css.teamMessageMemberId} title={`成员 ID：${node.senderId}`}>
              ID {shortMemberId(node.senderId)}
            </code>
          )}
        </span>
        <span className={css.teamMessageType}>{TEAM_MESSAGE_TYPE_LABELS[node.messageType]}</span>
      </header>
      <div className={css.teamMessageText}><MarkdownText text={node.text} labels={markdownLabels()} /></div>
    </article>
  )
}

function shortMemberId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

type ToolVariant = 'bash' | 'read' | 'search' | 'write' | 'edit' | 'code' | 'others'

/** Tool name to row variant, copied from the Harness's own Tool presentation. */
const TOOL_VARIANTS: Record<string, ToolVariant> = {
  bash: 'bash',
  pwsh: 'bash',
  read: 'read',
  read_image: 'read',
  web_fetch: 'read',
  web_search: 'search',
  grep: 'search',
  glob: 'search',
  write: 'write',
  edit: 'edit',
  run_code: 'code',
}

/** Variant leading glyphs, one for one with the Harness's own table. */
const TOOL_ICONS: Record<ToolVariant, JSX.Element> = {
  bash: <IconApiOutline14 size={14} />,
  read: <IconBrowseOutline16 size={14} />,
  search: <IconSearchOutline16 size={14} />,
  write: <IconEditOutline16 size={14} />,
  edit: <IconEditOutline16 size={14} />,
  code: <IconCodeOutline16 size={14} />,
  others: <IconSparkle16 size={14} />,
}

/** Summary key preference per variant, copied from the Harness's own Tool row. */
const TOOL_SUMMARY_KEYS: Record<ToolVariant, readonly string[]> = {
  bash: ['description', 'command'],
  read: ['path', 'file_path', 'url'],
  search: ['query', 'pattern', 'url'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  code: ['description'],
  others: [],
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

function parsedArguments(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** The row's one-line summary: the argument the Harness itself would show. */
function toolSummary(node: Extract<ConversationNode, { kind: 'tool' }>): string {
  const args = parsedArguments(node.arguments)
  if (args === undefined) return firstLine(node.arguments)
  for (const key of TOOL_SUMMARY_KEYS[TOOL_VARIANTS[node.name] ?? 'others']) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return firstLine(value)
  }
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value !== '') return firstLine(value)
  }
  return firstLine(node.arguments)
}

/** The IN body the Harness shows: arguments re-printed as pretty JSON. */
function toolArgumentsBody(node: Extract<ConversationNode, { kind: 'tool' }>): string {
  const args = parsedArguments(node.arguments)
  return args === undefined ? node.arguments : JSON.stringify(args, null, 2)
}

function ToolCard({ node }: { node: Extract<ConversationNode, { kind: 'tool' }> }): JSX.Element {
  const status = node.status === 'running' ? '执行中' : node.status === 'success' ? '已完成' : '失败'
  const input = toolArgumentsBody(node)
  const output = node.result ?? node.error ?? ''
  const [open, setOpen] = useState(node.status !== 'success')
  return (
    <div className={css.toolCard}>
      <DisclosureRow
        rowClassName={css.toolCardRow}
        titleClassName={css.toolCardTitle}
        icon={node.status === 'error' ? <StateDot state="error" /> : TOOL_ICONS[TOOL_VARIANTS[node.name] ?? 'others']}
        title={node.name}
        open={open}
        expandable
        expandOnRowClick
        keepContentWhenOpen
        previewChevron
        onToggle={() => { setOpen(value => !value) }}
        collapsedContent={(
          <>
            <span className={css.toolCardSep} aria-hidden="true" />
            <span className={css.toolCardSummary}>{toolSummary(node)}</span>
            <span className={css.toolStatus}>{status}</span>
          </>
        )}
      >
        <div className={css.toolCardBody}>
          {input !== '' && (
            <div className={css.toolCardSection}>
              <span className={css.toolCardLabel}>输入</span>
              <span className={css.toolCardText}>{input}</span>
            </div>
          )}
          {input !== '' && output !== '' && <span className={css.toolCardDivider} aria-hidden="true" />}
          {output !== '' && (
            <div className={css.toolCardSection}>
              <span className={css.toolCardLabel}>输出</span>
              <span className={css.toolCardText} data-error={node.status === 'error' || undefined}>{output}</span>
            </div>
          )}
        </div>
      </DisclosureRow>
    </div>
  )
}
