import { withinLeaderAuthority } from './sandbox-authority.js'

/** The request a member is waiting on, as the policy needs to see it. */
export interface PendingAnswerRequest {
  kind: 'question' | 'approval'
  /** The sandbox level the request wants, when it is an approval. */
  requestedMode?: string | undefined
}

export interface LeaderAnswerInput {
  pending: PendingAnswerRequest
  /** What the Leader decided, when it decided. */
  decision?: 'allow' | 'deny'
  /** The sandbox level the Leader's own Session runs at. */
  leaderMode: string | undefined
  /** Whether «替我审批» has taken the reader out of this conversation. */
  delegated: boolean
}

export interface LeaderAnswerDecision {
  /**
   * Why the Leader may not answer this, or undefined when it may.
   *
   * Set only for a request wider than the Leader's own authority that the
   * Leader is trying to *allow*: refusing is always within its power.
   */
  refusal?: string
  /**
   * Whether only the reader could have granted this, so the request must be
   * kept off the Leader's screen and left for them.
   */
  userOnly: boolean
}

/**
 * Whether the Leader may answer a member's request, and what to say if not.
 *
 * A member cannot reach the reader, so the Leader answers for the team — but
 * only within its own authority. A request wider than that can be refused by
 * the Leader and granted only by the reader, so an attempt to allow it is
 * turned down with the reason. When «替我审批» has taken the reader out of the
 * conversation there is nobody who could grant it, and the request is refused
 * outright rather than left as a card that can never be answered.
 *
 * This is the one rule the whole approval path rests on, and it lived inside a
 * tool callback where nothing could test it.
 */
export function decideLeaderAnswer(input: LeaderAnswerInput): LeaderAnswerDecision {
  const beyondAuthority = input.pending.kind === 'approval'
    && input.decision === 'allow'
    && !withinLeaderAuthority(input.leaderMode, input.pending.requestedMode)
  if (!beyondAuthority) return { userOnly: false }

  const mode = input.leaderMode ?? '未知'
  const requested = input.pending.requestedMode ?? '未知'
  return {
    // Only the reader could grant it, and «替我审批» took them out of the loop,
    // so it stays refused rather than opening a card nobody can answer.
    userOnly: !input.delegated,
    refusal: input.delegated
      ? `超出你当前权限（${mode}）：请求 ${requested} 不能批准。`
        + '本会话开启了「替我审批」，用户不会介入——请改判 deny，或换一个你权限内的方案。'
      : `超出你当前权限（${mode}）：请求 ${requested} 只能由用户批准。`
        + '你可以 deny，或在你自己的回复里把理由和影响告诉用户，由它决定。',
  }
}
