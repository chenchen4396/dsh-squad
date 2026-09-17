import { describe, expect, it } from 'vitest'
import { groupTaskBlocks, inlineTokens, taskBlocks } from '../src/client/task-markdown.js'

/**
 * The descriptions the team writes are Markdown by habit. Drawn as one
 * paragraph, every heading, list and code fence turns into noise, so the blocks
 * have to be read back out — and anything this reader does not know must stay
 * exactly as written rather than be guessed at.
 */
describe('taskBlocks', () => {
  it('reads Markdown headings at their own level', () => {
    expect(taskBlocks('## 复核项\n### 细节')).toEqual([
      { kind: 'heading', level: 2, text: '复核项' },
      { kind: 'heading', level: 3, text: '细节' },
    ])
  })

  it('reads a title underlined with === or ---', () => {
    expect(taskBlocks('实现说明\n===\n\n正文')).toEqual([
      { kind: 'heading', level: 1, text: '实现说明' },
      { kind: 'paragraph', text: '正文' },
    ])
    expect(taskBlocks('小节\n---')).toEqual([{ kind: 'heading', level: 2, text: '小节' }])
  })

  it('prefers a known label over an underlined title', () => {
    // `任务说明` is one of the labels the dialog groups by; read as a plain
    // heading it would swallow the text under it instead of starting a section.
    expect(labelled(taskBlocks('任务说明\n===\n\n正文'))).toEqual(['任务描述'])
  })

  it('groups consecutive list items of every numbering style', () => {
    const blocks = taskBlocks('- 甲\n1. 乙\n2、丙\n• 丁')
    expect(blocks).toEqual([{ kind: 'items', items: ['甲', '乙', '丙', '丁'] }])
  })

  it('reads a fenced code block with its language and inner lines intact', () => {
    const blocks = taskBlocks('说明\n\n```c\nSTATIC_ASSERT(sizeof(X) == 10);\n\nreturn;\n```\n\n结尾')
    expect(blocks).toEqual([
      { kind: 'paragraph', text: '说明' },
      { kind: 'code', language: 'c', text: 'STATIC_ASSERT(sizeof(X) == 10);\n\nreturn;' },
      { kind: 'paragraph', text: '结尾' },
    ])
  })

  it('reads a fence without a language, and one closed by ~~~', () => {
    expect(taskBlocks('~~~\nplain\n~~~')).toEqual([{ kind: 'code', text: 'plain' }])
  })

  it('keeps an unterminated fence as code rather than dropping the rest', () => {
    expect(taskBlocks('```\nnever closed')).toEqual([{ kind: 'code', text: 'never closed' }])
  })

  it('reads quotes and horizontal rules', () => {
    expect(taskBlocks('> 注意这一点\n\n---')).toEqual([
      { kind: 'quote', text: '注意这一点' },
      { kind: 'rule' },
    ])
  })

  it('joins wrapped lines into one paragraph', () => {
    expect(taskBlocks('第一行\n第二行\n\n另一段')).toEqual([
      { kind: 'paragraph', text: '第一行 第二行' },
      { kind: 'paragraph', text: '另一段' },
    ])
  })

  it('keeps a paragraph and a list apart when they touch', () => {
    expect(taskBlocks('先说明。\n- 一条')).toEqual([
      { kind: 'paragraph', text: '先说明。' },
      { kind: 'items', items: ['一条'] },
    ])
  })

  it('leaves unknown markup exactly as written', () => {
    // A table is not understood, so it must survive verbatim rather than be
    // silently rewritten into something the author did not write.
    const table = '| a | b |\n|---|---|\n| 1 | 2 |'
    expect(taskBlocks(table)).toEqual([{ kind: 'paragraph', text: '| a | b | |---|---| | 1 | 2 |' }])
  })

  it('handles text that is not Markdown at all', () => {
    expect(taskBlocks('就是一句普通的话。')).toEqual([{ kind: 'paragraph', text: '就是一句普通的话。' }])
    expect(taskBlocks('')).toEqual([])
  })
})

describe('inlineTokens', () => {
  it('splits bold, code and links out of a line', () => {
    expect(inlineTokens('确认 `git status` 与 **零改动**，见 [规范](https://example.com/x)'))
      .toEqual([
        { kind: 'text', text: '确认 ' },
        { kind: 'code', text: 'git status' },
        { kind: 'text', text: ' 与 ' },
        { kind: 'strong', text: '零改动' },
        { kind: 'text', text: '，见 ' },
        { kind: 'link', text: '规范', href: 'https://example.com/x' },
      ])
  })

  it('leaves an unbalanced marker as literal text', () => {
    expect(inlineTokens('未闭合的 **强调')).toEqual([{ kind: 'text', text: '未闭合的 **强调' }])
  })

  it('does not turn a bare path into a link', () => {
    expect(inlineTokens('[不是链接](Notes.md)')).toEqual([{ kind: 'text', text: '[不是链接](Notes.md)' }])
  })

  it('keeps plain text as one token', () => {
    expect(inlineTokens('普通文字')).toEqual([{ kind: 'text', text: '普通文字' }])
  })
})

/** The labels a description is grouped under, in order. */
const labelled = (blocks: ReturnType<typeof taskBlocks>): string[] =>
  groupTaskBlocks(blocks)
    .map(group => group.title)
    .filter((title): title is string => title !== undefined)

describe('groupTaskBlocks', () => {
  it('splits a description on the labels the author used', () => {
    const groups = groupTaskBlocks(taskBlocks([
      '先把结论说清楚。',
      '输入：一份接口表',
      '输出：',
      '- 驱动源码',
      '- 构建日志',
    ].join('\n')))

    // The unlabelled body comes first, then each label with what it carries.
    expect(groups.map(g => g.title)).toEqual([undefined, '输入', '输出'])
    expect(groups[0]!.blocks).toEqual([{ kind: 'paragraph', text: '先把结论说清楚。' }])
    expect(groups[1]!.blocks).toEqual([{ kind: 'paragraph', text: '一份接口表' }])
    expect(groups[2]!.blocks).toEqual([{ kind: 'items', items: ['驱动源码', '构建日志'] }])
  })

  it('normalises the spellings to one set of names', () => {
    expect(labelled(taskBlocks('产出：x\n负责人：SE\n依赖：y')))
      .toEqual(['输出', '任务责任人', '前置依赖'])
  })

  it('treats a bracketed label as a section too', () => {
    const groups = groupTaskBlocks(taskBlocks('【验收标准】\n1. 构建通过'))
    expect(labelled(taskBlocks('【验收标准】\n1. 构建通过'))).toEqual(['验收'])
    expect(groups[0]!.blocks).toEqual([{ kind: 'items', items: ['构建通过'] }])
  })

  it('keeps code and lists inside the section they belong to', () => {
    const groups = groupTaskBlocks(taskBlocks('输出：\n```c\nint x;\n```\n\n输入：\n一份表'))
    expect(labelled(taskBlocks('输出：\n```c\nint x;\n```\n\n输入：\n一份表')))
      .toEqual(['输出', '输入'])
    expect(groups[0]!.blocks).toEqual([{ kind: 'code', language: 'c', text: 'int x;' }])
  })

  it('does not mistake ordinary prose for a label', () => {
    const groups = groupTaskBlocks(taskBlocks('这一步的输出结果需要复核。'))
    expect(groups).toEqual([{ blocks: [{ kind: 'paragraph', text: '这一步的输出结果需要复核。' }] }])
  })
})
