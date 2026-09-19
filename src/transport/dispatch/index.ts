import type { AgentTeamMethod, AgentTeamRequest } from '../contracts.js'
import type { AgentTeamService } from '../../service/agent-team-service.js'
import type { DispatchHandler } from './types.js'
import { TABLE as assistantBuilder } from './assistant-builder.js'
import { TABLE as assistants } from './assistants.js'
import { TABLE as bundles } from './bundles.js'
import { TABLE as catalog } from './catalog.js'
import { TABLE as conversations } from './conversations.js'
import { TABLE as teams } from './teams.js'
import { TABLE as workspace } from './workspace.js'

/**
 * Every API method's implementation, assembled from one table per subject.
 *
 * A single switch used to hold all fifty-three, so finding one method meant
 * scrolling a file that also carried the HTTP envelope, the upload route and
 * the event stream. Each subject now states its own methods, and this is where
 * they are joined — which is also the place that can prove the join is total.
 */
const HANDLERS: Record<AgentTeamMethod, DispatchHandler> = {
  ...catalog,
  ...assistants,
  ...assistantBuilder,
  ...teams,
  ...conversations,
  ...workspace,
  ...bundles,
} as Record<AgentTeamMethod, DispatchHandler>

/** The methods this transport can actually serve. */
export function dispatchedMethods(): AgentTeamMethod[] {
  return Object.keys(HANDLERS) as AgentTeamMethod[]
}

/**
 * Run one request.
 *
 * Async on purpose: a payload that fails its schema throws while the entry runs,
 * and callers await a rejection rather than having to catch a synchronous throw
 * from a function that looks like it returns a promise.
 */
export async function dispatch(service: AgentTeamService, request: AgentTeamRequest): Promise<unknown> {
  const handler = HANDLERS[request.method]
  if (handler === undefined) {
    throw new Error(`No handler for ${request.method}`)
  }
  return await handler({
    service,
    rawPayload: request.payload,
    options: request.expectedRevision === undefined ? {} : { expectedRevision: request.expectedRevision },
  })
}
