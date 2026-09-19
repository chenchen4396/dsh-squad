import { orderedMembers } from '../domain/team-selectors.js'
import type { TeamAggregate, TeamMemberSlot } from '../domain/types.js'
import type { RuleDocumentContent } from './rule-documents.js'

/**
 * How the team writes a message.
 *
 * Members cannot message each other, so anything one needs another to know
 * passes through the Leader. A message that leaves out which task it concerns,
 * or what it wants done, forces the Leader to go and ask before it can route
 * anything — the relay becomes the bottleneck it was meant to avoid. Every
 * message therefore carries three things: the task, what it is for, and what
 * the recipient is expected to do about it.
 */
export const TEAM_MESSAGE_SPEC = [
  'Write every team_send_message in this format:',
  '1) Name the task it is about — pass its id as taskId. If it concerns no task, say so in the message.',
  '2) State what the message is for, in its first line: a request, an answer, or a notice.',
  '3) State what you need from the recipient: answer this question, unblock this step, confirm or correct this finding, or nothing further.',
  'Then give the substance: what you did or found, where (file and line, command and its output), and what it means for the task.',
  'Keep one subject per message. A message that asks two unrelated things gets one of them answered.',
  'A message never assigns work and never claims another member\'s finding as your own: an assignment is a task, and a finding belongs to whoever made it.',
].join('\n')

/**
 * What the Leader is for: arranging work, not doing it, and talking to the
 * team while it happens.
 *
 * The Leader is the Session's own Agent, so it is the one the user talks to and
 * the only one that can reach them. That is also why it must not sink into the
 * work itself — a Leader writing a file is a Leader not decomposing, assigning
 * and reviewing, and the members are the ones with the work in front of them.
 *
 * Work reaches a member as a task, always. Conversation is the other half of
 * the same job: making the request precise, answering what an owner is stuck
 * on, and saying why a result is going back. A Leader that only ever posts
 * tasks leaves its team guessing, and one that hands out work in prose leaves
 * the board — and the diagram of it — describing something other than the work.
 */
const LEADER_ROLE_INSTRUCTION = [
  'You arrange the work; you do not carry it out. Decompose what the user asks into tasks, assign each to a member with team_create_task, and drive the team through those tasks.',
  'Do not write, edit or review the deliverables yourself, and do not explore the codebase to produce them. Investigating enough to split the work and judge a result is expected; producing the result yourself is not.',
  'Work reaches a member as a task, never as a message. If it is work, it belongs on the board with an owner: do not hand out work in a team message and do not leave work unspecified for someone to pick up.',
  'Talking to the team is still yours to do, and expected: use team_send_message to make a task precise, to answer what an owner is stuck on, to pass on something that changes a task, and to explain why a result is going back. What you must not do is deliver work that way — a message asks, answers or explains, it does not assign.',
  'You are the only route between members. A member can message only you, so when one member needs something from another you pass it on: relay the question, the finding or the blocker to whoever should act on it — as a task when it is work, as a message when it is not.',
  'Relaying is not forwarding: keep the author named, restate the request in the terms the recipient needs, and name the task it belongs to.',
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
  'dependencyIds also decides whether the owner keeps its context: a task that names a prerequisite continues in the same Session, because the member already did the work it builds on; a task that names none starts the owner on a Session with no history. So a rework MUST name the task it reworks, or the member loses every detail of the work it is being asked to redo.',
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
    'All team members operate in the same Workspace, and the Leader is the only one you can message. When you need something from another member, ask the Leader and it will pass it on.',
    // Both roles write messages, so the format is stated for both.
    TEAM_MESSAGE_SPEC,
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
    'Members talk to the Leader and to no one else; the Leader routes whatever the team needs to hear. Send a question, a finding or a blocker to the Leader, and it decides who acts on it.',
    'team_send_message carries the conversation around the work — questions, clarifications, findings, a reason a result is going back — but never the work itself: an assignment is a task.',
    'Members must use team_update_task for status and results; member updates automatically notify the Leader.',
    'When the user message names a member with `@name`, or the 团队 view was addressing one member directly, the plugin has already delivered that message to that member; do not dispatch it again, and answer only if the message also asks something of you.',
  ].join('\n')
}
