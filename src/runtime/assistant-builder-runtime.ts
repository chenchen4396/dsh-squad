import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assembleContextFor, type AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { Config } from '../config.js'
import { AssistantDraftStore } from './assistant-builder-drafts.js'
import { registerAssistantBuilderTools } from './assistant-builder-tools.js'
import * as assistantBuilderConfig from './assistant-builder-config.js'
import * as assistantBuilderSetup from './assistant-builder-setup.js'
import { AgentTeamError } from '../domain/errors.js'
import type { AgentTeamService } from '../service/agent-team-service.js'
import type {
  AssistantBuilderModelPreferenceStore,
  AssistantBuilderModelReference,
} from '../storage/assistant-builder-preferences.js'
import type {
  AssistantBuilderConversationListView,
  AssistantBuilderConversationSummary,
  AssistantBuilderConversationView,
  AssistantBuilderDraftView,
  InteractionResponseInput,
} from '../transport/contracts.js'
import { projectConversation } from './conversation-projector.js'
import { readStoredEvents } from './session-events.js'
import type { TeamInteractionBridge } from './team-interaction-bridge.js'

export const ASSISTANT_BUILDER_SESSION_ID = 'agent-team:assistant-builder'
const ASSISTANT_BUILDER_SESSION_PREFIX = `${ASSISTANT_BUILDER_SESSION_ID}:`
const ASSISTANT_BUILDER_DRAFT_ID = `${ASSISTANT_BUILDER_SESSION_PREFIX}draft`

export const ASSISTANT_BUILDER_PROMPT = `
你是“团队 Agent 小助手”，负责通过对话帮助用户创建可复用的 Agent 助手模板。

工作规则：
1. 先理解用户希望这个助手承担的职责、工作边界、输出方式和协作习惯。
2. 创建前必须收集名称、Provider、模型、Agent Preset、权限预设和长期提示词。说明按需要收集；可用 Skills 和 MCP Servers 由用户从真实目录中选择，都可以不选。
3. 必须先调用 assistant_builder_get_catalog 获取当前真实可选项；Provider、模型、Preset 和权限只能使用目录中存在的标识，不能编造。确定模型后，再携带 provider 和 model 调用一次目录工具读取该模型真实支持的思考模式；未返回思考能力时不得配置。确定 Agent Preset 后，再携带 agentPresetId 调用一次目录工具，取得该 Preset 可用的 Skills 和 MCP Servers。
4. 参数不完整或意图含糊时，优先调用 ask_user_question，一次询问一至三个最关键的问题，并给出基于真实目录的简短选项和建议。问题较开放、需要用户详细描述，或只是普通解释时，可以直接输出中文文本。
5. 长期提示词应描述稳定职责、约束、工作流程和验收要求，不要写入用户眼前的一次性任务。
6. 只保存用户明确选择的 Skills 和 MCP Servers；未选择就表示不使用，不能猜测名称。不要询问或限制普通工具，工具能力由 Agent Preset 提供。
7. 配置完整后调用 assistant_builder_prepare 校验并暂存草稿；此步骤不会创建助手，新草稿会替代旧草稿。
8. 用简洁清单复述最终配置，并询问用户是否确认创建。用户可以用自然语言表达同意，例如“确认”“可以”“就这样创建”“没问题，创建吧”，不要要求固定口令。必须等待新的用户消息，不得在同一轮代替用户确认。
9. 只有用户对当前最终配置明确表达同意后才能调用 assistant_builder_commit。若用户的回复含糊、否定创建、提出问题或要求修改配置，不得提交；应先回答或修改草稿，再次展示最终配置并征求确认。
10. 创建成功后明确告知助手名称，并提示它现在可以加入团队。
11. 你只能帮助设计和创建助手模板，不创建团队、不修改或删除已有助手，也不执行 Workspace 任务。

保持中文、简洁、主动，但不要替用户猜测会显著影响成本、权限或能力范围的参数。
`.trim()

