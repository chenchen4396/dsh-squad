import { Context } from '@deepseek-ai/cordis'
import { fallbackSessionTitle } from '@deepseek-ai/dsh-session-title'
import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../src/config.js'
import { AgentTeamError } from '../src/domain/errors.js'
import type {
  AssistantTemplate,
  Operation,
  RuleDocument,
  TeamActivity,
  TeamAggregate,
  TeamConversation,
  TeamMessage,
} from '../src/domain/types.js'
import { AgentTeamService } from '../src/service/agent-team-service.js'
import type { AgentTeamStore } from '../src/storage/store.js'
import { LEADER_ANSWER_TIMEOUT_MS } from '../src/runtime/team-interaction-bridge.js'
import { TeamRuntime } from '../src/runtime/team-runtime.js'
import type { TeamCommandHandler } from '../src/runtime/team-command-handler.js'
import type { TeamMessageDispatcher } from '../src/runtime/team-message-dispatcher.js'
import { ASSISTANT_BUILDER_PROMPT } from '../src/runtime/assistant-builder-runtime.js'
import { conversationWorkspace } from '../src/domain/team-selectors.js'

const config: Config = {
  maxRequestBytes: 128 * 1024,
  sseHeartbeatMs: 20_000,
  runtimeConcurrency: 4,
  directMemberChatDefault: true,
  assistantBuilderProvider: '',
  assistantBuilderModel: '',
  assistantBuilderAgentPresetId: '',
  assistantBuilderPermissionPresetId: '',
}

