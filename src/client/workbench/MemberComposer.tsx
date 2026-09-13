import { useEffect, useRef, useState } from 'react'
import { IconSendOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam } from '../api.js'
import { addressedMemberContent } from '../member-composer.js'
import type { MemberComposerTarget } from '../store.js'
import css from '../AgentTeam.module.css'

/**
 * The composer that stands in for the Harness composer while the 团队 view is
 * addressing one member.
 *
 * The Harness composer belongs to the Session, and the Session's own Agent is
 * the team's Leader, so anything typed there reaches the Leader and nobody else.
 * Talking to one member privately is therefore a different composer, not a
 * different relay: this one hands the message to that member alone, and the
 * Leader never sees it.
 *
 * It is elected into the Harness's `conversation.composer` chain, so the native
 * composer stays mounted (hidden) underneath: the reader's draft there survives
 * switching back and forth.
 */
export function MemberComposer({ matched }: { matched: MemberComposerTarget }): JSX.Element {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  async function send(): Promise<void> {
    if (draft.trim().length === 0 || busy) return
    setBusy(true)
    try {
      await callAgentTeam('team.message.send', {
        teamId: matched.teamId,
        conversationId: matched.conversationId,
        content: addressedMemberContent(matched.displayName, draft),
        targetSlotId: matched.slotId,
      })
      setDraft('')
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.memberComposer}>
      <div className={css.memberComposerCard}>
        <div className={css.memberComposerAddressee} title="这条消息只发给该成员，Leader 不会收到">
          <span className={css.memberComposerAvatar} aria-hidden="true">
            {matched.displayName.slice(0, 1).toLocaleUpperCase()}
          </span>
          发给 {matched.displayName}
        </div>
        <textarea
          ref={inputRef}
          className={css.memberComposerInput}
          rows={1}
          value={draft}
          placeholder={`单独给 ${matched.displayName} 发消息…`}
          aria-label={`单独给 ${matched.displayName} 发消息`}
          onChange={event => { setDraft(event.target.value) }}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            void send()
          }}
        />
        <div className={css.memberComposerBar}>
          <span className={css.memberComposerHint}>只发给该成员 · Leader 不会收到</span>
          <button
            type="button"
            className={css.memberComposerSend}
            disabled={busy || draft.trim().length === 0}
            aria-label="发送"
            onClick={() => { void send() }}
          >
            <IconSendOutline16 size={16} />
          </button>
        </div>
        {error !== undefined && <div role="alert" className={css.memberComposerError}>{error}</div>}
      </div>
    </div>
  )
}
