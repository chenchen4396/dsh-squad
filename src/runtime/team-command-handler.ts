import { randomUUID } from 'node:crypto'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { AgentTeamError } from '../domain/errors.js'
import { taskAssigneeIds } from '../domain/team-selectors.js'
import type { TeamAggregate, TeamTask } from '../domain/types.js'
import type { AgentTeamService } from '../service/agent-team-service.js'
import {
  assignmentContent,
  createTaskDispatchMessage,
  createTeamMessage,
  reassignmentContent,
  requireMessageContent,
  taskMessageType,
  taskUpdateContent,
  teamMessageHeader,
} from './team-messages.js'

interface TeamCommandPort {
  deliverMessage: (teamId: string, messageId: string) => Promise<boolean>
  followup: (
    teamId: string,
    conversationId: string,
    slotId: string,
    message: UserMessage,
  ) => void
}

export class TeamCommandHandler {
  constructor(
    private readonly service: AgentTeamService,
    private readonly port: TeamCommandPort,
  ) {}

  async createTask(
    teamId: string,
    conversationId: string,
    creatorSlotId: string,
    input: {
      title: string
      description?: string
      ownerSlotId?: string
      ownerSlotIds?: string[]
      fileScopes?: string[]
      dependencyIds?: string[]
    },
  ): Promise<{ taskId: string; status: string; deliveryState?: 'queued' | 'delivered' }> {
    const team = this.service.getTeam(teamId)
    if (team.leaderSlotId !== creatorSlotId) {
      throw new AgentTeamError('INVALID_REQUEST', 'Only the current team leader may create tasks')
    }
    const owners = uniqueStrings([
      ...(input.ownerSlotIds ?? []),
      ...(input.ownerSlotId === undefined ? [] : [input.ownerSlotId]),
    ])
    for (const slotId of owners) {
      if (team.members[slotId] === undefined) {
        throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown task owner '${slotId}'`)
      }
    }
    const title = requireShortText(input.title, 'Task title', 500)
    const now = new Date().toISOString()
    const taskId = randomUUID()
    const status = owners.length === 0 ? 'pending' as const : 'assigned' as const
    const fileScopes = uniqueStrings(input.fileScopes ?? [])
    const dependencyIds = this.requireDependencies(team, conversationId, taskId, input.dependencyIds ?? [])
    /**
     * Everyone named on the task is woken with it, so a task given to several
     * members is worked on by all of them instead of waiting on one owner.
     */
    const assignments = owners
      .filter(slotId => slotId !== creatorSlotId)
      .map(slotId => createTaskDispatchMessage({
        team,
        conversationId,
        senderSlotId: creatorSlotId,
        recipientSlotId: slotId,
        taskId,
        type: 'instruction',
        content: assignmentContent(
          title,
          input.description?.trim() ?? '',
          fileScopes,
          owners
            .filter(collaborator => collaborator !== slotId)
            .map(collaborator => team.members[collaborator]?.displayName ?? collaborator),
        ),
      }))
    await this.service.updateRuntimeTeam(
      teamId,
      current => ({
        ...current,
        tasks: {
          ...current.tasks,
          [taskId]: {
            id: taskId,
            title,
            description: input.description?.trim() ?? '',
            status,
            conversationId,
            ownerSlotIds: owners,
            ...(owners.length === 0 ? {} : { ownerSlotId: owners[0]! }),
            createdBySlotId: creatorSlotId,
            dependencyIds,
            fileScopes,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          },
        },
        outbox: assignments.length === 0
          ? current.outbox
          : {
              ...current.outbox,
              ...Object.fromEntries(assignments.map(assignment => [assignment.id, assignment])),
            },
      }),
      'team.task_created',
      `Task ${title} created`,
    )
    if (assignments.length === 0) return { taskId, status }
    let delivered = true
    for (const assignment of assignments) {
      delivered = await this.port.deliverMessage(teamId, assignment.id) && delivered
    }
    return { taskId, status, deliveryState: delivered ? 'delivered' : 'queued' }
  }

  async updateTask(
    teamId: string,
    conversationId: string,
    callerSlotId: string,
    input: {
      taskId: string
      status: 'pending' | 'assigned' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled'
      result?: string
      error?: string
      ownerSlotId?: string
      ownerSlotIds?: string[]
      /** Replaces this task's dependencies; omit to leave them as they are. */
      dependencyIds?: string[]
    },
  ): Promise<{ taskId: string; status: string; deliveryState?: 'queued' | 'delivered' }> {
    const team = this.service.getTeam(teamId)
    const task = team.tasks[input.taskId]
    if (task === undefined) throw new AgentTeamError('INVALID_REQUEST', `Unknown task '${input.taskId}'`)
    // The task board is conversation-scoped, so a member may only touch tasks
    // that belong to the conversation it is running in.
    if (task.conversationId !== conversationId) {
      throw new AgentTeamError('INVALID_REQUEST', `Task '${input.taskId}' belongs to another conversation`)
    }
    const currentOwners = taskAssigneeIds(task)
    if (callerSlotId !== team.leaderSlotId && !currentOwners.includes(callerSlotId)) {
      throw new AgentTeamError('INVALID_REQUEST', 'A member may update only a task it owns')
    }
    const requestedOwners = input.ownerSlotIds === undefined && input.ownerSlotId === undefined
      ? undefined
      : uniqueStrings([
          ...(input.ownerSlotIds ?? []),
          ...(input.ownerSlotId === undefined ? [] : [input.ownerSlotId]),
        ])
    /** An empty request changes nothing: a task always keeps at least one owner. */
    const nextOwners = requestedOwners === undefined || requestedOwners.length === 0
      ? undefined
      : requestedOwners
    if (nextOwners !== undefined) {
      if (callerSlotId !== team.leaderSlotId) {
        throw new AgentTeamError('INVALID_REQUEST', 'Only the team leader may reassign tasks')
      }
      for (const slotId of nextOwners) {
        if (team.members[slotId] === undefined) {
          throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown task owner '${slotId}'`)
        }
      }
    }
    /** Owners the leader just added; each one is woken with the task. */
    const addedOwners = (nextOwners ?? []).filter(slotId =>
      slotId !== callerSlotId && !currentOwners.includes(slotId))
    const assignments = addedOwners.map(slotId => createTaskDispatchMessage({
      team,
      conversationId,
      senderSlotId: callerSlotId,
      recipientSlotId: slotId,
      taskId: task.id,
      type: 'instruction',
      content: reassignmentContent(task.title, input.result, input.error),
    }))
    const notification = assignments.length > 0 || callerSlotId === team.leaderSlotId
      ? undefined
      : createTaskDispatchMessage({
        team,
        conversationId,
        senderSlotId: callerSlotId,
        recipientSlotId: team.leaderSlotId,
        taskId: task.id,
        type: taskMessageType(input.status),
        content: taskUpdateContent(task.title, input.status, input.result, input.error),
      })
    const outboxAdditions = [...assignments, ...(notification === undefined ? [] : [notification])]
    // Dependencies may only be rewired by the Leader: a member editing its own
    // board into a shape the team cannot run is worse than refusing the edit.
    if (input.dependencyIds !== undefined && callerSlotId !== team.leaderSlotId) {
      throw new AgentTeamError('INVALID_REQUEST', 'Only the team leader may change task dependencies')
    }
    const dependencyIds = input.dependencyIds === undefined
      ? undefined
      : this.requireDependencies(team, conversationId, task.id, input.dependencyIds)
    await this.service.updateRuntimeTeam(
      teamId,
      current => ({
        ...current,
        tasks: {
          ...current.tasks,
          [input.taskId]: {
            ...current.tasks[input.taskId]!,
            status: input.status,
            ...(input.result === undefined ? {} : { result: input.result }),
            ...(input.error === undefined ? {} : { error: input.error }),
            ...(nextOwners === undefined
              ? {}
              : { ownerSlotId: nextOwners[0]!, ownerSlotIds: nextOwners }),
            ...(dependencyIds === undefined ? {} : { dependencyIds }),
            revision: current.tasks[input.taskId]!.revision + 1,
            updatedAt: new Date().toISOString(),
          },
        },
        outbox: outboxAdditions.length === 0
          ? current.outbox
          : {
              ...current.outbox,
              ...Object.fromEntries(outboxAdditions.map(message => [message.id, message])),
            },
      }),
      'team.task_updated',
      `Task ${task.title} entered ${input.status}`,
    )
    if (outboxAdditions.length === 0) return { taskId: input.taskId, status: input.status }
    let delivered = true
    for (const message of outboxAdditions) {
      delivered = await this.port.deliverMessage(teamId, message.id) && delivered
    }
    return {
      taskId: input.taskId,
      status: input.status,
      deliveryState: delivered ? 'delivered' : 'queued',
    }
  }

  /**
   * Validate one task's dependencies before they are written.
   *
   * A dependency is only useful if the board can act on it, so every id has to
   * name a task of the same conversation, none may name the task itself, and the
   * result must stay acyclic: a cycle has no runnable order, and a board that
   * holds one can never finish.
   */
  private requireDependencies(
    team: TeamAggregate,
    conversationId: string,
    taskId: string,
    requested: readonly string[],
  ): string[] {
    const dependencyIds = uniqueStrings([...requested])
    for (const dependencyId of dependencyIds) {
      if (dependencyId === taskId) {
        throw new AgentTeamError('INVALID_REQUEST', 'A task cannot depend on itself')
      }
      const dependency = team.tasks[dependencyId]
      if (dependency === undefined || dependency.conversationId !== conversationId) {
        throw new AgentTeamError(
          'INVALID_REQUEST',
          `Unknown dependency '${dependencyId}': a task may only depend on a task of this conversation`,
        )
      }
    }
    const closes = dependencyIds.find(dependencyId =>
      reaches(team.tasks, dependencyId, taskId))
    if (closes !== undefined) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        `Dependency '${closes}' would create a cycle`,
      )
    }
    return dependencyIds
  }

  async sendMemberMessage(    teamId: string,
    conversationId: string,
    senderSlotId: string,
    recipientSlotId: string,
    rawContent: string,
    type: 'instruction' | 'progress' | 'result' | 'question' | 'warning' = 'progress',
  ): Promise<{ messageId: string; deliveryState: 'delivered' }> {
    const team = this.service.getTeam(teamId)
    const sender = team.members[senderSlotId]
    const recipient = team.members[recipientSlotId]
    if (sender === undefined || recipient === undefined) {
      throw new AgentTeamError('MEMBER_NOT_FOUND', 'Sender or recipient is not a current team member')
    }
    if (senderSlotId !== team.leaderSlotId && recipientSlotId !== team.leaderSlotId && !team.directMemberChat) {
      throw new AgentTeamError('INVALID_REQUEST', 'Direct member-to-member messages are disabled')
    }
    const content = requireMessageContent(rawContent)
    const relay = createUserMessage({
      content: [{ type: 'text', text: `${teamMessageHeader(sender.displayName, sender.id)}\n${content}` }],
      source: {
        kind: 'plugin',
        plugin: 'dsh-squad',
        form: 'relay',
      },
    })
    const record = createTeamMessage({
      id: String(relay.id),
      teamId,
      conversationId,
      sender: { kind: 'member', id: senderSlotId },
      recipient: recipientSlotId === team.leaderSlotId
        ? { kind: 'leader', slotId: recipientSlotId }
        : { kind: 'member', slotId: recipientSlotId },
      type,
      content,
      idempotencyKey: String(relay.id),
    })
    await this.service.putRuntimeMessage(record)
    try {
      this.port.followup(teamId, conversationId, recipientSlotId, relay)
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'delivered' })
      return { messageId: record.id, deliveryState: 'delivered' }
    } catch (error) {
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'failed' })
      throw error
    }
  }
}

/**
 * Whether `from` reaches `target` by following dependencies.
 *
 * Used to reject a dependency that would close a cycle. A visited set keeps a
 * pre-existing cycle (which validation already forbids, but a stored record may
 * still hold one) from looping forever.
 */
function reaches(
  tasks: Record<string, TeamTask>,
  from: string,
  target: string,
): boolean {
  const seen = new Set<string>()
  const stack = [from]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === target) return true
    if (seen.has(current)) continue
    seen.add(current)
    for (const next of tasks[current]?.dependencyIds ?? []) stack.push(next)
  }
  return false
}

function requireShortText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new AgentTeamError('INVALID_REQUEST', `${label} cannot be empty`)
  if (normalized.length > maxLength) throw new AgentTeamError('INVALID_REQUEST', `${label} is too long`)
  return normalized
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}
