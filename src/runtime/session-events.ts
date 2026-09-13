import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Read one stored session's durable event log without taking write ownership.
 * Used for members and Assistant Builder conversations that are not currently
 * online, since `ctx.sessions` only holds live sessions.
 */
export async function readStoredEvents(
  ctx: Context,
  sessionId: string,
): Promise<readonly SessionEvent[]> {
  const handle = await ctx.sessionPersistence.open(SessionId(sessionId), 'read')
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
  }
}
