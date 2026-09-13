import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeEventSource {
  static readonly OPEN = 1
  static instances: FakeEventSource[] = []

  readonly listeners = new Map<string, Array<(event: unknown) => void>>()
  readyState = 0
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener as (event: unknown) => void)
    this.listeners.set(type, listeners)
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) })
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN
    this.onopen?.()
  }

  close(): void {
    this.closed = true
  }
}

describe('dsh-squad client event hub', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Deliver the coalescing window a change burst is collected into. */
  function flushChangeWindow(): void {
    vi.advanceTimersByTime(200)
  }

  it('shares one EventSource across list and conversation subscribers', async () => {
    const {
      subscribeAgentTeam,
      subscribeAgentTeamConversation,
      subscribeAgentTeamWorkspace,
      subscribeAssistantBuilderConversation,
    } = await import('../src/client/api.js')
    const listChange = vi.fn()
    const conversationChange = vi.fn()
    const builderChange = vi.fn()
    const workspaceChange = vi.fn()
    const opened = vi.fn()

    const unsubscribeList = subscribeAgentTeam(listChange, vi.fn())
    const unsubscribeConversation = subscribeAgentTeamConversation(
      'team-1',
      conversationChange,
      vi.fn(),
      opened,
    )
    const unsubscribeBuilder = subscribeAssistantBuilderConversation(builderChange, vi.fn())
    const unsubscribeWorkspace = subscribeAgentTeamWorkspace('team-1', workspaceChange, vi.fn())

    expect(FakeEventSource.instances).toHaveLength(1)
    const source = FakeEventSource.instances[0]!
    source.open()
    source.emit('change', { entityId: 'team-1' })
    source.emit('conversation', {
      entityId: 'team-1',
      conversation: { slotId: 'slot-1', throughSeq: 3 },
    })
    source.emit('assistant-builder-conversation', {
      assistantBuilderConversation: {
        schemaVersion: 1,
        sessionId: 'agent-team:assistant-builder',
        status: 'running',
        throughSeq: 4,
        nodes: [],
      },
    })
    source.emit('workspace', { entityId: 'team-1', kind: 'workspace.changed' })

    // Conversation frames carry their payload and are dispatched right away;
    // plain change frames are collected into one coalesced delivery.
    expect(opened).toHaveBeenCalledOnce()
    expect(conversationChange).toHaveBeenCalledWith(expect.objectContaining({ slotId: 'slot-1' }))
    expect(builderChange).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'agent-team:assistant-builder',
    }))
    expect(listChange).not.toHaveBeenCalled()
    expect(workspaceChange).not.toHaveBeenCalled()

    flushChangeWindow()

    expect(listChange).toHaveBeenCalledOnce()
    expect(workspaceChange).toHaveBeenCalledOnce()
    expect(listChange.mock.calls[0]?.[0]).toEqual(new Set(['unknown']))

    unsubscribeList()
    expect(source.closed).toBe(false)
    unsubscribeConversation()
    expect(source.closed).toBe(false)
    unsubscribeBuilder()
    expect(source.closed).toBe(false)
    unsubscribeWorkspace()
    expect(source.closed).toBe(true)
  })

  it('coalesces a burst into one delivery carrying every affected kind', async () => {
    const { subscribeAgentTeam, subscribeAgentTeamWorkspace } = await import('../src/client/api.js')
    const change = vi.fn()
    const workspace = vi.fn()
    subscribeAgentTeam(change, vi.fn())
    subscribeAgentTeamWorkspace('team-1', workspace, vi.fn())
    subscribeAgentTeamWorkspace('team-2', vi.fn(), vi.fn())
    const source = FakeEventSource.instances[0]!

    // A running team publishes this shape every few dozen milliseconds.
    for (let index = 0; index < 20; index += 1) {
      source.emit('change', { entityType: 'conversation', entityId: 'team-1' })
    }
    source.emit('change', { entityType: 'team', entityId: 'team-1' })
    source.emit('workspace', { entityId: 'team-1' })
    source.emit('workspace', { entityId: 'team-1' })

    expect(change).not.toHaveBeenCalled()
    flushChangeWindow()

    expect(change).toHaveBeenCalledOnce()
    expect(change.mock.calls[0]?.[0]).toEqual(new Set(['conversation', 'team']))
    expect(workspace).toHaveBeenCalledOnce()
  })
})

