import { randomUUID } from 'node:crypto'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import type { Context } from '@deepseek-ai/cordis'
import { AgentTeamError } from '../domain/errors.js'
import { isMcpServerName } from '../domain/mcp.js'
import { createAssistantInputSchema, updateAssistantInputSchema } from '../domain/schemas.js'
import type {
  AssistantTemplate,
  CreateAssistantInput,
  Page,
  TeamAggregate,
  TeamMemberSlot,
  UpdateAssistantInput,
} from '../domain/types.js'
import type { AgentTeamStore } from '../storage/store.js'
import { assertRevision, requireAssistant, type MutationOptions } from './store-guards.js'

/**
 * Assistant templates, and what follows from changing one.
 *
 * Fifteen methods scattered through a 1480-line service: the plain reads, the
 * writes, and the validation each write runs first. The validation is why they
 * belong together — a template is checked against the live catalog, and a
 * change to one has to reach every running member that follows it.
 */

/** What an assistant operation needs from the service that owns it. */
export interface AssistantDeps {
  store: AgentTeamStore
  /** The Harness context: the catalogs and presets a template is checked on. */
  ctx: Context
  /** The runtime, when it is attached; running members are told about changes. */
  runtime: AssistantRuntimeLike | undefined
  activity: (kind: string, entityId: string, revision: number, summary: string) => Promise<void>
  publish: (
    entityType:
      | 'assistant' | 'assistant-builder' | 'team' | 'operation'
      | 'conversation' | 'workspace' | 'catalog' | 'rule-document',
    entityId: string,
    revision: number,
    kind: string,
  ) => void
  /** One provider's models, as the catalog cache knows them. */
  modelCapabilities: (
    provider: string,
    model: string,
  ) => Promise<{ reasoning?: { efforts: Array<{ id: string }> } }>
  /** One preset's MCP servers, as the catalog cache knows them. */
  mcpCatalog: (
    agentPresetId: string,
  ) => Promise<{ servers: Array<{ name: string; tools: Array<{ name: string }> }> }>
}

/** The part of the runtime these operations use. */
interface AssistantRuntimeLike {
  refreshAssistantSettings: (assistant: AssistantTemplate) => void
}

export function getAssistant(deps: AssistantDeps, id: string): AssistantTemplate {
  return requireAssistant(deps.store, id)
}

export function assistantForMember(deps: AssistantDeps, member: TeamMemberSlot): AssistantTemplate {
  const assistant = deps.store.getAssistant(member.assistantId)
  if (assistant === undefined) {
    throw new AgentTeamError(
      'ASSISTANT_NOT_FOUND',
      `成员「${member.displayName}」引用的助手已不存在，请替换该成员或重建团队`,
      { memberId: member.id, assistantId: member.assistantId },
    )
  }
  return assistant
}

export function listAssistants(deps: AssistantDeps): Page<AssistantTemplate> {
  const items = deps.store.listAssistants()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  return { items, total: items.length }
}

export async function createAssistant(deps: AssistantDeps, raw: CreateAssistantInput): Promise<AssistantTemplate> {
  const input = await validateAssistantDraft(deps, raw)
  const now = new Date().toISOString()
  const assistant: AssistantTemplate = {
    schemaVersion: 1,
    id: randomUUID(),
    ...input,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }
  await deps.store.putAssistant(assistant)
  await deps.activity('assistant.created', assistant.id, assistant.revision, `Assistant ${assistant.name} created`)
  deps.publish('assistant', assistant.id, assistant.revision, 'assistant.created')
  return assistant
}

export async function validateAssistantDraft(
  deps: AssistantDeps,
  raw: CreateAssistantInput,
): Promise<CreateAssistantInput & { ruleDocumentAllowlist: string[] }> {
  const input = normalizeAssistantInput(createAssistantInputSchema.parse(raw))
  await validateAssistantReferences(deps, input)
  return input
}

export async function updateAssistant(
  deps: AssistantDeps,
  id: string,
  raw: UpdateAssistantInput,
  options: MutationOptions = {},
): Promise<AssistantTemplate> {
  const patch = updateAssistantInputSchema.parse(raw)
  const current = requireAssistant(deps.store, id)
  assertRevision('assistant', current.revision, options.expectedRevision)
  const candidate = normalizeAssistantInput(createAssistantInputSchema.parse({
    ...assistantInputOf(current),
    ...patch,
  }))
  await validateAssistantReferences(deps, candidate)
  const next = await deps.store.updateAssistant(id, value => ({
    ...value,
    ...candidate,
    revision: value.revision + 1,
    updatedAt: new Date().toISOString(),
  }))
  await deps.activity('assistant.updated', next.id, next.revision, `Assistant ${next.name} updated`)
  // Members inherit the template live, but one that is already running holds
  // the selection and sandbox it was created with, so the edit is pushed onto
  // the members that still follow this assistant. Without this the teams drift
  // from their assistant and nothing on screen says so.
  await followAssistant(deps, next)
  deps.publish('assistant', next.id, next.revision, 'assistant.updated')
  return next
}

