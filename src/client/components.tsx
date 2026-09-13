import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  IconAgentPresetOutline16,
  IconChevronLeftOutline14,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { AssistantPanel } from './assistants/AssistantPanel.js'
import {
  callAgentTeam,
  subscribeAgentTeam,
} from './api.js'
import {
  openTeams,
  showTeamPage,
  useAgentTeamUi,
} from './store.js'
import { isTeamExecuting } from './team-status.js'
import { TeamPanel } from './teams/TeamPanel.js'
import { cacheCatalog, cachedCatalog } from './view-cache.js'
import css from './AgentTeam.module.css'
import type {
  AssistantView,
  CatalogView,
  TeamView,
} from '../transport/contracts.js'


/** Sidebar-foot entry that opens the team management page. */
export function AgentTeamSidebarAction({ wide, usePanelInfo }: {
  wide: boolean
  /** Framework standard hook over the frame's selected main panel. */
  usePanelInfo: <S>(selector: (state: { activePanelId: string | null }) => S) => S
}): JSX.Element {
  const open = usePanelInfo(state => state.activePanelId === 'agent-team')
  const [hasExecutingTeam, setHasExecutingTeam] = useState(false)
  useEffect(() => {
    const load = (): void => {
      void callAgentTeam('team.list')
        .then(value => { setHasExecutingTeam(value.items.some(isTeamExecuting)) })
        .catch(() => undefined)
    }
    load()
    return subscribeAgentTeam(
      kinds => {
        if ([...kinds].some(kind => kind === 'team' || kind === 'conversation')) load()
      },
      () => undefined,
    )
  }, [])

  return (
    <button
      type="button"
      className={`${css.sidebarAction} ${wide ? '' : css.sidebarActionRail}`}
      onClick={showTeamPage}
      aria-pressed={open}
      aria-label={hasExecutingTeam ? '打开团队管理，有团队正在执行任务' : '打开团队管理'}
      title="dsh-squad"
    >
      <span className={css.sidebarActionIcon}>
        <IconAgentPresetOutline16 size={18} />
        {hasExecutingTeam && <span className={css.sidebarActionDot} aria-hidden="true" />}
      </span>
      {wide && <span className={css.sidebarActionLabel}>团队</span>}
    </button>
  )
}

/**
 * Which data a change kind can affect. Anything else (a member's streamed
 * conversation, a workspace watcher tick) leaves the catalog, the assistant
 * library and the team list exactly as they were.
 */
function reloadsAssistants(kind: string): boolean {
  return kind === 'assistant' || kind === 'rule-document'
}

function reloadsTeams(kind: string): boolean {
  return kind === 'team' || kind === 'conversation'
}

export function useAgentTeamData(includeTeams: boolean, active = true): {
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  teams: TeamView[]
  loading: boolean
  error: string | undefined
  load: (kinds?: ReadonlySet<string>) => Promise<void>
} {
  const [catalog, setCatalog] = useState<CatalogView | undefined>(() => cachedCatalog())
  const [assistants, setAssistants] = useState<AssistantView[]>([])
  const [teams, setTeams] = useState<TeamView[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()

  /**
   * Read the team library, or only the parts one change burst can touch.
   *
   * A background refresh never reports: it keeps whatever was last read, since
   * the event stream already reports a lost connection and a stale row is
   * better than replacing the page with an error. The full load owns the
   * screen, so it does report.
   */
  const load = useCallback(async (kinds?: ReadonlySet<string>): Promise<void> => {
    const full = kinds === undefined
    const wantCatalog = full || kinds.has('catalog')
    const wantAssistants = full || [...kinds].some(reloadsAssistants)
    const wantTeams = includeTeams && (full || [...kinds].some(reloadsTeams))
    if (full) {
      setLoading(true)
      setError(undefined)
    }
    const failures: string[] = []
    const report = (cause: unknown): void => {
      failures.push(cause instanceof Error ? cause.message : String(cause))
    }
    const requests: Array<Promise<void>> = []
    if (wantCatalog) {
      requests.push(callAgentTeam('catalog.get').then(value => {
        cacheCatalog(value)
        setCatalog(value)
      }, report))
    }
    if (wantAssistants) {
      requests.push(callAgentTeam('assistant.list').then(value => { setAssistants(value.items) }, report))
    }
    if (wantTeams) {
      requests.push(callAgentTeam('team.list').then(value => { setTeams(value.items) }, report))
    } else if (full && !includeTeams) {
      setTeams([])
    }
    await Promise.all(requests)
    if (full) {
      if (failures.length > 0) setError(failures.join('；'))
      setLoading(false)
    }
  }, [includeTeams])

  useEffect(() => {
    if (!active) return
    void load()
    return subscribeAgentTeam(
      kinds => { void load(kinds) },
      () => { setError('事件连接已断开，正在等待重连') },
    )
  }, [active, load])

  return { catalog, assistants, teams, loading, error, load }
}

export function AgentTeamSettingsSection(_props: SettingsSectionOwnerProps): JSX.Element {
  const { catalog, assistants, loading, error, load } = useAgentTeamData(false)
  return (
    <section className={css.settingsSection}>
      <div className={css.settingsHeading}>
        <div>
          <h1 className={css.settingsTitle}>dsh-squad</h1>
          <p className={css.settingsDescription}>管理可在不同团队间复用的助手、模型和权限配置。</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => { void load() }} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </Button>
      </div>
      {error && <div role="alert" className={css.error}>{error}</div>}
      <AssistantPanel catalog={catalog} assistants={assistants} onChanged={load} />
    </section>
  )
}

/**
 * The team management page: a main panel of the frame.
 *
 * It owns the global side of the feature — the team list, the team detail page
 * and the assistant library. A team no longer has Sessions of its own: it is
 * enabled in a Harness Session, and that Session's own 团队 view is where its
 * meeting room and member columns live.
 */
export function AgentTeamPanel(): JSX.Element {
  const { selectedTeamId } = useAgentTeamUi()
  const { catalog, assistants, teams, error, load } = useAgentTeamData(true)
  const selectedTeam = teams.find(team => team.id === selectedTeamId)
  const headerTitle = selectedTeam?.name ?? 'dsh-squad'

  return (
    <section className={css.panel} aria-label="dsh-squad">
      <header className={css.shellHeader}>
        {selectedTeamId !== undefined && (
          <button
            type="button"
            className={css.panelBack}
            onClick={() => { openTeams() }}
            aria-label="返回团队列表"
            title="返回团队列表"
          >
            <IconChevronLeftOutline14 size={16} />
            返回
          </button>
        )}
        <div className={css.headerCopy}>
          <div className={css.shellTitleRow}>
            <h1 className={css.title} title={headerTitle}>{headerTitle}</h1>
            {selectedTeam !== undefined && isTeamExecuting(selectedTeam) && (
              <Tag tone="success">任务执行中</Tag>
            )}
          </div>
          <p className={css.subtitle}>团队在会话的「团队」标签里启用和运行</p>
        </div>
      </header>
      {error !== undefined && <div role="alert" className={css.error}>{error}</div>}
      <main className={css.panelBody}>
        <TeamPanel
          catalog={catalog}
          assistants={assistants}
          teams={teams}
          selectedTeamId={selectedTeamId}
          onChanged={load}
        />
      </main>
    </section>
  )
}
