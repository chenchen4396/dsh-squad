import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { callAgentTeam, subscribeAgentTeam } from './api.js'

/** One member the `@` menu can offer. */
interface MentionMember {
  slotId: string
  displayName: string
  role: 'leader' | 'member'
}

/** The one menu candidate shape this source produces. */
interface MentionCandidate {
  name: string
  description?: string
  icon: 'session'
  value: string
}

/** The `@` trigger source contract this plugin implements. */
interface InputTriggerSource {
  trigger: '@'
  name: string
  order?: number
  showGroupTitle?: boolean
  candidates(
    session: { sessionId: string },
    request: { query: string; signal: AbortSignal },
  ): Promise<readonly MentionCandidate[]>
  onPick(pick: { candidate: MentionCandidate }): { insert: MentionInsert }
  lexicon?(session: { sessionId: string }): readonly string[] | undefined
  subscribeLexicon?(session: { sessionId: string }, listener: () => void): () => void
  warm?(session: { sessionId: string }): void
  readonly codec?: {
    clipboardText(ref: string): string
    serialize(ref: string, signal: AbortSignal): Promise<string>
  }
}

interface MentionInsert {
  source: string
  ref: string
  label: string
  appearance: 'session'
  clipboardText: string
}

interface InputTriggerHost {
  registerSource(source: InputTriggerSource): () => void
}

/** Menu group title of this plugin's own `@` candidates. */
const SOURCE_NAME = '团队成员'

/**
 * Offer the enabled team's members in the Harness's own `@` menu.
 *
 * The meeting room deliberately has no composer of its own: a message typed in
 * the Harness composer is what the Session — and so the team's Leader — reads.
 * `@`-mentioning a member is how the reader addresses a specific one, and the
 * Host relays a mentioned message straight to that member, so the mention is a
 * routing instruction rather than decoration.
 *
 * Sessions without a team produce no candidates, and the source rides the
 * client plugin's lifetime.
 *
 * @param ctx - client root context.
 */
export function registerTeamMentionSource(ctx: ClientContext): void {
  // The composer's trigger service may compose after this plugin, so the source
  // is contributed through an injection scope rather than read once at apply.
  ctx.inject(['inputTriggers'], scoped => {
    register(scoped, scoped.get('inputTriggers') as InputTriggerHost)
  })
}

/**
 * Contribute the source to a live trigger service.
 *
 * @param ctx - the injection scope owning every registration.
 * @param triggers - the composer's trigger service.
 */
function register(ctx: ClientContext, triggers: InputTriggerHost): void {

  const rosters = new Map<string, MentionMember[]>()
  const inflight = new Map<string, Promise<MentionMember[]>>()
  const listeners = new Map<string, Set<() => void>>()

  function rosterFor(sessionId: string): Promise<MentionMember[]> {
    const cached = rosters.get(sessionId)
    if (cached !== undefined) return Promise.resolve(cached)
    const running = inflight.get(sessionId)
    if (running !== undefined) return running
    const request = callAgentTeam('team.session.get', { sessionId })
      .then(view => (view.team === undefined
        ? []
        : Object.values(view.team.members)
          .sort((left, right) => (left.id === view.team?.leaderSlotId ? -1 : 0)
            - (right.id === view.team?.leaderSlotId ? -1 : 0))
          .map(member => ({
            slotId: member.id,
            displayName: member.displayName,
            role: member.role,
          }))))
      .catch(() => [])
      .then(members => {
        rosters.set(sessionId, members)
        inflight.delete(sessionId)
        return members
      })
    inflight.set(sessionId, request)
    return request
  }

  /** Drop every cached roster: a team or a binding may have changed. */
  function invalidate(): void {
    rosters.clear()
    for (const set of listeners.values()) for (const listener of set) listener()
  }

  ctx.effect(
    () => subscribeAgentTeam(
      kinds => {
        if ([...kinds].some(kind => kind === 'team' || kind === 'conversation')) invalidate()
      },
      () => undefined,
    ),
    'agent-team: mention roster invalidation',
  )

  ctx.effect(() => triggers.registerSource({
    trigger: '@',
    name: SOURCE_NAME,
    order: -1,
    showGroupTitle: true,
    warm(session) {
      void rosterFor(session.sessionId)
    },
    async candidates(session, { query, signal }) {
      const members = await rosterFor(session.sessionId)
      if (signal.aborted) return []
      const needle = query.toLocaleLowerCase()
      return members
        .filter(member => needle.length === 0 || member.displayName.toLocaleLowerCase().includes(needle))
        .slice(0, 12)
        .map((member): MentionCandidate => ({
          name: member.displayName,
          description: member.role === 'leader' ? 'Leader' : '成员',
          icon: 'session',
          value: member.slotId,
        }))
    },
    onPick({ candidate }) {
      const mention = `@${candidate.name}`
      return {
        insert: {
          // The pipeline resolves the codec by the source's own name.
          source: SOURCE_NAME,
          ref: mention,
          label: candidate.name,
          appearance: 'session',
          clipboardText: mention,
        },
      }
    },
    lexicon(session) {
      return rosters.get(session.sessionId)?.map(member => member.displayName)
    },
    subscribeLexicon(session, listener) {
      const set = listeners.get(session.sessionId) ?? new Set()
      set.add(listener)
      listeners.set(session.sessionId, set)
      return () => {
        set.delete(listener)
        if (set.size === 0) listeners.delete(session.sessionId)
      }
    },
    codec: {
      clipboardText: ref => ref,
      serialize: ref => Promise.resolve(ref),
    },
  }), 'agent-team: @ source')
}
