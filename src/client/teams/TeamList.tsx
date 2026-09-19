import { Button, IconAgentPresetOutline16, IconChevronLeftOutline14, IconCloseOutline16, IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamView } from '../../transport/contracts.js'
import css from '../AgentTeam.module.css'
import { orderedMembers } from '../../domain/team-selectors.js'
import { agoLabel } from '../native-locale.js'
import { openTeam } from '../store.js'

export function TeamList({ teams, now }: { teams: TeamView[]; now: number }): JSX.Element {
  return (
    <div className={css.teamList}>
      <div className={css.teamListHeader}>
        <span>团队</span>
        <span>队长</span>
        <span>成员</span>
        <span>更新时间</span>
      </div>
      {teams.map(team => {
        const members = orderedMembers(team)
        const leader = team.members[team.leaderSlotId]
        return (
          <button
            key={team.id}
            type="button"
            className={css.teamListRow}
            aria-label={`打开团队「${team.name}」`}
            onClick={() => { openTeam(team.id) }}
          >
            <span className={css.teamListIdentity}>
              <span className={css.teamListIcon} aria-hidden="true">
                <IconAgentPresetOutline16 size={18} />
              </span>
              <span className={css.teamListCopy}>
                <span className={css.teamListName}>{team.name}</span>
              </span>
            </span>
            <span className={css.teamListPerson}>
              {leader === undefined
                ? <span className={css.teamListMuted}>暂无 Leader</span>
                : <>
                    <span className={css.teamListAvatar}>{leader.displayName.slice(0, 1).toUpperCase()}</span>
                    <span className={css.teamListPersonName} title={leader.displayName}>{leader.displayName}</span>
                  </>}
            </span>
            <span className={css.teamListRoster}>
              {members.slice(0, 4).map(member => (
                <span key={member.id} className={css.teamListAvatar} title={member.displayName}>
                  {member.displayName.slice(0, 1).toUpperCase()}
                </span>
              ))}
              {members.length > 4 && <span className={css.teamListMuted}>+{members.length - 4}</span>}
            </span>
            <span className={css.teamListTime}>{agoLabel(team.updatedAt, now)}</span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * One team's own page: a summary card beside the member roster and the team's
 * lifecycle actions. `compact` drops the page chrome for the workbench's
 * management dialog, which shows the same surface inline.
 */
