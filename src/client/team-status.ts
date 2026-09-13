import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * The harness's own state vocabulary for one runtime state, so every dot in
 * the plugin is the shipped `StateDot` rather than a local colour choice.
 */
export function runtimeStateDot(state: string): StateDotState {
  switch (state) {
    case 'running':
    case 'starting':
      return 'ongoing'
    case 'waiting_approval':
      return 'warning'
    case 'error':
      return 'error'
    default:
      return 'idle'
  }
}

export interface TeamExecutionView {
  members: Record<string, { lastRuntimeState: string }>
  tasks: Record<string, { status: string }>
}

export function isTeamExecuting(team: TeamExecutionView): boolean {
  return Object.values(team.members).some(member => (
    member.lastRuntimeState === 'running' || member.lastRuntimeState === 'waiting_approval'
  )) || Object.values(team.tasks).some(task => task.status === 'running')
}
