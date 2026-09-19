import { z } from 'zod'
import type { InteractionResponseInput } from './contracts.js'

/**
 * A reader's answer as it arrives on the wire, which is what the schema proves:
 * slightly looser than the view type, because an absent `custom` reads as
 * `undefined` rather than being missing.
 */
export type ParsedInteractionResponse =
  | { kind: 'approval'; outcome: 'allowed-once' | 'rejected' }
  | {
    kind: 'question'
    answers: Array<{ id: string; selected: string[]; custom?: string | undefined }>
  }

/**
 * What every API method accepts, in one place.
 *
 * The dispatcher used to hold one `z.object(...).parse(request.payload)` per
 * branch and `contracts.ts` declared the matching payload type by hand, so the
 * same request was described twice and the two drifted silently. These schemas
 * are what the dispatcher validates with, and what the declared payload types
 * are read from.
 *
 * A method that takes nothing declares `noPayload`: the request may omit the
 * field entirely, and an explicit `undefined` is accepted the same way.
 */
export const noPayload = z.undefined()

const idPayload = z.object({ id: z.string().trim().min(1) }).strict()
/** One Harness Session id: the conversation a team is enabled in. */
const sessionIdPayload = z.string().trim().min(1).max(200)
const interactionResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('question'),
    answers: z.array(z.object({
      id: z.string().trim().min(1).max(200),
      selected: z.array(z.string().min(1).max(500)).max(50),
      custom: z.string().max(32_000).optional(),
    }).strict()).min(1).max(32),
  }).strict(),
  z.object({
    kind: z.literal('approval'),
    outcome: z.enum(['allowed-once', 'rejected']),
  }).strict(),
])
export { idPayload, sessionIdPayload, interactionResponseSchema }

/**
 * The reader's answer to a member's question or approval, in the shape the
 * service takes.
 *
 * Both the team room and the assistant designer let the reader answer, and both
 * wrote out the same narrowing by hand. The schema above already proves which
 * of the two it is, so the difference is one branch, stated once.
 */
export function interactionResponseOf(
  response: ParsedInteractionResponse,
): InteractionResponseInput {
  if (response.kind === 'approval') return response
  return {
    kind: 'question',
    answers: response.answers.map(answer => ({
      id: answer.id,
      selected: answer.selected,
      ...(answer.custom === undefined ? {} : { custom: answer.custom }),
    })),
  }
}


