import { describe, expect, it } from 'vitest'
import { AgentTeamError } from '../src/domain/errors.js'
import type { TeamAggregate, TeamMemberSlot } from '../src/domain/types.js'
import {
  assignmentContent,
  requireMessageContent,
  taskMessageType,
  teamMessageHeader,
} from '../src/runtime/team-messages.js'
import { memberPrompt, rosterPrompt, TASK_AUTHORING_SPEC } from '../src/runtime/team-prompts.js'

describe('team runtime support', () => {
  it('builds identity and roster prompts with stable member ids', () => {
    const leader = member('leader-slot', 'Code Leader', 'leader')
    const coder = member('coder-slot', 'Coder', 'member')
    const team = {
      id: 'team-1',
      name: 'Compiler Team',
      leaderSlotId: leader.id,
      members: { [leader.id]: leader, [coder.id]: coder },
    } as unknown as TeamAggregate

    expect(memberPrompt(team, coder, 'Implement assigned code.')).toContain('You are Coder')
    expect(memberPrompt(team, coder, 'Implement assigned code.')).toContain('Implement assigned code.')
    expect(rosterPrompt(team)).toContain('Code Leader (leader), slotId=leader-slot')
    expect(rosterPrompt(team)).toContain('Coder (member), slotId=coder-slot')
  })

  it('tells the leader how to write a task, and tells members nothing of it', () => {
    const leader = member('leader-slot', 'Code Leader', 'leader')
    const coder = member('coder-slot', 'Coder', 'member')
    const team = {
      id: 'team-1',
      name: 'Compiler Team',
      leaderSlotId: leader.id,
      members: { [leader.id]: leader, [coder.id]: coder },
    } as unknown as TeamAggregate

    const leaderPrompt = memberPrompt(team, leader, 'Coordinate.')
    for (const label of ['前置依赖：', '任务描述：', '任务责任人：', '输出：', '输入：', '验收：']) {
      expect(leaderPrompt).toContain(label)
    }
    // The description is for the reader; dependencyIds is what the board acts
    // on, so the prompt has to say both.
    expect(leaderPrompt).toContain('dependencyIds')
    expect(leaderPrompt).toContain('will be drawn and dispatched as if it could start immediately')

    // A member is told to write tasks, not how to author them.
    expect(memberPrompt(team, coder, 'Implement.')).not.toContain(TASK_AUTHORING_SPEC)
  })

  it('tells the leader it arranges work rather than carrying it out', () => {
    const leader = member('leader-slot', 'Code Leader', 'leader')
    const coder = member('coder-slot', 'Coder', 'member')
    const team = {
      id: 'team-1',
      name: 'Compiler Team',
      leaderSlotId: leader.id,
      members: { [leader.id]: leader, [coder.id]: coder },
    } as unknown as TeamAggregate

    const prompt = memberPrompt(team, leader, 'Coordinate.')
    expect(prompt).toContain('You arrange the work; you do not carry it out')
    expect(prompt).toContain('A task is the only way work reaches a member')
    expect(prompt).toContain('Close the loop on what you assign')
    // The role line still tells it the truth about ownership.
    expect(prompt).toContain('Your role is leader')
    // A member is never told it arranges anything.
    expect(memberPrompt(team, coder, 'Implement.')).not.toContain('You arrange the work')
  })

  it('says in the roster that work travels as tasks, not as messages', () => {
    const leader = member('leader-slot', 'Code Leader', 'leader')
    const team = {
      id: 'team-1',
      name: 'Compiler Team',
      leaderSlotId: leader.id,
      members: { [leader.id]: leader },
    } as unknown as TeamAggregate
    const prompt = rosterPrompt(team)
    expect(prompt).toContain('Work travels as tasks')
    expect(prompt).toContain('for talking, not for handing out work')
  })

  it('keeps the spec in the order the reader reads it', () => {
    const order = ['前置依赖：', '任务描述：', '任务责任人：', '输出：', '输入：', '验收：']
      .map(label => TASK_AUTHORING_SPEC.indexOf(label))
    expect(order.every(index => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('appends imported rule documents after the assistant instructions', () => {
    const coder = member('coder-slot', 'Coder', 'member')
    const team = { id: 'team-1', name: 'Compiler Team', leaderSlotId: coder.id } as unknown as TeamAggregate

    const prompt = memberPrompt(team, coder, 'Implement assigned code.', [
      { title: '项目规范', fileName: 'CLAUDE.md', text: '- 使用严格模式。' },
    ])

    expect(prompt).toContain('## 规则：项目规范（CLAUDE.md）')
    expect(prompt).toContain('- 使用严格模式。')
    // Instructions still come first: documents are additive context.
    expect(prompt.indexOf('Implement assigned code.')).toBeLessThan(prompt.indexOf('- 使用严格模式。'))
  })

  it('sends the Leader to the question tool and keeps members off it', () => {
    const leader = member('leader-slot', 'Code Leader', 'leader')
    const coder = member('coder-slot', 'Coder', 'member')
    const team = {
      id: 'team-1',
      name: 'Compiler Team',
      leaderSlotId: leader.id,
      members: { [leader.id]: leader, [coder.id]: coder },
    } as unknown as TeamAggregate

    // Only the Leader talks to the user; a question in its reply is prose the
    // user has to retype an answer to, so it has to use the question tool.
    expect(memberPrompt(team, leader, 'Coordinate the work.')).toContain('ask_user_question')
    expect(memberPrompt(team, coder, 'Implement assigned code.')).not.toContain('ask_user_question')
  })

  it('normalizes messages and maps task states to message types', () => {
    expect(requireMessageContent('  ready  ')).toBe('ready')
    expect(() => requireMessageContent('   ')).toThrow(AgentTeamError)
    expect(teamMessageHeader('Coder', 'coder-slot')).toBe(
      '[Team message from Coder; slotId=coder-slot]',
    )
    expect(assignmentContent('Parser', 'Implement it.', ['src/parser.ts'])).toContain(
      'File scopes: src/parser.ts',
    )
    expect(taskMessageType('completed')).toBe('result')
    expect(taskMessageType('blocked')).toBe('question')
    expect(taskMessageType('failed')).toBe('warning')
    expect(taskMessageType('running')).toBe('progress')
  })
})

function member(id: string, displayName: string, role: 'leader' | 'member'): TeamMemberSlot {
  return {
    id,
    displayName,
    role,
    assistantSnapshot: {
      instructions: 'Implement assigned code.',
    },
  } as unknown as TeamMemberSlot
}
