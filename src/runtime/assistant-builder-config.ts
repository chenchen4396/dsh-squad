import type { Context } from '@deepseek-ai/cordis'
import { AgentTeamError } from '../domain/errors.js'
import type {
  AssistantBuilderModelPreferenceStore,
  AssistantBuilderModelReference,
} from '../storage/assistant-builder-preferences.js'
import type { Config } from '../config.js'

/** The configuration one builder conversation runs with. */
export interface BuilderConfiguration {
  provider: string
  model: string
  agentPresetId: string
  permissionPresetId: string
}

/**
 * Which model, preset and permission the Assistant Builder runs with.
 *
 * Three sources, in order: what the reader picked for this conversation, what
 * they picked last time, and what the deployment configures. Each is checked
 * before it is used — a provider that no longer exists, a model that was
 * removed from the catalog, a preset the Harness does not have — because the
 * builder's failure to start is otherwise reported as an adapter error that
 * names none of them.
 */

/** What resolving the builder's configuration needs. */
export interface BuilderConfigDeps {
  ctx: Context
  config: Config
  modelPreferences: AssistantBuilderModelPreferenceStore
  /** What this runtime has already resolved, per conversation. */
  configurations: ReadonlyMap<string, BuilderConfiguration>
}

export async function resolveConfiguration(deps: BuilderConfigDeps, sessionId: string): Promise<BuilderConfiguration> {
  const selected = deps.configurations.get(sessionId)
  const persisted = selected === undefined
    ? deps.modelPreferences.getConversationModel(sessionId)
      ?? deps.modelPreferences.getLastSelectedModel()
    : undefined
  const persistedModel = persisted === undefined
    ? undefined
    : await resolvePersistedModel(deps, persisted)
  const requestedProvider = selected?.provider
    ?? persistedModel?.provider
    ?? deps.config.assistantBuilderProvider.trim()
  const requestedModel = selected?.model
    ?? persistedModel?.model
    ?? deps.config.assistantBuilderModel.trim()
  if (requestedModel.length > 0 && requestedProvider.length === 0) {
    throw new AgentTeamError('INVALID_REQUEST', 'assistantBuilderModel requires assistantBuilderProvider')
  }
  const providers = deps.ctx.llm.listProviders()
  const candidates = requestedProvider.length > 0
    ? providers.filter(provider => provider.id === requestedProvider)
    : providers
  if (candidates.length === 0) {
    throw new AgentTeamError(
      'MODEL_REFERENCE_INVALID',
      requestedProvider.length > 0
        ? `Unknown Assistant Builder provider '${requestedProvider}'`
        : 'No model provider is available for the Assistant Builder',
    )
  }

  let provider = ''
  let model = ''
  for (const candidate of candidates) {
    const models = await deps.ctx.llm.listModels(candidate.id)
    const selected = requestedModel.length > 0
      ? models.find(item => item.id === requestedModel)
      : models[0]
    if (selected === undefined) continue
    provider = candidate.id
    model = selected.id
    break
  }
  if (provider.length === 0 || model.length === 0) {
    throw new AgentTeamError(
      'MODEL_REFERENCE_INVALID',
      requestedModel.length > 0
        ? `Unknown Assistant Builder model '${requestedProvider}/${requestedModel}'`
        : 'No catalog model is available for the Assistant Builder',
    )
  }
  await deps.ctx.llm.resolveModelInfo(provider, model)

  const agentPresetId = deps.config.assistantBuilderAgentPresetId.trim() || deps.ctx.agentPresets.defaultId
  await deps.ctx.agentPresets.resolve(agentPresetId)
  const permissionPresetId = deps.config.assistantBuilderPermissionPresetId.trim()
    || (deps.ctx.permissionPresets.names.includes('read-only')
      ? 'read-only'
      : deps.ctx.permissionPresets.defaultPreset)
  if (!deps.ctx.permissionPresets.names.includes(permissionPresetId)) {
    throw new AgentTeamError(
      'PERMISSION_PRESET_INVALID',
      `Unknown Assistant Builder permission preset '${permissionPresetId}'`,
    )
  }
  return { provider, model, agentPresetId, permissionPresetId }
}

async function resolvePersistedModel(deps: BuilderConfigDeps, 
  preference: AssistantBuilderModelReference,
): Promise<AssistantBuilderModelReference | undefined> {
  try {
    await deps.ctx.llm.resolveModelInfo(preference.provider, preference.model)
    return preference
  } catch (error) {
    deps.ctx.logger.warn(
      `agent-team: saved Assistant Builder model '${preference.provider}/${preference.model}' is unavailable; falling back`,
      error,
    )
    return undefined
  }
}
