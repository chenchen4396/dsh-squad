import { describe, expect, it } from 'vitest'
import {
  assertRevision,
  assertTeamMutable,
  requireAssistant,
  requireTeam,
} from '../src/service/store-guards.js'
import type { AgentTeamStore } from '../src/storage/store.js'
import type { AssistantTemplate, TeamAggregate } from '../src/domain/types.js'

const assistant = { id: 'a1', name: 'SE' } as AssistantTemplate
const team = { id: 't1', name: 'BIOS', state: 'active', revision: 4 } as TeamAggregate
const store = {
  getAssistant: (id: string) => (id === 'a1' ? assistant : undefined),
  getTeam: (id: string) => (id === 't1' ? team : undefined),
} as unknown as AgentTeamStore

/**
 * The rules for reading the store and for when a team may be changed at all.
 * They were module-level helpers inside a 1480-line service, so every subject
 * that needed one reached across the whole file, and none of them had a test.
 */
describe('store guards', () => {
  it('returns what is stored', () => {
    expect(requireAssistant(store, 'a1')).toBe(assistant)
    expect(requireTeam(store, 't1')).toBe(team)
  })

  it('names what was missing', () => {
    expect(() => requireAssistant(store, 'nope')).toThrowError(/nope/)
    expect(() => requireTeam(store, 'nope')).toThrowError(/nope/)
    expect(() => requireTeam(store, 'nope')).toThrowError(/Unknown team/)
  })

  it('accepts a revision that matches', () => {
    expect(() => { assertRevision('team', 4, 4) }).not.toThrow()
    expect(() => { assertRevision('team', 4, undefined) }).not.toThrow()
  })

  it('refuses a revision that has moved on', () => {
    // The reader edited a team somebody else had already changed.
    expect(() => { assertRevision('team', 5, 4) }).toThrowError(/revision/)
  })

  it('lets a team that is merely idle be changed', () => {
    for (const state of ['draft', 'active', 'paused', 'dissolved']) {
      expect(() => { assertTeamMutable({ ...team, state } as TeamAggregate) }).not.toThrow()
    }
  })

  it('refuses to change a team that is on its way out', () => {
    // Anything else would race the deletion that is already running.
    for (const state of ['deleting', 'delete_blocked']) {
      expect(() => { assertTeamMutable({ ...team, state } as TeamAggregate) })
        .toThrowError(/deleting/)
    }
  })
})
