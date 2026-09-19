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
  /** Members on the task, so the archive can build the same card. */
  ownerSlotIds: string[]
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
 * Node geometry: a compact card sized for the panel, not for a page.
 *
 * The chart flows top to bottom, so its width is what has to fit: the members
 * columns can leave the 团队 view narrow, and a chart that needs sideways
 * scrolling hides its own nodes — which reads as missing work. Depth goes down
 * the screen instead, where the panel already scrolls, and a wide node is worth
 * the room because it is the only thing asking for width.
 */
export const FLOW_NODE = {
  width: 150,
  height: 58,
  /** Corner radius, the rounded style of the board. */
  radius: 14,
  /** Vertical gap between one dependency level and the next. */
  gapY: 30,
  /** Horizontal gap between two nodes of the same level. */
  gapX: 14,
  /**
   * How many nodes of one level sit side by side before the rest wrap.
   *
   * Parallel work is the normal case, so a level can hold more nodes than the
   * 团队 view has width for. Wrapping keeps the chart inside the panel instead
   * of pushing its right-hand tasks off screen, where they read as missing.
   */
  maxPerRow: 2,
  /** Vertical gap between two wrapped rows of the same level. */
  gapRowY: 14,
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

  // Group by level in dependency order, then align each level under what feeds
  // it so a reader can follow a chain straight down the screen.
  const columns = new Map<number, TaskGraphNode[]>()
  for (const node of graph.nodes) {
    const rank = level.get(node.id) ?? 0
    const column = columns.get(rank) ?? []
    column.push(node)
    columns.set(rank, column)
  }

  const { width: nodeWidth, height: nodeHeight, gapX, gapY, padding, maxPerRow, gapRowY } = FLOW_NODE
  const columnsByRank = [...columns.keys()].sort((left, right) => left - right)
  alignColumns(columns, columnsByRank, graph.nodes, present)
  // Every level wraps at the same width, so the chart has one column count and
  // a merge still sits between the branches that feed it.
  const widest = Math.min(
    maxPerRow,
    Math.max(...columnsByRank.map(rank => columns.get(rank)!.length)),
  )
  const chartWidth = widest * nodeWidth + (widest - 1) * gapX

  const titles = new Map(graph.nodes.map(node => [node.id, node.title]))
  const items: TaskFlowItem[] = []
  /** Where the next level starts, so a wrapped level pushes the ones below it. */
  let cursorY = padding
  for (const rank of columnsByRank) {
    const column = columns.get(rank)!
    const rows = Math.ceil(column.length / widest)
    column.forEach((node, index) => {
      const row = Math.floor(index / widest)
      const lane = index % widest
      // The last row of a level may hold fewer nodes: centre what it holds.
      const inRow = Math.min(widest, column.length - row * widest)
      const rowWidth = inRow * nodeWidth + (inRow - 1) * gapX
      const left = (chartWidth - rowWidth) / 2
      items.push({
        id: node.id,
        title: node.title,
        caption: ownerCaption(node, members),
        ownerSlotIds: [...node.ownerSlotIds],
        subtitle: subtitleOf(node, members, titles),
        state: node.state,
        level: rank,
        lane: index,
        x: padding + left + lane * (nodeWidth + gapX) + nodeWidth / 2,
        y: cursorY + row * (nodeHeight + gapRowY) + nodeHeight / 2,
      })
    })
    cursorY += rows * nodeHeight + (rows - 1) * gapRowY + gapY
  }
  const chartHeight = cursorY - gapY + padding

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
 * Order every level so a node sits under what feeds it.
 *
 * Dependency order alone says nothing about position: three tasks that feed one
 * dependent can come out in any sequence, and the arrows then cross the ones
 * beside them. A node that follows something on this board is therefore placed
 * above what it feeds — the average position of its dependencies, the usual
 * barycentre — while a node with nothing to follow keeps the place dependency
 * order gave it, which is the board's own sequence. Levels are processed top
 * down, so every dependency already has a position to follow.
 */
function alignColumns(
  columns: Map<number, TaskGraphNode[]>,
  ranks: readonly number[],
  nodes: readonly TaskGraphNode[],
  present: ReadonlySet<string>,
): void {
  const upstream = new Map(nodes.map(node => [
    node.id,
    node.dependsOn.concat(node.waitingOn).filter(id => present.has(id)),
  ]))
  const position = new Map<string, number>()
  for (const rank of ranks) {
    const column = columns.get(rank)!
    // Where each node started, so one with nothing to follow keeps its place.
    const original = new Map(column.map((node, index) => [node.id, index]))
    const barycentre = new Map<string, number>()
    column.forEach(node => {
      if (position.has(node.id)) return
      const ranked = (upstream.get(node.id) ?? [])
        .map(id => position.get(id))
        .filter((value): value is number => value !== undefined)
      if (ranked.length === 0) return
      barycentre.set(node.id, ranked.reduce((sum, value) => sum + value, 0) / ranked.length)
    })
    for (const [id, value] of barycentre) position.set(id, value)
    column.sort((left, right) => {
      const a = barycentre.get(left.id)
      const b = barycentre.get(right.id)
      if (a === undefined && b === undefined) return original.get(left.id)! - original.get(right.id)!
      if (a === undefined) return 1
      if (b === undefined) return -1
      return a - b
    })
    // A node that follows nothing is placed after the ones that do, so the next
    // level still has a position for every dependency it can follow.
    let fallback = column.length
    for (const node of column) {
      if (position.has(node.id)) continue
      position.set(node.id, fallback)
      fallback += 1
    }
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
export function ownerCaption(
  node: TaskGraphNode,
  members: Readonly<Record<string, { displayName: string }>>,
): string {
  return node.ownerSlotIds
    .map(slotId => members[slotId]?.displayName ?? slotId)
    .join('、')
}

/**
 * A dependency's arrow: from the bottom of what is depended on to the top of
 * what waits on it.
 *
 * Two nodes on the same level have no vertical room between them, so the curve
 * bulges to the side instead of collapsing into a horizontal line that would
 * read as the wrong direction.
 */
function flowPath(from: TaskFlowItem, to: TaskFlowItem): string {
  const startY = from.y + FLOW_NODE.height / 2 - 3
  const endY = to.y - FLOW_NODE.height / 2 + 2
  if (endY - startY < 20) {
    const bow = FLOW_NODE.height / 2 + 24
    const direction = to.x >= from.x ? 1 : -1
    return `M ${from.x} ${startY} C ${from.x + direction * 18} ${startY + bow}, `
      + `${to.x - direction * 18} ${endY - bow}, ${to.x} ${endY}`
  }
  const middle = (startY + endY) / 2
  return `M ${from.x} ${startY} C ${from.x} ${middle}, ${to.x} ${middle}, ${to.x} ${endY}`
}
