import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionBindingView, TeamView } from '../transport/contracts.js'

/** Row id that disables the team this Session has enabled. */
export const TEAM_SWITCH_UNBIND = 'agent-team:unbind'

/** Row id that toggles «替我审批» for the binding. */
export const TEAM_SWITCH_DELEGATE = 'agent-team:delegate'

/** Row id shown while the switch has nothing to offer. */
export const TEAM_SWITCH_EMPTY = 'agent-team:empty'

/** Whether this Session's binding runs with «替我审批». */
export function delegatedInteractions(binding: SessionBindingView | undefined): boolean {
  return binding?.conversation?.delegateInteractions === true
}

/**
 * What the composer's team switch offers for the Session it sits in.
 *
 * Enabling a team is a per-Session decision — the Session's own Agent becomes
 * the Leader — so the switch lists the teams that exist, marks the one already
 * running here, and offers to stop it. Kept apart from the component so the
 * options can be asserted without rendering.
 */
export function teamSwitchMenu(
  teams: readonly TeamView[],
  binding: SessionBindingView | undefined,
  options: { busy: boolean; error: string | undefined } = { busy: false, error: undefined },
): MenuEntry[] {
  const bound = binding?.team
  const items: MenuEntry[] = [
    { type: 'label', id: 'heading', text: bound === undefined ? '在本会话启用团队' : '本会话已启用' },
  ]
  if (teams.length === 0) {
    items.push({
      id: TEAM_SWITCH_EMPTY,
      label: '还没有团队，先在侧栏「团队」里创建',
      disabled: true,
    })
  }
  for (const team of teams) {
    const members = Object.keys(team.members).length
    const running = bound?.id === team.id
    items.push({
      id: team.id,
      label: running ? `${team.name}（已启用）` : `${team.name} · ${members} 名成员`,
      disabled: options.busy || running,
    })
  }
  if (bound !== undefined) {
    items.push({ type: 'separator', id: 'before-delegate' })
    items.push({ type: 'label', id: 'delegate-heading', text: '审批' })
    items.push({
      id: TEAM_SWITCH_DELEGATE,
      label: delegatedInteractions(binding) ? '替我审批（已开启）' : '替我审批',
      disabled: options.busy,
    })
    items.push({ type: 'separator', id: 'before-unbind' })
    items.push({
      id: TEAM_SWITCH_UNBIND,
      label: `停用「${bound.name}」`,
      danger: true,
      disabled: options.busy,
    })
  }
  if (options.error !== undefined) {
    items.push({ type: 'separator', id: 'before-error' })
    items.push({ type: 'label', id: 'error', text: options.error })
  }
  return items
}

/** What the switch says about the Session it sits in, next to the model. */
export function teamSwitchLabel(binding: SessionBindingView | undefined): string {
  const bound = binding?.team
  return bound === undefined ? '启用团队' : `团队 · ${bound.name}`
}
