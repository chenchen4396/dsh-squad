import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AgentTeamError } from '../domain/errors.js'

interface TeamToolHandlers {
  assertIdentity: (agent: Agent | undefined) => void
  getTaskBoard: () => {
    teamId: string
    revision: number
    tasks: Array<Record<string, string | number | string[]>>
  }
  createTask: (input: {
    title: string
    description?: string
    ownerSlotId?: string
    ownerSlotIds?: string[]
    fileScopes?: string[]
    dependencyIds?: string[]
  }) => Promise<{ taskId: string; status: string; deliveryState?: 'queued' | 'delivered' }>
  updateTask: (input: {
    taskId: string
    status: 'pending' | 'assigned' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled'
    result?: string
    error?: string
    ownerSlotId?: string
    ownerSlotIds?: string[]
    dependencyIds?: string[]
  }) => Promise<{ taskId: string; status: string; deliveryState?: 'queued' | 'delivered' }>
  sendMessage: (
    recipientSlotId: string,
    content: string,
    type?: 'instruction' | 'progress' | 'result' | 'question' | 'warning',
  ) => Promise<{ messageId: string; deliveryState: 'delivered' }>
  /**
   * Settle one member's pending question or approval. Members never talk to the
   * reader, so the Leader answers for the team — this is that answer.
   */
  /**
   * Settle one member's pending question or approval. Only the Leader is given
   * this: members never talk to the reader, so the Leader answers for the team.
   */
  answerMember?: (input: {
    interactionId: string
    decision?: 'allow' | 'deny'
    answers?: string[]
  }) => Promise<{ interactionId: string; answered: 'question' | 'approval' }>
}

/**
 * Expose the team tools on one Agent's scope.
 *
 * @param agentCtx - the scoped context of the Agent acting as leader or member.
 * @param handlers - identity check and team operations behind the tools.
 * @returns a disposer removing exactly the tools this call registered.
 */
export function registerTeamTools(
  agentCtx: Context,
  handlers: TeamToolHandlers,
): () => void {
  const disposers: Array<() => void> = []
  disposers.push(agentCtx.tools.register(defineTool({
    name: 'team_get_task_board',
    description: 'Read the current shared task board for this team.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (_args, exec) => {
      handlers.assertIdentity(exec.agent)
      return handlers.getTaskBoard()
    },
  })))
  disposers.push(agentCtx.tools.register(defineTool({
    name: 'team_create_task',
    description: [
      'Create and optionally assign a task on the shared team task board. Only the current leader may call this.',
      'Name one owner for a single-owner task, or several owners with ownerSlotIds to have them work on it in parallel.',
    ].join(' '),
    parameters: {
      title: { type: 'string', required: true },
      description: { type: 'string' },
      ownerSlotId: { type: 'string', description: 'Current member slot id to assign as the single owner.' },
      ownerSlotIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Member slot ids to work on this task together; every one of them is woken with the task at once.',
      },
      fileScopes: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative file scopes.' },
      dependencyIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task ids this task waits on. Its owner should not start before they complete; the board shows the dependency.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          deliveryState: { type: 'string', enum: ['queued', 'delivered'] },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Created team task ${value.taskId} (${value.status})${value.deliveryState === undefined ? '' : `; assignment ${value.deliveryState}`}`,
      }],
    },
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      return handlers.createTask(args)
    },
  })))
  disposers.push(agentCtx.tools.register(defineTool({
    name: 'team_update_task',
    description: 'Update a task you own; the team leader may update any task and reassign it.',
    parameters: {
      taskId: { type: 'string', required: true },
      status: {
        type: 'string',
        required: true,
        enum: ['pending', 'assigned', 'running', 'blocked', 'completed', 'failed', 'cancelled'],
      },
      result: { type: 'string' },
      error: { type: 'string' },
      ownerSlotId: { type: 'string', description: 'Leader-only reassignment target.' },
      ownerSlotIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Leader-only: the new owner set; newly added owners are woken with the task.',
      },
      dependencyIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Leader-only: replace the task ids this task waits on. Omit to leave them unchanged.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          deliveryState: { type: 'string', enum: ['queued', 'delivered'] },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Updated team task ${value.taskId} (${value.status})${value.deliveryState === undefined ? '' : `; notification ${value.deliveryState}`}`,
      }],
    },
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      return handlers.updateTask(args)
    },
  })))
  disposers.push(agentCtx.tools.register(defineTool({
    name: 'team_send_message',
    description: 'Send a message to another member in this team and wake that member.',
    parameters: {
      recipientSlotId: { type: 'string', required: true, description: 'Recipient member slot id.' },
      content: { type: 'string', required: true, description: 'Message content.' },
      type: {
        type: 'string',
        enum: ['instruction', 'progress', 'result', 'question', 'warning'],
        description: 'Message purpose.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          messageId: { type: 'string', required: true },
          deliveryState: { type: 'string', const: 'delivered', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `Delivered team message ${value.messageId}` }],
    },
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      return handlers.sendMessage(args.recipientSlotId, args.content, args.type)
    },
  })))
  if (handlers.answerMember !== undefined) disposers.push(agentCtx.tools.register(defineTool({
    name: 'team_answer_member',
    description: [
      'Answer a request a team member is waiting on: its question, or its sandbox',
      'escalation approval. Members cannot reach the user, so their request waits',
      'until the Leader answers it — the member stays blocked otherwise.',
    ].join(' '),
    parameters: {
      interactionId: {
        type: 'string',
        required: true,
        description: 'Interaction id from the member request message.',
      },
      decision: {
        type: 'string',
        enum: ['allow', 'deny'],
        description: 'For an approval request: allow or deny the escalation.',
      },
      answers: {
        type: 'array',
        items: { type: 'string' },
        description: [
          'For a question request: one answer per question, in the order the',
          'request lists them. An answer that matches an option label selects it',
          '(several labels separated by 、 or , select several); anything else is',
          'a free-form answer.',
        ].join(' '),
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          interactionId: { type: 'string', required: true },
          answered: { type: 'string', enum: ['question', 'approval'], required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `Answered ${value.interactionId}` }],
    },
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      const answer = handlers.answerMember
      if (answer === undefined) throw new AgentTeamError('INVALID_REQUEST', 'Caller cannot answer members')
      return answer(args)
    },
  })))
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
