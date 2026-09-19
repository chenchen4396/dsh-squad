import type { AgentTeamMethod } from '../contracts.js'
import { interactionResponseOf, parsePayload } from '../payload-schemas.js'
import type { DispatchHandler } from './types.js'

/** The chat that designs an assistant. */
export const TABLE: Partial<Record<AgentTeamMethod, DispatchHandler>> = {
  'assistant.builder.list': (ctx) => {
  return ctx.service.listAssistantBuilderConversations()},
  'assistant.builder.draft.get': (ctx) => {
  return ctx.service.getAssistantBuilderDraft()},
  'assistant.builder.draft.configure': (ctx) => {
      const payload = parsePayload('assistant.builder.draft.configure', ctx.rawPayload)
      return ctx.service.configureAssistantBuilderDraft(payload.provider, payload.model)
    },
  'assistant.builder.start': (ctx) => {
      const payload = parsePayload('assistant.builder.start', ctx.rawPayload)
      return ctx.service.startAssistantBuilderConversation(payload.provider, payload.model, payload.content)
    },
  'assistant.builder.get': (ctx) => {
      const payload = parsePayload('assistant.builder.get', ctx.rawPayload)
      return ctx.service.getAssistantBuilderConversation(payload.sessionId)
    },
  'assistant.builder.configure': (ctx) => {
      const payload = parsePayload('assistant.builder.configure', ctx.rawPayload)
      return ctx.service.configureAssistantBuilder(payload.sessionId, payload.provider, payload.model)
    },
  'assistant.builder.send': (ctx) => {
      const payload = parsePayload('assistant.builder.send', ctx.rawPayload)
      return ctx.service.sendAssistantBuilderMessage(payload.sessionId, payload.content)
    },
  'assistant.builder.interaction.respond': async (ctx) => {
      const payload = parsePayload('assistant.builder.interaction.respond', ctx.rawPayload)
      await ctx.service.respondToAssistantBuilderInteraction(
        payload.sessionId,
        payload.interactionId,
        interactionResponseOf(payload.response),
      )
      return { accepted: true }
    },
  'assistant.builder.stop': async (ctx) => {
      const payload = parsePayload('assistant.builder.stop', ctx.rawPayload)
      await ctx.service.stopAssistantBuilder(payload.sessionId)
      return { accepted: true }
    },
  'assistant.builder.archive': async (ctx) => {
      const payload = parsePayload('assistant.builder.archive', ctx.rawPayload)
      await ctx.service.archiveAssistantBuilderConversation(payload.sessionId)
      return { archived: true }
    },
}
