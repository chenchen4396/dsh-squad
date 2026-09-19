import { randomUUID } from 'node:crypto'
import {
  addTeamMemberInputSchema,
  cloneTeamInputSchema,
  createTeamDraftInputSchema,
} from '../domain/schemas.js'
import { AgentTeamError } from '../domain/errors.js'
import { taskAssigneeIds } from '../domain/team-selectors.js'
import type { Page } from '../domain/types.js'
import type {
  AddTeamMemberInput,
  CloneTeamInput,
  CreateTeamDraftInput,
  TeamAggregate,
  TeamMemberSlot,
} from '../domain/types.js'
import type { AgentTeamStore } from '../storage/store.js'
import type { MemberConversationView } from '../transport/contracts.js'
import type { Config } from '../config.js'
import {
  assertRevision,
  assertTeamMutable,
  createMemberSlot,
  requireAssistant,
  requireTeam,
  type MutationOptions,
} from './store-guards.js'
import type { WorkspaceService } from './workspace-service.js'

/**
 * Teams: making one, staffing it, and removing it.
 *
 * These eleven methods were spread through a 1480-line service between the
 * catalog and the workspace, and the two that decide who is on a team are the
 * ones that have to agree with the agent runtime. What they share is the store,
 * and the record they keep of what changed.
 */

/** What a team operation needs from the service that owns it. */
export interface TeamDeps {
  store: AgentTeamStore
  config: Config
  /** The runtime when it is attached, and undefined when it is not. */
  runtime: TeamRuntimeLike | undefined
  /** The runtime, refusing when it is not attached; starting needs it. */
  requireRuntime: () => TeamRuntimeLike
  /** What the workspace service does when a team goes away. */
  workspace: Pick<WorkspaceService, 'unwatch'>
  activity: (kind: string, entityId: string, revision: number, summary: string) => Promise<void>
  publish: (
    entityType:
      | 'assistant' | 'assistant-builder' | 'team' | 'operation'
      | 'conversation' | 'workspace' | 'catalog' | 'rule-document',
    entityId: string,
    revision: number,
    kind: string,
    conversation?: MemberConversationView,
  ) => void
}

/** The part of the runtime these operations use. */
/** The part of the runtime these operations use. */
interface TeamRuntimeLike {
  activateMember: (teamId: string, slotId: string) => Promise<TeamAggregate>
  removeMember: (teamId: string, slotId: string) => Promise<TeamAggregate>
  startTeam: (teamId: string) => Promise<TeamAggregate>
  dissolveTeam: (teamId: string) => Promise<void>
  leaderChanged: (teamId: string, slotId: string) => Promise<void>
}

export function getTeam(deps: TeamDeps, id: string): TeamAggregate {
  return requireTeam(deps.store, id)
}

export function listTeams(deps: TeamDeps): Page<TeamAggregate> {
  const items = deps.store.listTeams()
  return { items, total: items.length }
}

export async function createTeamDraft(deps: TeamDeps, raw: CreateTeamDraftInput): Promise<TeamAggregate> {
  const input = createTeamDraftInputSchema.parse(raw)
  const leaders = input.members.filter(member => member.role === 'leader')
  if (leaders.length !== 1) {
    throw new AgentTeamError('TEAM_INVALID_LEADER', 'A team must contain exactly one leader')
  }

  const now = new Date().toISOString()
  const members: Record<string, TeamMemberSlot> = {}
  let leaderSlotId = ''
  for (const item of input.members) {
    const assistant = requireAssistant(deps.store, item.assistantId)
    const slotId = randomUUID()
    members[slotId] = {
      id: slotId,
      assistantId: assistant.id,
      displayName: assistant.name,
      role: item.role,
      permissionPresetId: assistant.permissionPresetId,
      ...(assistant.reasoningEffort === undefined ? {} : { reasoningEffort: assistant.reasoningEffort }),
      ruleAllowlist: [],
      desiredState: 'offline',
      lastRuntimeState: 'offline',
      joinedAt: now,
    }
    if (item.role === 'leader') leaderSlotId = slotId
  }

  const team: TeamAggregate = {
    schemaVersion: 1,
    id: randomUUID(),
    name: input.name.trim(),
    leaderSlotId,
    state: 'draft',
    directMemberChat: input.directMemberChat ?? deps.config.directMemberChatDefault,
    members,
    retiredSessions: {},
    tasks: {},
    leases: {},
    outbox: {},
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }
  await deps.store.putTeam(team)
  await deps.activity('team.created', team.id, team.revision, `Team ${team.name} draft created`)
  deps.publish('team', team.id, team.revision, 'team.created')
  return team
}

