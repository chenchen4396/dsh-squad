import { useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TeamTask } from '../../domain/types.js'
import { buildTaskGraph, type TaskGraphNode } from '../task-graph.js'
import { FLOW_NODE, layoutTaskRegions, type TaskFlowItem } from '../task-flow.js'
import { taskSections, type TaskSection } from '../task-description.js'
import css from '../AgentTeam.module.css'

const STATE_LABELS: Readonly<Record<TaskGraphNode['state'], string>> = {
  done: '已完成',
  running: '进行中',
  ready: '可开始',
  blocked: '等待依赖',
  failed: '失败',
  cancelled: '已取消',
}

/** State names as the badge spells them, following the chart this is drawn from. */
const BADGE_LABELS: Readonly<Record<TaskGraphNode['state'], string>> = {
  done: 'completed',
  running: 'in progress',
  ready: 'ready',
  blocked: 'blocked',
  failed: 'failed',
  cancelled: 'cancelled',
}

/** Legend order: the states a reader most needs to tell apart come first. */
const LEGEND: TaskGraphNode['state'][] = ['done', 'running', 'ready', 'blocked', 'failed', 'cancelled']

/** What the two arrow styles mean, in the order they are explained. */
const EDGE_LEGEND: Array<{ className: string; label: string }> = [
  { className: 'taskFlowLegendRule', label: '依赖已满足' },
  { className: 'taskFlowLegendBlocked', label: '依赖未完成' },
]

/** Roughly how many characters fit on one card, at these sizes. */
const TITLE_BUDGET = 12
const SUBTITLE_BUDGET = 16

/**
 * The 团队 view's task chart.
 *
 * Both halves are the same cards: the left draws the work in flight as a graph,
 * the right lists what has finished. They are kept identical on purpose — a
 * name, its state and who holds it read the same wherever the task sits, so
 * nothing has to be re-learnt when a task moves from one side to the other.
 *
 * The caller passes one conversation's tasks, so a chart never mixes sessions.
 */
export function TaskFlowChart({
  tasks,
  members,
}: {
  tasks: readonly TeamTask[]
  members: Readonly<Record<string, { displayName: string }>>
}): JSX.Element | null {
  const arrowId = `agent-team-flow-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [selectedId, setSelectedId] = useState<string>()

  if (tasks.length === 0) return null
  const graph = buildTaskGraph(tasks)
  const regions = layoutTaskRegions(graph, members)
  const chart = regions.active
  const details = new Map(graph.nodes.map(node => [node.id, node]))
  const selected = selectedId === undefined ? undefined : details.get(selectedId)
  const pick = (id: string): void => {
    setSelectedId(current => current === id ? undefined : id)
  }

  return (
    <div className={css.taskFlow}>
      <div className={css.taskFlowBar}>
        <span className={css.taskFlowProgress}>
          <span className={css.taskFlowProgressTrack}>
            <span
              className={css.taskFlowProgressFill}
              data-active={graph.summary.running > 0 ? 'true' : undefined}
              style={{ width: `${Math.round((graph.summary.done / graph.summary.total) * 100)}%` }}
            />
          </span>
          <span className={css.taskFlowProgressText}>
            {graph.summary.done}/{graph.summary.total} 已完成
          </span>
        </span>
        <ul className={css.taskFlowLegend}>
          {LEGEND.map(state => (
            <li key={state} className={css.taskFlowLegendItem} data-state={state}>
              <span className={css.taskFlowDot} aria-hidden="true" />
              {STATE_LABELS[state]}
            </li>
          ))}
          {EDGE_LEGEND.map(entry => (
            <li key={entry.label} className={css.taskFlowLegendItem}>
              <span className={css[entry.className]} aria-hidden="true" />
              {entry.label}
            </li>
          ))}
        </ul>
      </div>
      <div className={css.taskFlowSplit}>
        {/* The large half: everything not yet finished, in dependency order. */}
        <section className={css.taskFlowActive}>
          <header className={css.taskFlowSectionHead}>
            <strong className={css.taskFlowSectionTitle}>进行中</strong>
            <span className={css.taskFlowSectionCount}>{chart.items.length} 个任务</span>
          </header>
          {chart.items.length === 0
            ? <p className={css.taskFlowEmpty}>没有进行中的任务</p>
            : (
                <div className={css.taskFlowCanvas}>
                  <svg
                    className={css.taskFlowSvg}
                    viewBox={`0 0 ${chart.width} ${chart.height}`}
                    width={chart.width}
                    height={chart.height}
                    role="img"
                    aria-label={`进行中的任务流程图，共 ${chart.items.length} 个任务`}
                  >
                    <defs>
                      <marker
                        id={arrowId}
                        viewBox="0 0 8 8"
                        refX="7"
                        refY="4"
                        markerWidth="5"
                        markerHeight="5"
                        orient="auto-start-reverse"
                      >
                        <path d="M 0 1 L 8 4 L 0 7 z" className={css.taskFlowArrowHead} />
                      </marker>
                    </defs>
                    {chart.edges.map(edge => {
                      const satisfied = edge.sourceState === 'done' || edge.sourceState === 'cancelled'
                      return (
                        <path
                          key={edge.id}
                          className={css.taskFlowEdge}
                          data-state={edge.sourceState}
                          data-satisfied={satisfied ? 'true' : undefined}
                          d={edge.path}
                          fill="none"
                          markerEnd={`url(#${arrowId})`}
                        />
                      )
                    })}
                    {chart.items.map(item => (
                      <TaskCard
                        key={item.id}
                        item={item}
                        selected={item.id === selectedId}
                        onPick={pick}
                      />
                    ))}
                  </svg>
                </div>
              )}
        </section>
        {/* The small half: what has left the board, drawn as the same cards. */}
        <aside className={css.taskFlowArchive}>
          <details className={css.taskFlowArchiveDetails} open>
            <summary className={css.taskFlowSectionHead}>
              <strong className={css.taskFlowSectionTitle}>已完成</strong>
              <span className={css.taskFlowSectionCount}>{regions.archived.length}</span>
            </summary>
            {regions.archived.length === 0
              ? <p className={css.taskFlowEmpty}>还没有完成的任务</p>
              : (
                  <ul className={css.taskFlowArchiveList}>
                    {regions.archived.map(item => (
                      <li key={item.id} className={css.taskFlowArchiveCard}>
                        <svg
                          className={css.taskFlowSvg}
                          viewBox={`0 0 ${FLOW_NODE.width} ${FLOW_NODE.height}`}
                          width={FLOW_NODE.width}
                          height={FLOW_NODE.height}
                          role="img"
                          aria-label={`${item.title}，${STATE_LABELS[item.state]}`}
                        >
                          <TaskCard
                            item={{ ...item, x: FLOW_NODE.width / 2, y: FLOW_NODE.height / 2 }}
                            selected={item.id === selectedId}
                            onPick={pick}
                          />
                        </svg>
                      </li>
                    ))}
                  </ul>
                )}
          </details>
        </aside>
      </div>
      {/* A dialog rather than a panel: the chart uses the width it has, and the
          detail opens over it wherever the reader happens to be looking. */}
      <TaskDetail node={selected} members={members} onPick={setSelectedId} onClose={() => { setSelectedId(undefined) }} />
    </div>
  )
}

