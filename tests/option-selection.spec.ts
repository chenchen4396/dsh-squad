import { describe, expect, it } from 'vitest'
import { toggleSorted } from '../src/client/option-selection.js'

describe('toggleSorted', () => {
  it('adds a name and keeps the list sorted', () => {
    expect(toggleSorted(['b'], 'a', true)).toEqual(['a', 'b'])
  })

  it('removes a name', () => {
    expect(toggleSorted(['a', 'b'], 'a', false)).toEqual(['b'])
  })

  it('does not duplicate a name that is already selected', () => {
    // Clicking a checked box twice must not grow the list.
    expect(toggleSorted(['a'], 'a', true)).toEqual(['a'])
  })

  it('removing something absent is a no-op', () => {
    expect(toggleSorted(['a'], 'z', false)).toEqual(['a'])
  })

  it('leaves the input alone', () => {
    const input = ['b', 'a']
    toggleSorted(input, 'c', true)
    expect(input).toEqual(['b', 'a'])
  })
})
