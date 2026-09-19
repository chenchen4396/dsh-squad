import type { CatalogView, MemberConversationView, TeamView } from '../../transport/contracts.js'
import type { MemberModelLabel } from '../labels.js'
import { memberModelLabel } from '../labels.js'
import { assistantForMember } from '../member-assistant.js'
import { openMemberSession } from '../store.js'
import { ConversationColumn } from '../workbench/ConversationColumn.js'

/**
 * One member's own column.
 *
 * It appears twice — in the member grid, and alone when a member is opened
 * from the meeting room — and both places were spelling out the same eleven
 * props, including the rule for whether a column can be opened as a Session at
 * all. They had already drifted: one site narrowed the callback with an
 * assertion the other did not need. Deriving it in one place is what stops
 * that happening again.
 */
export function MemberColumn({
  team,
  conversationId,
  member,
  assistants,
  catalog,
  conversations,
  expanded,
  onLoadOlder,
  onSent,
  onExpandedChange,
}: {
  team: TeamView
  conversationId: string
  member: TeamView['members'][string]
  assistants: readonly { id: string }[]
  catalog: CatalogView | undefined
  conversations: Map<string, MemberConversationView>
  expanded: boolean
  onLoadOlder: () => Promise<void> | void
  onSent: () => Promise<void> | void
  onExpandedChange: (expanded: boolean) => void
}): JSX.Element {
  const assistant = assistantForMember(assistants as never, member)
  const model: MemberModelLabel = memberModelLabel(
    catalog?.models,
    member,
    team.leaderSlotId,
    assistant,
  )
  const openSession = openSessionFor(team, member, conversations)
  return (
    <ConversationColumn
      team={team}
      conversationId={conversationId}
      member={member}
      assistant={assistant}
      model={model}
      onLoadOlder={async () => { await onLoadOlder() }}
      conversation={conversations.get(member.id)}
      onSent={async () => { await onSent() }}
      {...(openSession === undefined ? {} : { onOpenSession: openSession })}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
    />
  )
}

/**
 * How to open a member's own Session, when there is one to open.
 *
 * The Leader is the Session the reader is already in, so it has no separate
 * column to open; and a member whose Session has not been recorded cannot be
 * opened either.
 */
export function openSessionFor(
  team: TeamView,
  member: TeamView['members'][string],
  conversations: Map<string, MemberConversationView>,
): (() => void) | undefined {
  if (member.id === team.leaderSlotId) return undefined
  const sessionId = conversations.get(member.id)?.sessionId
  if (sessionId === undefined) return undefined
  return () => { openMemberSession(sessionId) }
}
