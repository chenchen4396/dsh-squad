import type { TeamAggregate, TeamConversation, TeamMemberSlot, TeamMessage, TeamTask } from './types.js'

/** A workspace a conversation's member Sessions can run in. */
export interface TeamWorkspace {
  id: string
  path: string
}

/**
 * The workspace one conversation runs in. A conversation carries its own,
 * chosen when it was created; a conversation from before that split still
 * falls back to the workspace its team was created with.
 */
export function conversationWorkspace(
  team: Pick<TeamAggregate, 'workspaceId' | 'workspacePath'>,
  conversation: Pick<TeamConversation, 'workspaceId' | 'workspacePath'>,
): TeamWorkspace | undefined {
  const id = conversation.workspaceId ?? team.workspaceId
  const path = conversation.workspacePath ?? team.workspacePath
  return id === undefined || path === undefined ? undefined : { id, path }
}

/**
 * Members in presentation order: the leader first, then everyone else in join
 * order. Every surface that lists members reads them this way, so the room,
 * the member tabs and the roster all start with the leader.
 */
export function orderedMembers(
  team: Pick<TeamAggregate, 'members' | 'leaderSlotId'>,
): TeamMemberSlot[] {
  const members = Object.values(team.members)
  const leader = members.find(member => member.id === team.leaderSlotId)
  return leader === undefined
    ? members
    : [leader, ...members.filter(member => member.id !== leader.id)]
}

/**
 * Members a message addresses by name.
 *
 * The Harness composer inserts `@名字` when the reader picks a team member from
 * the `@` menu, so the mention the reader sees is exactly what routes the
 * message. A name two members share addresses both.
 *
 * @param team - team whose roster is matched.
 * @param text - the message as the user typed it.
 * @returns mentioned member slot ids, in roster order.
 */
export function mentionedSlotIds(
  team: Pick<TeamAggregate, 'members' | 'leaderSlotId'>,
  text: string,
): string[] {
  return orderedMembers(team)
    .filter(member => text.includes(`@${member.displayName}`))
    .map(member => member.id)
}

/**
 * Every member working on a task. A shared task names all of its owners;
 * records written before sharing name one.
 */
export function taskAssigneeIds(task: TeamTask): string[] {
  return task.ownerSlotIds.length > 0
    ? task.ownerSlotIds
    : task.ownerSlotId === undefined ? [] : [task.ownerSlotId]
}

/**
 * Lead line of the wake-up a room message used to relay to a member. A relay
 * now carries the user's own text and is recognised by its plugin provenance,
 * so this line only lives on in Session logs written before that change.
 */
export const ROOM_RELAY_NOTICE = '[会议室] 团队会议室有新消息，请在会议室中回应。'

/** Lead line of a wake-up that named the member it relayed to. Legacy, as above. */
export const ROOM_RELAY_MENTION_NOTICE = '[会议室] 你在团队会议室中被 @ 提及，请在会议室中回应。'

/**
 * Whether one user line is a relay wake-up an earlier version wrote into a
 * member's Session. Those relays read as the user's own line, so the room has
 * to keep dropping them; anything delivered since carries the plugin source
 * instead of this text.
 *
 * @param text - one projected user message.
 * @returns whether the text is a legacy relay wake-up.
 */
export function isRoomRelayText(text: string): boolean {
  return text.startsWith(`${ROOM_RELAY_NOTICE}\n`)
    || text.startsWith(`${ROOM_RELAY_MENTION_NOTICE}\n`)
}

/**
 * Whether one durable record is a wake-up relay an earlier bug stored as a user
 * message. Records like this were written before that relay was marked as a
 * plugin message, and they read as things the user said.
 *
 * @param message - stored room record, in any delivery state.
 * @returns whether the record is such an echo.
 */
export function isRoomRelayEcho(
  message: Pick<TeamMessage, 'sender' | 'content' | 'mentions'>,
): boolean {
  if (message.sender.kind !== 'user' || (message.mentions?.length ?? 0) === 0) return false
  return isRoomRelayText(message.content)
}
