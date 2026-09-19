import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { subscribeRuntimeEvents, type RuntimeEventDeps } from '../src/runtime/runtime-events.js'

/**
 * The runtime's six subscriptions.
 *
 * They were wired inline and held in six fields, and `dispose` called the six
 * by hand — six chances to add a seventh and forget it there, which leaks work
 * that runs after the runtime is gone. One disposer is what makes that
 * impossible, so it is what these tests are about.
 */
function fakeContext(): { ctx: Context; events: string[]; fired: (event: string, payload: unknown) => void; disposed: string[] } {
  const events: string[] = []
  const disposed: string[] = []
  const handlers = new Map<string, (payload: never) => void>()
  const ctx = {
    on: (event: string, handler: (payload: never) => void) => {
      events.push(event)
      handlers.set(event + ':' + events.filter(e => e === event).length, handler)
      const token = `${event}#${events.filter(e => e === event).length}`
      return () => { disposed.push(token) }
    },
  } as unknown as Context
  // `ctx.on` passes a Session event's payload as two arguments, so the fake
  // has to forward whatever it is given rather than a single value.
  const fired = (event: string, ...args: unknown[]): void => {
    for (const [key, handler] of handlers) {
      if (key.startsWith(event + ':')) (handler as (...a: unknown[]) => void)(...args)
    }
  }
  return { ctx, events, fired, disposed }
}

function deps(overrides: Partial<RuntimeEventDeps> = {}): RuntimeEventDeps {
  const member = { teamId: 't1', slotId: 's1' }
  return {
    members: {
      agentOf: () => undefined,
      leaderOf: () => undefined,
      has: () => false,
      detachLeader: vi.fn(),
    },
    conversationPublishes: { schedule: vi.fn() },
    liveStreams: { begin: vi.fn(), append: vi.fn(), replace: vi.fn(), end: vi.fn() },
    warn: vi.fn(),
    attachLeaderForSession: vi.fn(),
    observeUserMessage: vi.fn(),
    setMemberRuntimeState: vi.fn(async () => {}),
    publishOwnedConversation: vi.fn(),
    ...overrides,
  } as unknown as RuntimeEventDeps
}

describe('runtime event subscriptions', () => {
  it('subscribes to each event the runtime needs', () => {
    const { ctx, events } = fakeContext()
    subscribeRuntimeEvents(ctx, deps())
    expect(events.sort()).toEqual([
      'agent/assistant-stream',
      'agent/created',
      'agent/disposed',
      'agent/status',
      'session/event',
      'session/event',
    ])
  })

  it('removes every subscription it made, through one disposer', () => {
    const { ctx, disposed } = fakeContext()
    const unsubscribe = subscribeRuntimeEvents(ctx, deps())
    unsubscribe()
    // Six made, six removed: a missed one is work that outlives the runtime.
    expect(disposed).toHaveLength(6)
  })

  it('attaches a Session\u2019s own Agent as Leader when it appears', () => {
    const attach = vi.fn()
    const { ctx, fired } = fakeContext()
    subscribeRuntimeEvents(ctx, deps({ attachLeaderForSession: attach }))
    fired('agent/created', { agent: { id: 'session-1' } })
    expect(attach).toHaveBeenCalledWith('session-1')
  })

  it('forgets a Leader whose Agent went away', () => {
    const detach = vi.fn()
    const { ctx, fired } = fakeContext()
    const withMembers = deps()
    ;(withMembers.members as unknown as { detachLeader: unknown }).detachLeader = detach
    subscribeRuntimeEvents(ctx, withMembers)
    fired('agent/disposed', { agent: { id: 'session-1' } })
    expect(detach).toHaveBeenCalledWith('session-1')
  })

  it('ignores a Session event that is not the reader speaking', () => {
    const observe = vi.fn()
    const { ctx, fired } = fakeContext()
    subscribeRuntimeEvents(ctx, deps({ observeUserMessage: observe }))
    // Anything but a user message is not this listener's business.
    fired('session/event', { id: 'session-1' }, { type: 'turn/end' })
    expect(observe).not.toHaveBeenCalled()
  })

  it('reads each stream frame into the buffer for a Session it owns', () => {
    const streams = { begin: vi.fn(), append: vi.fn(), replace: vi.fn(), end: vi.fn() }
    const { ctx, fired } = fakeContext()
    const d = deps({ liveStreams: streams as never })
    ;(d.members as unknown as { has: unknown }).has = () => true
    subscribeRuntimeEvents(ctx, d)

    fired('agent/assistant-stream', { agent: { id: 'session-1' }, frame: { type: 'start' } })
    fired('agent/assistant-stream', {
      agent: { id: 'session-1' },
      frame: { type: 'chunk', chunk: { type: 'text-delta', text: '你' } },
    })
    fired('agent/assistant-stream', {
      agent: { id: 'session-1' },
      frame: { type: 'chunk', chunk: { type: 'block-end', block: { type: 'text', text: '你好' } } },
    })
    fired('agent/assistant-stream', { agent: { id: 'session-1' }, frame: { type: 'end' } })

    expect(streams.begin).toHaveBeenCalled()
    expect(streams.append).toHaveBeenCalledWith('session-1', { text: '你' })
    // A finished block replaces what was streamed, rather than appending to it.
    expect(streams.replace).toHaveBeenCalledWith('session-1', { text: '你好' })
    expect(streams.end).toHaveBeenCalledWith('session-1')
  })

  it('does nothing for a Session it does not own', () => {
    const streams = { begin: vi.fn(), append: vi.fn(), replace: vi.fn(), end: vi.fn() }
    const { ctx, fired } = fakeContext()
    subscribeRuntimeEvents(ctx, deps({ liveStreams: streams as never }))
    fired('agent/assistant-stream', { agent: { id: 'someone-else' }, frame: { type: 'start' } })
    expect(streams.begin).not.toHaveBeenCalled()
  })
})
