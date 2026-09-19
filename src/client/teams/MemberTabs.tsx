import {
  IconCloseOutline16,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MemberConversationView, TeamView } from '../../transport/contracts.js'
import css from '../AgentTeam.module.css'
import { CrownIcon } from '../icons/CrownIcon.js'
import { runtimeStateDot } from '../team-status.js'

/**
 * One tab per member of the team.
 *
 * The tab has to carry what a reader needs without opening anything: that this
 * one is the Leader, that this one is waiting on an answer or an approval, and
 * what it is doing right now. The remove action sits on the tab because that is
 * where a member is — but never on the Leader, whose slot the team cannot do
 * without.
 */
export function MemberTabs({
  members,
  conversations,
  selectedSlotId,
  onPick,
  onRemove,
}: {
  members: readonly TeamView['members'][string][]
  conversations: Map<string, MemberConversationView>
  /** The member being looked at alone, when there is one. */
  selectedSlotId: string | undefined
  onPick: (slotId: string) => void
  onRemove: (member: TeamView['members'][string]) => void
}): JSX.Element {
  return (
    <>
      {members.map(member => {
        const conversation = conversations.get(member.id)
        const selected = selectedSlotId === member.id
        return (
          <span key={member.id} className={css.memberTabWrap}>
            <button
              type="button"
              className={`${css.memberTab} ${member.role === 'leader' ? '' : css.memberTabWithActions} ${selected ? css.memberTabActive : ''}`}
              title={selected ? '显示全部成员' : `只看 ${member.displayName}`}
              onClick={() => { onPick(member.id) }}
              aria-pressed={selected}
            >
              <span className={css.memberAvatar}>{member.displayName.slice(0, 1).toUpperCase()}</span>
              <span className={css.memberTabName}>{member.displayName}</span>
              {member.role === 'leader' && <CrownIcon size={15} className={css.leaderCrown} title="Leader" />}
              {(conversation?.pendingInteractions.length ?? 0) > 0
                && <span className={css.memberTabAlert} title="该成员在等你的回答或审批">!</span>}
              <StateDot state={runtimeStateDot(conversation?.status ?? 'idle')} size={8} />
            </button>
            {member.role !== 'leader' && (
              <span className={css.memberTabActions}>
                <button
                  type="button"
                  className={css.memberTabRemoveAction}
                  title={`移出成员 ${member.displayName}`}
                  aria-label={`移出成员 ${member.displayName}`}
                  onClick={() => { onRemove(member) }}
                >
                  <IconCloseOutline16 size={12} />
                </button>
              </span>
            )}
          </span>
        )
      })}
    </>
  )
}
