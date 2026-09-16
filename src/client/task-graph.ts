import { taskAssigneeIds } from '../domain/team-selectors.js'
import type { TeamTask } from '../domain/types.js'

/**
 * One task as the team view draws it.
 *
 * `state` folds the record's own status together with its dependencies: a task
 * whose dependencies have not finished cannot run yet however its status reads,
 * and that is the fact a reader needs first. `waitingOn` names exactly which
 * tasks are still holding it back, so a blocked row explains itself.
 */
export interface TaskGraphNode {
  id: string
  title: string
  description: string
  status: TeamTask['status']
  /** What the row shows: the status folded with the dependency situation. */
  state: 'done' | 'running' | 'ready' | 'blocked' | 'failed' | 'cancelled'
  ownerSlotIds: string[]
  /** Dependencies that have already finished. */
  dependsOn: string[]
  /** Dependencies still unfinished — why this task has not started. */
  waitingOn: string[]
  /** Tasks that list this one as a dependency. */
  blocks: string[]
  fileScopes: string[]
  updatedAt: string
}

export interface TaskGraphView {
  /** Topological order: every dependency appears before what depends on it. */
  nodes: TaskGraphNode[]
  /** `from` depends on `to`. */
  edges: Array<{ from: string; to: string }>
  summary: {
    total: number
    done: number
    running: number
    ready: number
    blocked: number
    failed: number
    cancelled: number
  }
}

/**
 * The task board of one conversation as a graph.
 *
 * Tasks are conversation-scoped, so the board is built from exactly the tasks
 * that belong to the conversation being shown. A dependency that is not part of
 * that set — a task from another conversation, or one that was deleted — is
 * dropped rather than drawn as an edge to nothing, but it still counts as
 * unfinished when judging readiness: a task must never look ready because its
 * dependency vanished from view.
 */
export function buildTaskGraph(tasks: readonly TeamTask[]): TaskGraphView {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const done = (id: string): boolean => {
    const task = byId.get(id)
    return task !== undefined && (task.status === 'completed' || task.status === 'cancelled')
  }

  const nodes = tasks.map(task => {
    const dependencies = unique(task.dependencyIds)
    const waitingOn = dependencies.filter(id => !done(id))
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      state: stateOf(task, waitingOn.length > 0),
      ownerSlotIds: taskAssigneeIds(task),
      dependsOn: dependencies.filter(id => done(id)),
      waitingOn,
      blocks: tasks.filter(other => other.dependencyIds.includes(task.id)).map(other => other.id),
      fileScopes: [...task.fileScopes],
      updatedAt: task.updatedAt,
    } satisfies TaskGraphNode
  })

  // Only a dependency that is itself on the board can be drawn; a missing one
  // still blocks its dependent, but there is nothing to point an edge at.
  const present = new Set(nodes.map(node => node.id))
  const edges = nodes.flatMap(node => node.dependsOn.concat(node.waitingOn)
    .filter(dependency => present.has(dependency))
    .map(dependency => ({ from: node.id, to: dependency })))

  return {
    nodes: topologically(nodes),
    edges,
    summary: {
      total: nodes.length,
      done: nodes.filter(node => node.state === 'done').length,
      running: nodes.filter(node => node.state === 'running').length,
      ready: nodes.filter(node => node.state === 'ready').length,
      blocked: nodes.filter(node => node.state === 'blocked').length,
      failed: nodes.filter(node => node.state === 'failed').length,
      cancelled: nodes.filter(node => node.state === 'cancelled').length,
    },
  }
}

/**
 * The one word a row shows for a task.
 *
 * A finished task is done whatever it was waiting on; a failed or cancelled one
 * says so rather than hiding behind "blocked"; everything else that still has
 * unfinished dependencies is waiting, and only then does its own status speak.
 */
function stateOf(task: TeamTask, waiting: boolean): TaskGraphNode['state'] {
  if (task.status === 'completed') return 'done'
  if (task.status === 'cancelled') return 'cancelled'
  if (task.status === 'failed') return 'failed'
  if (waiting) return 'blocked'
  if (task.status === 'running') return 'running'
  return 'ready'
}

/**
 * Dependencies first, so a reader can follow the board top to bottom.
 *
 * A dependency cycle cannot be ordered; every member of it is emitted in a
 * stable group instead of being dropped, because a cycle is a fact about the
 * board that the reader has to see rather than have silently tidied away.
 */
function topologically(nodes: readonly TaskGraphNode[]): TaskGraphNode[] {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const ordered: TaskGraphNode[] = []
  const placed = new Set<string>()
  const visiting = new Set<string>()

  const visit = (node: TaskGraphNode): void => {
    if (placed.has(node.id)) return
    if (visiting.has(node.id)) return
    visiting.add(node.id)
    for (const dependency of node.dependsOn.concat(node.waitingOn)) {
      const target = byId.get(dependency)
      if (target !== undefined) visit(target)
    }
    visiting.delete(node.id)
    placed.add(node.id)
    ordered.push(node)
  }

  for (const node of nodes) visit(node)
  return ordered
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}
