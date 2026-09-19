import type { z } from 'zod'
import type { AgentTeamMethod, AgentTeamRequestMap } from './contracts.js'
import { PAYLOAD_SCHEMAS } from './payload-schemas.js'

/** What a method's request schema produces from a raw payload. */
type SchemaOutput<M extends AgentTeamMethod> = M extends keyof typeof PAYLOAD_SCHEMAS
  ? (typeof PAYLOAD_SCHEMAS)[M] extends z.ZodTypeAny
    ? z.infer<(typeof PAYLOAD_SCHEMAS)[M]>
    : never
  : never

/**
 * The methods whose payload the request schema deliberately does not describe.
 *
 * Each carries a field whose own shape is validated by the service, so that a
 * bad one can be reported field by field instead of as "the whole body is
 * wrong". The schema checks that the field is present; the service checks what
 * is in it.
 */
export type ServiceValidatedPayload =
  | 'assistant.create'
  | 'assistant.update'
  | 'bundle.import'
  | 'team.addMember'
  | 'team.createDraft'

/**
 * The request schema and the declared payload describe the same request.
 *
 * These are two descriptions of one thing — the schema says what is accepted on
 * the wire, the request map says what the transport hands on — and nothing else
 * makes them agree. They had already drifted at eight methods: the schema
 * proved `conversationId?: string | undefined` where the map said
 * `conversationId?: string`, which is the same request and not the same type.
 *
 * So it is checked. A method that is not on the list above and whose schema
 * output does not fit its declared payload makes this type a union of method
 * names, and the assignment below stops compiling.
 */
export type ContractDisagreements = {
  [M in AgentTeamMethod]: M extends ServiceValidatedPayload
    ? never
    : [SchemaOutput<M>] extends [AgentTeamRequestMap[M]['payload']]
      ? never
      : M
}[AgentTeamMethod]

/**
 * Compile-time proof that the two descriptions agree.
 *
 * Reading the error: the type it names IS the method whose schema and payload
 * have drifted apart. Either make the declared payload match what the schema
 * proves, or add the method to `ServiceValidatedPayload` above with a reason.
 */
export function assertContractAgreement(disagreements: ContractDisagreements): void {
  const none: never = disagreements
  void none
}
