import { describe, expect, it } from 'vitest'
import { addressedMemberContent } from '../src/client/member-composer.js'

describe('addressedMemberContent', () => {
  it('addresses the member the message is sent to', () => {
    expect(addressedMemberContent('SE', '你好')).toBe('@SE 你好')
  })

  it('trims what the reader typed', () => {
    expect(addressedMemberContent('SE', '  你好  ')).toBe('@SE 你好')
  })

  it('leaves a message that already names the member alone', () => {
    expect(addressedMemberContent('SE', '@SE 你好')).toBe('@SE 你好')
    expect(addressedMemberContent('SE', '你好 @SE')).toBe('你好 @SE')
  })

  it('does not confuse one member with another whose name contains it', () => {
    expect(addressedMemberContent('SE', '@TSE 你好')).toBe('@SE @TSE 你好')
  })
})
