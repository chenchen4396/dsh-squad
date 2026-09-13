/**
 * Choosing the Workspace a team's next session runs in. A team owns no
 * directory, so every session names one; the default follows the Harness's own
 * rule for "New session" — the one the user is already in, else the most
 * recently touched — with the team's own last choice taking precedence.
 */

/** One Workspace as the client already knows it. */
export interface WorkspaceChoiceSource {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  readonly updatedAt: string
}

/** One of a team's conversations, as far as the choice cares. */
export interface ConversationWorkspaceSource {
  readonly workspaceId?: string | undefined
}

/**
 * The Workspace the menu starts on: where this team worked last, else the one
 * the open Harness session is in, else the most recently touched. Undefined
 * only when the Harness has no Workspace at all to offer.
 */
export function defaultWorkspaceId(
  conversations: readonly ConversationWorkspaceSource[],
  workspaces: readonly WorkspaceChoiceSource[],
  currentSessionId: string | undefined,
): string | undefined {
  const last = [...conversations].reverse().find(item => item.workspaceId !== undefined)?.workspaceId
  if (last !== undefined) return last
  const current = currentSessionId === undefined
    ? undefined
    : workspaces.find(item => item.sessionIds.includes(currentSessionId))?.workspaceId
  if (current !== undefined) return current
  return [...workspaces]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .at(0)?.workspaceId
}
