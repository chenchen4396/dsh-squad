import type {
  WorkspaceEntryView,
  WorkspaceGitDiffView,
  WorkspaceGitStatusView,
} from '../contracts.js'

/** Reading and changing the workspace a conversation runs in. */
export interface WorkspaceRequests {
  'team.workspace.list': {
    payload: { teamId: string; conversationId?: string | undefined; path?: string | undefined }
    result: WorkspaceEntryView[]
  }
  'team.workspace.search': {
    payload: { teamId: string; conversationId?: string | undefined; query?: string | undefined; limit?: number | undefined }
    result: WorkspaceEntryView[]
  }
  'team.workspace.changes': {
    payload: { teamId: string; conversationId?: string | undefined }
    result: WorkspaceGitStatusView
  }
  'team.workspace.diff': {
    payload: {
      teamId: string
      conversationId?: string | undefined
      path: string
      scope: 'staged' | 'unstaged'
      layout: 'unified' | 'split'
      theme: 'light' | 'dark'
    }
    result: WorkspaceGitDiffView
  }
}
