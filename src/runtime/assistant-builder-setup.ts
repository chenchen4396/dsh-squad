import type { Context } from '@deepseek-ai/cordis'
import { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import { AgentTeamError } from '../domain/errors.js'
import type { AgentTeamService } from '../service/agent-team-service.js'
import type { AssistantDraftStore } from './assistant-builder-drafts.js'
import { registerAssistantBuilderTools } from './assistant-builder-tools.js'
import type { TeamInteractionBridge } from './team-interaction-bridge.js'
import { ASSISTANT_BUILDER_PROMPT } from './assistant-builder-runtime.js'

/** The configuration one builder conversation runs with. */
export interface AssistantBuilderConfiguration {
  provider: string
  model: string
  agentPresetId: string
  permissionPresetId: string
}

/**
 * What the Assistant Builder's own Agent is given.
 *
 * The designer is an Agent like any other, with the narrowest scope in the
 * plugin: it may read the catalog, prepare a draft and commit a confirmed one,
 * and nothing else. That restriction is the point — this Agent exists so the
 * reader can describe an assistant in prose, and a builder that could edit
 * anything else would be a second, unaccountable way to change the plugin's
 * state.
 */

/** What the builder's setup needs from the runtime that owns it. */
export interface BuilderSetupDeps {
  ctx: Context
  service: AgentTeamService
  drafts: AssistantDraftStore
  interactions: TeamInteractionBridge
  assertToolIdentity: (id: unknown, sessionId: string) => void
}

/** One conversation's builder Agent, as it is being created. */
export interface BuilderSetupArgs {
  sessionId: string
  configuration: AssistantBuilderConfiguration
  cwd: string
}

/** The tools the builder is allowed, and nothing outside this list. */
const ALLOWED_TOOLS = new Set([
  'assistant_builder_get_catalog',
  'assistant_builder_prepare',
  'assistant_builder_commit',
  'ask_user_question',
])

export function assistantBuilderSetup(
  deps: BuilderSetupDeps,
  args: BuilderSetupArgs,
): (agentCtx: Context, agent: Agent) => Promise<void> {
  return async (agentCtx, agent) => {
  deps.interactions.attach(agentCtx, agent)
  await deps.ctx.agentPresets.mount(agentCtx, args.configuration.agentPresetId)
  agentCtx.tools.presentAs('native')
  if (agent.session.header.cwd === undefined) {
    agentCtx.systemPrompt.variable('cwd', () => args.cwd)
  }
  const allowedTools = new Set([
    'assistant_builder_get_catalog',
    'assistant_builder_prepare',
    'assistant_builder_commit',
    'ask_user_question',
  ])
  agentCtx.tools.guard(execution => allowedTools.has(execution.name)
    ? undefined
    : 'The built-in Assistant Builder may only read its catalog, prepare a draft, and commit an explicitly confirmed draft.')
  registerAssistantBuilderTools(agentCtx, args.sessionId, {
    service: deps.service,
    drafts: deps.drafts,
    assertIdentity: (id, target) => { deps.assertToolIdentity(id, target) },
  })
  const deniedTools = agentCtx.tools.schemas(agent)
    .map(tool => tool.name)
    .filter(name => !allowedTools.has(name))
  if (deniedTools.length > 0) agentCtx.tools.restrict({ deny: deniedTools })
  const promptSection = 'agent-team:assistant-builder'
  agentCtx.systemPrompt.section({
    name: promptSection,
    order: 10,
    text: ASSISTANT_BUILDER_PROMPT,
  })
  deps.ctx.permissionPresets.set(agent.session, args.configuration.permissionPresetId)
  const assembly = await agentCtx.systemPrompt.assemble(assembleContextFor(agent))
  if (!assembly.sections.some(section => section.name === promptSection)) {
    throw new AgentTeamError(
      'PRESET_PROMPT_INCOMPATIBLE',
      `Preset '${args.configuration.agentPresetId}' replaced the Assistant Builder prompt`,
    )
  }
  }
}
