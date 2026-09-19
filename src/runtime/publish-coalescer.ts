/**
 * Publish at most once per window, per key.
 *
 * A running member writes session events constantly, and every one of them
 * changes what its conversation view should show. Publishing on each event
 * would rebuild the same view dozens of times a second for no reader to see,
 * so the first event schedules a publish and the rest of the window is
 * dropped: the reader sees the state at the end of the window, which is the
 * state that matters.
 *
 * The window is short enough that a person cannot tell it is there (48ms is
 * under three frames) and long enough to absorb a burst.
 */
const DEFAULT_WINDOW_MS = 48

export class PublishCoalescer {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly windowMs: number = DEFAULT_WINDOW_MS) {}

  /** Run `publish` for `key` once, at the end of the current window. */
  schedule(key: string, publish: () => void): void {
    if (this.timers.has(key)) return
    const timer = setTimeout(() => {
      // Cleared before publishing so a failure cannot leave the key scheduled
      // forever, and the next event opens a fresh window.
      this.timers.delete(key)
      publish()
    }, this.windowMs)
    this.timers.set(key, timer)
  }

  /** Cancel every window. Pending publishes do not run. */
  cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}
