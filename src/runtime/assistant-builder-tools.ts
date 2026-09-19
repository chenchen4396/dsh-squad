import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { AgentTeamError } from '../domain/errors.js'
import type { AgentTeamService } from '../service/agent-team-service.js'
import type { AssistantDraftStore } from './assistant-builder-drafts.js'

/**
 * The tools the assistant designer may call.
 *
 * Three of them, and the order matters: read the catalog to find exact ids,
 * prepare a draft to have it validated and held, then commit only after a
 * later real user message approves it. Keeping them together makes that
 * sequence readable in one place instead of spread through the runtime that
 * hosts them.
 */
export interface AssistantBuilderToolDeps {
  service: AgentTeamService
  drafts: AssistantDraftStore
  assertIdentity: (agentId: unknown, sessionId: string) => void
}

export function registerAssistantBuilderTools(
agentCtx: Context,
sessionId: string,
deps: AssistantBuilderToolDeps,
): void {
  agentCtx.tools.register(defineTool({
    name: 'assistant_builder_get_catalog',
    description: 'Read exact creation options. Pass provider and model after choosing a model to read its reasoning efforts. Pass agentPresetId to read its Skills and MCP Servers.',
    parameters: {
      provider: { type: 'string', description: 'Chosen Provider id; pass together with model.' },
      model: { type: 'string', description: 'Chosen model id; pass together with provider.' },
      agentPresetId: { type: 'string', description: 'Chosen Agent Preset id used to discover available Skills and MCP Servers.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      deps.assertIdentity(exec.agent?.id, sessionId)
      const catalog = await deps.service.catalog()
      const skillCatalog = args.agentPresetId === undefined
        ? undefined
        : await deps.service.skillCatalog(args.agentPresetId)
      const mcpCatalog = args.agentPresetId === undefined
        ? undefined
        : await deps.service.mcpCatalog(args.agentPresetId)
      if ((args.provider === undefined) !== (args.model === undefined)) {
        throw new AgentTeamError('INVALID_REQUEST', 'Provider and model must be supplied together')
      }
      const modelCapabilities = args.provider === undefined || args.model === undefined
        ? undefined
        : await deps.service.modelCapabilities(args.provider, args.model)
      return {
        providers: catalog.providers.map(provider => ({ id: provider.id, name: provider.name })),
        models: catalog.models,
        agentPresets: catalog.agentPresets.filter(preset => preset.broken === undefined),
        permissionPresets: catalog.permissionPresets.map(preset => ({
          value: preset.value,
          name: preset.name,
          ...(preset.description === undefined ? {} : { description: preset.description }),
        })),
        existingAssistants: deps.service.listAssistants().items.map(assistant => assistant.name),
        ...(modelCapabilities === undefined ? {} : {
          modelCapabilities: {
            provider: modelCapabilities.provider,
            model: modelCapabilities.model,
            ...(modelCapabilities.reasoning === undefined ? {} : {
              reasoning: {
                efforts: modelCapabilities.reasoning.efforts.map(effort => ({ ...effort })),
                ...(modelCapabilities.reasoning.defaultEffort === undefined
                  ? {}
                  : { defaultEffort: modelCapabilities.reasoning.defaultEffort }),
              },
            }),
          },
        }),
        ...(skillCatalog === undefined ? {} : { skills: skillCatalog.skills }),
        ruleDocuments: deps.service.listRuleDocuments().items.map(document => ({
          id: document.id,
          title: document.title,
          fileName: document.fileName,
        })),
        ...(mcpCatalog === undefined ? {} : {
          mcpServers: mcpCatalog.servers.map(server => ({
            name: server.name,
            toolCount: server.tools.length,
            tools: server.tools,
          })),
        }),
      }
    },
  }))
  agentCtx.tools.register(defineTool({
    name: 'assistant_builder_prepare',
    description: 'Validate and temporarily store one complete assistant draft. Replaces any older draft; this tool does not create the assistant.',
    parameters: {
      name: { type: 'string', required: true, description: 'Unique, user-facing assistant name.' },
      description: { type: 'string', description: 'Short user-facing purpose.' },
      instructions: { type: 'string', required: true, description: 'Stable responsibilities, constraints, workflow, and acceptance rules.' },
      provider: { type: 'string', required: true },
      model: { type: 'string', required: true },
      reasoningEffort: {
        type: 'string',
        description: 'Optional exact reasoning effort id returned by modelCapabilities. Omit to use the model default.',
      },
      agentPresetId: { type: 'string', required: true },
      permissionPresetId: { type: 'string', required: true },
      skills: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exact Skill names explicitly selected by the user from the chosen preset catalog.',
      },
      mcpServers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exact MCP Server names explicitly selected by the user from the chosen preset catalog.',
      },
      ruleDocuments: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exact rule document ids explicitly selected by the user from the imported rule document catalog.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: `草稿“${value.name}”已校验。请展示最终配置，并等待用户在新的消息中明确同意创建；用户可使用自然语言表达，无需固定口令。`,
      }],
    },
    execute: async (args, exec) => {
      deps.assertIdentity(exec.agent?.id, sessionId)
      if (exec.agent === undefined) {
        throw new AgentTeamError('INVALID_REQUEST', 'Assistant Builder Agent is unavailable')
      }
      const input = await deps.service.validateAssistantDraft({
        name: args.name,
        ...(args.description === undefined ? {} : { description: args.description }),
        instructions: args.instructions,
        provider: args.provider,
        model: args.model,
        ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
        agentPresetId: args.agentPresetId,
        permissionPresetId: args.permissionPresetId,
        skillAllowlist: args.skills ?? [],
        mcpServers: args.mcpServers ?? [],
        ruleDocumentAllowlist: args.ruleDocuments ?? [],
      })
      deps.drafts.put(sessionId, {
        input,
        preparedThroughSeq: exec.agent.session.snapshotEvents().at(-1)?.seq ?? -1,
      })
      return {
        name: input.name,
        requiresExplicitUserConfirmation: true,
      }
    },
  }))
  agentCtx.tools.register(defineTool({
    name: 'assistant_builder_commit',
    description: 'Create the currently prepared assistant only after a later, real user message clearly approves the final configuration. Natural-language approval is allowed; ambiguity, rejection, questions, or requested changes are not approval.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          revision: { type: 'number', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `助手“${value.name}”已创建。` }],
    },
    execute: async (_args, exec) => {
      deps.assertIdentity(exec.agent?.id, sessionId)
      if (exec.agent === undefined) {
        throw new AgentTeamError('INVALID_REQUEST', 'Assistant Builder Agent is unavailable')
      }
      const pending = deps.drafts.get(sessionId)
      if (pending === undefined) {
        throw new AgentTeamError(
          'INVALID_REQUEST',
          '没有等待确认的助手草稿，请先重新校验草稿',
        )
      }
      if (!hasFreshAssistantDraftUserResponse(
        exec.agent.session.snapshotEvents(),
        pending.preparedThroughSeq,
      )) {
        throw new AgentTeamError(
          'INVALID_REQUEST',
          '必须等待用户在新的消息中明确同意当前助手配置',
        )
      }
      const assistant = await deps.service.createAssistant(pending.input)
      deps.drafts.discard(sessionId, pending)
      return { id: assistant.id, name: assistant.name, revision: assistant.revision }
    },
  }))
}

/**
 * Whether the user has spoken since the draft was prepared.
 *
 * Approval has to be a new message: an older "yes" in the transcript — for a
 * different draft, or before this one was shown — must not count. Only a real
 * user message does; a tool result or a relayed note is not the user speaking.
 */
export function hasFreshAssistantDraftUserResponse(
  events: readonly SessionEvent[],
  preparedThroughSeq: number,
): boolean {
  const latestUserMessage = events.findLast(event => (
    event.seq > preparedThroughSeq
    && event.type === 'user/message'
    && event.data.source.kind === 'user'
  ))
  return latestUserMessage?.type === 'user/message'
}
