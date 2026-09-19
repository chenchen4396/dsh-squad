import { randomUUID } from 'node:crypto'
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  bundleImportInputSchema,
  type BundleImportMode,
  type BundleImportSummary,
  type SquadBundle,
} from '../domain/bundle.js'
import { taskAssigneeIds } from '../domain/team-selectors.js'
import type { TeamMemberSlot, TeamTask } from '../domain/types.js'
import type { AgentTeamStore } from '../storage/store.js'

/**
 * Moving what this instance is configured with, in and out of a file.
 *
 * Kept out of the service because none of it is service state: both directions
 * are a function of the store and the file, which is also what makes them
 * testable without a runtime, a Session or an Agent.
 */

/**
 * Write what this instance is configured with into a portable file.
 *
 * Only configuration is exported. A team's conversations, member Sessions,
 * task results and file leases describe this machine's running state; they
 * would not survive the move and are not what a reader wants to share.
 */
export function exportConfigured(
store: AgentTeamStore,
input: { teamIds?: readonly string[] | undefined } = {},
): SquadBundle {
  const wanted = input.teamIds === undefined ? undefined : new Set(input.teamIds)
  const ruleDocuments = store.listRuleDocuments()
    .filter(document => wanted === undefined || documentIsUsed(store, document.id))
    .sort((left, right) => left.path.localeCompare(right.path))
  const ruleKeys = new Map(ruleDocuments.map(document => [document.id, `rule:${document.path}`]))
  const assistants = store.listAssistants()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  const assistantKeys = new Map(assistants.map(assistant => [assistant.id, `assistant:${assistant.name}`]))
  const teams = store.listTeams()
    .filter(team => wanted === undefined || wanted.has(team.id))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))

  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    assistants: assistants.map(assistant => ({
      key: assistantKeys.get(assistant.id)!,
      name: assistant.name,
      ...(assistant.description === undefined ? {} : { description: assistant.description }),
      ...(assistant.icon === undefined ? {} : { icon: assistant.icon }),
      instructions: assistant.instructions,
      provider: assistant.provider,
      model: assistant.model,
      ...(assistant.reasoningEffort === undefined ? {} : { reasoningEffort: assistant.reasoningEffort }),
      agentPresetId: assistant.agentPresetId,
      permissionPresetId: assistant.permissionPresetId,
      skillAllowlist: [...assistant.skillAllowlist],
      mcpServers: [...assistant.mcpServers],
      ruleDocumentKeys: assistant.ruleDocumentAllowlist
        .map(id => ruleKeys.get(id))
        .filter((key): key is string => key !== undefined),
    })),
    ruleDocuments: ruleDocuments.map(document => ({
      key: ruleKeys.get(document.id)!,
      schemaVersion: document.schemaVersion,
      path: document.path,
      title: document.title,
      fileName: document.fileName,
      content: document.content,
      bytes: document.bytes,
      importedAt: document.importedAt,
    })),
    teams: teams.map(team => {
      const memberKeys = new Map(Object.keys(team.members).map(id => [id, `member:${id}`]))
      const taskKeys = new Map(Object.keys(team.tasks).map(id => [id, `task:${id}`]))
      const members: SquadBundle['teams'][number]['members'] = {}
      for (const [id, member] of Object.entries(team.members)) {
        const assistantKey = assistantKeys.get(member.assistantId)
        if (assistantKey === undefined) continue
        members[memberKeys.get(id)!] = {
          displayName: member.displayName,
          role: member.role,
          permissionPresetId: member.permissionPresetId,
          ...(member.reasoningEffort === undefined ? {} : { reasoningEffort: member.reasoningEffort }),
          assistantKey,
        }
      }
      const tasks: SquadBundle['teams'][number]['tasks'] = {}
      for (const [id, task] of Object.entries(team.tasks)) {
        tasks[taskKeys.get(id)!] = {
          key: taskKeys.get(id)!,
          title: task.title,
          description: task.description,
          ownerKeys: taskAssigneeIds(task)
            .map(owner => memberKeys.get(owner))
            .filter((key): key is string => key !== undefined),
          dependencyIds: (task.dependencyIds ?? [])
            .map(dep => taskKeys.get(dep))
            .filter((key): key is string => key !== undefined),
          fileScopes: [...task.fileScopes],
        }
      }
      const leaderKey = memberKeys.get(team.leaderSlotId)
      return {
        name: team.name,
        directMemberChat: team.directMemberChat,
        leaderKey: leaderKey !== undefined && members[leaderKey] !== undefined
          ? leaderKey
          : Object.keys(members)[0] ?? 'member:leader',
        members,
        tasks,
      }
    }).filter(team => Object.keys(team.members).length > 0),
  }
}

/** Whether any assistant loads this document, used to trim an export. */
function documentIsUsed(store: AgentTeamStore, documentId: string): boolean {
  return store.listAssistants().some(assistant => assistant.ruleDocumentAllowlist.includes(documentId))
}

/**
 * Write a bundle into this instance.
 *
 * `copy` gives every record a fresh id, so importing a file twice leaves two
 * independent teams and never rewrites what is already here. `overwrite`
 * keeps the record that already carries the same name or path and updates it
 * in place — the same configuration moved between machines rather than a
 * second copy of it.
 */
