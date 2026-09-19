/**
 * The message to show a reader for something that failed.
 *
 * A rejection is unknown: it is usually an Error, and `callAgentTeam` only
 * rejects with an Error or a string, but a thrown value can be anything. This
 * was written out at forty-seven call sites, which is forty-seven chances for
 * one of them to render `[object Object]` at somebody.
 */
export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
