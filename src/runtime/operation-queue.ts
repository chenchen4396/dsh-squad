/**
 * One operation at a time, per key.
 *
 * Two things must not overlap: opening a team's members, and any later attempt
 * to do the same, because both read the same records and then write them. Work
 * for different keys is independent and runs together, so one busy team cannot
 * hold up another.
 *
 * It also decides what a failure means. An operation that rejects does not
 * poison the queue — the next one runs normally — because a failed activation
 * must not make the team permanently unusable. And once the owner is closing,
 * nothing new starts: a promise that never settles would be worse than a
 * refusal, so callers get an error instead.
 */
export class OperationQueue {
  private readonly pending = new Map<string, Promise<unknown>>()
  private closed = false

  /** Run `operation` after everything already queued under `key` has settled. */
  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('dsh-squad runtime is closing'))
    const prior = this.pending.get(key) ?? Promise.resolve()
    const current = prior.catch(() => undefined).then(operation)
    this.pending.set(key, current)
    void current.finally(() => {
      // Only the last operation clears the entry: an earlier one finishing must
      // not drop the link to the one queued behind it.
      if (this.pending.get(key) === current) this.pending.delete(key)
    }).catch(() => undefined)
    return current
  }

  /** Refuse new work. Operations already running are left to settle. */
  close(): void {
    this.closed = true
  }

  /**
   * Resolve once nothing is queued or running.
   *
   * Shutdown waits on this before disposing the agents those operations are
   * holding. It loops because an operation may queue another as it finishes,
   * and a single pass would return while work was still arriving.
   */
  async settled(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending.values()])
    }
  }
}
