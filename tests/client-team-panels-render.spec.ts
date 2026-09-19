import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AssistantView, CatalogView, TeamView } from '../src/transport/contracts.js'
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
