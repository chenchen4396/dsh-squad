import { describe, expect, it } from 'vitest'
import { decideLeaderAnswer } from '../src/runtime/leader-answer.js'

/**
 * A member cannot reach the reader, so the Leader answers for the team — but
 * only within its own authority. This is the rule the whole approval path
 * rests on, and it had no test while it lived inside a tool callback.
 */
describe('decideLeaderAnswer', () => {
  const approval = (requestedMode?: string) => ({ kind: 'approval' as const, requestedMode })

  it('lets the Leader answer a request within its authority', () => {
    expect(decideLeaderAnswer({
      pending: approval('workspace-write'),
      decision: 'allow',
      leaderMode: 'danger-full-access',
      delegated: false,
    })).toEqual({ userOnly: false })
  })

  it('lets the Leader refuse anything, however wide', () => {
    // Refusing is always within its power; only allowing is bounded.
    expect(decideLeaderAnswer({
      pending: approval('danger-full-access'),
      decision: 'deny',
      leaderMode: 'workspace-write',
      delegated: false,
    })).toEqual({ userOnly: false })
  })

  it('sends a wider request to the reader when the reader is still in the loop', () => {
    const decision = decideLeaderAnswer({
      pending: approval('danger-full-access'),
      decision: 'allow',
      leaderMode: 'workspace-write',
      delegated: false,
    })
    expect(decision.userOnly).toBe(true)
    expect(decision.refusal).toContain('只能由用户批准')
    expect(decision.refusal).toContain('danger-full-access')
    expect(decision.refusal).toContain('workspace-write')
  })

  it('refuses outright when «替我审批» left nobody to ask', () => {
    const decision = decideLeaderAnswer({
      pending: approval('danger-full-access'),
      decision: 'allow',
      leaderMode: 'workspace-write',
      delegated: true,
    })
    // A card nobody can answer would hang the member, so it is refused here.
    expect(decision.userOnly).toBe(false)
    expect(decision.refusal).toContain('不能批准')
    expect(decision.refusal).toContain('用户不会介入')
  })

  it('never governs a question, only approvals it is trying to allow', () => {
    expect(decideLeaderAnswer({
      pending: { kind: 'question' },
      decision: 'allow',
      leaderMode: 'workspace-write',
      delegated: false,
    })).toEqual({ userOnly: false })
  })

  it('treats a request that names no level as within anyone\u2019s authority', () => {
    // A request with no level attached is not wider than the Leader.
    expect(decideLeaderAnswer({
      pending: approval(undefined),
      decision: 'allow',
      leaderMode: 'read-only',
      delegated: false,
    })).toEqual({ userOnly: false })
  })

  it('counts a Leader whose own level cannot be read as narrower than everything', () => {
    const decision = decideLeaderAnswer({
      pending: approval('read-only'),
      decision: 'allow',
      leaderMode: undefined,
      delegated: false,
    })
    // Not guessed at: the reader is asked.
    expect(decision.userOnly).toBe(true)
    expect(decision.refusal).toContain('未知')
  })
})
