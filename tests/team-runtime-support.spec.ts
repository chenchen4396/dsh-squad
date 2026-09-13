import { describe, expect, it } from 'vitest'
import { AgentTeamError } from '../src/domain/errors.js'
import type { TeamAggregate, TeamMemberSlot } from '../src/domain/types.js'
import {
  assignmentContent,
  requireMessageContent,
  taskMessageType,
  teamMessageHeader,
} from '../src/runtime/team-messages.js'
import { memberPrompt, rosterPrompt } from '../src/runtime/team-prompts.js'

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