export async function importInto(store: AgentTeamStore, raw: unknown): Promise<BundleImportSummary> {
  const input = bundleImportInputSchema.parse(raw)
  const mode: BundleImportMode = input.mode
  const bundle = input.bundle
  const warnings: string[] = []
  const now = new Date().toISOString()

  // Rule documents first: assistants reference them, and a document whose
  // path is unknown here is simply not imported rather than breaking the file.
  const documentIds = new Map<string, string>()
  let ruleDocumentsCreated = 0
  let ruleDocumentsUpdated = 0
  for (const document of bundle.ruleDocuments) {
    const existing = mode === 'overwrite'
      ? store.listRuleDocuments().find(current => current.path === document.path)
      : undefined
    if (existing !== undefined) {
      await store.putRuleDocument({
        ...existing,
        title: document.title,
        fileName: document.fileName,
        content: document.content,
        bytes: document.bytes,
        importedAt: document.importedAt,
      })
      documentIds.set(document.key, existing.id)
      ruleDocumentsUpdated += 1
      continue
    }
    const id = randomUUID()
    await store.putRuleDocument({
      schemaVersion: 1,
      id,
      path: document.path,
      title: document.title,
      fileName: document.fileName,
      content: document.content,
      bytes: document.bytes,
      importedAt: document.importedAt,
    })
    documentIds.set(document.key, id)
    ruleDocumentsCreated += 1
  }

  const assistantIds = new Map<string, string>()
  let assistantsCreated = 0
  let assistantsUpdated = 0
  for (const assistant of bundle.assistants) {
    const allowlist = assistant.ruleDocumentKeys
      .map(key => documentIds.get(key))
      .filter((id): id is string => id !== undefined)
    const existing = mode === 'overwrite'
      ? store.listAssistants().find(current => current.name === assistant.name)
      : undefined
    if (existing !== undefined) {
      await store.putAssistant({
        ...existing,
        description: assistant.description,
        icon: assistant.icon,
        instructions: assistant.instructions,
        provider: assistant.provider,
        model: assistant.model,
        reasoningEffort: assistant.reasoningEffort,
        agentPresetId: assistant.agentPresetId,
        permissionPresetId: assistant.permissionPresetId,
        skillAllowlist: [...assistant.skillAllowlist],
        mcpServers: [...assistant.mcpServers],
        ruleDocumentAllowlist: allowlist,
        revision: existing.revision + 1,
        updatedAt: now,
      })
      assistantIds.set(assistant.key, existing.id)
      assistantsUpdated += 1
      continue
    }
    const id = randomUUID()
    await store.putAssistant({
      schemaVersion: 1,
      id,
      name: assistant.name,
      ...(assistant.description === undefined ? {} : { description: assistant.description }),
      ...(assistant.icon === undefined ? {} : { icon: assistant.icon }),
      instructions: assistant.instructions,
      provider: assistant.provider,
      model: assistant.model,
      ...(assistant.reasoningEffort === undefined ? {} : { reasoningEffort: assistant.reasoningEffort }),
      agentPresetId: assistant.agentPresetId,
      permissionPresetId: assistant.permissionPresetId,
      skillAllowlist: [...assistant.skillAllowlist],
      mcpServers: [...assistant.mcpServers],
      ruleDocumentAllowlist: allowlist,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    assistantIds.set(assistant.key, id)
    assistantsCreated += 1
  }

  let teamsCreated = 0
  for (const team of bundle.teams) {
    const members: Record<string, TeamMemberSlot> = {}
    const memberIds = new Map<string, string>()
    let leaderSlotId = ''
    for (const [key, member] of Object.entries(team.members)) {
      const assistantId = assistantIds.get(member.assistantKey)
      if (assistantId === undefined) {
        warnings.push(`团队「${team.name}」的成员 ${member.displayName} 引用了文件里没有的助手，已跳过`)
        continue
      }
      const id = randomUUID()
      memberIds.set(key, id)
      members[id] = {
        id,
        assistantId,
        displayName: member.displayName,
        role: member.role,
        permissionPresetId: member.permissionPresetId,
        ...(member.reasoningEffort === undefined ? {} : { reasoningEffort: member.reasoningEffort }),
        ruleAllowlist: [],
        desiredState: 'offline',
        lastRuntimeState: 'offline',
        joinedAt: now,
      }
      if (member.role === 'leader') leaderSlotId = id
    }
    if (leaderSlotId === '') {
      const fallback = memberIds.get(team.leaderKey)
      if (fallback === undefined) {
        warnings.push(`团队「${team.name}」没有可用的 Leader，已跳过`)
        continue
      }
      leaderSlotId = fallback
      // Exactly one leader is an invariant of a team, so a file that named
      // none still arrives with one.
      members[leaderSlotId] = { ...members[leaderSlotId]!, role: 'leader' }
    }

    const tasks: Record<string, TeamTask> = {}
    const taskIds = new Map<string, string>()
    for (const [key, task] of Object.entries(team.tasks)) taskIds.set(key, randomUUID())
    for (const [key, task] of Object.entries(team.tasks)) {
      const id = taskIds.get(key)!
      tasks[id] = {
        id,
        title: task.title,
        description: task.description,
        status: 'pending',
        ownerSlotIds: task.ownerKeys
          .map(owner => memberIds.get(owner))
          .filter((value): value is string => value !== undefined),
        createdBySlotId: leaderSlotId,
        dependencyIds: task.dependencyIds
          .map(dep => taskIds.get(dep))
          .filter((value): value is string => value !== undefined),
        fileScopes: [...task.fileScopes],
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }
    }

    await store.putTeam({
      schemaVersion: 1,
      id: randomUUID(),
      name: team.name,
      leaderSlotId,
      state: 'draft',
      directMemberChat: team.directMemberChat,
      members,
      retiredSessions: {},
      tasks,
      leases: {},
      outbox: {},
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    teamsCreated += 1
  }

  return {
    mode,
    assistantsCreated,
    assistantsUpdated,
    ruleDocumentsCreated,
    ruleDocumentsUpdated,
    teamsCreated,
    warnings,
  }
}
