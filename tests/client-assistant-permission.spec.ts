import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PERMISSION_PRESET,
  defaultPermissionPreset,
} from '../src/client/assistants/assistant-permission.js'

/**
 * A new Assistant that starts read-only hands every member it builds a sandbox
 * that cannot write, so each one has to ask permission before it can do the
 * work it was created for. Workspace write is the intended default.
 */
describe('defaultPermissionPreset', () => {
  it('picks workspace write rather than the catalog\'s first, most restrictive preset', () => {
    expect(defaultPermissionPreset([
      { value: 'read-only' },
      { value: 'workspace-write' },
      { value: 'danger-full-access' },
    ])).toBe(DEFAULT_PERMISSION_PRESET)
  })

  it('picks workspace write whatever order the catalog lists presets in', () => {
    expect(defaultPermissionPreset([
      { value: 'danger-full-access' },
      { value: 'workspace-write' },
    ])).toBe(DEFAULT_PERMISSION_PRESET)
  })

  it('falls back to the first preset when the deployment does not offer workspace write', () => {
    expect(defaultPermissionPreset([{ value: 'custom-confined' }])).toBe('custom-confined')
  })

  it('stays empty when no preset is available yet', () => {
    expect(defaultPermissionPreset([])).toBe('')
  })
})
