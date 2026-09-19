import { FLOW_NODE, type TaskFlowItem } from '../task-flow.js'
import css from '../AgentTeam.module.css'
import { BADGE_LABELS, STATE_LABELS } from './task-labels.js'

/** Roughly how many characters fit on one card, at these sizes. */
const TITLE_BUDGET = 12
const SUBTITLE_BUDGET = 16

export function TaskCard({
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

function badgeWidth(label: string): number {
  return Math.round(label.length * 5.6) + 14
}

/** Cut a label to what fits, marking that it was cut. */
function truncate(text: string, budget: number): string {
  return text.length <= budget ? text : `${text.slice(0, budget - 1)}…`
}
