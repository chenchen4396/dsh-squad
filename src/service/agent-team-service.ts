import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { isModelInvocable, isSkillName, isUserInvocable } from '@deepseek-ai/dsh-skill'
import { fallbackSessionTitle } from '@deepseek-ai/dsh-session-title'
import type { Config } from '../config.js'
import { AgentTeamError } from '../domain/errors.js'
import { isMcpServerName, mcpServerFromToolName } from '../domain/mcp.js'
import { isMarkdownRulePath, markdownRuleExtensions } from '../domain/rule-format.js'
import { taskAssigneeIds, isRoomRelayEcho } from '../domain/team-selectors.js'
import {
  createAssistantInputSchema,
  addTeamMemberInputSchema,
  cloneTeamInputSchema,
  createTeamDraftInputSchema,
  updateAssistantInputSchema,
} from '../domain/schemas.js'
import {
  type AddTeamMemberInput,
  type AssistantTemplate,
  type CloneTeamInput,
  type CreateAssistantInput,
  type CreateTeamDraftInput,
  type Operation,
  type Page,
  type RuleDocument,
  type TeamActivity,
  type TeamAggregate,
  type TeamConversation,
  type TeamMemberSlot,
  type TeamMessage,
  type UpdateAssistantInput,
} from '../domain/types.js'
import type { AgentTeamStore } from '../storage/store.js'
import type { AssistantBuilderRuntime } from '../runtime/assistant-builder-runtime.js'
import type { TeamRuntime } from '../runtime/team-runtime.js'
import { WorkspaceService } from './workspace-service.js'
import type {
  AssistantBuilderConversationView,
  AssistantBuilderConversationListView,
  AssistantBuilderDraftView,
  InteractionResponseInput,
  MemberConversationView,
  RoomView,
  TeamWorkbenchView,
  WorkspaceEntryView,
  WorkspaceGitStatusView,
  WorkspaceGitDiffView,
  WorkspaceUploadView,
} from '../transport/contracts.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTeam: AgentTeamService
  }
}

export interface MutationOptions {
  expectedRevision?: number
}

/**
 * Native session-title fallback limits, taken from the shipped
 * `session-title` defaults so a team conversation gets exactly the title a DSH
 * Session would get from the same first message.
 */
const AUTO_TITLE_WORDS = 5
const AUTO_TITLE_BYTES = 40

/**
 * How long one complete catalog read is reused before it refreshes.
 *
 * Reading a provider's models is a network round trip, and a real setup has
 * several providers, so a complete read takes tens of seconds. Nothing in the
 * UI changes that fast — a provider list, a preset list, the Workspace list —
 * and a view opening must not wait on it.
 */
const CATALOG_TTL_MS = 5 * 60_000

/** What the sidebar shows about a conversation beyond its stored record. */
interface ConversationDisplay {
  /** Earliest user message text; absent when nobody has spoken yet. */
  firstUserText?: string
  /** Latest activity in epoch ms. */
  lastActivity: number
}

export interface AgentTeamChange {
  cursor: number
  entityType: 'assistant' | 'assistant-builder' | 'team' | 'operation' | 'conversation' | 'workspace' | 'catalog' | 'rule-document'
  entityId: string
  revision: number
  kind: string
  conversation?: MemberConversationView
  assistantBuilderConversation?: AssistantBuilderConversationView
}

export interface CatalogSnapshot {
  providers: ReturnType<Context['llm']['listProviders']>
  models: Record<string, Array<{ id: string; name: string; description?: string }>>
  agentPresets: Array<{ id: string; name: string; description?: string; broken?: string }>
  permissionPresets: Array<ReturnType<Context['permissionPresets']['optionOf']>>
  workspaces: Array<{
    id: string
    path: string
    title: string
    status: 'ok' | 'missing-dir'
  }>
}

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

const PERMISSION_PRESET_LABELS: Readonly<Record<string, string>> = {
  'read-only': '只读',
  'workspace-write': '工作区可写',
  'danger-full-access': '完全访问',
  standard: '标准',
}

export class AgentTeamService extends Service {
  private readonly listeners = new Set<(change: AgentTeamChange) => void>()
  private cursor = 0
  /** Last complete catalog read, and when it was taken. */
  private catalogValue?: CatalogSnapshot
  private catalogReadAt = 0
  /** The one complete read in flight, shared by every caller. */
  private catalogRead: Promise<void> | undefined
  /** Last agent-preset list read; the service behind it takes tens of seconds. */
  private catalogAgentPresets: CatalogSnapshot['agentPresets'] | undefined
  private runtime?: TeamRuntime
  private assistantBuilderRuntime?: AssistantBuilderRuntime
  private readonly workspace: WorkspaceService

  constructor(
    ctx: Context,
    readonly config: Config,
    private readonly store: AgentTeamStore,
  ) {
    super(ctx, 'agentTeam')
    this.workspace = new WorkspaceService(
      ctx,
      store,
      teamId => {
        const team = this.store.getTeam(teamId)
        if (team !== undefined) this.publish('workspace', teamId, team.revision, 'workspace.changed')
      },
      (teamId, error) => {
        this.ctx.logger.warn(`agent-team: Workspace watcher failed for team '${teamId}'`, error)
      },
    )
    ctx.on('llm/adapters-updated', () => {
      this.publish('catalog', 'models', 0, 'catalog.models_updated')
    })
  }

