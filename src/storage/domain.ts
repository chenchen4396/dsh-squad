import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import {
  assistantTemplateSchema,
  operationSchema,
  ruleDocumentSchema,
  teamActivitySchema,
  teamAggregateSchema,
  teamConversationSchema,
  teamMessageSchema,
} from '../domain/schemas.js'
import type {
  AssistantTemplate,
  Operation,
  RuleDocument,
  TeamActivity,
  TeamAggregate,
  TeamConversation,
  TeamMessage,
} from '../domain/types.js'

export type AssistantId = string
export type TeamId = string
export type ConversationId = string
export type MessageId = string
export type ActivityId = string
export type OperationId = string
export type RuleDocumentId = string

export const agentTeamDomainSpec = defineDomain({
  name: 'agent_team',
  // Stays at 1: the backend unit is stamped with this version, so bumping it
  // would make `open` reject every existing storage with `version-mismatch`.
  // Adding a table is safe — a stored unit simply has no records for it.
  version: 1,
  tables: {
    assistants: domainTable<AssistantId, AssistantTemplate>(assistantTemplateSchema),
    rule_documents: domainTable<RuleDocumentId, RuleDocument>(ruleDocumentSchema),
    teams: domainTable<TeamId, TeamAggregate>(teamAggregateSchema),
    conversations: domainTable<ConversationId, TeamConversation>(teamConversationSchema),
    messages: domainTable<MessageId, TeamMessage>(teamMessageSchema),
    activities: domainTable<ActivityId, TeamActivity>(teamActivitySchema),
    operations: domainTable<OperationId, Operation>(operationSchema),
  },
})

