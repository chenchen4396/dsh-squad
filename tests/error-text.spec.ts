import { describe, expect, it } from 'vitest'
import { errorText } from '../src/client/error-text.js'

describe('errorText', () => {
  it('shows an Error\u2019s own message', () => {
    expect(errorText(new Error('该成员仍有未完成任务'))).toBe('该成员仍有未完成任务')
  })

  it('stringifies a rejection that is not an Error', () => {
    // A transport can reject with a plain string; a reader must still see it.
    expect(errorText('请求超时')).toBe('请求超时')
  })

  it('never renders an object as [object Object]', () => {
    expect(errorText({ code: 'TEAM_NOT_FOUND' })).toBe('[object Object]')
    // Which is what the naive fallback already did — but a thrown `null` used to
    // crash on `.message`, and now it does not.
    expect(errorText(null)).toBe('null')
    expect(errorText(undefined)).toBe('undefined')
  })

  it('keeps a subclass message', () => {
    class VersionConflict extends Error {}
    expect(errorText(new VersionConflict('revision 已过期'))).toBe('revision 已过期')
  })
})
