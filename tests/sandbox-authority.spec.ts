import { describe, expect, it } from 'vitest'
import {
  sandboxLevel,
  sandboxModeOf,
  withinLeaderAuthority,
} from '../src/runtime/sandbox-authority.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Members never reach the reader, so the Leader answers their requests — but a
 * Leader that could grant more than it holds would silently widen the sandbox
 * the reader granted it. The ladder decides what it may grant.
 */
describe('withinLeaderAuthority', () => {
  it('lets a Leader grant its own level and anything narrower', () => {
    expect(withinLeaderAuthority('workspace-write', 'read-only')).toBe(true)
    expect(withinLeaderAuthority('workspace-write', 'workspace-write')).toBe(true)
    expect(withinLeaderAuthority('danger-full-access', 'danger-full-access')).toBe(true)
    expect(withinLeaderAuthority('danger-full-access', 'workspace-write')).toBe(true)
  })

  it('sends anything wider to the reader', () => {
    expect(withinLeaderAuthority('read-only', 'workspace-write')).toBe(false)
    expect(withinLeaderAuthority('workspace-write', 'danger-full-access')).toBe(false)
    expect(withinLeaderAuthority('read-only', 'danger-full-access')).toBe(false)
  })

  it('treats an ask that names no level as the Leader\'s, and an unread level as nobody\'s', () => {
    expect(withinLeaderAuthority('read-only', undefined)).toBe(true)
    expect(withinLeaderAuthority(undefined, 'workspace-write')).toBe(false)
    expect(withinLeaderAuthority('workspace-write', 'unknown-mode')).toBe(false)
  })

  it('ranks the ladder', () => {
    expect(sandboxLevel('read-only')).toBe(0)
    expect(sandboxLevel('danger-full-access')).toBe(2)
    expect(sandboxLevel('nonsense')).toBe(-1)
  })
})

describe('sandboxModeOf', () => {
  it('reads the level a Session is running at from its own log', () => {
    const events = [
      { type: 'sandbox/mode', data: { mode: 'read-only' } },
      { type: 'user/message', data: {} },
      { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
    ] as unknown as SessionEvent[]

    expect(sandboxModeOf(events)).toBe('workspace-write')
    expect(sandboxModeOf([])).toBeUndefined()
    expect(sandboxModeOf([{ type: 'sandbox/mode', data: { mode: 'nonsense' } }] as unknown as SessionEvent[]))
      .toBeUndefined()
  })
})
