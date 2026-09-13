import { orderedMembers } from '../domain/team-selectors.js'
import type { TeamAggregate, TeamMemberSlot } from '../domain/types.js'
import type { RuleDocumentContent } from './rule-documents.js'

/**
 * The Leader is the Session's own Agent, so the user is its direct counterpart.
 * A question only the user can answer has to be asked through the Harness
 * question tool, which is what puts a one-click box in front of it; a question
 * written into the reply is just prose the user has to retype an answer to.
 */
const LEADER_ASK_INSTRUCTION = [
  'You are the Agent the user talks to directly in this conversation, so a decision only the user can make is asked of it directly.',
  'When you need one, ask it with the question tool (ask_user_question) instead of listing the questions in your reply: that turn then waits for the answer, which is the point of asking.',
  'Keep plain text for progress and findings that need no answer.',
].join(' ')

export function memberPrompt(
  team: TeamAggregate,
  member: TeamMemberSlot,
  instructions: string,
  rules: readonly RuleDocumentContent[] = [],
): string {
  return [
    `You are ${member.displayName}, an independent Agent in the team “${team.name}”.`,
    `Your role is ${member.role}. The leader coordinates work but does not own other Agents.`,
    'All team members operate in the same Workspace. Coordinate before editing overlapping files.',
    ...(member.role === 'leader' ? [LEADER_ASK_INSTRUCTION] : []),
    instructions,
    ...rules.map(rule => `## 规则：${rule.title}（${rule.fileName}）\n${rule.text}`),
  ].filter(Boolean).join('\n\n')
}

export function rosterPrompt(team: TeamAggregate): string {
  const roster = orderedMembers(team)
    .map(member => `- ${member.displayName} (${member.role}), slotId=${member.id}`)
    .join('\n')
  return [
    `Team roster:\n${roster}`,
    'The shared task board and durable team mailbox are the coordination protocol.',
    'Leaders assign work with team_create_task; every owner is woken with the task at once, so naming several owners in ownerSlotIds starts them in parallel on the same task.',
    'Members must use team_update_task for status and results; member updates automatically notify the Leader.',
    'Use team_send_message for questions and other explicit member communication.',
    'When the user message names a member with `@name`, or the 团队 view was addressing one member directly, the plugin has already delivered that message to that member; do not dispatch it again, and answer only if the message also asks something of you.',
  ].join('\n')
}
