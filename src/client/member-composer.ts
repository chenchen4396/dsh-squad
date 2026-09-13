/**
 * One private message, addressed.
 *
 * A message sent straight to a member reads like every other addressed message
 * in the team: it opens with `@Name`, the same mention the Harness composer's
 * `@` menu writes. The member's own transcript then says who the message was
 * for instead of showing a bare line, and a reader's line in the meeting room
 * carries the same addressing. A message that already names the member is left
 * as it is.
 *
 * @param displayName - the member the message is sent to.
 * @param draft - what the reader typed.
 * @returns the message content delivered to that member.
 */
export function addressedMemberContent(displayName: string, draft: string): string {
  const body = draft.trim()
  const mention = `@${displayName}`
  return body.includes(mention) ? body : `${mention} ${body}`
}
