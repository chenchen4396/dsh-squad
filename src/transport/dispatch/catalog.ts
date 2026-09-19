import type { AgentTeamMethod } from '../contracts.js'
import { parsePayload } from '../payload-schemas.js'
import type { DispatchHandler } from './types.js'

/** The catalog, one provider’s model list, and the Skills and MCP Servers one preset offers. */
export const TABLE: Partial<Record<AgentTeamMethod, DispatchHandler>> = {
  'catalog.get': (ctx) => {
  return ctx.service.catalog()},
  'catalog.model.get': (ctx) => {
      const payload = parsePayload('catalog.model.get', ctx.rawPayload)
      return ctx.service.modelCapabilities(payload.provider, payload.model)
    },
  'skill.catalog': (ctx) => {
      const payload = parsePayload('skill.catalog', ctx.rawPayload)
      return ctx.service.skillCatalog(payload.agentPresetId)
    },
  'mcp.catalog': (ctx) => {
      const payload = parsePayload('mcp.catalog', ctx.rawPayload)
      return ctx.service.mcpCatalog(payload.agentPresetId)
    },
}
