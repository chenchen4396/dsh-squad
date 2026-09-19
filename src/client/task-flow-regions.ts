import type { TeamTask } from '../domain/types.js'
import type { TaskGraphNode, TaskGraphView } from './task-graph.js'
import {
  FLOW_NODE,
  layoutTaskFlow,
  ownerCaption,
  type TaskFlowChart,
  type TaskFlowItem,
} from './task-flow.js'

/**
 * Which half of the board a task belongs to.
 *
 * The chart is drawn in two parts: the work still in flight, and what has
 * finished. Deciding what goes where is a different question from how a graph
 * is laid out, and the rule is not obvious — a step that just finished stays
 * while something below it still waits on it, because it is what explains that
 * work.
 */
/** Which half of the board a task belongs to. */
export type TaskFlowRegion = 'active' | 'archived'

/**
 * How many finished tasks stay in the chart even though nothing waits on them.
 *
 * A step that just finished is what the reader is looking for: it explains
 * where the task below it came from. Dropping it the moment it completes breaks
 * the chain at exactly the point the reader is following, so the most recent
 * few are kept until newer work pushes them out.
 */
export const KEEP_RECENT_FINISHED = 3

/**
 * Whether a task has left the chart for the archive.
 *
 * Only finished and cancelled tasks are ever archived — everything else is
 * still work, however it reads. That is what makes this a statement about the
 * record rather than about the chart: what a task *draws* as is `state`.
 */
export function taskFlowRegion(state: TeamTask['status']): TaskFlowRegion {
  return state === 'completed' || state === 'cancelled' ? 'archived' : 'active'
}

/**
 * The finished tasks the chart keeps, because they are part of a chain.
 *
 * A chain is the thing worth reading: `a → b → c` tells the reader what led to
 * what, and it says that whether or not the work has finished. A finished step
 * is therefore kept while it stands in one — while something on this board is
 * its prerequisite or its dependent — and while it is among the most recent to
 * finish. Everything else has nothing left to explain and archives.
 *
 * Only the board's own relationships count. A finished task whose prerequisite
 * is not on the board is a step with a loose end, not a chain.
 */
export function keptInFlow(
  nodes: readonly TaskGraphNode[],
  keep = KEEP_RECENT_FINISHED,
): Set<string> {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const finished = new Set(
    nodes.filter(node => taskFlowRegion(node.status) === 'archived').map(node => node.id),
  )
  // Every task that is on the board and waits on something, or is waited on.
  const connected = new Set<string>()
  for (const node of nodes) {
    const prerequisites = node.dependsOn.concat(node.waitingOn).filter(id => byId.has(id))
    if (prerequisites.length === 0) continue
    connected.add(node.id)
    for (const id of prerequisites) connected.add(id)
  }

  // Newest first, so a long chain keeps its most recent links rather than its
  // oldest. Ids break ties so the chart does not reshuffle between renders.
  const recent = [...finished]
    .filter(id => connected.has(id))
    .sort((left, right) => {
      const a = byId.get(left)!
      const b = byId.get(right)!
      return b.updatedAt.localeCompare(a.updatedAt) || left.localeCompare(right)
    })
    .slice(0, keep)

  return new Set(recent)
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
  // A finished step the chart keeps counts as drawn work: it stays out of the
  // archive, so a task never appears in both halves.
  const kept = keptInFlow(graph.nodes)
  const active = graph.nodes.filter(node => (
    taskFlowRegion(node.status) === 'active' || kept.has(node.id)
  ))
  const archived = graph.nodes
    .filter(node => taskFlowRegion(node.status) === 'archived' && !kept.has(node.id))
    .slice()
    .reverse()

  return {
    active: layoutTaskFlow({ ...graph, nodes: active }, members),
    archived: archived.map((node, lane) => ({
      id: node.id,
      title: node.title,
      caption: ownerCaption(node, members),
      ownerSlotIds: [...node.ownerSlotIds],
      subtitle: ownerCaption(node, members),
      state: node.state,
      level: 0,
      lane,
      x: 0,
      y: 0,
    })),
  }
}
