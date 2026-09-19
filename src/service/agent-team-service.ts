import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { isModelInvocable, isSkillName, isUserInvocable } from '@deepseek-ai/dsh-skill'
import { fallbackSessionTitle } from '@deepseek-ai/dsh-session-title'
import type { Config } from '../config.js'
import type { BundleImportSummary, SquadBundle } from '../domain/bundle.js'
import { exportConfigured, importInto } from './bundle-service.js'
import { CatalogCache } from './catalog-cache.js'
import { AgentTeamError } from '../domain/errors.js'
import {
  assertRevision,
  assertTeamMutable,
  createMemberSlot,
  requireAssistant,
  requireTeam,
  type MutationOptions,
} from './store-guards.js'

// The service's public surface still names it here.
export type { MutationOptions } from './store-guards.js'
import {
  type McpCatalogSnapshot,
  type ModelCapabilitiesSnapshot,
  type SkillCatalogSnapshot,
} from './catalog-views.js'
import * as catalogViews from './catalog-views.js'
import * as conversations from './conversations-service.js'
import * as assistants from './assistants-service.js'
import * as teams from './teams-service.js'
import {
  deleteRuleDocument,
  getRuleDocument,
  importRuleDocument,
  listRuleDocuments,
  ruleDocumentLimit,
  type RuleDocumentDeps,
} from './rule-documents.js'
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
  type TeamTask,
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

/**
 * Native session-title fallback limits, taken from the shipped
 * `session-title` defaults so a team conversation gets exactly the title a DSH
 * Session would get from the same first message.
 */
/**
 * How long one complete catalog read is reused before it refreshes.
 *
 * Reading a provider's models is a network round trip, and a real setup has
 * several providers, so a complete read takes tens of seconds. Nothing in the
 * UI changes that fast — a provider list, a preset list, the Workspace list —
 * and a view opening must not wait on it.
 */
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

export type { McpCatalogSnapshot, ModelCapabilitiesSnapshot, SkillCatalogSnapshot } from './catalog-views.js'

export class AgentTeamService extends Service {
  private readonly listeners = new Set<(change: AgentTeamChange) => void>()
  private cursor = 0
  /** Last complete catalog read, and when it was taken. */
  private runtime?: TeamRuntime
  private assistantBuilderRuntime?: AssistantBuilderRuntime
  private readonly workspace: WorkspaceService
  private readonly catalogCache: CatalogCache

