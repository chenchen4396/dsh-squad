import { z } from 'zod'

const isoDate = z.iso.datetime({ offset: true })
const nonEmpty = z.string().trim().min(1)

export const assistantSnapshotSchema = z.object({
  assistantId: nonEmpty,
  revision: z.int().positive(),
  name: nonEmpty,
  instructions: z.string(),
  provider: nonEmpty,
  model: nonEmpty,
  reasoningEffort: nonEmpty.optional(),
  agentPresetId: nonEmpty,
  permissionPresetId: nonEmpty,
  skillAllowlist: z.array(nonEmpty),
  mcpServers: z.array(nonEmpty),
}).strict()

/**
 * One whole imported rule document.
 *
 * Rules are imported as complete files (a `CLAUDE.md`, a house style guide)
 * rather than authored one entry at a time, so the content is stored verbatim
 * and never split into individual rules.
 */
export const ruleDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty,
  /**
   * Location relative to whatever was imported, e.g.
   * `rules/frontend/design.md`. Importing a folder keeps its layout, so this is
   * what the picker groups by.
   */
  path: nonEmpty,
  /** Display name, taken from the document's first heading when it has one. */
  title: nonEmpty,
  /** Basename of `path`, kept for display and for matching a re-import. */
  fileName: nonEmpty,
  content: z.string(),
  bytes: z.int().nonnegative(),
  importedAt: isoDate,
}).strict()

export const assistantTemplateSchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty,
  name: nonEmpty,
  description: z.string().optional(),
  icon: z.string().optional(),
  instructions: z.string(),
  provider: nonEmpty,
  model: nonEmpty,
  reasoningEffort: nonEmpty.optional(),
  agentPresetId: nonEmpty,
  permissionPresetId: nonEmpty,
  skillAllowlist: z.array(nonEmpty),
  mcpServers: z.array(nonEmpty),
  /**
   * Imported rule documents this assistant loads, mirroring `skillAllowlist`.
   * Members inherit the assistant live, so editing this changes every member
   * using the assistant.
   */
  ruleDocumentAllowlist: z.array(nonEmpty).default([]),
  revision: z.int().positive(),
  createdAt: isoDate,
  updatedAt: isoDate,
}).strict()

export const memberRuntimeStateSchema = z.enum([
  'offline',
  'starting',
  'idle',
  'running',
  'waiting_approval',
  'error',
])

export const teamMemberSlotSchema = z.object({
  id: nonEmpty,
  assistantId: nonEmpty,
  displayName: nonEmpty,
  role: z.enum(['leader', 'member']),
  /**
   * Legacy frozen copy of the assistant template.
   *
   * Members inherit the assistant live now, so this is only ever present on
   * records written before that change. It is kept as an optional field purely
   * so those records still parse — rejecting them would make the storage domain
   * unopenable and stop the plugin from starting. Nothing reads it any more.
   */
  assistantSnapshot: assistantSnapshotSchema.optional(),
  permissionPresetId: nonEmpty,
  reasoningEffort: nonEmpty.optional(),
  /**
   * Legacy team-scoped Session id. Conversations own member Sessions now, so
   * this is only ever present on records written before conversations became
   * isolated; its presence marks a team as legacy.
   */
  sessionId: nonEmpty.optional(),
  /**
   * Legacy per-member rule selection from the workspace `.agent-team/rules/`
   * directory. Document selection belongs to the assistant now, so nothing
   * reads this; it stays optional purely so records written before the change
   * still parse instead of making the whole storage domain unopenable.
   */
  ruleAllowlist: z.array(nonEmpty).default([]),
  desiredState: z.enum(['online', 'offline', 'removing']),
  lastRuntimeState: memberRuntimeStateSchema,
  joinedAt: isoDate,
}).strict()

export const retiredMemberSessionSchema = z.object({
  formerSlotId: nonEmpty,
  sessionId: nonEmpty,
  displayName: nonEmpty,
  removedAt: isoDate,
}).strict()

export const teamTaskSchema = z.object({
  id: nonEmpty,
  title: nonEmpty,
  description: z.string(),
  status: z.enum(['pending', 'assigned', 'running', 'blocked', 'completed', 'failed', 'cancelled']),
  /** Primary owner: kept for records written before a task could be shared. */
  ownerSlotId: nonEmpty.optional(),
  /**
   * Every member working on this task. More than one owner means the task was
   * dispatched to all of them at once, so they work on it in parallel.
   */
  ownerSlotIds: z.array(nonEmpty).default([]),
  createdBySlotId: nonEmpty.optional(),
  /** Conversation this task belongs to; legacy tasks predate isolated conversations. */
  conversationId: nonEmpty.optional(),
  dependencyIds: z.array(nonEmpty),
  fileScopes: z.array(nonEmpty),
  result: z.string().optional(),
  error: z.string().optional(),
  revision: z.int().positive(),
  createdAt: isoDate,
  updatedAt: isoDate,
}).strict()

export const fileScopeLeaseSchema = z.object({
  id: nonEmpty,
  slotId: nonEmpty,
  taskId: nonEmpty,
  path: nonEmpty,
  acquiredAt: isoDate,
  expiresAt: isoDate.optional(),
}).strict()

const attachmentRefSchema = z.object({
  kind: z.enum(['workspace_path', 'url']),
  value: nonEmpty,
  label: z.string().optional(),
}).strict()

