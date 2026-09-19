import { useEffect, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { markdownLabels } from '../native-locale.js'
import type {
  InteractionResponseInput,
  PendingInteractionView,
  QuestionAnswerView,
} from '../../transport/contracts.js'
import { LEADER_ANSWER_WINDOW_MS, leaderAnswerState } from '../pending-actions.js'

/** Why the reader cannot answer yet, said the same way on both card kinds. */
const LEADER_WAIT_NOTE = `已交给 Leader 裁决：成员只通过 Leader 说话。${Math.round(LEADER_ANSWER_WINDOW_MS / 1000)} 秒内 Leader 未处理，这张卡会开放给你直接处理。`
/** «替我审批»: the card is a status line only — the Leader answers it, not the reader. */
const DELEGATED_NOTE = '本会话已开启「替我审批」：Leader 全权处理，这张卡不会开放给你。'
import css from './ConversationColumn.module.css'
import { errorText } from '../error-text.js'

export function PendingInteractionCard({
  interaction,
  memberName,
  awaitsLeader = false,
  onRespond,
}: {
  interaction: PendingInteractionView
  /** Member that is blocked on this request, when the card speaks for one. */
  memberName?: string
  /**
   * A member's request goes to the Leader first, so this card stays read-only
   * until the Leader has had {@link LEADER_ANSWER_WINDOW_MS} to answer it.
   */
  awaitsLeader?: boolean
  onRespond: (response: InteractionResponseInput) => Promise<void>
}): JSX.Element {
  const [answers, setAnswers] = useState<Record<string, QuestionAnswerView>>(() => (
    interaction.kind === 'question'
      ? Object.fromEntries(interaction.questions.map(question => [question.id, {
        id: question.id,
        selected: [],
      }]))
      : {}
  ))
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string>()
  // The window closes on its own, so the card has to notice time passing.
  const [now, setNow] = useState(() => Date.now())
  // A request wider than the Leader's own level is the reader's from the start:
  // the Leader cannot grant it, so there is nothing to wait for.
  const readerOnly = interaction.kind === 'approval' && interaction.userOnly === true
  // «替我审批» takes the reader out of the loop entirely: the card never opens.
  const leaderOnly = interaction.leaderOnly === true
  const withLeader = !leaderOnly && awaitsLeader && !readerOnly && leaderAnswerState(interaction.askedAt, now) === 'leader'
  useEffect(() => {
    if (!awaitsLeader || !withLeader) return
    const timer = setInterval(() => { setNow(Date.now()) }, 5_000)
    return () => { clearInterval(timer) }
  }, [awaitsLeader, withLeader])
  const locked = submitting || submitted || withLeader || leaderOnly

  async function submitResponse(response: InteractionResponseInput): Promise<void> {
    if (submitting || submitted) return
    setSubmitting(true)
    try {
      await onRespond(response)
      setSubmitted(true)
      setError(undefined)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setSubmitting(false)
    }
  }

  if (interaction.kind === 'approval') {
    return (
      <article className={`${css.interactionCard} ${css.approvalCard}`} aria-live="polite">
        <header className={css.interactionHeader}>
          <strong>{memberName === undefined ? '需要审批' : `${memberName} 的审批请求`}</strong>
          <span>{submitted ? '已提交' : withLeader ? '等 Leader 裁决' : leaderOnly ? 'Leader 全权处理' : '等待操作'}</span>
        </header>
        <div className={css.approvalToolName}>{interaction.toolName}</div>
        {interaction.reason && <p className={css.interactionDescription}>{interaction.reason}</p>}
        {withLeader && <p className={css.interactionDescription}>{LEADER_WAIT_NOTE}</p>}
        {leaderOnly && <p className={css.interactionDescription}>{DELEGATED_NOTE}</p>}
        {readerOnly && (
          <p className={css.interactionDescription}>
            超出 Leader 的权限（请求 {interaction.requestedMode ?? '未知'}），只能由你批准。
          </p>
        )}
        <div className={css.interactionActions}>
          <button
            type="button"
            className={css.interactionSecondaryButton}
            disabled={locked}
            onClick={() => { void submitResponse({ kind: 'approval', outcome: 'rejected' }) }}
          >
            拒绝
          </button>
          <button
            type="button"
            className={css.interactionPrimaryButton}
            disabled={locked}
            onClick={() => { void submitResponse({ kind: 'approval', outcome: 'allowed-once' }) }}
          >
            {submitting ? '提交中…' : submitted ? '已允许' : '允许本次'}
          </button>
        </div>
        {error && <span className={css.interactionError}>{error}</span>}
      </article>
    )
  }

  const complete = interaction.questions.every(question => {
    const answer = answers[question.id]
    return answer !== undefined && (answer.selected.length > 0 || Boolean(answer.custom?.trim()))
  })

  function updateAnswer(questionId: string, update: (current: QuestionAnswerView) => QuestionAnswerView): void {
    setAnswers(current => {
      const answer = current[questionId] ?? { id: questionId, selected: [] }
      return { ...current, [questionId]: update(answer) }
    })
  }

  return (
    <form
      className={`${css.interactionCard} ${css.questionCard}`}
      aria-live="polite"
      onSubmit={event => {
        event.preventDefault()
        if (!complete) return
        void submitResponse({
          kind: 'question',
          answers: interaction.questions.map(question => answers[question.id]!),
        })
      }}
    >
      <header className={css.interactionHeader}>
        <strong>
          {memberName === undefined ? '' : `${memberName} `}
          {interaction.questions.some(question => question.intent?.kind === 'plan-review') ? '请审阅方案' : '需要你的回答'}
        </strong>
        <span>{withLeader ? '等 Leader 回答' : leaderOnly ? 'Leader 全权处理' : `${interaction.questions.length} 个问题`}</span>
      </header>
      {withLeader && <p className={css.interactionDescription}>{LEADER_WAIT_NOTE}</p>}
      {leaderOnly && <p className={css.interactionDescription}>{DELEGATED_NOTE}</p>}
      <div className={css.questionList}>
        {interaction.questions.map((question, index) => {
          const answer = answers[question.id] ?? { id: question.id, selected: [] }
          const inputType = question.multiSelect === true ? 'checkbox' : 'radio'
          return (
            <fieldset key={question.id} className={css.questionFieldset} disabled={locked}>
              <legend>
                {question.header && <span>{question.header}</span>}
                <strong>{interaction.questions.length > 1 ? `${index + 1}. ${question.question}` : question.question}</strong>
              </legend>
              {question.detail && (
                <div className={css.questionDetail}><MarkdownText text={question.detail} labels={markdownLabels()} /></div>
              )}
              {(question.options?.length ?? 0) > 0 && (
                <div className={css.questionOptions}>
                  {question.options?.map(option => (
                    <label key={option.label} className={css.questionOption}>
                      <input
                        type={inputType}
                        name={`${interaction.id}:${question.id}`}
                        checked={answer.selected.includes(option.label)}
                        onChange={event => {
                          updateAnswer(question.id, current => {
                            if (question.multiSelect === true) {
                              const selected = event.target.checked
                                ? [...current.selected, option.label]
                                : current.selected.filter(label => label !== option.label)
                              return { ...current, selected }
                            }
                            return { id: current.id, selected: [option.label] }
                          })
                        }}
                      />
                      <span>
                        <strong>{option.label}</strong>
                        {option.description && <small>{option.description}</small>}
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <textarea
                className={css.questionCustomInput}
                value={answer.custom ?? ''}
                rows={2}
                placeholder={(question.options?.length ?? 0) > 0 ? '其他答案（可选）' : '请输入回答'}
                onChange={event => {
                  const custom = event.target.value
                  updateAnswer(question.id, current => ({
                    id: current.id,
                    selected: question.multiSelect === true ? current.selected : [],
                    ...(custom.length === 0 ? {} : { custom }),
                  }))
                }}
              />
            </fieldset>
          )
        })}
      </div>
      <div className={css.interactionActions}>
        <button
          type="submit"
          className={css.interactionPrimaryButton}
          disabled={locked || !complete}
        >
          {submitting ? '提交中…' : submitted ? '已提交' : '提交回答'}
        </button>
      </div>
      {error && <span className={css.interactionError}>{error}</span>}
    </form>
  )
}
