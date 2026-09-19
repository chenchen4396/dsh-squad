import type { AgentTeamMethod } from '../contracts.js'
import { parsePayload } from '../payload-schemas.js'
import type { DispatchHandler } from './types.js'

/** A team running in a Session: its room, its messages, and the workbench. */
export const TABLE: Partial<Record<AgentTeamMethod, DispatchHandler>> = {
  'team.message.list': (ctx) => {
  return ctx.service.listMessages(parsePayload('team.message.list', ctx.rawPayload).id)},
  'team.message.send': (ctx) => {
      const payload = parsePayload('team.message.send', ctx.rawPayload)
      return ctx.service.sendUserMessage(
        payload.teamId,
        payload.conversationId,
        payload.content,
        payload.targetSlotId,
      )
    },
  'team.workbench.get': (ctx) => {
      const payload = parsePayload('team.workbench.get', ctx.rawPayload)
      return ctx.service.getWorkbench(payload.id, payload.conversationId)
    },
  'team.workbench.older': (ctx) => {
      const payload = parsePayload('team.workbench.older', ctx.rawPayload)
      return ctx.service.getOlderMemberConversation(
        payload.id,
        payload.conversationId,
        payload.slotId,
        payload.beforeSeq,
      )
    },
  'team.session.get': (ctx) => {
      const payload = parsePayload('team.session.get', ctx.rawPayload)
      const conversation = ctx.service.findConversationBySession(payload.sessionId)
      if (conversation === undefined) return { sessionId: payload.sessionId }
      return {
        sessionId: payload.sessionId,
        team: ctx.service.getTeam(conversation.teamId),
        conversation,
      }
    },
  'team.session.bind': async (ctx) => {
      const payload = parsePayload('team.session.bind', ctx.rawPayload)
      const conversation = await ctx.service.bindSession(payload.sessionId, payload.teamId)
      return { sessionId: payload.sessionId, team: ctx.service.getTeam(conversation.teamId), conversation }
    },
  'team.session.unbind': async (ctx) => {
      const payload = parsePayload('team.session.unbind', ctx.rawPayload)
      await ctx.service.unbindSession(payload.sessionId)
      return { accepted: true }
    },
  'team.session.delegate': async (ctx) => {
      const payload = parsePayload('team.session.delegate', ctx.rawPayload)
      const conversation = await ctx.service.setSessionDelegation(payload.sessionId, payload.delegate)
      return { sessionId: payload.sessionId, team: ctx.service.getTeam(conversation.teamId), conversation }
    },
  'team.conversation.list': (ctx) => {
      const payload = parsePayload('team.conversation.list', ctx.rawPayload)
      return ctx.service.listConversations(payload.teamId)
    },
  'team.room.get': (ctx) => {
      const payload = parsePayload('team.room.get', ctx.rawPayload)
      return ctx.service.getRoom(payload.teamId, payload.conversationId)
    },
  'team.room.older': (ctx) => {
      const payload = parsePayload('team.room.older', ctx.rawPayload)
      return ctx.service.getRoom(payload.teamId, payload.conversationId, payload.beforeTime)
    },
  'team.room.send': (ctx) => {
      const payload = parsePayload('team.room.send', ctx.rawPayload)
      return ctx.service.sendRoomMessage(
        payload.teamId,
        payload.content,
        payload.conversationId,
        payload.mentions ?? [],
      )
    },
  'team.interaction.respond': async (ctx) => {
      const payload = parsePayload('team.interaction.respond', ctx.rawPayload)
      await ctx.service.respondToInteraction(
        payload.teamId,
        payload.slotId,
        payload.interactionId,
        payload.response.kind === 'approval'
          ? payload.response
          : {
            kind: 'question',
            answers: payload.response.answers.map(answer => ({
              id: answer.id,
              selected: answer.selected,
              ...(answer.custom === undefined ? {} : { custom: answer.custom }),
            })),
          },
        payload.conversationId,
      )
      return { accepted: true }
    },
}