describe('AgentTeamService', () => {
  it('announces model directory changes so open selectors refresh', () => {
    const { ctx, service } = createHarness()
    const listener = vi.fn()
    service.subscribe(listener)

    ctx.emit('llm/adapters-updated')

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      entityType: 'catalog',
      entityId: 'models',
      kind: 'catalog.models_updated',
    }))
  })

  it('reuses identical uploads and only renames same-name files with different content', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'agent-team-upload-'))
    try {
      const { service } = createHarness(workspacePath)
      const assistant = await service.createAssistant(assistantInput())
      const team = await service.createTeamDraft({
        name: 'Upload team',
        
        directMemberChat: true,
        members: [{ assistantId: assistant.id, role: 'leader' }],
      })
      const bytes = new TextEncoder().encode('hello')
      const changedBytes = new TextEncoder().encode('changed')

      const conversation = await service.createConversationRecord(team.id, {
        sessionId: 'session-upload',
        workspaceId: 'workspace-1',
        workspacePath,
      })
      const first = await service.uploadWorkspaceFile(team.id, conversation.id, '../notes.txt', bytes)
      const duplicate = await service.uploadWorkspaceFile(team.id, conversation.id, '../notes.txt', bytes)
      const changed = await service.uploadWorkspaceFile(team.id, conversation.id, '../notes.txt', changedBytes)
      const changedDuplicate = await service.uploadWorkspaceFile(team.id, conversation.id, '../notes.txt', changedBytes)

      expect(first).toEqual({ name: 'notes.txt', path: '.agent-team/uploads/notes.txt', bytes: 5 })
      expect(duplicate).toEqual(first)
      expect(changed).toEqual({ name: 'notes (1).txt', path: '.agent-team/uploads/notes (1).txt', bytes: 7 })
      expect(changedDuplicate).toEqual(changed)
      await expect(readFile(join(workspacePath, first.path), 'utf8')).resolves.toBe('hello')
      await expect(readFile(join(workspacePath, changed.path), 'utf8')).resolves.toBe('changed')
    } finally {
      await rm(workspacePath, { recursive: true, force: true })
    }
  })

  it('answers a catalog read without waiting for the provider model lists', async () => {
    const { service } = createHarness()

    // The first read answers with what is already local; the model lists and
    // the preset walk arrive behind it.
    const first = await service.catalog()
    expect(first.providers.length).toBeGreaterThan(0)
    expect(first.models).toEqual({})
    expect(first.agentPresets).toEqual([])

    const settled = await vi.waitFor(async () => {
      const next = await service.catalog()
      expect(next.models.openai).toHaveLength(1)
      expect(next.agentPresets.map(preset => preset.id)).toEqual(['default'])
      return next
    })
    // A later read is served from the cache, not rebuilt per caller.
    expect(await service.catalog()).toBe(settled)
  })

  it('lists the earliest created assistants first', async () => {
    const { service, store } = createHarness()
    const base = {
      schemaVersion: 1 as const,
      description: undefined,
      icon: undefined,
      instructions: 'Coordinate the team.',
      provider: 'openai',
      model: 'codex',
      agentPresetId: 'default',
      permissionPresetId: 'standard',
      skillAllowlist: [],
      mcpServers: [],
      ruleDocumentAllowlist: [],
      revision: 1,
    }
    await store.putAssistant({
      ...base,
      id: 'older-assistant',
      name: 'Older assistant',
      createdAt: '2026-08-17T08:00:00.000Z',
      updatedAt: '2026-08-17T08:00:00.000Z',
    })
    await store.putAssistant({
      ...base,
      id: 'newer-assistant',
      name: 'Newer assistant',
      createdAt: '2026-08-18T08:00:00.000Z',
      updatedAt: '2026-08-18T08:00:00.000Z',
    })

    expect(service.listAssistants().items.map(assistant => assistant.id)).toEqual([
      'older-assistant',
      'newer-assistant',
    ])
  })

  it('delegates the built-in assistant builder conversation without storing it as a template', async () => {
    const { service, store } = createHarness()
    const conversation = {
      schemaVersion: 1 as const,
      sessionId: 'agent-team:assistant-builder',
      status: 'idle' as const,
      throughSeq: -1,
      nodes: [],
      pendingInteractions: [],
      configuration: {
        provider: 'test-provider',
        model: 'test-model',
        agentPresetId: 'standard',
        permissionPresetId: 'workspace-write',
      },
    }
    const draft = {
      schemaVersion: 1 as const,
      configuration: conversation.configuration,
    }
    const builder = {
      listConversations: vi.fn(async () => ({ items: [], total: 0 })),
      getDraft: vi.fn(async () => draft),
      configureDraft: vi.fn(async () => ({
        ...draft,
        configuration: {
          ...draft.configuration,
          provider: 'another-provider',
          model: 'another-model',
        },
      })),
      startConversation: vi.fn(async () => conversation),
      getConversation: vi.fn(async () => conversation),
      configure: vi.fn(async () => ({
        ...conversation,
        configuration: {
          ...conversation.configuration,
          provider: 'another-provider',
          model: 'another-model',
        },
      })),
      sendMessage: vi.fn(async () => ({ messageId: 'message-1' })),
      respondToInteraction: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      archiveConversation: vi.fn(async () => {}),
    }
    service.attachAssistantBuilderRuntime(builder as never)

    await expect(service.listAssistantBuilderConversations()).resolves.toEqual({ items: [], total: 0 })
    await expect(service.getAssistantBuilderDraft()).resolves.toEqual(draft)
    await expect(service.configureAssistantBuilderDraft('another-provider', 'another-model')).resolves.toMatchObject({
      configuration: { provider: 'another-provider', model: 'another-model' },
    })
    await expect(service.startAssistantBuilderConversation(
      'test-provider',
      'test-model',
      'Create a reviewer',
    )).resolves.toEqual(conversation)
    await expect(service.getAssistantBuilderConversation(conversation.sessionId)).resolves.toEqual(conversation)
    await expect(service.configureAssistantBuilder(conversation.sessionId, 'another-provider', 'another-model')).resolves.toMatchObject({
      configuration: { provider: 'another-provider', model: 'another-model' },
    })
    await expect(service.sendAssistantBuilderMessage(conversation.sessionId, 'Create a reviewer')).resolves.toEqual({ messageId: 'message-1' })
    await service.respondToAssistantBuilderInteraction(conversation.sessionId, 'question:1', {
      kind: 'question',
      answers: [{ id: 'name', selected: ['Reviewer'] }],
    })
    await service.stopAssistantBuilder(conversation.sessionId)
    await service.archiveAssistantBuilderConversation(conversation.sessionId)

    expect(builder.sendMessage).toHaveBeenCalledWith(conversation.sessionId, 'Create a reviewer')
    expect(builder.respondToInteraction).toHaveBeenCalledWith(
      conversation.sessionId,
      'question:1',
      { kind: 'question', answers: [{ id: 'name', selected: ['Reviewer'] }] },
    )
    expect(builder.startConversation).toHaveBeenCalledWith('test-provider', 'test-model', 'Create a reviewer')
    expect(builder.configureDraft).toHaveBeenCalledWith('another-provider', 'another-model')
    expect(builder.configure).toHaveBeenCalledWith(conversation.sessionId, 'another-provider', 'another-model')
    expect(builder.stop).toHaveBeenCalledWith(conversation.sessionId)
    expect(builder.archiveConversation).toHaveBeenCalledWith(conversation.sessionId)
    expect(store.listAssistants()).toHaveLength(0)
    expect(ASSISTANT_BUILDER_PROMPT).toContain('assistant_builder_get_catalog')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('assistant_builder_prepare')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('assistant_builder_commit')
    expect(ASSISTANT_BUILDER_PROMPT).not.toContain('assistant_builder_create')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('必须等待新的用户消息')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('不要要求固定口令')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('明确表达同意')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('不要询问或限制普通工具')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('MCP Servers')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('优先调用 ask_user_question')
  })

  it('lists model- or user-invocable Skills with their invocation policy', async () => {
    const { service } = createHarness()

    await expect(service.skillCatalog('default')).resolves.toEqual({
      agentPresetId: 'default',
      skills: [{
        name: 'code-review',
        description: 'Review code changes.',
        source: 'user-agents',
        modelInvocable: true,
        userInvocable: true,
      }, {
        name: 'manual-only',
        description: 'Only users may invoke this.',
        source: 'user-agents',
        modelInvocable: false,
        userInvocable: true,
      }],
    })
  })

  it('groups MCP tools by Server for the chosen Agent Preset', async () => {
    const { service } = createHarness()

    await expect(service.mcpCatalog('default')).resolves.toEqual({
      agentPresetId: 'default',
      servers: [
        {
          name: 'figma',
          tools: [{ name: 'mcp__figma__inspect', description: 'Inspect a Figma node.' }],
        },
        {
          name: 'github',
          tools: [
            { name: 'mcp__github__create_issue', description: 'Create an issue.' },
            { name: 'mcp__github__list_issues', description: 'List issues.' },
          ],
        },
      ],
    })
  })

  it('localizes built-in permission preset names while preserving their ids', async () => {
    const { service } = createHarness()

    await expect(service.catalog()).resolves.toMatchObject({
      permissionPresets: [
        { value: 'standard', name: '标准' },
        { value: 'read-only', name: '只读' },
        { value: 'workspace-write', name: '工作区可写' },
        { value: 'danger-full-access', name: '完全访问' },
      ],
    })
  })

  it('reads and validates exact-model reasoning efforts without hard-coded ids', async () => {
    const { service } = createHarness()

    await expect(service.modelCapabilities('openai', 'codex')).resolves.toEqual({
      provider: 'openai',
      model: 'codex',
      reasoning: {
        efforts: [
          { id: 'low', name: 'Low', description: 'Faster reasoning.' },
          { id: 'high', name: 'High' },
        ],
        defaultEffort: 'low',
      },
    })

    const assistant = await service.createAssistant({
      ...assistantInput(),
      reasoningEffort: 'high',
    })
    const team = await service.createTeamDraft({
      name: 'Reasoning Team',
      
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    const member = team.members[team.leaderSlotId]!

    expect(assistant.reasoningEffort).toBe('high')
    expect(member.reasoningEffort).toBe('high')
    expect(service.assistantForMember(member).reasoningEffort).toBe('high')
    await expect(service.createAssistant({
      ...assistantInput(),
      reasoningEffort: 'invented',
    })).rejects.toMatchObject({ code: 'MODEL_REFERENCE_INVALID' })
  })

  it('names the member when its provider is missing instead of failing inside the adapter', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant({
      ...assistantInput(),
      provider: 'opencode-go',
      model: 'kimi-k3',
    })
    const draft = await service.createTeamDraft({
      name: 'Stale Provider Team',
      
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = team.members[team.leaderSlotId]!
    const runtime = new TeamRuntime(ctx, config, service)

    // The raw Harness failure is `no adapter registered for provider "opencode-go"`,
    // which names neither the member nor the assistant to fix.
    await expect(runtimeInternals(runtime).assertModelAvailable(member, 'opencode-go', 'kimi-k3'))
      .rejects.toMatchObject({ code: 'MODEL_REFERENCE_INVALID' })
    await expect(runtimeInternals(runtime).assertModelAvailable(member, 'opencode-go', 'kimi-k3'))
      .rejects.toThrow(/opencode-go/)
    await expect(runtimeInternals(runtime).assertModelAvailable(member, 'opencode-go', 'kimi-k3'))
      .rejects.toThrow(/openai/)

    // A registered provider and resolvable model pass.
    await expect(runtimeInternals(runtime).assertModelAvailable(member, 'openai', 'codex'))
      .resolves.toBeUndefined()
  })

  it('moves members onto an edited assistant model without restarting them', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Live Model Team',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = Object.values(team.members).find(value => value.role === 'member')!
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const owned = await ownMember(service, runtime, team.id, member.id)
    const entry = runtimeInternals(runtime).owned.get(owned.sessionId) as {
      modelSelection: { current?: { provider: string; model: string } }
    }

    await service.updateAssistant(assistant.id, { model: 'codex-2' })

    expect(entry.modelSelection.current).toMatchObject({ provider: 'openai', model: 'codex-2' })
  })

  it('gives a member the reasoning effort its assistant describes', async () => {
    const { service } = createHarness()
    const assistant = await service.createAssistant({
      ...assistantInput(),
      reasoningEffort: 'low',
    })
    const team = await service.createTeamDraft({
      name: 'Reasoning Team',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    const member = team.members[team.leaderSlotId]!
    expect(member.reasoningEffort).toBe('low')

    // A member holds no reasoning of its own: the assistant owns it.
    await service.updateAssistant(assistant.id, { reasoningEffort: 'high' })
    expect(service.getTeam(team.id).members[member.id]?.reasoningEffort).toBe('high')
  })

  it('validates an assistant draft without storing it', async () => {
    const { service, store } = createHarness()

    await expect(service.validateAssistantDraft({
      ...assistantInput(),
      name: '  Codex Lead  ',
    })).resolves.toMatchObject({ name: 'Codex Lead' })

    expect(store.listAssistants()).toHaveLength(0)
  })

  it('creates a multi-member draft and dissolves only the team', async () => {
    const { service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const team = await service.createTeamDraft({
      name: 'Compiler Team',
      
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })

    expect(Object.values(team.members)).toHaveLength(2)
    expect(Object.values(team.members).map(member => member.displayName)).toEqual(['Codex Lead', 'Codex Lead'])
    expect(new Set(Object.values(team.members).map(member => member.id)).size).toBe(2)
    expect(() => service.getAssistant(assistant.id)).not.toThrow()

    await expect(service.dissolveTeam(team.id, 'wrong')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await service.dissolveTeam(team.id, team.name)

    expect(store.getTeam(team.id)).toBeUndefined()
    expect(store.listMessages(team.id)).toHaveLength(0)
    expect(store.listActivities(team.id)).toHaveLength(0)
    expect(service.getAssistant(assistant.id).name).toBe('Codex Lead')
  })

  it('clones team configuration into fresh members and sessions without runtime records', async () => {
    const { service, store } = createHarness()
    const assistant = await service.createAssistant({
      ...assistantInput(),
      reasoningEffort: 'low',
      skillAllowlist: ['code-review'],
      mcpServers: ['github'],
    })
    const draft = await service.createTeamDraft({
      name: 'Source Team',
      
      directMemberChat: false,
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    const memberId = Object.values(draft.members).find(member => member.role === 'member')!.id
    const source = await store.updateTeam(draft.id, team => ({
      ...team,
      tasks: {
        'task-1': {
          id: 'task-1',
          title: 'Existing work',
          description: 'Do not copy this task.',
          status: 'running',
          ownerSlotId: memberId,
          ownerSlotIds: [memberId],
          dependencyIds: [],
          fileScopes: [],
          revision: 1,
          createdAt: team.createdAt,
          updatedAt: team.updatedAt,
        },
      },
    }))
    await service.updateAssistant(assistant.id, { instructions: 'Updated after team creation.' })

    const clone = await service.cloneTeam(source.id, { name: 'Copied Team' })
    const sourceMembers = Object.values(source.members)
    const clonedMembers = Object.values(clone.members)

    expect(clone).toMatchObject({
      name: 'Copied Team',
      state: 'draft',
      directMemberChat: false,
      revision: 1,
      tasks: {},
      leases: {},
      outbox: {},
      retiredSessions: {},
    })
    expect(clone.id).not.toBe(source.id)
    expect(clonedMembers.map(member => member.displayName)).toEqual(sourceMembers.map(member => member.displayName))
    expect(clonedMembers.map(member => member.role)).toEqual(sourceMembers.map(member => member.role))
    expect(clonedMembers.map(member => member.permissionPresetId)).toEqual(sourceMembers.map(member => member.permissionPresetId))
    // Members inherit their assistant live, so the clone follows the template as
    // it is now — not the copy that existed when the source team was created.
    // Cloning used to carry that stale copy forward.
    expect(clonedMembers.every(member => member.assistantId === assistant.id)).toBe(true)
    expect(clonedMembers.every(member => member.assistantSnapshot === undefined)).toBe(true)
    expect(clonedMembers.every(member => service.assistantForMember(member).instructions === 'Updated after team creation.')).toBe(true)
    expect(clonedMembers.every(member => service.assistantForMember(member).skillAllowlist[0] === 'code-review')).toBe(true)
    expect(clonedMembers.every(member => service.assistantForMember(member).mcpServers[0] === 'github')).toBe(true)
    expect(new Set(clonedMembers.map(member => member.id)).size).toBe(clonedMembers.length)
    // Members carry no Session id any more: conversations own member Sessions,
    // so a clone starts with none and materializes them on activation.
    expect(clonedMembers.every(member => member.sessionId === undefined)).toBe(true)
    expect(clonedMembers.every(member => !sourceMembers.some(sourceMember => sourceMember.id === member.id))).toBe(true)
    expect(clone.members[clone.leaderSlotId]?.role).toBe('leader')
    expect(service.getTeam(source.id).tasks['task-1']).toBeDefined()
  })

  it('rejects binding a Session in an unavailable Workspace', async () => {
    const { service } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const source = await service.createTeamDraft({
      name: 'Source Team',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })

    // The bound Session names the workspace, so an unusable one is refused
    // when the conversation record is created.
    await expect(service.createConversationRecord(source.id, {
      sessionId: 'session-1',
      workspaceId: 'missing-workspace',
      workspacePath: '/tmp/agent-team-workspace',
    })).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' })
    expect(service.listConversations(source.id).items).toHaveLength(0)
  })

  it('rejects malformed Skill names before storing a template', async () => {
    const { service } = createHarness()
    await expect(service.createAssistant({
      ...assistantInput(),
      skillAllowlist: ['Not A Skill'],
    })).rejects.toMatchObject({ code: 'SKILL_REFERENCE_INVALID' })
  })

  it('imports only Markdown rule documents', async () => {
    const { service } = createHarness()

    const imported = await service.importRuleDocument('rules/code-style.md', '# 代码风格\n\n先读后写。')
    expect(imported).toMatchObject({
      path: 'rules/code-style.md',
      fileName: 'code-style.md',
      title: '代码风格',
    })

    // A picked folder usually holds more than rules, so anything else is
    // refused by name instead of becoming prompt content.
    await expect(service.importRuleDocument('rules/notes.txt', 'plain text'))
      .rejects.toMatchObject({ code: 'RULE_REFERENCE_INVALID' })
    await expect(service.importRuleDocument('rules/config.json', '{}'))
      .rejects.toMatchObject({ code: 'RULE_REFERENCE_INVALID' })
    await expect(service.importRuleDocument('rules/design.md.txt', '# looks like Markdown'))
      .rejects.toMatchObject({ code: 'RULE_REFERENCE_INVALID' })

    expect(service.listRuleDocuments().items.map(document => document.path))
      .toEqual(['rules/code-style.md'])
  })

  it('rejects MCP Servers that are malformed or unavailable to the Agent Preset', async () => {
    const { service } = createHarness()

    await expect(service.createAssistant({
      ...assistantInput(),
      mcpServers: ['bad server'],
    })).rejects.toMatchObject({ code: 'MCP_REFERENCE_INVALID' })
    await expect(service.createAssistant({
      ...assistantInput(),
      mcpServers: ['missing'],
    })).rejects.toMatchObject({ code: 'MCP_REFERENCE_INVALID' })
  })

  it('persists selected MCP Servers into new team member snapshots', async () => {
    const { service } = createHarness()
    const assistant = await service.createAssistant({
      ...assistantInput(),
      mcpServers: ['github', 'github'],
    })
    const team = await service.createTeamDraft({
      name: 'MCP Team',
      
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })

    expect(assistant.mcpServers).toEqual(['github'])
    expect(service.assistantForMember(Object.values(team.members)[0]!)).toMatchObject({ mcpServers: ['github'] })
  })

  it('rejects the removed maxTokens field', async () => {
    const { service } = createHarness()
    await expect(service.createAssistant({
      ...assistantInput(),
      maxTokens: 4096,
    } as never)).rejects.toThrow()
  })

  it('dissolves a started team while preserving its assistant template', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Durable Team',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = Object.values(team.members).find(value => value.role === 'member')!
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const agent = fakeAgent()
    await ownMember(service, runtime, team.id, member.id, agent)

    await service.dissolveTeam(team.id, team.name)

    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
    expect(agent.whenIdle).toHaveBeenCalledOnce()
    expect(runtimeInternals(runtime).owned.size).toBe(0)
    expect(store.getTeam(draft.id)).toBeUndefined()
    expect(store.getAssistant(assistant.id)).toBeDefined()
  })

  it('keeps a failed started-team dissolution retryable', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Retryable Team',
      
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = team.members[team.leaderSlotId]!
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const agent = fakeAgent()
    const { conversationId, sessionId } = await assignSession(service, team.id, member.id)
    runtimeInternals(runtime).owned.set(sessionId, {
      teamId: team.id,
      conversationId,
      slotId: member.id,
      handle: {
        agent,
        dispose: vi.fn(async () => { throw new Error('dispose failed') }),
      },
      modelSelection: { current: undefined, assembled: undefined },
    })

    await expect(service.dissolveTeam(team.id, team.name)).rejects.toMatchObject({ code: 'TEAM_DELETE_FAILED' })

    expect(store.getTeam(team.id)?.state).toBe('delete_blocked')
    expect(store.getAssistant(assistant.id)).toBeDefined()
  })

  it('adds, promotes, and removes draft members without changing templates', async () => {
    const { service } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Mutable Draft',
      
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    const added = await service.addMember(draft.id, {
      assistantId: assistant.id,
    }, { expectedRevision: draft.revision })
    const second = Object.values(added.members).find(member => member.id !== draft.leaderSlotId)!
    const promoted = await service.changeLeader(added.id, second.id, { expectedRevision: added.revision })
    const original = promoted.members[draft.leaderSlotId]!
    const removed = await service.removeMember(promoted.id, original.id, { expectedRevision: promoted.revision })

    expect(Object.values(removed.members).map(member => member.displayName)).toEqual(['Codex Lead'])
    expect(service.getAssistant(assistant.id).revision).toBe(1)
  })

  it('notifies the leader after a new live member is ready', async () => {
    const { ctx, service, store, agents } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Growing Team',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const leader = team.members[team.leaderSlotId]!
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const leaderAgent = fakeAgent()
    const ensureMemberOnline = vi.fn(async () => {})
    await ownLeader(agents, service, team.id, leaderAgent)
    runtimeInternals(runtime).ensureMemberOnline = ensureMemberOnline

    const added = await service.addMember(team.id, {
      assistantId: assistant.id,
    }, { expectedRevision: service.getTeam(team.id).revision })
    const member = Object.values(added.members).find(value => value.id !== leader.id)!

    expect(ensureMemberOnline).toHaveBeenCalledOnce()
    expect(leaderAgent.followup).toHaveBeenCalledOnce()
    expect(leaderAgent.followup.mock.calls[0]?.[0]).toMatchObject({
      source: { kind: 'plugin', plugin: 'dsh-squad', form: 'relay' },
      content: [{ type: 'text', text: expect.stringContaining(member.id) }],
    })
    expect(Object.keys(added.outbox)).toHaveLength(0)
    expect(service.listMessages(team.id).items).toContainEqual(expect.objectContaining({
      sender: { kind: 'system', id: 'dsh-squad' },
      recipient: { kind: 'leader', slotId: leader.id },
      type: 'system',
      deliveryState: 'delivered',
    }))
  })

  it('atomically queues an assigned task and wakes its owner', async () => {
    const { ctx, service, store, agents } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Dispatch Team',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = Object.values(team.members).find(value => value.role === 'member')!
    const teamRuntime = new TeamRuntime(ctx, config, service)
    const runtime = runtimeInternals(teamRuntime)
    const leaderAgent = fakeAgent()
    const memberAgent = fakeAgent()
    const { conversationId } = await ownLeader(agents, service, team.id, leaderAgent)
    await ownMember(service, teamRuntime, team.id, member.id, memberAgent, conversationId)

    const created = await runtime.commands.createTask(team.id, conversationId, team.leaderSlotId, {
      title: 'Implement parser',
      description: 'Add the parser implementation.',
      ownerSlotId: member.id,
      fileScopes: ['src/parser.ts'],
    })

    expect(created).toMatchObject({ status: 'assigned', deliveryState: 'delivered' })
    expect(memberAgent.followup).toHaveBeenCalledOnce()
    expect(Object.keys(service.getTeam(team.id).outbox)).toHaveLength(0)
    const assignment = service.listMessages(team.id).items[0]!
    expect(assignment).toMatchObject({
      deliveryState: 'delivered',
      recipient: { kind: 'member', slotId: member.id },
      relatedTaskId: created.taskId,
    })

    const updated = await runtime.commands.updateTask(team.id, conversationId, member.id, {
      taskId: created.taskId,
      status: 'completed',
      result: 'Parser implemented and tested.',
    })

    expect(updated.deliveryState).toBe('delivered')
    expect(leaderAgent.followup).toHaveBeenCalledOnce()
    expect(leaderAgent.followup.mock.calls[0]?.[0]).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining(`slotId=${member.id}`) }],
    })
    expect(service.listMessages(team.id).items[1]).toMatchObject({
      type: 'result',
      recipient: { kind: 'leader', slotId: team.leaderSlotId },
      relatedTaskId: created.taskId,
    })
  })

  it('routes member messages through the Leader instead of member to member', async () => {
    const { ctx, service, store, agents } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Routed Team',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const [first, second] = Object.values(team.members).filter(member => member.role === 'member')
    const teamRuntime = new TeamRuntime(ctx, config, service)
    const runtime = runtimeInternals(teamRuntime)
    const { conversationId } = await ownLeader(agents, service, team.id, fakeAgent())
    await ownMember(service, teamRuntime, team.id, first!.id, fakeAgent(), conversationId)
    await ownMember(service, teamRuntime, team.id, second!.id, fakeAgent(), conversationId)

    // Even with direct member chat on, one member cannot reach another: the
    // Leader is the single voice the team coordinates through.
    expect(team.directMemberChat).toBe(true)
    await expect(runtime.commands.sendMemberMessage(
      team.id, conversationId, first!.id, second!.id, '直接找你了',
    )).rejects.toThrow('Members may message only the Leader')

    // Both directions to the Leader still work.
    await expect(runtime.commands.sendMemberMessage(
      team.id, conversationId, first!.id, team.leaderSlotId, '回报 Leader',
    )).resolves.toMatchObject({ deliveryState: 'delivered' })
    await expect(runtime.commands.sendMemberMessage(
      team.id, conversationId, team.leaderSlotId, second!.id, '派活给成员',
    )).resolves.toMatchObject({ deliveryState: 'delivered' })
  })

  it('routes member messages through the Leader instead of member to member', async () => {
    const { ctx, service, store, agents } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Routed Team',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const [first, second] = Object.values(team.members).filter(member => member.role === 'member')
    const teamRuntime = new TeamRuntime(ctx, config, service)
    const runtime = runtimeInternals(teamRuntime)
    const { conversationId } = await ownLeader(agents, service, team.id, fakeAgent())
    await ownMember(service, teamRuntime, team.id, first!.id, fakeAgent(), conversationId)
    await ownMember(service, teamRuntime, team.id, second!.id, fakeAgent(), conversationId)

    // Even with direct member chat on, one member cannot reach another: the
    // Leader is the single voice the team coordinates through.
    expect(team.directMemberChat).toBe(true)
    await expect(runtime.commands.sendMemberMessage(
      team.id, conversationId, first!.id, second!.id, '直接找你了',
    )).rejects.toThrow('Members may message only the Leader')

    // Both directions to the Leader still work.
    await expect(runtime.commands.sendMemberMessage(
      team.id, conversationId, first!.id, team.leaderSlotId, '回报 Leader',
    )).resolves.toMatchObject({ deliveryState: 'delivered' })
    await expect(runtime.commands.sendMemberMessage(
      team.id, conversationId, team.leaderSlotId, second!.id, '派活给成员',
    )).resolves.toMatchObject({ deliveryState: 'delivered' })
  })

  it('records the task a message is about, so the Leader can route it', async () => {
    const { ctx, service, store, agents } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Named Task Team',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = Object.values(team.members).find(value => value.role === 'member')!
    const teamRuntime = new TeamRuntime(ctx, config, service)
    const runtime = runtimeInternals(teamRuntime)
    const { conversationId } = await ownLeader(agents, service, team.id, fakeAgent())
    await ownMember(service, teamRuntime, team.id, member.id, fakeAgent(), conversationId)
    const task = await runtime.commands.createTask(team.id, conversationId, team.leaderSlotId, {
      title: '实现驱动',
      ownerSlotId: member.id,
    })

    await runtime.commands.sendMemberMessage(
      team.id, conversationId, member.id, team.leaderSlotId,
      '请求：请确认命令码\n需要：确认或纠正 netfn 取值',
      'question', task.taskId,
    )

    const sent = service.listMessages(team.id).items
      .find(message => message.sender.kind === 'member' && message.type === 'question')
    expect(sent?.relatedTaskId).toBe(task.taskId)
  })

  it('exports configuration to a bundle and reads it back as an independent copy', async () => {
    const source = createHarness()
    const assistant = await source.service.createAssistant(assistantInput())
    const document = await source.service.importRuleDocument('rules/house.md', '# 规范\n\n只改必要的行。')
    await source.service.updateAssistant(assistant.id, {
      ruleDocumentAllowlist: [document.id],
    })
    const draft = await source.service.createTeamDraft({
      name: 'Bundle Team',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    await source.store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = source.service.getTeam(draft.id)
    const [first, second] = Object.values(team.members)
    const task = await runtimeInternals(new TeamRuntime(source.ctx, config, source.service)).commands.createTask(
      team.id, 'conversation-1', first!.id, { title: '先做', ownerSlotId: first!.id },
    )
    await runtimeInternals(new TeamRuntime(source.ctx, config, source.service)).commands.createTask(
      team.id, 'conversation-1', first!.id,
      { title: '后做', ownerSlotId: second!.id, dependencyIds: [task.taskId] },
    )

    const bundle = source.service.exportBundle({ teamIds: [team.id] })

    // Configuration only: nothing that describes a running team travels.
    expect(bundle.format).toBe('dsh-squad/bundle')
    expect(bundle.assistants).toHaveLength(1)
    expect(bundle.assistants[0]!.ruleDocumentKeys).toEqual(['rule:rules/house.md'])
    expect(bundle.ruleDocuments.map(document => document.path)).toEqual(['rules/house.md'])
    expect(bundle.teams).toHaveLength(1)
    const exported = bundle.teams[0]!
    expect(Object.keys(exported.members)).toHaveLength(2)
    const exportedTasks = Object.values(exported.tasks)
    expect(exportedTasks.map(item => item.title).sort()).toEqual(['先做', '后做'])
    // The dependency is expressed as a key inside the file, not a storage id.
    const later = exportedTasks.find(item => item.title === '后做')!
    const earlier = exportedTasks.find(item => item.title === '先做')!
    expect(later.dependencyIds).toEqual([earlier.key])

    // Importing it elsewhere gives a working, independent copy.
    const target = createHarness()
    const summary = await target.service.importBundle({ bundle, mode: 'copy' })
    expect(summary.teamsCreated).toBe(1)
    expect(summary.assistantsCreated).toBe(1)
    expect(summary.ruleDocumentsCreated).toBe(1)
    expect(summary.warnings).toEqual([])

    const importedTeam = target.service.listTeams().items[0]!
    expect(importedTeam.name).toBe('Bundle Team')
    expect(importedTeam.id).not.toBe(team.id)
    expect(importedTeam.state).toBe('draft')
    // Every id is this instance's own: no record points at the source's storage.
    expect(Object.keys(importedTeam.members)).toHaveLength(2)
    for (const member of Object.values(importedTeam.members)) {
      expect(member.assistantId).not.toBe(assistant.id)
      expect(importedTeam.members[importedTeam.leaderSlotId]).toBeDefined()
    }
    const importedTasks = Object.values(importedTeam.tasks)
    expect(importedTasks).toHaveLength(2)
    const importedLater = importedTasks.find(item => item.title === '后做')!
    const importedEarlier = importedTasks.find(item => item.title === '先做')!
    expect(importedLater.dependencyIds).toEqual([importedEarlier.id])
    expect(importedLater.ownerSlotIds.every(owner => importedTeam.members[owner] !== undefined)).toBe(true)
  })

  it('keeps the same record when importing over what is already here', async () => {
    const source = createHarness()
    const assistant = await source.service.createAssistant({ ...assistantInput(), name: 'Shared' })
    const document = await source.service.importRuleDocument('rules/shared.md', '# 共享')
    await source.service.updateAssistant(assistant.id, {
      ruleDocumentAllowlist: [document.id],
    })
    const bundle = source.service.exportBundle({})

    const target = createHarness()
    const first = await target.service.importBundle({ bundle, mode: 'overwrite' })
    const second = await target.service.importBundle({ bundle, mode: 'overwrite' })

    // Overwrite is for moving a configuration, not for accumulating copies: the
    // second import recognises what the first one made.
    expect(first.assistantsCreated).toBe(1)
    expect(second.assistantsCreated).toBe(0)
    expect(second.assistantsUpdated).toBe(1)
    expect(target.service.listAssistants().items).toHaveLength(1)
    expect(target.service.listRuleDocuments().items).toHaveLength(1)
    expect(target.service.listAssistants().items[0]!.name).toBe('Shared')
  })

  it('warns instead of failing when a member names an assistant the file lacks', async () => {
    const { service } = createHarness()
    const bundle = {
      format: 'dsh-squad/bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      assistants: [],
      ruleDocuments: [],
      teams: [{
        name: 'Broken Team',
        directMemberChat: true,
        leaderKey: 'member:a',
        members: {
          'member:a': { displayName: 'A', role: 'leader', permissionPresetId: 'standard', assistantKey: 'assistant:missing' },
        },
        tasks: {},
      }],
    }
    const summary = await service.importBundle({ bundle, mode: 'copy' })
    // Nothing to import, but the file is understood and the reader is told why.
    expect(summary.teamsCreated).toBe(0)
    expect(summary.warnings.join('')).toContain('没有可用的 Leader')
  })

  it('refuses a bundle that is not one, and names what is wrong', async () => {
    const { service } = createHarness()
    await expect(service.importBundle({ bundle: { format: 'something-else' }, mode: 'copy' }))
      .rejects.toThrow()
    await expect(service.importBundle({ bundle: { format: 'dsh-squad/bundle', version: 99 } , mode: 'copy' }))
      .rejects.toThrow()
  })

  it('records task dependencies and refuses ones that cannot be run', async () => {
    const { ctx, service, store, agents } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Dependency Team',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = Object.values(team.members).find(value => value.role === 'member')!
    const teamRuntime = new TeamRuntime(ctx, config, service)
    const runtime = runtimeInternals(teamRuntime)
    const { conversationId } = await ownLeader(agents, service, team.id, fakeAgent())
    await ownMember(service, teamRuntime, team.id, member.id, fakeAgent(), conversationId)

    const design = await runtime.commands.createTask(team.id, conversationId, team.leaderSlotId, {
      title: 'Design the parser',
      ownerSlotId: member.id,
    })
    const implement = await runtime.commands.createTask(team.id, conversationId, team.leaderSlotId, {
      title: 'Implement the parser',
      ownerSlotId: member.id,
      dependencyIds: [design.taskId],
    })

    // The dependency is stored on the task, which is what the board draws from.
    expect(service.getTeam(team.id).tasks[implement.taskId]?.dependencyIds).toEqual([design.taskId])

    await expect(runtime.commands.createTask(team.id, conversationId, team.leaderSlotId, {
      title: 'Written against a task that does not exist',
      dependencyIds: ['no-such-task'],
    })).rejects.toThrow('Unknown dependency')

    await expect(runtime.commands.updateTask(team.id, conversationId, team.leaderSlotId, {
      taskId: design.taskId,
      status: 'running',
      dependencyIds: [design.taskId],
    })).rejects.toThrow('cannot depend on itself')

    // design -> implement already exists, so making design wait on implement
    // would close a cycle that no ordering could ever run.
    await expect(runtime.commands.updateTask(team.id, conversationId, team.leaderSlotId, {
      taskId: design.taskId,
      status: 'running',
      dependencyIds: [implement.taskId],
    })).rejects.toThrow('would create a cycle')

    // A member may not rewire the board.
    await expect(runtime.commands.updateTask(team.id, conversationId, member.id, {
      taskId: implement.taskId,
      status: 'running',
      dependencyIds: [],
    })).rejects.toThrow('Only the team leader may change task dependencies')

    // Clearing dependencies is the Leader's to do, and it sticks.
    await runtime.commands.updateTask(team.id, conversationId, team.leaderSlotId, {
      taskId: implement.taskId,
      status: 'running',
      dependencyIds: [],
    })
    expect(service.getTeam(team.id).tasks[implement.taskId]?.dependencyIds).toEqual([])
  })

  it('wakes every owner of a shared task so they work on it in parallel', async () => {
    const { ctx, service, store, agents } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Shared Team',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
        { assistantId: assistant.id, role: 'member' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const [first, second, outsider] = Object.values(team.members).filter(value => value.role === 'member')
    const teamRuntime = new TeamRuntime(ctx, config, service)
    const runtime = runtimeInternals(teamRuntime)
    const leaderAgent = fakeAgent()
    const firstAgent = fakeAgent()
    const secondAgent = fakeAgent()
    const { conversationId } = await ownLeader(agents, service, team.id, leaderAgent)
    await ownMember(service, teamRuntime, team.id, first!.id, firstAgent, conversationId)
    await ownMember(service, teamRuntime, team.id, second!.id, secondAgent, conversationId)

    const created = await runtime.commands.createTask(team.id, conversationId, team.leaderSlotId, {
      title: 'Build the parser',
      ownerSlotIds: [first!.id, second!.id],
    })

    expect(created).toMatchObject({ status: 'assigned', deliveryState: 'delivered' })
    expect(firstAgent.followup).toHaveBeenCalledOnce()
    expect(secondAgent.followup).toHaveBeenCalledOnce()
    expect(Object.keys(service.getTeam(team.id).outbox)).toHaveLength(0)
    expect(Object.values(service.getTeam(team.id).tasks)[0]?.ownerSlotIds)
      .toEqual([first!.id, second!.id])
    // Each owner is told who it shares the task with.
    const assignments = service.listMessages(team.id).items
    expect(assignments).toHaveLength(2)
    for (const assignment of assignments) {
      expect(assignment.relatedTaskId).toBe(created.taskId)
      expect(JSON.stringify(assignment.content)).toContain('You share this task with')
    }

    // Both owners may update it; an unrelated member may not.
    await expect(runtime.commands.updateTask(team.id, conversationId, outsider!.id, {
      taskId: created.taskId,
      status: 'running',
    })).rejects.toThrow('only a task it owns')
    await expect(runtime.commands.updateTask(team.id, conversationId, second!.id, {
      taskId: created.taskId,
      status: 'running',
    })).resolves.toMatchObject({ status: 'running' })
  })

  it('keeps failed assignment delivery in the durable outbox and recovers it', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Recovery Team',
      
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = Object.values(team.members).find(value => value.role === 'member')!
    const teamRuntime = new TeamRuntime(ctx, config, service)
    const runtime = runtimeInternals(teamRuntime)
    const memberAgent = fakeAgent()
    memberAgent.followup.mockImplementationOnce(() => { throw new Error('temporary inbox failure') })
    const { conversationId } = await ownMember(service, teamRuntime, team.id, member.id, memberAgent)

    const created = await runtime.commands.createTask(team.id, conversationId, team.leaderSlotId, {
      title: 'Recoverable assignment',
      ownerSlotId: member.id,
    })

    expect(created.deliveryState).toBe('queued')
    expect(Object.keys(service.getTeam(team.id).outbox)).toHaveLength(1)
    expect(service.listMessages(team.id).items[0]?.deliveryState).toBe('failed')

    memberAgent.followup.mockImplementation(message => {
      memberAgent.session.events.push({
        type: 'agent/inbox/spliced',
        data: { inserted: [message] },
      })
    })
    await runtime.messages.recover(service.getTeam(team.id))

    expect(memberAgent.followup).toHaveBeenCalledTimes(2)
    expect(Object.keys(service.getTeam(team.id).outbox)).toHaveLength(0)
    expect(service.listMessages(team.id).items[0]?.deliveryState).toBe('delivered')
  })

  it('stops the active member, clears pending inbox work, and waits for idle', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Stop Team',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, team => ({
      ...team,
      state: 'active',
      members: Object.fromEntries(Object.entries(team.members).map(([id, member]) => [
        id,
        { ...member, lastRuntimeState: 'running' },
      ])),
    }))
    const team = service.getTeam(draft.id)
    const member = Object.values(team.members).find(value => value.role === 'member')!
    const teamRuntime = new TeamRuntime(ctx, config, service)
    const runtime = runtimeInternals(teamRuntime)
    const agent = fakeAgent()
    agent.status = 'running'
    agent.whenIdle.mockImplementation(async () => { agent.status = 'idle' })
    const { conversationId } = await ownMember(service, teamRuntime, team.id, member.id, agent)

    await runtime.stopMember(team.id, member.id, conversationId)

    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(agent.whenIdle).toHaveBeenCalledOnce()
    expect(service.getTeam(team.id).members[member.id]?.lastRuntimeState).toBe('idle')
  })

  it('reliably notifies the leader after removing a live member', async () => {
    const { ctx, service, store, agents } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Roster Team',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const leader = team.members[team.leaderSlotId]!
    const member = Object.values(team.members).find(value => value.role === 'member')!
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const leaderAgent = fakeAgent()
    const memberAgent = fakeAgent()
    await ownLeader(agents, service, team.id, leaderAgent)
    const memberSession = await ownMember(service, runtime, team.id, member.id, memberAgent)

    const removed = await service.removeMember(team.id, member.id, {
      expectedRevision: service.getTeam(team.id).revision,
    })

    expect(removed.members[member.id]).toBeUndefined()
    expect(removed.retiredSessions[memberSession.sessionId])
      .toMatchObject({ displayName: member.displayName })
    expect(memberAgent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
    expect(leaderAgent.followup).toHaveBeenCalledOnce()
    expect(leaderAgent.followup.mock.calls[0]?.[0]).toMatchObject({
      role: 'user',
      source: { kind: 'plugin', plugin: 'dsh-squad', form: 'relay' },
      content: [{ type: 'text', text: expect.stringContaining(member.id) }],
    })
    expect(Object.keys(removed.outbox)).toHaveLength(0)
    expect(service.listMessages(team.id).items).toContainEqual(expect.objectContaining({
      sender: { kind: 'system', id: 'dsh-squad' },
      recipient: { kind: 'leader', slotId: leader.id },
      type: 'system',
      deliveryState: 'delivered',
    }))
  })

  it('changes a live member permission without modifying the assistant default', async () => {
    const { ctx, service, store, permissionSet } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Permission Team',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = Object.values(team.members).find(value => value.role === 'member')!
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    await ownMember(service, runtime, team.id, member.id, fakeAgent())

    // The assistant is the only place an effective permission can be changed.
    await service.updateAssistant(assistant.id, { permissionPresetId: 'workspace-write' })

    expect(permissionSet).toHaveBeenCalledWith(expect.anything(), 'workspace-write')
    expect(service.getTeam(team.id).members[member.id]?.permissionPresetId).toBe('workspace-write')
  })

  it('brings a team along when its assistant changes, so the team cannot silently drift', async () => {
    const { ctx, service, store, permissionSet } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Following Team',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = Object.values(team.members).find(value => value.role === 'member')!
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const { conversationId } = await ownMember(service, runtime, team.id, member.id, fakeAgent())

    await service.updateAssistant(assistant.id, { permissionPresetId: 'workspace-write' })

    // The member that follows takes the new permission, and the running Agent
    // is re-sandboxed with it.
    expect(service.getTeam(team.id).members[member.id]?.permissionPresetId).toBe('workspace-write')
    expect(permissionSet).toHaveBeenCalledWith(expect.anything(), 'workspace-write')
    void conversationId
  })

  it('brings a team bound before the rule onto its assistant at startup', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Legacy Team',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    // A record written while a member still kept its own stale copy.
    await store.updateTeam(draft.id, team => ({
      ...team,
      state: 'active',
      members: Object.fromEntries(Object.entries(team.members).map(([id, member]) => [
        id,
        { ...member, permissionPresetId: 'read-only' },
      ])),
    }))
    const member = Object.values(service.getTeam(draft.id).members)
      .find(value => value.role === 'member')!

    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    await runtime.recoverTeams()

    expect(service.getTeam(draft.id).members[member.id]?.permissionPresetId).toBe('standard')
  })

  it('updates an active team that has no member running yet', async () => {
    // A team is only really running once a conversation opens it. Until then
    // there is no live Agent to push onto, and the record is the only thing the
    // next activation will read.
    const { service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Idle Team',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))

    await service.updateAssistant(assistant.id, { permissionPresetId: 'workspace-write' })

    const leader = Object.values(service.getTeam(draft.id).members)
      .find(value => value.role === 'leader')!
    expect(leader.permissionPresetId).toBe('workspace-write')
  })

  it('updates a draft team record so it is right the moment it starts', async () => {
    const { service } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Draft Team',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await service.updateAssistant(assistant.id, { permissionPresetId: 'workspace-write' })
    const leader = Object.values(service.getTeam(draft.id).members)
      .find(value => value.role === 'leader')!
    expect(leader.permissionPresetId).toBe('workspace-write')
  })
})

