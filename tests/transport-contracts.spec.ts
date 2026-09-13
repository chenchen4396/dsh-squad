import { describe, expect, expectTypeOf, it } from 'vitest'
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
