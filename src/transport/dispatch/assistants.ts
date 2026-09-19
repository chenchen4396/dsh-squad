import type { AgentTeamMethod } from '../contracts.js'
import { parsePayload } from '../payload-schemas.js'
import type { DispatchHandler } from './types.js'
import type { AgentTeamService } from '../../service/agent-team-service.js'
import type { RuleDocumentCatalogView } from '../contracts.js'

/** Assistant templates, and the rule documents they load. */
export const TABLE: Partial<Record<AgentTeamMethod, DispatchHandler>> = {
  'assistant.list': (ctx) => {
  return ctx.service.listAssistants()},
  'assistant.get': (ctx) => {
  return ctx.service.getAssistant(parsePayload('assistant.get', ctx.rawPayload).id)},
  'assistant.create': (ctx) => {
  return ctx.service.createAssistant(ctx.rawPayload as never)},
  'assistant.update': (ctx) => {
      const payload = parsePayload('assistant.update', ctx.rawPayload)
      return ctx.service.updateAssistant(payload.id, payload.value as never, ctx.options)
    },
  'assistant.clone': (ctx) => {
      const payload = parsePayload('assistant.clone', ctx.rawPayload)
      return ctx.service.cloneAssistant(payload.id, payload.name)
    },
  'assistant.delete': async (ctx) => {
  await ctx.service.deleteAssistant(parsePayload('assistant.delete', ctx.rawPayload).id); return null},
  'assistant.ruleDocuments.list': (ctx) => {
  return documentCatalog(ctx.service)},
  'assistant.ruleDocuments.get': (ctx) => {
      const payload = parsePayload('assistant.ruleDocuments.get', ctx.rawPayload)
      const document = ctx.service.getRuleDocument(payload.id)
      return {
        id: document.id,
        path: document.path,
        title: document.title,
        fileName: document.fileName,
        bytes: document.bytes,
        importedAt: document.importedAt,
        content: document.content,
      }
    },
  'assistant.ruleDocuments.import': async (ctx) => {
      const payload = parsePayload('assistant.ruleDocuments.import', ctx.rawPayload)
      await ctx.service.importRuleDocument(payload.path, payload.content)
      return documentCatalog(ctx.service)
    },
  'assistant.ruleDocuments.delete': async (ctx) => {
      const payload = parsePayload('assistant.ruleDocuments.delete', ctx.rawPayload)
      await ctx.service.deleteRuleDocument(payload.id)
      return documentCatalog(ctx.service)
    },
}

/**
 * The rule-document catalog: what an assistant can load, and how large one may
 * be. Deliberately without the document bodies, which the editor reads one at a
 * time when it needs them.
 */
function documentCatalog(service: AgentTeamService): RuleDocumentCatalogView {
  const { items } = service.listRuleDocuments()
  return {
    items: items.map(document => ({
      id: document.id,
      path: document.path,
      title: document.title,
      fileName: document.fileName,
      bytes: document.bytes,
      importedAt: document.importedAt,
    })),
    total: items.length,
    limitBytes: service.ruleDocumentLimit(),
  }
}