export const teamConversationSchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty,
  teamId: nonEmpty,
  /**
   * Harness Session this team is enabled in.
   *
   * A team owns no Session of its own: enabling it in a Session binds that
   * Session's own Agent as the Leader and runs every other member as that
   * Agent's subagent. Absent only on records written before the binding model,
   * which are dropped at startup.
   */
  sessionId: nonEmpty.optional(),
  title: nonEmpty,
  /**
   * Where the displayed title comes from: `auto` follows the conversation's
   * first user message the way a DSH Session does, `user` is an explicit
   * rename that pins the title. Auto titles are resolved for display only and
   * never overwrite the stored placeholder.
   */
  titleSource: z.enum(['auto', 'user']).default('auto'),
  state: z.enum(['active', 'archived']),
  /**
   * «替我审批»: the Leader answers every interaction of this conversation on the
   * reader's behalf, so the reader is never asked. Absent (or false) means the
   * reader answers, which is how bindings written before this acted.
   */
  delegateInteractions: z.boolean().optional(),
  /**
   * Workspace this conversation's member Sessions run in. It is read off the
   * bound Harness Session when the team is enabled, because a DSH Session's
   * working directory is fixed at creation and the members share it.
   */
  workspaceId: nonEmpty.optional(),
  workspacePath: nonEmpty.optional(),
  /**
   * Member Sessions owned by this conversation, keyed by member slot id. Each
   * conversation runs its own set of Sessions, so member context never leaks
   * between conversations and several conversations can run concurrently.
   */
  memberSessions: z.record(z.string(), nonEmpty).default({}),
  /**
   * Legacy per-member event cursors from when all conversations shared one
   * Session per member. Retained only so pre-isolation records still parse.
   */
  memberCursors: z.record(z.string(), z.int().nonnegative()).optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
  revision: z.int().positive(),
}).strict()

export const teamMessageSchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty,
  teamId: nonEmpty,
  conversationId: nonEmpty.optional(),
  mentions: z.array(nonEmpty).optional(),
  sender: z.object({
    kind: z.enum(['user', 'member', 'system']),
    id: nonEmpty,
  }).strict(),
  recipient: z.object({
    kind: z.enum(['leader', 'member', 'broadcast']),
    slotId: nonEmpty.optional(),
  }).strict(),
  type: z.enum(['instruction', 'progress', 'result', 'question', 'warning', 'system']),
  content: z.string(),
  relatedTaskId: nonEmpty.optional(),
  attachments: z.array(attachmentRefSchema),
  deliveryState: z.enum(['queued', 'delivered', 'read', 'failed']),
  idempotencyKey: nonEmpty,
  createdAt: isoDate,
}).strict()

export const teamAggregateSchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty,
  name: nonEmpty,
  /**
   * Workspace of a team created before sessions chose their own. Optional:
   * a team owns no workspace now, and a conversation without one of its own
   * still runs in this, so records written earlier keep working.
   */
  workspaceId: nonEmpty.optional(),
  workspacePath: nonEmpty.optional(),
  leaderSlotId: nonEmpty,
  state: z.enum([
    'draft',
    'starting',
    'active',
    'ownership_conflict',
    'deleting',
    'delete_blocked',
    'error',
  ]),
  directMemberChat: z.boolean(),
  activeConversationId: nonEmpty.optional(),
  members: z.record(z.string(), teamMemberSlotSchema),
  retiredSessions: z.record(z.string(), retiredMemberSessionSchema),
  tasks: z.record(z.string(), teamTaskSchema),
  leases: z.record(z.string(), fileScopeLeaseSchema),
  outbox: z.record(z.string(), teamMessageSchema),
  revision: z.int().positive(),
  createdAt: isoDate,
  updatedAt: isoDate,
}).strict()

export const teamActivitySchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty,
  teamId: nonEmpty,
  kind: nonEmpty,
  entityId: nonEmpty.optional(),
  summary: z.string(),
  revision: z.int().nonnegative(),
  createdAt: isoDate,
}).strict()

export const operationSchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty,
  teamId: nonEmpty.optional(),
  kind: z.enum(['dissolve_team', 'remove_member', 'sync_member', 'migrate_records']),
  state: z.enum(['pending', 'running', 'blocked', 'completed', 'failed']),
  stage: nonEmpty,
  cursor: z.string().optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
}).strict()

export const createAssistantInputSchema = assistantTemplateSchema.pick({
  name: true,
  description: true,
  icon: true,
  instructions: true,
  provider: true,
  model: true,
  reasoningEffort: true,
  agentPresetId: true,
  permissionPresetId: true,
  skillAllowlist: true,
  mcpServers: true,
}).extend({
  /**
   * Optional on input so callers that predate rule documents keep working; the
   * stored template always carries it, defaulting to no documents.
   */
  ruleDocumentAllowlist: z.array(nonEmpty).optional(),
})

export const updateAssistantInputSchema = createAssistantInputSchema.partial().strict()

export const createTeamMemberInputSchema = z.object({
  assistantId: nonEmpty,
  role: z.enum(['leader', 'member']),
}).strict()

export const addTeamMemberInputSchema = createTeamMemberInputSchema.omit({ role: true }).strict()

export const createTeamDraftInputSchema = z.object({
  name: nonEmpty,
  directMemberChat: z.boolean().optional(),
  members: z.array(createTeamMemberInputSchema).min(1),
}).strict()

export const cloneTeamInputSchema = z.object({
  name: nonEmpty,
}).strict()
