import { describe, expect, it } from 'vitest'
import {
  TEAM_SWITCH_DELEGATE,
  TEAM_SWITCH_EMPTY,
  TEAM_SWITCH_UNBIND,
  delegatedInteractions,
  teamSwitchLabel,
  teamSwitchMenu,
} from '../src/client/composer-team-menu.js'
import type { SessionBindingView, TeamView } from '../src/transport/contracts.js'

function team(id: string, name: string, members: string[]): TeamView {
  return {
    id,
    name,
    members: Object.fromEntries(members.map(member => [member, { id: member }])),
  } as unknown as TeamView
}

const bios = team('bios', 'BIOS', ['ld', 'se', 'tse'])
const probe = team('probe', '测试', ['ld'])
const bound = (id: string, name: string): SessionBindingView => ({ team: { id, name } } as SessionBindingView)

/**
 * The composer switch is how a reader starts the team without opening the 团队
 * view, so what it offers has to be exactly the per-Session decision: the teams
 * that exist, the one running here, and stopping it.
 */
describe('teamSwitchMenu', () => {
  it('lists the teams to enable and marks the one already running', () => {
    const items = teamSwitchMenu([bios, probe], bound('bios', 'BIOS'))
    expect(items[0]).toMatchObject({ type: 'label', text: '本会话已启用' })
    expect(items).toContainEqual(expect.objectContaining({ id: 'bios', label: 'BIOS（已启用）', disabled: true }))
    expect(items).toContainEqual(expect.objectContaining({ id: 'probe', label: '测试 · 1 名成员' }))
    expect(items).toContainEqual(expect.objectContaining({ id: TEAM_SWITCH_UNBIND, label: '停用「BIOS」', danger: true }))
  })

  it('offers only the choice while no team runs here', () => {
    const items = teamSwitchMenu([bios], undefined)
    expect(items[0]).toMatchObject({ type: 'label', text: '在本会话启用团队' })
    expect(items.some(item => 'id' in item && item.id === TEAM_SWITCH_UNBIND)).toBe(false)
    expect(items).toContainEqual(expect.objectContaining({ id: 'bios', disabled: false }))
  })

  it('points at the team page when there is no team yet', () => {
    const items = teamSwitchMenu([], undefined)
    expect(items).toContainEqual(expect.objectContaining({ id: TEAM_SWITCH_EMPTY, disabled: true }))
  })

  it('shows a failure without hiding the choice, and locks rows while busy', () => {
    const items = teamSwitchMenu([bios], bound('bios', 'BIOS'), { busy: true, error: '该会话已启用另一个团队' })
    expect(items).toContainEqual(expect.objectContaining({ type: 'label', text: '该会话已启用另一个团队' }))
    expect(items).toContainEqual(expect.objectContaining({ id: TEAM_SWITCH_UNBIND, disabled: true }))
  })

  it('offers «替我审批» once a team runs here, and says when it is on', () => {
    const off = teamSwitchMenu([bios], bound('bios', 'BIOS'))
    expect(off).toContainEqual(expect.objectContaining({ id: TEAM_SWITCH_DELEGATE, label: '替我审批' }))

    const delegated = {
      team: { id: 'bios', name: 'BIOS' },
      conversation: { delegateInteractions: true },
    } as SessionBindingView
    expect(teamSwitchMenu([bios], delegated))
      .toContainEqual(expect.objectContaining({ id: TEAM_SWITCH_DELEGATE, label: '替我审批（已开启）' }))
    expect(delegatedInteractions(delegated)).toBe(true)
    expect(delegatedInteractions(bound('bios', 'BIOS'))).toBe(false)
    expect(delegatedInteractions(undefined)).toBe(false)
  })
})

describe('teamSwitchLabel', () => {
  it('names the team the Session runs, or offers to start one', () => {
    expect(teamSwitchLabel(undefined)).toBe('启用团队')
    expect(teamSwitchLabel(bound('bios', 'BIOS'))).toBe('团队 · BIOS')
  })
})
