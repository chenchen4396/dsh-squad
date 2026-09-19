import { describe, expect, it } from 'vitest'
import { LiveStreamBuffer } from '../src/runtime/live-stream-buffer.js'

/**
 * A member's reply arrives as deltas plus, per block, the provider's own
 * complete text. Getting the interaction between those wrong shows a reader
 * either a half-written reply or text from a turn that already ended, so each
 * rule is pinned here.
 */
describe('LiveStreamBuffer', () => {
  it('builds the value from deltas', () => {
    const buffer = new LiveStreamBuffer()
    buffer.begin('s1')
    buffer.append('s1', { text: 'Hello' })
    buffer.append('s1', { text: ', world' })
    expect(buffer.get('s1')).toEqual({ text: 'Hello, world', reasoning: '' })
  })

  it('keeps reasoning apart from the reply', () => {
    const buffer = new LiveStreamBuffer()
    buffer.begin('s1')
    buffer.append('s1', { reasoning: 'thinking' })
    buffer.append('s1', { text: 'answering' })
    expect(buffer.get('s1')).toEqual({ text: 'answering', reasoning: 'thinking' })
  })

  it('replaces the accumulated value with the block the provider sent', () => {
    const buffer = new LiveStreamBuffer()
    buffer.begin('s1')
    buffer.append('s1', { text: 'partial' })
    // The closing frame corrects any delta that was lost or arrived out of order.
    buffer.replace('s1', { text: 'the whole block' })
    expect(buffer.get('s1')?.text).toBe('the whole block')
  })

  it('replaces only the part it was given, leaving the other alone', () => {
    const buffer = new LiveStreamBuffer()
    buffer.begin('s1')
    buffer.append('s1', { text: 'answer', reasoning: 'thought' })
    buffer.replace('s1', { reasoning: 'final thought' })
    expect(buffer.get('s1')).toEqual({ text: 'answer', reasoning: 'final thought' })
  })

  it('appends to a stream it never saw begin', () => {
    const buffer = new LiveStreamBuffer()
    // A delta can arrive before the start frame is processed.
    buffer.append('s1', { text: 'first' })
    expect(buffer.get('s1')?.text).toBe('first')
  })

  it('discards what was left when a new stream begins', () => {
    const buffer = new LiveStreamBuffer()
    buffer.begin('s1')
    buffer.append('s1', { text: 'from the previous turn' })
    buffer.begin('s1')
    expect(buffer.get('s1')).toEqual({ text: '', reasoning: '' })
  })

  it('leaves nothing behind when the stream ends', () => {
    const buffer = new LiveStreamBuffer()
    buffer.begin('s1')
    buffer.append('s1', { text: 'done' })
    buffer.end('s1')
    expect(buffer.get('s1')).toBeUndefined()
  })

  it('reports nothing to show for an empty stream', () => {
    const buffer = new LiveStreamBuffer()
    buffer.begin('s1')
    // The view must not render an empty shell for a stream that just started.
    expect(buffer.nonEmpty('s1')).toBeUndefined()
    buffer.append('s1', { text: 'x' })
    expect(buffer.nonEmpty('s1')?.text).toBe('x')
    expect(buffer.nonEmpty('unknown')).toBeUndefined()
  })

  it('keeps Sessions apart', () => {
    const buffer = new LiveStreamBuffer()
    buffer.begin('a')
    buffer.begin('b')
    buffer.append('a', { text: 'for a' })
    expect(buffer.get('b')?.text).toBe('')
  })
})
