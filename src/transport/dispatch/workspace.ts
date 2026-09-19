import type { AgentTeamMethod } from '../contracts.js'
import { parsePayload } from '../payload-schemas.js'
import type { DispatchHandler } from './types.js'

/** Reading and changing the workspace a conversation runs in. */
export const TABLE: Partial<Record<AgentTeamMethod, DispatchHandler>> = {
  'team.workspace.list': (ctx) => {
      const payload = parsePayload('team.workspace.list', ctx.rawPayload)
      return ctx.service.listWorkspace(payload.teamId, payload.conversationId, payload.path)
    },
  'team.workspace.search': (ctx) => {
      const payload = parsePayload('team.workspace.search', ctx.rawPayload)
      return ctx.service.searchWorkspace(payload.teamId, payload.conversationId, payload.query, payload.limit)
    },
  'team.workspace.changes': (ctx) => {
      const payload = parsePayload('team.workspace.changes', ctx.rawPayload)
      return ctx.service.getWorkspaceChanges(payload.teamId, payload.conversationId)
    },
  'team.workspace.diff': (ctx) => {
      const payload = parsePayload('team.workspace.diff', ctx.rawPayload)
      return ctx.service.getWorkspaceDiff(
        payload.teamId,
        payload.conversationId,
        payload.path,
        payload.scope,
        payload.layout,
        payload.theme,
      )
    },
}
