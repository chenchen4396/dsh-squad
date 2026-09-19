import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AssistantView, CatalogView, TeamView } from '../src/transport/contracts.js'
import { MemberTabs } from '../src/client/teams/MemberTabs.js'
import { TeamDetail } from '../src/client/teams/TeamDetail.js'
import { TeamForm } from '../src/client/teams/TeamForm.js'
import { TeamList } from '../src/client/teams/TeamList.js'
import { TeamPanel } from '../src/client/teams/TeamPanel.js'
import { TeamWorkbench } from '../src/client/teams/TeamWorkbench.js'

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(element)
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

function assistant(overrides: Partial<AssistantView> = {}): AssistantView {
  return {
    schemaVersion: 1,
    id: 'a1',
    name: 'SE',
    instructions: '',
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4.1-flash',
    agentPresetId: 'standard',
    permissionPresetId: 'workspace-write',
    skillAllowlist: [],
    mcpServers: [],
    ruleDocumentAllowlist: [],
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as AssistantView
}

function team(overrides: Partial<TeamView> = {}): TeamView {
  const leader = {
    id: 'slot-leader',
    assistantId: 'a1',
    displayName: 'LD',
    role: 'leader',
    permissionPresetId: 'workspace-write',
    ruleAllowlist: [],
    desiredState: 'online',
    lastRuntimeState: 'offline',
    joinedAt: '2026-01-01T00:00:00.000Z',
  }
  const member = { ...leader, id: 'slot-se', displayName: 'SE', role: 'member' }
  return {
    schemaVersion: 1,
    id: 't1',
    name: 'BIOS',
    leaderSlotId: 'slot-leader',
    state: 'active',
    directMemberChat: true,
    members: { 'slot-leader': leader, 'slot-se': member },
    retiredSessions: {},
    tasks: {},
    leases: {},
    outbox: {},
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as unknown as TeamView
}

const catalog: CatalogView = {
  providers: [{ id: 'commandcode', name: 'CommandCode' }],
  models: { commandcode: [{ id: 'm', name: 'Model' }] },
  agentPresets: [{ id: 'standard', name: '标准' }],
  permissionPresets: [{ value: 'workspace-write', name: '工作区可写' }],
  workspaces: [],
}

/** The team panel's pieces, each rendered on its own. */
describe('team panels render', () => {
  it('lists teams with their leader and member counts', () => {
    const html = render(createElement(TeamList, { teams: [team()], now: Date.now() }))
    expect(text(html)).toContain('BIOS')
    expect(text(html)).toContain('团队')
    expect(text(html)).toContain('队长')
    expect(text(html)).toContain('成员')
    // The row is a button so it is reachable by keyboard; it also says so.
    expect(html).toContain('aria-label="打开团队「BIOS」"')
  })

  it('shows an empty list without inventing a row', () => {
    const html = render(createElement(TeamList, { teams: [], now: Date.now() }))
    expect(text(html)).not.toContain('BIOS')
    expect(text(html)).toContain('团队')
  })

  it('renders the create form with its member picker', () => {
    const html = render(createElement(TeamForm, {
      catalog,
      assistants: [assistant()],
      onCancel: () => {},
      onCreated: async () => {},
    }))
    expect(text(html)).toContain('团队名称')
    expect(text(html)).toContain('SE')
    // The form states the rule that makes a team valid, and where the
    // workspace comes from.
    expect(text(html)).toContain('至少选择一个助手当团队 Leader')
    expect(text(html)).toContain('每个会话可以有自己的 Workspace')
    expect(text(html)).toContain('创建团队')
  })

  it('renders the team page, which shows the empty state before a team is chosen', () => {
    const html = render(createElement(TeamPanel, {
      catalog,
      assistants: [assistant()],
      teams: [team()],
      selectedTeamId: undefined,
    } as never))
    // With nothing selected the page shows the list and the create action.
    expect(text(html)).toContain('BIOS')
  })

  it('renders a team detail with its members and actions', () => {
    const html = render(createElement(TeamDetail, {
      team: team(),
      catalog,
      assistants: [assistant()],
      permissionPresets: catalog.permissionPresets,
      onBack: () => {},
      onChanged: async () => {},
    } as never))
    expect(text(html)).toContain('BIOS')
    expect(text(html)).toContain('LD')
  })

  it('renders the workbench with its view tabs', () => {
    const html = render(createElement(TeamWorkbench, {
      team: team(),
      conversationId: 'c1',
      catalog,
      assistants: [assistant()],
      permissionPresets: catalog.permissionPresets,
      onChanged: async () => {},
    }))
    // The three views the workbench offers, named where the reader chooses them.
    expect(text(html)).toContain('会议室')
    expect(text(html)).toContain('成员视图')
    expect(text(html)).toContain('流程图')
  })
})

describe('the member column', () => {
  it('offers opening a member Session only when there is one to open', async () => {
    const { openSessionFor } = await import('../src/client/teams/MemberColumn.js')
    const view = team()
    const leader = view.members[view.leaderSlotId]!
    // The Leader is the Session the reader is already in; it has no column to
    // open, and the member grid and the focused room view must agree on that.
    expect(openSessionFor(view, leader, new Map())).toBeUndefined()

    const member = view.members['slot-se']!
    expect(openSessionFor(view, member, new Map())).toBeUndefined()
    const sessions = new Map([['slot-se', { slotId: 'slot-se', sessionId: 'session-se' }]])
    expect(typeof openSessionFor(view, member, sessions as never)).toBe('function')
  })
})

describe('the assistant management dialog', () => {
  it('is one dialog reachable from two places, and says which', async () => {
    const { AssistantManagementDialog } = await import('../src/client/teams/TeamDialogs.js')
    const fromPanel = renderToStaticMarkup(createElement(AssistantManagementDialog, {
      open: true,
      title: '管理助手',
      onClose: () => {},
      catalog: undefined,
      assistants: [],
      onChanged: async () => {},
    }))
    const fromTeam = renderToStaticMarkup(createElement(AssistantManagementDialog, {
      open: true,
      title: '助手配置',
      onClose: () => {},
      catalog: undefined,
      assistants: [],
      onChanged: async () => {},
    }))
    // The same body behind both doors; only the title says which one.
    const body = (html: string): string => html.replace(/title="[^"]*"/g, '')
    expect(body(fromPanel)).toBe(body(fromTeam))
    expect(fromPanel).toContain('管理助手')
    expect(fromTeam).toContain('助手配置')
  })

  it('renders nothing while it is closed', async () => {
    const { AssistantManagementDialog } = await import('../src/client/teams/TeamDialogs.js')
    const html = renderToStaticMarkup(createElement(AssistantManagementDialog, {
      open: false,
      title: '管理助手',
      onClose: () => {},
      catalog: undefined,
      assistants: [],
      onChanged: async () => {},
    }))
    expect(html).toBe('')
  })
})

describe('the remove-member confirmation', () => {
  it('names the member and says what is kept', async () => {
    const { RemoveTeamMemberDialog } = await import('../src/client/teams/TeamDialogs.js')
    const html = renderToStaticMarkup(createElement(RemoveTeamMemberDialog, {
      open: true,
      member: { displayName: 'SE' },
      busy: false,
      error: undefined,
      onCancel: () => {},
      onConfirm: () => {},
    }))
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    expect(text).toContain('确定移出“SE”')
    // The warning is a promise the service keeps: a member with open work is
    // refused. Both call sites must say the same thing.
    expect(text).toContain('未完成任务')
    expect(text).toContain('Session 历史都会保留')
    expect(text).toContain('确认移出')
  })

  it('reports a failure instead of closing quietly', async () => {
    const { RemoveTeamMemberDialog } = await import('../src/client/teams/TeamDialogs.js')
    const html = renderToStaticMarkup(createElement(RemoveTeamMemberDialog, {
      open: true,
      member: { displayName: 'SE' },
      busy: false,
      error: '该成员仍有未完成任务',
      onCancel: () => {},
      onConfirm: () => {},
    }))
    expect(html.replace(/<[^>]+>/g, ' ')).toContain('该成员仍有未完成任务')
  })

  it('says it is working rather than looking idle', async () => {
    const { RemoveTeamMemberDialog } = await import('../src/client/teams/TeamDialogs.js')
    const html = renderToStaticMarkup(createElement(RemoveTeamMemberDialog, {
      open: true,
      member: { displayName: 'SE' },
      busy: true,
      error: undefined,
      onCancel: () => {},
      onConfirm: () => {},
    }))
    expect(html.replace(/<[^>]+>/g, ' ')).toContain('移出中')
  })
})

describe('the member tabs', () => {
  const member = (id: string, name: string, role: 'leader' | 'member') => ({
    id, displayName: name, role, assistantId: 'a1', permissionPresetId: 'read-only',
    ruleAllowlist: [], desiredState: 'online', lastRuntimeState: 'offline', joinedAt: '',
  })
  const team = {
    members: {
      'slot-leader': member('slot-leader', 'LD', 'leader'),
      'slot-se': member('slot-se', 'SE', 'member'),
    },
  } as unknown as TeamView

  const render = (props: Record<string, unknown> = {}): string =>
    renderToStaticMarkup(createElement(MemberTabs, {
      members: Object.values(team.members),
      conversations: new Map(),
      selectedSlotId: undefined,
      onPick: () => {},
      onRemove: () => {},
      ...props,
    } as never))

  it('marks the Leader and offers no remove action for it', () => {
    const html = render()
    expect(html).toContain('Leader')
    // The team cannot do without its Leader slot, so it is not removable.
    expect([...html.matchAll(/aria-label="移出成员/g)]).toHaveLength(1)
    expect(html).toContain('移出成员 SE')
  })

  it('badges a member who is waiting on the reader', () => {
    const conversations = new Map([['slot-se', {
      slotId: 'slot-se', status: 'idle', pendingInteractions: [{ id: 'i1' }],
    }]])
    const html = render({ conversations })
    expect(html).toContain('该成员在等你的回答或审批')
  })

  it('marks the member being looked at alone', () => {
    const html = render({ selectedSlotId: 'slot-se' })
    expect([...html.matchAll(/memberTabActive/g)]).toHaveLength(1)
    // Clicking the selected tab goes back to showing everybody.
    expect(html).toContain('显示全部成员')
  })
})