/**
 * One task, drawn the same way wherever it appears.
 *
 * A card carries its state as a badge, its name, and the one fact a reader asks
 * next — who holds it, or what it is still waiting for.
 */
function TaskCard({
  item,
  selected,
  onPick,
}: {
  item: TaskFlowItem
  selected: boolean
  onPick: (id: string) => void
}): JSX.Element {
  const left = item.x - FLOW_NODE.width / 2
  const top = item.y - FLOW_NODE.height / 2
  const badge = BADGE_LABELS[item.state]
  return (
    <g
      className={css.taskFlowNode}
      data-state={item.state}
      data-selected={selected ? 'true' : undefined}
      transform={`translate(${left} ${top})`}
      role="button"
      tabIndex={0}
      aria-label={`${item.title}，${STATE_LABELS[item.state]}`}
      onClick={() => { onPick(item.id) }}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onPick(item.id)
      }}
    >
      <title>{`${item.title}｜${STATE_LABELS[item.state]}｜${item.subtitle}`}</title>
      <rect
        className={css.taskFlowHalo}
        x={-4}
        y={-4}
        width={FLOW_NODE.width + 8}
        height={FLOW_NODE.height + 8}
        rx={FLOW_NODE.radius + 4}
      />
      <rect
        className={css.taskFlowCard}
        width={FLOW_NODE.width}
        height={FLOW_NODE.height}
        rx={FLOW_NODE.radius}
      />
      <rect
        className={css.taskFlowAccent}
        x={0}
        y={10}
        width={4}
        height={FLOW_NODE.height - 20}
        rx={2}
      />
      <rect
        className={css.taskFlowBadge}
        x={14}
        y={8}
        width={badgeWidth(badge)}
        height={15}
        rx={7.5}
      />
      <text className={css.taskFlowBadgeText} x={14 + badgeWidth(badge) / 2} y={19} textAnchor="middle">
        {badge}
      </text>
      <text className={css.taskFlowLabel} x={14} y={39}>
        {truncate(item.title, TITLE_BUDGET)}
      </text>
      <text className={css.taskFlowSubtitle} x={14} y={55}>
        {truncate(item.subtitle, SUBTITLE_BUDGET)}
      </text>
    </g>
  )
}

