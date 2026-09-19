import { useEffect, useState } from 'react'
import {
  DisclosureRow,
  IconApiOutline14,
  IconBrowseOutline16,
  IconCodeOutline16,
  IconEditOutline16,
  IconRightUpOutline16,
  IconSearchOutline16,
  IconSparkle16,
  IconThinkOutline14,
  MarkdownText,
  StateDot,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationNode } from '../../transport/contracts.js'
import { markdownLabels } from '../native-locale.js'
import css from './ConversationColumn.module.css'

/**
 * One node of a transcript, drawn as what it is.
 *
 * A member's column, the meeting room, and the assistant designer all show the
 * same conversation, so what a thinking block, a team message or a tool call
 * looks like has to be decided here rather than three times over. The column
 * that arranges nodes and this that renders them are separate jobs.
 */
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