  constructor(
    ctx: Context,
    readonly config: Config,
    private readonly store: AgentTeamStore,
  ) {
    super(ctx, 'agentTeam')
    this.catalogCache = new CatalogCache(ctx, () => {
      this.publish('catalog', 'models', 0, 'catalog.models_updated')
    })
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

  // ── The assistant designer ──────────────────────────────────────────────
  attachAssistantBuilderRuntime(runtime: AssistantBuilderRuntime): void {
    if (this.assistantBuilderRuntime !== undefined) throw new Error('Assistant Builder runtime is already attached')
    this.assistantBuilderRuntime = runtime
  }

  // ── The workspace a conversation runs in ────────────────────────────────
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
  /** The deployment's providers, models and presets, cached behind one read. */
  // ── The catalog: what this deployment offers ────────────────────────────

  /** The deployment's providers, models and presets, cached behind one read. */
  catalog(): Promise<CatalogSnapshot> {
    return this.catalogCache.get()
  }

  // The three live reads belong to `catalog-views`; the service is where
  // callers reach them.

  async modelCapabilities(
    provider: string,
    model: string,
  ): Promise<ModelCapabilitiesSnapshot> {
    return await catalogViews.modelCapabilities(this.catalogDeps(), provider, model)
  }

  async skillCatalog(agentPresetId: string): Promise<SkillCatalogSnapshot> {
    return await catalogViews.skillCatalog(this.catalogDeps(), agentPresetId)
  }

  async mcpCatalog(agentPresetId: string): Promise<McpCatalogSnapshot> {
    return await catalogViews.mcpCatalog(this.catalogDeps(), agentPresetId)
  }

  /** What reading the catalogs needs from this service. */
  private catalogDeps(): catalogViews.CatalogDeps {
    return { ctx: this.ctx }
  }

  /**
   * Every imported rule document, newest last.
   *
   * Documents are whole files (a `CLAUDE.md`, a house style guide) stored
   * verbatim, not individual rules. Which ones an Agent loads is part of that
   * Agent's configuration, so there is no per-team catalog any more.
   */

  /** Imported rule documents; the domain itself lives in its own module. */
  private ruleDocumentDeps(): RuleDocumentDeps {
    return {
      store: this.store,
      maxRequestBytes: this.config.maxRequestBytes,
      activity: (kind, entityId, revision, summary) => this.activity(kind, entityId, revision, summary),
      publish: (entityType, entityId, revision, kind) => { this.publish(entityType, entityId, revision, kind) },
      refreshAssistantSettings: assistant => { this.runtime?.refreshAssistantSettings(assistant) },
    }
  }

  // ── Imported rule documents ─────────────────────────────────────────────
  listRuleDocuments(): Page<RuleDocument> {
    return listRuleDocuments(this.store)
  }

  getRuleDocument(id: string): RuleDocument {
    return getRuleDocument(this.store, id)
  }

  ruleDocumentLimit(): number {
    return ruleDocumentLimit(this.config.maxRequestBytes)
  }

  importRuleDocument(rawPath: string, content: string): Promise<RuleDocument> {
    return importRuleDocument(this.ruleDocumentDeps(), rawPath, content)
  }

  deleteRuleDocument(id: string): Promise<void> {
    return deleteRuleDocument(this.ruleDocumentDeps(), id)
  }

  /**
   * The assistant a member runs as, resolved live.
   *
   * Members no longer carry a frozen configuration copy, so editing an
   * assistant changes every member that uses it. Deleting an assistant that a
   * team still references is rejected, so this always resolves for a member of
   * a stored team.
   */
  // ── Assistant templates ─────────────────────────────────────────────────
  // These belong to `assistants-service`; the service is where callers reach
  // them, so it hands each one on.

  getAssistant(id: string): AssistantTemplate {
    return assistants.getAssistant(this.assistantDeps(), id)
  }

  assistantForMember(member: TeamMemberSlot): AssistantTemplate {
    return assistants.assistantForMember(this.assistantDeps(), member)
  }

  listAssistants(): Page<AssistantTemplate> {
    return assistants.listAssistants(this.assistantDeps())
  }

  async createAssistant(raw: CreateAssistantInput): Promise<AssistantTemplate> {
    return await assistants.createAssistant(this.assistantDeps(), raw)
  }

  async validateAssistantDraft(
    raw: CreateAssistantInput,
  ): Promise<CreateAssistantInput & { ruleDocumentAllowlist: string[] }> {
    return await assistants.validateAssistantDraft(this.assistantDeps(), raw)
  }

  async updateAssistant(
    id: string,
    raw: UpdateAssistantInput,
    options: MutationOptions = {},
  ): Promise<AssistantTemplate> {
    return await assistants.updateAssistant(this.assistantDeps(), id, raw, options)
  }

  assistantSettingsFor(member: TeamMemberSlot): {
    permissionPresetId: string
    reasoningEffort?: string
  } | undefined {
    return assistants.assistantSettingsFor(this.assistantDeps(), member)
  }

  async followAssistants(): Promise<void> {
    await assistants.followAssistants(this.assistantDeps())
  }

  async cloneAssistant(id: string, name?: string): Promise<AssistantTemplate> {
    return await assistants.cloneAssistant(this.assistantDeps(), id, name)
  }

  async deleteAssistant(id: string): Promise<void> {
    await assistants.deleteAssistant(this.assistantDeps(), id)
  }

  async updateRuntimeTeam(
    teamId: string,
    update: (team: TeamAggregate) => TeamAggregate,
    kind: string,
    summary: string,
  ): Promise<TeamAggregate> {
    return await assistants.updateRuntimeTeam(this.assistantDeps(), teamId, update, kind, summary)
  }

  /** What `assistants-service` needs from this service, gathered in one place. */
  private assistantDeps(): assistants.AssistantDeps {
    return {
      store: this.store,
      ctx: this.ctx,
      runtime: this.runtime,
      activity: (kind, entityId, revision, summary) => this.activity(kind, entityId, revision, summary),
      publish: (entityType, entityId, revision, kind) => {
        this.publish(entityType, entityId, revision, kind)
      },
      modelCapabilities: (provider, model) => this.modelCapabilities(provider, model),
      mcpCatalog: agentPresetId => this.mcpCatalog(agentPresetId),
    }
  }

  /**
   * Write what this instance is configured with into a portable file. Only
   * configuration travels; the running state stays with the machine it ran on.
   */
  // ── Moving configuration in and out ─────────────────────────────────────
  exportBundle(input: { teamIds?: readonly string[] | undefined } = {}): SquadBundle {
    return exportConfigured(this.store, input)
  }

  /** Write a bundle into this instance; `mode` decides copy versus overwrite. */
  async importBundle(raw: unknown): Promise<BundleImportSummary> {
    return importInto(this.store, raw)
  }

  /**
   * The permission and reasoning a member runs with.
   *
   * A member has no settings of its own: its assistant owns them, and this is
   * the single place that says so. Everything that used to keep its own copy —
   * activation, the running Agent, the stored record — reads it from here, so
   * the team can never drift from the assistant that describes it.
   */

  /**
   * Bring the members of every team back in line with an edited assistant.
   *
   * Members follow their assistant completely, so an edit has to reach the
   * records the next activation reads *and* the Agents already running. Draft
   * and archived teams have no runtime, so their records are all that changes.
   */

  /**
   * Bring every member of every team onto its assistant once, at startup.
   *
   * Members used to keep their own copy of the permission, so a team could sit
   * on a stale value indefinitely — visible in the team view and, worse, the
   * sandbox the member actually ran with. The composition is authoritative now,
   * and this closes the gap for teams bound before that.
   */

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

  // ── Teams and their membership ──────────────────────────────────────────
  // Each of these is `teams-service`'s; the service is the one place callers
  // reach, so it hands them on rather than making everybody import the module.

  getTeam(id: string): TeamAggregate {
    return teams.getTeam(this.teamDeps(), id)
  }

  listTeams(): Page<TeamAggregate> {
    return teams.listTeams(this.teamDeps())
  }

  async createTeamDraft(raw: CreateTeamDraftInput): Promise<TeamAggregate> {
    return await teams.createTeamDraft(this.teamDeps(), raw)
  }

  async cloneTeam(sourceTeamId: string, raw: CloneTeamInput): Promise<TeamAggregate> {
    return await teams.cloneTeam(this.teamDeps(), sourceTeamId, raw)
  }

  async changeLeader(
    teamId: string,
    successorSlotId: string,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    return await teams.changeLeader(this.teamDeps(), teamId, successorSlotId, options)
  }

  async addMember(
    teamId: string,
    raw: AddTeamMemberInput,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    return await teams.addMember(this.teamDeps(), teamId, raw, options)
  }

  async removeMember(
    teamId: string,
    slotId: string,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    return await teams.removeMember(this.teamDeps(), teamId, slotId, options)
  }

  async startTeam(teamId: string, options: MutationOptions = {}): Promise<TeamAggregate> {
    return await teams.startTeam(this.teamDeps(), teamId, options)
  }

  async dissolveTeam(
    teamId: string,
    confirmation: string,
    options: MutationOptions = {},
  ): Promise<void> {
    await teams.dissolveTeam(this.teamDeps(), teamId, confirmation, options)
  }

  async deleteTeamRecords(teamId: string): Promise<void> {
    await teams.deleteTeamRecords(this.teamDeps(), teamId)
  }

  async purgeTeamRecords(teamId: string): Promise<void> {
    await teams.purgeTeamRecords(this.teamDeps(), teamId)
  }

  /** What `teams-service` needs from this service, gathered in one place. */
  private teamDeps(): teams.TeamDeps {
    return {
      store: this.store,
      config: this.config,
      runtime: this.runtime,
      requireRuntime: () => this.requireRuntime(),
      workspace: this.workspace,
      activity: (kind, entityId, revision, summary) => this.activity(kind, entityId, revision, summary),
      publish: (entityType, entityId, revision, kind, conversation) => {
        this.publish(entityType, entityId, revision, kind, conversation)
      },
    }
  }

  async sendUserMessage(
    teamId: string,
    conversationId: string,
    content: string,
    targetSlotId?: string,
  ): Promise<TeamMessage> {
    return this.requireRuntime().sendUserMessage(teamId, content, conversationId, targetSlotId)
  }

  // ── Sessions, conversations and the room ────────────────────────────────
  // These belong to `conversations-service`; the service is where callers
  // reach them.

  getConversation(teamId: string, conversationId: string): TeamConversation {
    return conversations.getConversation(this.conversationDeps(), teamId, conversationId)
  }

  findConversationBySession(sessionId: string): TeamConversation | undefined {
    return conversations.findConversationBySession(this.conversationDeps(), sessionId)
  }

  listConversations(teamId: string): Page<TeamConversation> {
    return conversations.listConversations(this.conversationDeps(), teamId)
  }

  async createConversationRecord(
    teamId: string,
    input: {
      sessionId: string
      workspaceId: string
      workspacePath: string
      title?: string
    },
  ): Promise<TeamConversation> {
    return await conversations.createConversationRecord(this.conversationDeps(), teamId, input)
  }

  async deleteConversationRecord(teamId: string, conversationId: string): Promise<void> {
    await conversations.deleteConversationRecord(this.conversationDeps(), teamId, conversationId)
  }

  async assignMemberSessions(
    teamId: string,
    conversationId: string,
    additions: Record<string, string>,
  ): Promise<TeamConversation> {
    return await conversations.assignMemberSessions(this.conversationDeps(), teamId, conversationId, additions)
  }

  async forgetMemberSessions(teamId: string, slotId: string): Promise<void> {
    await conversations.forgetMemberSessions(this.conversationDeps(), teamId, slotId)
  }

  async bindSession(sessionId: string, teamId: string): Promise<TeamConversation> {
    return await conversations.bindSession(this.conversationDeps(), sessionId, teamId)
  }

  async unbindSession(sessionId: string): Promise<void> {
    await conversations.unbindSession(this.conversationDeps(), sessionId)
  }

  async setSessionDelegation(sessionId: string, delegate: boolean): Promise<TeamConversation> {
    return await conversations.setSessionDelegation(this.conversationDeps(), sessionId, delegate)
  }

  publishConversation(
    teamId: string,
    revision: number,
    conversation?: MemberConversationView,
  ): void {
    conversations.publishConversation(this.conversationDeps(), teamId, revision, conversation)
  }

  listMessages(teamId: string): Page<TeamMessage> {
    return conversations.listMessages(this.conversationDeps(), teamId)
  }

  async putRuntimeMessage(message: TeamMessage): Promise<void> {
    await conversations.putRuntimeMessage(this.conversationDeps(), message)
  }

  /** What conversation records need from this service. */
  private conversationDeps(): conversations.ConversationDeps {
    return {
      store: this.store,
      publish: (entityType, entityId, revision, kind, conversation) => {
        this.publish(entityType, entityId, revision, kind, conversation)
      },
      requireWorkspace: workspaceId => this.requireWorkspace(workspaceId),
      requireRuntime: () => this.requireRuntime(),
      now: () => new Date().toISOString(),
    }
  }

  private conversationDisplays(teamId: string): Map<string, conversations.ConversationDisplay> {
    return conversations.conversationDisplays(this.conversationDeps(), teamId)
  }

  private displayConversation(
    conversation: TeamConversation,
    displays: Map<string, conversations.ConversationDisplay>,
  ): TeamConversation {
    return conversations.displayConversation(this.conversationDeps(), conversation, displays)
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

  /**
   * Drop every stored record of a team without touching its Workspace. Used to
   * discard teams that predate conversation-scoped member Sessions.
   */

  getOperation(id: string): Operation {
    const operation = this.store.getOperation(id)
    if (operation === undefined) {
      throw new AgentTeamError('INVALID_REQUEST', `Unknown operation '${id}'`)
    }
    return operation
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

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function withReasoningEffort(
  member: TeamMemberSlot,
  reasoningEffort: string | undefined,
): TeamMemberSlot {
  const { reasoningEffort: _current, ...rest } = member
  return reasoningEffort === undefined ? rest : { ...rest, reasoningEffort }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}
