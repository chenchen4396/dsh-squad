import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { Config } from '../config.js'
import { interactionResponseSchema, PAYLOAD_SCHEMAS, parsePayload } from './payload-schemas.js'
import { AgentTeamError, isAgentTeamError } from '../domain/errors.js'
import type { AgentTeamService, AgentTeamChange } from '../service/agent-team-service.js'
import {
  AGENT_TEAM_API_PATH,
  AGENT_TEAM_EVENTS_PATH,
  AGENT_TEAM_METHODS,
  AGENT_TEAM_UPLOAD_PATH,
  type AgentTeamRequest,
  type AgentTeamResponse,
  type RuleDocumentCatalogView,
} from './contracts.js'

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

const requestSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  method: z.enum(AGENT_TEAM_METHODS),
  expectedRevision: z.int().positive().optional(),
  payload: z.unknown(),
}).strict()

export interface WebTransport {
  dispose(): void
}

export function registerWebTransport(
  ctx: Context,
  config: Config,
  service: AgentTeamService,
): WebTransport {
  const clients = new Set<ServerResponse>()
  const unsubscribe = service.subscribe(change => broadcast(clients, change))
  const heartbeat = setInterval(() => {
    for (const response of clients) response.write(': heartbeat\n\n')
  }, config.sseHeartbeatMs)
  heartbeat.unref()

  const disposeApi = ctx.webServer.register({
    kind: 'exact',
    path: AGENT_TEAM_API_PATH,
    handler: async (request, response) => {
      await handleApi(request, response, config, service, ctx)
    },
  })
  const disposeEvents = ctx.webServer.register({
    kind: 'exact',
    path: AGENT_TEAM_EVENTS_PATH,
    handler: (request, response) => {
      handleEvents(request, response, clients)
    },
  })
  const disposeUpload = ctx.webServer.register({
    kind: 'exact',
    path: AGENT_TEAM_UPLOAD_PATH,
    handler: async (request, response) => {
      await handleUpload(request, response, service, ctx)
    },
  })

  return {
    dispose() {
      disposeUpload()
      disposeEvents()
      disposeApi()
      unsubscribe()
      clearInterval(heartbeat)
      for (const response of clients) response.end()
      clients.clear()
    },
  }
}

async function handleUpload(
  request: IncomingMessage,
  response: ServerResponse,
  service: AgentTeamService,
  ctx: Context,
): Promise<void> {
  const requestId = headerValue(request.headers['x-agent-team-request-id']) ?? 'unknown'
  if (request.method !== 'POST') {
    writeJson(response, 405, failure(requestId, 'METHOD_NOT_ALLOWED', 'Only POST is supported'))
    return
  }
  if (!sameOrigin(request)) {
    writeJson(response, 403, failure(requestId, 'ORIGIN_REJECTED', 'Cross-origin requests are not allowed'))
    return
  }
  try {
    const url = new URL(request.url ?? AGENT_TEAM_UPLOAD_PATH, `http://${request.headers.host ?? 'localhost'}`)
    const teamId = url.searchParams.get('teamId')?.trim()
    const conversationId = url.searchParams.get('conversationId')?.trim() || undefined
    const encodedName = headerValue(request.headers['x-agent-team-file-name'])
    if (!teamId || !encodedName) throw new AgentTeamError('INVALID_REQUEST', 'Team id and file name are required')
    let fileName: string
    try {
      fileName = decodeURIComponent(encodedName)
    } catch {
      throw new AgentTeamError('INVALID_REQUEST', 'File name encoding is invalid')
    }
    const data = await readBytes(request, MAX_UPLOAD_BYTES)
    const value = await service.uploadWorkspaceFile(teamId, conversationId, fileName, data)
    writeJson(response, 200, { requestId, ok: true, value })
  } catch (error) {
    if (!isAgentTeamError(error)) {
      ctx.logger.error('agent-team: unhandled upload error', error)
    }
    const normalized = normalizeError(requestId, error)
    const status = normalized.error.code.endsWith('_NOT_FOUND') ? 404 : 400
    writeJson(response, status, normalized)
  }
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  config: Config,
  service: AgentTeamService,
  ctx: Context,
): Promise<void> {
  if (request.method !== 'POST') {
    writeJson(response, 405, failure('unknown', 'METHOD_NOT_ALLOWED', 'Only POST is supported'))
    return
  }
  if (!sameOrigin(request)) {
    writeJson(response, 403, failure('unknown', 'ORIGIN_REJECTED', 'Cross-origin requests are not allowed'))
    return
  }
  const contentType = request.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    writeJson(response, 415, failure('unknown', 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'))
    return
  }

  let parsed: AgentTeamRequest
  try {
    const body = await readJson(request, config.maxRequestBytes)
    parsed = requestSchema.parse(body) as AgentTeamRequest
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request'
    writeJson(response, 400, failure('unknown', 'INVALID_REQUEST', message))
    return
  }

  try {
    const value = await dispatch(service, parsed)
    writeJson(response, 200, { requestId: parsed.requestId, ok: true, value })
  } catch (error) {
    if (!isAgentTeamError(error) && !(error instanceof z.ZodError)) {
      ctx.logger.error('agent-team: unhandled API error', error)
    }
    const normalized = normalizeError(parsed.requestId, error)
    const status = normalized.error.code.endsWith('_NOT_FOUND') ? 404
      : normalized.error.code.includes('REVISION_CONFLICT') ? 409
        : 400
    writeJson(response, status, normalized)
  }
}

function handleEvents(
  request: IncomingMessage,
  response: ServerResponse,
  clients: Set<ServerResponse>,
): void {
  if (request.method !== 'GET') {
    writeJson(response, 405, failure('unknown', 'METHOD_NOT_ALLOWED', 'Only GET is supported'))
    return
  }
  if (!sameOrigin(request)) {
    writeJson(response, 403, failure('unknown', 'ORIGIN_REJECTED', 'Cross-origin requests are not allowed'))
    return
  }
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  })
  response.write('retry: 2000\n\n')
  clients.add(response)
  const close = () => { clients.delete(response) }
  request.once('close', close)
  response.once('close', close)
}