/**
 * What a click reveals: the whole task, its owner, its description and both
 * dependency directions, in a dialog over the chart.
 *
 * The card itself stays small; everything it cannot carry is one click away.
 * The dialog is drawn through a portal so a chart that scrolls sideways cannot
 * clip it, and it closes on Escape, on a click outside, or on the close button.
 */
function TaskDetail({
  node,
  members,
  onPick,
  onClose,
}: {
  node: TaskGraphNode | undefined
  members: Readonly<Record<string, { displayName: string }>>
  onPick: (id: string) => void
  onClose: () => void
}): JSX.Element | null {
  useEffect(() => {
    if (node === undefined) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [node, onClose])

  if (node === undefined || typeof document === 'undefined') return null
  const owners = node.ownerSlotIds.map(slotId => members[slotId]?.displayName ?? slotId)
  const sections = taskSections(node.description)
  return createPortal(
    <div className={css.taskDetailBackdrop} onClick={onClose} role="presentation">
      <div
        className={css.taskDetailDialog}
        role="dialog"
        aria-modal="true"
        aria-label={node.title}
        onClick={event => { event.stopPropagation() }}
      >
        <header className={css.taskDetailHeader}>
          <div className={css.taskDetailHeading}>
            <strong className={css.taskDetailTitle}>{node.title}</strong>
            <span className={css.taskFlowDetailState} data-state={node.state}>
              {STATE_LABELS[node.state]}
              {owners.length === 0 ? ' · 未分配' : ` · ${owners.join('、')}`}
            </span>
          </div>
          <button type="button" className={css.taskDetailClose} onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className={css.taskFlowDetail} data-state={node.state}>
          <dl className={css.taskFlowDetailFacts}>
            <dt>等待</dt>
            <dd>{node.waitingOn.length === 0 ? '无（可开始）' : node.waitingOn.join('、')}</dd>
            <dt>完成后解锁</dt>
            <dd>{node.blocks.length === 0 ? '无' : node.blocks.join('、')}</dd>
          </dl>
          {sections.map((section, index) => (
            <TaskSectionBody key={`${section.title ?? 'body'}-${index}`} section={section} />
          ))}
          {(node.waitingOn.length > 0 || node.blocks.length > 0) && (
            <div className={css.taskFlowDetailLinks}>
              {[...node.waitingOn, ...node.blocks].map(id => (
                <button
                  key={id}
                  type="button"
                  className={css.taskFlowDetailLink}
                  onClick={() => { onPick(id) }}
                >
                  {id.slice(0, 8)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** One section of a description: its heading, its points, then its prose. */
function TaskSectionBody({ section }: { section: TaskSection }): JSX.Element {
  return (
    <section className={css.taskDetailSection}>
      {section.title !== undefined && (
        <h4 className={css.taskDetailSectionTitle}>{section.title}</h4>
      )}
      {section.items.length > 0 && (
        <ol className={css.taskDetailList}>
          {section.items.map((item, index) => (
            <li key={index} className={css.taskDetailItem}>
              <span className={css.taskDetailItemIndex} aria-hidden="true">{index + 1}</span>
              <span className={css.taskDetailItemText}>{inlineParts(item)}</span>
            </li>
          ))}
        </ol>
      )}
      {section.paragraphs.map((paragraph, index) => (
        <p key={index} className={css.taskDetailParagraph}>{inlineParts(paragraph)}</p>
      ))}
    </section>
  )
}

/** `**bold**` and `` `code` `` as spans, so the common emphasis survives. */
function inlineParts(text: string): Array<string | JSX.Element> {
  const parts: Array<string | JSX.Element> = []
  const pattern = /\*\*(.+?)\*\*|`([^`]+)`/g
  let last = 0
  let match = pattern.exec(text)
  let key = 0
  while (match !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    if (match[1] !== undefined) parts.push(<strong key={key++}>{match[1]}</strong>)
    else if (match[2] !== undefined) parts.push(<code key={key++} className={css.taskDetailCode}>{match[2]}</code>)
    last = match.index + match[0].length
    match = pattern.exec(text)
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

/** Badge width: the label plus its padding, so the pill always fits its word. */
function badgeWidth(label: string): number {
  return Math.round(label.length * 5.6) + 14
}

/** Cut a label to what fits, marking that it was cut. */
function truncate(text: string, budget: number): string {
  return text.length <= budget ? text : `${text.slice(0, budget - 1)}…`
}
