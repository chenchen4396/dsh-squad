import type {
  WorkspaceEntryView,
  WorkspaceGitDiffView,
  WorkspaceGitStatusView,
} from '../contracts.js'

/** Reading and changing the workspace a conversation runs in. */
export interface WorkspaceRequests {
  'team.workspace.list': {
    payload: { teamId: string; conversationId?: string; path?: string }
    result: WorkspaceEntryView[]
  }
  'team.workspace.search': {
    payload: { teamId: string; conversationId?: string; query?: string; limit?: number }
    result: WorkspaceEntryView[]
  }
  'team.workspace.changes': {
    payload: { teamId: string; conversationId?: string }
    result: WorkspaceGitStatusView
  }
  'team.workspace.diff': {
    payload: {
      teamId: string
      conversationId?: string
      path: string
      scope: 'staged' | 'unstaged'
      layout: 'unified' | 'split'
      theme: 'light' | 'dark'
    }
    result: WorkspaceGitDiffView
  }
}
