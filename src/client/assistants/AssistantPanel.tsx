import type { FormEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  IconArchiveOutline20,
  IconPlusOutline16,
  IconSendOutline16,
  IconStopFill16,
  MarkdownText,
  StateDot,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AssistantBuilderConversationListView,
  AssistantBuilderConversationSummary,
  AssistantBuilderConversationView,
  AssistantBuilderDraftView,
  AssistantView,
  CatalogView,
  McpCatalogView,
  RuleDocumentView,
  SkillCatalogView,
} from '../../transport/contracts.js'
import { isMarkdownRulePath, markdownRuleExtensions } from '../../domain/rule-format.js'
import { callAgentTeam, subscribeAssistantBuilderConversation } from '../api.js'
import css from '../AgentTeam.module.css'
import { defaultPermissionPreset } from './assistant-permission.js'
import { shouldSubmitComposer } from '../keyboard.js'
import { PERMISSION_LABELS } from '../labels.js'
import { markdownLabels } from '../native-locale.js'
import { defaultReasoningLabel, useModelCapabilities } from '../model-reasoning.js'
import { AnimatedModal, Empty, Field } from '../shared.js'
import { ConversationNodeView } from '../workbench/ConversationColumn.js'
import { buildRuleDocumentTree, type RuleDocumentNode } from '../rule-documents.js'
import { PendingInteractionCard } from '../workbench/PendingInteractionCard.js'
import conversationCss from '../workbench/ConversationColumn.module.css'

/**
 * Folder picking is not part of the standard React input typings, so the
 * directory hints are passed through as raw attributes.
 */
const folderInputAttributes = { webkitdirectory: '', directory: '' }

const ASSISTANT_FORM_ID = 'agent-team-assistant-form'
const ASSISTANT_EDIT_FORM_ID = 'agent-team-assistant-edit-form'

export function AssistantPanel({
  catalog,
  assistants,
  onChanged,
}: {
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  onChanged: () => Promise<void>
}): JSX.Element {
  const [creating, setCreating] = useState(false)
  const [editingAssistant, setEditingAssistant] = useState<AssistantView>()
  const [builderOpen, setBuilderOpen] = useState(false)
  const [assistantSaving, setAssistantSaving] = useState(false)
  // Cards name the documents an assistant loads, so the catalog is resolved
  // here rather than only inside the editor.
  const [ruleDocuments, setRuleDocuments] = useState<RuleDocumentView[]>([])
  useEffect(() => {
    let active = true
    void callAgentTeam('assistant.ruleDocuments.list', undefined)
      .then(value => { if (active) setRuleDocuments(value.items) })
      .catch(() => undefined)
    return () => { active = false }
  }, [assistants])
  return (
    <section className={css.section}>
      <div className={css.sectionHeader}>
        <div>
          <h2 className={css.sectionHeading}>助手模板 <span className={css.count}>{assistants.length}</span></h2>
          <p className={css.sectionDescription}>助手是可复用模板，解散团队不会删除助手。</p>
        </div>
        <div className={css.sectionHeaderActions}>
          <Button variant="primary" onClick={() => { setCreating(true) }}>手动新建</Button>
        </div>
      </div>
      <article className={css.assistantBuilderCard}>
        <div className={css.assistantBuilderAvatar} aria-hidden="true">AI</div>
        <div className={css.assistantBuilderCopy}>
          <span className={css.assistantBuilderEyebrow}>内置 · 默认</span>
          <strong>团队 Agent 小助手</strong>
          <p>描述你需要的角色，它会询问必要参数、整理长期提示词，并在确认后创建助手。</p>
        </div>
        <Button variant="primary" onClick={() => { setBuilderOpen(true) }}>开始对话</Button>
      </article>
      {assistants.length === 0
        ? <Empty text="还没有助手模板" hint="创建助手后，就可以把它作为 Leader 或普通成员加入不同团队。" />
        : (
            <div className={css.cardGrid}>
              {assistants.map(assistant => (
                <AssistantCard
                  key={assistant.id}
                  assistant={assistant}
                  ruleDocuments={ruleDocuments}
                  onEdit={() => { setEditingAssistant(assistant) }}
                  onChanged={onChanged}
                />
              ))}
            </div>
          )}
      <AnimatedModal
        open={builderOpen}
        onClose={() => { setBuilderOpen(false) }}
        title="团队 Agent 小助手"
        closeLabel="关闭"
        description="通过对话设计助手，完整配置会在你确认后保存到助手模板库。"
        className={css.assistantBuilderDialog ?? ''}
        contentClassName={css.assistantBuilderDialogContent ?? ''}
      >
        {builderOpen && <AssistantBuilderConversation catalog={catalog} />}
      </AnimatedModal>
      <AnimatedModal
        open={creating}
        onClose={() => { setCreating(false) }}
        title="新建助手"
        closeLabel="关闭"
        description="配置可复用的模型、权限与长期规则。具体任务在团队启动后发送。"
        className={css.assistantDialog ?? ''}
        contentClassName={css.modalScrollContent ?? ''}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setCreating(false) }} disabled={assistantSaving}>取消</Button>
            <Button
              variant="primary"
              type="submit"
              form={ASSISTANT_FORM_ID}
              disabled={assistantSaving}
            >
              {assistantSaving ? '保存中…' : '保存助手'}
            </Button>
          </>
        )}
      >
        <AssistantForm
          catalog={catalog}
          formId={ASSISTANT_FORM_ID}
          saving={assistantSaving}
          setSaving={setAssistantSaving}
          onSaved={async () => { setCreating(false); await onChanged() }}
        />
      </AnimatedModal>
      <AnimatedModal
        open={editingAssistant !== undefined}
        onClose={() => { setEditingAssistant(undefined) }}
        title="编辑助手"
        closeLabel="关闭"
        description="更新助手模板只影响之后启动的团队成员，不修改已有成员快照。"
        className={css.assistantDialog ?? ''}
        contentClassName={css.modalScrollContent ?? ''}
        footer={editingAssistant === undefined
          ? undefined
          : (
              <>
                <Button variant="outline" onClick={() => { setEditingAssistant(undefined) }} disabled={assistantSaving}>取消</Button>
                <Button
                  variant="primary"
                  type="submit"
                  form={ASSISTANT_EDIT_FORM_ID}
                  disabled={assistantSaving}
                >
                  {assistantSaving ? '保存中…' : '保存修改'}
                </Button>
              </>
            )}
      >
        {editingAssistant !== undefined && (
          <AssistantForm
            key={`${editingAssistant.id}:${editingAssistant.revision}`}
            catalog={catalog}
            formId={ASSISTANT_EDIT_FORM_ID}
            assistant={editingAssistant}
            saving={assistantSaving}
            setSaving={setAssistantSaving}
            onSaved={async () => { setEditingAssistant(undefined); await onChanged() }}
          />
        )}
      </AnimatedModal>
    </section>
  )
}