function createHarness(workspacePath = '/tmp/agent-team-workspace'): {
  ctx: Context
  service: AgentTeamService
  store: MemoryStore
  permissionSet: ReturnType<typeof vi.fn>
  agents: {
    roots: Map<string, FakeLeaderAgent>
    creations: Array<{ sessionId: string; parentAgent?: unknown; meta?: unknown }>
  }
} {
  const ctx = new Context()
  ctx.provide('llm', {
    listProviders: () => [{ id: 'openai', name: 'OpenAI' }],
    listModels: async () => [{ id: 'codex', name: 'Codex' }],
    resolveModelInfo: async (provider: string, model: string) => ({
      provider,
      model,
      reasoning: {
        efforts: [
          { id: 'low', name: 'Low', description: 'Faster reasoning.' },
          { id: 'high', name: 'High' },
        ],
        defaultEffort: 'low',
      },
    }),
  } as never)
  ctx.provide('agentPresets', {
    list: async () => [{ id: 'default', name: 'Default' }],
    resolve: async (id: string) => ({ id, name: id }),
    standingKeyFor: async () => ({ kind: 'preset-scope' }),
  } as never)
  ctx.provide('tools', {
    get: (name: string) => name === 'skill' ? { name: 'skill' } : undefined,
    schemas: () => [
      { name: 'skill', description: 'Load one Skill.' },
      { name: 'mcp__github__list_issues', description: 'List issues.' },
      { name: 'mcp__figma__inspect', description: 'Inspect a Figma node.' },
      { name: 'mcp__github__create_issue', description: 'Create an issue.' },
    ],
  } as never)
  ctx.provide('skills', {
    list: async () => [
      {
        name: 'code-review',
        description: 'Review code changes.',
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'user-agents',
        provider: 'filesystem',
      },
      {
        name: 'manual-only',
        description: 'Only users may invoke this.',
        invocation: { modelInvocable: false, userInvocable: true },
        source: 'user-agents',
        provider: 'filesystem',
      },
    ],
  } as never)
  const agentCreations: Array<{ sessionId: string; parentAgent?: unknown; meta?: unknown }> = []
  const permissionSet = vi.fn()
  ctx.provide('permissionPresets', {
    names: ['standard', 'read-only', 'workspace-write', 'danger-full-access'],
    optionOf: (name: string) => ({ value: name, name }),
    set: permissionSet,
  } as never)
  const roots = new Map<string, FakeLeaderAgent>()
  /**
   * A member session is a subagent of the Session's own Agent, so only
   * registered Harness Sessions resolve to a root Agent here; member ids are
   * recognized by the prefix the runtime mints for them.
   */
  ctx.provide('agents', {
    get: (id: string) => {
      const key = String(id)
      if (key.startsWith('agent-team:')) return undefined
      const existing = roots.get(key)
      if (existing !== undefined) return existing
      const created = fakeLeaderAgent(key, workspacePath)
      roots.set(key, created)
      return created
    },
    create: async (options: { sessionId: string; parentAgent?: unknown; meta?: unknown }) => {
      agentCreations.push({
        sessionId: String(options.sessionId),
        parentAgent: options.parentAgent,
        meta: options.meta,
      })
      return { agent: fakeAgent(String(options.sessionId)), dispose: vi.fn(async () => {}) }
    },
    resume: async (options: { resumeSessionId: string; parentAgent?: unknown }) => {
      agentCreations.push({
        sessionId: String(options.resumeSessionId),
        parentAgent: options.parentAgent,
        meta: undefined,
      })
      return { agent: fakeAgent(String(options.resumeSessionId)), dispose: vi.fn(async () => {}) }
    },
  } as never)
  ctx.provide('sessionPersistence', {
    list: async () => [],
  } as never)
  ctx.provide('sessions', {
    flush: async () => {},
  } as never)
  const workspace = {
    id: 'workspace-1',
    path: workspacePath,
    title: 'Workspace',
    status: async () => 'ok' as const,
    attachSession: async () => {},
    detachSession: async () => {},
  }
  ctx.provide('workspaceRegistry', {
    get: (id: string) => id === workspace.id ? workspace : undefined,
    list: () => [workspace],
  } as never)
  const store = new MemoryStore()
  return {
    ctx,
    service: new AgentTeamService(ctx, config, store),
    store,
    permissionSet,
    agents: { roots, creations: agentCreations },
  }
}