  subscribe(listener: (change: AgentTeamChange) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  attachRuntime(runtime: TeamRuntime): void {
    if (this.runtime !== undefined) throw new Error('dsh-squad runtime is already attached')
    this.runtime = runtime
  }

  attachAssistantBuilderRuntime(runtime: AssistantBuilderRuntime): void {
    if (this.assistantBuilderRuntime !== undefined) throw new Error('Assistant Builder runtime is already attached')
    this.assistantBuilderRuntime = runtime
  }

  startWorkspaceTracking(): void {
    this.workspace.startTracking()
  }

  disposeWorkspaceTracking(): Promise<void> {
    return this.workspace.dispose()
  }

  /**
   * The model, preset, and Workspace directory the UI reads.
   *
   * A complete read lists every provider's models over the network and walks
   * the preset directory — the preset service alone takes twenty seconds on
   * this machine — so a view opening must never wait for it. The last complete
   * read answers at once (a stale one refreshes behind the reader); the
   * first-ever read answers with everything that is already local, and the
   * refresh publishes a catalog change, so open views take the whole directory
   * a moment later.
   */
  async catalog(): Promise<CatalogSnapshot> {
    const cached = this.catalogValue
    if (cached !== undefined) {
      if (Date.now() - this.catalogReadAt > CATALOG_TTL_MS) void this.refreshCatalog()
      return cached
    }
    void this.refreshCatalog()
    return this.readCatalogBasics()
  }

  /**
   * The catalog without its two slow reads: no provider round trip, and no
   * preset walk. Both are filled in by {@link readCatalog}; this is what a view
   * opening can have right now.
   */
  private async readCatalogBasics(): Promise<CatalogSnapshot> {
    const providers = this.ctx.llm.listProviders()
    const workspaces = await Promise.all(this.ctx.workspaceRegistry.list().map(async workspace => ({
      id: String(workspace.id),
      path: workspace.path,
      title: workspace.title,
      status: await workspace.status(),
    })))
    return {
      providers,
      models: this.catalogValue?.models ?? {},
      agentPresets: this.catalogAgentPresets ?? [],
      permissionPresets: this.ctx.permissionPresets.names.map(name => {
        const option = this.ctx.permissionPresets.optionOf(name)
        return {
          ...option,
          name: PERMISSION_PRESET_LABELS[option.value] ?? option.name,
        }
      }),
      workspaces,
    }
  }

  /** The complete catalog: every provider's model list and the preset directory. */
  private async readCatalog(): Promise<CatalogSnapshot> {
    const basics = await this.readCatalogBasics()
    const presets = await this.ctx.agentPresets.list()
    this.catalogAgentPresets = presets.map(preset => ({
      id: preset.id,
      name: preset.name ?? preset.id,
      ...(preset.description === undefined ? {} : { description: preset.description }),
      ...(preset.broken === undefined ? {} : { broken: preset.broken }),
    }))
    const modelEntries = await Promise.all(basics.providers.map(async provider => [
      provider.id,
      (await this.ctx.llm.listModels(provider.id)).map(model => ({
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
      })),
    ] as const))
    return {
      ...basics,
      models: Object.fromEntries(modelEntries),
      agentPresets: this.catalogAgentPresets,
    }
  }

  /** Rebuild the complete catalog once, however many callers ask for it. */
  private refreshCatalog(): Promise<void> {
    if (this.catalogRead !== undefined) return this.catalogRead
    const read: Promise<void> = this.readCatalog()
      .then(value => {
        this.catalogValue = value
        this.catalogReadAt = Date.now()
        // Views holding the partial directory take the complete one now.
        this.publish('catalog', 'models', 0, 'catalog.models_updated')
      })
      .catch(error => {
        // A stale directory beats none: keep serving it and say so quietly.
        if (this.catalogValue === undefined) throw error
        this.ctx.logger.warn('agent-team: catalog refresh failed', error)
      })
      .finally(() => {
        if (this.catalogRead === read) this.catalogRead = undefined
      })
    this.catalogRead = read
    return read
  }

  async modelCapabilities(providerValue: string, modelValue: string): Promise<ModelCapabilitiesSnapshot> {
    const provider = providerValue.trim()
    const model = modelValue.trim()
    let info: Awaited<ReturnType<Context['llm']['resolveModelInfo']>>
    try {
      info = await this.ctx.llm.resolveModelInfo(provider, model)
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

  async skillCatalog(agentPresetId: string): Promise<SkillCatalogSnapshot> {
    try {
      await this.ctx.agentPresets.resolve(agentPresetId)
      const scope = await this.ctx.agentPresets.standingKeyFor(agentPresetId)
      if (this.ctx.tools.get('skill', scope) === undefined) {
        return { agentPresetId, skills: [] }
      }
      const skills = await this.ctx.skills.list({ scope })
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

  /**
   * Every imported rule document, newest last.
   *
   * Documents are whole files (a `CLAUDE.md`, a house style guide) stored
   * verbatim, not individual rules. Which ones an Agent loads is part of that
   * Agent's configuration, so there is no per-team catalog any more.
   */
  listRuleDocuments(): Page<RuleDocument> {
    const items = this.store.listRuleDocuments()
    return { items, total: items.length }
  }

  getRuleDocument(id: string): RuleDocument {
    const document = this.store.getRuleDocument(id)
    if (document === undefined) {
      throw new AgentTeamError('RULE_REFERENCE_INVALID', `Unknown rule document '${id}'`)
    }
    return document
  }

  /** Largest single document this deployment accepts, given the request cap. */
  ruleDocumentLimit(): number {
    // The body carries the whole document plus a small JSON envelope, so the
    // document itself has to stay clear of `maxRequestBytes`; otherwise the
    // transport rejects it before the readable error below can be produced.
    return Math.max(4 * 1024, this.config.maxRequestBytes - 4 * 1024)
  }

  /**
   * Import one document file, stored whole and never split into rules.
   *
   * Only Markdown is accepted, so a folder import can never pull an unrelated
   * file into a member's prompt. Re-importing the same `path` updates the
   * document in place and keeps its id, so refreshing an imported folder never
   * invalidates the assistants that already selected those documents.
   */
  async importRuleDocument(rawPath: string, content: string): Promise<RuleDocument> {
    const path = normalizeRulePath(rawPath)
    if (path === undefined) {
      throw new AgentTeamError(
        'RULE_REFERENCE_INVALID',
        `规则路径不合法：${rawPath}`,
        { path: rawPath },
      )
    }
    if (!isMarkdownRulePath(path)) {
      throw new AgentTeamError(
        'RULE_REFERENCE_INVALID',
        `规则文档只支持 Markdown（${markdownRuleExtensions.join(' / ')}）：${path}`,
        { path },
      )
    }
    const bytes = Buffer.byteLength(content, 'utf8')
    const limit = this.ruleDocumentLimit()
    if (bytes > limit) {
      throw new AgentTeamError(
        'RULE_REFERENCE_INVALID',
        `规则文档「${path}」有 ${Math.round(bytes / 1024)} KB，超过 ${Math.round(limit / 1024)} KB 上限`,
        { path, bytes, limit },
      )
    }
    const fileName = path.slice(path.lastIndexOf('/') + 1)
    const existing = this.store.listRuleDocuments().find(document => document.path === path)
    const document: RuleDocument = {
      schemaVersion: 1,
      id: existing?.id ?? randomUUID(),
      path,
      title: ruleDocumentTitle(content, fileName),
      fileName,
      content,
      bytes,
      importedAt: new Date().toISOString(),
    }
    await this.store.putRuleDocument(document)
    await this.activity(
      'assistant.rule_imported',
      document.id,
      1,
      `Rule document ${document.path} ${existing === undefined ? 'imported' : 'updated'}`,
    )
    this.publish('rule-document', document.id, 1, 'assistant.rule_imported')
    return document
  }

  /**
   * Delete a document and drop it from every assistant that selected it, so no
   * assistant is left pointing at a document that no longer exists.
   */
  async deleteRuleDocument(id: string): Promise<void> {
    const document = this.getRuleDocument(id)
    const owners = this.store.listAssistants()
      .filter(assistant => assistant.ruleDocumentAllowlist.includes(id))
    for (const assistant of owners) {
      await this.store.updateAssistant(assistant.id, current => ({
        ...current,
        ruleDocumentAllowlist: current.ruleDocumentAllowlist.filter(value => value !== id),
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      }))
    }
    await this.store.deleteRuleDocument(id)
    for (const assistant of owners) {
      const next = this.store.getAssistant(assistant.id)
      if (next !== undefined) this.runtime?.refreshAssistantSettings(next)
    }
    await this.activity(
      'assistant.rule_deleted',
      document.id,
      1,
      `Rule document ${document.fileName} deleted`,
    )
    this.publish('rule-document', document.id, 1, 'assistant.rule_deleted')
  }

  async mcpCatalog(agentPresetId: string): Promise<McpCatalogSnapshot> {    try {
      await this.ctx.agentPresets.resolve(agentPresetId)
      const scope = await this.ctx.agentPresets.standingKeyFor(agentPresetId)
      const servers = new Map<string, Array<{ name: string; description: string }>>()
      for (const tool of this.ctx.tools.schemas(scope)) {
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

  getAssistant(id: string): AssistantTemplate {
    return requireAssistant(this.store, id)
  }

  /**
   * The assistant a member runs as, resolved live.
   *
   * Members no longer carry a frozen configuration copy, so editing an
   * assistant changes every member that uses it. Deleting an assistant that a
   * team still references is rejected, so this always resolves for a member of
   * a stored team.
   */
  assistantForMember(member: TeamMemberSlot): AssistantTemplate {
    const assistant = this.store.getAssistant(member.assistantId)
    if (assistant === undefined) {
      throw new AgentTeamError(
        'ASSISTANT_NOT_FOUND',
        `成员「${member.displayName}」引用的助手已不存在，请替换该成员或重建团队`,
        { memberId: member.id, assistantId: member.assistantId },
      )
    }
    return assistant
  }

  listAssistants(): Page<AssistantTemplate> {
    const items = this.store.listAssistants()
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    return { items, total: items.length }
  }

  async createAssistant(raw: CreateAssistantInput): Promise<AssistantTemplate> {
    const input = await this.validateAssistantDraft(raw)
    const now = new Date().toISOString()
    const assistant: AssistantTemplate = {
      schemaVersion: 1,
      id: randomUUID(),
      ...input,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    await this.store.putAssistant(assistant)
    await this.activity('assistant.created', assistant.id, assistant.revision, `Assistant ${assistant.name} created`)
    this.publish('assistant', assistant.id, assistant.revision, 'assistant.created')
    return assistant
  }

  async validateAssistantDraft(
    raw: CreateAssistantInput,
  ): Promise<CreateAssistantInput & { ruleDocumentAllowlist: string[] }> {
    const input = normalizeAssistantInput(createAssistantInputSchema.parse(raw))
    await this.validateAssistantReferences(input)
    return input
  }

  async updateAssistant(
    id: string,
    raw: UpdateAssistantInput,
    options: MutationOptions = {},
  ): Promise<AssistantTemplate> {
    const patch = updateAssistantInputSchema.parse(raw)
    const current = requireAssistant(this.store, id)
    assertRevision('assistant', current.revision, options.expectedRevision)
    const candidate = normalizeAssistantInput(createAssistantInputSchema.parse({
      ...assistantInputOf(current),
      ...patch,
    }))
    await this.validateAssistantReferences(candidate)
    const next = await this.store.updateAssistant(id, value => ({
      ...value,
      ...candidate,
      revision: value.revision + 1,
      updatedAt: new Date().toISOString(),
    }))
    await this.activity('assistant.updated', next.id, next.revision, `Assistant ${next.name} updated`)
    // Members inherit the template live, but one that is already running holds
    // the selection and sandbox it was created with, so the edit is pushed onto
    // the members that still follow this assistant. Without this the teams drift
    // from their assistant and nothing on screen says so.
    await this.followAssistant(next)
    this.publish('assistant', next.id, next.revision, 'assistant.updated')
    return next
  }

  /**
   * The permission and reasoning a member runs with.
   *
   * A member has no settings of its own: its assistant owns them, and this is
   * the single place that says so. Everything that used to keep its own copy —
   * activation, the running Agent, the stored record — reads it from here, so
   * the team can never drift from the assistant that describes it.
   */
  assistantSettingsFor(member: TeamMemberSlot): {
    permissionPresetId: string
    reasoningEffort?: string
  } | undefined {
    const assistant = this.store.getAssistant(member.assistantId)
    if (assistant === undefined) return undefined
    return {
      permissionPresetId: assistant.permissionPresetId,
      ...(assistant.reasoningEffort === undefined ? {} : { reasoningEffort: assistant.reasoningEffort }),
    }
  }

  /** Rewrite every member of one team onto its assistant's current settings. */
  private membersOntoAssistants(team: TeamAggregate): TeamAggregate {
    return {
      ...team,
      members: mapTeamMembers(team, member => {
        const settings = this.assistantSettingsFor(member)
        if (settings === undefined) return member
        if (!this.ctx.permissionPresets.names.includes(settings.permissionPresetId)) return member
        return {
          ...member,
          permissionPresetId: settings.permissionPresetId,
          reasoningEffort: settings.reasoningEffort,
        }
      }),
    }
  }

  /**
   * Bring the members of every team back in line with an edited assistant.
   *
   * Members follow their assistant completely, so an edit has to reach the
   * records the next activation reads *and* the Agents already running. Draft
   * and archived teams have no runtime, so their records are all that changes.
   */
  private async followAssistant(assistant: AssistantTemplate): Promise<void> {
    // A template may name a preset this deployment does not offer (an assistant
    // imported from elsewhere). Writing it would make every member unstartable,
    // so such a template is left alone rather than followed into a dead end.
    if (!this.ctx.permissionPresets.names.includes(assistant.permissionPresetId)) return
    const teams = this.store.listTeams()
      .filter(team => Object.values(team.members).some(member => member.assistantId === assistant.id))
    if (teams.length === 0) return
    // Members that are already running hold the sandbox they were created with,
    // so the runtime re-sandboxes the ones this assistant owns. A team with no
    // running member still needs its record updated — that record is what the
    // next activation reads.
    this.runtime?.refreshAssistantSettings(assistant)
    for (const team of teams) {
      await this.updateRuntimeTeam(
        team.id,
        current => this.membersOntoAssistants(current),
        'team.members_followed_assistant',
        `Members of ${team.name} follow assistant ${assistant.name}`,
      )
    }
  }

  /**
   * Bring every member of every team onto its assistant once, at startup.
   *
   * Members used to keep their own copy of the permission, so a team could sit
   * on a stale value indefinitely — visible in the team view and, worse, the
   * sandbox the member actually ran with. The composition is authoritative now,
   * and this closes the gap for teams bound before that.
   */
  async followAssistants(): Promise<void> {
    const teams = this.store.listTeams()
      .filter(team => Object.values(team.members).some(member => (
        this.assistantSettingsFor(member) !== undefined
      )))
    for (const team of teams) {
      const next = this.membersOntoAssistants(team)
      if (JSON.stringify(next.members) === JSON.stringify(team.members)) continue
      await this.updateRuntimeTeam(
        team.id,
        current => this.membersOntoAssistants(current),
        'team.members_followed_assistant',
        `Members of ${team.name} followed their assistants on startup`,
      )
    }
  }

  async cloneAssistant(id: string, name?: string): Promise<AssistantTemplate> {
    const source = requireAssistant(this.store, id)
    return this.createAssistant({
      ...assistantInputOf(source),
      name: name?.trim() || `${source.name} Copy`,
    })
  }

  async deleteAssistant(id: string): Promise<void> {
    const assistant = requireAssistant(this.store, id)
    const references = this.store.listTeams()
      .filter(team => Object.values(team.members).some(member => member.assistantId === id))
      .map(team => ({ id: team.id, name: team.name }))
    if (references.length > 0) {
      throw new AgentTeamError(
        'ASSISTANT_IN_USE',
        `Assistant '${assistant.name}' is used by active team members`,
        { teams: references },
      )
    }
    await this.store.deleteAssistant(id)
    await this.activity('assistant.deleted', id, assistant.revision + 1, `Assistant ${assistant.name} deleted`)
    this.publish('assistant', id, assistant.revision + 1, 'assistant.deleted')
  }

  listAssistantBuilderConversations(): Promise<AssistantBuilderConversationListView> {
    return this.requireAssistantBuilderRuntime().listConversations()
  }

  getAssistantBuilderDraft(): Promise<AssistantBuilderDraftView> {
    return this.requireAssistantBuilderRuntime().getDraft()
  }

  configureAssistantBuilderDraft(provider: string, model: string): Promise<AssistantBuilderDraftView> {
    return this.requireAssistantBuilderRuntime().configureDraft(provider, model)
  }

  startAssistantBuilderConversation(
    provider: string,
    model: string,
    content: string,
  ): Promise<AssistantBuilderConversationView> {
    return this.requireAssistantBuilderRuntime().startConversation(provider, model, content)
  }

  getAssistantBuilderConversation(sessionId: string): Promise<AssistantBuilderConversationView> {
    return this.requireAssistantBuilderRuntime().getConversation(sessionId)
  }

  configureAssistantBuilder(
    sessionId: string,
    provider: string,
    model: string,
  ): Promise<AssistantBuilderConversationView> {
    return this.requireAssistantBuilderRuntime().configure(sessionId, provider, model)
  }

  sendAssistantBuilderMessage(sessionId: string, content: string): Promise<{ messageId: string }> {
    return this.requireAssistantBuilderRuntime().sendMessage(sessionId, content)
  }

  respondToAssistantBuilderInteraction(
    sessionId: string,
    interactionId: string,
    response: InteractionResponseInput,
  ): Promise<void> {
    return this.requireAssistantBuilderRuntime().respondToInteraction(sessionId, interactionId, response)
  }

  stopAssistantBuilder(sessionId: string): Promise<void> {
    return this.requireAssistantBuilderRuntime().stop(sessionId)
  }

  archiveAssistantBuilderConversation(sessionId: string): Promise<void> {
    return this.requireAssistantBuilderRuntime().archiveConversation(sessionId)
  }

  getTeam(id: string): TeamAggregate {
    return requireTeam(this.store, id)
  }

  listTeams(): Page<TeamAggregate> {
    const items = this.store.listTeams()
    return { items, total: items.length }
  }

  async createTeamDraft(raw: CreateTeamDraftInput): Promise<TeamAggregate> {
    const input = createTeamDraftInputSchema.parse(raw)
    const leaders = input.members.filter(member => member.role === 'leader')
    if (leaders.length !== 1) {
      throw new AgentTeamError('TEAM_INVALID_LEADER', 'A team must contain exactly one leader')
    }

    const now = new Date().toISOString()
    const members: Record<string, TeamMemberSlot> = {}
    let leaderSlotId = ''
    for (const item of input.members) {
      const assistant = requireAssistant(this.store, item.assistantId)
      const slotId = randomUUID()
      members[slotId] = {
        id: slotId,
        assistantId: assistant.id,
        displayName: assistant.name,
        role: item.role,
        permissionPresetId: assistant.permissionPresetId,
        ...(assistant.reasoningEffort === undefined ? {} : { reasoningEffort: assistant.reasoningEffort }),
        ruleAllowlist: [],
        desiredState: 'offline',
        lastRuntimeState: 'offline',
        joinedAt: now,
      }
      if (item.role === 'leader') leaderSlotId = slotId
    }

    const team: TeamAggregate = {
      schemaVersion: 1,
      id: randomUUID(),
      name: input.name.trim(),
      leaderSlotId,
      state: 'draft',
      directMemberChat: input.directMemberChat ?? this.config.directMemberChatDefault,
      members,
      retiredSessions: {},
      tasks: {},
      leases: {},
      outbox: {},
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    await this.store.putTeam(team)
    await this.activity('team.created', team.id, team.revision, `Team ${team.name} draft created`)
    this.publish('team', team.id, team.revision, 'team.created')
    return team
  }

  async cloneTeam(sourceTeamId: string, raw: CloneTeamInput): Promise<TeamAggregate> {
    const input = cloneTeamInputSchema.parse(raw)
    const source = requireTeam(this.store, sourceTeamId)

    const now = new Date().toISOString()
    const members: Record<string, TeamMemberSlot> = {}
    let leaderSlotId = ''
    for (const sourceMember of Object.values(source.members)) {
      const member = cloneMemberSlot(sourceMember, now)
      members[member.id] = member
      if (sourceMember.id === source.leaderSlotId) leaderSlotId = member.id
    }
    if (leaderSlotId === '') {
      throw new AgentTeamError('TEAM_INVALID_LEADER', 'Source team has no valid leader')
    }

    const team: TeamAggregate = {
      schemaVersion: 1,
      id: randomUUID(),
      name: input.name.trim(),
      leaderSlotId,
      state: 'draft',
      directMemberChat: source.directMemberChat,
      members,
      retiredSessions: {},
      tasks: {},
      leases: {},
      outbox: {},
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    await this.store.putTeam(team)
    await this.activity('team.cloned', team.id, team.revision, `Team ${team.name} cloned from ${source.name}`)
    this.publish('team', team.id, team.revision, 'team.cloned')
    return team
  }

  async changeLeader(
    teamId: string,
    successorSlotId: string,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const current = requireTeam(this.store, teamId)
    assertTeamMutable(current)
    assertRevision('team', current.revision, options.expectedRevision)
    if (current.members[successorSlotId] === undefined) {
      throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${successorSlotId}'`)
    }
    if (current.leaderSlotId === successorSlotId) {
      throw new AgentTeamError('INVALID_REQUEST', 'The selected member is already the team leader')
    }
    const next = await this.store.updateTeam(teamId, team => ({
      ...team,
      members: Object.fromEntries(Object.entries(team.members).map(([slotId, member]) => [
        slotId,
        { ...member, role: slotId === successorSlotId ? 'leader' : 'member' },
      ])),
      leaderSlotId: successorSlotId,
      revision: team.revision + 1,
      updatedAt: new Date().toISOString(),
    }))
    await this.activity('team.leader_changed', teamId, next.revision, 'Team leader changed')
    this.publish('team', teamId, next.revision, 'team.leader_changed')
    if (this.runtime !== undefined && next.state !== 'draft') {
      await this.runtime.leaderChanged(teamId, successorSlotId)
    }
    return next
  }

  async addMember(
    teamId: string,
    raw: AddTeamMemberInput,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const input = addTeamMemberInputSchema.parse(raw)
    const team = requireTeam(this.store, teamId)
    assertTeamMutable(team)
    assertRevision('team', team.revision, options.expectedRevision)
    if (team.state !== 'draft' && team.state !== 'active') {
      throw new AgentTeamError('TEAM_NOT_ACTIVE', `Cannot add a member while team is '${team.state}'`)
    }
    const assistant = requireAssistant(this.store, input.assistantId)
    const displayName = assistant.name
    const now = new Date().toISOString()
    const member = createMemberSlot(assistant, displayName, 'member', now, team.state === 'draft' ? 'offline' : 'online')
    const next = await this.store.updateTeam(teamId, current => ({
      ...current,
      members: { ...current.members, [member.id]: member },
      revision: current.revision + 1,
      updatedAt: now,
    }))
    await this.activity('team.member_added', teamId, next.revision, `Member ${displayName} added`)
    this.publish('team', teamId, next.revision, 'team.member_added')
    if (next.state !== 'draft') return this.requireRuntime().activateMember(teamId, member.id)
    return next
  }

  async removeMember(
    teamId: string,
    slotId: string,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const team = requireTeam(this.store, teamId)
    assertTeamMutable(team)
    assertRevision('team', team.revision, options.expectedRevision)
    const member = team.members[slotId]
    if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    if (slotId === team.leaderSlotId) {
      throw new AgentTeamError('MEMBER_IS_LEADER', 'Choose a successor before removing the current leader')
    }
    assertMemberHasNoOpenTasks(team, slotId)
    if (team.state === 'draft') {
      const next = await this.store.updateTeam(teamId, current => {
        const members = { ...current.members }
        delete members[slotId]
        return { ...current, members, revision: current.revision + 1, updatedAt: new Date().toISOString() }
      })
      await this.activity('team.member_removed', teamId, next.revision, `Member ${member.displayName} removed`)
      this.publish('team', teamId, next.revision, 'team.member_removed')
      return next
    }
    return this.requireRuntime().removeMember(teamId, slotId)
  }

  async startTeam(teamId: string, options: MutationOptions = {}): Promise<TeamAggregate> {
    const team = requireTeam(this.store, teamId)
    assertRevision('team', team.revision, options.expectedRevision)
    return this.requireRuntime().startTeam(teamId)
  }

  async sendUserMessage(
    teamId: string,
    conversationId: string,
    content: string,
    targetSlotId?: string,
  ): Promise<TeamMessage> {
    return this.requireRuntime().sendUserMessage(teamId, content, conversationId, targetSlotId)
  }

  async getWorkbench(teamId: string, conversationId: string): Promise<TeamWorkbenchView> {
    const view = await this.requireRuntime().getWorkbench(teamId, conversationId)
    const displays = this.conversationDisplays(teamId)
    return { ...view, conversation: this.displayConversation(view.conversation, displays) }
  }

  /** One member's older page of nodes, prepended by the viewer. */
  getOlderMemberConversation(
    teamId: string,
    conversationId: string,
    slotId: string,
    beforeSeq: number,
  ): Promise<MemberConversationView> {
    return this.requireRuntime()
      .getOlderMemberConversation(teamId, conversationId, slotId, beforeSeq)
  }

  listConversations(teamId: string): Page<TeamConversation> {
    requireTeam(this.store, teamId)
    const displays = this.conversationDisplays(teamId)
    const items = this.store.listConversations(teamId)
      .map(conversation => this.displayConversation(conversation, displays))
    return { items, total: items.length }
  }

  /**
   * Sidebar facts of a team's conversations, resolved in one pass: the title
   * rule is DSH's own first-prompt fallback over the earliest user message, and
   * the row's right-hand stamp is the conversation's latest activity.
   */
  private conversationDisplays(teamId: string): Map<string, ConversationDisplay> {
    const displays = new Map<string, ConversationDisplay>()
    for (const message of this.store.listMessages(teamId)) {
      if (message.conversationId === undefined) continue
      const at = Date.parse(message.createdAt)
      const current = displays.get(message.conversationId)
      const firstUserText = message.sender.kind === 'user' && message.content.trim().length > 0
        ? current?.firstUserText ?? message.content
        : current?.firstUserText
      displays.set(message.conversationId, {
        ...(firstUserText === undefined ? {} : { firstUserText }),
        lastActivity: Math.max(current?.lastActivity ?? 0, at),
      })
    }
    return displays
  }

  /**
   * Display copy of one conversation. An auto title is derived, never stored:
   * the record keeps its placeholder so a rename stays the only pinned title.
   * An underivable title stays empty, which the UI labels like a new Session.
   */
  private displayConversation(
    conversation: TeamConversation,
    displays: Map<string, ConversationDisplay>,
  ): TeamConversation {
    if (conversation.titleSource === 'user') return conversation
    const display = displays.get(conversation.id)
    if (display === undefined) return { ...conversation, title: '' }
    return {
      ...conversation,
      title: display.firstUserText === undefined
        ? ''
        : fallbackSessionTitle(display.firstUserText, AUTO_TITLE_WORDS, AUTO_TITLE_BYTES),
      updatedAt: new Date(display.lastActivity).toISOString(),
    }
  }

  getConversation(teamId: string, conversationId: string): TeamConversation {
    const conversation = this.store.getConversation(conversationId)
    if (conversation === undefined || conversation.teamId !== teamId) {
      throw new AgentTeamError('CONVERSATION_NOT_FOUND', `Unknown conversation '${conversationId}'`)
    }
    return conversation
  }

  /**
   * The conversation bound to one Harness Session, if any.
   *
   * A Session enables at most one team, so the first match is the only match;
   * legacy conversations carry no Session and are never returned.
   */
  findConversationBySession(sessionId: string): TeamConversation | undefined {
    for (const team of this.store.listTeams()) {
      const found = this.store.listConversations(team.id).find(item => item.sessionId === sessionId)
      if (found !== undefined) return found
    }
    return undefined
  }

  /** Enable a team in one Harness Session; the runtime binds and activates it. */
  async bindSession(sessionId: string, teamId: string): Promise<TeamConversation> {
    return this.requireRuntime().bindSession(sessionId, teamId)
  }

  /** Disable whichever team is enabled in one Harness Session. */
  async unbindSession(sessionId: string): Promise<void> {
    return this.requireRuntime().unbindSession(sessionId)
  }

  /**
   * Turn «替我审批» on or off for one Session's binding: with it on, the Leader
   * answers every interaction of that conversation on the reader's behalf.
   */
  async setSessionDelegation(sessionId: string, delegate: boolean): Promise<TeamConversation> {
    return this.requireRuntime().setSessionDelegation(sessionId, delegate)
  }

  /**
   * Create the conversation record for a Harness Session without activating
   * anything. Used by the runtime (which activates afterwards).
   *
   * The workspace is read off the Session, because a DSH Session's working
   * directory is fixed when it is created and every member shares it.
   */
  async createConversationRecord(
    teamId: string,
    input: {
      sessionId: string
      workspaceId: string
      workspacePath: string
      title?: string
    },
  ): Promise<TeamConversation> {
    requireTeam(this.store, teamId)
    const workspace = await this.requireWorkspace(input.workspaceId)
    const now = new Date().toISOString()
    const conversation: TeamConversation = {
      schemaVersion: 1,
      id: randomUUID(),
      teamId,
      sessionId: input.sessionId,
      // Placeholder only: the Session's own title is what the UI shows.
      title: input.title?.trim() || `会话 ${this.store.listConversations(teamId).length + 1}`,
      titleSource: input.title === undefined ? 'auto' : 'user',
      state: 'active',
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      memberSessions: {},
      createdAt: now,
      updatedAt: now,
      revision: 1,
    }
    await this.store.putConversation(conversation)
    return conversation
  }

  /** Drop one conversation record, which un-enables its team in that Session. */
  async deleteConversationRecord(teamId: string, conversationId: string): Promise<void> {
    const conversation = this.getConversation(teamId, conversationId)
    await this.store.deleteConversation(conversation.id)
    this.publish('conversation', teamId, conversation.revision, 'team.conversation_removed')
  }

  /** Change one conversation record, bumping its revision and publishing it. */
  async updateConversationRecord(
    conversationId: string,
    update: (current: TeamConversation) => TeamConversation,
  ): Promise<TeamConversation> {
    const updated = await this.store.updateConversation(conversationId, current => ({
      ...update(current),
      updatedAt: new Date().toISOString(),
      revision: current.revision + 1,
    }))
    this.publish('conversation', updated.teamId, updated.revision, 'team.conversation_updated')
    return updated
  }

  /** Resolve a Workspace the caller picked, refusing one that is not usable. */
  private async requireWorkspace(workspaceId: string): Promise<{ id: string; path: string }> {
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(workspaceId))
    if (workspace === undefined || await workspace.status() !== 'ok') {
      throw new AgentTeamError('WORKSPACE_UNAVAILABLE', `Workspace '${workspaceId}' is unavailable`)
    }
    return { id: String(workspace.id), path: workspace.path }
  }

  /** Record the Session ids a conversation assigned to its members. */
  async assignMemberSessions(
    teamId: string,
    conversationId: string,
    additions: Record<string, string>,
  ): Promise<TeamConversation> {
    const conversation = this.getConversation(teamId, conversationId)
    const next: TeamConversation = {
      ...conversation,
      memberSessions: { ...conversation.memberSessions, ...additions },
      updatedAt: new Date().toISOString(),
      revision: conversation.revision + 1,
    }
    await this.store.putConversation(next)
    return next
  }

  /** Drop one member's Session assignment from every conversation of a team. */
  async forgetMemberSessions(teamId: string, slotId: string): Promise<void> {
    for (const conversation of this.store.listConversations(teamId)) {
      if (conversation.memberSessions[slotId] === undefined) continue
      const memberSessions = { ...conversation.memberSessions }
      delete memberSessions[slotId]
      await this.store.putConversation({
        ...conversation,
        memberSessions,
        updatedAt: new Date().toISOString(),
        revision: conversation.revision + 1,
      })
    }
  }

  getRoom(teamId: string, conversationId: string, beforeTime?: number): Promise<RoomView> {
    requireTeam(this.store, teamId)
    return this.requireRuntime().getRoom(teamId, conversationId, beforeTime)
  }

  sendRoomMessage(
    teamId: string,
    content: string,
    conversationId: string,
    mentions: readonly string[] = [],
  ): Promise<TeamMessage> {
    return this.requireRuntime().sendRoomMessage(teamId, content, conversationId, mentions)
  }

  stopMember(teamId: string, slotId: string, conversationId: string): Promise<void> {
    requireTeam(this.store, teamId)
    return this.requireRuntime().stopMember(teamId, slotId, conversationId)
  }

  async respondToInteraction(
    teamId: string,
    slotId: string,
    interactionId: string,
    response: InteractionResponseInput,
    conversationId: string,
  ): Promise<void> {
    const team = requireTeam(this.store, teamId)
    if (team.members[slotId] === undefined) {
      throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    }
    await this.requireRuntime()
      .respondToInteraction(teamId, slotId, interactionId, response, conversationId)
  }


  publishConversation(teamId: string, revision: number, conversation?: MemberConversationView): void {
    this.publish('conversation', teamId, revision, 'member.conversation', conversation)
  }

  publishAssistantBuilderConversation(conversation: AssistantBuilderConversationView): void {
    const change: AgentTeamChange = {
      cursor: ++this.cursor,
      entityType: 'assistant-builder',
      entityId: conversation.sessionId,
      revision: Math.max(0, conversation.throughSeq + 1),
      kind: 'assistant.builder.conversation',
      assistantBuilderConversation: conversation,
    }
    for (const listener of this.listeners) listener(change)
  }

  async listWorkspace(
    teamId: string,
    conversationId?: string,
    rawPath = '',
  ): Promise<WorkspaceEntryView[]> {
    return this.workspace.list(teamId, conversationId, rawPath)
  }

  async searchWorkspace(
    teamId: string,
    conversationId?: string,
    query = '',
    limit = 40,
  ): Promise<WorkspaceEntryView[]> {
    return this.workspace.search(teamId, conversationId, query, limit)
  }

  async getWorkspaceChanges(teamId: string, conversationId?: string): Promise<WorkspaceGitStatusView> {
    return this.workspace.changes(teamId, conversationId)
  }

  async getWorkspaceDiff(
    teamId: string,
    conversationId: string | undefined,
    path: string,
    scope: 'staged' | 'unstaged',
    layout: 'unified' | 'split',
    theme: 'light' | 'dark',
  ): Promise<WorkspaceGitDiffView> {
    return this.workspace.diff(teamId, conversationId, path, scope, layout, theme)
  }

  async uploadWorkspaceFile(
    teamId: string,
    conversationId: string | undefined,
    rawName: string,
    data: Uint8Array,
  ): Promise<WorkspaceUploadView> {
    return this.workspace.upload(teamId, conversationId, rawName, data)
  }

  listMessages(teamId: string): Page<TeamMessage> {
    requireTeam(this.store, teamId)
    const items = this.store.listMessages(teamId)
    return { items, total: items.length }
  }

  async updateRuntimeTeam(
    teamId: string,
    update: (team: TeamAggregate) => TeamAggregate,
    kind: string,
    summary: string,
  ): Promise<TeamAggregate> {
    const next = await this.store.updateTeam(teamId, current => {
      const candidate = update(current)
      return {
        ...candidate,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      }
    })
    await this.activity(kind, teamId, next.revision, summary)
    this.publish('team', teamId, next.revision, kind)
    return next
  }

  async putRuntimeMessage(message: TeamMessage): Promise<void> {
    await this.store.putMessage(message)
    const team = requireTeam(this.store, message.teamId)
    this.publish('team', team.id, team.revision, 'team.message')
  }

  /**
   * Drop the wake-up relay copies an earlier bug stored as room messages.
   *
   * Relaying a mentioned member injected the wake-up as user input, so the room
   * recorded its own relay text and relayed it again. Left in place those rows
   * read as things the user said. Nothing else produces them.
   *
   * @param teamId - team whose records are repaired.
   * @returns how many records were dropped.
   */
  async dropRoomRelayEchoes(teamId: string): Promise<number> {
    requireTeam(this.store, teamId)
    const echoes = this.store.listMessages(teamId).filter(isRoomRelayEcho)
    await Promise.all(echoes.map(message => this.store.deleteMessage(message.id)))
    return echoes.length
  }

  async dissolveTeam(
    teamId: string,
    confirmation: string,
    options: MutationOptions = {},
  ): Promise<void> {
    const team = requireTeam(this.store, teamId)
    assertRevision('team', team.revision, options.expectedRevision)
    if (confirmation !== team.name) {
      throw new AgentTeamError('INVALID_REQUEST', 'Team name confirmation does not match')
    }
    if (team.state !== 'draft') return this.requireRuntime().dissolveTeam(teamId)
    await this.deleteTeamRecords(teamId)
  }

  async deleteTeamRecords(teamId: string): Promise<void> {
    const team = requireTeam(this.store, teamId)
    await Promise.all(this.store.listMessages(teamId).map(message => this.store.deleteMessage(message.id)))
    await Promise.all(this.store.listConversations(teamId).map(conversation => this.store.deleteConversation(conversation.id)))
    await Promise.all(this.store.listActivities(teamId).map(activity => this.store.deleteActivity(activity.id)))
    await this.store.deleteTeam(teamId)
    await this.workspace.unwatch(teamId)
    this.publish('team', teamId, team.revision + 1, 'team.deleted')
  }

  /**
   * Drop every stored record of a team without touching its Workspace. Used to
   * discard teams that predate conversation-scoped member Sessions.
   */
  async purgeTeamRecords(teamId: string): Promise<void> {
    const team = this.store.getTeam(teamId)
    if (team === undefined) return
    await Promise.all(this.store.listMessages(teamId).map(message => this.store.deleteMessage(message.id)))
    await Promise.all(this.store.listConversations(teamId).map(conversation => this.store.deleteConversation(conversation.id)))
    await Promise.all(this.store.listActivities(teamId).map(activity => this.store.deleteActivity(activity.id)))
    await Promise.all(this.store.listOperations().filter(operation => operation.teamId === teamId).map(operation => this.store.deleteOperation(operation.id)))
    await this.store.deleteTeam(teamId)
    await this.workspace.unwatch(teamId)
    this.publish('team', teamId, team.revision + 1, 'team.deleted')
  }

  getOperation(id: string): Operation {
    const operation = this.store.getOperation(id)
    if (operation === undefined) {
      throw new AgentTeamError('INVALID_REQUEST', `Unknown operation '${id}'`)
    }
    return operation
  }

  private async validateAssistantReferences(input: CreateAssistantInput): Promise<void> {
    const invalidSkill = input.skillAllowlist.find(name => !isSkillName(name))
    if (invalidSkill !== undefined) {
      throw new AgentTeamError('SKILL_REFERENCE_INVALID', `Invalid Skill name '${invalidSkill}'`)
    }
    const invalidMcpServer = input.mcpServers.find(name => !isMcpServerName(name))
    if (invalidMcpServer !== undefined) {
      throw new AgentTeamError('MCP_REFERENCE_INVALID', `Invalid MCP Server name '${invalidMcpServer}'`)
    }
    await this.validateReasoningEffort(input.provider, input.model, input.reasoningEffort)
    try {
      await this.ctx.agentPresets.resolve(input.agentPresetId)
    } catch (error) {
      throw new AgentTeamError(
        'PRESET_REFERENCE_INVALID',
        `Unknown agent preset '${input.agentPresetId}'`,
        undefined,
        { cause: error },
      )
    }
    if (!this.ctx.permissionPresets.names.includes(input.permissionPresetId)) {
      throw new AgentTeamError(
        'PERMISSION_PRESET_INVALID',
        `Unknown permission preset '${input.permissionPresetId}'`,
      )
    }
    if (input.mcpServers.length > 0) {
      const catalog = await this.mcpCatalog(input.agentPresetId)
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

  private async validateReasoningEffort(
    provider: string,
    model: string,
    reasoningEffort: string | undefined,
  ): Promise<void> {
    const capabilities = await this.modelCapabilities(provider, model)
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

  private async activity(kind: string, entityId: string, revision: number, summary: string): Promise<void> {
    const activity: TeamActivity = {
      schemaVersion: 1,
      id: randomUUID(),
      teamId: kind.startsWith('team.') ? entityId : 'assistant-library',
      kind,
      entityId,
      summary,
      revision,
      createdAt: new Date().toISOString(),
    }
    try {
      await this.store.putActivity(activity)
    } catch (error) {
      this.ctx.logger.warn('agent-team: activity write failed after primary mutation', error)
    }
  }

  private publish(
    entityType: AgentTeamChange['entityType'],
    entityId: string,
    revision: number,
    kind: string,
    conversation?: MemberConversationView,
  ): void {
    const change: AgentTeamChange = {
      cursor: ++this.cursor,
      entityType,
      entityId,
      revision,
      kind,
      ...(conversation === undefined ? {} : { conversation }),
    }
    for (const listener of this.listeners) listener(change)
  }

  private requireRuntime(): TeamRuntime {
    if (this.runtime === undefined) throw new Error('dsh-squad runtime is not attached')
    return this.runtime
  }


  private requireAssistantBuilderRuntime(): AssistantBuilderRuntime {
    if (this.assistantBuilderRuntime === undefined) throw new Error('Assistant Builder runtime is not attached')
    return this.assistantBuilderRuntime
  }
}

function requireAssistant(store: AgentTeamStore, id: string): AssistantTemplate {
  const assistant = store.getAssistant(id)
  if (assistant === undefined) {
    throw new AgentTeamError('ASSISTANT_NOT_FOUND', `Unknown assistant '${id}'`)
  }
  return assistant
}

function requireTeam(store: AgentTeamStore, id: string): TeamAggregate {
  const team = store.getTeam(id)
  if (team === undefined) throw new AgentTeamError('TEAM_NOT_FOUND', `Unknown team '${id}'`)
  return team
}

function assertRevision(entity: string, actual: number, expected?: number): void {
  if (expected !== undefined && expected !== actual) {
    throw new AgentTeamError(
      entity === 'assistant' ? 'ASSISTANT_REVISION_CONFLICT' : 'TEAM_REVISION_CONFLICT',
      `${entity} revision conflict: expected ${expected}, current ${actual}`,
      { expected, actual },
    )
  }
}

function assertTeamMutable(team: TeamAggregate): void {
  if (team.state === 'deleting' || team.state === 'delete_blocked') {
    throw new AgentTeamError('TEAM_DELETING', `Team '${team.id}' is deleting`)
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
function normalizeRulePath(raw: string): string | undefined {
  const segments = raw
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0 && segment !== '.')
  if (segments.length === 0 || segments.some(segment => segment === '..')) return undefined
  const path = segments.join('/')
  if (path.length > 300) return undefined
  return /^[\p{L}\p{N}._\- /]+$/u.test(path) ? path : undefined
}

/**
 * A readable name for an imported document: its first Markdown heading, or the
 * file name when the document has no heading.
 */
function ruleDocumentTitle(content: string, fileName: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(content)?.[1]?.trim()
  return heading !== undefined && heading.length > 0 ? heading.slice(0, 120) : fileName
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function createMemberSlot(
  assistant: AssistantTemplate,
  displayName: string,
  role: 'leader' | 'member',
  now: string,
  desiredState: 'online' | 'offline',
): TeamMemberSlot {
  const slotId = randomUUID()
  return {
    id: slotId,
    assistantId: assistant.id,
    displayName,
    role,
    permissionPresetId: assistant.permissionPresetId,
    ...(assistant.reasoningEffort === undefined ? {} : { reasoningEffort: assistant.reasoningEffort }),
    ruleAllowlist: [],
    desiredState,
    lastRuntimeState: desiredState === 'online' ? 'starting' : 'offline',
    joinedAt: now,
  }
}

/**
 * Clone a member onto a new slot. The clone points at the same assistant, so it
 * inherits that assistant's *current* configuration; copying a frozen snapshot
 * here would carry a stale model into the new team.
 */
function cloneMemberSlot(source: TeamMemberSlot, now: string): TeamMemberSlot {
  const slotId = randomUUID()
  return {
    id: slotId,
    assistantId: source.assistantId,
    displayName: source.displayName,
    role: source.role,
    permissionPresetId: source.permissionPresetId,
    ...(source.reasoningEffort === undefined ? {} : { reasoningEffort: source.reasoningEffort }),
    ruleAllowlist: [...source.ruleAllowlist],
    desiredState: 'offline',
    lastRuntimeState: 'offline',
    joinedAt: now,
  }
}

function withReasoningEffort(
  member: TeamMemberSlot,
  reasoningEffort: string | undefined,
): TeamMemberSlot {
  const { reasoningEffort: _current, ...rest } = member
  return reasoningEffort === undefined ? rest : { ...rest, reasoningEffort }
}

function assertMemberHasNoOpenTasks(team: TeamAggregate, slotId: string): void {
  const open = Object.values(team.tasks).filter(task =>
    taskAssigneeIds(task).includes(slotId) && !['completed', 'failed', 'cancelled'].includes(task.status))
  if (open.length > 0) {
    throw new AgentTeamError(
      'MEMBER_BUSY',
      'Reassign, complete, fail, or cancel this member’s open tasks before removal',
      { taskIds: open.map(task => task.id) },
    )
  }
}
