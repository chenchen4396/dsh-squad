import { randomUUID } from 'node:crypto'
import { AgentTeamError } from '../domain/errors.js'
import { isMarkdownRulePath, markdownRuleExtensions } from '../domain/rule-format.js'
import type { AssistantTemplate, Page, RuleDocument } from '../domain/types.js'
import type { AgentTeamStore } from '../storage/store.js'

/**
 * Imported rule documents: whole files an assistant loads alongside its
 * instructions.
 *
 * They are their own small domain — a store, a size limit, and the two facts
 * that importing twice updates in place and deleting one releases every
 * assistant that pointed at it. The service keeps one-line methods that call
 * these, so nothing else has to know where the domain lives.
 */
export interface RuleDocumentDeps {
  store: AgentTeamStore
  /** Largest request body this deployment accepts, which caps one document. */
  maxRequestBytes: number
  activity: (kind: string, entityId: string, revision: number, summary: string) => Promise<void>
  publish: (entityType: 'rule-document', entityId: string, revision: number, kind: string) => void
  refreshAssistantSettings: (assistant: AssistantTemplate) => void
}

export function listRuleDocuments(store: AgentTeamStore): Page<RuleDocument> {
  const items = store.listRuleDocuments()
  return { items, total: items.length }
}

export function getRuleDocument(store: AgentTeamStore, id: string): RuleDocument {
  const document = store.getRuleDocument(id)
  if (document === undefined) {
    throw new AgentTeamError('RULE_REFERENCE_INVALID', `Unknown rule document '${id}'`)
  }
  return document
}

/** Largest single document this deployment accepts, given the request cap. */
export function ruleDocumentLimit(maxRequestBytes: number): number {
  // The body carries the whole document plus a small JSON envelope, so the
  // document itself has to stay clear of `maxRequestBytes`; otherwise the
  // transport rejects it before the readable error below can be produced.
  return Math.max(4 * 1024, maxRequestBytes - 4 * 1024)
}

/**
 * Import one document file, stored whole and never split into rules.
 *
 * Only Markdown is accepted, so a folder import can never pull an unrelated
 * file into a member's prompt. Re-importing the same `path` updates the
 * document in place and keeps its id, so refreshing an imported folder never
 * invalidates the assistants that already selected those documents.
 */
export async function importRuleDocument(
deps: RuleDocumentDeps,
rawPath: string,
content: string,
): Promise<RuleDocument> {
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
  const limit = ruleDocumentLimit(deps.maxRequestBytes)
  if (bytes > limit) {
    throw new AgentTeamError(
      'RULE_REFERENCE_INVALID',
      `规则文档「${path}」有 ${Math.round(bytes / 1024)} KB，超过 ${Math.round(limit / 1024)} KB 上限`,
      { path, bytes, limit },
    )
  }
  const fileName = path.slice(path.lastIndexOf('/') + 1)
  const existing = deps.store.listRuleDocuments().find(document => document.path === path)
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
  await deps.store.putRuleDocument(document)
  await deps.activity(
    'assistant.rule_imported',
    document.id,
    1,
    `Rule document ${document.path} ${existing === undefined ? 'imported' : 'updated'}`,
  )
  deps.publish('rule-document', document.id, 1, 'assistant.rule_imported')
  return document
}

/**
 * Delete a document and drop it from every assistant that selected it, so no
 * assistant is left pointing at a document that no longer exists.
 */
export async function deleteRuleDocument(deps: RuleDocumentDeps, id: string): Promise<void> {
  const document = getRuleDocument(deps.store, id)
  const owners = deps.store.listAssistants()
    .filter(assistant => assistant.ruleDocumentAllowlist.includes(id))
  for (const assistant of owners) {
    await deps.store.updateAssistant(assistant.id, current => ({
      ...current,
      ruleDocumentAllowlist: current.ruleDocumentAllowlist.filter(value => value !== id),
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    }))
  }
  await deps.store.deleteRuleDocument(id)
  for (const assistant of owners) {
    const next = deps.store.getAssistant(assistant.id)
    if (next !== undefined) deps.refreshAssistantSettings(next)
  }
  await deps.activity(
    'assistant.rule_deleted',
    document.id,
    1,
    `Rule document ${document.fileName} deleted`,
  )
  deps.publish('rule-document', document.id, 1, 'assistant.rule_deleted')
}

/**
 * A readable name for an imported document: its first Markdown heading, or the
 * file name when the document has no heading.
 */
function ruleDocumentTitle(content: string, fileName: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(content)?.[1]?.trim()
  return heading !== undefined && heading.length > 0 ? heading.slice(0, 120) : fileName
}


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

