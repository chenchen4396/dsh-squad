import { describe, expect, it } from 'vitest'
import { visibleMemberSlots } from '../src/client/member-visibility.js'

describe('team member visibility', () => {
  it('opens every team member without a three-column cap', () => {
    expect(visibleMemberSlots(['leader', 'member-1', 'member-2', 'member-3'], undefined)).toEqual([
      'leader',
      'member-1',
      'member-2',
      'member-3',
    ])
  })

  it('shows the picked member alone, whatever the roster size', () => {
    expect(visibleMemberSlots(['leader', 'member-1', 'member-2'], 'member-2')).toEqual(['member-2'])
  })

  it('returns to every member when the picked one left the team', () => {
    expect(visibleMemberSlots(['leader', 'member-2'], 'member-1')).toEqual(['leader', 'member-2'])
  })
})
