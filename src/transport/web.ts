import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { Config } from '../config.js'
import { dispatch } from './dispatch/index.js'
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
