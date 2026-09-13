import { useCallback, useEffect, useState } from 'react'
import {
  IconAgentPresetOutline16,
  IconChevronDownOutline14,
  Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam, subscribeAgentTeam } from '../api.js'
import {
  TEAM_SWITCH_DELEGATE,
  TEAM_SWITCH_UNBIND,
  delegatedInteractions,
  teamSwitchLabel,
  teamSwitchMenu,
} from '../composer-team-menu.js'
import { cachedBinding, cacheBinding } from '../view-cache.js'
import css from '../AgentTeam.module.css'
import type { SessionBindingView, TeamView } from '../../transport/contracts.js'

/**
 * The team switch, beside the model selector.
 *
 * A team is enabled per Session — that Session's own Agent becomes the Leader —
 * and the 团队 view is where its workbench shows. Making the reader open that
 * tab to start a team turned the common case (start the team, then talk to it)
 * into two steps and a round trip, so the same decision sits in the composer
 * tool row, left of the model selector.
 */
export function ComposerTeamControl({ sessionId }: { sessionId: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [teams, setTeams] = useState<TeamView[]>([])
  const [binding, setBinding] = useState<SessionBindingView | undefined>(() => cachedBinding(sessionId))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  // A cached binding paints the reader's own Session on the first frame.
  const refresh = useCallback(async () => {
    try {
      const [list, current] = await Promise.all([
        callAgentTeam('team.list'),
        callAgentTeam('team.session.get', { sessionId }),
      ])
      setTeams(list.items)
      cacheBinding(current)
      setBinding(current)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sessionId])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(
    () => subscribeAgentTeam(
      kinds => {
        // A binding moves only with the teams themselves; a streamed member
        // turn never does.
        if ([...kinds].some(kind => kind === 'team' || kind === 'conversation')) void refresh()
      },
      () => undefined,
    ),
    [refresh],
  )

  async function enable(teamId: string): Promise<void> {
    setBusy(true)
    try {
      const next = await callAgentTeam('team.session.bind', { sessionId, teamId })
      cacheBinding(next)
      setBinding(next)
      setOpen(false)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function disable(): Promise<void> {
    setBusy(true)
    try {
      await callAgentTeam('team.session.unbind', { sessionId })
      cacheBinding({ sessionId })
      setBinding(undefined)
      setOpen(false)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  /** Turn «替我审批» on or off; the menu stays open so the check is visible. */
  async function delegate(next: boolean): Promise<void> {
    setBusy(true)
    try {
      const updated = await callAgentTeam('team.session.delegate', { sessionId, delegate: next })
      cacheBinding(updated)
      setBinding(updated)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const label = teamSwitchLabel(binding)
  const delegated = delegatedInteractions(binding)
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={teamSwitchMenu(teams, binding, { busy, error })}
      selectedIds={[
        ...(binding?.team === undefined ? [] : [binding.team.id]),
        ...(delegated ? [TEAM_SWITCH_DELEGATE] : []),
      ]}
      onSelect={id => {
        if (id === TEAM_SWITCH_UNBIND) void disable()
        else if (id === TEAM_SWITCH_DELEGATE) void delegate(!delegated)
        else void enable(id)
      }}
      align="end"
      side="top"
      portal
      compact
      anchor={(
        <button
          type="button"
          className={css.composerTeamTrigger}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={label}
          title={binding?.team === undefined ? '在会话的「团队」标签里启用团队' : `本会话已启用「${binding.team.name}」`}
          disabled={busy}
          onMouseDown={event => { event.preventDefault() }}
          onClick={() => { setOpen(value => !value) }}
        >
          <IconAgentPresetOutline16 size={14} />
          <span className={css.composerTeamLabel}>{label}</span>
          <IconChevronDownOutline14 className={css.composerTeamChevron} />
        </button>
      )}
    />
  )
}
