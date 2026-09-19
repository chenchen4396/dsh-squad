import type { Context } from '@deepseek-ai/cordis'
import { AgentTeamError } from '../domain/errors.js'
import { isModelInvocable, isUserInvocable } from '@deepseek-ai/dsh-skill'
import { mcpServerFromToolName } from '../domain/mcp.js'

export interface SkillCatalogSnapshot {
  agentPresetId: string
  skills: Array<{
    name: string
    description: string
    source: string
    modelInvocable: boolean
    userInvocable: boolean
  }>
}

export interface ModelCapabilitiesSnapshot {
  provider: string
  model: string
  reasoning?: {
    efforts: Array<{ id: string; name: string; description?: string }>
    defaultEffort?: string
  }
}

export interface McpCatalogSnapshot {
  agentPresetId: string
  servers: Array<{
    name: string
    tools: Array<{ name: string; description: string }>
  }>
}

/**
 * What one provider, preset or Harness offers.
 *
 * Three reads of the Harness's own catalogs, each of which has to turn a lookup
 * failure into something a reader can act on: a model that cannot be resolved
 * is named as a model, not reported as an adapter error from three layers down.
 * They are separate from the cached catalog of providers because they are not
 * cached — each describes a live Harness, and a stale answer here is worse than
 * a slower one.
 */

/** What reading the catalogs needs. */
export interface CatalogDeps {
  ctx: Context
}

export async function modelCapabilities(deps: CatalogDeps, providerValue: string, modelValue: string): Promise<ModelCapabilitiesSnapshot> {
  const provider = providerValue.trim()
  const model = modelValue.trim()
  let info: Awaited<ReturnType<Context['llm']['resolveModelInfo']>>
  try {
    info = await deps.ctx.llm.resolveModelInfo(provider, model)
  } catch (error) {
    throw new AgentTeamError(
      'MODEL_REFERENCE_INVALID',
      `Cannot resolve model '${provider}/${model}'`,
      undefined,
      { cause: error },
    )
  }
  return {
    provider,
    model,
    ...(info.reasoning === undefined
      ? {}
      : {
          reasoning: {
            efforts: info.reasoning.efforts.map(effort => ({
              id: String(effort.id),
              name: effort.name,
              ...(effort.description === undefined ? {} : { description: effort.description }),
            })),
            ...(info.reasoning.defaultEffort === undefined
              ? {}
              : { defaultEffort: String(info.reasoning.defaultEffort) }),
          },
        }),
  }
}

export async function skillCatalog(deps: CatalogDeps, agentPresetId: string): Promise<SkillCatalogSnapshot> {
  try {
    await deps.ctx.agentPresets.resolve(agentPresetId)
    const scope = await deps.ctx.agentPresets.standingKeyFor(agentPresetId)
    if (deps.ctx.tools.get('skill', scope) === undefined) {
      return { agentPresetId, skills: [] }
    }
    const skills = await deps.ctx.skills.list({ scope })
    return {
      agentPresetId,
      skills: skills.filter(skill => isModelInvocable(skill) || isUserInvocable(skill)).map(skill => ({
        name: skill.name,
        description: skill.description,
        source: skill.source,
        modelInvocable: isModelInvocable(skill),
        userInvocable: isUserInvocable(skill),
      })),
    }
  } catch (error) {
    if (error instanceof AgentTeamError) throw error
    throw new AgentTeamError(
      'PRESET_REFERENCE_INVALID',
      `Cannot read Skills for agent preset '${agentPresetId}'`,
      undefined,
      { cause: error },
    )
  }
}

export async function mcpCatalog(deps: CatalogDeps, agentPresetId: string): Promise<McpCatalogSnapshot> {    try {
    await deps.ctx.agentPresets.resolve(agentPresetId)
    const scope = await deps.ctx.agentPresets.standingKeyFor(agentPresetId)
    const servers = new Map<string, Array<{ name: string; description: string }>>()
    for (const tool of deps.ctx.tools.schemas(scope)) {
      const serverName = mcpServerFromToolName(tool.name)
      if (serverName === undefined) continue
      const entries = servers.get(serverName) ?? []
      entries.push({ name: tool.name, description: tool.description })
      servers.set(serverName, entries)
    }
    return {
      agentPresetId,
      servers: [...servers.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, tools]) => ({
        name,
        tools: tools.sort((left, right) => left.name.localeCompare(right.name)),
      })),
    }
  } catch (error) {
    if (error instanceof AgentTeamError) throw error
    throw new AgentTeamError(
      'PRESET_REFERENCE_INVALID',
      `Cannot read MCP Servers for agent preset '${agentPresetId}'`,
      undefined,
      { cause: error },
    )
  }
}
