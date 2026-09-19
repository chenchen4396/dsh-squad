import { randomUUID } from 'node:crypto'
import { AgentTeamError } from '../domain/errors.js'
import type { AssistantTemplate, TeamAggregate, TeamMemberSlot } from '../domain/types.js'
import type { AgentTeamStore } from '../storage/store.js'

/**
 * Reading the store, and refusing to proceed when it will not do.
 *
 * These were module-level helpers in a 1480-line service, so every subject that
 * needed one reached across the whole file for it. They are about one thing —
 * what a stored entity must be, and when a team may be changed at all — and had
 * no tests of their own.
 */

export function requireAssistant(store: AgentTeamStore, id: string): AssistantTemplate {
  const assistant = store.getAssistant(id)
  if (assistant === undefined) {
    throw new AgentTeamError('ASSISTANT_NOT_FOUND', `Unknown assistant '${id}'`)
  }
  return assistant
}

export function requireTeam(store: AgentTeamStore, id: string): TeamAggregate {
  const team = store.getTeam(id)
  if (team === undefined) throw new AgentTeamError('TEAM_NOT_FOUND', `Unknown team '${id}'`)
  return team
}

export function assertRevision(entity: string, actual: number, expected?: number): void {
  if (expected !== undefined && expected !== actual) {
    throw new AgentTeamError(
      entity === 'assistant' ? 'ASSISTANT_REVISION_CONFLICT' : 'TEAM_REVISION_CONFLICT',
      `${entity} revision conflict: expected ${expected}, current ${actual}`,
      { expected, actual },
    )
  }
}

export function assertTeamMutable(team: TeamAggregate): void {
  if (team.state === 'deleting' || team.state === 'delete_blocked') {
    throw new AgentTeamError('TEAM_DELETING', `Team '${team.id}' is deleting`)
  }
}

export function createMemberSlot(
  assistant: AssistantTemplate,
  displayName: string,
  role: 'leader' | 'member',
  now: string,
  desiredState: 'online' | 'offline',
): TeamMemberSlot {
  const slotId = randomUUID()
  return {
    id: slotId,
    assistantId: assistant.id,
    displayName,
    role,
    permissionPresetId: assistant.permissionPresetId,
    ...(assistant.reasoningEffort === undefined ? {} : { reasoningEffort: assistant.reasoningEffort }),
    ruleAllowlist: [],
    desiredState,
    lastRuntimeState: desiredState === 'online' ? 'starting' : 'offline',
    joinedAt: now,
  }
}
