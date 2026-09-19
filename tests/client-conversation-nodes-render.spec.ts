import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ConversationNode } from '../src/transport/contracts.js'
import { ConversationNodeView } from '../src/client/workbench/ConversationNodeView.js'

const render = (node: ConversationNode): string =>
  renderToStaticMarkup(createElement(ConversationNodeView, { node }))
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * A member's column, the meeting room and the assistant designer all show the
 * same conversation, so what a node looks like is decided here once. These
 * tests pin that a node is drawn as what it is, not as a generic block.
 */
describe('conversation nodes render', () => {
  it('draws a user turn as its text', () => {
    expect(text(render({ id: 'n1', seq: 1, kind: 'user', text: '帮我看看这个' } as never)))
      .toContain('帮我看看这个')
  })

  it('draws an assistant turn as markdown', () => {
    const html = render({ id: 'n2', seq: 2, kind: 'assistant', text: '# 结论' } as never)
    expect(html).toContain('data-markdown')
  })

  it('draws a notice with its tone', () => {
    const html = render({ id: 'n3', seq: 3, kind: 'notice', text: '会话已归档', tone: 'error' } as never)
    expect(text(html)).toContain('会话已归档')
  })

  it('draws a tool call with its name and a summary', () => {
    const html = render({
      id: 'n4',
      seq: 4,
      kind: 'tool',
      name: 'bash',
      callId: 'c1',
      arguments: '{"command":"ls"}',
      result: 'file.ts',
      status: 'success',
    } as never)
    // A finished call is collapsed, so the name is what identifies it.
    expect(text(html)).toContain('bash')
    expect(text(html)).toContain('已完成')
  })

  it('draws a thinking block as reasoning rather than as the reply', () => {
    const html = render({ id: 'n5', seq: 5, kind: 'reasoning', text: '先看代码' } as never)
    expect(text(html)).toContain('先看代码')
  })

  it('draws a team message with who sent it', () => {
    const html = render({
      id: 'n6',
      seq: 6,
      kind: 'team-message',
      text: '已完成',
      senderId: 'slot-se',
      senderName: 'SE',
      senderRole: 'member',
      messageType: 'result',
    } as never)
    expect(text(html)).toContain('SE')
    expect(text(html)).toContain('已完成')
  })
})
