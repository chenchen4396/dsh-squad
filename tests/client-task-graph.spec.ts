import { describe, expect, it } from 'vitest'
import { buildTaskGraph } from '../src/client/task-graph.js'
import type { TeamTask } from '../src/domain/types.js'

/**
 * The board has to answer, at a glance: what is assigned, what depends on what,
 * what is running and what is finished. A member blocked behind an unfinished
 * dependency looks exactly like an idle one in the raw record, so the state the
 * view draws is folded from both the status and the dependencies.
 */
function task(id: string, overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id,
    title: id,
    description: '',
    status: 'pending',
    ownerSlotIds: [],
    dependencyIds: [],
    fileScopes: [],
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as TeamTask
}

describe('buildTaskGraph', () => {
  it('marks a task with unfinished dependencies as blocked and names them', () => {
    const graph = buildTaskGraph([
      task('design', { status: 'running', ownerSlotIds: ['tse'] }),
      task('implement', { dependencyIds: ['design'], ownerSlotIds: ['se'] }),
    ])

    const implement = graph.nodes.find(node => node.id === 'implement')!
    expect(implement.state).toBe('blocked')
    expect(implement.waitingOn).toEqual(['design'])
    expect(implement.dependsOn).toEqual([])
    expect(graph.summary.running).toBe(1)
    expect(graph.summary.blocked).toBe(1)
    expect(graph.edges).toEqual([{ from: 'implement', to: 'design' }])
  })

  it('lets a task run once its dependencies are completed', () => {
    const graph = buildTaskGraph([
      task('design', { status: 'completed' }),
      task('implement', { dependencyIds: ['design'], status: 'running' }),
      task('verify', { dependencyIds: ['implement'] }),
    ])

    const implement = graph.nodes.find(node => node.id === 'implement')!
    expect(implement.state).toBe('running')
    expect(implement.dependsOn).toEqual(['design'])
    expect(implement.waitingOn).toEqual([])

    const verify = graph.nodes.find(node => node.id === 'verify')!
    expect(verify.state).toBe('blocked')
    expect(graph.summary.done).toBe(1)
  })

  it('reports which tasks a finished one unblocks', () => {
    const graph = buildTaskGraph([
      task('design', { status: 'completed' }),
      task('implement', { dependencyIds: ['design'] }),
      task('verify', { dependencyIds: ['implement'] }),
    ])

    const design = graph.nodes.find(node => node.id === 'design')!
    expect(design.blocks).toEqual(['implement'])
  })

  it('orders dependencies before what depends on them', () => {
    const graph = buildTaskGraph([
      task('c', { dependencyIds: ['b'] }),
      task('b', { dependencyIds: ['a'] }),
      task('a'),
    ])

    expect(graph.nodes.map(node => node.id)).toEqual(['a', 'b', 'c'])
  })

  it('keeps every task of a dependency cycle instead of dropping them', () => {
    const graph = buildTaskGraph([
      task('a', { dependencyIds: ['b'] }),
      task('b', { dependencyIds: ['a'] }),
    ])

    expect(graph.nodes.map(node => node.id).sort()).toEqual(['a', 'b'])
    expect(graph.nodes.every(node => node.state === 'blocked')).toBe(true)
  })

  it('treats a dependency missing from the board as unfinished rather than ready', () => {
    const graph = buildTaskGraph([
      task('implement', { dependencyIds: ['gone'] }),
    ])

    expect(graph.nodes[0]!.state).toBe('blocked')
    expect(graph.nodes[0]!.waitingOn).toEqual(['gone'])
    // Nothing to point an edge at, so the edge is not drawn.
    expect(graph.edges).toEqual([])
  })

  it('keeps a failed task failed even when it is waiting', () => {
    const graph = buildTaskGraph([
      task('design', { status: 'running' }),
      task('implement', { status: 'failed', dependencyIds: ['design'] }),
    ])

    expect(graph.nodes.find(node => node.id === 'implement')!.state).toBe('failed')
    expect(graph.summary.failed).toBe(1)
  })

  it('treats a cancelled dependency as satisfied so the board can move on', () => {
    const graph = buildTaskGraph([
      task('optional', { status: 'cancelled' }),
      task('implement', { dependencyIds: ['optional'] }),
    ])

    expect(graph.nodes.find(node => node.id === 'implement')!.state).toBe('ready')
    expect(graph.summary.cancelled).toBe(1)
  })

  it('counts a plain assigned task with no dependencies as ready to work', () => {
    const graph = buildTaskGraph([
      task('implement', { status: 'assigned', ownerSlotIds: ['se', 'tse'] }),
    ])

    expect(graph.nodes[0]!.state).toBe('ready')
    expect(graph.nodes[0]!.ownerSlotIds).toEqual(['se', 'tse'])
    expect(graph.summary.ready).toBe(1)
  })
})