function AssistantBuilderConversation({ catalog }: { catalog: CatalogView | undefined }): JSX.Element {
  const [conversation, setConversation] = useState<AssistantBuilderConversationView>()
  const [draft, setDraft] = useState<AssistantBuilderDraftView>()
  const [history, setHistory] = useState<AssistantBuilderConversationSummary[]>([])
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [applyingModel, setApplyingModel] = useState(false)
  const [archivingSessionId, setArchivingSessionId] = useState<string>()
  const [archiveCandidate, setArchiveCandidate] = useState<AssistantBuilderConversationSummary>()
  const [archiveError, setArchiveError] = useState<string>()
  const [selectedProvider, setSelectedProvider] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [modelSelectionDirty, setModelSelectionDirty] = useState(false)
  const [error, setError] = useState<string>()
  const timeline = useRef<HTMLDivElement>(null)
  const drafting = useRef(false)
  const composing = useRef(false)
  const sendInFlight = useRef(false)

  const loadHistory = useCallback(async (): Promise<AssistantBuilderConversationListView> => {
    const next = await callAgentTeam('assistant.builder.list')
    setHistory(next.items)
    return next
  }, [])

  const load = useCallback(async (sessionId?: string) => {
    try {
      if (sessionId !== undefined) {
        const next = await callAgentTeam('assistant.builder.get', { sessionId })
        setConversation(next)
        setDraft(undefined)
        drafting.current = false
        await loadHistory()
      } else {
        const nextHistory = await loadHistory()
        const latest = nextHistory.items[0]
        if (latest !== undefined) {
          const next = await callAgentTeam('assistant.builder.get', {
            sessionId: latest.sessionId,
          })
          setConversation(next)
          setDraft(undefined)
          drafting.current = false
        } else {
          const next = await callAgentTeam('assistant.builder.draft.get')
          setConversation(undefined)
          setDraft(next)
          drafting.current = true
        }
      }
      setModelSelectionDirty(false)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [loadHistory])

  useEffect(() => {
    void load()
    return subscribeAssistantBuilderConversation(next => {
      if (next !== undefined) {
        setConversation(current => {
          if (current?.sessionId !== next.sessionId) return current
          if (current.status === 'running' && next.status === 'idle') void loadHistory()
          return next
        })
      }
      else if (drafting.current) void loadHistory()
      else void load()
      setError(undefined)
    }, () => {
      setError('实时连接已断开，正在等待重连')
    }, () => {
      setError(undefined)
      if (drafting.current) void loadHistory()
      else void load()
    })
  }, [load, loadHistory])

  useEffect(() => {
    const configuration = conversation?.configuration ?? draft?.configuration
    if (configuration === undefined || modelSelectionDirty) return
    setSelectedProvider(configuration.provider)
    setSelectedModel(configuration.model)
  }, [conversation, draft, modelSelectionDirty])

  useEffect(() => {
    const element = timeline.current
    if (element === null) return
    element.scrollTop = element.scrollHeight
  }, [conversation?.throughSeq, conversation?.nodes.length, conversation?.pendingInteractions.length])

  async function send(): Promise<void> {
    const message = content.trim()
    if (
      message.length === 0
      || !selectedProvider
      || !selectedModel
      || sendInFlight.current
      || (conversation === undefined && draft === undefined)
      || conversation?.status === 'running'
    ) return
    sendInFlight.current = true
    setSending(true)
    try {
      if (conversation === undefined) {
        const next = await callAgentTeam('assistant.builder.start', {
          provider: selectedProvider,
          model: selectedModel,
          content: message,
        })
        setConversation(next)
        setDraft(undefined)
        drafting.current = false
        setModelSelectionDirty(false)
      } else {
        await callAgentTeam('assistant.builder.send', {
          sessionId: conversation.sessionId,
          content: message,
        })
      }
      setContent('')
      await loadHistory()
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      sendInFlight.current = false
      setSending(false)
    }
  }

  async function stop(): Promise<void> {
    if (conversation === undefined) return
    try {
      await callAgentTeam('assistant.builder.stop', { sessionId: conversation.sessionId })
      await load(conversation.sessionId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function applyModel(): Promise<void> {
    if (!selectedProvider || !selectedModel || applyingModel || (conversation === undefined && draft === undefined) || conversation?.status === 'running') return
    setApplyingModel(true)
    try {
      if (conversation === undefined) {
        const next = await callAgentTeam('assistant.builder.draft.configure', {
          provider: selectedProvider,
          model: selectedModel,
        })
        setDraft(next)
      } else {
        const next = await callAgentTeam('assistant.builder.configure', {
          sessionId: conversation.sessionId,
          provider: selectedProvider,
          model: selectedModel,
        })
        setConversation(next)
      }
      setModelSelectionDirty(false)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setApplyingModel(false)
    }
  }

  async function createDraft(): Promise<void> {
    if (running || loading || draft !== undefined) return
    setLoading(true)
    try {
      const next = await callAgentTeam('assistant.builder.draft.get')
      setConversation(undefined)
      setDraft(next)
      drafting.current = true
      setContent('')
      setModelSelectionDirty(false)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  async function selectConversation(sessionId: string): Promise<void> {
    if (running || loading || sessionId === conversation?.sessionId) return
    setLoading(true)
    setContent('')
    setDraft(undefined)
    drafting.current = false
    await load(sessionId)
  }

  async function archiveConversation(): Promise<void> {
    const item = archiveCandidate
    if (item === undefined || loading || archivingSessionId !== undefined) return
    setArchivingSessionId(item.sessionId)
    setArchiveError(undefined)
    try {
      await callAgentTeam('assistant.builder.archive', { sessionId: item.sessionId })
      setContent('')
      if (item.sessionId === conversation?.sessionId) {
        setConversation(undefined)
        setLoading(true)
        await load()
      } else {
        await loadHistory()
      }
      setArchiveCandidate(undefined)
      setError(undefined)
    } catch (cause) {
      setArchiveError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setArchivingSessionId(undefined)
      setLoading(false)
    }
  }

  const running = conversation?.status === 'running'
  const pendingInteractions = conversation?.pendingInteractions ?? []
  const runtimeLabel = pendingInteractions.some(interaction => interaction.kind === 'approval')
    ? '等待审批'
    : pendingInteractions.length > 0
      ? '等待回答'
      : loading
        ? '正在启动…'
        : running
          ? '正在思考'
          : '可以对话'
  const providers = catalog?.providers ?? []
  const modelSelection = JSON.stringify([selectedProvider, selectedModel])
  const appliedConfiguration = conversation?.configuration ?? draft?.configuration
  const modelChanged = appliedConfiguration !== undefined && (
    selectedProvider !== appliedConfiguration.provider
    || selectedModel !== appliedConfiguration.model
  )
  return (
    <>
      <section className={css.assistantBuilderConversation}>
      <aside className={css.assistantBuilderHistory}>
        <button
          type="button"
          className={css.assistantBuilderNewConversation}
          disabled={loading || running || draft !== undefined}
          onClick={() => { void createDraft() }}
        >
          <IconPlusOutline16 size={14} />
          <span>新对话</span>
        </button>
        <div className={css.assistantBuilderHistoryList}>
          {history.map(item => (
            <div key={item.sessionId} className={css.assistantBuilderHistoryRow}>
              <button
                type="button"
                className={`${css.assistantBuilderHistoryItem} ${item.sessionId === conversation?.sessionId ? css.assistantBuilderHistoryItemActive : ''}`}
                disabled={loading || running || archivingSessionId !== undefined}
                onClick={() => { void selectConversation(item.sessionId) }}
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
                  disabled={loading || archivingSessionId !== undefined || (running && item.sessionId === conversation?.sessionId)}
                  onClick={() => {
                    setArchiveError(undefined)
                    setArchiveCandidate(item)
                  }}
                >
                  <IconArchiveOutline20 size={14} />
                </button>
              </Tooltip>
            </div>
          ))}
          {!loading && history.length === 0 && <span className={css.assistantBuilderHistoryEmpty}>暂无历史对话</span>}
        </div>
      </aside>
      <div className={css.assistantBuilderMain}>
        <div className={css.assistantBuilderRuntime}>
        <span className={css.assistantBuilderRuntimeState}>
          <StateDot state={running ? 'ongoing' : 'idle'} size={8} />
          <span>{runtimeLabel}</span>
        </span>
        <div className={css.assistantBuilderModelControls}>
          <select
            value={modelSelection}
            onChange={event => {
              const [provider, model] = JSON.parse(event.target.value) as [string, string]
              setSelectedProvider(provider)
              setSelectedModel(model)
              setModelSelectionDirty(true)
            }}
            className={css.assistantBuilderModelSelect}
            aria-label="小助手模型目录"
            disabled={loading || running || applyingModel}
          >
            {providers.map(provider => (
              <optgroup key={provider.id} label={provider.name}>
                {(catalog?.models[provider.id] ?? []).map(model => (
                  <option
                    key={`${provider.id}/${model.id}`}
                    value={JSON.stringify([provider.id, model.id])}
                  >
                    {model.name === model.id ? model.id : `${model.name}（${model.id}）`}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <Button
            variant="outline"
            size="sm"
            disabled={!modelChanged || !selectedProvider || !selectedModel || loading || running || applyingModel}
            onClick={() => { void applyModel() }}
          >
            {applyingModel ? '切换中…' : '应用模型'}
          </Button>
        </div>
        </div>
        <div ref={timeline} className={`${conversationCss.timeline} ${css.assistantBuilderTimeline}`}>
        {!loading && (draft !== undefined || conversation?.nodes.length === 0) && (
          <article className={`${conversationCss.messageNode} ${conversationCss.assistantMessage}`}>
            <div className={conversationCss.messageText}>
              <MarkdownText labels={markdownLabels()} text="你好，我是团队 Agent 小助手。告诉我你想创建什么样的助手，以及它主要负责什么；缺少的配置我会逐项询问你。" />
            </div>
          </article>
        )}
        {conversation?.nodes.map(node => <ConversationNodeView key={node.id} node={node} />)}
        {pendingInteractions.map(interaction => (
          <PendingInteractionCard
            key={interaction.id}
            interaction={interaction}
            onRespond={async response => {
              if (conversation === undefined) return
              await callAgentTeam('assistant.builder.interaction.respond', {
                sessionId: conversation.sessionId,
                interactionId: interaction.id,
                response,
              })
            }}
          />
        ))}
        </div>
        <form
        className={`${conversationCss.composer} ${css.assistantBuilderComposer}`}
        onSubmit={event => { event.preventDefault(); void send() }}
      >
        <textarea
          value={content}
          onChange={event => { setContent(event.target.value) }}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false }}
          onKeyDown={event => {
            if (!shouldSubmitComposer({
              key: event.key,
              shiftKey: event.shiftKey,
              isComposing: event.nativeEvent.isComposing,
              keyCode: event.nativeEvent.keyCode,
            }, composing.current)) return
            event.preventDefault()
            void send()
          }}
          placeholder={running ? '小助手正在回复…' : '例如：我需要一个负责 React 前端开发和代码审查的助手'}
          disabled={loading || running}
          rows={3}
        />
        <div className={conversationCss.composerFooter}>
          <span className={css.muted}>Enter 发送 · Shift+Enter 换行</span>
          <div className={conversationCss.composerActions}>
            {running && (
              <Tooltip label="停止生成" side="top" delayMs={400}>
                <button type="button" className={conversationCss.composerIconButton} onClick={() => { void stop() }} aria-label="停止生成">
                  <IconStopFill16 size={16} />
                </button>
              </Tooltip>
            )}
            <Tooltip label={sending ? '发送中…' : '发送消息'} side="top" delayMs={400}>
              <button
                type="submit"
                className={conversationCss.composerIconButton}
                disabled={loading || running || sending || !selectedProvider || !selectedModel || content.trim().length === 0}
                aria-label={sending ? '发送中' : '发送消息'}
              >
                <IconSendOutline16 size={16} />
              </button>
            </Tooltip>
          </div>
        </div>
        {error && <span className={conversationCss.composerError}>{error}</span>}
        </form>
      </div>
      </section>
      <AnimatedModal
        open={archiveCandidate !== undefined}
        onClose={() => {
          if (archivingSessionId === undefined) {
            setArchiveCandidate(undefined)
            setArchiveError(undefined)
          }
        }}
        title="归档会话"
        closeLabel="关闭"
        description="归档后，该会话将不再显示在团队 Agent 小助手的历史记录中。"
        className={css.assistantBuilderArchiveDialog ?? ''}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={archivingSessionId !== undefined}
              onClick={() => {
                setArchiveCandidate(undefined)
                setArchiveError(undefined)
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              disabled={archiveCandidate === undefined || archivingSessionId !== undefined}
              onClick={() => { void archiveConversation() }}
            >
              {archivingSessionId !== undefined ? '归档中…' : '确认归档'}
            </Button>
          </>
        )}
      >
        {archiveCandidate !== undefined && (
          <div className={css.assistantBuilderArchiveConfirm}>
            <div className={css.assistantBuilderArchiveIcon} aria-hidden="true">
              <IconArchiveOutline20 size={20} />
            </div>
            <div>
              <strong>{archiveCandidate.title}</strong>
              <p>会话内容不会被删除，底层 Session 日志仍由 Harness 保留。</p>
            </div>
            {archiveError && <div role="alert" className={css.inlineError}>{archiveError}</div>}
          </div>
        )}
      </AnimatedModal>
    </>
  )
}

function assistantBuilderStateLabel(state: AssistantBuilderConversationSummary['state']): string {
  if (state === 'completed') return '已创建'
  if (state === 'in_progress') return '配置中'
  return '新对话'
}

function formatConversationTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

/**
 * One node of the rule document tree. Folders only group — loading is chosen per
 * document, so a folder renders its children and nothing else.
 */
function RuleDocumentNodeRow({
  node,
  depth,
  selected,
  busy,
  previews,
  confirming,
  onToggle,
  onPreview,
  onAskDelete,
  onDelete,
}: {
  node: RuleDocumentNode
  depth: number
  selected: string[]
  busy: string | undefined
  previews: Record<string, string>
  confirming: string | undefined
  onToggle: (id: string, checked: boolean) => void
  onPreview: (id: string) => void
  onAskDelete: (id: string | undefined) => void
  onDelete: (id: string) => void
}): JSX.Element {
  if (node.kind === 'folder') {
    return (
      <div className={css.ruleDocumentFolder} style={{ paddingLeft: `${depth * 12}px` }}>
        <span className={css.ruleDocumentFolderName}>{node.name}/</span>
        <div className={css.ruleDocumentFolderChildren}>
          {node.children.map(child => (
            <RuleDocumentNodeRow
              key={child.kind === 'folder' ? `folder:${child.path}` : child.document.id}
              node={child}
              depth={depth + 1}
              selected={selected}
              busy={busy}
              previews={previews}
              confirming={confirming}
              onToggle={onToggle}
              onPreview={onPreview}
              onAskDelete={onAskDelete}
              onDelete={onDelete}
            />
          ))}
        </div>
      </div>
    )
  }

  const { document } = node
  const open = previews[document.id] !== undefined
  return (
    <div className={css.ruleDocument} style={{ marginLeft: `${depth * 12}px` }}>
      <label className={css.ruleDocumentMain}>
        <input
          type="checkbox"
          checked={selected.includes(document.id)}
          onChange={event => { onToggle(document.id, event.target.checked) }}
        />
        <span className={css.skillOptionText}>
          <strong>{document.title}</strong>
          <small>{document.path} · {(document.bytes / 1024).toFixed(1)} KB</small>
        </span>
      </label>
      <div className={css.ruleDocumentActions}>
        <button
          type="button"
          className={css.ruleDocumentAction}
          disabled={busy === document.id}
          onClick={() => { onPreview(document.id) }}
        >
          {open ? '收起' : '查看'}
        </button>
        {confirming === document.id
          ? (
              <>
                <button
                  type="button"
                  className={css.ruleDocumentDanger}
                  disabled={busy === document.id}
                  onClick={() => { onDelete(document.id) }}
                >
                  确认删除
                </button>
                <button
                  type="button"
                  className={css.ruleDocumentAction}
                  onClick={() => { onAskDelete(undefined) }}
                >
                  取消
                </button>
              </>
            )
          : (
              <button
                type="button"
                className={css.ruleDocumentAction}
                onClick={() => { onAskDelete(document.id) }}
              >
                删除
              </button>
            )}
      </div>
      {open && <pre className={css.ruleDocumentPreview}>{previews[document.id]}</pre>}
    </div>
  )
}

function AssistantCard({
  assistant,
  ruleDocuments,
  onEdit,
  onChanged,
}: {
  assistant: AssistantView
  ruleDocuments: RuleDocumentView[]
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
      setError(cause instanceof Error ? cause.message : String(cause))
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
      setError(cause instanceof Error ? cause.message : String(cause))
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
          <strong>{assistant.name}</strong>
          <span className={css.muted}>{assistant.provider} / {assistant.model}</span>
          <span className={css.muted}>
            Preset: {assistant.agentPresetId} · 权限: {PERMISSION_LABELS[assistant.permissionPresetId] ?? assistant.permissionPresetId} · 思考模式：{assistant.reasoningEffort ?? '模型默认'}
          </span>
          <span className={css.muted}>
            Skills: {assistant.skillAllowlist.length > 0 ? assistant.skillAllowlist.join('、') : '未选择'}
          </span>
          <span className={css.muted}>
            MCP: {assistant.mcpServers.length > 0 ? assistant.mcpServers.join('、') : '未选择'}
          </span>
          <span className={css.muted}>
            规则文档: {assistant.ruleDocumentAllowlist.length === 0
              ? '未选择'
              : assistant.ruleDocumentAllowlist
                  .map(id => ruleDocuments.find(document => document.id === id)?.title ?? '已删除的文档')
                  .join('、')}
          </span>
          {assistant.description && <p className={css.description}>{assistant.description}</p>}
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

function AssistantForm({
  catalog,
  formId,
  assistant,
  saving,
  setSaving,
  onSaved,
}: {
  catalog: CatalogView | undefined
  formId: string
  assistant?: AssistantView
  saving: boolean
  setSaving: (saving: boolean) => void
  onSaved: () => Promise<void>
}): JSX.Element {
  const providers = catalog?.providers ?? []
  const presets = catalog?.agentPresets.filter(preset => preset.broken === undefined) ?? []
  const permissions = catalog?.permissionPresets ?? []
  const [name, setName] = useState(assistant?.name ?? '')
  const [description, setDescription] = useState(assistant?.description ?? '')
  const [instructions, setInstructions] = useState(assistant?.instructions ?? '')
  const [provider, setProvider] = useState(assistant?.provider ?? providers[0]?.id ?? '')
  const models = catalog?.models[provider] ?? []
  const [modelChoice, setModelChoice] = useState(assistant?.model ?? '')
  const [reasoningEffort, setReasoningEffort] = useState(assistant?.reasoningEffort ?? '')
  const [agentPresetId, setAgentPresetId] = useState(assistant?.agentPresetId ?? presets[0]?.id ?? '')
  const [permissionPresetId, setPermissionPresetId] = useState(assistant?.permissionPresetId ?? defaultPermissionPreset(permissions))
  const [availableSkills, setAvailableSkills] = useState<SkillCatalogView['skills']>([])
  const [selectedSkills, setSelectedSkills] = useState<string[]>(assistant?.skillAllowlist ?? [])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsError, setSkillsError] = useState<string>()
  const [availableMcpServers, setAvailableMcpServers] = useState<McpCatalogView['servers']>([])
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>(assistant?.mcpServers ?? [])
  const [mcpLoading, setMcpLoading] = useState(false)
  const [mcpError, setMcpError] = useState<string>()
  const [ruleDocuments, setRuleDocuments] = useState<RuleDocumentView[]>([])
  const [ruleDocumentLimit, setRuleDocumentLimit] = useState<number>()
  const [selectedRuleDocuments, setSelectedRuleDocuments] = useState<string[]>(
    assistant?.ruleDocumentAllowlist ?? [],
  )
  const [ruleDocumentsLoading, setRuleDocumentsLoading] = useState(true)
  const [ruleDocumentsError, setRuleDocumentsError] = useState<string>()
  const [ruleDocumentPreview, setRuleDocumentPreview] = useState<Record<string, string>>({})
  const [ruleDocumentBusy, setRuleDocumentBusy] = useState<string>()
  const [confirmingRuleDocument, setConfirmingRuleDocument] = useState<string>()
  const ruleDocumentFilesRef = useRef<HTMLInputElement>(null)
  const ruleDocumentFolderRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string>()
  const modelCapabilities = useModelCapabilities(provider, modelChoice)

  useEffect(() => {
    if (!provider && providers[0]) setProvider(providers[0].id)
    if (!agentPresetId && presets[0]) setAgentPresetId(presets[0].id)
    if (!permissionPresetId && permissions[0]) setPermissionPresetId(defaultPermissionPreset(permissions))
  }, [agentPresetId, permissionPresetId, permissions, presets, provider, providers])
  useEffect(() => {
    setModelChoice(current => {
      if (models.some(candidate => candidate.id === current)) return current
      return models[0]?.id ?? ''
    })
  }, [models])
  useEffect(() => {
    if (modelCapabilities.loading || modelCapabilities.value === undefined) return
    const efforts = modelCapabilities.value.reasoning?.efforts ?? []
    setReasoningEffort(current => current && !efforts.some(effort => effort.id === current) ? '' : current)
  }, [modelCapabilities.loading, modelCapabilities.value])
  const ruleDocumentTree = useMemo(() => buildRuleDocumentTree(ruleDocuments), [ruleDocuments])

  const toggleRuleDocument = useCallback((id: string, checked: boolean): void => {
    setSelectedRuleDocuments(current => checked
      ? (current.includes(id) ? current : [...current, id])
      : current.filter(value => value !== id))
  }, [])

  const loadRuleDocuments = useCallback(async (): Promise<RuleDocumentView[]> => {
    try {
      const value = await callAgentTeam('assistant.ruleDocuments.list', undefined)
      setRuleDocuments(value.items)
      setRuleDocumentLimit(value.limitBytes)
      setRuleDocumentsError(undefined)
      return value.items
    } catch (cause) {
      setRuleDocumentsError(cause instanceof Error ? cause.message : String(cause))
      return []
    } finally {
      setRuleDocumentsLoading(false)
    }
  }, [])

  useEffect(() => { void loadRuleDocuments() }, [loadRuleDocuments])

  /**
   * Import whole files, one request each.
   *
   * One document per request keeps every body well inside `maxRequestBytes` — a
   * folder of rules can be far larger than one request may carry. Files keep the
   * layout they were picked with, so `rules/frontend/` stays grouped, and the
   * imported documents are selected straight away since importing means using.
   *
   * Only Markdown is imported: a picked folder usually holds more than rules, so
   * anything else is skipped by name rather than uploaded and refused.
   */
  async function importRuleDocuments(files: File[]): Promise<void> {
    if (files.length === 0) return
    setRuleDocumentBusy('import')
    setRuleDocumentsError(undefined)
    const importedPaths = new Set<string>()
    const failures: string[] = []
    const skipped: string[] = []
    let latest = ruleDocuments
    for (const file of files) {
      const relative = file.webkitRelativePath.length > 0 ? file.webkitRelativePath : file.name
      if (!isMarkdownRulePath(relative)) {
        skipped.push(relative)
        continue
      }
      // Check locally first: uploading an oversized file would come back as a
      // generic body-limit error instead of naming the file and the cap.
      if (ruleDocumentLimit !== undefined && file.size > ruleDocumentLimit) {
        failures.push(
          `${relative}：${(file.size / 1024).toFixed(0)} KB 超过 ${Math.round(ruleDocumentLimit / 1024)} KB 上限`,
        )
        continue
      }
      try {
        const content = await file.text()
        const value = await callAgentTeam('assistant.ruleDocuments.import', {
          path: relative,
          content,
        })
        latest = value.items
        setRuleDocumentLimit(value.limitBytes)
        importedPaths.add(relative)
      } catch (cause) {
        failures.push(`${relative}：${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
    setRuleDocuments(latest)
    const importedIds = latest
      .filter(document => importedPaths.has(document.path))
      .map(document => document.id)
    if (importedIds.length > 0) {
      setSelectedRuleDocuments(current => [...new Set([...current, ...importedIds])])
    }
    if (failures.length > 0) {
      setRuleDocumentsError(`${failures.length} 份文档导入失败 — ${failures.slice(0, 3).join('；')}`)
    } else if (skipped.length > 0) {
      setRuleDocumentsError(
        `已跳过 ${skipped.length} 个非 Markdown 文件（只支持 ${markdownRuleExtensions.join(' / ')}）：${skipped.slice(0, 3).join('；')}`,
      )
    }
    setRuleDocumentBusy(undefined)
    if (ruleDocumentFilesRef.current !== null) ruleDocumentFilesRef.current.value = ''
    if (ruleDocumentFolderRef.current !== null) ruleDocumentFolderRef.current.value = ''
  }

  async function toggleRuleDocumentPreview(id: string): Promise<void> {
    if (ruleDocumentPreview[id] !== undefined) {
      setRuleDocumentPreview(current => {
        const next = { ...current }
        delete next[id]
        return next
      })
      return
    }
    setRuleDocumentBusy(id)
    try {
      const document = await callAgentTeam('assistant.ruleDocuments.get', { id })
      setRuleDocumentPreview(current => ({ ...current, [id]: document.content }))
    } catch (cause) {
      setRuleDocumentsError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRuleDocumentBusy(undefined)
    }
  }

  async function deleteRuleDocument(id: string): Promise<void> {
    setRuleDocumentBusy(id)
    try {
      const value = await callAgentTeam('assistant.ruleDocuments.delete', { id })
      setRuleDocuments(value.items)
      setSelectedRuleDocuments(current => current.filter(value => value !== id))
      setRuleDocumentPreview(current => {
        const next = { ...current }
        delete next[id]
        return next
      })
      setConfirmingRuleDocument(undefined)
    } catch (cause) {
      setRuleDocumentsError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRuleDocumentBusy(undefined)
    }
  }

  useEffect(() => {
    let active = true
    if (!agentPresetId) {
      setAvailableSkills([])
      setSelectedSkills([])
      return () => { active = false }
    }
    setSkillsLoading(true)
    setSkillsError(undefined)
    void callAgentTeam('skill.catalog', { agentPresetId })
      .then(value => {
        if (!active) return
        setAvailableSkills(value.skills)
        const availableNames = new Set(value.skills.map(skill => skill.name))
        setSelectedSkills(current => current.filter(name => availableNames.has(name)))
      })
      .catch(cause => {
        if (!active) return
        setAvailableSkills([])
        setSelectedSkills([])
        setSkillsError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (active) setSkillsLoading(false)
      })
    return () => { active = false }
  }, [agentPresetId])
  useEffect(() => {
    let active = true
    if (!agentPresetId) {
      setAvailableMcpServers([])
      setSelectedMcpServers([])
      return () => { active = false }
    }
    setMcpLoading(true)
    setMcpError(undefined)
    void callAgentTeam('mcp.catalog', { agentPresetId })
      .then(value => {
        if (!active) return
        setAvailableMcpServers(value.servers)
        const availableNames = new Set(value.servers.map(server => server.name))
        setSelectedMcpServers(current => current.filter(name => availableNames.has(name)))
      })
      .catch(cause => {
        if (!active) return
        setAvailableMcpServers([])
        setSelectedMcpServers([])
        setMcpError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (active) setMcpLoading(false)
      })
    return () => { active = false }
  }, [agentPresetId])

  const model = modelChoice

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    try {
      const value = {
        name,
        ...(assistant === undefined && !description.trim()
          ? {}
          : { description: description.trim() }),
        instructions,
        provider,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        agentPresetId,
        permissionPresetId,
        skillAllowlist: selectedSkills,
        mcpServers: selectedMcpServers,
        ruleDocumentAllowlist: selectedRuleDocuments,
      }
      if (assistant === undefined) {
        await callAgentTeam('assistant.create', value)
      } else {
        await callAgentTeam('assistant.update', { id: assistant.id, value }, assistant.revision)
      }
      await onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form id={formId} onSubmit={(event) => { void submit(event) }} className={`${css.form} ${css.assistantForm}`}>
      <div className={css.formGrid}>
        <Field label="名称"><input required value={name} onChange={event => { setName(event.target.value) }} className={css.input} /></Field>
        <Field label="说明"><input value={description} onChange={event => { setDescription(event.target.value) }} className={css.input} /></Field>
        <Field label="Provider">
          <select required value={provider} onChange={event => { setProvider(event.target.value) }} className={css.input}>
            <option value="">请选择</option>
            {providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </Field>
        <Field label={`模型（${models.length} 个可选）`}>
          <select required value={modelChoice} onChange={event => { setModelChoice(event.target.value) }} className={css.input}>
            <option value="" disabled>请选择</option>
            {models.map(item => (
              <option key={item.id} value={item.id}>
                {item.name === item.id ? item.id : `${item.name}（${item.id}）`}
              </option>
            ))}
          </select>
        </Field>
        {modelCapabilities.value?.reasoning !== undefined && modelCapabilities.value.reasoning.efforts.length > 0 && (
          <Field label="思考模式">
            <select
              value={reasoningEffort}
              onChange={event => { setReasoningEffort(event.target.value) }}
              className={css.input}
              aria-describedby={`${formId}-reasoning-hint`}
            >
              <option value="">{defaultReasoningLabel(modelCapabilities.value)}</option>
              {modelCapabilities.value.reasoning.efforts.map(effort => (
                <option key={effort.id} value={effort.id}>
                  {effort.name === effort.id ? effort.name : `${effort.name}（${effort.id}）`}
                </option>
              ))}
            </select>
            <span id={`${formId}-reasoning-hint`} className={css.hint}>由当前 Provider 和模型决定可用档位。</span>
          </Field>
        )}
        {modelCapabilities.error && <span className={conversationCss.composerError}>{modelCapabilities.error}</span>}
        <Field label="Agent Preset">
          <select required value={agentPresetId} onChange={event => { setAgentPresetId(event.target.value) }} className={css.input}>
            {presets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </Field>
        <Field label="权限预设">
          <select required value={permissionPresetId} onChange={event => { setPermissionPresetId(event.target.value) }} className={css.input}>
            {permissions.map(item => (
              <option key={item.value} value={item.value}>
                {PERMISSION_LABELS[item.value] ?? item.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="助手规则（可选）" className={css.fullWidth ?? ''}>
          <textarea
            value={instructions}
            onChange={event => { setInstructions(event.target.value) }}
            rows={4}
            placeholder="例如：你负责前端实现；遵循现有代码风格；修改前先阅读相关文件；完成后向 Leader 汇报测试结果。"
            className={css.input}
          />
          <span className={css.hint}>随助手模板保存，在成员启动时加入系统提示词；这里不填写具体任务。</span>
        </Field>
        <Field
          label={`规则文档（已选择 ${selectedRuleDocuments.length} 份）`}
          className={css.fullWidth ?? ''}
        >
          <div className={css.ruleDocuments} role="group" aria-label="选择该助手加载的规则文档">
            <div className={css.ruleDocumentsToolbar}>
              <button
                type="button"
                className={css.ruleDocumentsImport}
                disabled={ruleDocumentBusy !== undefined}
                onClick={() => { ruleDocumentFilesRef.current?.click() }}
              >
                {ruleDocumentBusy === 'import' ? '导入中…' : '+ 导入文件'}
              </button>
              <button
                type="button"
                className={css.ruleDocumentsImport}
                disabled={ruleDocumentBusy !== undefined}
                onClick={() => { ruleDocumentFolderRef.current?.click() }}
              >
                导入文件夹
              </button>
              <span className={css.hint}>
                整份导入，不做条目拆分；选文件夹会保留 rules/ 这类层级。只支持 Markdown（
                {markdownRuleExtensions.join(' / ')}），其他文件会被跳过。
              </span>
              <input
                ref={ruleDocumentFilesRef}
                type="file"
                multiple
                accept={`${markdownRuleExtensions.join(',')},text/markdown`}
                hidden
                aria-label="选择要导入的规则文档"
                onChange={event => {
                  void importRuleDocuments([...(event.target.files ?? [])])
                }}
              />
              <input
                ref={ruleDocumentFolderRef}
                type="file"
                multiple
                hidden
                aria-label="选择要导入的规则文件夹"
                {...(folderInputAttributes as Record<string, string>)}
                onChange={event => {
                  void importRuleDocuments([...(event.target.files ?? [])])
                }}
              />
            </div>
            {ruleDocumentsError !== undefined && (
              <span className={conversationCss.composerError}>{ruleDocumentsError}</span>
            )}
            {ruleDocumentsLoading && <span className={css.hint}>正在读取规则文档…</span>}
            {!ruleDocumentsLoading && ruleDocuments.length === 0 && (
              <span className={css.hint}>还没有导入任何规则文档。</span>
            )}
            {!ruleDocumentsLoading && ruleDocumentTree.map(node => (
              <RuleDocumentNodeRow
                key={node.kind === 'folder' ? `folder:${node.path}` : node.document.id}
                node={node}
                depth={0}
                selected={selectedRuleDocuments}
                busy={ruleDocumentBusy}
                previews={ruleDocumentPreview}
                confirming={confirmingRuleDocument}
                onToggle={toggleRuleDocument}
                onPreview={id => { void toggleRuleDocumentPreview(id) }}
                onAskDelete={setConfirmingRuleDocument}
                onDelete={id => { void deleteRuleDocument(id) }}
              />
            ))}
          </div>
          <span className={css.hint}>只勾选这个助手需要的文档；成员会实时继承这里的选择，下一轮对话即可生效。</span>
        </Field>
        <Field
          label={`可用 Skills（已选择 ${selectedSkills.length} 个）`}
          className={css.fullWidth ?? ''}
        >
          <div className={css.skillPicker} role="group" aria-label="选择助手可使用的 Skills">
            {skillsLoading && <span className={css.hint}>正在读取该 Preset 的 Skills…</span>}
            {!skillsLoading && skillsError && <span className={conversationCss.composerError}>{skillsError}</span>}
            {!skillsLoading && !skillsError && availableSkills.length === 0 && (
              <span className={css.hint}>该 Agent Preset 没有可用的 Skill。</span>
            )}
            {!skillsLoading && availableSkills.map(skill => (
              <label key={skill.name} className={css.skillOption}>
                <input
                  type="checkbox"
                  checked={selectedSkills.includes(skill.name)}
                  onChange={event => {
                    setSelectedSkills(current => event.target.checked
                      ? [...current, skill.name].sort()
                      : current.filter(name => name !== skill.name))
                  }}
                />
                <span className={css.skillOptionText}>
                  <strong>{skill.name}{!skill.modelInvocable && skill.userInvocable ? ' · 仅斜杠调用' : ''}</strong>
                  <small>{skill.description}</small>
                </span>
              </label>
            ))}
          </div>
          <span className={css.hint}>只选择这个助手执行任务时可能需要的 Skills；运行时会按任务需要加载具体 Skill 指令。</span>
        </Field>
        <Field
          label={`可用 MCP（已选择 ${selectedMcpServers.length} 个）`}
          className={css.fullWidth ?? ''}
        >
          <div className={css.skillPicker} role="group" aria-label="选择助手可使用的 MCP Server">
            {mcpLoading && <span className={css.hint}>正在读取该 Preset 的 MCP Server…</span>}
            {!mcpLoading && mcpError && <span className={conversationCss.composerError}>{mcpError}</span>}
            {!mcpLoading && !mcpError && availableMcpServers.length === 0 && (
              <span className={css.hint}>当前 Harness 未为该 Agent Preset 配置 MCP Server。</span>
            )}
            {!mcpLoading && availableMcpServers.map(server => (
              <label key={server.name} className={css.skillOption}>
                <input
                  type="checkbox"
                  checked={selectedMcpServers.includes(server.name)}
                  onChange={event => {
                    setSelectedMcpServers(current => event.target.checked
                      ? [...current, server.name].sort()
                      : current.filter(name => name !== server.name))
                  }}
                />
                <span className={css.skillOptionText}>
                  <strong>{server.name}</strong>
                  <small>{server.tools.length} 个工具</small>
                </span>
              </label>
            ))}
          </div>
          <span className={css.hint}>MCP 连接和密钥由 Harness Profile/Preset 统一管理；运行时只向助手开放已选 Server 的工具。</span>
        </Field>
      </div>
      {error && <div role="alert" className={css.inlineError}>{error}</div>}
    </form>
  )
}
