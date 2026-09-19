import { describe, expect, expectTypeOf, it } from 'vitest'
import { PAYLOAD_SCHEMAS, parsePayload } from '../src/transport/payload-schemas.js'
import {
  AGENT_TEAM_METHODS,
  type AgentTeamPayload,
  type AgentTeamResult,
  type WorkspaceEntryView,
  type WorkspaceGitDiffView,
} from '../src/transport/contracts.js'

describe('dsh-squad transport contracts', () => {
  it('keeps API method names unique', () => {
    expect(new Set(AGENT_TEAM_METHODS).size).toBe(AGENT_TEAM_METHODS.length)
  })

  it('describes every declared method with exactly one payload schema', () => {
    // The schema table is the only description of what a method accepts. A
    // method added to the list without an entry would fail at request time
    // instead of here.
    const described = Object.keys(PAYLOAD_SCHEMAS)
    expect([...described].sort()).toEqual([...AGENT_TEAM_METHODS].sort())
  })

  it('accepts a request that omits the payload for a method that takes none', () => {
    expect(parsePayload('catalog.get', undefined)).toBeUndefined()
    expect(parsePayload('team.list', undefined)).toBeUndefined()
  })

  it('refuses a payload that does not match the method', () => {
    expect(() => parsePayload('team.get', {})).toThrow()
    expect(() => parsePayload('team.get', { id: '' })).toThrow()
    // A method that takes no payload still refuses one it was not told about.
    expect(() => parsePayload('catalog.get', { extra: true })).toThrow()
  })

  it('associates Workspace methods with their payload and result types', () => {
    expectTypeOf<AgentTeamPayload<'team.workspace.diff'>>().toEqualTypeOf<{
      teamId: string
      conversationId?: string
      path: string
      scope: 'staged' | 'unstaged'
      layout: 'unified' | 'split'
      theme: 'light' | 'dark'
    }>()
    expectTypeOf<AgentTeamResult<'team.workspace.diff'>>().toEqualTypeOf<WorkspaceGitDiffView>()
    expectTypeOf<AgentTeamResult<'team.workspace.list'>>().toEqualTypeOf<WorkspaceEntryView[]>()
  })
})
