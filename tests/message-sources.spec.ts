import { describe, expect, it } from 'vitest'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { isReaderSource, isRoomRelaySource, isVisibleUserSource } from '../src/runtime/message-sources.js'

const user = { kind: 'user' } as MessageSource
const relay = { kind: 'plugin', plugin: 'dsh-squad', form: 'relay' } as unknown as MessageSource
const other = { kind: 'plugin', plugin: 'someone-else', form: 'relay' } as unknown as MessageSource
const notice = { kind: 'plugin', plugin: 'dsh-squad' } as unknown as MessageSource

/**
 * Three questions get asked of every Session input, and they are not the same
 * question. Only the text distinguishes a reader's relayed room message from a
 * team message this plugin delivered, so getting this wrong shows the reader
 * their own words as somebody else's — or hides a teammate's message entirely.
 */
describe('message sources', () => {
  it('recognises only this plugin\u2019s relays', () => {
    expect(isRoomRelaySource(relay)).toBe(true)
    expect(isRoomRelaySource(user)).toBe(false)
    // Another plugin's relay is not ours to interpret.
    expect(isRoomRelaySource(other)).toBe(false)
    // A plugin message that is not a relay carries no reader text.
    expect(isRoomRelaySource(notice)).toBe(false)
  })

  it('counts a message the reader typed as theirs', () => {
    expect(isReaderSource(user, 'anything', new Set())).toBe(true)
  })

  it('counts a relayed line as the reader\u2019s only when it is one of their own', () => {
    const lines = new Set(['帮我看看这个'])
    expect(isReaderSource(relay, '帮我看看这个', lines)).toBe(true)
    // A team message rides the same relay with a header, so it is not theirs.
    expect(isReaderSource(relay, '[Team message from SE]\n完成', lines)).toBe(false)
  })

  it('ignores surrounding whitespace when matching a relayed line', () => {
    expect(isReaderSource(relay, '  帮我看看这个  ', new Set(['帮我看看这个']))).toBe(true)
  })

  it('does not treat another plugin\u2019s relay as the reader speaking', () => {
    expect(isReaderSource(other, '帮我看看这个', new Set(['帮我看看这个']))).toBe(false)
  })

  it('shows both the reader\u2019s own turns and relays, but not other plugins', () => {
    expect(isVisibleUserSource(user)).toBe(true)
    expect(isVisibleUserSource(relay)).toBe(true)
    expect(isVisibleUserSource(other)).toBe(false)
    expect(isVisibleUserSource(notice)).toBe(false)
  })
})
