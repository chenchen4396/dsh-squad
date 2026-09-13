import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { identifyMemberAsSubagent } from '../src/runtime/member-descriptor.js'

interface FakeSession {
  events: Array<{ type: string; data: unknown }>
  snapshotEvents: () => Array<{ type: string; data: unknown }>
  append: (type: string, data: unknown) => unknown
}

function fakeAgent(): { agent: Agent; session: FakeSession } {
  const session: FakeSession = {
    events: [],
    snapshotEvents: () => session.events,
    append: (type, data) => {
      session.events.push({ type, data })
      return { type, data }
    },
  }
  return { agent: { id: 'agent-team:1', session } as unknown as Agent, session }
}

describe('identifyMemberAsSubagent', () => {
  it('writes the subagent identity the Harness subagent projection folds', () => {
    const { agent, session } = fakeAgent()

    identifyMemberAsSubagent(agent, 'SE')

    expect(session.events).toEqual([{
      type: 'subagent/descriptor',
      data: { version: 3, mode: 'one-shot', provider: 'agent-team', label: 'SE' },
    }])
  })

  it('leaves a member whose log already carries the identity alone', () => {
    const { agent, session } = fakeAgent()
    session.events.push({
      type: 'subagent/descriptor',
      data: { version: 3, mode: 'one-shot', provider: 'agent-team', label: 'SE' },
    })

    identifyMemberAsSubagent(agent, 'SE')

    expect(session.events).toHaveLength(1)
  })
})