export async function cloneTeam(deps: TeamDeps, sourceTeamId: string, raw: CloneTeamInput): Promise<TeamAggregate> {
  const input = cloneTeamInputSchema.parse(raw)
  const source = requireTeam(deps.store, sourceTeamId)

  const now = new Date().toISOString()
  const members: Record<string, TeamMemberSlot> = {}
  let leaderSlotId = ''
  for (const sourceMember of Object.values(source.members)) {
    const member = cloneMemberSlot(sourceMember, now)
    members[member.id] = member
    if (sourceMember.id === source.leaderSlotId) leaderSlotId = member.id
  }
  if (leaderSlotId === '') {
    throw new AgentTeamError('TEAM_INVALID_LEADER', 'Source team has no valid leader')
  }

  const team: TeamAggregate = {
    schemaVersion: 1,
    id: randomUUID(),
    name: input.name.trim(),
    leaderSlotId,
    state: 'draft',
    directMemberChat: source.directMemberChat,
    members,
    retiredSessions: {},
    tasks: {},
    leases: {},
    outbox: {},
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }
  await deps.store.putTeam(team)
  await deps.activity('team.cloned', team.id, team.revision, `Team ${team.name} cloned from ${source.name}`)
  deps.publish('team', team.id, team.revision, 'team.cloned')
  return team
}

export async function changeLeader(deps: TeamDeps,
  teamId: string,
  successorSlotId: string,
  options: MutationOptions = {},
): Promise<TeamAggregate> {
  const current = requireTeam(deps.store, teamId)
  assertTeamMutable(current)
  assertRevision('team', current.revision, options.expectedRevision)
  if (current.members[successorSlotId] === undefined) {
    throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${successorSlotId}'`)
  }
  if (current.leaderSlotId === successorSlotId) {
    throw new AgentTeamError('INVALID_REQUEST', 'The selected member is already the team leader')
  }
  const next = await deps.store.updateTeam(teamId, team => ({
    ...team,
    members: Object.fromEntries(Object.entries(team.members).map(([slotId, member]) => [
      slotId,
      { ...member, role: slotId === successorSlotId ? 'leader' : 'member' },
    ])),
    leaderSlotId: successorSlotId,
    revision: team.revision + 1,
    updatedAt: new Date().toISOString(),
  }))
  await deps.activity('team.leader_changed', teamId, next.revision, 'Team leader changed')
  deps.publish('team', teamId, next.revision, 'team.leader_changed')
  // A team that is not running has nobody to tell.
  if (deps.runtime !== undefined && next.state !== 'draft') {
    await deps.runtime.leaderChanged(teamId, successorSlotId)
  }
  return next
}

export async function addMember(deps: TeamDeps,
  teamId: string,
  raw: AddTeamMemberInput,
  options: MutationOptions = {},
): Promise<TeamAggregate> {
  const input = addTeamMemberInputSchema.parse(raw)
  const team = requireTeam(deps.store, teamId)
  assertTeamMutable(team)
  assertRevision('team', team.revision, options.expectedRevision)
  if (team.state !== 'draft' && team.state !== 'active') {
    throw new AgentTeamError('TEAM_NOT_ACTIVE', `Cannot add a member while team is '${team.state}'`)
  }
  const assistant = requireAssistant(deps.store, input.assistantId)
  const displayName = assistant.name
  const now = new Date().toISOString()
  const member = createMemberSlot(assistant, displayName, 'member', now, team.state === 'draft' ? 'offline' : 'online')
  const next = await deps.store.updateTeam(teamId, current => ({
    ...current,
    members: { ...current.members, [member.id]: member },
    revision: current.revision + 1,
    updatedAt: now,
  }))
  await deps.activity('team.member_added', teamId, next.revision, `Member ${displayName} added`)
  deps.publish('team', teamId, next.revision, 'team.member_added')
  if (next.state !== 'draft') return deps.requireRuntime().activateMember(teamId, member.id)
  return next
}

