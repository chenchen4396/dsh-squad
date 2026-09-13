import { describe, expect, it } from 'vitest'
import { shouldSubmitComposer } from '../src/client/keyboard.js'

const enter = {
  key: 'Enter',
  shiftKey: false,
  isComposing: false,
  keyCode: 13,
}

describe('shouldSubmitComposer', () => {
  it('submits a regular Enter key press', () => {
    expect(shouldSubmitComposer(enter, false)).toBe(true)
  })

  it('does not submit while an IME composition is active', () => {
    expect(shouldSubmitComposer({ ...enter, isComposing: true }, false)).toBe(false)
    expect(shouldSubmitComposer(enter, true)).toBe(false)
  })

  it('handles the IME keyCode fallback used by some browsers', () => {
    expect(shouldSubmitComposer({ ...enter, keyCode: 229 }, false)).toBe(false)
  })

  it('preserves Shift+Enter and ignores other keys', () => {
    expect(shouldSubmitComposer({ ...enter, shiftKey: true }, false)).toBe(false)
    expect(shouldSubmitComposer({ ...enter, key: 'a', keyCode: 65 }, false)).toBe(false)
  })
})
