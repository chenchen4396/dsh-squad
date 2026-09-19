import { describe, expect, it, vi } from 'vitest'
import { teamComposition, type CompositionDeps } from '../src/runtime/team-composition.js'

/**
 * What a team puts on an Agent.
 *
 * A Leader's own Agent and each member's Agent get the same two prompt sections
 * and the same team tools — that is why this is one function, and the point of
 * these tests is that the two callers cannot drift apart, which is what happened
 * when it was written out twice.
 */
function harness(): {
  deps: CompositionDeps
  calls: { created: unknown[]; updated: unknown[]; sent: unknown[]; boards: number }
} {
  const calls = { created: [] as unknown[], updated: [] as unknown[], sent: [] as unknown[], boards: 0 }
  const deps = {
    service: {
      getTeam: () => ({
        id: 't1',
        revision: 7,
        tasks: {
          a: { id: 'a', conversationId: 'c1', title: 'A' },
          b: { id: 'b', conversationId: 'other', title: 'B' },
        },
      }),
      assistantForMember: () => ({ instructions: '做' }),
    },
    commands: {
      createTask: async (...args: unknown[]) => { calls.created.push(args); return { taskId: 'x', status: 'pending' } },
      updateTask: async (...args: unknown[]) => { calls.updated.push(args); return { taskId: 'x', status: 'done' } },
      sendMemberMessage: async (...args: unknown[]) => { calls.sent.push(args); return { messageId: 'm', deliveryState: 'delivered' } },
    },
    rulesFor: () => [],
    assertToolIdentity: vi.fn(),
  } as unknown as CompositionDeps
  return { deps, calls }
}

const team = { id: 't1', leaderSlotId: 'slot-leader', members: {} } as never

describe('team composition', () => {
  it('names its sections after the slot and the team', () => {
    const { deps } = harness()
    const composition = teamComposition(deps, {
      team,
      conversationId: 'c1',
      slotId: 'slot-se',
      actorSlotId: () => 'slot-se',
      promptMember: () => undefined,
    })
    expect(composition.identitySection).toBe('agent-team:identity:slot-se')
    expect(composition.rosterSection).toBe('agent-team:roster:t1')
  })

  it('reads who is acting when a tool is called, not when it is installed', () => {
    const { deps, calls } = harness()
    let actor = 'slot-leader'
    const composition = teamComposition(deps, {
      team,
      conversationId: 'c1',
      slotId: 'slot-leader',
      actorSlotId: () => actor,
      promptMember: () => undefined,
    })
    void composition.tools.createTask({ title: 'x' })
    // A team can change leader while its Agent is running.
    actor = 'slot-next'
    void composition.tools.createTask({ title: 'y' })
    expect(calls.created.map(args => (args as unknown[])[2])).toEqual(['slot-leader', 'slot-next'])
  })

  it('reads the task board fresh, and only this conversation', () => {
    const { deps } = harness()
    const composition = teamComposition(deps, {
      team,
      conversationId: 'c1',
      slotId: 'slot-se',
      actorSlotId: () => 'slot-se',
      promptMember: () => undefined,
    })
    const board = composition.tools.getTaskBoard() as { revision: number; tasks: unknown[] }
    // A board nobody re-reads is a board that shows yesterday's work.
    expect(board.revision).toBe(7)
    expect(board.tasks).toHaveLength(1)
  })

  it('gives the board as data, not as the store\u2019s own objects', () => {
    const { deps } = harness()
    const composition = teamComposition(deps, {
      team, conversationId: 'c1', slotId: 'slot-se',
      actorSlotId: () => 'slot-se', promptMember: () => undefined,
    })
    const board = composition.tools.getTaskBoard() as { tasks: Array<Record<string, unknown>> }
    const shown = deps.service.getTeam('t1').tasks.a as { title?: string }
    board.tasks[0]!.title = '改了'
    // The tool result is handed to the model; the store's record must not follow it.
    expect(shown.title).toBe('A')
  })

  it('checks identity against whoever is acting', () => {
    const { deps } = harness()
    let actor = 'slot-leader'
    const composition = teamComposition(deps, {
      team, conversationId: 'c1', slotId: 'slot-leader',
      actorSlotId: () => actor, promptMember: () => undefined,
    })
    composition.tools.assertIdentity(undefined)
    actor = 'slot-se'
    composition.tools.assertIdentity(undefined)
    expect(deps.assertToolIdentity).toHaveBeenNthCalledWith(1, undefined, 't1', 'c1', 'slot-leader')
    expect(deps.assertToolIdentity).toHaveBeenNthCalledWith(2, undefined, 't1', 'c1', 'slot-se')
  })

  it('sends a message as whoever is acting', () => {
    const { deps, calls } = harness()
    const composition = teamComposition(deps, {
      team, conversationId: 'c1', slotId: 'slot-se',
      actorSlotId: () => 'slot-se', promptMember: () => undefined,
    })
    void composition.tools.sendMessage('slot-leader', '完成了', 'result', 'task-1')
    expect(calls.sent[0]).toEqual(['t1', 'c1', 'slot-se', 'slot-leader', '完成了', 'result', 'task-1'])
  })
})
