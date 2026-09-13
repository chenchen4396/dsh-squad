import { useCallback, useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam, subscribeAgentTeam } from '../api.js'
import { useAgentTeamData } from '../components.js'
import { openTeams } from '../store.js'
import { cachedBinding, cacheBinding } from '../view-cache.js'
import { isTeamExecuting } from '../team-status.js'
import { TeamWorkbench } from '../teams/TeamPanel.js'
import css from '../AgentTeam.module.css'
import type { SessionBindingView } from '../../transport/contracts.js'

/**
 * The 团队 view of one Harness conversation.
 *
 * A team is enabled per Session: that Session's own Agent is the Leader and the
 * other members run as its subagents. With no team enabled this view offers the
 * teams to enable; once one is enabled it renders the team's workbench —
 * meeting room, member columns and the shared Workspace.
 *
 * Both roots carry `data-conversation-composer-overlay`: this view is not the
 * transcript, so the Harness hides its transcript width handles here — exactly
 * what the built-in Trajectory view does with the same marker. The content
 * stays centred at the Harness's own content width instead of being draggable.
 */
export function AgentTeamSessionView({ sessionId }: { sessionId: string }): JSX.Element {
  const { catalog, assistants, teams, error, load } = useAgentTeamData(true)
  // Paint what the reader saw last time on the first frame; the read below
  // refreshes it. A cache hit is what keeps re-opening the tab instant.
  const [binding, setBinding] = useState<SessionBindingView | undefined>(() => cachedBinding(sessionId))
  const [loading, setLoading] = useState(() => cachedBinding(sessionId) === undefined)
  const [actionError, setActionError] = useState<string>()

  const refresh = useCallback(async () => {
    try {
      const next = await callAgentTeam('team.session.get', { sessionId })
      cacheBinding(next)
      setBinding(next)
      setActionError(undefined)
    } catch (cause) {
      // A binding this view already read stays on screen: a busy Host dropping
      // one read must not blank the workbench. Only a first read has nothing
      // to keep, so only that one reports.
      setBinding(current => {
        if (current === undefined) {
          setActionError(cause instanceof Error ? cause.message : String(cause))
        }
        return current
      })
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(
    () => subscribeAgentTeam(
      kinds => {
        // Only the binding's own owner can change it. A streamed member turn
        // publishes on the conversation channel many times a second, and it
        // never changes which team this Session has enabled — re-reading the
        // binding for it put a request behind every streamed frame.
        if ([...kinds].some(kind => kind === 'team')) void refresh()
      },
      () => undefined,
    ),
    [refresh],
  )

  async function enable(teamId: string): Promise<void> {
    try {
      const next = await callAgentTeam('team.session.bind', { sessionId, teamId })
      cacheBinding(next)
      setBinding(next)
      setActionError(undefined)
      await load()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
      throw cause
    }
  }

  async function disable(): Promise<void> {
    try {
      await callAgentTeam('team.session.unbind', { sessionId })
      cacheBinding({ sessionId })
      setBinding(undefined)
      setActionError(undefined)
      await load()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
      throw cause
    }
  }

  const boundTeam = binding?.team
  const boundConversation = binding?.conversation
  /**
   * A first read that failed has nothing on screen to keep, so the view offers
   * the read again: a Host busy enough to drop one request is usually busy for
   * seconds, not forever.
   */
  const retryable = binding === undefined && actionError !== undefined
  const message = retryable ? error : actionError ?? error
  const retry = retryable && (
    <div className={css.errorRead}>
      <span>{actionError}</span>
      <Button variant="outline" size="sm" onClick={() => { void refresh() }}>重试</Button>
    </div>
  )

  if (boundTeam !== undefined && boundConversation !== undefined) {
    return (
      <div className={css.sessionView} data-conversation-composer-overlay="">
        <header className={css.sessionViewHeader}>
          <div className={css.sessionViewCopy}>
            <strong className={css.sessionViewTitle} title={boundTeam.name}>{boundTeam.name}</strong>
            <span className={css.sessionViewSubtitle}>
              {Object.keys(boundTeam.members).length} 名成员 · 会话自身的 Agent 是 Leader
            </span>
          </div>
          <Button
            variant="outline"
            onClick={() => { void disable().catch(() => undefined) }}
          >
            停用团队
          </Button>
        </header>
        {message !== undefined && <div role="alert" className={css.error}>{message}</div>}
        <div className={css.sessionViewBody}>
          <TeamWorkbench
            key={boundConversation.id}
            team={boundTeam}
            conversationId={boundConversation.id}
            catalog={catalog}
            assistants={assistants}
            permissionPresets={catalog?.permissionPresets ?? []}
            onChanged={async () => { await load(); await refresh() }}
          />
        </div>
      </div>
    )
  }

  return (
    <div className={css.sessionView} data-conversation-composer-overlay="">
      <header className={css.sessionViewHeader}>
        <div className={css.sessionViewCopy}>
          <strong className={css.sessionViewTitle}>团队</strong>
          <span className={css.sessionViewSubtitle}>
            为这个会话启用一个团队：会话自身的 Agent 会成为 Leader，其他成员作为它的子 agent 运行。
          </span>
        </div>
        <Button variant="outline" onClick={() => { openTeams() }}>管理团队</Button>
      </header>
      {retry}
      {message !== undefined && <div role="alert" className={css.error}>{message}</div>}
      <div className={css.sessionViewBody}>
        {loading
          ? <div className={css.sessionViewEmpty}>正在读取…</div>
          : teams.length === 0
            ? (
              <div className={css.sessionViewEmpty}>
                <p>还没有团队。</p>
                <p>先在「管理团队」里创建助手和团队，再回到这里启用。</p>
              </div>
            )
            : (
              <ul className={css.sessionTeamList}>
                {teams.map(team => (
                  <li key={team.id} className={css.sessionTeamRow}>
                    <div className={css.sessionTeamCopy}>
                      <strong>{team.name}</strong>
                      <span>
                        {Object.keys(team.members).length} 名成员
                        {isTeamExecuting(team) ? ' · 任务执行中' : ''}
                      </span>
                    </div>
                    <Button
                      variant="primary"
                      disabled={team.members[team.leaderSlotId] === undefined}
                      onClick={() => { void enable(team.id).catch(() => undefined) }}
                    >
                      启用
                    </Button>
                  </li>
                ))}
              </ul>
            )}
      </div>
    </div>
  )
}
