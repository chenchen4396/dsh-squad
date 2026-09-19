import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IconChevronRightOutline14,
  IconFolderClose16,
  IconFolderOpen16,
  IconRefreshOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  TeamView,
  WorkspaceEntryView,
  WorkspaceGitChangeView,
  WorkspaceGitDiffView,
  WorkspaceGitStatusView,
} from '../../transport/contracts.js'
import { callAgentTeam, subscribeAgentTeamWorkspace } from '../api.js'
import css from './WorkspacePanel.module.css'
import { WorkspaceChanges } from './WorkspaceChanges.js'
import { WorkspaceDiffDialog, type WorkspaceDiffTarget } from './WorkspaceDiffDialog.js'
import { WorkspaceTreeRow } from './WorkspaceTreeRow.js'

export function WorkspacePanel({
  team,
  conversationId,
  workspacePath,
  refreshSignal,
  onCollapse,
}: {
  team: TeamView
  /** The conversation on screen: the workspace belongs to it, not to the team. */
  conversationId: string | undefined
  /** That conversation's workspace root, shown in the panel header. */
  workspacePath: string | undefined
  refreshSignal: number
  onCollapse: () => void
}): JSX.Element {
  const [activeTab, setActiveTab] = useState<'files' | 'changes'>('files')
  const [entries, setEntries] = useState<WorkspaceEntryView[]>([])
  const [gitStatus, setGitStatus] = useState<WorkspaceGitStatusView>()
  const [diffTarget, setDiffTarget] = useState<WorkspaceDiffTarget>()
  const [fileError, setFileError] = useState<string>()
  const [gitError, setGitError] = useState<string>()
  const [fileRefreshing, setFileRefreshing] = useState(false)
  const [gitRefreshing, setGitRefreshing] = useState(false)
  const [treeRefreshToken, setTreeRefreshToken] = useState(0)
  const fileLoadGeneration = useRef(0)
  const gitLoadGeneration = useRef(0)

  const loadFiles = useCallback(async (): Promise<void> => {
    const generation = ++fileLoadGeneration.current
    setFileRefreshing(true)
    try {
      const next = await callAgentTeam('team.workspace.list', {
        teamId: team.id,
        ...(conversationId === undefined ? {} : { conversationId }),
      })
      if (generation !== fileLoadGeneration.current) return
      setEntries(next)
      setTreeRefreshToken(current => current + 1)
      setFileError(undefined)
    } catch (cause) {
      if (generation !== fileLoadGeneration.current) return
      setFileError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (generation === fileLoadGeneration.current) setFileRefreshing(false)
    }
  }, [conversationId, team.id])

  const loadChanges = useCallback(async (): Promise<void> => {
    const generation = ++gitLoadGeneration.current
    setGitRefreshing(true)
    try {
      const next = await callAgentTeam('team.workspace.changes', {
        teamId: team.id,
        ...(conversationId === undefined ? {} : { conversationId }),
      })
      if (generation !== gitLoadGeneration.current) return
      setGitStatus(next)
      setGitError(undefined)
    } catch (cause) {
      if (generation !== gitLoadGeneration.current) return
      setGitError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (generation === gitLoadGeneration.current) setGitRefreshing(false)
    }
  }, [conversationId, team.id])

  const load = useCallback(async (): Promise<void> => {
    await Promise.allSettled([loadFiles(), loadChanges()])
  }, [loadChanges, loadFiles])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (refreshSignal === 0) return
    const timer = setTimeout(() => { void load() }, 600)
    return () => { clearTimeout(timer) }
  }, [load, refreshSignal])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = subscribeAgentTeamWorkspace(team.id, () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => { void load() }, 250)
    }, () => {})
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe()
    }
  }, [load, team.id])

  const refreshing = fileRefreshing || gitRefreshing
  return (
    <>
      <aside className={css.workspacePanel}>
        <div className={css.workspaceHeader}>
          <div><strong>Workspace</strong><span>{workspacePath ?? '未选择 Workspace'}</span></div>
          <div className={css.workspaceHeaderActions}>
            <Tooltip label={refreshing ? '刷新中…' : '刷新 Workspace'} side="bottom" delayMs={400}>
              <button
                type="button"
                className={`${css.workspaceRefreshButton} ${refreshing ? css.workspaceRefreshButtonBusy : ''}`}
                disabled={refreshing}
                aria-label={refreshing ? '正在刷新 Workspace' : '刷新 Workspace'}
                onClick={() => { void load() }}
              >
                <IconRefreshOutline16 size={16} />
              </button>
            </Tooltip>
            <Tooltip label="收起 Workspace" side="bottom" delayMs={400}>
              <button
                type="button"
                className={css.workspaceRefreshButton}
                aria-label="收起 Workspace"
                onClick={onCollapse}
              >
                <IconChevronRightOutline14 size={14} />
              </button>
            </Tooltip>
          </div>
        </div>
        <div className={css.workspaceTabs} role="tablist" aria-label="Workspace 视图">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'files'}
            className={activeTab === 'files' ? css.workspaceTabActive : ''}
            onClick={() => { setActiveTab('files') }}
          >文件</button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'changes'}
            className={activeTab === 'changes' ? css.workspaceTabActive : ''}
            onClick={() => { setActiveTab('changes') }}
          >
            变更
            {gitStatus?.state === 'repository' && gitStatus.changes.length > 0
              ? <span>{gitStatus.changes.length}</span>
              : null}
          </button>
        </div>
        <div className={css.workspaceContent}>
          {activeTab === 'files' ? (
            <div className={css.fileTree}>
              {entries.map(entry => (
                <WorkspaceTreeRow
                  key={entry.path}
                  teamId={team.id}
                  conversationId={conversationId}
                  entry={entry}
                  depth={0}
                  refreshToken={treeRefreshToken}
                />
              ))}
              {entries.length === 0 && !fileError && (
                <span className={css.fileEmpty}>{fileRefreshing ? '正在读取目录…' : '目录为空'}</span>
              )}
              {fileError && <span className={css.fileError}>{fileError}</span>}
            </div>
          ) : (
            <WorkspaceChanges
              status={gitStatus}
              error={gitError}
              refreshing={gitRefreshing}
              onOpenDiff={setDiffTarget}
            />
          )}
        </div>
      </aside>
      <WorkspaceDiffDialog
        teamId={team.id}
        conversationId={conversationId}
        target={diffTarget}
        onClose={() => { setDiffTarget(undefined) }}
      />
    </>
  )
}