interface FakeAgent {
  id: string
  followup: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  whenIdle: ReturnType<typeof vi.fn>
  status: 'idle' | 'running'
  /** The scoped context the runtime attaches its interaction handlers to. */
  ctx: { on: (event: string, handler: unknown) => () => void }
  session: {
    id: string
    header: { cwd?: string; delegationDepth?: number }
    events: Array<{ type: string; data: { inserted: unknown[] } }>
    snapshotEvents: () => Array<{ type: string; data: { inserted: unknown[] } }>
  }
}

interface FakeLeaderAgent {
  id: string
  status: 'idle' | 'running'
  session: FakeAgent['session']
  followup: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  whenIdle: ReturnType<typeof vi.fn>
  sections: Array<{ name: string; text: () => string }>
  tools: string[]
  disposers: Array<ReturnType<typeof vi.fn>>
  ctx: {
    systemPrompt: { section: (entry: { name: string; text: () => string }) => () => void }
    tools: {
      register: (definition: { name: string }) => () => void
      get: (name: string) => unknown
      schemas: () => unknown[]
    }
    on: (event: string, handler: unknown) => () => void
  }
}

interface RuntimeInternals {
  owned: Map<string, unknown>
  leaders: Map<string, { teamId: string; conversationId: string; slotId: string; dispose: () => void }>
  commands: TeamCommandHandler
  messages: TeamMessageDispatcher
  assertModelAvailable: (
    member: TeamAggregate['members'][string],
    provider: string,
    model: string,
  ) => Promise<void>
  ensureConversationOnline: (teamId: string, conversationId: string) => Promise<void>
  ensureMemberOnline: (...args: unknown[]) => Promise<void>
  stopMember(teamId: string, slotId: string, conversationId: string): Promise<void>
}

