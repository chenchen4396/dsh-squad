import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AssistantView, CatalogView } from '../src/transport/contracts.js'
import { AssistantBuilderConversation } from '../src/client/assistants/AssistantBuilder.js'
import { AssistantCard } from '../src/client/assistants/AssistantCard.js'
import { AssistantForm } from '../src/client/assistants/AssistantForm.js'
import { AssistantPanel } from '../src/client/assistants/AssistantPanel.js'
import { RuleDocumentNodeRow } from '../src/client/assistants/RuleDocumentNodeRow.js'

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(element)
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

function assistant(overrides: Partial<AssistantView> = {}): AssistantView {
  return {
    schemaVersion: 1,
    id: 'a1',
    name: 'SE 实现者',
    description: '负责代码实现',
    instructions: '实现需求',
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4.1-flash',
    reasoningEffort: 'max',
    agentPresetId: 'standard',
    permissionPresetId: 'workspace-write',
    skillAllowlist: ['find-skills'],
    mcpServers: [],
    ruleDocumentAllowlist: ['r1', 'r2'],
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as AssistantView
}

const catalog: CatalogView = {
  providers: [{ id: 'commandcode', name: 'CommandCode' }],
  models: { commandcode: [{ id: 'deepseek/deepseek-v4.1-flash', name: 'V4.1 Flash' }] },
  agentPresets: [{ id: 'standard', name: '标准' }],
  permissionPresets: [
    { value: 'read-only', name: '只读' },
    { value: 'workspace-write', name: '工作区可写' },
  ],
  workspaces: [],
}

/** The split components, each rendered on its own with a stub for the UI package. */
describe('assistant panels render', () => {
  it('lists templates and offers creating one', () => {
    const html = render(createElement(AssistantPanel, {
      catalog,
      assistants: [assistant()],
      onChanged: async () => {},
    }))
    expect(text(html)).toContain('助手模板')
    // The library states its own rule: dissolving a team does not delete these.
    expect(text(html)).toContain('解散团队不会删除助手')
    expect(text(html)).toContain('手动新建')
    expect(text(html)).toContain('SE 实现者')
  })

  it('shows the built-in designer entry even with no templates', () => {
    const html = render(createElement(AssistantPanel, {
      catalog, assistants: [], onChanged: async () => {},
    }))
    expect(text(html)).toContain('团队 Agent 小助手')
    expect(text(html)).toContain('还没有助手模板')
  })

  it('draws one card with its model, permission and counts', () => {
    const html = render(createElement(AssistantCard, {
      assistant: assistant(),
      onEdit: () => {},
      onChanged: async () => {},
    }))
    expect(text(html)).toContain('SE 实现者')
    expect(text(html)).toContain('deepseek/deepseek-v4.1-flash')
    // The permission is spelled in the reader's language, not the preset id.
    expect(text(html)).toContain('工作区可写')
    // Counts, not the joined lists.
    expect(text(html)).toContain('Skills')
    expect(text(html)).toContain('规则文档')
    expect(html).toContain('data-tone="permission"')
    expect(text(html)).toContain('负责代码实现')
  })

  it('does not draw a list of skill names on the card', () => {
    const html = render(createElement(AssistantCard, {
      assistant: assistant(),
      onEdit: () => {},
      onChanged: async () => {},
    }))
    // Five joined lists turned one card into a paragraph.
    expect(text(html)).not.toContain('find-skills')
  })

  it('lays the editor out as decisions, not one grid of fields', () => {
    const html = render(createElement(AssistantForm, {
      catalog,
      formId: 'f1',
      saving: false,
      setSaving: () => {},
      onSaved: async () => {},
    }))
    for (const section of ['基本信息', '模型', '执行', '能力']) {
      expect(text(html)).toContain(section)
    }
    expect(text(html)).toContain('名称')
    expect(text(html)).toContain('助手规则')
  })

  it('explains what the chosen permission actually permits', () => {
    const html = render(createElement(AssistantForm, {
      catalog,
      formId: 'f1',
      assistant: assistant({ permissionPresetId: 'read-only' }),
      saving: false,
      setSaving: () => {},
      onSaved: async () => {},
    }))
    // A preset name alone never told a reader that a reviewer could write.
    expect(text(html)).toContain('评审或调研类角色建议用这一档')
  })

  it('warns while a writable permission is selected', () => {
    const html = render(createElement(AssistantForm, {
      catalog,
      formId: 'f1',
      assistant: assistant({ permissionPresetId: 'workspace-write' }),
      saving: false,
      setSaving: () => {},
      onSaved: async () => {},
    }))
    expect(text(html)).toContain('可以直接修改工作区文件')
    expect(html).toContain('data-tone="warn"')
  })

  it('renders the designer chat with its history and composer', () => {
    const html = render(createElement(AssistantBuilderConversation, { catalog }))
    // Starting a conversation, the composer, and the keyboard rule the panel
    // states rather than leaving to be discovered.
    expect(text(html)).toContain('新对话')
    expect(text(html)).toContain('Enter 发送 · Shift+Enter 换行')
    expect(html).toContain('textarea')
  })

  it('names the model the designer will run on', () => {
    const html = render(createElement(AssistantBuilderConversation, { catalog }))
    // The model is read from the catalog the page already loaded.
    expect(text(html)).toContain('V4.1 Flash')
  })

  it('renders one rule-document row with its path and controls', () => {
    const html = render(createElement(RuleDocumentNodeRow, {
      node: {
        kind: 'document',
        document: {
          schemaVersion: 1,
          id: 'r1',
          path: 'rules/house.md',
          title: '团队规范',
          fileName: 'house.md',
          content: '# 规范',
          bytes: 10,
          importedAt: '2026-01-01T00:00:00.000Z',
        },
      } as never,
      depth: 0,
      selected: [],
      busy: undefined,
      previews: {},
      confirming: undefined,
      onToggle: () => {},
      onPreview: () => {},
      onAskDelete: () => {},
      onDelete: () => {},
    }))
    expect(text(html)).toContain('团队规范')
    expect(html).toContain('type="checkbox"')
  })
})
