import type { z } from 'zod'
import type {
  assistantSnapshotSchema,
  addTeamMemberInputSchema,
  assistantTemplateSchema,
  cloneTeamInputSchema,
  createAssistantInputSchema,
  createTeamDraftInputSchema,
  createTeamMemberInputSchema,
  fileScopeLeaseSchema,
  memberRuntimeStateSchema,
  operationSchema,
  retiredMemberSessionSchema,
  ruleDocumentSchema,
  teamActivitySchema,
  teamAggregateSchema,
  teamConversationSchema,
  teamMemberSlotSchema,
  teamMessageSchema,
  teamTaskSchema,
  updateAssistantInputSchema,
} from './schemas.js'

export type AssistantSnapshot = z.infer<typeof assistantSnapshotSchema>
export type AssistantTemplate = z.infer<typeof assistantTemplateSchema>
export type CreateAssistantInput = z.infer<typeof createAssistantInputSchema>
export type UpdateAssistantInput = z.infer<typeof updateAssistantInputSchema>
export type MemberRuntimeState = z.infer<typeof memberRuntimeStateSchema>
export type RuleDocument = z.infer<typeof ruleDocumentSchema>
export type TeamMemberSlot = z.infer<typeof teamMemberSlotSchema>
export type RetiredMemberSession = z.infer<typeof retiredMemberSessionSchema>
export type TeamTask = z.infer<typeof teamTaskSchema>
export type FileScopeLease = z.infer<typeof fileScopeLeaseSchema>
export type TeamAggregate = z.infer<typeof teamAggregateSchema>
export type TeamConversation = z.infer<typeof teamConversationSchema>
export type TeamMessage = z.infer<typeof teamMessageSchema>
export type TeamActivity = z.infer<typeof teamActivitySchema>
export type Operation = z.infer<typeof operationSchema>
export type CreateTeamMemberInput = z.infer<typeof createTeamMemberInputSchema>
export type AddTeamMemberInput = z.infer<typeof addTeamMemberInputSchema>
export type CreateTeamDraftInput = z.infer<typeof createTeamDraftInputSchema>
export type CloneTeamInput = z.infer<typeof cloneTeamInputSchema>

export interface Page<T> {
  items: T[]
  total: number
}
