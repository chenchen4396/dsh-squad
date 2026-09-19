import { z } from 'zod'
import { assistantTemplateSchema, ruleDocumentSchema, teamMemberSlotSchema } from './schemas.js'

/**
 * A portable copy of what the user configured, and nothing else.
 *
 * A team in storage carries conversations, live member sessions, tasks in
 * flight, file leases and an outbox — the state of a running team, tied to one
 * machine's Sessions. None of that survives a move, and most of it should not
 * be shared. What travels is the decision: which assistants exist, what they
 * are told to do and allowed to touch, which rules they load, and how a team is
 * arranged.
 *
 * The bundle therefore names its members by `memberKey` — a value local to the
 * file — rather than by the slot id that storage assigned on this machine. An
 * import assigns its own ids and rebuilds the references, so the same file can
 * be imported twice without one copy pointing at the other.
 */
export const BUNDLE_FORMAT = 'dsh-squad/bundle'
export const BUNDLE_VERSION = 1

/** One assistant, with the rules it references resolved to local keys. */
export const bundleAssistantSchema = z.object({
  /** Local key. Referenced by `members[].assistantKey`; not a storage id. */
  key: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  instructions: z.string(),
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoningEffort: z.string().trim().min(1).optional(),
  agentPresetId: z.string().trim().min(1),
  permissionPresetId: z.string().trim().min(1),
  skillAllowlist: z.array(z.string().trim().min(1)),
  mcpServers: z.array(z.string().trim().min(1)),
  /** Keys into this file's `ruleDocuments`. */
  ruleDocumentKeys: z.array(z.string().trim().min(1)),
}).strict()

/** One rule document, exactly as it was imported into the source instance. */
export const bundleRuleDocumentSchema = ruleDocumentSchema.omit({ id: true }).extend({
  /** Local key. Referenced by `assistants[].ruleDocumentKeys`. */
  key: z.string().trim().min(1),
}).strict()

/**
 * One member of a team, named by local keys throughout.
 *
 * The runtime fields of a member slot are dropped: `sessionId`,
 * `lastRuntimeState`, `desiredState` and the retired-session map all describe
 * this machine's running team, and an imported team starts offline.
 */
export const bundleMemberSchema = teamMemberSlotSchema.pick({
  displayName: true,
  role: true,
  permissionPresetId: true,
}).extend({
  /** Local key into this file's `assistants`. */
  assistantKey: z.string().trim().min(1),
  reasoningEffort: z.string().trim().min(1).optional(),
}).strict()

/**
 * One task, kept as a definition.
 *
 * Tasks travel because a team's arrangement is partly its work breakdown, but
 * only the part that is configuration: an execution record belongs to whoever
 * ran it and is deliberately dropped.
 */
export const bundleTaskSchema = z.object({
  /** Local key. Referenced by `dependencyIds` and `ownerKeys`. */
  key: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string(),
  /** Keys into this team's `members`. */
  ownerKeys: z.array(z.string().trim().min(1)),
  /** Keys into this team's `tasks`. */
  dependencyIds: z.array(z.string().trim().min(1)),
  fileScopes: z.array(z.string().trim().min(1)),
}).strict()

/** One team, arranged but not running. */
export const bundleTeamSchema = z.object({
  name: z.string().trim().min(1),
  directMemberChat: z.boolean(),
  /** Local key into this team's `members`, marking the leader. */
  leaderKey: z.string().trim().min(1),
  members: z.record(z.string(), bundleMemberSchema),
  tasks: z.record(z.string(), bundleTaskSchema),
}).strict()

export const squadBundleSchema = z.object({
  format: z.literal(BUNDLE_FORMAT),
  version: z.literal(BUNDLE_VERSION),
  exportedAt: z.string().trim().min(1),
  assistants: z.array(bundleAssistantSchema),
  ruleDocuments: z.array(bundleRuleDocumentSchema),
  teams: z.array(bundleTeamSchema),
}).strict()

export type SquadBundle = z.infer<typeof squadBundleSchema>
export type BundleAssistant = z.infer<typeof bundleAssistantSchema>
export type BundleRuleDocument = z.infer<typeof bundleRuleDocumentSchema>
export type BundleTeam = z.infer<typeof bundleTeamSchema>
export type BundleMember = z.infer<typeof bundleMemberSchema>
export type BundleTask = z.infer<typeof bundleTaskSchema>

/** What to do with something the target instance already has. */
export type BundleImportMode = 'copy' | 'overwrite'

export const bundleImportInputSchema = z.object({
  bundle: squadBundleSchema,
  mode: z.enum(['copy', 'overwrite']),
}).strict()

export interface BundleImportSummary {
  mode: BundleImportMode
  assistantsCreated: number
  assistantsUpdated: number
  ruleDocumentsCreated: number
  ruleDocumentsUpdated: number
  teamsCreated: number
  /** Anything the file asked for that this deployment cannot provide. */
  warnings: string[]
}

/** Which teams to write into the file; omitting it exports every team. */
export type BundleExportInput = {
  teamIds?: readonly string[]
}
