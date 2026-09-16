import type { TeamTask } from '../domain/types.js'
import type { TaskGraphNode, TaskGraphView } from './task-graph.js'

/**
 * A task drawn as a node in the flow chart.
 *
 * `x`/`y` are the centre of the node, `level` is the dependency depth (0 has no
 * dependencies), and `lane` is the position within that level.
 */
export interface TaskFlowItem {
  id: string
  title: string
  /** Owner names already resolved for display, ready to draw. */
  caption: string
  /**
   * The node's second line: who is on it, or what it is still waiting for.
   * A blocked card says why it cannot move yet, which is the one thing the
   * reader cannot infer from the arrows alone.
   */
  subtitle: string
  state: TaskGraphNode['state']
  level: number
  lane: number
  x: number
  y: number
}

/** One dependency as the chart draws it: `from` waits on `to`. */
export interface TaskFlowEdge {
  id: string
  from: string
  to: string
  path: string
  /** The waiting task's state: an arrow carries the colour of what it leaves. */
  sourceState: TaskGraphNode['state']
}

export interface TaskFlowChart {
  width: number
  height: number
  items: TaskFlowItem[]
  edges: TaskFlowEdge[]
}

/**
 * Node geometry: a compact card, not a banner.
 *
 * The chart is read as a shape first and by label second, so a node only needs
 * room for a short title. A tight card keeps more of the graph on screen, and
 * the full text lives in the detail panel a click opens.
 */
export const FLOW_NODE = {
  width: 176,
  height: 66,
  /** Corner radius, the rounded style of the board. */
  radius: 14,
  /** Horizontal gap between one level and the next. */
  gapX: 46,
  /** Vertical gap between two nodes stacked in the same level. */
  gapY: 12,
  /** Padding around the whole chart. */
  padding: 12,
} as const

/**
 * Lay a task graph out as a left-to-right flow chart.
 *
 * The chart is the shape of the work: a task sits one level right of everything
 * it waits on, so parallel branches stack in the same column and merge where
 * their consumer sits. Levels come from the longest dependency path, which puts
 * a task right of *all* of its dependencies rather than merely right of one.
 *
 * A dependency that is not on the board cannot be drawn, but it still pushes
 * its dependent one level right, so a task waiting on something unknown is never
 * mistaken for a first step.
 */
export function layoutTaskFlow(
  graph: TaskGraphView,
  members: Readonly<Record<string, { displayName: string }>> = {},
): TaskFlowChart {
  if (graph.nodes.length === 0) {
    return { width: 0, height: 0, items: [], edges: [] }
  }

  const present = new Set(graph.nodes.map(node => node.id))
  const level = assignLevels(graph.nodes, present)

  // Group by level, keeping the topological order within each column so a
  // reader still follows the board's own sequence.
  const columns = new Map<number, TaskGraphNode[]>()
  for (const node of graph.nodes) {
    const rank = level.get(node.id) ?? 0
    const column = columns.get(rank) ?? []
    column.push(node)
    columns.set(rank, column)
  }

  const { width: nodeWidth, height: nodeHeight, gapX, gapY, padding } = FLOW_NODE
  const columnsByRank = [...columns.keys()].sort((left, right) => left - right)
  const tallest = Math.max(...columnsByRank.map(rank => columns.get(rank)!.length))
  const chartHeight = tallest * nodeHeight + (tallest - 1) * gapY
  const chartWidth = columnsByRank.length * nodeWidth + (columnsByRank.length - 1) * gapX

  const items: TaskFlowItem[] = []
  const titles = new Map(graph.nodes.map(node => [node.id, node.title]))
  for (const rank of columnsByRank) {
    const column = columns.get(rank)!
    // Each column is centred against the tallest one, so a merge point sits
    // between the branches that feed it rather than at their top.
    const columnHeight = column.length * nodeHeight + (column.length - 1) * gapY
    const top = (chartHeight - columnHeight) / 2
    column.forEach((node, lane) => {
      items.push({
        id: node.id,
        title: node.title,
        caption: ownerCaption(node, members),
        subtitle: subtitleOf(node, members, titles),
        state: node.state,
        level: rank,
        lane,
        x: padding + rank * (nodeWidth + gapX) + nodeWidth / 2,
        y: padding + top + lane * (nodeHeight + gapY) + nodeHeight / 2,
      })
    })
  }

  const byId = new Map(items.map(item => [item.id, item]))
  const edges: TaskFlowEdge[] = []
  for (const node of graph.nodes) {
    for (const dependency of node.dependsOn.concat(node.waitingOn)) {
      if (!present.has(dependency)) continue
      const from = byId.get(dependency)
      const to = byId.get(node.id)
      if (from === undefined || to === undefined) continue
      edges.push({
        id: `${node.id}->${dependency}`,
        from: dependency,
        to: node.id,
        path: flowPath(from, to),
        sourceState: node.state,
      })
    }
  }

  return {
    width: chartWidth + padding * 2,
    height: chartHeight + padding * 2,
    items,
    edges,
  }
}

