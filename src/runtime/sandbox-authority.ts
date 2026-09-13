/**
 * The sandbox ladder and who may grant what.
 *
 * A member asking to widen its sandbox is asking for one level of
 * {@link SANDBOX_MODES}. Members never reach the reader, so the Leader answers
 * — but only within the access the Leader itself holds: granting a member
 * something the Leader cannot do would let the team exceed the grant the reader
 * gave the Leader. Anything wider waits for the reader.
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const

export type SandboxMode = (typeof SANDBOX_MODES)[number]

/** Whether a value names one of the ladder's levels. */
export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === 'string' && (SANDBOX_MODES as readonly string[]).includes(value)
}

/** Where one mode sits on the ladder; -1 for a level we do not know. */
export function sandboxLevel(mode: string | undefined): number {
  return isSandboxMode(mode) ? SANDBOX_MODES.indexOf(mode) : -1
}

/**
 * Whether a Leader running at `leaderMode` may grant `requested`.
 *
 * An approval that names no wider level (some asks are not escalations) is
 * within anyone's authority. A named level needs a Leader whose own level is at
 * least as wide; a Leader whose level cannot be read counts as narrower than
 * everything, so the request goes to the reader instead of being guessed at.
 */
export function withinLeaderAuthority(leaderMode: string | undefined, requested: string | undefined): boolean {
  if (requested === undefined) return true
  const leader = sandboxLevel(leaderMode)
  const wanted = sandboxLevel(requested)
  if (leader < 0 || wanted < 0) return false
  return wanted <= leader
}

/**
 * The sandbox level a Session is running at, from its own log.
 *
 * `sandbox/mode` is logged whenever the level changes, so the last one is the
 * level in effect; a Session that never logged one is unknown, not unlimited.
 */
export function sandboxModeOf(events: readonly SessionEvent[]): SandboxMode | undefined {
  let mode: SandboxMode | undefined
  for (const event of events) {
    // `sandbox/mode` is declared by the sandbox-policy package, which this
    // plugin does not depend on, so the event is read by its shape.
    const candidate = event as { type: string; data?: { mode?: unknown } }
    if (candidate.type !== 'sandbox/mode') continue
    if (isSandboxMode(candidate.data?.mode)) mode = candidate.data.mode
  }
  return mode
}
