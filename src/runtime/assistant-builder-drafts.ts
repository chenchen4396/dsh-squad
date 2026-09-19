import type { CreateAssistantInput } from '../domain/types.js'

/** One validated assistant draft, waiting for the user to approve it. */
export interface PendingAssistantDraft {
  input: CreateAssistantInput
  /**
   * The Session's last event sequence when the draft was prepared. Approval
   * has to be a *later* real user message, so this is what makes an older
   * message in the transcript impossible to mistake for consent.
   */
  preparedThroughSeq: number
}

/**
 * The assistant drafts the designer has proposed but not created.
 *
 * One per Session, and only until it is used: preparing again replaces the
 * draft rather than queueing a second one, because the user is looking at one
 * configuration. A draft belongs to the Session that prepared it, so two open
 * designers cannot approve each other's.
 */
export class AssistantDraftStore {
  private readonly drafts = new Map<string, PendingAssistantDraft>()

  /** Record a draft, replacing whatever this Session had prepared before. */
  put(sessionId: string, draft: PendingAssistantDraft): void {
    this.drafts.set(sessionId, draft)
  }

  get(sessionId: string): PendingAssistantDraft | undefined {
    return this.drafts.get(sessionId)
  }

  /**
   * Drop a draft, but only the one the caller was working with.
   *
   * Approving one draft must not discard a newer draft that arrived while the
   * approval was in flight.
   */
  discard(sessionId: string, draft: PendingAssistantDraft): void {
    if (this.drafts.get(sessionId) === draft) this.drafts.delete(sessionId)
  }

  /** Drop whatever this Session has prepared. */
  clear(sessionId: string): void {
    this.drafts.delete(sessionId)
  }
}
