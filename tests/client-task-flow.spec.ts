import { describe, expect, it } from 'vitest'
import { buildTaskGraph } from '../src/client/task-graph.js'
import { FLOW_NODE, layoutTaskFlow } from '../src/client/task-flow.js'
import {
  KEEP_RECENT_FINISHED,
  keptInFlow,
  layoutTaskRegions,
  taskFlowRegion,
} from '../src/client/task-flow-regions.js'
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

  it('keeps the finished dependency of live work in the chart, with its arrow', () => {
    // The step a task came from is the chain the reader is following, so it
    // stays drawn and keeps its arrow.
    const chart = layoutTaskRegions(buildTaskGraph([
      task('design', { status: 'completed' }),
      task('implement', { dependencyIds: ['design'], status: 'running' }),
    ]))

    expect(chart.active.items.map(item => item.id)).toEqual(['design', 'implement'])
    expect(chart.active.edges).toHaveLength(1)
    expect(chart.active.items.find(item => item.id === 'implement')!.level).toBe(1)
    expect(chart.archived).toEqual([])
  })

  it('counts a cancelled dependency as satisfied and still draws the chain', () => {
    // A cancelled step blocks nothing, so the dependent is startable — and the
    // step it came from stays in the chart for the same reason a finished one does.
    const chart = layoutTaskRegions(buildTaskGraph([
      task('optional', { status: 'cancelled' }),
      task('implement', { dependencyIds: ['optional'] }),
    ]))
    expect(chart.active.items.map(item => item.id).sort()).toEqual(['implement', 'optional'])
    expect(chart.active.items.find(item => item.id === 'implement')!.state).toBe('ready')
    expect(chart.archived).toEqual([])
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

describe('finished steps the chart keeps', () => {
  it('keeps the step a live task came from instead of breaking the chain', () => {
    const chart = layoutTaskRegions(buildTaskGraph([
      task('done', { status: 'completed', updatedAt: '2026-01-02T00:00:00.000Z' }),
      task('running', { status: 'running', dependencyIds: ['done'] }),
    ]))

    // The finished step is what explains the task below it, so it stays drawn.
    expect(chart.active.items.map(item => item.id).sort()).toEqual(['done', 'running'])
    expect(chart.archived).toEqual([])
    // Its arrow is still there, which is the point of keeping it.
    expect(chart.active.edges).toHaveLength(1)
    expect(chart.active.items.find(item => item.id === 'done')!.state).toBe('done')
  })

  it('keeps a chain of finished steps, not only the last one', () => {
    const chart = layoutTaskRegions(buildTaskGraph([
      task('a', { status: 'completed', updatedAt: '2026-01-01T00:00:00.000Z' }),
      task('b', { status: 'completed', dependencyIds: ['a'], updatedAt: '2026-01-02T00:00:00.000Z' }),
      task('c', { status: 'running', dependencyIds: ['b'] }),
    ]))

    expect(chart.active.items.map(item => item.id).sort()).toEqual(['a', 'b', 'c'])
    expect(chart.archived).toEqual([])
  })

  it('never shows one task in both halves', () => {
    const chart = layoutTaskRegions(buildTaskGraph([
      task('done', { status: 'completed' }),
      task('running', { status: 'running', dependencyIds: ['done'] }),
    ]))

    const drawn = new Set(chart.active.items.map(item => item.id))
    for (const archived of chart.archived) expect(drawn.has(archived.id)).toBe(false)
  })

  it('archives a finished step that leads nowhere, however recent', () => {
    const chart = layoutTaskRegions(buildTaskGraph([
      task('loose', { status: 'completed', updatedAt: '2026-06-01T00:00:00.000Z' }),
      task('running', { status: 'running' }),
    ]))

    expect(chart.active.items.map(item => item.id)).toEqual(['running'])
    expect(chart.archived.map(item => item.id)).toEqual(['loose'])
  })

  it('stops at the keep limit and archives the rest of a long chain', () => {
    const finished = Array.from({ length: KEEP_RECENT_FINISHED + 2 }, (_, index) =>
      task(`s${index}`, {
        status: 'completed',
        dependencyIds: index === 0 ? [] : [`s${index - 1}`],
        updatedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
      }))
    const chart = layoutTaskRegions(buildTaskGraph([
      ...finished,
      task('running', { status: 'running', dependencyIds: [`s${KEEP_RECENT_FINISHED + 1}`] }),
    ]))

    expect(chart.active.items.filter(item => item.state === 'done')).toHaveLength(KEEP_RECENT_FINISHED)
    // The oldest links fall back to the archive rather than growing the chart.
    expect(chart.archived.map(item => item.id).sort()).toEqual(['s0', 's1'])
  })

  it('keeps the most recent links of a chain, not the oldest', () => {
    const nodes = buildTaskGraph([
      task('old', { status: 'completed', updatedAt: '2026-01-01T00:00:00.000Z' }),
      task('new', { status: 'completed', dependencyIds: ['old'], updatedAt: '2026-03-01T00:00:00.000Z' }),
      task('running', { status: 'running', dependencyIds: ['new'] }),
    ]).nodes
    expect([...keptInFlow(nodes, 1)]).toEqual(['new'])
  })

  it('is empty when nothing finished', () => {
    expect([...keptInFlow(buildTaskGraph([task('a', { status: 'running' })]).nodes)]).toEqual([])
  })
})

describe('readability: related work lines up', () => {
  it('keeps an independent chain in one column instead of letting it drift', () => {
    // A→B and C→D: two chains that never touch must not cross each other.
    const chart = chartOf([
      task('a'),
      task('b', { dependencyIds: ['a'] }),
      task('c'),
      task('d', { dependencyIds: ['c'] }),
    ])
    const at = (id: string) => chart.items.find(item => item.id === id)!
    expect(at('b').x).toBe(at('a').x)
    expect(at('d').x).toBe(at('c').x)
    // The level is ordered so the arrows do not cross.
    expect(at('b').x).toBeLessThan(at('d').x)
  })

  it('lines each dependent up under its own parent, interleaved or not', () => {
    // Two chains, listed in the order a board records them: each root before
    // its step. Neither may drift under the other.
    const chart = chartOf([
      task('left'),
      task('right'),
      task('after-left', { dependencyIds: ['left'] }),
      task('after-right', { dependencyIds: ['right'] }),
    ])
    const at = (id: string) => chart.items.find(item => item.id === id)!
    expect(at('after-left').x).toBe(at('left').x)
    expect(at('after-right').x).toBe(at('right').x)
  })

  it('is stable: the same board lays out the same way twice', () => {
    const board = [
      task('a'), task('b', { dependencyIds: ['a'] }),
      task('c'), task('d', { dependencyIds: ['a', 'c'] }),
    ]
    const first = chartOf(board).items.map(item => `${item.id}@${item.x},${item.y}`)
    const second = chartOf(board).items.map(item => `${item.id}@${item.x},${item.y}`)
    expect(second).toEqual(first)
  })
})

describe('plan C: a chain is kept whole, finished or not', () => {
  it('keeps a fully finished chain instead of archiving all of it', () => {
    const chart = layoutTaskRegions(buildTaskGraph([
      task('a', { status: 'completed', updatedAt: '2026-01-01T00:00:00.000Z' }),
      task('b', { status: 'completed', dependencyIds: ['a'], updatedAt: '2026-01-02T00:00:00.000Z' }),
      task('c', { status: 'completed', dependencyIds: ['b'], updatedAt: '2026-01-03T00:00:00.000Z' }),
    ]))

    // Nothing is unfinished, yet the chain is what the reader came to see.
    expect(chart.active.items.map(item => item.id)).toEqual(['a', 'b', 'c'])
    expect(chart.archived).toEqual([])
    expect(chart.active.edges).toHaveLength(2)
  })

  it('keeps the most recent links of a finished chain and archives the rest', () => {
    const chart = layoutTaskRegions(buildTaskGraph([
      task('s1', { status: 'completed', updatedAt: '2026-01-01T00:00:00.000Z' }),
      task('s2', { status: 'completed', dependencyIds: ['s1'], updatedAt: '2026-01-02T00:00:00.000Z' }),
      task('s3', { status: 'completed', dependencyIds: ['s2'], updatedAt: '2026-01-03T00:00:00.000Z' }),
      task('s4', { status: 'completed', dependencyIds: ['s3'], updatedAt: '2026-01-04T00:00:00.000Z' }),
    ]))

    expect(chart.active.items.map(item => item.id).sort()).toEqual(['s2', 's3', 's4'])
    expect(chart.archived.map(item => item.id)).toEqual(['s1'])
  })

  it('archives a finished task whose prerequisite is not on the board', () => {
    // A loose end rather than a chain: there is nothing beside it to read.
    const chart = layoutTaskRegions(buildTaskGraph([
      task('orphan', { status: 'completed', dependencyIds: ['gone'] }),
    ]))
    expect(chart.active.items).toEqual([])
    expect(chart.archived.map(item => item.id)).toEqual(['orphan'])
  })

  it('still counts a kept finished task once, and only once', () => {
    const chart = layoutTaskRegions(buildTaskGraph([
      task('a', { status: 'completed' }),
      task('b', { status: 'completed', dependencyIds: ['a'] }),
    ]))
    const drawn = new Set(chart.active.items.map(item => item.id))
    for (const archived of chart.archived) expect(drawn.has(archived.id)).toBe(false)
  })
})