export function assistantSettingsFor(deps: AssistantDeps, member: TeamMemberSlot): {
  permissionPresetId: string
  reasoningEffort?: string
} | undefined {
  const assistant = deps.store.getAssistant(member.assistantId)
  if (assistant === undefined) return undefined
  return {
    permissionPresetId: assistant.permissionPresetId,
    ...(assistant.reasoningEffort === undefined ? {} : { reasoningEffort: assistant.reasoningEffort }),
  }
}

/** Rewrite every member of one team onto its assistant's current settings. */
export function membersOntoAssistants(deps: AssistantDeps, team: TeamAggregate): TeamAggregate {
  return {
    ...team,
    members: mapTeamMembers(team, member => {
      const settings = assistantSettingsFor(deps, member)
      if (settings === undefined) return member
      if (!deps.ctx.permissionPresets.names.includes(settings.permissionPresetId)) return member
      return {
        ...member,
        permissionPresetId: settings.permissionPresetId,
        reasoningEffort: settings.reasoningEffort,
      }
    }),
  }
}

export async function followAssistant(deps: AssistantDeps, assistant: AssistantTemplate): Promise<void> {
  // A template may name a preset this deployment does not offer (an assistant
  // imported from elsewhere). Writing it would make every member unstartable,
  // so such a template is left alone rather than followed into a dead end.
  if (!deps.ctx.permissionPresets.names.includes(assistant.permissionPresetId)) return
  const teams = deps.store.listTeams()
    .filter(team => Object.values(team.members).some(member => member.assistantId === assistant.id))
  if (teams.length === 0) return
  // Members that are already running hold the sandbox they were created with,
  // so the runtime re-sandboxes the ones this assistant owns. A team with no
  // running member still needs its record updated — that record is what the
  // next activation reads.
  deps.runtime?.refreshAssistantSettings(assistant)
  for (const team of teams) {
    await updateRuntimeTeam(deps, 
      team.id,
      current => membersOntoAssistants(deps, current),
      'team.members_followed_assistant',
      `Members of ${team.name} follow assistant ${assistant.name}`,
    )
  }
}

export async function followAssistants(deps: AssistantDeps): Promise<void> {
  const teams = deps.store.listTeams()
    .filter(team => Object.values(team.members).some(member => (
      assistantSettingsFor(deps, member) !== undefined
    )))
  for (const team of teams) {
    const next = membersOntoAssistants(deps, team)
    if (JSON.stringify(next.members) === JSON.stringify(team.members)) continue
    await updateRuntimeTeam(deps, 
      team.id,
      current => membersOntoAssistants(deps, current),
      'team.members_followed_assistant',
      `Members of ${team.name} followed their assistants on startup`,
    )
  }
}

export async function cloneAssistant(deps: AssistantDeps, id: string, name?: string): Promise<AssistantTemplate> {
  const source = requireAssistant(deps.store, id)
  return createAssistant(deps, {
    ...assistantInputOf(source),
    name: name?.trim() || `${source.name} Copy`,
  })
}

export async function deleteAssistant(deps: AssistantDeps, id: string): Promise<void> {
  const assistant = requireAssistant(deps.store, id)
  const references = deps.store.listTeams()
    .filter(team => Object.values(team.members).some(member => member.assistantId === id))
    .map(team => ({ id: team.id, name: team.name }))
  if (references.length > 0) {
    throw new AgentTeamError(
      'ASSISTANT_IN_USE',
      `Assistant '${assistant.name}' is used by active team members`,
      { teams: references },
    )
  }
  await deps.store.deleteAssistant(id)
  await deps.activity('assistant.deleted', id, assistant.revision + 1, `Assistant ${assistant.name} deleted`)
  deps.publish('assistant', id, assistant.revision + 1, 'assistant.deleted')
}

export async function updateRuntimeTeam(
  deps: AssistantDeps,
  teamId: string,
  update: (team: TeamAggregate) => TeamAggregate,
  kind: string,
  summary: string,
): Promise<TeamAggregate> {
  const next = await deps.store.updateTeam(teamId, current => {
    const candidate = update(current)
    return {
      ...candidate,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    }
  })
  await deps.activity(kind, teamId, next.revision, summary)
  deps.publish('team', teamId, next.revision, kind)
  return next
}

