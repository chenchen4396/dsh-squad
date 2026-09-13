import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AgentTeamError } from '../src/domain/errors.js'
import {
  normalizeQuestionAnswers,
  TeamInteractionBridge,
} from '../src/runtime/team-interaction-bridge.js'

describe('TeamInteractionBridge', () => {
  it('claims an agent question, exposes it to the workbench, and settles the answerer', async () => {
    const onChange = vi.fn()
    const bridge = new TeamInteractionBridge({} as Context, {
      acceptsSession: id => id === 'session-1',
      onChange,
    })
    const agentCtx = fakeAgentContext()
    bridge.attach(agentCtx.ctx, agentOf('session-1'))

    const answered = agentCtx.ask('user-questions/request', {
      questions: [{
        id: 'language',
        question: '选择语言？',
        options: [{ label: 'TypeScript', description: '推荐' }, { label: 'Rust' }],
      }],
    })

    await vi.waitFor(() => {
      expect(bridge.list('session-1')).toEqual([expect.objectContaining({ kind: 'question' })])
    })
    const pending = bridge.list('session-1')[0]
    expect(pending).toBeDefined()

    await bridge.respond('session-1', pending!.id, {
      kind: 'question',
      answers: [{ id: 'language', selected: ['TypeScript'] }],
    })
    await expect(answered).resolves.toEqual({
      answers: [{ id: 'language', selected: ['TypeScript'] }],
    })
    expect(bridge.list('session-1')).toEqual([])
    expect(onChange).toHaveBeenCalled()
  })

  it('lets the Leader answer a request without naming the member Session', async () => {
    const bridge = new TeamInteractionBridge({} as Context, {
      acceptsSession: () => true,
      onChange: vi.fn(),
    })
    const agentCtx = fakeAgentContext()
    bridge.attach(agentCtx.ctx, agentOf('session-3'))

    const answered = agentCtx.ask('user-questions/request', {
      questions: [
        { id: 'path', question: '驱动放在哪个目录？', options: [{ label: 'IpmiPostCompleteDxe' }, { label: 'BmcOsHandoffDxe' }] },
        { id: 'why', question: '为什么这样选？' },
      ],
    })
    await vi.waitFor(() => { expect(bridge.list('session-3')).toHaveLength(1) })
    const pending = bridge.list('session-3')[0]

    // Members never reach the reader: the Leader answers for the team, naming
    // the request and answering in its own words.
    expect(pending?.askedAt).toBeTypeOf('number')
    expect(bridge.answerAsLeader(pending!.id, { answers: ['BmcOsHandoffDxe', '与现有包命名一致'] }))
      .toBe('question')
    await expect(answered).resolves.toEqual({
      answers: [
        { id: 'path', selected: ['BmcOsHandoffDxe'] },
        { id: 'why', selected: [], custom: '与现有包命名一致' },
      ],
    })
    expect(bridge.list('session-3')).toEqual([])
  })

  it('answers an approval from the Leader as one allowed or rejected outcome', async () => {
    const bridge = new TeamInteractionBridge({} as Context, {
      acceptsSession: () => true,
      onChange: vi.fn(),
    })
    const agentCtx = fakeAgentContext()
    const askedBy = agentOf('session-4', [{
      type: 'tool/call',
      data: {
        callId: 'call-1',
        name: 'write',
        arguments: JSON.stringify({ file_path: '/tmp/x', sandbox_permissions: 'workspace-write' }),
      },
    }])
    bridge.attach(agentCtx.ctx, askedBy)

    const outcome = agentCtx.ask('approval/request', {
      agent: askedBy,
      toolName: 'write',
      callId: 'call-1',
      reason: '需要写工作区',
    })
    await vi.waitFor(() => { expect(bridge.list('session-4')).toHaveLength(1) })
    const pending = bridge.list('session-4')[0]

    // The wider level it asks for is what the Leader's authority is judged on.
    expect(pending).toMatchObject({ kind: 'approval', requestedMode: 'workspace-write' })
    expect(bridge.answerAsLeader(pending!.id, { decision: 'allow' })).toBe('approval')
    await expect(outcome).resolves.toBe('allowed-once')
    expect(() => bridge.answerAsLeader('approval:missing', { decision: 'deny' }))
      .toThrow(AgentTeamError)
  })

  it('claims an approval request and returns the one-shot outcome', async () => {
    const bridge = new TeamInteractionBridge({} as Context, {
      acceptsSession: () => true,
      onChange: vi.fn(),
    })
    const agentCtx = fakeAgentContext()
    bridge.attach(agentCtx.ctx, agentOf('session-2'))

    const outcome = agentCtx.ask('approval/request', {
      toolName: 'bash',
      reason: '需要访问工作区之外的路径',
    })
    await vi.waitFor(() => { expect(bridge.list('session-2')).toHaveLength(1) })
    const pending = bridge.list('session-2')[0]

    await bridge.respond('session-2', pending!.id, { kind: 'approval', outcome: 'allowed-once' })
    await expect(outcome).resolves.toBe('allowed-once')
    expect(bridge.list('session-2')).toEqual([])
    await bridge.dispose()
  })

  it('rejects an unknown or already settled interaction', async () => {
    const bridge = new TeamInteractionBridge({} as Context, {
      acceptsSession: () => true,
      onChange: vi.fn(),
    })
    await expect(bridge.respond('session-3', 'missing', {
      kind: 'approval',
      outcome: 'rejected',
    })).rejects.toMatchObject({ code: 'INTERACTION_NOT_FOUND' })
  })

  it('leaves a Session it does not own to the Harness interface', async () => {
    const bridge = new TeamInteractionBridge({} as Context, {
      acceptsSession: id => id === 'member-session',
      onChange: vi.fn(),
    })
    const agentCtx = fakeAgentContext()
    bridge.attach(agentCtx.ctx, agentOf('leader-session'))

    // The Leader is the user's own Agent: its question has to reach the
    // Harness box, not be held here until the workbench is opened.
    await expect(agentCtx.ask('user-questions/request', {
      questions: [{ id: 'path', question: '驱动放在哪个目录？' }],
    })).rejects.toThrow('delegated')
    expect(bridge.list('leader-session')).toEqual([])
  })

  it('answers for a Session «替我审批» took the reader out of', async () => {
    const bridge = new TeamInteractionBridge({} as Context, {
      acceptsSession: () => true,
      autoAnswer: () => true,
      onChange: vi.fn(),
    })
    const agentCtx = fakeAgentContext()
    bridge.attach(agentCtx.ctx, agentOf('leader-session'))

    // Nobody is left to answer, so the turn continues instead of hanging: the
    // question comes back unanswered (with the reason) and the escalation is
    // allowed once.
    await expect(agentCtx.ask('user-questions/request', {
      questions: [{ id: 'path', question: '驱动放在哪个目录？', options: [{ label: 'A' }] }],
    })).resolves.toEqual({
      answers: [{
        id: 'path',
        selected: [],
        custom: '本会话开启了「替我审批」，没有人会回答这个问题——请自行决策并继续。',
      }],
    })
    await expect(agentCtx.ask('approval/request', { toolName: 'bash' })).resolves.toBe('allowed-once')
    expect(bridge.list('leader-session')).toEqual([])
  })

  it('refuses a leader-only approval outright and keeps it from the reader', async () => {
    const bridge = new TeamInteractionBridge({} as Context, {
      acceptsSession: () => true,
      onChange: vi.fn(),
    })
    const agentCtx = fakeAgentContext()
    bridge.attach(agentCtx.ctx, agentOf('session-9'))
    const outcome = agentCtx.ask('approval/request', { toolName: 'bash' })
    await vi.waitFor(() => { expect(bridge.list('session-9')).toHaveLength(1) })
    const pending = bridge.list('session-9')[0]!

    bridge.markLeaderOnly(pending.id)
    expect(bridge.list('session-9')[0]).toMatchObject({ leaderOnly: true })
    // The reader's own path cannot settle it, however it is reached.
    await expect(bridge.respond('session-9', pending.id, { kind: 'approval', outcome: 'allowed-once' }))
      .rejects.toMatchObject({ code: 'INTERACTION_NOT_FOUND' })

    // Nobody could grant it, so it is refused rather than left hanging.
    expect(bridge.refuse(pending.id)).toBe(true)
    await expect(outcome).resolves.toBe('rejected')
    expect(bridge.list('session-9')).toEqual([])
    await bridge.dispose()
  })

  it('drops pending records when a session is forgotten', async () => {
    const bridge = new TeamInteractionBridge({} as Context, {
      acceptsSession: () => true,
      onChange: vi.fn(),
    })
    const agentCtx = fakeAgentContext()
    bridge.attach(agentCtx.ctx, agentOf('session-4'))
    const pending = agentCtx.ask('approval/request', { toolName: 'bash' })
    pending.catch(() => undefined)
    await vi.waitFor(() => { expect(bridge.list('session-4')).toHaveLength(1) })
    bridge.forget('session-4')
    expect(bridge.list('session-4')).toEqual([])
    await bridge.dispose()
  })
})