export const PAYLOAD_SCHEMAS = {
  'catalog.model.get': z.object({
    provider: z.string().trim().min(1).max(200),
    model: z.string().trim().min(1).max(500),
  }).strict(),
  'skill.catalog': z.object({ agentPresetId: z.string().trim().min(1).max(200) }).strict(),
  'mcp.catalog': z.object({ agentPresetId: z.string().trim().min(1).max(200) }).strict(),
  'assistant.update': z.object({ id: z.string().min(1), value: z.unknown() }).strict(),
  'assistant.clone': z.object({ id: z.string().min(1), name: z.string().optional() }).strict(),
  'assistant.builder.draft.configure': z.object({
    provider: z.string().trim().min(1).max(200),
    model: z.string().trim().min(1).max(500),
  }).strict(),
  'assistant.builder.start': z.object({
    provider: z.string().trim().min(1).max(200),
    model: z.string().trim().min(1).max(500),
    content: z.string().trim().min(1).max(32_000),
  }).strict(),
  'assistant.builder.get': z.object({ sessionId: z.string().trim().min(1).max(200) }).strict(),
  'assistant.builder.configure': z.object({
    sessionId: z.string().trim().min(1).max(200),
    provider: z.string().trim().min(1).max(200),
    model: z.string().trim().min(1).max(500),
  }).strict(),
  'assistant.builder.send': z.object({
    sessionId: z.string().trim().min(1).max(200),
    content: z.string().trim().min(1).max(32_000),
  }).strict(),
  'assistant.builder.interaction.respond': z.object({
    sessionId: z.string().trim().min(1).max(200),
    interactionId: z.string().trim().min(1).max(500),
    response: interactionResponseSchema,
  }).strict(),
  'assistant.builder.stop': z.object({ sessionId: z.string().trim().min(1).max(200) }).strict(),
  'assistant.builder.archive': z.object({ sessionId: z.string().trim().min(1).max(200) }).strict(),
  'team.clone': z.object({
    teamId: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(500),
  }).strict(),
  'team.addMember': z.object({ teamId: z.string().min(1), value: z.unknown() }).strict(),
  'team.removeMember': z.object({ teamId: z.string().min(1), slotId: z.string().min(1) }).strict(),
  'team.changeLeader': z.object({ teamId: z.string().min(1), successorSlotId: z.string().min(1) }).strict(),
  'team.message.send': z.object({
    teamId: z.string().min(1),
    content: z.string(),
    conversationId: sessionIdPayload,
    targetSlotId: z.string().min(1).optional(),
  }).strict(),
  'team.workbench.get': z.object({
    id: z.string().trim().min(1).max(200),
    conversationId: sessionIdPayload,
  }).strict(),
  'team.workbench.older': z.object({
    id: z.string().trim().min(1).max(200),
    conversationId: sessionIdPayload,
    slotId: z.string().trim().min(1).max(200),
    beforeSeq: z.int().nonnegative(),
  }).strict(),
  'team.session.get': z.object({ sessionId: sessionIdPayload }).strict(),
  'team.session.bind': z.object({
    sessionId: sessionIdPayload,
    teamId: z.string().trim().min(1).max(200),
  }).strict(),
  'team.session.unbind': z.object({ sessionId: sessionIdPayload }).strict(),
  'team.session.delegate': z.object({
    sessionId: sessionIdPayload,
    delegate: z.boolean(),
  }).strict(),
  'team.conversation.list': z.object({ teamId: z.string().trim().min(1).max(200) }).strict(),
  'team.room.get': z.object({
    teamId: z.string().trim().min(1).max(200),
    conversationId: sessionIdPayload,
  }).strict(),
  'team.room.older': z.object({
    teamId: z.string().trim().min(1).max(200),
    conversationId: sessionIdPayload,
    beforeTime: z.int().nonnegative(),
  }).strict(),
  'team.room.send': z.object({
    teamId: z.string().trim().min(1).max(200),
    content: z.string(),
    conversationId: sessionIdPayload,
    mentions: z.array(z.string().trim().min(1).max(200)).max(64).optional(),
  }).strict(),
  'team.member.stop': z.object({
    teamId: z.string().min(1),
    slotId: z.string().min(1),
    conversationId: sessionIdPayload,
  }).strict(),
  'team.interaction.respond': z.object({
    teamId: z.string().trim().min(1).max(200),
    slotId: z.string().trim().min(1).max(200),
    interactionId: z.string().trim().min(1).max(300),
    response: interactionResponseSchema,
    conversationId: sessionIdPayload,
  }).strict(),
  'assistant.ruleDocuments.get': z.object({ id: z.string().min(1) }).strict(),
  'assistant.ruleDocuments.import': z.object({
    path: z.string().trim().min(1).max(400),
    // Bounded by the transport's own body limit; the service reports the
    // readable size error against the configured cap.
    content: z.string(),
  }).strict(),
  'bundle.export': z.object({ teamIds: z.array(z.string().trim().min(1)).max(200).optional() })
    .strict(),
  'bundle.import': z.object({ bundle: z.unknown(), mode: z.enum(['copy', 'overwrite']) })
    .strict(),
  'assistant.ruleDocuments.delete': z.object({ id: z.string().min(1) }).strict(),
  'team.workspace.list': z.object({
    teamId: z.string().min(1),
    conversationId: z.string().min(1).optional(),
    path: z.string().max(4096).optional(),
  }).strict(),
  'team.workspace.search': z.object({
    teamId: z.string().min(1),
    conversationId: z.string().min(1).optional(),
    query: z.string().max(4096).optional(),
    limit: z.int().min(1).max(100).optional(),
  }).strict(),
  'team.workspace.changes': z.object({
    teamId: z.string().min(1),
    conversationId: z.string().min(1).optional(),
  }).strict(),
  'team.workspace.diff': z.object({
    teamId: z.string().min(1),
    conversationId: z.string().min(1).optional(),
    path: z.string().min(1).max(4096),
    scope: z.enum(['staged', 'unstaged']),
    layout: z.enum(['unified', 'split']),
    theme: z.enum(['light', 'dark']),
  }).strict(),
  'team.dissolve': z.object({ teamId: z.string().min(1), confirmation: z.string() }).strict(),
  // No payload: the request may leave `payload` out.
  'catalog.get': noPayload,
  'assistant.list': noPayload,
  'assistant.builder.list': noPayload,
  'assistant.builder.draft.get': noPayload,
  'team.list': noPayload,
  'assistant.ruleDocuments.list': noPayload,
  // One id, the same shape most single-record methods take.
  'assistant.get': idPayload,
  'assistant.delete': idPayload,
  'team.get': idPayload,
  'team.start': idPayload,
  'team.message.list': idPayload,
  // Validated by the service, which owns the schema for these two.
  'assistant.create': z.unknown(),
  'team.createDraft': z.unknown(),
} as const

/**
 * Validate one request's payload with the schema for its method.
 *
 * Called with a literal method, so the result is typed by that method's entry
 * rather than by the union of every entry — a switch on `method` cannot narrow
 * a value it does not discriminate, and reading `request.payload` directly
 * would leave every branch with the union.
 */
export function parsePayload<M extends keyof typeof PAYLOAD_SCHEMAS>(
  method: M,
  raw: unknown,
): z.infer<(typeof PAYLOAD_SCHEMAS)[M]> {
  return PAYLOAD_SCHEMAS[method].parse(raw) as z.infer<(typeof PAYLOAD_SCHEMAS)[M]>
}

export type AgentTeamPayloadSchema = typeof PAYLOAD_SCHEMAS
