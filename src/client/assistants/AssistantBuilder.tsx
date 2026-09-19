import { useCallback, useEffect, useRef, useState } from 'react'
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
  CatalogView,
} from '../../transport/contracts.js'
import { callAgentTeam, subscribeAssistantBuilderConversation } from '../api.js'
import css from '../AgentTeam.module.css'
import { shouldSubmitComposer } from '../keyboard.js'
import { markdownLabels } from '../native-locale.js'
import { AnimatedModal } from '../shared.js'
import { ConversationNodeView } from '../workbench/ConversationNodeView.js'
import { PendingInteractionCard } from '../workbench/PendingInteractionCard.js'
import conversationCss from '../workbench/ConversationColumn.module.css'
import { errorText } from '../error-text.js'

/** The chat that designs an assistant, and the history of past ones. */

export function assistantBuilderStateLabel(state: AssistantBuilderConversationSummary['state']): string {
  if (state === 'completed') return '已创建'
  if (state === 'in_progress') return '配置中'
  return '新对话'
}


export function formatConversationTime(value: string): string {
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

export function AssistantBuilderConversation({ catalog }: { catalog: CatalogView | undefined }): JSX.Element {
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
      setError(errorText(cause))
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
      setError(errorText(cause))
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
      setError(errorText(cause))
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
      setError(errorText(cause))
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
      setError(errorText(cause))
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
      setArchiveError(errorText(cause))
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

/** One titled group of the editor, so a long form reads as a few decisions. */