async function dispatch(service: AgentTeamService, request: AgentTeamRequest): Promise<unknown> {
  const options = request.expectedRevision === undefined
    ? {}
    : { expectedRevision: request.expectedRevision }
  switch (request.method) {
    case 'catalog.get': return service.catalog()
    case 'catalog.model.get': {
      const payload = parsePayload('catalog.model.get', request.payload)
      return service.modelCapabilities(payload.provider, payload.model)
    }
    case 'skill.catalog': {
      const payload = parsePayload('skill.catalog', request.payload)
      return service.skillCatalog(payload.agentPresetId)
    }
    case 'mcp.catalog': {
      const payload = parsePayload('mcp.catalog', request.payload)
      return service.mcpCatalog(payload.agentPresetId)
    }
    case 'assistant.list': return service.listAssistants()
    case 'assistant.get': return service.getAssistant(parsePayload('assistant.get', request.payload).id)
    case 'assistant.create': return service.createAssistant(request.payload as never)
    case 'assistant.update': {
      const payload = parsePayload('assistant.update', request.payload)
      return service.updateAssistant(payload.id, payload.value as never, options)
    }
    case 'assistant.clone': {
      const payload = parsePayload('assistant.clone', request.payload)
      return service.cloneAssistant(payload.id, payload.name)
    }
    case 'assistant.delete': await service.deleteAssistant(parsePayload('assistant.delete', request.payload).id); return null
    case 'assistant.builder.list': return service.listAssistantBuilderConversations()
    case 'assistant.builder.draft.get': return service.getAssistantBuilderDraft()
    case 'assistant.builder.draft.configure': {
      const payload = parsePayload('assistant.builder.draft.configure', request.payload)
      return service.configureAssistantBuilderDraft(payload.provider, payload.model)
    }
    case 'assistant.builder.start': {
      const payload = parsePayload('assistant.builder.start', request.payload)
      return service.startAssistantBuilderConversation(payload.provider, payload.model, payload.content)
    }
    case 'assistant.builder.get': {
      const payload = parsePayload('assistant.builder.get', request.payload)
      return service.getAssistantBuilderConversation(payload.sessionId)
    }
    case 'assistant.builder.configure': {
      const payload = parsePayload('assistant.builder.configure', request.payload)
      return service.configureAssistantBuilder(payload.sessionId, payload.provider, payload.model)
    }
    case 'assistant.builder.send': {
      const payload = parsePayload('assistant.builder.send', request.payload)
      return service.sendAssistantBuilderMessage(payload.sessionId, payload.content)
    }
    case 'assistant.builder.interaction.respond': {
      const payload = parsePayload('assistant.builder.interaction.respond', request.payload)
      await service.respondToAssistantBuilderInteraction(
        payload.sessionId,
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
      )
      return { accepted: true }
    }
    case 'assistant.builder.stop': {
      const payload = parsePayload('assistant.builder.stop', request.payload)
      await service.stopAssistantBuilder(payload.sessionId)
      return { accepted: true }
    }
    case 'assistant.builder.archive': {
      const payload = parsePayload('assistant.builder.archive', request.payload)
      await service.archiveAssistantBuilderConversation(payload.sessionId)
      return { archived: true }
    }
    case 'team.list': return service.listTeams()
    case 'team.get': return service.getTeam(parsePayload('team.get', request.payload).id)
    case 'team.createDraft': return service.createTeamDraft(request.payload as never)
    case 'team.clone': {
      const payload = parsePayload('team.clone', request.payload)
      return service.cloneTeam(payload.teamId, { name: payload.name })
    }
    case 'team.start': return service.startTeam(parsePayload('team.start', request.payload).id, options)
    case 'team.addMember': {
      const payload = parsePayload('team.addMember', request.payload)
      return service.addMember(payload.teamId, payload.value as never, options)
    }
    case 'team.removeMember': {
      const payload = parsePayload('team.removeMember', request.payload)
      return service.removeMember(payload.teamId, payload.slotId, options)
    }
    case 'team.changeLeader': {
      const payload = parsePayload('team.changeLeader', request.payload)
      return service.changeLeader(payload.teamId, payload.successorSlotId, options)
    }
    case 'team.message.list': return service.listMessages(parsePayload('team.message.list', request.payload).id)
    case 'team.message.send': {
      const payload = parsePayload('team.message.send', request.payload)
      return service.sendUserMessage(
        payload.teamId,
        payload.conversationId,
        payload.content,
        payload.targetSlotId,
      )
    }
    case 'team.workbench.get': {
      const payload = parsePayload('team.workbench.get', request.payload)
      return service.getWorkbench(payload.id, payload.conversationId)
    }
    case 'team.workbench.older': {
      const payload = parsePayload('team.workbench.older', request.payload)
      return service.getOlderMemberConversation(
        payload.id,
        payload.conversationId,
        payload.slotId,
        payload.beforeSeq,
      )
    }
    case 'team.session.get': {
      const payload = parsePayload('team.session.get', request.payload)
      const conversation = service.findConversationBySession(payload.sessionId)
      if (conversation === undefined) return { sessionId: payload.sessionId }
      return {
        sessionId: payload.sessionId,
        team: service.getTeam(conversation.teamId),
        conversation,
      }
    }
    case 'team.session.bind': {
      const payload = parsePayload('team.session.bind', request.payload)
      const conversation = await service.bindSession(payload.sessionId, payload.teamId)
      return { sessionId: payload.sessionId, team: service.getTeam(conversation.teamId), conversation }
    }
    case 'team.session.unbind': {
      const payload = parsePayload('team.session.unbind', request.payload)
      await service.unbindSession(payload.sessionId)
      return { accepted: true }
    }
    case 'team.session.delegate': {
      const payload = parsePayload('team.session.delegate', request.payload)
      const conversation = await service.setSessionDelegation(payload.sessionId, payload.delegate)
      return { sessionId: payload.sessionId, team: service.getTeam(conversation.teamId), conversation }
    }
    case 'team.conversation.list': {
      const payload = parsePayload('team.conversation.list', request.payload)
      return service.listConversations(payload.teamId)
    }
    case 'team.room.get': {
      const payload = parsePayload('team.room.get', request.payload)
      return service.getRoom(payload.teamId, payload.conversationId)
    }
    case 'team.room.older': {
      const payload = parsePayload('team.room.older', request.payload)
      return service.getRoom(payload.teamId, payload.conversationId, payload.beforeTime)
    }
    case 'team.room.send': {
      const payload = parsePayload('team.room.send', request.payload)
      return service.sendRoomMessage(
        payload.teamId,
        payload.content,
        payload.conversationId,
        payload.mentions ?? [],
      )
    }
    case 'team.member.stop': {
      const payload = parsePayload('team.member.stop', request.payload)
      await service.stopMember(payload.teamId, payload.slotId, payload.conversationId)
      return { accepted: true }
    }
    case 'team.interaction.respond': {
      const payload = parsePayload('team.interaction.respond', request.payload)
      await service.respondToInteraction(
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
    }
    case 'assistant.ruleDocuments.list':
      return documentCatalog(service)
    case 'assistant.ruleDocuments.get': {
      const payload = parsePayload('assistant.ruleDocuments.get', request.payload)
      const document = service.getRuleDocument(payload.id)
      return {
        id: document.id,
        path: document.path,
        title: document.title,
        fileName: document.fileName,
        bytes: document.bytes,
        importedAt: document.importedAt,
        content: document.content,
      }
    }
    case 'assistant.ruleDocuments.import': {
      const payload = z.object({
        path: z.string().trim().min(1).max(400),
        // Bounded by the transport's own body limit; the service reports the
        // readable size error against the configured cap.
        content: z.string(),
      }).strict().parse(request.payload)
      await service.importRuleDocument(payload.path, payload.content)
      return documentCatalog(service)
    }
    case 'bundle.export': {
      const payload = parsePayload('bundle.export', request.payload)
      return service.exportBundle(payload)
    }
    case 'bundle.import': {
      // The bundle is validated inside the service, where the failure can name
      // the field that is wrong instead of the whole body being "invalid".
      const payload = z.object({ bundle: z.unknown(), mode: z.enum(['copy', 'overwrite']) })
        .strict().parse(request.payload)
      return service.importBundle(payload)
    }
    case 'assistant.ruleDocuments.delete': {
      const payload = parsePayload('assistant.ruleDocuments.delete', request.payload)
      await service.deleteRuleDocument(payload.id)
      return documentCatalog(service)
    }
    case 'team.workspace.list': {
      const payload = parsePayload('team.workspace.list', request.payload)
      return service.listWorkspace(payload.teamId, payload.conversationId, payload.path)
    }
    case 'team.workspace.search': {
      const payload = parsePayload('team.workspace.search', request.payload)
      return service.searchWorkspace(payload.teamId, payload.conversationId, payload.query, payload.limit)
    }
    case 'team.workspace.changes': {
      const payload = parsePayload('team.workspace.changes', request.payload)
      return service.getWorkspaceChanges(payload.teamId, payload.conversationId)
    }
    case 'team.workspace.diff': {
      const payload = parsePayload('team.workspace.diff', request.payload)
      return service.getWorkspaceDiff(
        payload.teamId,
        payload.conversationId,
        payload.path,
        payload.scope,
        payload.layout,
        payload.theme,
      )
    }
    case 'team.dissolve': {
      const payload = parsePayload('team.dissolve', request.payload)
      await service.dissolveTeam(payload.teamId, payload.confirmation, options)
      return null
    }
  }
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > limit) throw new AgentTeamError('INVALID_REQUEST', `Request body exceeds ${limit} bytes`)
    chunks.push(buffer)
  }
  if (chunks.length === 0) throw new AgentTeamError('INVALID_REQUEST', 'Request body is empty')
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

