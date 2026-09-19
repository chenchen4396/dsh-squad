import type { WorkspaceGitChangeView, WorkspaceGitStatusView } from '../../transport/contracts.js'
import type { WorkspaceDiffTarget } from './WorkspaceDiffDialog.js'
import { IconBranchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './WorkspacePanel.module.css'

/** The change groups of one workspace, grouped by directory. */
export function WorkspaceChanges({
  status,
  error,
  refreshing,
  onOpenDiff,
}: {
  status: WorkspaceGitStatusView | undefined
  error: string | undefined
  refreshing: boolean
  onOpenDiff: (target: WorkspaceDiffTarget) => void
}): JSX.Element {
  if (error !== undefined) return <span className={css.fileError}>{error}</span>
  if (status === undefined) return <span className={css.fileEmpty}>{refreshing ? '正在读取 Git 状态…' : '暂无状态'}</span>
  if (status.state === 'not-repository') {
    return (
      <div className={css.workspaceGitEmpty}>
        <span><IconBranchOutline16 size={20} /></span>
        <strong>当前 Workspace 不是 Git 仓库</strong>
        <p>仍可在“文件”中浏览工作区内容。</p>
      </div>
    )
  }
  if (status.changes.length === 0) {
    return (
      <div className={css.workspaceGitEmpty}>
        <span><IconBranchOutline16 size={20} /></span>
        <strong>没有未提交变更</strong>
        <p>Workspace 当前处于干净状态。</p>
      </div>
    )
  }

  const conflicted = status.changes.filter(change => change.kind === 'unmerged')
  const staged = status.changes.filter(change => change.staged && change.kind !== 'unmerged')
  const modified = status.changes.filter(change => change.unstaged && !['unmerged', 'untracked'].includes(change.kind))
  const untracked = status.changes.filter(change => change.kind === 'untracked')
  return (
    <div className={css.workspaceChanges}>
      <WorkspaceChangeGroup title="冲突" changes={conflicted} scope="unstaged" onOpenDiff={onOpenDiff} />
      <WorkspaceChangeGroup title="已暂存" changes={staged} scope="staged" onOpenDiff={onOpenDiff} />
      <WorkspaceChangeGroup title="已修改" changes={modified} scope="unstaged" onOpenDiff={onOpenDiff} />
      <WorkspaceChangeGroup title="未跟踪" changes={untracked} scope="unstaged" onOpenDiff={onOpenDiff} />
      {status.truncated && <span className={css.workspaceChangesTruncated}>变更过多，仅显示前 2000 项。</span>}
    </div>
  )
}

function WorkspaceChangeGroup({
  title,
  changes,
  scope,
  onOpenDiff,
}: {
  title: string
  changes: WorkspaceGitChangeView[]
  scope: 'staged' | 'unstaged'
  onOpenDiff: (target: WorkspaceDiffTarget) => void
}): JSX.Element | null {
  if (changes.length === 0) return null
  return (
    <section className={css.workspaceChangeGroup}>
      <header><strong>{title}</strong><span>{changes.length}</span></header>
      {changes.map(change => (
        <button
          type="button"
          className={css.workspaceChangeRow}
          key={`${title}:${change.path}`}
          title={`预览 ${change.path}`}
          onClick={() => { onOpenDiff({ change, scope }) }}
        >
          <span className={`${css.workspaceChangeCode} ${workspaceChangeTone(change)}`}>
            {workspaceChangeCode(change)}
          </span>
          <span className={css.workspaceChangePath}>
            {change.originalPath === undefined ? change.path : `${change.originalPath} → ${change.path}`}
          </span>
        </button>
      ))}
    </section>
  )
}


function workspaceChangeTone(change: WorkspaceGitChangeView): string {
  if (change.kind === 'added' || change.kind === 'untracked') return css.workspaceChangeAdded!
  if (change.kind === 'deleted' || change.kind === 'unmerged') return css.workspaceChangeDeleted!
  if (change.kind === 'renamed' || change.kind === 'copied') return css.workspaceChangeRenamed!
  return css.workspaceChangeModified!
}

function workspaceChangeCode(change: WorkspaceGitChangeView): string {
  if (change.kind === 'untracked') return 'U'
  if (change.kind === 'unmerged') return '!'
  if (change.kind === 'added') return 'A'
  if (change.kind === 'deleted') return 'D'
  if (change.kind === 'renamed') return 'R'
  if (change.kind === 'copied') return 'C'
  if (change.kind === 'type-changed') return 'T'
  return 'M'
}
