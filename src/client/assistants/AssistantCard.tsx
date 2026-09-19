import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AssistantView } from '../../transport/contracts.js'
import { callAgentTeam } from '../api.js'
import css from '../AgentTeam.module.css'
import { PERMISSION_LABELS } from '../labels.js'
import { AnimatedModal } from '../shared.js'
import { errorText } from '../error-text.js'

/** One assistant template, with the actions that act on the template itself. */

export function AssistantCard({
  assistant,
  onEdit,
  onChanged,
}: {
  assistant: AssistantView
  onEdit: () => void
  onChanged: () => Promise<void>
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [deleteOpen, setDeleteOpen] = useState(false)

  async function clone(): Promise<void> {
    setBusy(true)
    try {
      await callAgentTeam('assistant.clone', { id: assistant.id, name: `${assistant.name} Copy` })
      await onChanged()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    setBusy(true)
    try {
      await callAgentTeam('assistant.delete', { id: assistant.id })
      setDeleteOpen(false)
      setError(undefined)
      await onChanged()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <article className={css.card}>
        <div
          className={css.assistantCardContent}
          role="button"
          tabIndex={busy ? -1 : 0}
          aria-label={`编辑助手 ${assistant.name}`}
          onClick={() => { if (!busy) onEdit() }}
          onKeyDown={event => {
            if (busy || (event.key !== 'Enter' && event.key !== ' ')) return
            event.preventDefault()
            onEdit()
          }}
        >
          <div className={css.assistantCardHead}>
            <span className={css.assistantCardAvatar} aria-hidden="true">
              {assistant.name.trim().slice(0, 1).toUpperCase() || 'AI'}
            </span>
            <span className={css.assistantCardIdentity}>
              <strong className={css.assistantCardName}>{assistant.name}</strong>
              {/* The model is the one fact a reader scans for, so it sits on the
                  name line instead of in a list of four equal strings. */}
              <span className={css.assistantCardModel}>{assistant.model}</span>
            </span>
          </div>
          {assistant.description && <p className={css.assistantCardDescription}>{assistant.description}</p>}
          <div className={css.assistantCardFacts}>
            <span className={css.assistantCardFact} data-tone="permission">
              {PERMISSION_LABELS[assistant.permissionPresetId] ?? assistant.permissionPresetId}
            </span>
            <span className={css.assistantCardFact}>{assistant.agentPresetId}</span>
            <span className={css.assistantCardFact}>{assistant.reasoningEffort ?? '思考默认'}</span>
          </div>
          {/* Counts, not names: the editor is where the lists belong, and five
              joined lists turn one card into a paragraph. */}
          <dl className={css.assistantCardCounts}>
            <div className={css.assistantCardCount}>
              <dt>Skills</dt>
              <dd data-empty={assistant.skillAllowlist.length === 0 ? 'true' : undefined}>
                {assistant.skillAllowlist.length}
              </dd>
            </div>
            <div className={css.assistantCardCount}>
              <dt>MCP</dt>
              <dd data-empty={assistant.mcpServers.length === 0 ? 'true' : undefined}>
                {assistant.mcpServers.length}
              </dd>
            </div>
            <div className={css.assistantCardCount}>
              <dt>规则文档</dt>
              <dd data-empty={assistant.ruleDocumentAllowlist.length === 0 ? 'true' : undefined}>
                {assistant.ruleDocumentAllowlist.length}
              </dd>
            </div>
          </dl>
        </div>
        <div className={css.actions}>
          <Button variant="outline" size="sm" disabled={busy} onClick={onEdit}>编辑</Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { void clone() }}>复制</Button>
          <Button
            variant="outline"
            size="sm"
            className={css.dangerAction}
            disabled={busy}
            onClick={() => {
              setError(undefined)
              setDeleteOpen(true)
            }}
          >
            删除
          </Button>
        </div>
        {error && !deleteOpen && <div role="alert" className={css.inlineError}>{error}</div>}
      </article>
      <AnimatedModal
        open={deleteOpen}
        onClose={() => {
          if (busy) return
          setDeleteOpen(false)
          setError(undefined)
        }}
        title="删除助手模板"
        closeLabel="关闭"
        description="此操作无法撤销。"
        className={css.assistantDeleteDialog ?? ''}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDeleteOpen(false)
                setError(undefined)
              }}
            >
              取消
            </Button>
            <Button
              variant="outline"
              className={css.dangerAction}
              disabled={busy}
              onClick={() => { void remove() }}
            >
              {busy ? '删除中…' : '确认删除'}
            </Button>
          </>
        )}
      >
        <div className={css.assistantDeleteConfirm}>
          <div className={css.assistantDeleteIcon} aria-hidden="true">
            {assistant.name.slice(0, 1).toLocaleUpperCase()}
          </div>
          <div>
            <strong>{assistant.name}</strong>
            <p>删除后不会影响团队或 Workspace。若模板仍被团队成员引用，系统会拒绝删除。</p>
          </div>
          {error && <div role="alert" className={css.inlineError}>{error}</div>}
        </div>
      </AnimatedModal>
    </>
  )
}

