import type { TaskGraphNode } from '../task-graph.js'

/** How a state is named to the reader. */
export const STATE_LABELS: Readonly<Record<TaskGraphNode['state'], string>> = {
  done: '已完成',
  running: '进行中',
  ready: '可开始',
  blocked: '等待依赖',
  failed: '失败',
  cancelled: '已取消',
}

/** State names as the badge spells them, following the chart this is drawn from. */
export const BADGE_LABELS: Readonly<Record<TaskGraphNode['state'], string>> = {
  done: 'completed',
  running: 'in progress',
  ready: 'ready',
  blocked: 'blocked',
  failed: 'failed',
  cancelled: 'cancelled',
}

/** Legend order: the states a reader most needs to tell apart come first. */
export const LEGEND: TaskGraphNode['state'][] = ['done', 'running', 'ready', 'blocked', 'failed', 'cancelled']

/** What the two arrow styles mean, in the order they are explained. */
export const EDGE_LEGEND: Array<{ className: string; label: string }> = [
  { className: 'taskFlowLegendRule', label: '依赖已满足' },
  { className: 'taskFlowLegendBlocked', label: '依赖未完成' },
]
