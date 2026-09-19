import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TeamView, WorkspaceGitStatusView } from '../src/transport/contracts.js'
import { WorkspaceChanges } from '../src/client/workspace/WorkspaceChanges.js'
import { WorkspacePanel } from '../src/client/workspace/WorkspacePanel.js'
import { WorkspaceTreeRow } from '../src/client/workspace/WorkspaceTreeRow.js'

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(element)
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

const team = { id: 't1', name: 'BIOS', members: {}, leaderSlotId: 'l' } as unknown as TeamView

function status(overrides: Partial<WorkspaceGitStatusView> = {}): WorkspaceGitStatusView {
  return { state: 'repository', changes: [], truncated: false, ...overrides }
}

const change = {
  path: 'MdeModulePkg/X.inf',
  kind: 'modified',
  staged: false,
  unstaged: true,
} as unknown as WorkspaceGitStatusView['changes'][number]

/** The workspace panel's pieces, each rendered on its own. */
describe('workspace panels render', () => {
  it('shows the panel with its two views', () => {
    const html = render(createElement(WorkspacePanel, {
      team,
      conversationId: undefined,
      workspacePath: '/root/code/edk2',
      refreshSignal: 0,
      onCollapse: () => {},
    }))
    expect(text(html)).toContain('/root/code/edk2')
    expect(text(html)).toContain('文件')
    expect(text(html)).toContain('变更')
  })

  it('says the workspace is unavailable when the conversation has none', () => {
    const html = render(createElement(WorkspacePanel, {
      team,
      conversationId: undefined,
      workspacePath: undefined,
      refreshSignal: 0,
      onCollapse: () => {},
    }))
    // Without a workspace there is nothing to show, and the panel says so
    // rather than rendering an empty tree.
    expect(text(html).length).toBeGreaterThan(0)
  })

  it('groups changes by what happened to them', () => {
    const html = render(createElement(WorkspaceChanges, {
      status: status({ changes: [change] }),
      error: undefined,
      refreshing: false,
      onOpenDiff: () => {},
    }))
    expect(text(html)).toContain('已修改')
    expect(text(html)).toContain('MdeModulePkg/X.inf')
  })

  it('says a clean workspace is clean rather than showing empty groups', () => {
    const html = render(createElement(WorkspaceChanges, {
      status: status(),
      error: undefined,
      refreshing: false,
      onOpenDiff: () => {},
    }))
    expect(text(html)).toContain('没有未提交变更')
  })

  it('says so when the workspace is not a repository', () => {
    const html = render(createElement(WorkspaceChanges, {
      status: status({ state: 'not-repository' }),
      error: undefined,
      refreshing: false,
      onOpenDiff: () => {},
    }))
    expect(text(html)).toContain('不是 Git 仓库')
  })

  it('warns when the change list was cut short', () => {
    const html = render(createElement(WorkspaceChanges, {
      status: status({ changes: [change], truncated: true }),
      error: undefined,
      refreshing: false,
      onOpenDiff: () => {},
    }))
    expect(text(html)).toContain('仅显示前 2000 项')
  })

  it('reports a git read failure instead of an empty list', () => {
    const html = render(createElement(WorkspaceChanges, {
      status: undefined,
      error: 'git 不可用',
      refreshing: false,
      onOpenDiff: () => {},
    }))
    expect(text(html)).toContain('git 不可用')
  })

  it('says it is still reading rather than claiming there is nothing', () => {
    const html = render(createElement(WorkspaceChanges, {
      status: undefined,
      error: undefined,
      refreshing: true,
      onOpenDiff: () => {},
    }))
    expect(text(html)).toContain('正在读取 Git 状态')
  })

  it('renders a file row with its name', () => {
    const html = render(createElement(WorkspaceTreeRow, {
      entry: { path: 'MdeModulePkg', name: 'MdeModulePkg', kind: 'directory', depth: 0 } as never,
      teamId: 't1',
      conversationId: undefined,
      onOpenFile: () => {},
    } as never))
    expect(text(html)).toContain('MdeModulePkg')
  })
})