export async function removeMember(deps: TeamDeps,
  teamId: string,
  slotId: string,
  options: MutationOptions = {},
): Promise<TeamAggregate> {
  const team = requireTeam(deps.store, teamId)
  assertTeamMutable(team)
  assertRevision('team', team.revision, options.expectedRevision)
  const member = team.members[slotId]
  if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
  if (slotId === team.leaderSlotId) {
    throw new AgentTeamError('MEMBER_IS_LEADER', 'Choose a successor before removing the current leader')
  }
  assertMemberHasNoOpenTasks(team, slotId)
  if (team.state === 'draft') {
    const next = await deps.store.updateTeam(teamId, current => {
      const members = { ...current.members }
      delete members[slotId]
      return { ...current, members, revision: current.revision + 1, updatedAt: new Date().toISOString() }
    })
    await deps.activity('team.member_removed', teamId, next.revision, `Member ${member.displayName} removed`)
    deps.publish('team', teamId, next.revision, 'team.member_removed')
    return next
  }
  return deps.requireRuntime().removeMember(teamId, slotId)
}

export async function startTeam(deps: TeamDeps, teamId: string, options: MutationOptions = {}): Promise<TeamAggregate> {
  const team = requireTeam(deps.store, teamId)
  assertRevision('team', team.revision, options.expectedRevision)
  return deps.requireRuntime().startTeam(teamId)
}

export async function dissolveTeam(deps: TeamDeps,
  teamId: string,
  confirmation: string,
  options: MutationOptions = {},
): Promise<void> {
  const team = requireTeam(deps.store, teamId)
  assertRevision('team', team.revision, options.expectedRevision)
  if (confirmation !== team.name) {
    throw new AgentTeamError('INVALID_REQUEST', 'Team name confirmation does not match')
  }
  if (team.state !== 'draft') return deps.requireRuntime().dissolveTeam(teamId)
  await deleteTeamRecords(deps, teamId)
}

export async function deleteTeamRecords(deps: TeamDeps, teamId: string): Promise<void> {
  const team = requireTeam(deps.store, teamId)
  await Promise.all(deps.store.listMessages(teamId).map(message => deps.store.deleteMessage(message.id)))
  await Promise.all(deps.store.listConversations(teamId).map(conversation => deps.store.deleteConversation(conversation.id)))
  await Promise.all(deps.store.listActivities(teamId).map(activity => deps.store.deleteActivity(activity.id)))
  await deps.store.deleteTeam(teamId)
  await deps.workspace.unwatch(teamId)
  deps.publish('team', teamId, team.revision + 1, 'team.deleted')
}

export async function purgeTeamRecords(deps: TeamDeps, teamId: string): Promise<void> {
  const team = deps.store.getTeam(teamId)
  if (team === undefined) return
  await Promise.all(deps.store.listMessages(teamId).map(message => deps.store.deleteMessage(message.id)))
  await Promise.all(deps.store.listConversations(teamId).map(conversation => deps.store.deleteConversation(conversation.id)))
  await Promise.all(deps.store.listActivities(teamId).map(activity => deps.store.deleteActivity(activity.id)))
  await Promise.all(deps.store.listOperations().filter(operation => operation.teamId === teamId).map(operation => deps.store.deleteOperation(operation.id)))
  await deps.store.deleteTeam(teamId)
  await deps.workspace.unwatch(teamId)
  deps.publish('team', teamId, team.revision + 1, 'team.deleted')
}

/**
 * Clone a member onto a new slot. The clone points at the same assistant, so it
 * inherits that assistant's *current* configuration; copying a frozen snapshot
 * here would carry a stale model into the new team.
 */
function cloneMemberSlot(source: TeamMemberSlot, now: string): TeamMemberSlot {
  const slotId = randomUUID()
  return {
    id: slotId,
    assistantId: source.assistantId,
    displayName: source.displayName,
    role: source.role,
    permissionPresetId: source.permissionPresetId,
    ...(source.reasoningEffort === undefined ? {} : { reasoningEffort: source.reasoningEffort }),
    ruleAllowlist: [...source.ruleAllowlist],
    desiredState: 'offline',
    lastRuntimeState: 'offline',
    joinedAt: now,
  }
}

function assertMemberHasNoOpenTasks(team: TeamAggregate, slotId: string): void {
  const open = Object.values(team.tasks).filter(task =>
    taskAssigneeIds(task).includes(slotId) && !['completed', 'failed', 'cancelled'].includes(task.status))
  if (open.length > 0) {
    throw new AgentTeamError(
      'MEMBER_BUSY',
      'Reassign, complete, fail, or cancel this member’s open tasks before removal',
      { taskIds: open.map(task => task.id) },
    )
  }
}