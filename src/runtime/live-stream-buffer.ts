/**
 * The assistant text one Session is producing right now.
 *
 * A member's reply reaches the runtime as a stream, and the workbench shows it
 * as it arrives rather than waiting for the turn to end. Two things make that
 * harder than appending strings: the provider sends deltas *and*, at the end of
 * each block, the block's complete text — so a delta-built value can be
 * replaced by the authoritative one — and a stream that ends must leave nothing
 * behind, or the view keeps showing text from a turn that is over.
 *
 * Only what is in progress lives here. Once a turn ends the Session log is the
 * truth, and this holds nothing.
 */
export interface LiveStream {
  text: string
  reasoning: string
}

export class LiveStreamBuffer {
  private readonly streams = new Map<string, LiveStream>()

  /** Begin a stream for a Session, discarding anything left from before. */
  begin(sessionId: string): void {
    this.streams.set(sessionId, { text: '', reasoning: '' })
  }

  /** Add a delta to what has arrived so far. */
  append(sessionId: string, delta: Partial<LiveStream>): void {
    const current = this.streams.get(sessionId) ?? { text: '', reasoning: '' }
    this.streams.set(sessionId, {
      text: current.text + (delta.text ?? ''),
      reasoning: current.reasoning + (delta.reasoning ?? ''),
    })
  }

  /**
   * Replace the accumulated value with the provider's own.
   *
   * The closing frame of a block carries the whole block, which corrects any
   * delta that arrived out of order or was dropped.
   */
  replace(sessionId: string, value: Partial<LiveStream>): void {
    const current = this.streams.get(sessionId) ?? { text: '', reasoning: '' }
    this.streams.set(sessionId, {
      text: value.text ?? current.text,
      reasoning: value.reasoning ?? current.reasoning,
    })
  }

  /** Forget a Session's stream. Nothing is left to show once a turn ends. */
  end(sessionId: string): void {
    this.streams.delete(sessionId)
  }

  get(sessionId: string): LiveStream | undefined {
    return this.streams.get(sessionId)
  }

  /** The stream for a Session, unless there is nothing to show yet. */
  nonEmpty(sessionId: string): LiveStream | undefined {
    const stream = this.streams.get(sessionId)
    if (stream === undefined) return undefined
    return stream.text.length === 0 && stream.reasoning.length === 0 ? undefined : stream
  }
}
