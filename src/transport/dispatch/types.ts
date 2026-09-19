import type { AgentTeamMethod } from '../contracts.js'
import type { AgentTeamService } from '../../service/agent-team-service.js'

/** Everything one dispatch entry is given. */
export interface DispatchContext {
  service: AgentTeamService
  /** The raw payload; each entry validates it with its own schema. */
  rawPayload: unknown
  options: { expectedRevision?: number }
}

/** One method's implementation. */
export type DispatchHandler = (ctx: DispatchContext) => unknown