export class AssistantBuilderRuntime {
  private handle: AgentHandle | undefined
  private starting: Promise<AgentHandle> | undefined
  private reconfiguring: Promise<void> | undefined
  private switching: Promise<void> | undefined
  private activeSessionId: string | undefined
  private configuration: assistantBuilderConfig.BuilderConfiguration | undefined
  private readonly configurations = new Map<string, assistantBuilderConfig.BuilderConfiguration>()
  private readonly drafts = new AssistantDraftStore()
  private publishTimer: ReturnType<typeof setTimeout> | undefined
  private readonly disposeStatusListener: () => void
  private readonly disposeConversationListener: () => void
  private readonly disposeInteractionScope: () => void
  private closing = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly service: AgentTeamService,
    private readonly modelPreferences: AssistantBuilderModelPreferenceStore,
    private readonly interactions: TeamInteractionBridge,
  ) {
    this.disposeInteractionScope = interactions.registerScope({
      acceptsSession: isAssistantBuilderSessionId,
      onChange: sessionId => {
        if (sessionId === this.activeSessionId) this.publishCurrent()
      },
    })
    this.disposeStatusListener = ctx.on('agent/status', ({ agent }) => {
      if (String(agent.id) !== this.activeSessionId || this.closing) return
      this.publishCurrent()
    })
    this.disposeConversationListener = ctx.on('session/event', session => {
      if (String(session.id) !== this.activeSessionId || this.closing || this.publishTimer !== undefined) return
      this.publishTimer = setTimeout(() => {
        this.publishTimer = undefined
        this.publishCurrent()
      }, 48)
    })
  }

  async listConversations(): Promise<AssistantBuilderConversationListView> {
    const snapshots = (await this.ctx.sessionPersistence.list())
      .filter(snapshot => (
        isAssistantBuilderSessionId(String(snapshot.header.id))
        && !this.isConversationArchived(String(snapshot.header.id))
      ))
    const active = this.handle?.agent.session
    const headers = new Map(snapshots.map(snapshot => [String(snapshot.header.id), snapshot.header]))
    if (
      active !== undefined
      && isAssistantBuilderSessionId(String(active.id))
      && !this.isConversationArchived(String(active.id))
    ) {
      headers.set(String(active.id), active.header)
    }
    const summaries = await Promise.all([...headers.entries()].map(async ([sessionId, header]) => {
      const events = active !== undefined && String(active.id) === sessionId
        ? active.snapshotEvents()
        : await readStoredEvents(this.ctx, sessionId)
      return summarizeConversation(sessionId, header.createdAt, events)
    }))
    const items = summaries.filter(item => item.state !== 'new')
    items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt))
    return { items, total: items.length }
  }

  async getDraft(): Promise<AssistantBuilderDraftView> {
    return {
      schemaVersion: 1,
      configuration: await this.resolveConfiguration(ASSISTANT_BUILDER_DRAFT_ID),
    }
  }

  async configureDraft(rawProvider: string, rawModel: string): Promise<AssistantBuilderDraftView> {
    const provider = rawProvider.trim()
    const model = rawModel.trim()
    await this.validateModelReference(provider, model)
    await this.modelPreferences.setLastSelectedModel(provider, model)
    const configuration = await this.resolveConfiguration(ASSISTANT_BUILDER_DRAFT_ID)
    return { schemaVersion: 1, configuration: { ...configuration, provider, model } }
  }

  async startConversation(
    rawProvider: string,
    rawModel: string,
    rawContent: string,
  ): Promise<AssistantBuilderConversationView> {
    const provider = rawProvider.trim()
    const model = rawModel.trim()
    const content = rawContent.trim()
    if (content.length === 0) throw new AgentTeamError('INVALID_REQUEST', 'Message content is required')
    await this.validateModelReference(provider, model)
    const base = await this.resolveConfiguration(ASSISTANT_BUILDER_DRAFT_ID)
    const sessionId = `${ASSISTANT_BUILDER_SESSION_PREFIX}${randomUUID()}`
    const configuration = { ...base, provider, model }
    this.configurations.set(sessionId, configuration)
    await this.modelPreferences.setSelectedModel(sessionId, provider, model)
    const handle = await this.ensureOnline(sessionId, true)
    const message = createUserMessage({
      content: [{ type: 'text', text: content }],
      source: { kind: 'user' },
    })
    handle.agent.followup(message)
    return this.project(sessionId, handle.agent.session.snapshotEvents(), handle.agent.status)
  }

  async getConversation(rawSessionId: string): Promise<AssistantBuilderConversationView> {
    const sessionId = await this.requireExistingSessionId(rawSessionId)
    const handle = await this.ensureOnline(sessionId)
    return this.project(sessionId, handle.agent.session.snapshotEvents(), handle.agent.status)
  }

  async sendMessage(sessionId: string, rawContent: string): Promise<{ messageId: string }> {
    const content = rawContent.trim()
    if (content.length === 0) throw new AgentTeamError('INVALID_REQUEST', 'Message content is required')
    const handle = await this.ensureOnline(await this.requireExistingSessionId(sessionId))
    const message = createUserMessage({
      content: [{ type: 'text', text: content }],
      source: { kind: 'user' },
    })
    handle.agent.followup(message)
    return { messageId: String(message.id) }
  }

  async configure(sessionId: string, rawProvider: string, rawModel: string): Promise<AssistantBuilderConversationView> {
    if (this.closing) throw new Error('Assistant Builder runtime is closing')
    if (this.reconfiguring !== undefined) await this.reconfiguring
    const provider = rawProvider.trim()
    const model = rawModel.trim()
    if (provider.length === 0 || model.length === 0) {
      throw new AgentTeamError('INVALID_REQUEST', 'Assistant Builder provider and model are required')
    }
    const targetSessionId = await this.requireExistingSessionId(sessionId)
    const reconfiguring = this.reconfigure(targetSessionId, provider, model)
    this.reconfiguring = reconfiguring
    try {
      await reconfiguring
    } finally {
      if (this.reconfiguring === reconfiguring) this.reconfiguring = undefined
    }
    return this.getConversation(targetSessionId)
  }

  async stop(sessionId: string): Promise<void> {
    const handle = await this.ensureOnline(await this.requireExistingSessionId(sessionId))
    handle.agent.cancel({ kind: 'user' }, { keepInbox: false })
    await handle.agent.whenIdle()
    this.publishCurrent()
  }

  async respondToInteraction(
    rawSessionId: string,
    interactionId: string,
    response: InteractionResponseInput,
  ): Promise<void> {
    const sessionId = await this.requireExistingSessionId(rawSessionId)
    await this.ensureOnline(sessionId)
    if (this.activeSessionId !== sessionId) {
      throw new AgentTeamError('INTERACTION_NOT_FOUND', '该交互请求不属于当前团队 Agent 小助手会话')
    }
    await this.interactions.respond(sessionId, interactionId, response)
  }

  async archiveConversation(rawSessionId: string): Promise<void> {
    if (this.closing) throw new Error('Assistant Builder runtime is closing')
    await this.reconfiguring?.catch(() => undefined)
    await this.switching?.catch(() => undefined)
    await this.starting?.catch(() => undefined)
    const sessionId = rawSessionId.trim()
    if (!isAssistantBuilderSessionId(sessionId)) {
      throw new AgentTeamError('INVALID_REQUEST', `Invalid Assistant Builder conversation '${sessionId}'`)
    }
    if (this.isConversationArchived(sessionId)) return
    const current = sessionId === this.activeSessionId ? this.handle : undefined
    if (current?.agent.status === 'running') {
      throw new AgentTeamError('INVALID_REQUEST', '请先停止团队 Agent 小助手当前回复，再归档会话')
    }
    await this.ctx.workspaceRegistry.archiveSession(SessionId(sessionId))
    if (current !== undefined) {
      await this.ctx.sessions.flush(current.agent.session)
      await current.dispose()
      if (this.handle === current) this.handle = undefined
      this.activeSessionId = undefined
      this.configuration = undefined
    }
    this.configurations.delete(sessionId)
    this.drafts.clear(sessionId)
  }

  async dispose(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.disposeStatusListener()
    this.disposeConversationListener()
    this.disposeInteractionScope()
    if (this.publishTimer !== undefined) clearTimeout(this.publishTimer)
    this.publishTimer = undefined
    await this.reconfiguring?.catch(() => undefined)
    await this.switching?.catch(() => undefined)
    await this.starting?.catch(() => undefined)
    const handle = this.handle
    if (handle === undefined) return
    handle.agent.cancel({ kind: 'disposed' }, { keepInbox: true })
    await handle.agent.whenIdle().catch(() => undefined)
    try {
      await this.ctx.sessions.flush(handle.agent.session)
    } catch (error) {
      this.ctx.logger.warn('agent-team: assistant builder session flush failed', error)
    }
    await handle.dispose()
    this.handle = undefined
  }

  private async ensureOnline(sessionId: string, allowCreate = false): Promise<AgentHandle> {
    if (this.closing) throw new Error('Assistant Builder runtime is closing')
    if (this.reconfiguring !== undefined) await this.reconfiguring
    await this.activate(sessionId)
    if (this.handle !== undefined && this.activeSessionId === sessionId) return this.handle
    if (this.starting !== undefined) return this.starting
    const starting = this.start(sessionId, allowCreate)
    this.starting = starting
    try {
      const handle = await starting
      this.handle = handle
      return handle
    } catch (error) {
      if (error instanceof AgentTeamError) throw error
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`agent-team: assistant builder activation failed: ${message}`, error)
      throw new AgentTeamError(
        'SESSION_CREATE_FAILED',
        `团队 Agent 小助手启动失败：${message}`,
        { cause: message },
        { cause: error },
      )
    } finally {
      if (this.starting === starting) this.starting = undefined
    }
  }

  private async activate(sessionId: string): Promise<void> {
    if (this.activeSessionId === sessionId) return
    if (this.switching !== undefined) await this.switching
    if (this.activeSessionId === sessionId) return
    const switching = this.switchSession(sessionId)
    this.switching = switching
    try {
      await switching
    } finally {
      if (this.switching === switching) this.switching = undefined
    }
  }

  private async switchSession(sessionId: string): Promise<void> {
    await this.starting?.catch(() => undefined)
    const current = this.handle
    if (current?.agent.status === 'running') {
      throw new AgentTeamError('INVALID_REQUEST', '请先停止当前小助手回复，再切换会话')
    }
    if (current !== undefined) {
      await this.ctx.sessions.flush(current.agent.session)
      await current.dispose()
    }
    this.handle = undefined
    this.configuration = this.configurations.get(sessionId)
    this.activeSessionId = sessionId
  }

  private async reconfigure(sessionId: string, provider: string, model: string): Promise<void> {
    await this.validateModelReference(provider, model)
    await this.activate(sessionId)
    await this.starting?.catch(() => undefined)
    const current = this.handle
    if (current !== undefined && current.agent.status === 'running') {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        '请先停止团队 Agent 小助手当前回复，再切换模型',
      )
    }
    if (
      this.configuration?.provider === provider
      && this.configuration.model === model
    ) return

    await this.modelPreferences.setSelectedModel(sessionId, provider, model)

    if (current !== undefined) {
      await this.ctx.sessions.flush(current.agent.session)
      await current.dispose()
      if (this.handle === current) this.handle = undefined
    }
    const currentConfiguration = this.configuration ?? await this.resolveConfiguration(sessionId)
    const nextConfiguration = { ...currentConfiguration, provider, model }
    this.configurations.set(sessionId, nextConfiguration)
    this.configuration = nextConfiguration
  }

  /** What the builder's Agent setup needs from this runtime. */
  private setupDeps(): assistantBuilderSetup.BuilderSetupDeps {
    return {
      ctx: this.ctx,
      service: this.service,
      drafts: this.drafts,
      interactions: this.interactions,
      assertToolIdentity: (id, sessionId) => this.assertToolIdentity(id, sessionId),
    }
  }

  private async start(rawSessionId: string, allowCreate: boolean): Promise<AgentHandle> {
    const sessionId = SessionId(rawSessionId)
    const cwd = process.cwd()
    if (this.ctx.agents.get(sessionId) !== undefined) {
      throw new AgentTeamError(
        'AGENT_HANDLE_OWNERSHIP_CONFLICT',
        `Session '${rawSessionId}' is live without this plugin's AgentHandle`,
      )
    }
    const configuration = this.configurations.get(rawSessionId) ?? await this.resolveConfiguration(rawSessionId)
    this.configurations.set(rawSessionId, configuration)
    this.configuration = configuration
    const rememberedModel = this.modelPreferences.getConversationModel(rawSessionId)
    if (
      rememberedModel?.provider !== configuration.provider
      || rememberedModel.model !== configuration.model
    ) {
      await this.modelPreferences.setConversationModel(
        rawSessionId,
        configuration.provider,
        configuration.model,
      )
    }
    const setup = assistantBuilderSetup.assistantBuilderSetup(this.setupDeps(), {
      sessionId: rawSessionId,
      configuration,
      cwd,
    })
    const agentOptions = { provider: configuration.provider, model: configuration.model }
    const persisted = (await this.ctx.sessionPersistence.list())
      .some(snapshot => String(snapshot.header.id) === rawSessionId)
    if (!persisted && !allowCreate) {
      throw new AgentTeamError('INVALID_REQUEST', `Unknown Assistant Builder conversation '${rawSessionId}'`)
    }
    return persisted
      ? this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
      : this.ctx.agents.create({
        sessionId,
        meta: { cwd, agentPreset: configuration.agentPresetId },
        agentOptions,
        setup,
      })
  }



  /** What resolving the builder's configuration needs from this runtime. */
  private configDeps(): assistantBuilderConfig.BuilderConfigDeps {
    return {
      ctx: this.ctx,
      config: this.config,
      modelPreferences: this.modelPreferences,
      configurations: this.configurations,
    }
  }

  private async resolveConfiguration(
    sessionId: string,
  ): Promise<assistantBuilderConfig.BuilderConfiguration> {
    return await assistantBuilderConfig.resolveConfiguration(this.configDeps(), sessionId)
  }

  private async validateModelReference(provider: string, model: string): Promise<void> {
    if (provider.length === 0 || model.length === 0) {
      throw new AgentTeamError('INVALID_REQUEST', 'Assistant Builder provider and model are required')
    }
    try {
      await this.ctx.llm.resolveModelInfo(provider, model)
    } catch (error) {
      throw new AgentTeamError(
        'MODEL_REFERENCE_INVALID',
        `Cannot resolve Assistant Builder model '${provider}/${model}'`,
        undefined,
        { cause: error },
      )
    }
  }

  private async requireExistingSessionId(rawSessionId: string): Promise<string> {
    const sessionId = rawSessionId.trim()
    if (!isAssistantBuilderSessionId(sessionId)) {
      throw new AgentTeamError('INVALID_REQUEST', `Invalid Assistant Builder conversation '${sessionId}'`)
    }
    if (this.isConversationArchived(sessionId)) {
      throw new AgentTeamError('INVALID_REQUEST', `Unknown Assistant Builder conversation '${sessionId}'`)
    }
    if (sessionId === this.activeSessionId) return sessionId
    const exists = (await this.ctx.sessionPersistence.list())
      .some(snapshot => String(snapshot.header.id) === sessionId)
    if (!exists) {
      throw new AgentTeamError('INVALID_REQUEST', `Unknown Assistant Builder conversation '${sessionId}'`)
    }
    return sessionId
  }

  private isConversationArchived(sessionId: string): boolean {
    return this.ctx.workspaceRegistry.archivedSessionIds
      .some(archivedSessionId => String(archivedSessionId) === sessionId)
  }


  private assertToolIdentity(id: unknown, sessionId: string): void {
    if (String(id) !== sessionId || !isAssistantBuilderSessionId(sessionId)) {
      throw new AgentTeamError('INVALID_REQUEST', 'Assistant Builder tool called outside its owned Agent')
    }
  }

  private project(
    sessionId: string,
    events: readonly SessionEvent[],
    status: 'idle' | 'running',
  ): AssistantBuilderConversationView {
    if (this.configuration === undefined) throw new Error('Assistant Builder configuration is unavailable')
    return {
      schemaVersion: 1,
      sessionId,
      status,
      pendingInteractions: this.interactions.list(sessionId),
      ...projectConversation(events),
      configuration: this.configuration,
    }
  }

  private publishCurrent(): void {
    const handle = this.handle
    const sessionId = this.activeSessionId
    if (handle === undefined || sessionId === undefined || this.configuration === undefined || this.closing) return
    this.service.publishAssistantBuilderConversation(
      this.project(sessionId, handle.agent.session.snapshotEvents(), handle.agent.status),
    )
  }
}


