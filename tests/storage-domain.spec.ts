import { describe, expect, it } from 'vitest'
import { agentTeamDomainSpec } from '../src/storage/domain.js'
import { assistantTemplateSchema, ruleDocumentSchema } from '../src/domain/schemas.js'

/**
 * `defineDomain` runs at module load and validates every declaration, so merely
 * importing the spec exercises those checks. Unit tests elsewhere drive a plain
 * in-memory store and never reach this layer — which is how an invalid table
 * name once shipped while every test still passed.
 */
describe('agentTeamDomainSpec', () => {
  it('declares only table names the storage layer accepts', () => {
    const names = Object.keys(agentTeamDomainSpec.tables)

    expect(names).toContain('rule_documents')
    for (const name of names) {
      // The storage layer rejects anything outside /^[a-z][a-z0-9_]*$/.
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it('keeps the domain version at 1 so existing storages still open', () => {
    // The backend unit is stamped with this version; bumping it makes `open`
    // fail with `version-mismatch` for every existing storage.
    expect(agentTeamDomainSpec.version).toBe(1)
  })

  it('parses an assistant stored before rule documents existed', () => {
    // `ruleDocumentAllowlist` was added later, so stored records lack it. A
    // required field would make the whole domain unopenable with
    // `invalid-record`.
    const stored = {
      schemaVersion: 1 as const,
      id: 'assistant-1',
      name: 'Legacy',
      instructions: '',
      provider: 'openai',
      model: 'codex',
      agentPresetId: 'default',
      permissionPresetId: 'standard',
      skillAllowlist: [],
      mcpServers: [],
      revision: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    expect(assistantTemplateSchema.parse(stored).ruleDocumentAllowlist).toEqual([])
  })

  it('rejects a rule document missing required metadata', () => {
    expect(() => ruleDocumentSchema.parse({
      schemaVersion: 1,
      id: 'doc-1',
      title: 'Rules',
      fileName: 'CLAUDE.md',
      content: '# Rules\n',
    })).toThrow()
  })
})
