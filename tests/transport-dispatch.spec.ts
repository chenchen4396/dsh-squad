import { describe, expect, it, vi } from 'vitest'
import type { AgentTeamService } from '../src/service/agent-team-service.js'
import { dispatch, dispatchedMethods } from '../src/transport/dispatch/index.js'

/**
 * Which service method each API method reaches.
 *
 * This exists because the first version of the dispatch tables was generated
 * wrong: every entry got the body of `catalog.get`, and *nothing caught it* —
 * the handlers all return `unknown`, so the types agreed, and every other test
 * calls the service directly rather than through the transport. Routing is
 * only proven by routing something.
 */
function stubService(): AgentTeamService {
  return {
    catalog: vi.fn(async () => 'catalog'),
    modelCapabilities: vi.fn(async () => 'capabilities'),
    skillCatalog: vi.fn(async () => 'skills'),
    mcpCatalog: vi.fn(async () => 'mcp'),
    listAssistants: vi.fn(() => 'assistants'),
    getAssistant: vi.fn(() => 'assistant'),
    createAssistant: vi.fn(async () => 'created'),
    updateAssistant: vi.fn(async () => 'updated'),
    cloneAssistant: vi.fn(async () => 'cloned'),
    deleteAssistant: vi.fn(async () => null),
    listRuleDocuments: vi.fn(() => ({ items: [], total: 0 })),
    getRuleDocument: vi.fn(() => ({ id: 'r1', path: 'a.md', title: 't', fileName: 'a.md', bytes: 1, importedAt: '', content: '' })),
    importRuleDocument: vi.fn(async () => 'imported'),
    deleteRuleDocument: vi.fn(async () => undefined),
    ruleDocumentLimit: vi.fn(() => 1000),
    listAssistantBuilderConversations: vi.fn(() => 'builder-list'),
    getAssistantBuilderDraft: vi.fn(() => 'draft'),
    configureAssistantBuilderDraft: vi.fn(async () => 'draft-configured'),
    startAssistantBuilderConversation: vi.fn(async () => 'builder-started'),
    getAssistantBuilderConversation: vi.fn(() => 'builder-conversation'),
    configureAssistantBuilder: vi.fn(async () => 'builder-configured'),
    sendAssistantBuilderMessage: vi.fn(async () => 'builder-sent'),
    respondToAssistantBuilderInteraction: vi.fn(async () => undefined),
    stopAssistantBuilder: vi.fn(async () => undefined),
    archiveAssistantBuilderConversation: vi.fn(async () => undefined),
    listTeams: vi.fn(() => 'teams'),
    getTeam: vi.fn(() => 'team'),
    createTeamDraft: vi.fn(async () => 'team-draft'),
    cloneTeam: vi.fn(async () => 'cloned-team'),
    startTeam: vi.fn(async () => 'started'),
    addMember: vi.fn(async () => 'member-added'),
    removeMember: vi.fn(async () => 'member-removed'),
    changeLeader: vi.fn(async () => 'leader-changed'),
    dissolveTeam: vi.fn(async () => 'dissolved'),
    exportBundle: vi.fn(() => 'bundle'),
    importBundle: vi.fn(async () => 'imported-bundle'),
    listMessages: vi.fn(() => 'messages'),
    sendRoomMessage: vi.fn(async () => 'room-message'),
    sendUserMessage: vi.fn(async () => 'user-message'),
    getRoom: vi.fn(async () => 'room'),
    getWorkbench: vi.fn(async () => 'workbench'),
  } as unknown as AgentTeamService
}

const call = (service: AgentTeamService, method: string, payload?: unknown) =>
  dispatch(service, { requestId: 'r1', method: method as never, payload })

describe('dispatch routing', () => {
  it('sends each catalog method to its own service call', async () => {
    const service = stubService()
    await call(service, 'catalog.get')
    await call(service, 'catalog.model.get', { provider: 'p', model: 'm' })
    await call(service, 'skill.catalog', { agentPresetId: 'standard' })
    await call(service, 'mcp.catalog', { agentPresetId: 'standard' })

    expect(service.catalog).toHaveBeenCalled()
    expect(service.modelCapabilities).toHaveBeenCalledWith('p', 'm')
    expect(service.skillCatalog).toHaveBeenCalledWith('standard')
    expect(service.mcpCatalog).toHaveBeenCalledWith('standard')
  })

  it('validates the payload before the service sees it', async () => {
    const service = stubService()
    await expect(call(service, 'catalog.model.get', { provider: 'p' })).rejects.toThrow()
    // The service must not be called with a half-formed request.
    expect(service.modelCapabilities).not.toHaveBeenCalled()
  })

  it('routes the assistant methods, with the revision option where it belongs', async () => {
    const service = stubService()
    await call(service, 'assistant.update', { id: 'a1', value: {} })
    await dispatch(service, {
      requestId: 'r2',
      method: 'assistant.update',
      expectedRevision: 3,
      payload: { id: 'a1', value: {} },
    })
    expect(service.updateAssistant).toHaveBeenNthCalledWith(1, 'a1', {}, {})
    expect(service.updateAssistant).toHaveBeenNthCalledWith(2, 'a1', {}, { expectedRevision: 3 })
  })

  it('routes the rule-document methods, answering with the catalog', async () => {
    const service = stubService()
    const result = await call(service, 'assistant.ruleDocuments.import', { path: 'a.md', content: 'x' })
    expect(service.importRuleDocument).toHaveBeenCalledWith('a.md', 'x')
    // Importing answers with the whole catalog, not the single document.
    expect(result).toMatchObject({ total: 0, limitBytes: 1000 })
  })

  it('routes the designer methods', async () => {
    const service = stubService()
    await call(service, 'assistant.builder.draft.configure', { provider: 'p', model: 'm' })
    expect(service.configureAssistantBuilderDraft).toHaveBeenCalledWith('p', 'm')
  })

  it('routes the team methods', async () => {
    const service = stubService()
    await call(service, 'team.list')
    await call(service, 'team.get', { id: 't1' })
    expect(service.listTeams).toHaveBeenCalled()
    expect(service.getTeam).toHaveBeenCalledWith('t1')
  })

  it('routes the bundle methods through their own schemas', async () => {
    const service = stubService()
    await call(service, 'bundle.export', {})
    expect(service.exportBundle).toHaveBeenCalledWith({ teamIds: undefined })
    // A mode the schema does not allow must not reach the service.
    await expect(call(service, 'bundle.import', { bundle: {}, mode: 'merge' })).rejects.toThrow()
    expect(service.importBundle).not.toHaveBeenCalled()
  })

  it('has a handler for every method it claims to dispatch', () => {
    for (const method of dispatchedMethods()) {
      expect(typeof method).toBe('string')
    }
  })
})
