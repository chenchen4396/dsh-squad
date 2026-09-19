import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OptionPicker } from '../src/client/assistants/OptionPicker.js'
import { RuleDocumentPicker } from '../src/client/assistants/RuleDocumentPicker.js'

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(element)
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * Both pickers own their data and had none of their own tests. What matters is
 * that a reader can see the state they are in: still loading, nothing on offer,
 * or a list with the selection marked.
 */
describe('the pickers render their state', () => {
  it('tells a reader it is still loading', () => {
    const html = render(createElement(OptionPicker, {
      label: '可用 Skills',
      groupLabel: '选择助手可使用的 Skills',
      loadingText: '正在读取该 Preset 的 Skills…',
      loading: true,
      error: undefined,
      emptyText: '该 Agent Preset 没有可用的 Skill。',
      hint: '只选择需要的 Skills。',
      options: [],
      selected: [],
      onChange: () => {},
    }))
    expect(text(html)).toContain('正在读取该 Preset 的 Skills…')
  })

  it('says so when the preset offers nothing', () => {
    const html = render(createElement(OptionPicker, {
      label: '可用 MCP',
      groupLabel: '选择助手可使用的 MCP Server',
      loadingText: '读取中…',
      loading: false,
      error: undefined,
      emptyText: '当前 Harness 未为该 Agent Preset 配置 MCP Server。',
      hint: 'MCP 连接由 Harness 管理。',
      options: [],
      selected: [],
      onChange: () => {},
    }))
    expect(text(html)).toContain('未为该 Agent Preset 配置 MCP Server')
  })

  it('marks what is selected and counts it in the label', () => {
    const html = render(createElement(OptionPicker, {
      label: '可用 MCP',
      groupLabel: '选择助手可使用的 MCP Server',
      loadingText: '读取中…',
      loading: false,
      error: undefined,
      emptyText: '无',
      hint: 'hint',
      options: [
        { name: 'filesystem', detail: '3 个工具' },
        { name: 'memory', detail: '1 个工具' },
      ],
      selected: ['memory'],
      onChange: () => {},
    }))
    expect(text(html)).toContain('已选择 1 个')
    expect(text(html)).toContain('filesystem')
    expect(text(html)).toContain('3 个工具')
    // The checked box is what marks the selection.
    expect([...html.matchAll(/checked=""/g)]).toHaveLength(1)
  })

  it('renders an error instead of the empty message', () => {
    const html = render(createElement(OptionPicker, {
      label: '可用 Skills',
      groupLabel: 'g',
      loadingText: 'l',
      loading: false,
      error: '读取失败',
      emptyText: '该 Agent Preset 没有可用的 Skill。',
      hint: 'hint',
      options: [],
      selected: [],
      onChange: () => {},
    }))
    expect(text(html)).toContain('读取失败')
    expect(text(html)).not.toContain('没有可用的 Skill')
  })

  it('renders the rule-document picker with its import controls', () => {
    const html = render(createElement(RuleDocumentPicker, { selected: [], onChange: () => {} }))
    // The picker owns its own loading state, so it starts by saying so.
    expect(text(html)).toContain('正在读取规则文档…')
    expect(text(html)).toContain('导入文件')
    expect(text(html)).toContain('导入文件夹')
    expect(text(html)).toContain('只支持 Markdown')
  })

  it('shows how many documents are selected', () => {
    const html = render(createElement(RuleDocumentPicker, {
      selected: ['r1', 'r2'],
      onChange: () => {},
    }))
    expect(text(html)).toContain('已选择 2 份')
  })
})