export async function validateAssistantReferences(deps: AssistantDeps, input: CreateAssistantInput): Promise<void> {
  const invalidSkill = input.skillAllowlist.find(name => !isSkillName(name))
  if (invalidSkill !== undefined) {
    throw new AgentTeamError('SKILL_REFERENCE_INVALID', `Invalid Skill name '${invalidSkill}'`)
  }
  const invalidMcpServer = input.mcpServers.find(name => !isMcpServerName(name))
  if (invalidMcpServer !== undefined) {
    throw new AgentTeamError('MCP_REFERENCE_INVALID', `Invalid MCP Server name '${invalidMcpServer}'`)
  }
  await validateReasoningEffort(deps, input.provider, input.model, input.reasoningEffort)
  try {
    await deps.ctx.agentPresets.resolve(input.agentPresetId)
  } catch (error) {
    throw new AgentTeamError(
      'PRESET_REFERENCE_INVALID',
      `Unknown agent preset '${input.agentPresetId}'`,
      undefined,
      { cause: error },
    )
  }
  if (!deps.ctx.permissionPresets.names.includes(input.permissionPresetId)) {
    throw new AgentTeamError(
      'PERMISSION_PRESET_INVALID',
      `Unknown permission preset '${input.permissionPresetId}'`,
    )
  }
  if (input.mcpServers.length > 0) {
    const catalog = await deps.mcpCatalog(input.agentPresetId)
    const available = new Set(catalog.servers.map(server => server.name))
    const missing = input.mcpServers.filter(name => !available.has(name))
    if (missing.length > 0) {
      throw new AgentTeamError(
        'MCP_REFERENCE_INVALID',
        `Agent Preset '${input.agentPresetId}' cannot access MCP Server(s): ${missing.join(', ')}`,
        { missing },
      )
    }
  }
}

export async function validateReasoningEffort(
  deps: AssistantDeps,
  provider: string,
  model: string,
  reasoningEffort: string | undefined,
): Promise<void> {
  const capabilities = await deps.modelCapabilities(provider, model)
  if (reasoningEffort === undefined) return
  const supported = capabilities.reasoning?.efforts.some(effort => effort.id === reasoningEffort) ?? false
  if (!supported) {
    throw new AgentTeamError(
      'MODEL_REFERENCE_INVALID',
      `Model '${provider}/${model}' does not support reasoning effort '${reasoningEffort}'`,
      {
        reasoningEffort,
        supportedEfforts: capabilities.reasoning?.efforts.map(effort => effort.id) ?? [],
      },
    )
  }
}

/** Replace every member of one team through a pure mapper. */
function mapTeamMembers(
  team: TeamAggregate,
  change: (member: TeamMemberSlot) => TeamMemberSlot,
): Record<string, TeamMemberSlot> {
  return Object.fromEntries(Object.entries(team.members).map(([id, member]) => [id, change(member)]))
}

function assistantInputOf(assistant: AssistantTemplate): CreateAssistantInput {
  return {
    name: assistant.name,
    ...(assistant.description === undefined ? {} : { description: assistant.description }),
    ...(assistant.icon === undefined ? {} : { icon: assistant.icon }),
    instructions: assistant.instructions,
    provider: assistant.provider,
    model: assistant.model,
    ...(assistant.reasoningEffort === undefined ? {} : { reasoningEffort: assistant.reasoningEffort }),
    agentPresetId: assistant.agentPresetId,
    permissionPresetId: assistant.permissionPresetId,
    skillAllowlist: [...assistant.skillAllowlist],
    mcpServers: [...assistant.mcpServers],
    ruleDocumentAllowlist: [...assistant.ruleDocumentAllowlist],
  }
}

/**
 * The input schema keeps `ruleDocumentAllowlist` optional so older callers stay
 * valid, but every stored template carries it — hence the narrowed return type.
 */
function normalizeAssistantInput(
  input: CreateAssistantInput,
): CreateAssistantInput & { ruleDocumentAllowlist: string[] } {
  return {
    ...input,
    name: input.name.trim(),
    provider: input.provider.trim(),
    model: input.model.trim(),
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort.trim() }),
    agentPresetId: input.agentPresetId.trim(),
    permissionPresetId: input.permissionPresetId.trim(),
    skillAllowlist: unique(input.skillAllowlist),
    mcpServers: unique(input.mcpServers),
    ruleDocumentAllowlist: unique(input.ruleDocumentAllowlist ?? []),
  }
}

/**
 * Normalize an imported path into `a/b/c.md`, rejecting anything that could
 * escape the document set (`..`) or that is not a usable path.
 */
function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}