describe('dsh-squad client requests', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('requests the Skill catalog for one Agent Preset', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => ({
      json: async () => ({ requestId: 'request-1', ok: true, value: { skills: [] } }),
    }))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
    const { callAgentTeam } = await import('../src/client/api.js')

    await callAgentTeam('skill.catalog', { agentPresetId: 'standard' })

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({
      method: 'skill.catalog',
      payload: { agentPresetId: 'standard' },
    })
  })

  it('submits a structured team interaction response', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => ({
      json: async () => ({ requestId: 'request-1', ok: true, value: { accepted: true } }),
    }))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
    const { callAgentTeam } = await import('../src/client/api.js')

    await callAgentTeam('team.interaction.respond', {
      teamId: 'team-1',
      conversationId: 'conversation-1',
      slotId: 'slot-1',
      interactionId: 'question:rpc-1',
      response: {
        kind: 'question',
        answers: [{ id: 'name', selected: [], custom: 'Reviewer' }],
      },
    })

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({
      method: 'team.interaction.respond',
      payload: {
        teamId: 'team-1',
        slotId: 'slot-1',
        interactionId: 'question:rpc-1',
        response: {
          kind: 'question',
          answers: [{ id: 'name', selected: [], custom: 'Reviewer' }],
        },
      },
    })
  })

  it('uploads a system-selected file to the team Workspace upload route', async () => {
    const fetch = vi.fn(async () => ({
      json: async () => ({
        requestId: 'request-1',
        ok: true,
        value: { name: 'notes.txt', path: '.agent-team/uploads/notes.txt', bytes: 5 },
      }),
    }))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
    const { uploadAgentTeamFile } = await import('../src/client/api.js')
    const file = { name: '会议 notes.txt' } as File

    await expect(uploadAgentTeamFile('team-1', 'conversation-1', file)).resolves.toMatchObject({
      path: '.agent-team/uploads/notes.txt',
    })

    expect(fetch).toHaveBeenCalledWith(
      '/agent-team/upload?teamId=team-1&conversationId=conversation-1',
      expect.objectContaining({
      method: 'POST',
      body: file,
      headers: expect.objectContaining({
        'Content-Type': 'application/octet-stream',
        'X-Agent-Team-File-Name': encodeURIComponent(file.name),
      }),
    }))
  })

  it('requests the MCP catalog for one Agent Preset', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => ({
      json: async () => ({ requestId: 'request-1', ok: true, value: { servers: [] } }),
    }))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
    const { callAgentTeam } = await import('../src/client/api.js')

    await callAgentTeam('mcp.catalog', { agentPresetId: 'standard' })

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({
      method: 'mcp.catalog',
      payload: { agentPresetId: 'standard' },
    })
  })

  it('addresses Assistant Builder requests to one conversation Session', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => ({
      json: async () => ({ requestId: 'request-1', ok: true, value: { messageId: 'message-1' } }),
    }))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
    const { callAgentTeam } = await import('../src/client/api.js')

    await callAgentTeam('assistant.builder.send', {
      sessionId: 'agent-team:assistant-builder:conversation-1',
      content: 'Create a reviewer',
    })

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({
      method: 'assistant.builder.send',
      payload: {
        sessionId: 'agent-team:assistant-builder:conversation-1',
        content: 'Create a reviewer',
      },
    })
  })

  it('submits an Assistant Builder structured interaction response', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => ({
      json: async () => ({ requestId: 'request-1', ok: true, value: { accepted: true } }),
    }))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
    const { callAgentTeam } = await import('../src/client/api.js')

    await callAgentTeam('assistant.builder.interaction.respond', {
      sessionId: 'agent-team:assistant-builder:conversation-1',
      interactionId: 'question:question-rpc-1',
      response: {
        kind: 'question',
        answers: [{ id: 'name', selected: ['代码审查助手'] }],
      },
    })

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({
      method: 'assistant.builder.interaction.respond',
      payload: {
        sessionId: 'agent-team:assistant-builder:conversation-1',
        interactionId: 'question:question-rpc-1',
      },
    })
  })

  it('starts an Assistant Builder Session only with the first draft message', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => ({
      json: async () => ({ requestId: 'request-1', ok: true, value: { sessionId: 'conversation-1' } }),
    }))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
    const { callAgentTeam } = await import('../src/client/api.js')

    await callAgentTeam('assistant.builder.start', {
      provider: 'deepseek',
      model: 'reasoner',
      content: 'Create a reviewer',
    })

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({
      method: 'assistant.builder.start',
      payload: {
        provider: 'deepseek',
        model: 'reasoner',
        content: 'Create a reviewer',
      },
    })
  })

  it('requests archival of one Assistant Builder conversation', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => ({
      json: async () => ({ requestId: 'request-1', ok: true, value: { archived: true } }),
    }))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
    const { callAgentTeam } = await import('../src/client/api.js')

    await callAgentTeam('assistant.builder.archive', {
      sessionId: 'agent-team:assistant-builder:conversation-1',
    })

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({
      method: 'assistant.builder.archive',
      payload: { sessionId: 'agent-team:assistant-builder:conversation-1' },
    })
  })

  it('sends the current revision when updating an assistant', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => ({
      json: async () => ({ requestId: 'request-1', ok: true, value: { id: 'assistant-1' } }),
    }))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
    const { callAgentTeam } = await import('../src/client/api.js')

    await callAgentTeam('assistant.update', {
      id: 'assistant-1',
      value: { name: 'Updated Assistant' },
    }, 3)

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({
      method: 'assistant.update',
      expectedRevision: 3,
      payload: {
        id: 'assistant-1',
        value: { name: 'Updated Assistant' },
      },
    })
  })
})
