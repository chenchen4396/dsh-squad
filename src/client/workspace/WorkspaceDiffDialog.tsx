import { useEffect, useRef, useState } from 'react'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceGitChangeView, WorkspaceGitDiffView } from '../../transport/contracts.js'
import { callAgentTeam } from '../api.js'
import { AnimatedModal } from '../shared.js'
import css from './WorkspacePanel.module.css'

/** One change the reader asked to see, and which side of the index it is on. */
export interface WorkspaceDiffTarget {
  change: WorkspaceGitChangeView
  scope: 'staged' | 'unstaged'
}

/** The diff of one change, as an overlay so the panel keeps its place. */
export function WorkspaceDiffDialog({
  teamId,
  conversationId,
  target,
  onClose,
}: {
  teamId: string
  conversationId: string | undefined
  target: WorkspaceDiffTarget | undefined
  onClose: () => void
}): JSX.Element {
  const [diff, setDiff] = useState<WorkspaceGitDiffView>()
  const [layout, setLayout] = useState<'unified' | 'split'>('unified')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const themeType = useHarnessThemeType()

  useEffect(() => {
    if (target === undefined) {
      setDiff(undefined)
      setError(undefined)
      return
    }
    let active = true
    setLoading(true)
    setDiff(undefined)
    setError(undefined)
    void callAgentTeam('team.workspace.diff', {
      teamId,
      ...(conversationId === undefined ? {} : { conversationId }),
      path: target.change.path,
      scope: target.scope,
      layout,
      theme: themeType,
    }).then(next => {
      if (active) setDiff(next)
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [conversationId, layout, target, teamId, themeType])

  const scopeLabel = target?.scope === 'staged' ? '已暂存' : '工作区'
  const hasTextPatch = diff !== undefined && !diff.binary && diff.html.length > 0
  return (
    <AnimatedModal
      open={target !== undefined}
      onClose={onClose}
      title={target?.change.path ?? '文件变更'}
      className={css.workspaceDiffDialog ?? ''}
      headless
    >
      <div className={css.workspaceDiffShell}>
        <header className={css.workspaceDiffHeader}>
          <div className={css.workspaceDiffHeading}>
            <div className={css.workspaceDiffTitleRow}>
              <h2>{target?.change.path ?? '文件变更'}</h2>
              <span>{workspaceChangeLabel(target?.change.kind)}</span>
            </div>
            <p>{scopeLabel}变更 · 只读预览</p>
          </div>
          <div className={css.workspaceDiffHeaderActions}>
            <div className={css.workspaceDiffLayout} role="group" aria-label="Diff 布局">
              <button
                type="button"
                className={layout === 'unified' ? css.workspaceDiffLayoutActive : ''}
                onClick={() => { setLayout('unified') }}
              >统一</button>
              <button
                type="button"
                className={layout === 'split' ? css.workspaceDiffLayoutActive : ''}
                onClick={() => { setLayout('split') }}
              >分栏</button>
            </div>
            <button type="button" className={css.workspaceDiffClose} aria-label="关闭变更预览" onClick={onClose}>
              <IconCloseOutline16 size={16} />
            </button>
          </div>
        </header>
        <div className={css.workspaceDiffBody}>
          {loading && <div className={css.workspaceDiffState}>正在读取文件变更…</div>}
          {error && <div role="alert" className={css.workspaceDiffError}>{error}</div>}
          {diff?.binary && <div className={css.workspaceDiffState}>二进制文件无法显示文本 Diff。</div>}
          {diff !== undefined && !diff.binary && !hasTextPatch && (
            <div className={css.workspaceDiffState}>这个文件只有元数据变化，没有可显示的文本差异。</div>
          )}
          {hasTextPatch && diff !== undefined && <WorkspaceDiffHtml html={diff.html} />}
        </div>
      </div>
    </AnimatedModal>
  )
}

function WorkspaceDiffHtml({ html }: { html: string }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    root.innerHTML = html
    return () => { root.replaceChildren() }
  }, [html])
  return <div ref={hostRef} className={css.workspaceDiffVirtualizer} />
}

function useHarnessThemeType(): 'light' | 'dark' {
  const readTheme = (): 'light' | 'dark' => (
    typeof document !== 'undefined' && document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
  )
  const [themeType, setThemeType] = useState<'light' | 'dark'>(readTheme)
  useEffect(() => {
    const observer = new MutationObserver(() => { setThemeType(readTheme()) })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => { observer.disconnect() }
  }, [])
  return themeType
}


function workspaceChangeLabel(kind: WorkspaceGitChangeView['kind'] | undefined): string {
  if (kind === 'added') return '新增文件'
  if (kind === 'deleted') return '删除文件'
  if (kind === 'renamed') return '重命名'
  if (kind === 'copied') return '复制文件'
  if (kind === 'unmerged') return '冲突文件'
  if (kind === 'untracked') return '未跟踪文件'
  if (kind === 'type-changed') return '类型变化'
  return '修改文件'
}