function isAssistantBuilderSessionId(sessionId: string): boolean {
  return sessionId === ASSISTANT_BUILDER_SESSION_ID
    || sessionId.startsWith(ASSISTANT_BUILDER_SESSION_PREFIX)
}

function summarizeConversation(
  sessionId: string,
  createdAt: number,
  events: readonly SessionEvent[],
): AssistantBuilderConversationSummary {
  const projection = projectConversation(events, Number.MAX_SAFE_INTEGER)
  const firstUser = projection.nodes.find(node => node.kind === 'user')
  const lastUserSeq = projection.nodes.reduce((latest, node) => (
    node.kind === 'user' ? Math.max(latest, node.seq) : latest
  ), -1)
  const lastCommitSeq = projection.nodes.reduce((latest, node) => (
    node.kind === 'tool'
    && node.name === 'assistant_builder_commit'
    && node.status === 'success'
      ? Math.max(latest, node.seq)
      : latest
  ), -1)
  const lastEventAt = events.at(-1)?.time ?? createdAt
  return {
    sessionId,
    title: firstUser?.kind === 'user' ? conversationTitle(firstUser.text) : '新对话',
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(lastEventAt).toISOString(),
    state: lastUserSeq < 0
      ? 'new'
      : lastCommitSeq >= lastUserSeq
        ? 'completed'
        : 'in_progress',
  }
}

function conversationTitle(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= 28 ? compact : `${compact.slice(0, 28)}…`
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}
