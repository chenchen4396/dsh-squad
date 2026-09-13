import type { AssistantView, TeamView } from '../transport/contracts.js'

/**
 * The assistant a member runs as, resolved against the assistant catalog.
 *
 * Members inherit their assistant live instead of carrying a frozen copy, so
 * every surface that shows a member's model, Skills, or preset reads it from
 * here. The catalog is loaded independently of the team, so this can briefly be
 * undefined — callers degrade rather than assume.
 */
export function assistantForMember(
  assistants: readonly AssistantView[],
  member: TeamView['members'][string],
): AssistantView | undefined {
  return assistants.find(assistant => assistant.id === member.assistantId)
}
