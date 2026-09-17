import { orderedMembers } from '../domain/team-selectors.js'
import type { TeamAggregate, TeamMemberSlot } from '../domain/types.js'
import type { RuleDocumentContent } from './rule-documents.js'

/**
 * What the Leader is for: arranging work, not doing it.
 *
 * The Leader is the Session's own Agent, so it is the one the user talks to and
 * the only one that can reach them. That is also why it must not sink into the
 * work itself — a Leader writing a file is a Leader not decomposing, assigning
 * and reviewing, and the members are the ones with the work in front of them.
 * Every piece of work therefore leaves the Leader as a task.
 */
const LEADER_ROLE_INSTRUCTION = [
  'You arrange the work; you do not carry it out. Decompose what the user asks into tasks, assign each to a member with team_create_task, and drive the team through those tasks.',
  'Do not write, edit or review the deliverables yourself, and do not explore the codebase to produce them. Investigating enough to split the work and judge a result is expected; producing the result yourself is not.',
  'A task is the only way work reaches a member. Do not hand out work in a team message and do not leave work unspecified for someone to pick up: if it is work, it is a task on the board.',
  'Close the loop on what you assign: read each member update, judge it against the 验收 you wrote, and either accept it or send it back as a task with the defect stated. Report the team\'s result to the user yourself, and tell the user what is blocked rather than doing it for them.',
].join(' ')

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

/**
 * How a task is written, so every task on the board reads the same way.
 *
 * The dialog that shows a task to the reader is built from these sections: the
 * ones a task leaves out are drawn as unfilled, and the dependency section is
 * read from `dependencyIds`, not from prose. A task written any other way is
 * still shown, but its relationships and its inputs are invisible — which is
 * what the board looked like before this was stated.
 */
export const TASK_AUTHORING_SPEC = [
  'Write every task with team_create_task, and write its description as these labelled sections, one per line:',
  '前置依赖：(the task ids this waits on; write 无 when it waits on nothing)',
  '任务描述：(what the work is and what done means, in as much detail as the owner needs)',
  '任务责任人：(who owns it — already fixed by ownerSlotId/ownerSlotIds; keep the two in step)',
  '输出：(the deliverables: files, reports, evidence)',
  '输入：(what the owner is given to start from; write 无 when there is nothing)',
  '验收：(optional — the criteria a reviewer will judge by)',
  'Keep those labels and their order. Add detail under a section as numbered points rather than as one long paragraph, and Markdown is welcome.',
  'A real prerequisite must ALSO be named in team_create_task dependencyIds: the description is for the reader, but `dependencyIds` is what the board and the task graph act on. A task that waits on another and does not say so will be drawn and dispatched as if it could start immediately.',
].join('\n')

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
    ...(member.role === 'leader'
      ? [LEADER_ROLE_INSTRUCTION, TASK_AUTHORING_SPEC, LEADER_ASK_INSTRUCTION]
      : []),
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
    'Work travels as tasks: the Leader assigns it with team_create_task, and every owner is woken with the task at once, so naming several owners in ownerSlotIds starts them in parallel on the same task.',
    'team_send_message is for talking, not for handing out work. A member is told to write task updates, not to author tasks.',
    'Members must use team_update_task for status and results; member updates automatically notify the Leader.',
    'When the user message names a member with `@name`, or the 团队 view was addressing one member directly, the plugin has already delivered that message to that member; do not dispatch it again, and answer only if the message also asks something of you.',
  ].join('\n')
}
