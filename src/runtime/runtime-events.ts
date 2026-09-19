import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgentStatus } from '@deepseek-ai/dsh-agent'
import type { MemberRegistry } from './member-registry.js'
import type { PublishCoalescer } from './publish-coalescer.js'
import type { LiveStreamBuffer } from './live-stream-buffer.js'

/** What the runtime's event subscriptions need to act on. */
export interface RuntimeEventDeps {
  /** Which Sessions this runtime owns, and what they are for. */
  members: MemberRegistry
  /** Coalesces the burst of events one turn produces into one publish. */
  conversationPublishes: PublishCoalescer
  /** The half-written reply, held while a turn is still running. */
  liveStreams: LiveStreamBuffer
  warn: (message: string, error: unknown) => void
  /** A Session's own Agent appeared: it acts as the Leader of its team. */
  attachLeaderForSession: (sessionId: string) => void
  /** The reader typed into a bound Session. */
  observeUserMessage: (sessionId: string, event: SessionEvent) => void
  /** A member's Agent changed status; the record follows. */
  setMemberRuntimeState: (teamId: string, slotId: string, status: AgentStatus) => Promise<void>
  /** A member's transcript moved; the view is rebuilt. */
  publishOwnedConversation: (sessionId: string) => void
}

/**
 * Everything this runtime listens to, wired in one place.
 *
 * Six subscriptions were set up inline in the constructor and held in six
 * fields, and `dispose` called the six by hand. That is six chances to add a
 * seventh and forget it there — a leak that only shows as work happening after
 * the runtime is gone.
 *
 * What each event means stays here, next to the reason it is subscribed to;
 * what to do about it is the runtime's.
 *
 * @returns one disposer that removes every subscription.
 */
export function subscribeRuntimeEvents(ctx: Context, deps: RuntimeEventDeps): () => void {
  const disposers: Array<() => void> = []
  // A Session's own Agent is the Leader of whichever team that Session has
  // enabled, so the composition is installed when the Agent appears — on the
  // first conversation view, on a reload, or after a Harness restart — and
  // dropped when it goes away.
  disposers.push(ctx.on('agent/created', ({ agent }) => {
    deps.attachLeaderForSession(String(agent.id))
  }))
  disposers.push(ctx.on('agent/disposed', ({ agent }) => {
    deps.members.detachLeader(String(agent.id))
  }))
  // Everything the user types goes through the Harness composer now, so a
  // bound Session's own user message is what the room must show — and what
  // routes to a member the message mentions.
  disposers.push(ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message') return
    deps.observeUserMessage(String(session.id), event)
  }))
  disposers.push(ctx.on('agent/status', ({ agent, status }) => {
    const owned = deps.members.agentOf(String(agent.id))
    if (owned === undefined) return
    void deps.setMemberRuntimeState(owned.teamId, owned.slotId, status)
      .catch(error => deps.warn('agent-team: failed to persist agent status', error))
  }))
  disposers.push(ctx.on('session/event', (session) => {
    const sessionId = String(session.id)
    if (deps.members.agentOf(sessionId) === undefined && deps.members.leaderOf(sessionId) === undefined) return
    deps.conversationPublishes.schedule(sessionId, () => {
      try {
        deps.publishOwnedConversation(sessionId)
      } catch (error) {
        deps.warn('agent-team: failed to publish conversation update', error)
      }
    })
  }))
  disposers.push(ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const sessionId = String(agent.id)
    if (!deps.members.has(sessionId)) return
    // What each frame means is this listener's business; holding the
    // in-progress text is the buffer's.
    if (frame.type === 'start') {
      deps.liveStreams.begin(sessionId)
    } else if (frame.type === 'chunk') {
      const chunk = frame.chunk
      if (chunk.type === 'text-delta') deps.liveStreams.append(sessionId, { text: chunk.text })
      if (chunk.type === 'reasoning-delta') deps.liveStreams.append(sessionId, { reasoning: chunk.text })
      if (chunk.type === 'block-end' && chunk.block.type === 'text') {
        deps.liveStreams.replace(sessionId, { text: chunk.block.text })
      }
      if (chunk.type === 'block-end' && chunk.block.type === 'reasoning') {
        deps.liveStreams.replace(sessionId, { reasoning: chunk.block.text })
      }
    } else {
      deps.liveStreams.end(sessionId)
    }
  }))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
