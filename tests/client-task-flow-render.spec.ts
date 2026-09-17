import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TaskFlowChart } from '../src/client/teams/TaskFlowChart.js'
import type { TeamTask } from '../src/domain/types.js'

/**
 * The chart is what the reader actually looks at, so the drawn markup is the
 * contract: one ellipse per task, one arrow per dependency, and the legend that
 * says what each fill means.
 */
function task(id: string, title: string, overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id,
    title,
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

const REFERENCE = [
  task('parse', '解析', { status: 'completed', ownerSlotIds: ['se'] }),
  task('transcode', '转码', { dependencyIds: ['parse'], status: 'running', ownerSlotIds: ['se'] }),
  task('thumbnail', '生成缩略图', { dependencyIds: ['parse'], status: 'running', ownerSlotIds: ['tse'] }),
  task('watermark', '添加水印', { dependencyIds: ['transcode', 'thumbnail'] }),
  task('publish', '发布', { dependencyIds: ['watermark'] }),
]

const MEMBERS = { se: { displayName: 'SE' }, tse: { displayName: 'TSE' } }

describe('TaskFlowChart rendering', () => {
  it('draws the reference flow chart: nodes, arrows and a legend', () => {
    const html = renderToStaticMarkup(createElement(TaskFlowChart, {
      tasks: REFERENCE,
      members: MEMBERS,
    }))
    console.log('--- 图中节点数 ---', [...html.matchAll(/taskFlowCard/g)].length)
    console.log('--- 图内箭头数 ---', [...html.matchAll(/marker-end/g)].length)
    console.log('--- 归档条数 ---', [...html.matchAll(/taskFlowArchiveItem/g)].length)
    console.log('--- 图内文本 ---')
    console.log([...html.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(match => match[1]).join(' | '))

    // The finished 解析 unlocks 转码, so it stays drawn with its arrow: five
    // cards, five arrows. Only a finished task that explains nothing archives.
    expect([...html.matchAll(/class="_taskFlowCard/g)]).toHaveLength(5)
    expect([...html.matchAll(/class="_taskFlowBadge_/g)]).toHaveLength(5)
    expect([...html.matchAll(/marker-end/g)]).toHaveLength(5)
    // Each card gets a halo layer, which is what breathes while a task runs.
    expect([...html.matchAll(/class="_taskFlowHalo_/g)]).toHaveLength(5)
    // Something is running here, so the header line animates with it.
    expect(html).toContain('data-active="true"')

    // The card carries a state badge spelled the reference chart's way.
    expect(html).toContain('in progress')
    expect(html).toContain('blocked')
    // And a subtitle: what it is waiting for, or who is on it.
    expect(html).toContain('等待 转码')
    expect(html).toContain('执行中：')
    // The live nodes carry their states.
    expect(html).toContain('转码')
    expect(html).toContain('data-state="running"')
    expect(html).toContain('data-state="blocked"')
    // The step that explains live work stays in the chart rather than moving
    // aside, which is the point: the chain reads without a gap.
    expect(html).toContain('解析')
    expect(html).toContain('1/5 已完成')
    // Both halves are named.
    expect(html).toContain('进行中')
    expect(html).toContain('已完成')
    // The legend explains the two arrow styles.
    expect(html).toContain('依赖已满足')
    expect(html).toContain('依赖未完成')
    // An arrow is an actual path, not a straight line collapse.
    expect(html).toMatch(/<path[^>]*d="M [\d.]+ [\d.]+ C /)
  })

  it('keeps the full title reachable when the node label has to be cut', () => {
    const html = renderToStaticMarkup(createElement(TaskFlowChart, {
      tasks: [task('long', '这是一个非常长的任务标题需要被截断显示')],
      members: {},
    }))
    // Visible label is cut, the tooltip and the svg title keep the whole one.
    expect(html).toContain('…')
    expect(html).toContain('这是一个非常长的任务标题需要被截断显示')
  })

  it('shows no detail panel until a task is picked', () => {
    const html = renderToStaticMarkup(createElement(TaskFlowChart, {
      tasks: REFERENCE,
      members: MEMBERS,
    }))
    // The detail is opened by a click, so the first paint has none of its facts.
    expect(html).not.toContain('完成后解锁')
    // The two halves are named, so the split is legible before any click.
    expect(html).toContain('进行中')
    expect(html).toContain('已完成')
  })

  it('renders nothing for a conversation with no tasks', () => {
    expect(renderToStaticMarkup(createElement(TaskFlowChart, { tasks: [], members: {} }))).toBe('')
  })

  it('says the archive is empty while everything is still in flight', () => {
    const html = renderToStaticMarkup(createElement(TaskFlowChart, {
      tasks: [task('open', '进行中的任务', { status: 'running' })],
      members: {},
    }))
    expect(html).toContain('还没有完成的任务')
    expect(html).not.toContain('taskFlowArchiveItem')
    expect(html).toContain('0/1 已完成')
  })
})

describe('the archive draws the same cards as the chart', () => {
  it('gives an archived task a badge, a title and a state, not a bare row', () => {
    const html = renderToStaticMarkup(createElement(TaskFlowChart, {
      tasks: [
        task('done', '已经完成的孤立任务', { status: 'completed', ownerSlotIds: ['se'] }),
        task('running', '正在做的事', { status: 'running', ownerSlotIds: ['tse'] }),
      ],
      members: MEMBERS,
    }))

    // One card per task wherever it sits: two cards, two badges.
    expect([...html.matchAll(/class="_taskFlowCard/g)]).toHaveLength(2)
    expect([...html.matchAll(/class="_taskFlowBadge_/g)]).toHaveLength(2)
    // The archived card carries its own words, not a single-line summary.
    expect(html).toContain('已经完成的孤立任务')
    expect(html).toContain('completed')
    expect(html).toContain('SE')
    // The finished task is not in the chart, so it draws no chart arrows.
    expect([...html.matchAll(/marker-end/g)]).toHaveLength(0)
    // Both cards are drawn at the chart's own card size: the archive must not
    // stretch them to fill its column and come out larger than the chart's.
    for (const card of html.matchAll(/taskFlowCard[^>]*width="(\d+)" height="(\d+)"/g)) {
      expect([card[1], card[2]]).toEqual(['150', '58'])
    }
  })
})