describe('normalizeQuestionAnswers', () => {
  it('rejects incomplete and forged option answers', () => {
    const questions = [{
      id: 'model',
      question: '选择模型？',
      options: [{ label: 'DeepSeek' }, { label: 'GLM' }],
    }]
    expect(() => normalizeQuestionAnswers(questions, [])).toThrow(AgentTeamError)
    expect(() => normalizeQuestionAnswers(questions, [{
      id: 'model',
      selected: ['Unknown'],
    }])).toThrow('包含无效选项')
  })
})

function agentOf(sessionId: string, events: unknown[] = []): Agent {
  return { id: sessionId, session: { id: sessionId, snapshotEvents: () => events } } as unknown as Agent
}

/** Minimal agent-scoped context capturing waterfall registrations. */
function fakeAgentContext(): {
  ctx: Context
  ask: (event: string, request: Record<string, unknown>) => Promise<unknown>
} {
  const handlers = new Map<string, (request: never, next: () => Promise<never>) => Promise<unknown>>()
  const ctx = {
    on: (event: string, handler: (request: never, next: () => Promise<never>) => Promise<unknown>) => {
      handlers.set(event, handler)
      return () => { handlers.delete(event) }
    },
  } as unknown as Context
  return {
    ctx,
    ask: (event, request) => {
      const handler = handlers.get(event)
      if (handler === undefined) throw new Error(`no handler for ${event}`)
      const next = (): Promise<never> => Promise.reject(new Error('delegated'))
      return handler(request as never, next)
    },
  }
}
