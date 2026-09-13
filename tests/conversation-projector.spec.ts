import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { projectContextUsage, projectConversation, projectRoom } from '../src/runtime/conversation-projector.js'

describe('projectConversation', () => {
  it('projects user messages and final assistant text with reasoning', () => {
    const projected = projectConversation([
      event(0, 'user/message', {
        id: 'user-1', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: 'Build it' }],
      }),
      event(1, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: 'assistant-1', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'codex' },
          content: [
            { type: 'reasoning', text: 'Checking files' },
            { type: 'text', text: 'Working' },
          ],
        },
      }),
    ])

    expect(projected.throughSeq).toBe(1)
    expect(projected.nodes).toEqual([
      expect.objectContaining({ kind: 'user', text: 'Build it' }),
      expect.objectContaining({ kind: 'assistant', text: 'Working', reasoning: 'Checking files' }),
    ])
  })

  it('pairs a tool call with its result', () => {
    const projected = projectConversation([
      event(0, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: 'assistant-1', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'codex' },
          content: [{ type: 'text', text: 'Final answer' }],
        },
      }),
      event(2, 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"path":"a.ts"}' }),
      event(3, 'tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: 'tool-result-1', role: 'user', source: { kind: 'tool', callId: 'call-1' },
          content: [{
            type: 'tool-result', toolCallId: 'call-1', isError: false,
            content: [{ type: 'text', text: 'file contents' }],
          }],
        },
      }),
    ])

    expect(projected.nodes).toEqual([
      expect.objectContaining({ kind: 'assistant', text: 'Final answer' }),
      expect.objectContaining({ kind: 'tool', name: 'read', status: 'success', result: 'file contents' }),
    ])
  })

  it('projects reasoning and text from one persisted assistant message', () => {
    const projected = projectConversation([
      timedEvent(2, 3_500, 'assistant/message', {
        turn: 3,
        step: 1,
        message: {
          id: 'assistant-3', role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          content: [
            { type: 'reasoning', text: '分析完成' },
            { type: 'text', text: '最终回答' },
          ],
        },
      }),
    ])

    expect(projected.nodes).toEqual([
      expect.objectContaining({
        kind: 'assistant',
        text: '最终回答',
        reasoning: '分析完成',
      }),
    ])
  })

  it('keeps model-facing context out of the visible conversation', () => {
    const projected = projectConversation([
      event(0, 'user/message', {
        id: 'context-snapshot', role: 'user',
        source: {
          kind: 'plugin', plugin: 'dsh-runtime-context', form: 'snapshot',
          sections: [{ name: 'policy', text: 'Current runtime context' }],
        },
        content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier snapshots.' }],
      }),
      event(1, 'user/message', {
        id: 'skills-catalog', role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-skills', form: 'catalog' },
        content: [{ type: 'text', text: '<system-reminder><available_skills>secret catalog</available_skills></system-reminder>' }],
      }),
      event(2, 'user/message', {
        id: 'user-1', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: '你好' }],
      }),
      event(3, 'user/message', {
        id: 'relay-1', role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-squad', form: 'relay' },
        content: [{ type: 'text', text: 'Leader 分配的任务' }],
      }),
      event(4, 'user/message', {
        id: 'foreign-relay', role: 'user',
        source: { kind: 'plugin', plugin: 'another-plugin', form: 'relay' },
        content: [{ type: 'text', text: '其他插件的内部转发' }],
      }),
    ])

    expect(projected.nodes).toEqual([
      expect.objectContaining({ kind: 'user', text: '你好' }),
      expect.objectContaining({ kind: 'user', text: 'Leader 分配的任务' }),
    ])
    expect(JSON.stringify(projected.nodes)).not.toContain('Current runtime context')
    expect(JSON.stringify(projected.nodes)).not.toContain('available_skills')
  })

  it('projects persisted member relays as structured compact team messages', () => {
    const projected = projectConversation([
      event(0, 'user/message', {
        id: 'relay-1', role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-squad', form: 'relay' },
        content: [{ type: 'text', text: '[Team message from Coder]\nParser implemented.' }],
      }),
    ], 240, {
      team: {
        leaderSlotId: 'leader-1',
        members: {
          'leader-1': { id: 'leader-1', displayName: 'Lead' },
          'member-1': { id: 'member-1', displayName: 'Coder' },
        },
        retiredSessions: {},
      } as never,
      messages: [{
        id: 'relay-1',
        sender: { kind: 'member', id: 'member-1' },
        type: 'result',
        content: 'Parser implemented.',
        relatedTaskId: 'task-1',
      } as never],
    })

    expect(projected.nodes).toEqual([{
      id: 'relay-1',
      kind: 'team-message',
      seq: 0,
      time: 1_700_000_000_000,
      text: 'Parser implemented.',
      senderName: 'Coder',
      senderId: 'member-1',
      senderRole: 'member',
      messageType: 'result',
      relatedTaskId: 'task-1',
    }])
  })
})

