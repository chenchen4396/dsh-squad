import { afterEach, describe, expect, it, vi } from 'vitest'
import { PublishCoalescer } from '../src/runtime/publish-coalescer.js'

/**
 * A member writes session events far faster than a reader can see them, so
 * this decides what a view is rebuilt for. It had no test while it was an
 * inline timer in a listener.
 */
describe('PublishCoalescer', () => {
  afterEach(() => { vi.useRealTimers() })

  it('publishes once for a burst of events on one key', () => {
    vi.useFakeTimers()
    const coalescer = new PublishCoalescer(50)
    const publish = vi.fn()
    for (let i = 0; i < 5; i += 1) coalescer.schedule('session-a', publish)
    expect(publish).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(publish).toHaveBeenCalledOnce()
  })

  it('keeps a window per key, so one session cannot delay another', () => {
    vi.useFakeTimers()
    const coalescer = new PublishCoalescer(50)
    const first = vi.fn()
    const second = vi.fn()
    coalescer.schedule('a', first)
    coalescer.schedule('b', second)
    vi.advanceTimersByTime(50)
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })

  it('opens a fresh window for the next event', () => {
    vi.useFakeTimers()
    const coalescer = new PublishCoalescer(50)
    const publish = vi.fn()
    coalescer.schedule('a', publish)
    vi.advanceTimersByTime(50)
    coalescer.schedule('a', publish)
    vi.advanceTimersByTime(50)
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('does not wedge the key when a publish throws', () => {
    vi.useFakeTimers()
    const coalescer = new PublishCoalescer(50)
    coalescer.schedule('a', () => { throw new Error('publish failed') })
    // The caller owns the failure — the runtime's listener logs it — so the
    // throw escapes the timer here exactly as it does in the listener.
    expect(() => vi.advanceTimersByTime(50)).toThrow('publish failed')

    const next = vi.fn()
    coalescer.schedule('a', next)
    vi.advanceTimersByTime(50)
    // The key was released before publishing, so the next event gets a window.
    expect(next).toHaveBeenCalledOnce()
  })

  it('drops a pending publish when cancelled', () => {
    vi.useFakeTimers()
    const coalescer = new PublishCoalescer(50)
    const publish = vi.fn()
    coalescer.schedule('a', publish)
    coalescer.cancelAll()
    vi.advanceTimersByTime(500)
    expect(publish).not.toHaveBeenCalled()
  })
})
