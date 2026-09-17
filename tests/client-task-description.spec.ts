import { describe, expect, it } from 'vitest'
import { taskSections } from '../src/client/task-description.js'

/**
 * A task description arrives as one string. Dropped into a dialog as a single
 * paragraph it reads as a wall; the structure the author typed — headings,
 * numbered points, prose — is what makes it scannable, so it has to survive.
 */
describe('taskSections', () => {
  it('reads a bracketed heading with its numbered points', () => {
    const sections = taskSections([
      '在实现任务 e9db05b8 完成后执行。',
      '',
      '【复核项，逐条给判定】',
      '1) diff 边界：确认改动只有新增模块',
      '2) 命令构造点唯一性',
    ].join('\n'))

    expect(sections).toHaveLength(2)
    expect(sections[0]!.title).toBeUndefined()
    expect(sections[0]!.paragraphs).toEqual(['在实现任务 e9db05b8 完成后执行。'])
    expect(sections[1]!.title).toBe('复核项，逐条给判定')
    expect(sections[1]!.items).toEqual(['diff 边界：确认改动只有新增模块', '命令构造点唯一性'])
  })

  it('keeps prose after a list in its own section', () => {
    const sections = taskSections([
      '【产出】',
      '1) 提交结论',
      '若发现阻断问题，请同步给 LD。',
    ].join('\n'))

    expect(sections).toHaveLength(1)
    expect(sections[0]!.title).toBe('产出')
    expect(sections[0]!.items).toEqual(['提交结论'])
    expect(sections[0]!.paragraphs).toEqual(['若发现阻断问题，请同步给 LD。'])
  })

  it('honours Markdown headings and bullets too', () => {
    const sections = taskSections('## 背景\n\n- 第一条\n- 第二条\n\n正文一句。')
    expect(sections).toHaveLength(1)
    expect(sections[0]!.title).toBe('背景')
    expect(sections[0]!.items).toEqual(['第一条', '第二条'])
    expect(sections[0]!.paragraphs).toEqual(['正文一句。'])
  })

  it('recognises the numbering styles the team writes in', () => {
    expect(taskSections('1. 一\n2、二\n3) 三').flatMap(s => s.items)).toEqual(['一', '二', '三'])
    expect(taskSections('- 甲\n* 乙\n• 丙').flatMap(s => s.items)).toEqual(['甲', '乙', '丙'])
  })

  it('returns nothing for an empty description', () => {
    expect(taskSections('')).toEqual([])
    expect(taskSections('\n\n  \n')).toEqual([])
  })

  it('keeps a heading that has no body yet', () => {
    expect(taskSections('【待补充】')).toEqual([{ title: '待补充', items: [], paragraphs: [] }])
  })

  it('does not treat a mid-sentence bracket as a heading', () => {
    const sections = taskSections('这一步【重要】必须做。')
    expect(sections).toHaveLength(1)
    expect(sections[0]!.title).toBeUndefined()
    expect(sections[0]!.paragraphs).toEqual(['这一步【重要】必须做。'])
  })
})