async function readBytes(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > limit) {
    throw new AgentTeamError('INVALID_REQUEST', `File exceeds the ${Math.floor(limit / 1024 / 1024)} MB upload limit`)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > limit) {
      throw new AgentTeamError('INVALID_REQUEST', `File exceeds the ${Math.floor(limit / 1024 / 1024)} MB upload limit`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (origin === undefined) return true
  const host = request.headers.host
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

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

function broadcast(clients: Set<ServerResponse>, change: AgentTeamChange): void {
  const event = change.entityType === 'conversation' ? 'conversation'
    : change.entityType === 'assistant-builder' ? 'assistant-builder-conversation'
      : change.entityType === 'workspace' ? 'workspace'
      : 'change'
  const frame = `id: ${change.cursor}\nevent: ${event}\ndata: ${JSON.stringify(change)}\n\n`
  for (const response of clients) response.write(frame)
}

function normalizeError(requestId: string, error: unknown): AgentTeamResponse & { ok: false } {
  if (isAgentTeamError(error)) {
    return failure(requestId, error.code, error.message, error.details)
  }
  if (error instanceof z.ZodError) {
    return failure(requestId, 'INVALID_REQUEST', 'Request validation failed', { issues: error.issues })
  }
  return failure(requestId, 'INTERNAL_ERROR', 'dsh-squad encountered an internal error')
}

function failure(
  requestId: string,
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): AgentTeamResponse & { ok: false } {
  return {
    requestId,
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  }
}

function writeJson(response: ServerResponse, status: number, body: AgentTeamResponse): void {
  const json = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(json)
}