/** Every message a fake Agent's Session received, joined for one assertion. */
function inboxText(agent: { session: { events: Array<{ type: string; data: { inserted: unknown[] } }> } }): string {
  return agent.session.events
    .filter(event => event.type === 'agent/inbox/spliced')
    .flatMap(event => event.data.inserted)
    .map(message => (message as { content: Array<{ text: string }> })
      .content.map(block => block.text).join(''))
    .join('\n')
}

/**
 * A bound team whose member is blocked on a sandbox escalation the Leader is
 * allowed to grant. Every escalation-raising test starts from this state.
 */
async function escalationHarness(beforeRequest?: (parts: {
  ctx: Context
  service: AgentTeamService
  runtime: TeamRuntime
}) => void): Promise<{
  ctx: Context
  service: AgentTeamService
  runtime: TeamRuntime
  leader: FakeLeaderAgent
  escalation: FakeAgent
  asked: Promise<unknown>
}> {
  const { ctx, service, store, agents } = createHarness()
  const assistant = await service.createAssistant(assistantInput())
  const draft = await service.createTeamDraft({
    name: 'Escalation team',
    members: [
      { assistantId: assistant.id, role: 'leader' },
      { assistantId: assistant.id, role: 'member' },
    ],
  })
  await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
  const runtime = new TeamRuntime(ctx, config, service, {
    attempts: 2,
    retryMs: 0,
    answerWindowMs: LEADER_ANSWER_TIMEOUT_MS,
  })
  service.attachRuntime(runtime)

  const conversation = await bindTeam(service, draft.id, 'session-1')
  // The Leader itself runs at workspace-write, so the escalation is within its
  // authority and must reach it rather than the reader.
  const leader = agents.roots.get('session-1')!
  leader.session.events.push({ type: 'sandbox/mode', data: { mode: 'workspace-write' } } as never)

  const member = Object.values(service.getTeam(draft.id).members)
    .find(value => value.role === 'member')!
  const escalation = fakeAgent()
  await ownMember(service, runtime, draft.id, member.id, escalation, conversation.id)
  const approvals = new Map<string, (request: unknown, next: () => Promise<unknown>) => Promise<unknown>>()
  escalation.ctx = {
    on: (event, handler) => {
      approvals.set(event, handler as never)
      return () => { approvals.delete(event) }
    },
  }
  runtime.interactionBridge().attach(escalation.ctx as never, escalation as never)
  beforeRequest?.({ ctx, service, runtime })
  const asked = approvals.get('approval/request')!({
    agent: escalation,
    toolName: 'write',
    callId: 'call-1',
    reason: '需要写入工作区',
  }, () => Promise.resolve('unavailable'))
  return { ctx, service, runtime, leader, escalation, asked }
}

function runtimeInternals(runtime: TeamRuntime): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

