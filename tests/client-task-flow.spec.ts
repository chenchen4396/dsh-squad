import { describe, expect, it } from 'vitest'
import { buildTaskGraph } from '../src/client/task-graph.js'
import {
  FLOW_NODE,
  layoutTaskFlow,
  layoutTaskRegions,
  taskFlowRegion,
} from '../src/client/task-flow.js'
import type { TeamTask } from '../src/domain/types.js'

/**
 * The chart is the shape of the work, so the layout is what has to be right:
 * parallel branches sit side by side on one level and merge where their
 * consumer sits, and an arrow always runs downwards — never from a task back
 * to its dependency. Depth runs down the screen because that is the axis the
 * panel already scrolls; width is what it cannot spare.
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

function chartOf(tasks: TeamTask[], members: Record<string, { displayName: string }> = {}) {
  return layoutTaskFlow(buildTaskGraph(tasks), members)
}

describe('layoutTaskFlow', () => {
  it('draws the reference shape: one start, two parallel branches, one merge, one end', () => {
    const chart = chartOf([
      task('parse', { status: 'completed' }),
      task('transcode', { dependencyIds: ['parse'] }),
      task('thumbnail', { dependencyIds: ['parse'] }),
      task('watermark', { dependencyIds: ['transcode', 'thumbnail'] }),
      task('publish', { dependencyIds: ['watermark'] }),
    ])

    const at = (id: string) => chart.items.find(item => item.id === id)!
    // Depth 0 → 1 → 2 → 3 reads top to bottom.
    expect(at('parse').level).toBe(0)
    expect(at('transcode').level).toBe(1)
    expect(at('thumbnail').level).toBe(1)
    expect(at('watermark').level).toBe(2)
    expect(at('publish').level).toBe(3)

    // The two branches share a level and do not overlap sideways.
    expect(at('transcode').y).toBe(at('thumbnail').y)
    expect(at('transcode').x).not.toBe(at('thumbnail').x)

    // Every arrow runs downwards: the dependency is always further up.
    for (const edge of chart.edges) {
      const from = at(edge.from)
      const to = at(edge.to)
      expect(from.y).toBeLessThan(to.y)
    }
    // parse → 2 branches, 2 branches → watermark, watermark → publish.
    expect(chart.edges).toHaveLength(5)
  })

  it('places a task below every one of its dependencies, not just one', () => {
    const chart = chartOf([
      task('a'),
      task('b', { dependencyIds: ['a'] }),
      task('c', { dependencyIds: ['b'] }),
      // Depends on a shallow and a deep task: the deep one decides the column.
      task('d', { dependencyIds: ['a', 'c'] }),
    ])

    const at = (id: string) => chart.items.find(item => item.id === id)!
    expect(at('d').level).toBe(3)
    expect(at('d').y).toBeGreaterThan(at('c').y)
    expect(at('d').y).toBeGreaterThan(at('a').y)
  })

  it('centres a merge point between the branches that feed it', () => {
    const chart = chartOf([
      task('parse'),
      task('left', { dependencyIds: ['parse'] }),
      task('right', { dependencyIds: ['parse'] }),
      task('merge', { dependencyIds: ['left', 'right'] }),
    ])
    const at = (id: string) => chart.items.find(item => item.id === id)
    const merge = at('merge')!
    const left = at('left')!
    const right = at('right')!
    const middle = (left.x + right.x) / 2
    // With no other level wider, the merge sits on the branch midpoint.
    expect(Math.abs(merge.x - middle)).toBeLessThanOrEqual(FLOW_NODE.gapX)
  })

  it('keeps a task waiting on something off the board one level in', () => {
    const chart = chartOf([task('orphan', { dependencyIds: ['gone'] })])
    expect(chart.items[0]!.level).toBe(0)
    // Nothing to draw an arrow to.
    expect(chart.edges).toEqual([])
  })

  it('lays a cyclic board out instead of looping forever', () => {
    const chart = chartOf([
      task('a', { dependencyIds: ['b'] }),
      task('b', { dependencyIds: ['a'] }),
    ])
    expect(chart.items).toHaveLength(2)
    expect(chart.edges).toHaveLength(2)
    expect(chart.width).toBeGreaterThan(0)
    expect(chart.height).toBeGreaterThan(0)
  })

  it('resolves owner names onto the node caption and keeps ids when a member is gone', () => {
    const chart = chartOf(
      [task('a', { ownerSlotIds: ['se', 'ghost'] })],
      { se: { displayName: 'SE' } },
    )
    expect(chart.items[0]!.caption).toBe('SE、ghost')
  })

  it('measures the chart to fit every level and lane', () => {
    const chart = chartOf([
      task('a'),
      task('b', { dependencyIds: ['a'] }),
      task('c', { dependencyIds: ['a'] }),
      task('d', { dependencyIds: ['a'] }),
    ])
    const rightmost = Math.max(...chart.items.map(item => item.x + FLOW_NODE.width / 2))
    const bottom = Math.max(...chart.items.map(item => item.y + FLOW_NODE.height / 2))
    expect(chart.width).toBeGreaterThanOrEqual(rightmost)
    expect(chart.height).toBeGreaterThanOrEqual(bottom)
  })

  it('returns an empty drawing for an empty board', () => {
    expect(chartOf([])).toEqual({ width: 0, height: 0, items: [], edges: [] })
  })
})

describe('layoutTaskRegions', () => {
  it('archives finished and cancelled tasks and graphs the rest', () => {
    const chart = layoutTaskRegions(buildTaskGraph([
      task('done', { status: 'completed' }),
      task('dropped', { status: 'cancelled' }),
      task('open', { status: 'running' }),
      task('queued', { dependencyIds: ['open'] }),
    ]))

    expect(chart.active.items.map(item => item.id).sort()).toEqual(['open', 'queued'])
    // Archived newest first, so the most recent arrival reads at the top.
    expect(chart.archived.map(item => item.id)).toEqual(['dropped', 'done'])
  })

  it('keeps a dependency on an archived task out of the live chart', () => {
    // The dependency is satisfied, so the arrow has done its job and the live
    // chart must not stretch down to reach the archive.
    const chart = layoutTaskRegions(buildTaskGraph([
      task('design', { status: 'completed' }),
      task('implement', { dependencyIds: ['design'], status: 'running' }),
    ]))

    expect(chart.active.edges).toEqual([])
    expect(chart.active.items.map(item => item.id)).toEqual(['implement'])
    expect(chart.active.items[0]!.level).toBe(0)
    expect(chart.archived.map(item => item.id)).toEqual(['design'])
  })

  it('drops an archived task from a live task waiting list', () => {
    // A cancelled dependency counts as satisfied, so the dependent is startable.
    const chart = layoutTaskRegions(buildTaskGraph([
      task('optional', { status: 'cancelled' }),
      task('implement', { dependencyIds: ['optional'] }),
    ]))
    expect(chart.active.items.map(item => item.id)).toEqual(['implement'])
    expect(chart.archived.map(item => item.id)).toEqual(['optional'])
  })

  it('classifies a task by its record status', () => {
    expect(taskFlowRegion('completed')).toBe('archived')
    expect(taskFlowRegion('cancelled')).toBe('archived')
    expect(taskFlowRegion('running')).toBe('active')
    expect(taskFlowRegion('blocked')).toBe('active')
    expect(taskFlowRegion('failed')).toBe('active')
    expect(taskFlowRegion('pending')).toBe('active')
  })

  it('is empty on both sides for an empty board', () => {
    const chart = layoutTaskRegions(buildTaskGraph([]))
    expect(chart.active.items).toEqual([])
    expect(chart.archived).toEqual([])
  })
})

describe('node subtitles and arrow colours', () => {
  it('tells a blocked card what it is waiting for, by name', () => {
    const chart = chartOf([
      task('design', { status: 'running' }),
      task('implement', { dependencyIds: ['design'] }),
    ], { se: { displayName: 'SE' } })
    const blocked = chart.items.find(item => item.id === 'implement')!
    expect(blocked.subtitle).toBe('等待 design')
  })

  it('claims a running card with its owner and leaves a free one unclaimed', () => {
    const chart = chartOf([
      task('run', { status: 'running', ownerSlotIds: ['se'] }),
      task('open', { status: 'assigned', ownerSlotIds: ['se'] }),
      task('nobody', { status: 'pending' }),
    ], { se: { displayName: 'SE' } })
    const at = (id: string) => chart.items.find(item => item.id === id)!
    expect(at('run').subtitle).toBe('执行中：SE')
    expect(at('open').subtitle).toBe('认领：SE')
    expect(at('nobody').subtitle).toBe('未分配')
  })

  it('colours every arrow by the task that waits on it', () => {
    const chart = chartOf([
      task('done', { status: 'running' }),
      task('waiting', { dependencyIds: ['done'] }),
    ])
    // `waiting` is blocked, so its arrow carries the blocked colour.
    expect(chart.edges[0]!.sourceState).toBe('blocked')
  })
})
