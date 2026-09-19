import type {
  CatalogView,
  McpCatalogView,
  ModelCapabilitiesView,
  SkillCatalogView,
} from '../contracts.js'

/** The catalog, one provider’s model list, and one preset’s Skills and MCP Servers. */
export interface CatalogRequests {
  'catalog.get': { payload: undefined; result: CatalogView }
  'catalog.model.get': {
    payload: { provider: string; model: string }
    result: ModelCapabilitiesView
  }
  'skill.catalog': { payload: { agentPresetId: string }; result: SkillCatalogView }
  'mcp.catalog': { payload: { agentPresetId: string }; result: McpCatalogView }
}
