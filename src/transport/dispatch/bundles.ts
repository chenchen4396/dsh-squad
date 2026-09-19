import type { AgentTeamMethod } from '../contracts.js'
import { parsePayload } from '../payload-schemas.js'
import type { DispatchHandler } from './types.js'

/** Moving configuration in and out as a file. */
export const TABLE: Partial<Record<AgentTeamMethod, DispatchHandler>> = {
  'bundle.export': (ctx) => {
      const payload = parsePayload('bundle.export', ctx.rawPayload)
      return ctx.service.exportBundle(payload)
    },
  'bundle.import': (ctx) => {
      // The bundle is validated inside the service, where the failure can name
      // the field that is wrong instead of the whole body being "invalid".
      const payload = parsePayload('bundle.import', ctx.rawPayload)
      return ctx.service.importBundle(payload)
    },
}
