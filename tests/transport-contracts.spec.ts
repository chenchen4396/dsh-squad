import { describe, expect, expectTypeOf, it } from 'vitest'
import { PAYLOAD_SCHEMAS, parsePayload } from '../src/transport/payload-schemas.js'
import { dispatchedMethods } from '../src/transport/dispatch/index.js'
import {
  AGENT_TEAM_METHODS,
  type AgentTeamPayload,
  type AgentTeamResult,
  type WorkspaceEntryView,
  type WorkspaceGitDiffView,
} from '../src/transport/contracts.js'

describe('dsh-squad transport contracts', () => {
  it('keeps API method names unique', () => {
    expect(new Set(AGENT_TEAM_METHODS).size).toBe(AGENT_TEAM_METHODS.length)
  })

  it('describes every declared method with exactly one payload schema', () => {
    // The schema table is the only description of what a method accepts. A
    // method added to the list without an entry would fail at request time
    // instead of here.
    const described = Object.keys(PAYLOAD_SCHEMAS)
    expect([...described].sort()).toEqual([...AGENT_TEAM_METHODS].sort())
  })

  it('serves every declared method from some dispatch table', () => {
    // The tables are assembled by subject, so a method can be declared and
    // described while no table claims it. That would answer every call with
    // "no handler" at run time; it fails here instead.
    expect([...dispatchedMethods()].sort()).toEqual([...AGENT_TEAM_METHODS].sort())
  })

  it('accepts a request that omits the payload for a method that takes none', () => {
    expect(parsePayload('catalog.get', undefined)).toBeUndefined()
    expect(parsePayload('team.list', undefined)).toBeUndefined()
  })

  it('refuses a payload that does not match the method', () => {
    expect(() => parsePayload('team.get', {})).toThrow()
    expect(() => parsePayload('team.get', { id: '' })).toThrow()
    // A method that takes no payload still refuses one it was not told about.
    expect(() => parsePayload('catalog.get', { extra: true })).toThrow()
  })

  it('associates Workspace methods with their payload and result types', () => {
    expectTypeOf<AgentTeamPayload<'team.workspace.diff'>>().toEqualTypeOf<{
      teamId: string
      // Written the way the request schema infers it, which is what makes the
      // two descriptions of this request agree.
      conversationId?: string | undefined
      path: string
      scope: 'staged' | 'unstaged'
      layout: 'unified' | 'split'
      theme: 'light' | 'dark'
    }>()
    expectTypeOf<AgentTeamResult<'team.workspace.diff'>>().toEqualTypeOf<WorkspaceGitDiffView>()
    expectTypeOf<AgentTeamResult<'team.workspace.list'>>().toEqualTypeOf<WorkspaceEntryView[]>()
  })
})

describe('interactionResponseOf', () => {
  it('passes an approval through unchanged', async () => {
    const { interactionResponseOf } = await import('../src/transport/payload-schemas.js')
    const approval = { kind: 'approval' as const, outcome: 'allowed-once' as const }
    expect(interactionResponseOf(approval)).toEqual(approval)
  })

  it('drops an answer field that was not given rather than storing undefined', async () => {
    const { interactionResponseOf } = await import('../src/transport/payload-schemas.js')
    const response = interactionResponseOf({
      kind: 'question',
      answers: [{ id: 'q1', selected: ['a'] }, { id: 'q2', selected: [], custom: '其他' }],
    })
    expect(response).toEqual({
      kind: 'question',
      answers: [
        { id: 'q1', selected: ['a'] },
        { id: 'q2', selected: [], custom: '其他' },
      ],
    })
    // The key must be absent, not present as undefined: this shape is stored.
    expect(Object.keys((response as { answers: object[] }).answers[0]!)).toEqual(['id', 'selected'])
  })
})

describe('the request schema and the declared payload agree', () => {
  it('holds for every method but the ones the service validates itself', async () => {
    const { assertContractAgreement } = await import('../src/transport/contract-agreement.js')
    // The real check is the type of this function's parameter, which the
    // typechecker evaluates: if a method's schema output stopped fitting the
    // payload its request declares, the parameter becomes that method's name and
    // the body stops compiling — naming it.
    expect(typeof assertContractAgreement).toBe('function')
  })

  it('keeps the list of exceptions short and named', async () => {
    type ZodLike = { _zod?: { def?: { type?: string } }; shape?: Record<string, ZodLike> }
    const unknownIn = (schema: ZodLike): string[] => {
      if (schema._zod?.def?.type === 'unknown') return [''] // the whole payload
      return Object.entries(schema.shape ?? {})
        .filter(([, field]) => field._zod?.def?.type === 'unknown')
        .map(([field]) => field)
    }
    const schemas = (await import('../src/transport/payload-schemas.js')).PAYLOAD_SCHEMAS
    const unknownFields = Object.entries(schemas).flatMap(([method, schema]) =>
      unknownIn(schema as ZodLike)
        .map(field => (field === '' ? method : `${method}.${field}`)))
    // A field the schema does not describe has to be one the service validates.
    // This pins how many there are: a new one is a decision, not a drift.
    expect(unknownFields.sort()).toEqual([
      // Two whole payloads the service parses itself, so a bad one names the
      // field rather than reporting the whole body as invalid.
      'assistant.create',
      // Three fields whose inner shape the service validates, for the same
      // reason.
      'assistant.update.value',
      'bundle.import.bundle',
      'team.addMember.value',
      'team.createDraft',
    ])
  })
})
