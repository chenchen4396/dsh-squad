import { IconArchiveOutline20, IconPlusOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AssistantBuilderConversationSummary } from '../../transport/contracts.js'
import css from '../AgentTeam.module.css'
import { assistantBuilderStateLabel, formatConversationTime } from './builder-labels.js'

/**
 * The designer's conversation history.
 *
 * Each row is one past conversation with the designer, and the two things a
 * reader does with one: open it, or archive it. Both are unavailable while the
 * designer is working — archiving the conversation an Agent is running in is
 * the one action that cannot be undone by reopening it.
 */
export function BuilderHistory({
  history,
  activeSessionId,
  loading,
  running,
  drafting,
  archivingSessionId,
  onNew,
  onSelect,
  onArchive,
}: {
  history: readonly AssistantBuilderConversationSummary[]
  /** The conversation on screen, marked in the list. */
  activeSessionId: string | undefined
  loading: boolean
  running: boolean
  /** A brand-new conversation is already open, so a second is not offered. */
  drafting: boolean
  archivingSessionId: string | undefined
  onNew: () => void
  onSelect: (sessionId: string) => void
  onArchive: (item: AssistantBuilderConversationSummary) => void
}): JSX.Element {
  const busy = loading || running || archivingSessionId !== undefined
  return (
    <aside className={css.assistantBuilderHistory}>
      <button
        type="button"
        className={css.assistantBuilderNewConversation}
        disabled={loading || running || drafting}
        onClick={onNew}
      >
        <IconPlusOutline16 size={14} />
        <span>新对话</span>
      </button>
      <div className={css.assistantBuilderHistoryList}>
        {history.map(item => (
          <div key={item.sessionId} className={css.assistantBuilderHistoryRow}>
            <button
              type="button"
              className={`${css.assistantBuilderHistoryItem} ${item.sessionId === activeSessionId ? css.assistantBuilderHistoryItemActive : ''}`}
              disabled={busy}
              onClick={() => { onSelect(item.sessionId) }}
            >
              <strong>{item.title}</strong>
              <span>
                <time dateTime={item.updatedAt}>{formatConversationTime(item.updatedAt)}</time>
                <em>{assistantBuilderStateLabel(item.state)}</em>
              </span>
            </button>
            <Tooltip label="归档会话" side="right" delayMs={400}>
              <button
                type="button"
                className={css.assistantBuilderHistoryArchive}
                aria-label={`归档会话 ${item.title}`}
                disabled={loading || archivingSessionId !== undefined || (running && item.sessionId === activeSessionId)}
                onClick={() => { onArchive(item) }}
              >
                <IconArchiveOutline20 size={14} />
              </button>
            </Tooltip>
          </div>
        ))}
        {!loading && history.length === 0 && (
          <span className={css.assistantBuilderHistoryEmpty}>暂无历史对话</span>
        )}
      </div>
    </aside>
  )
}
