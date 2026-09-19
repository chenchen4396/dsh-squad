import { describe, expect, it } from 'vitest'
import { OperationQueue } from '../src/runtime/operation-queue.js'

/**
 * This serializes the work that opens and reconfigures a team's members. Two
 * of those overlapping read the same records and then write them, which is the
 * race the queue exists to prevent — and nothing tested it before it had a
 * name, so the behaviour below is now pinned rather than assumed.
 */
describe('OperationQueue', () => {
  it('runs work for one key one at a time, in the order it was queued', async () => {
    const queue = new OperationQueue()
    const order: string[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })

    const first = queue.run('team', async () => {
      order.push('first:start')
      await gate
      order.push('first:end')
    })
    const second = queue.run('team', async () => {
      order.push('second:start')
    })

    // The second cannot have started while the first holds the key. One turn
    // of the event loop is enough for the queue's own chaining to have run.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(order).toEqual(['first:start'])
    release?.()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
  })

  it('runs different keys together', async () => {
    const queue = new OperationQueue()
    const order: string[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })

    const held = queue.run('one', async () => { await gate; order.push('one:end') })
    const free = queue.run('two', async () => { order.push('two:ran') })

    await free
    // A busy key does not hold up another.
    expect(order).toEqual(['two:ran'])
    release?.()
    await held
    expect(order).toEqual(['two:ran', 'one:end'])
  })

  it('keeps running after a failure instead of poisoning the key', async () => {
    const queue = new OperationQueue()
    const failure = queue.run('team', async () => { throw new Error('activation failed') })
    const after = queue.run('team', async () => 'ran anyway')

    await expect(failure).rejects.toThrow('activation failed')
    // A failed activation must not leave the team permanently unusable.
    await expect(after).resolves.toBe('ran anyway')
  })

  it('keeps the queue linked while more work is behind the running one', async () => {
    const queue = new OperationQueue()
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const order: string[] = []

    const first = queue.run('team', async () => { await gate; order.push('first') })
    const second = queue.run('team', async () => { order.push('second') })
    release?.()
    await Promise.all([first, second])
    // The entry is cleared by the last operation, not by whichever finishes.
    expect(order).toEqual(['first', 'second'])
  })

  it('settles after everything queued has finished, including work it queues', async () => {
    const queue = new OperationQueue()
    const order: string[] = []
    queue.run('team', async () => {
      order.push('outer')
      queue.run('team', async () => { order.push('inner') })
    })
    await queue.settled()
    // A single pass would have returned before the inner operation ran.
    expect(order).toEqual(['outer', 'inner'])
  })

  it('settles immediately when nothing is queued', async () => {
    await expect(new OperationQueue().settled()).resolves.toBeUndefined()
  })

  it('refuses new work once closed', async () => {
    const queue = new OperationQueue()
    queue.close()
    await expect(queue.run('team', async () => 'never')).rejects.toThrow('is closing')
  })

  it('leaves work already running to settle after it closes', async () => {
    const queue = new OperationQueue()
    const running = queue.run('team', async () => 'finished')
    queue.close()
    await expect(running).resolves.toBe('finished')
  })
})
