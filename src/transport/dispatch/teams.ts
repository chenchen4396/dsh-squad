import type { AgentTeamMethod } from '../contracts.js'
import { parsePayload } from '../payload-schemas.js'
import type { DispatchHandler } from './types.js'

/** Teams and their membership. */
export const TABLE: Partial<Record<AgentTeamMethod, DispatchHandler>> = {
  'team.list': (ctx) => {
  return ctx.service.listTeams()},
  'team.get': (ctx) => {
  return ctx.service.getTeam(parsePayload('team.get', ctx.rawPayload).id)},
  'team.createDraft': (ctx) => {
  return ctx.service.createTeamDraft(ctx.rawPayload as never)},
  'team.clone': (ctx) => {
      const payload = parsePayload('team.clone', ctx.rawPayload)
      return ctx.service.cloneTeam(payload.teamId, { name: payload.name })
    },
  'team.start': (ctx) => {
  return ctx.service.startTeam(parsePayload('team.start', ctx.rawPayload).id, ctx.options)},
  'team.addMember': (ctx) => {
      const payload = parsePayload('team.addMember', ctx.rawPayload)
      return ctx.service.addMember(payload.teamId, payload.value as never, ctx.options)
    },
  'team.removeMember': (ctx) => {
      const payload = parsePayload('team.removeMember', ctx.rawPayload)
      return ctx.service.removeMember(payload.teamId, payload.slotId, ctx.options)
    },
  'team.changeLeader': (ctx) => {
      const payload = parsePayload('team.changeLeader', ctx.rawPayload)
      return ctx.service.changeLeader(payload.teamId, payload.successorSlotId, ctx.options)
    },
  'team.member.stop': async (ctx) => {
      const payload = parsePayload('team.member.stop', ctx.rawPayload)
      await ctx.service.stopMember(payload.teamId, payload.slotId, payload.conversationId)
      return { accepted: true }
    },
  'team.dissolve': async (ctx) => {
      const payload = parsePayload('team.dissolve', ctx.rawPayload)
      await ctx.service.dissolveTeam(payload.teamId, payload.confirmation, ctx.options)
      return null
    },
}