/**
 * A member Agent as the factory publishes it: the Agent and its Session carry
 * the same id the runtime recorded as owned, and `ctx` is where the runtime
 * attaches its interaction handlers.
 */
function fakeAgent(sessionId = 'agent-team:fake'): FakeAgent {
  const session: FakeAgent['session'] = {
    id: sessionId,
    header: {},
    events: [],
    snapshotEvents: () => session.events,
  }
  return {
    id: sessionId,
    session,
    status: 'idle',
    ctx: { on: () => () => {} },
    followup: vi.fn(message => {
      session.events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } })
    }),
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {}),
  }
}

/**
 * The Harness Session's own Agent, which leads whichever team that Session has
 * enabled. The plugin only ever adds sections, tools and interaction handlers
 * to it, so the fake records exactly those registrations.
 */
function fakeLeaderAgent(sessionId: string, cwd: string): FakeLeaderAgent {
  const session: FakeLeaderAgent['session'] = {
    id: sessionId,
    header: { cwd, delegationDepth: 0 },
    events: [],
    snapshotEvents: () => session.events,
  }
  const sections: FakeLeaderAgent['sections'] = []
  const tools: string[] = []
  const disposers: Array<ReturnType<typeof vi.fn>> = []
  const agent: FakeLeaderAgent = {
    id: sessionId,
    status: 'idle',
    session,
    sections,
    tools,
    disposers,
    followup: vi.fn(message => {
      session.events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } })
    }),
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {}),
    ctx: {} as FakeLeaderAgent['ctx'],
  }
  agent.ctx = {
    systemPrompt: {
      section: entry => {
        sections.push(entry)
        const dispose = vi.fn()
        disposers.push(dispose)
        return dispose
      },
    },
    tools: {
      register: definition => {
        tools.push(definition.name)
        const dispose = vi.fn()
        disposers.push(dispose)
        return dispose
      },
      get: () => undefined,
      schemas: () => [],
    },
    on: () => () => {},
  }
  return agent
}

function fakeOwned(agent: FakeAgent): unknown {
  return {
    handle: { agent, dispose: vi.fn(async () => {}) },
    modelSelection: { current: undefined, assembled: undefined },
  }
}

/** One stored user message, the input the conversation title is derived from. */
function userMessage(
  teamId: string,
  conversationId: string,
  id: string,
  content: string,
  createdAt = new Date().toISOString(),
): TeamMessage {
  return {
    schemaVersion: 1,
    id,
    teamId,
    conversationId,
    sender: { kind: 'user', id: 'local-user' },
    recipient: { kind: 'broadcast' },
    type: 'instruction',
    content,
    attachments: [],
    deliveryState: 'delivered',
    idempotencyKey: id,
    createdAt,
  }
}

/**
 * Give one conversation a Session id for a member, mirroring what activation
 * does before it creates the Agent.
 */
/**
 * One binding of a team, created on first use.
 *
 * A conversation is a Harness Session now: enabling the team in that Session is
 * what makes its members run, and the Session's own Agent is the Leader.
 */
let boundSessionCounter = 0
async function activeConversation(
  service: AgentTeamService,
  teamId: string,
): Promise<TeamConversation> {
  const existing = service.listConversations(teamId).items.at(-1)
  if (existing !== undefined) return existing
  return service.createConversationRecord(teamId, {
    sessionId: `session-${++boundSessionCounter}`,
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/agent-team-workspace',
  })
}

/**
 * Register the Harness Session's own Agent for a team's binding. The Leader is
 * that Agent, so it is never one of the plugin's owned member Sessions.
 */
async function ownLeader(
  agents: { roots: Map<string, FakeLeaderAgent> },
  service: AgentTeamService,
  teamId: string,
  agent: FakeAgent = fakeAgent(),
): Promise<{ conversationId: string; sessionId: string }> {
  const conversation = await activeConversation(service, teamId)
  const sessionId = conversation.sessionId!
  agents.roots.set(sessionId, agent as unknown as FakeLeaderAgent)
  return { conversationId: conversation.id, sessionId }
}

/** Bind one team to a Session, registering that Session's root Agent. */
async function bindTeam(
  service: AgentTeamService,
  teamId: string,
  sessionId: string,
): Promise<TeamConversation> {
  return service.bindSession(sessionId, teamId)
}

async function assignSession(
  service: AgentTeamService,
  teamId: string,
  slotId: string,
  conversationId?: string,
): Promise<{ conversationId: string; sessionId: string }> {
  const conversation = conversationId === undefined
    ? await activeConversation(service, teamId)
    : service.getConversation(teamId, conversationId)
  const existing = conversation.memberSessions[slotId]
  if (existing !== undefined) return { conversationId: conversation.id, sessionId: existing }
  const assigned = await service.assignMemberSessions(teamId, conversation.id, {
    [slotId]: `agent-team:${randomUUID()}`,
  })
  return { conversationId: conversation.id, sessionId: assigned.memberSessions[slotId]! }
}

/** Mirror runtime activation for a single member with a fake owned Agent. */
async function ownMember(
  service: AgentTeamService,
  runtime: TeamRuntime,
  teamId: string,
  slotId: string,
  agent: FakeAgent = fakeAgent(),
  conversationId?: string,
): Promise<{ conversationId: string; sessionId: string }> {
  const assigned = await assignSession(service, teamId, slotId, conversationId)
  // The published Agent and its Session always share one id, which is what the
  // runtime keys ownership and its interaction scope by.
  agent.id = assigned.sessionId
  agent.session.id = assigned.sessionId
  runtimeInternals(runtime).owned.set(assigned.sessionId, {
    teamId,
    conversationId: assigned.conversationId,
    slotId,
    handle: { agent, dispose: vi.fn(async () => {}) },
    modelSelection: { current: undefined, assembled: undefined },
  })
  return assigned
}

function assistantInput() {
  return {
    name: 'Codex Lead',
    instructions: 'Coordinate the team.',
    provider: 'openai',
    model: 'codex',
    agentPresetId: 'default',
    permissionPresetId: 'standard',
    skillAllowlist: [],
    mcpServers: [],
  }
}

class MemoryStore implements AgentTeamStore {
  private assistants = new Map<string, AssistantTemplate>()
  private ruleDocuments = new Map<string, RuleDocument>()
  private teams = new Map<string, TeamAggregate>()
  private messages = new Map<string, TeamMessage>()
  private conversations = new Map<string, TeamConversation>()
  private activities = new Map<string, TeamActivity>()
  private operations = new Map<string, Operation>()

  getAssistant(id: string) { return this.assistants.get(id) }
  listAssistants() { return [...this.assistants.values()] }
  async putAssistant(value: AssistantTemplate) { this.assistants.set(value.id, value) }
  updateAssistant(id: string, update: (current: AssistantTemplate) => AssistantTemplate) {
    return updateMap(this.assistants, id, update)
  }
  async deleteAssistant(id: string) { return this.assistants.delete(id) }

  getRuleDocument(id: string) { return this.ruleDocuments.get(id) }
  listRuleDocuments() { return [...this.ruleDocuments.values()] }
  async putRuleDocument(value: RuleDocument) { this.ruleDocuments.set(value.id, value) }
  async deleteRuleDocument(id: string) { return this.ruleDocuments.delete(id) }

  getTeam(id: string) { return this.teams.get(id) }
  listTeams() { return [...this.teams.values()] }
  async putTeam(value: TeamAggregate) { this.teams.set(value.id, value) }
  updateTeam(id: string, update: (current: TeamAggregate) => TeamAggregate) {
    return updateMap(this.teams, id, update)
  }
  async deleteTeam(id: string) { return this.teams.delete(id) }

  listMessages(teamId: string) { return [...this.messages.values()].filter(value => value.teamId === teamId) }
  async putMessage(value: TeamMessage) { this.messages.set(value.id, value) }
  async deleteMessage(id: string) { return this.messages.delete(id) }

  getConversation(id: string) { return this.conversations.get(id) }
  listConversations(teamId: string) {
    return [...this.conversations.values()].filter(value => value.teamId === teamId)
  }
  async putConversation(value: TeamConversation) { this.conversations.set(value.id, value) }
  updateConversation(id: string, update: (current: TeamConversation) => TeamConversation) {
    return updateMap(this.conversations, id, update)
  }
  async deleteConversation(id: string) { return this.conversations.delete(id) }

  listActivities(teamId: string) { return [...this.activities.values()].filter(value => value.teamId === teamId) }
  async putActivity(value: TeamActivity) { this.activities.set(value.id, value) }
  async deleteActivity(id: string) { return this.activities.delete(id) }

  getOperation(id: string) { return this.operations.get(id) }
  listOperations() { return [...this.operations.values()] }
  async putOperation(value: Operation) { this.operations.set(value.id, value) }
  updateOperation(id: string, update: (current: Operation) => Operation) {
    return updateMap(this.operations, id, update)
  }
  async deleteOperation(id: string) { return this.operations.delete(id) }
}

async function updateMap<T>(map: Map<string, T>, id: string, update: (current: T) => T): Promise<T> {
  const current = map.get(id)
  if (current === undefined) throw new AgentTeamError('INVALID_REQUEST', `Unknown record '${id}'`)
  const next = update(current)
  map.set(id, next)
  return next
}