describe('projectContextUsage', () => {
  it('uses the latest prompt-side provider sample and context capacity', () => {
    const projected = projectContextUsage([
      event(0, 'request/context', { provider: 'zai-coding-cn', model: 'glm-5.3', contextWindow: 128_000 }),
      event(1, 'assistant/message', {
        turn: 2,
        step: 1,
        message: {
          id: 'assistant-2', role: 'assistant', source: { kind: 'model', provider: 'zai-coding-cn', model: 'glm-5.3' },
          content: [{ type: 'text', text: 'Latest' }],
        },
        usage: { inputTokens: 2_000, outputTokens: 400, cacheReadTokens: 4_000, cacheWriteTokens: 500 },
      }),
    ])

    expect(projected).toEqual({
      usedTokens: 6_900,
      inputTokens: 6_500,
      outputTokens: 400,
      cacheReadTokens: 4_000,
      cacheWriteTokens: 500,
      reasoningTokens: 0,
      contextWindow: 128_000,
    })
  })

  it('requires real usage but still reports details when the window is unknown', () => {
    expect(projectContextUsage([
      event(0, 'request/context', { provider: 'openai', model: 'codex', contextWindow: 200_000 }),
    ])).toBeUndefined()
    expect(projectContextUsage([
      event(0, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: 'assistant-1', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'codex' },
          content: [],
        },
        usage: { inputTokens: 1_000, outputTokens: 100 },
      }),
    ])).toEqual({
      usedTokens: 1_100,
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    })
  })

  it('drops relay echoes only from the transcript that owns the user composer', () => {
    const events = [
      event(0, 'user/message', {
        id: 'user-1', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: '@Coder 处理登录' }],
      }),
      event(1, 'user/message', {
        id: 'relay-1', role: 'user', source: { kind: 'user' },
        content: [{
          type: 'text',
          text: '[会议室] 团队会议室有新消息，请在会议室中回应。\n@Coder 处理登录',
        }],
      }),
      event(2, 'user/message', {
        id: 'relay-2', role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-squad', form: 'relay' },
        content: [{ type: 'text', text: '@Coder 处理登录' }],
      }),
    ]
    const team = { leaderSlotId: 'lead', members: {}, retiredSessions: {} }

    expect(projectConversation(events, 50, { team: team as never, messages: [] }).nodes.map(node => node.id))
      .toEqual(['user-1', 'relay-1', 'relay-2'])
    expect(projectConversation(events, 50, {
      team: team as never,
      messages: [],
      hideRelayEchoes: true,
    }).nodes.map(node => node.id)).toEqual(['user-1'])
  })
})

function event(seq: number, type: SessionEvent['type'], data: unknown): SessionEvent {
  return { seq, time: 1_700_000_000_000 + seq, type, data } as SessionEvent
}

function timedEvent(seq: number, time: number, type: SessionEvent['type'], data: unknown): SessionEvent {
  return { seq, time, type, data } as SessionEvent
}