/**
 * The dependency depth of every task, counting only dependencies on the board.
 *
 * A cycle cannot be layered; walking it with a visited guard stops at the point
 * it closes and the members keep the depth they were first given, so a cyclic
 * board still lays out instead of hanging the view.
 */
function assignLevels(
  nodes: readonly TaskGraphNode[],
  present: ReadonlySet<string>,
): Map<string, number> {
  const dependencies = new Map(nodes.map(node => [
    node.id,
    node.dependsOn.concat(node.waitingOn).filter(id => present.has(id)),
  ]))
  const levels = new Map<string, number>()
  const resolving = new Set<string>()

  const depthOf = (id: string): number => {
    const known = levels.get(id)
    if (known !== undefined) return known
    if (resolving.has(id)) return 0
    resolving.add(id)
    let depth = 0
    for (const dependency of dependencies.get(id) ?? []) {
      depth = Math.max(depth, depthOf(dependency) + 1)
    }
    resolving.delete(id)
    levels.set(id, depth)
    return depth
  }

  for (const node of nodes) depthOf(node.id)
  return levels
}

/**
 * The node's second line.
 *
 * A blocked card names what it is still waiting for — the one fact its arrows
 * cannot state, since they show the shape and not the reason. Everything else
 * says who is on it, so a reader knows whether it is claimed.
 */
function subtitleOf(
  node: TaskGraphNode,
  members: Readonly<Record<string, { displayName: string }>>,
  titles: ReadonlyMap<string, string>,
): string {
  if (node.state === 'blocked' && node.waitingOn.length > 0) {
    const names = node.waitingOn.map(id => titles.get(id) ?? id)
    return `等待 ${names.join('、')}`
  }
  const owners = ownerCaption(node, members)
  if (owners.length === 0) return '未分配'
  return node.state === 'running' ? `执行中：${owners}` : `认领：${owners}`
}

/** The members working on a task, as the node's second line. */
function ownerCaption(
  node: TaskGraphNode,
  members: Readonly<Record<string, { displayName: string }>>,
): string {
  return node.ownerSlotIds
    .map(slotId => members[slotId]?.displayName ?? slotId)
    .join('、')
}

/**
 * A dependency's arrow, from the right of what is depended on to the left of
 * what waits on it.
 *
 * Two nodes in the same column have no room for a horizontal arrow, so the
 * curve bulges sideways instead of collapsing into a vertical line that would
 * read as the wrong direction.
 */
function flowPath(from: TaskFlowItem, to: TaskFlowItem): string {
  const startX = from.x + FLOW_NODE.width / 2 - 4
  const endX = to.x - FLOW_NODE.width / 2 + 3
  if (endX - startX < 24) {
    const bow = FLOW_NODE.width / 2 + 28
    const direction = to.y >= from.y ? 1 : -1
    return `M ${startX} ${from.y} C ${startX + bow} ${from.y + direction * 18}, `
      + `${startX + bow} ${to.y - direction * 18}, ${endX} ${to.y}`
  }
  return `M ${startX} ${from.y} C ${(startX + endX) / 2} ${from.y}, `
    + `${(startX + endX) / 2} ${to.y}, ${endX} ${to.y}`
}

/** Which half of the board a task belongs to. */
export type TaskFlowRegion = 'active' | 'archived'

/**
 * The board split into the work in flight and the work that is finished.
 *
 * Finished tasks leave the graph: their dependencies are satisfied, so keeping
 * them in the chart would stretch it sideways for no information while every
 * arrow into them has already done its job. They collapse instead into a short
 * archive, where "it is done" is the whole story.
 *
 * A cancelled task is archived too — it has left the board as surely as a
 * finished one and must not hold a column in the chart of live work.
 */
export function taskFlowRegion(state: TeamTask['status']): TaskFlowRegion {
  return state === 'completed' || state === 'cancelled' ? 'archived' : 'active'
}

export interface TaskFlowRegions {
  /** The graph of everything still moving — the large half of the board. */
  active: TaskFlowChart
  /** The tasks that have left the board, newest first. */
  archived: TaskFlowItem[]
}

/** Lay one conversation's tasks out as the board: graph left, archive right. */
export function layoutTaskRegions(
  graph: TaskGraphView,
  members: Readonly<Record<string, { displayName: string }>> = {},
): TaskFlowRegions {
  const active = graph.nodes.filter(node => taskFlowRegion(node.status) === 'active')
  const archived = graph.nodes
    .filter(node => taskFlowRegion(node.status) === 'archived')
    .slice()
    .reverse()

  return {
    active: layoutTaskFlow({ ...graph, nodes: active }, members),
    archived: archived.map((node, lane) => ({
      id: node.id,
      title: node.title,
      caption: ownerCaption(node, members),
      subtitle: ownerCaption(node, members),
      state: node.state,
      level: 0,
      lane,
      x: 0,
      y: 0,
    })),
  }
}