describe('AgentTeamService session binding', () => {
  async function teamWithLeader(service: AgentTeamService): Promise<string> {
    const assistant = await service.createAssistant(assistantInput())
    const team = await service.createTeamDraft({
      name: 'Meeting team',
      directMemberChat: true,
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    return team.id
  }

  it('binds a team to a Harness Session and finds it by that Session', async () => {
    const { ctx, service } = createHarness()
    const teamId = await teamWithLeader(service)
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)

    const conversation = await bindTeam(service, teamId, 'session-1')

    expect(conversation.sessionId).toBe('session-1')
    // Only the Leader exists, and the Leader is the Session itself, so no
    // member Session is created at all.
    expect(conversation.memberSessions).toEqual({})
    expect(service.findConversationBySession('session-1')?.id).toBe(conversation.id)
    expect(service.findConversationBySession('session-2')).toBeUndefined()
    // Enabling is what starts the team; a draft no longer waits for a Session.
    expect(service.getTeam(teamId).state).toBe('active')

    // Binding the same team again is idempotent.
    const again = await bindTeam(service, teamId, 'session-1')
    expect(again.id).toBe(conversation.id)
    expect(service.listConversations(teamId).items).toHaveLength(1)
  })

  it('allows one team per Session', async () => {
    const { ctx, service } = createHarness()
    const first = await teamWithLeader(service)
    const second = await teamWithLeader(service)
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)

    await bindTeam(service, first, 'session-1')

    await expect(service.bindSession('session-1', second)).rejects.toMatchObject({
      code: 'SESSION_ALREADY_BOUND',
    })
  })

  it('refuses a Session whose directory is not a Harness Workspace', async () => {
    const { ctx, service, agents } = createHarness()
    const teamId = await teamWithLeader(service)
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    agents.roots.set('session-elsewhere', fakeLeaderAgent('session-elsewhere', '/tmp/not-a-workspace'))

    await expect(service.bindSession('session-elsewhere', teamId)).rejects.toMatchObject({
      code: 'WORKSPACE_UNAVAILABLE',
    })
  })

  it('runs every non-leader member as a subagent of the Session Agent', async () => {
    const { ctx, service, agents } = createHarness()
    const leaderAssistant = await service.createAssistant(assistantInput())
    const memberAssistant = await service.createAssistant({ ...assistantInput(), name: 'Coder' })
    const team = await service.createTeamDraft({
      name: 'Subagent team',
      members: [
        { assistantId: leaderAssistant.id, role: 'leader' },
        { assistantId: memberAssistant.id, role: 'member' },
      ],
    })
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)

    const conversation = await service.bindSession('session-1', team.id)

    const leader = agents.roots.get('session-1')!
    const memberSlot = Object.values(service.getTeam(team.id).members)
      .find(member => member.role === 'member')!
    const creation = agents.creations.find(item => item.sessionId.startsWith('agent-team:'))
    expect(creation).toBeDefined()
    // The member is parented to the Session's own Agent and inherits its cwd,
    // so it is a real subagent Session rather than a root conversation.
    expect(creation?.parentAgent).toBe(leader)
    expect(creation?.meta).toMatchObject({
      cwd: '/tmp/agent-team-workspace',
      parentSession: 'session-1',
      origin: 'subagent',
      delegationDepth: 1,
    })
    expect(conversation.memberSessions[memberSlot.id]).toBe(creation?.sessionId)
    // The Leader owns no member Session: the Harness Session itself is it.
    expect(conversation.memberSessions[team.leaderSlotId]).toBeUndefined()
    expect(runtimeInternals(runtime).owned.size).toBe(1)
  })

  it('installs the Leader composition on the Session Agent and removes it on unbind', async () => {
    const { ctx, service, agents } = createHarness()
    const teamId = await teamWithLeader(service)
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)

    const conversation = await bindTeam(service, teamId, 'session-1')
    const leader = agents.roots.get('session-1')!
    const team = service.getTeam(teamId)

    expect(leader.sections.map(section => section.name)).toEqual([
      `agent-team:identity:${team.leaderSlotId}`,
      `agent-team:roster:${team.id}`,
    ])
    expect(leader.sections[0]?.text()).toContain('Codex Lead')
    expect(leader.tools).toEqual([
      'team_get_task_board',
      'team_create_task',
      'team_update_task',
      'team_send_message',
      // Members only talk to the Leader, so answering a member's waiting
      // question or approval is the Leader's own tool.
      'team_answer_member',
    ])
    const disposers = [...leader.disposers]

    await service.unbindSession('session-1')

    expect(service.findConversationBySession('session-1')).toBeUndefined()
    expect(runtimeInternals(runtime).leaders.size).toBe(0)
    for (const dispose of disposers) expect(dispose).toHaveBeenCalled()
    expect(() => service.getConversation(teamId, conversation.id)).toThrow(AgentTeamError)
  })

  it('records «替我审批» on the Session binding', async () => {
    const { ctx, service } = createHarness()
    const teamId = await teamWithLeader(service)
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)

    const conversation = await bindTeam(service, teamId, 'session-1')
    // Absent means the reader answers, which is how older bindings acted.
    expect(conversation.delegateInteractions).toBeUndefined()

    const delegated = await service.setSessionDelegation('session-1', true)
    expect(delegated.delegateInteractions).toBe(true)
    expect(service.findConversationBySession('session-1')?.delegateInteractions).toBe(true)

    const restored = await service.setSessionDelegation('session-1', false)
    expect(restored.delegateInteractions).toBe(false)
    // A Session without a team has nothing to delegate.
    await expect(service.setSessionDelegation('session-unbound', true))
      .rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' })
  })

  it('hands a member sandbox escalation to the Leader instead of leaving it pending', async () => {
    const { runtime, leader, escalation } = await escalationHarness()

    // Members never reach the reader, so the escalation stays blocked until the
    // Leader answers: it has to be told what is waiting and by which id.
    const pending = await vi.waitFor(() => {
      const listed = runtime.interactionBridge().list(String(escalation.id))
      expect(listed).toHaveLength(1)
      return listed[0]!
    })
    // Hand-off delivery is asynchronous: the Leader is told after this tick.
    await vi.waitFor(() => { expect(inboxText(leader)).toContain('需要你裁决') })
    const handoff = inboxText(leader)
    expect(handoff).toContain('write')
    expect(handoff).toContain(pending.id)
  })

  it('keeps handing a member escalation to the Leader when the conversation view cannot publish', async () => {
    // A live SSE client whose socket just died makes the broadcast throw; the
    // member's request must still reach the Leader.
    const { leader } = await escalationHarness(({ ctx, service }) => {
      vi.spyOn(service, 'publishConversation').mockImplementation(() => {
        throw new Error('client write failed')
      })
      vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    })

    await vi.waitFor(() => { expect(inboxText(leader)).toContain('需要你裁决') })
  })

  it('refuses a member escalation nobody answers once the answer window closes', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, runtime, escalation, asked } = await escalationHarness(({ ctx: hooks }) => {
        vi.spyOn(hooks.logger, 'warn').mockImplementation(() => {})
      })

      // The hand-off reached the Leader, who never answers it.
      await vi.waitFor(() => {
        expect(runtime.interactionBridge().list(String(escalation.id))).toHaveLength(1)
      })

      // The member must not be left waiting on a promise that never settles.
      await vi.advanceTimersByTimeAsync(LEADER_ANSWER_TIMEOUT_MS)
      await expect(asked).resolves.toBe('rejected')
      expect(runtime.interactionBridge().list(String(escalation.id))).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a member escalation it cannot hand over instead of leaving it waiting', async () => {
    // Every hand-off attempt fails, so no answerer can be reached at all. The
    // member must learn its request ended rather than stay blocked for good.
    const { runtime, escalation, asked } = await escalationHarness(({ ctx, runtime: live }) => {
      vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
      runtimeInternals(live).commands.sendMemberMessage = () =>
        Promise.reject(new Error('leader unreachable'))
    })

    // A refusal is a normal deny outcome, not an internal failure.
    await expect(asked).resolves.toBe('rejected')
    await vi.waitFor(() => {
      expect(runtime.interactionBridge().list(String(escalation.id))).toEqual([])
    })
  })

  it('attaches the Leader again when the Session Agent is created later', async () => {
    const { ctx, service, agents } = createHarness()
    const teamId = await teamWithLeader(service)
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    // A binding written by an earlier process: the Session is not open yet.
    await service.createConversationRecord(teamId, {
      sessionId: 'session-later',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/agent-team-workspace',
    })

    const leader = fakeLeaderAgent('session-later', '/tmp/agent-team-workspace')
    agents.roots.set('session-later', leader)
    ctx.emit('agent/created', { agent: leader } as never)

    expect(leader.sections).toHaveLength(2)
    expect(leader.tools).toHaveLength(5)
  })

  it('reports the bound Session in the workbench', async () => {
    const { ctx, service } = createHarness()
    const teamId = await teamWithLeader(service)
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)

    const conversation = await bindTeam(service, teamId, 'session-1')
    const team = service.getTeam(teamId)
    const board = await service.getWorkbench(teamId, conversation.id)

    expect(board.conversation.id).toBe(conversation.id)
    expect(board.conversations[0]?.slotId).toBe(team.leaderSlotId)
    // The Leader's Session is the Harness Session the user is looking at.
    expect(board.conversations[0]?.sessionId).toBe('session-1')
    expect(board.conversations[0]?.status).toBe('idle')
  })

  it('titles a bound Session row from its first user message like a DSH Session', async () => {
    const { service } = createHarness()
    const teamId = await teamWithLeader(service)
    const conversation = await service.createConversationRecord(teamId, {
      sessionId: 'session-title',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/agent-team-workspace',
    })

    // Nothing said yet: the row stays blank, which the UI labels as new.
    expect(service.listConversations(teamId).items[0]?.title).toBe('')

    const at = new Date('2026-01-02T03:04:05.000Z').toISOString()
    await service.putRuntimeMessage(userMessage(teamId, conversation.id, 'm1', '重做登录失败重试，并补回归测试', at))

    // The title is the native first-prompt fallback, not a plugin invention.
    const expected = fallbackSessionTitle('重做登录失败重试，并补回归测试', 5, 40)
    expect(service.listConversations(teamId).items[0]?.title).toBe(expected)
    // The row's stamp follows the latest activity, not the record's creation.
    expect(service.listConversations(teamId).items[0]?.updatedAt).toBe(at)
  })

  it('rejects a conversation that does not belong to the team', async () => {
    const { ctx, service } = createHarness()
    const teamId = await teamWithLeader(service)
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    await bindTeam(service, teamId, 'session-1')

    expect(() => service.getConversation(teamId, 'missing')).toThrow(AgentTeamError)
    await expect(service.getWorkbench(teamId, 'missing')).rejects.toThrow(AgentTeamError)
  })

  it('removes the bound Sessions when the team is dissolved', async () => {
    const { ctx, service, store } = createHarness()
    const teamId = await teamWithLeader(service)
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    await bindTeam(service, teamId, 'session-1')
    await bindTeam(service, teamId, 'session-2')
    expect(store.listConversations(teamId)).toHaveLength(2)

    const team = service.getTeam(teamId)
    await service.dissolveTeam(teamId, team.name)

    expect(store.listConversations(teamId)).toHaveLength(0)
    expect(service.findConversationBySession('session-1')).toBeUndefined()
  })

  it('drops teams that predate per-session binding', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Legacy Team',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    // Simulate a record written before a team was enabled in a Session.
    await store.updateTeam(draft.id, team => ({
      ...team,
      state: 'active',
      members: Object.fromEntries(Object.entries(team.members).map(([id, member]) => [
        id,
        { ...member, sessionId: 'agent-team:legacy-session' },
      ])),
    }))

    const runtime = new TeamRuntime(ctx, config, service)
    await runtime.recoverTeams()

    // The records are gone, so the plugin still opens its storage domain.
    expect(store.listTeams()).toHaveLength(0)
    expect(store.listConversations(draft.id)).toHaveLength(0)
    expect(service.listAssistants().items).toHaveLength(1)
  })

  it('drops a conversation that carries no Session', async () => {
    const { ctx, service, store } = createHarness()
    const teamId = await teamWithLeader(service)
    await store.updateTeam(teamId, current => ({ ...current, state: 'active' }))
    await store.putConversation({
      schemaVersion: 1,
      id: 'legacy-conversation',
      teamId,
      title: '旧会话',
      titleSource: 'auto',
      state: 'active',
      memberSessions: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      revision: 1,
    })

    const runtime = new TeamRuntime(ctx, config, service)
    await runtime.recoverTeams()

    expect(store.listConversations(teamId)).toHaveLength(0)
    expect(service.getTeam(teamId).state).toBe('active')
  })

  it('keeps a team dormant until it is enabled in a Session', async () => {
    const { ctx, service } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const team = await service.createTeamDraft({
      name: 'Draft Team',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)

    // Creating the record alone activates nothing: enabling is what starts it.
    await service.createConversationRecord(team.id, {
      sessionId: 'session-draft',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/agent-team-workspace',
    })

    expect(service.getTeam(team.id).state).toBe('draft')
    expect(runtimeInternals(runtime).owned.size).toBe(0)
  })

  it('starts a draft team without opening any Session', async () => {
    const { ctx, service, agents } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const team = await service.createTeamDraft({
      name: 'Started Team',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)

    await expect(runtime.startTeam(team.id)).resolves.toMatchObject({ id: team.id, state: 'active' })
    expect(agents.creations).toHaveLength(0)
  })

  it('accepts a message from an errored team instead of refusing it', async () => {
    const { ctx, service, store, agents } = createHarness()
    const teamId = await teamWithLeader(service)
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const conversation = await service.createConversationRecord(teamId, {
      sessionId: 'session-error',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/agent-team-workspace',
    })
    const leader = fakeLeaderAgent('session-error', '/tmp/agent-team-workspace')
    agents.roots.set('session-error', leader)
    await store.updateTeam(teamId, current => ({ ...current, state: 'error' }))

    const delivered = await runtime.sendUserMessage(teamId, '继续', conversation.id)

    expect(delivered.deliveryState).toBe('delivered')
    expect(leader.followup).toHaveBeenCalledTimes(1)
    expect(service.getTeam(teamId).state).toBe('error')
  })

  it('records a Harness-composer message in the room and does not hand it back to the Leader', async () => {
    const { ctx, service, store, agents } = createHarness()
    const teamId = await teamWithLeader(service)
    await store.updateTeam(teamId, current => ({ ...current, state: 'active' }))
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const conversation = await service.createConversationRecord(teamId, {
      sessionId: 'session-mention',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/agent-team-workspace',
    })
    const leader = fakeLeaderAgent('session-mention', '/tmp/agent-team-workspace')
    agents.roots.set('session-mention', leader)
    const team = service.getTeam(teamId)
    const leaderSlot = team.members[team.leaderSlotId]!

    // What the Harness composer appends to the Session it owns.
    ctx.emit('session/event', { id: 'session-mention' } as never, {
      type: 'user/message',
      seq: 1,
      time: Date.now(),
      data: {
        id: 'message-1',
        content: [{ type: 'text', text: `@${leaderSlot.displayName} 继续` }],
        source: { kind: 'user' },
      },
    } as never)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(service.listMessages(teamId).items).toContainEqual(expect.objectContaining({
      id: 'message-1',
      content: `@${leaderSlot.displayName} 继续`,
      mentions: [leaderSlot.id],
      deliveryState: 'delivered',
    }))
    // The Leader is this Session's own Agent: the message already drives its
    // turn, so relaying it back would deliver the same message twice.
    expect(leader.followup).not.toHaveBeenCalled()
  })

  it('hands a member-addressed message to that member alone', async () => {
    const { ctx, service, store, agents } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Private Team',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, current => ({ ...current, state: 'active' }))
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const conversation = await service.createConversationRecord(draft.id, {
      sessionId: 'session-private',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/agent-team-workspace',
    })
    const leader = fakeLeaderAgent('session-private', '/tmp/agent-team-workspace')
    const memberAgent = fakeAgent()
    agents.roots.set('session-private', leader)
    const team = service.getTeam(draft.id)
    const member = Object.values(team.members).find(value => value.role === 'member')!
    await ownMember(service, runtime, draft.id, member.id, memberAgent, conversation.id)

    const delivered = await runtime.sendUserMessage(
      draft.id,
      '只回复 priv-ok',
      conversation.id,
      member.id,
    )

    // The member the composer addressed is the only recipient; the Leader is the
    // Session's own Agent and never enters the delivery at all.
    expect(memberAgent.followup).toHaveBeenCalledOnce()
    expect(memberAgent.followup.mock.calls[0]![0]).toMatchObject({
      content: [{ type: 'text', text: '只回复 priv-ok' }],
    })
    expect(leader.followup).not.toHaveBeenCalled()
    expect(delivered).toMatchObject({
      content: '只回复 priv-ok',
      recipient: { kind: 'member', slotId: member.id },
      deliveryState: 'delivered',
    })
  })

  it('relays a mentioned member a plugin wake-up the room does not read back', async () => {
    const { ctx, service, store, agents } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Mention Team',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = Object.values(team.members).find(value => value.role === 'member')!
    const leaderSlot = team.members[team.leaderSlotId]!
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const conversation = await service.createConversationRecord(draft.id, {
      sessionId: 'session-mention-member',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/agent-team-workspace',
    })
    const leader = fakeLeaderAgent('session-mention-member', '/tmp/agent-team-workspace')
    const memberAgent = fakeAgent()
    agents.roots.set('session-mention-member', leader)
    await ownMember(service, runtime, draft.id, member.id, memberAgent, conversation.id)

    ctx.emit('session/event', { id: 'session-mention-member' } as never, {
      type: 'user/message',
      seq: 1,
      time: Date.now(),
      data: {
        id: 'message-mention',
        content: [{ type: 'text', text: `@${member.displayName} 请只回复 relay-ok` }],
        source: { kind: 'user' },
      },
    } as never)
    // The relay runs behind the team's exclusive lane, which also brings the
    // member online, so it needs more than one turn of the event loop.
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(memberAgent.followup).toHaveBeenCalledOnce()
    expect(memberAgent.followup.mock.calls[0]![0]).toMatchObject({
      source: { kind: 'plugin', plugin: 'dsh-squad', form: 'relay' },
      // The wake-up is what the reader typed, not a decorated copy of it: the
      // member's own column shows this message, and it is their words.
      content: [{ type: 'text', text: `@${member.displayName} 请只回复 relay-ok` }],
    })
    expect(leader.followup).not.toHaveBeenCalled()
    // The relay the plugin injected carries plugin provenance, so the room never
    // reads it back as another user message. Doing so used to relay it again,
    // one growing copy per round.
    ctx.emit('session/event', { id: 'session-mention-member' } as never, {
      type: 'user/message',
      seq: 2,
      time: Date.now(),
      data: {
        id: 'message-relay-echo',
        content: [{ type: 'text', text: `[会议室] 团队会议室有新消息，请在会议室中回应。\n@${leaderSlot.displayName} 请只回复 relay-ok` }],
        source: { kind: 'plugin', plugin: 'dsh-squad', form: 'relay' },
      },
    } as never)
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(service.listMessages(draft.id).items.filter(message => message.id === 'message-relay-echo'))
      .toHaveLength(0)
    expect(leader.followup).not.toHaveBeenCalled()
    expect(memberAgent.followup).toHaveBeenCalledOnce()
  })

  it('keeps a composer message that mentions nobody on the Leader alone', async () => {
    const { ctx, service, store, agents } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Leader Only Team',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = Object.values(team.members).find(value => value.role === 'member')!
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const conversation = await service.createConversationRecord(draft.id, {
      sessionId: 'session-leader-only',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/agent-team-workspace',
    })
    const leader = fakeLeaderAgent('session-leader-only', '/tmp/agent-team-workspace')
    const memberAgent = fakeAgent()
    agents.roots.set('session-leader-only', leader)
    await ownMember(service, runtime, draft.id, member.id, memberAgent, conversation.id)

    ctx.emit('session/event', { id: 'session-leader-only' } as never, {
      type: 'user/message',
      seq: 1,
      time: Date.now(),
      data: {
        id: 'message-plain',
        content: [{ type: 'text', text: '请继续' }],
        source: { kind: 'user' },
      },
    } as never)
    await new Promise(resolve => setTimeout(resolve, 50))

    // The Session's own Agent is the Leader, so its turn is the Harness's; the
    // plugin relays nothing. One member is reached by naming it, or by opening
    // that member's own Session — never by the Session's composer alone.
    expect(memberAgent.followup).not.toHaveBeenCalled()
    expect(leader.followup).not.toHaveBeenCalled()
    const record = service.listMessages(draft.id).items
      .find(message => message.id === 'message-plain')
    expect(record).toMatchObject({ content: '请继续' })
    expect(record?.mentions).toBeUndefined()
  })


  it('drops the relay copies an earlier bug stored as room messages', async () => {
    const { service } = createHarness()
    const teamId = await teamWithLeader(service)
    const conversation = await activeConversation(service, teamId)
    const note = (id: string, content: string) => ({
      schemaVersion: 1 as const,
      id,
      teamId,
      conversationId: conversation.id,
      mentions: ['slot-1'],
      sender: { kind: 'user' as const, id: 'local-user' },
      recipient: { kind: 'broadcast' as const },
      type: 'instruction' as const,
      content,
      attachments: [],
      deliveryState: 'delivered' as const,
      createdAt: new Date().toISOString(),
      idempotencyKey: id,
    })
    await service.putRuntimeMessage(note('message-keep', '@LD 你会分配任务吗'))
    await service.putRuntimeMessage(note(
      'message-echo',
      '[会议室] 团队会议室有新消息，请在会议室中回应。\n@LD 你会分配任务吗',
    ))

    await expect(service.dropRoomRelayEchoes(teamId)).resolves.toBe(1)

    expect(service.listMessages(teamId).items.map(message => message.id))
      .toEqual(['message-keep'])
  })

  it('keeps a message the room itself recorded exactly once', async () => {
    const { ctx, service, store, agents } = createHarness()
    const teamId = await teamWithLeader(service)
    await store.updateTeam(teamId, current => ({ ...current, state: 'active' }))
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    await service.createConversationRecord(teamId, {
      sessionId: 'session-room',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/agent-team-workspace',
    })
    agents.roots.set('session-room', fakeLeaderAgent('session-room', '/tmp/agent-team-workspace'))

    ctx.emit('session/event', { id: 'session-room' } as never, {
      type: 'user/message',
      seq: 1,
      time: Date.now(),
      data: {
        id: 'message-room',
        content: [{ type: 'text', text: '你好' }],
        source: { kind: 'user' },
      },
    } as never)
    await new Promise(resolve => setTimeout(resolve, 0))
    // The same event arriving twice (a live echo and a replay) records once.
    ctx.emit('session/event', { id: 'session-room' } as never, {
      type: 'user/message',
      seq: 1,
      time: Date.now(),
      data: {
        id: 'message-room',
        content: [{ type: 'text', text: '你好' }],
        source: { kind: 'user' },
      },
    } as never)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(service.listMessages(teamId).items.filter(message => message.id === 'message-room'))
      .toHaveLength(1)
  })

  it('names the real state when a team genuinely cannot take a message', async () => {
    const { ctx, service, store, agents } = createHarness()
    const teamId = await teamWithLeader(service)
    const conversation = await service.createConversationRecord(teamId, {
      sessionId: 'session-deleting',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/agent-team-workspace',
    })
    agents.roots.set('session-deleting', fakeLeaderAgent('session-deleting', '/tmp/agent-team-workspace'))
    await store.updateTeam(teamId, current => ({ ...current, state: 'deleting' }))
    const runtime = new TeamRuntime(ctx, config, service)

    await expect(runtime.sendRoomMessage(teamId, '你好', conversation.id)).rejects.toMatchObject({
      code: 'TEAM_NOT_ACTIVE',
      message: expect.stringContaining("'deleting'"),
    })
  })

  it('creates a team with no workspace and takes the bound Session one', async () => {
    const { ctx, service } = createHarness()
    const teamId = await teamWithLeader(service)
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)

    expect(service.getTeam(teamId).workspaceId).toBeUndefined()

    const conversation = await bindTeam(service, teamId, 'session-1')

    expect(conversationWorkspace(service.getTeam(teamId), conversation)).toEqual({
      id: 'workspace-1',
      path: '/tmp/agent-team-workspace',
    })
  })
})