describe('projectRoom', () => {
  it('merges every member Session event with the conversation messages in time order', () => {
    const team = {
      leaderSlotId: 'lead',
      members: {
        lead: { id: 'lead', displayName: 'Leader', role: 'leader' as const },
        coder: { id: 'coder', displayName: 'Coder', role: 'member' as const },
      },
      retiredSessions: {},
    }
    const projected = projectRoom(
      team as never,
      [
        {
          member: team.members.lead,
          events: [
            event(1, 'assistant/message', {
              turn: 1,
              step: 1,
              message: {
                id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'codex' },
                content: [{ type: 'text', text: '规划如下' }],
              },
            }),
          ],
        },
        {
          member: team.members.coder,
          events: [
            event(4, 'assistant/message', {
              turn: 1,
              step: 1,
              message: {
                id: 'a2', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'codex' },
                content: [{ type: 'text', text: '已完成登录改造' }],
              },
            }),
          ],
        },
      ],
      [
        {
          id: 'm1',
          teamId: 't1',
          conversationId: 'c2',
          sender: { kind: 'user', id: 'local-user' },
          recipient: { kind: 'broadcast' },
          type: 'instruction',
          content: '@Coder 处理登录',
          mentions: ['coder'],
          attachments: [],
          deliveryState: 'delivered',
          idempotencyKey: 'm1',
          createdAt: new Date(1_700_000_000_000).toISOString(),
        },
      ] as never,
    )

    // Sessions are conversation-scoped, so every event in them belongs here.
    expect(projected.messages.map(message => message.text)).toEqual([
      '@Coder 处理登录',
      '规划如下',
      '已完成登录改造',
    ])
    expect(projected.messages[0]).toMatchObject({ kind: 'user', senderRole: 'user', mentions: ['coder'] })
    expect(projected.messages[2]).toMatchObject({ kind: 'agent', senderName: 'Coder', senderRole: 'member' })
    expect(projected.throughSeq).toBe(4)
  })

  it('shows the user line once and drops the relay copies that woke a member', () => {
    const team = {
      leaderSlotId: 'lead',
      members: {
        lead: { id: 'lead', displayName: 'Leader', role: 'leader' as const },
        coder: { id: 'coder', displayName: 'Coder', role: 'member' as const },
      },
      retiredSessions: {},
    }
    const relayText = '@Coder 处理登录'
    const legacyRelayText = '[会议室] 团队会议室有新消息，请在会议室中回应。\n@Coder 处理登录'
    const projected = projectRoom(
      team as never,
      [
        {
          member: team.members.coder,
          events: [
            // A wake-up carries the reader's own text and is known by the
            // plugin source on the event it injected; an earlier version wrote
            // its relay back into the Session as user input instead.
            event(1, 'user/message', {
              id: 'relay-1', role: 'user',
              source: { kind: 'plugin', plugin: 'dsh-squad', form: 'relay' },
              content: [{ type: 'text', text: relayText }],
            }),
            event(2, 'user/message', {
              id: 'relay-legacy', role: 'user',
              source: { kind: 'user' },
              content: [{ type: 'text', text: legacyRelayText }],
            }),
            event(3, 'assistant/message', {
              turn: 1,
              step: 1,
              message: {
                id: 'a2', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'codex' },
                content: [{ type: 'text', text: '已完成登录改造' }],
              },
            }),
          ],
        },
      ],
      [
        {
          id: 'm1',
          teamId: 't1',
          conversationId: 'c2',
          sender: { kind: 'user', id: 'local-user' },
          recipient: { kind: 'broadcast' },
          type: 'instruction',
          content: '@Coder 处理登录',
          mentions: ['coder'],
          attachments: [],
          deliveryState: 'delivered',
          idempotencyKey: 'm1',
          createdAt: new Date(1_700_000_000_000).toISOString(),
        },
      ] as never,
    )

    expect(projected.messages.map(message => message.text)).toEqual([
      '@Coder 处理登录',
      '已完成登录改造',
    ])
  })

  it('speaks once per turn, keeping the last message and dropping the commentary', () => {
    const member = { id: 'lead', displayName: 'Leader', role: 'leader' as const }
    const assistant = (seq: number, id: string, turn: number, step: number, text: string) =>
      event(seq, 'assistant/message', {
        turn,
        step,
        message: {
          id, role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'codex' },
          content: text.length === 0 ? [] : [{ type: 'text', text }],
        },
      })
    const projected = projectRoom(
      { leaderSlotId: 'lead', members: { lead: member }, retiredSessions: {} } as never,
      [
        {
          member,
          events: [
            // One interaction: the model narrates, calls tools, and only the
            // last thing it said is the answer.
            assistant(1, 'a1', 1, 1, '我先看一下仓库'),
            assistant(2, 'a2', 1, 2, ''),
            assistant(3, 'a3', 1, 3, '结论：已有实现'),
            assistant(4, 'a4', 2, 1, '第二轮开始'),
          ],
        },
      ],
      [],
    )

    expect(projected.messages.map(message => message.text)).toEqual(['结论：已有实现', '第二轮开始'])
    expect(projected.messages.map(message => message.id)).toEqual(['lead:turn:1', 'lead:turn:2'])
    expect(projected.messages.every(message => message.kind === 'agent')).toBe(true)
  })

  it('holds back the turn a member is still speaking in', () => {
    const member = { id: 'lead', displayName: 'Leader', role: 'leader' as const }
    const message = (id: string, turn: number, text: string) =>
      event(turn * 10, 'assistant/message', {
        turn,
        step: 1,
        message: {
          id, role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'codex' },
          content: [{ type: 'text', text }],
        },
      })
    const room = (events: SessionEvent[]) => projectRoom(
      { leaderSlotId: 'lead', members: { lead: member }, retiredSessions: {} } as never,
      [{ member, events }],
      [],
    ).messages.map(entry => entry.text)

    const speaking = [
      timedEvent(1, 1_700_000_000_001, 'turn/start', { turn: 1 }),
      message('a1', 1, '第一轮答案'),
      timedEvent(3, 1_700_000_000_003, 'turn/end', { turn: 1, reason: 'success' }),
      timedEvent(4, 1_700_000_000_004, 'turn/start', { turn: 2 }),
      message('a2', 2, '第二轮说到一半'),
    ]

    // What a member is still writing is not something it said yet.
    expect(room(speaking)).toEqual(['第一轮答案'])
    expect(room([...speaking, timedEvent(6, 1_700_000_000_006, 'turn/end', { turn: 2, reason: 'success' })]))
      .toEqual(['第一轮答案', '第二轮说到一半'])
  })

  it('leaves the task board out of the room', () => {    const team = {
      leaderSlotId: 'lead',
      members: {
        lead: { id: 'lead', displayName: 'Leader', role: 'leader' as const },
        coder: { id: 'coder', displayName: 'Coder', role: 'member' as const },
      },
      retiredSessions: {},
    }
    const dispatch = (id: string, sender: string, type: string, content: string, taskId?: string) => ({
      id,
      teamId: 't1',
      conversationId: 'c1',
      sender: { kind: 'member', id: sender },
      recipient: { kind: 'member', slotId: 'coder' },
      type,
      content,
      ...(taskId === undefined ? {} : { relatedTaskId: taskId }),
      attachments: [],
      deliveryState: 'delivered',
      idempotencyKey: id,
      createdAt: new Date(1_700_000_000_000).toISOString(),
    })
    const projected = projectRoom(
      team as never,
      [],
      [
        dispatch('m1', 'lead', 'instruction', 'A team task has been assigned to you: 修登录', 'task-1'),
        dispatch('m2', 'coder', 'progress', 'Task update: 修登录\nStatus: running', 'task-1'),
        dispatch('m3', 'coder', 'result', '【Coder 交付完成】登录已修好'),
      ] as never,
    )

    // The board writes the first two behind the member's back; the third is the
    // member's own report of the same task.
    expect(projected.messages.map(entry => entry.text)).toEqual(['【Coder 交付完成】登录已修好'])
  })

  it('shows what a busy member delivered, not what it reported on the way', () => {
    const coder = { id: 'coder', displayName: 'Coder', role: 'member' as const }
    const authored = (id: string, type: string, at: number, content: string) => ({
      id,
      teamId: 't1',
      conversationId: 'c1',
      sender: { kind: 'member', id: 'coder' },
      recipient: { kind: 'leader', slotId: 'lead' },
      type,
      content,
      attachments: [],
      deliveryState: 'delivered',
      idempotencyKey: id,
      createdAt: new Date(at).toISOString(),
    })
    const projected = projectRoom(
      {
        leaderSlotId: 'lead',
        members: { coder },
        retiredSessions: {},
        tasks: {
          t: {
            id: 't', title: '修登录', description: '', status: 'running',
            ownerSlotIds: ['coder'], dependencyIds: [], fileScopes: [], revision: 1,
            createdAt: new Date(2_000).toISOString(), updatedAt: new Date(2_000).toISOString(),
          },
        },
      } as never,
      [],
      [
        authored('m1', 'progress', 3_000, '进度：还在写'),
        authored('m2', 'result', 3_500, '【Coder 交付完成】登录已修好'),
      ] as never,
    )

    // A result is what the task produced, so the room keeps it even though the
    // member had not closed the task yet.
    expect(projected.messages.map(message => message.text)).toEqual(['【Coder 交付完成】登录已修好'])
  })

  it('shows what answers the reader, and team process only while nothing is in flight', () => {
    const lead = { id: 'lead', displayName: 'Leader', role: 'leader' as const }
    const say = (seq: number, at: number, text: string) => ({
      ...event(seq, 'assistant/message', {
        turn: seq,
        step: 1,
        message: {
          id: `a${seq}`, role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'codex' },
          content: [{ type: 'text', text }],
        },
      }),
      time: at,
    })
    const projected = projectRoom(
      {
        leaderSlotId: 'lead',
        members: { lead },
        retiredSessions: {},
        tasks: {
          t: {
            id: 't', title: '修登录', description: '', status: 'running',
            ownerSlotIds: ['coder'], conversationId: 'c1', dependencyIds: [], fileScopes: [],
            revision: 1, createdAt: new Date(2_000).toISOString(), updatedAt: new Date(2_000).toISOString(),
          },
        },
      } as never,
      [{
        member: lead,
        events: [
          // A turn opens before the loop claims the input it runs on, so the
          // input that follows a `turn/start` is what the turn answers.
          timedEvent(1, 900, 'turn/start', { turn: 1 }),
          timedEvent(2, 1_000, 'user/message', {
            id: 'u0', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '开始吧' }],
          }),
          say(1, 1_100, '还没开工时的发言'),
          // The reader asks again: whatever answers them is the room's business.
          timedEvent(4, 1_500, 'turn/start', { turn: 2 }),
          timedEvent(5, 1_600, 'user/message', {
            id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }],
          }),
          say(2, 2_500, '回答你的那一句'),
          // A member's report arrives: the Leader's reaction to it is process.
          timedEvent(8, 3_000, 'turn/start', { turn: 3 }),
          timedEvent(9, 3_100, 'user/message', {
            id: 't1', role: 'user',
            source: { kind: 'plugin', plugin: 'dsh-squad', form: 'relay' },
            content: [{ type: 'text', text: '[Team message from Coder; slotId=coder]\n做完了' }],
          }),
          say(3, 3_500, '收到成员进度，无需干预'),
        ],
      }],
      [{
        id: 'u1',
        teamId: 't1',
        conversationId: 'c1',
        sender: { kind: 'user', id: 'local-user' },
        recipient: { kind: 'broadcast' },
        type: 'instruction',
        content: '你好',
        attachments: [],
        deliveryState: 'delivered',
        idempotencyKey: 'u1',
        createdAt: new Date(1_600).toISOString(),
      }] as never,
      { conversationId: 'c1' },
    )

    expect(projected.messages.map(message => message.text))
      .toEqual(['开始吧', '还没开工时的发言', '你好', '回答你的那一句'])
  })

  it('keeps one entry per message when the log predates turn markers', () => {
    const member = { id: 'coder', displayName: 'Coder', role: 'member' as const }
    const projected = projectRoom(
      { leaderSlotId: 'lead', members: { coder: member }, retiredSessions: {} } as never,
      [
        {
          member,
          events: [
            event(1, 'assistant/message', {
              message: {
                id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'codex' },
                content: [{ type: 'text', text: '旧日志第一条' }],
              },
            }),
            event(2, 'assistant/message', {
              message: {
                id: 'a2', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'codex' },
                content: [{ type: 'text', text: '旧日志第二条' }],
              },
            }),
          ],
        },
      ],
      [],
    )

    expect(projected.messages.map(message => message.text)).toEqual(['旧日志第一条', '旧日志第二条'])
  })

  it('keeps a member quiet while it holds a task, and lets it speak after', () => {
    const coder = { id: 'coder', displayName: 'Coder', role: 'member' as const }
    const task = (status: string, createdAt: string, updatedAt: string) => ({
      id: 'task-1',
      title: '修登录',
      description: '',
      status,
      ownerSlotIds: ['coder'],
      dependencyIds: [],
      fileScopes: [],
      revision: 1,
      createdAt,
      updatedAt,
    })
    const utterance = (seq: number, at: number, text: string) => {
      const node = event(seq, 'assistant/message', {
        turn: seq,
        step: 1,
        message: {
          id: `a${seq}`, role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'codex' },
          content: [{ type: 'text', text }],
        },
      })
      return { ...node, time: at }
    }
    const project = (tasks: unknown) => projectRoom(
      { leaderSlotId: 'lead', members: { coder }, retiredSessions: {}, tasks } as never,
      [{
        member: coder,
        events: [
          // Before the task, while it runs, and after it was closed.
          utterance(1, 1_000, '任务前的问题'),
          utterance(2, 3_000, '任务进行中的碎片'),
          utterance(3, 5_000, '交付完成'),
        ],
      }],
      [],
    ).messages.map(message => message.text)

    // The task runs 2s..4s, so only the fragment inside it disappears.
    expect(project([task('completed', '1970-01-01T00:00:02.000Z', '1970-01-01T00:00:04.000Z')]))
      .toEqual(['任务前的问题', '交付完成'])
    // Still running: everything from its creation on stays out.
    expect(project([task('running', '1970-01-01T00:00:02.000Z', '1970-01-01T00:00:02.000Z')]))
      .toEqual(['任务前的问题'])
  })

  it('stops an abandoned task from muting its owner for good', () => {
    const coder = { id: 'coder', displayName: 'Coder', role: 'member' as const }
    const task = (id: string, status: string, createdAt: string, updatedAt: string) => ({
      id,
      title: id,
      description: '',
      status,
      ownerSlotIds: ['coder'],
      dependencyIds: [],
      fileScopes: [],
      revision: 1,
      createdAt,
      updatedAt,
    })
    const utterance = (at: number, text: string) => ({
      ...event(1, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: `a${at}`, role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'codex' },
          content: [{ type: 'text', text }],
        },
      }),
      time: at,
    })
    const projected = projectRoom(
      {
        leaderSlotId: 'lead',
        members: { coder },
        retiredSessions: {},
        // The first task was never closed — a crash, an abandoned run. The
        // member moved on, so that task can only speak for its own stretch.
        tasks: {
          old: task('old', 'running', '1970-01-01T00:00:02.000Z', '1970-01-01T00:00:02.000Z'),
          next: task('next', 'completed', '1970-01-01T00:00:04.000Z', '1970-01-01T00:00:06.000Z'),
        },
      } as never,
      [{
        member: coder,
        events: [utterance(5_000, '第二个任务进行中'), utterance(7_000, '两个任务都结束了')],
      }],
      [],
    )

    expect(projected.messages.map(message => message.text)).toEqual(['两个任务都结束了'])
  })
})
