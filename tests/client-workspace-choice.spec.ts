import { describe, expect, it } from 'vitest'
import { defaultWorkspaceId } from '../src/client/workspace-choice.js'
import type { WorkspaceChoiceSource } from '../src/client/workspace-choice.js'

function workspace(
  workspaceId: string,
  updatedAt: string,
  sessionIds: readonly string[] = [],
): WorkspaceChoiceSource {
  return { workspaceId, path: `/${workspaceId}`, title: workspaceId, sessionIds, updatedAt }
}

describe('defaultWorkspaceId', () => {
  it('keeps a team where it worked last', () => {
    const workspaces = [workspace('code', '2026-01-02T00:00:00.000Z')]

    expect(defaultWorkspaceId(
      [{ workspaceId: 'work' }, { workspaceId: 'code' }],
      workspaces,
      undefined,
    )).toBe('code')
  })

  it('falls back to the Workspace the open Harness session is in', () => {
    const workspaces = [
      workspace('code', '2026-01-01T00:00:00.000Z'),
      workspace('work', '2026-01-02T00:00:00.000Z', ['session-1']),
    ]

    expect(defaultWorkspaceId([{}], workspaces, 'session-1')).toBe('work')
  })

  it('falls back to the most recently touched Workspace', () => {
    const workspaces = [
      workspace('code', '2026-01-01T00:00:00.000Z'),
      workspace('work', '2026-01-02T00:00:00.000Z'),
    ]

    expect(defaultWorkspaceId([], workspaces, 'unknown-session')).toBe('work')
  })

  it('has nothing to offer without a Workspace', () => {
    expect(defaultWorkspaceId([], [], undefined)).toBeUndefined()
  })
})
