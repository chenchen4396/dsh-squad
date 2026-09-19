import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, IconAgentPresetOutline16, IconChevronLeftOutline14, IconCloseOutline16, IconPlusOutline16, StateDot, Tag, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AssistantView,
  CatalogView,
  ConversationView,
  MemberConversationView,
  TeamView,
} from '../../transport/contracts.js'
import { callAgentTeam, subscribeAgentTeamConversation } from '../api.js'
import css from '../AgentTeam.module.css'
import { orderedMembers } from '../../domain/team-selectors.js'
import { assistantForMember } from '../member-assistant.js'
import { AddTeamMemberDialog, CloneTeamDialog } from './TeamDialogs.js'
import { mergeMemberConversation, mergeWorkbenchLoad, prependMemberPage } from '../conversation-nodes.js'
import { CrownIcon } from '../icons/CrownIcon.js'
import { memberStatusLabel, modelDisplayName } from '../labels.js'
import { agoLabel } from '../native-locale.js'
import { AnimatedModal } from '../shared.js'
import { openMemberSession, openTeam, setMemberComposerTarget } from '../store.js'
import { isTeamExecuting, runtimeStateDot } from '../team-status.js'

export function TeamDetail({
  team,
  catalog,
  assistants,
  onChanged,
  onBack,
  compact = false,
}: {
  team: TeamView
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  onChanged: () => Promise<void>
  onBack?: () => void
  compact?: boolean
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [addingMember, setAddingMember] = useState(false)
  const [cloneOpen, setCloneOpen] = useState(false)
  const [dissolveOpen, setDissolveOpen] = useState(false)
  const [memberToRemove, setMemberToRemove] = useState<{ slotId: string; displayName: string }>()
  const [error, setError] = useState<string>()
  const members = orderedMembers(team)
  const leader = team.members[team.leaderSlotId]
  const executing = isTeamExecuting(team)
  const now = Date.now()

  async function dissolve(): Promise<void> {
    setBusy(true)
    try {
      await callAgentTeam('team.dissolve', { teamId: team.id, confirmation: team.name })
      setDissolveOpen(false)
      setError(undefined)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function removeMember(): Promise<void> {
    if (memberToRemove === undefined) return
    setBusy(true)
    try {
      await callAgentTeam('team.removeMember', {
        teamId: team.id,
        slotId: memberToRemove.slotId,
      }, team.revision)
      setMemberToRemove(undefined)
      setError(undefined)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function changeLeader(successorSlotId: string): Promise<void> {
    if (successorSlotId === team.leaderSlotId) return
    setBusy(true)
    try {
      await callAgentTeam('team.changeLeader', {
        teamId: team.id,
        successorSlotId,
      }, team.revision)
      setError(undefined)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={compact ? css.teamDetailCompact : css.teamDetailPage}>
      {!compact && (
        <div className={css.teamDetailBar}>
          <nav className={css.teamBreadcrumb} aria-label="团队位置">
            <button type="button" className={css.teamBreadcrumbLink} onClick={() => { onBack?.() }}>
              团队
            </button>
            <span className={css.teamBreadcrumbSeparator} aria-hidden="true">/</span>
            <strong className={css.teamBreadcrumbCurrent} title={team.name}>{team.name}</strong>
            {executing && <Tag tone="success">任务执行中</Tag>}
          </nav>
          <div className={css.teamDetailBarActions}>
            <Button
              variant="outline"
              className={css.dangerAction}
              disabled={busy || team.state === 'deleting'}
              onClick={() => {
                setError(undefined)
                setDissolveOpen(true)
              }}
            >
              {team.state === 'deleting' ? '解散中…' : team.state === 'delete_blocked' ? '重试解散' : '解散团队'}
            </Button>
          </div>
        </div>
      )}

      <div className={css.teamDetailBody}>
        <aside className={css.teamSummaryCard}>
          <span className={css.teamSummaryIcon} aria-hidden="true">
            <IconAgentPresetOutline16 size={26} />
          </span>
          <strong className={css.teamSummaryName} title={team.name}>{team.name}</strong>
          <span className={css.teamSummarySub}>{members.length} 名成员</span>
          <span className={css.teamSummaryDivider} aria-hidden="true" />
          <span className={css.teamSummaryLabel}>详情</span>
          <dl className={css.teamSummaryRows}>
            <div className={css.teamSummaryRow}>
              <dt>队长</dt>
              <dd title={leader?.displayName}>{leader?.displayName ?? '暂无'}</dd>
            </div>
            <div className={css.teamSummaryRow}>
              <dt>成员</dt>
              <dd>{members.length}</dd>
            </div>
            <div className={css.teamSummaryRow}>
              <dt>创建时间</dt>
              <dd>{agoLabel(team.createdAt, now)}</dd>
            </div>
            <div className={css.teamSummaryRow}>
              <dt>更新时间</dt>
              <dd>{agoLabel(team.updatedAt, now)}</dd>
            </div>
          </dl>
        </aside>

        <section className={css.teamMemberPanel} aria-label="团队成员">
          <header className={css.teamMemberPanelHeader}>
            <div>
              <strong className={css.teamMemberPanelTitle}>成员</strong>
              <p className={css.teamMemberPanelHint}>该团队有 {members.length} 名成员</p>
            </div>
            <div className={css.teamMemberPanelActions}>
              <Button variant="outline" disabled={busy} onClick={() => { setAddingMember(true) }}>
                <IconPlusOutline16 size={14} />
                添加成员
              </Button>
            </div>
          </header>
          <ul className={css.teamMemberList}>
            {members.map(member => {
              const assistant = assistantForMember(assistants, member)
              return (
                <li key={member.id} className={css.teamMemberRow}>
                  <span className={css.teamMemberAvatar}>
                    {member.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <span className={css.teamMemberInfo}>
                    <span className={css.teamMemberTitle}>
                      <strong className={css.teamMemberName} title={member.displayName}>
                        {member.displayName}
                      </strong>
                      {member.role === 'leader' && (
                        <Tag tone="warning">
                          <CrownIcon size={12} title="Leader" />
                          队长
                        </Tag>
                      )}
                      <span className={css.teamMemberStatus}>
                        <StateDot state={runtimeStateDot(member.lastRuntimeState)} size={8} />
                        {memberStatusLabel(member.lastRuntimeState)}
                      </span>
                    </span>
                    <span
                      className={css.teamMemberMeta}
                      title={assistant === undefined
                        ? '助手不可用'
                        : `${assistant.provider} / ${assistant.model}`}
                    >
                      {member.id === team.leaderSlotId
                        ? '本会话 Agent'
                        : assistant === undefined
                          ? '助手不可用'
                          : modelDisplayName(catalog?.models, assistant.provider, assistant.model)}
                    </span>
                    <span className={css.teamMemberMeta}>加入于 {agoLabel(member.joinedAt, now)}</span>
                  </span>
                  <span className={css.teamMemberRowActions}>
                    {member.id !== team.leaderSlotId && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => { void changeLeader(member.id) }}
                        >
                          设为 Leader
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className={css.dangerAction}
                          disabled={busy}
                          onClick={() => {
                            setError(undefined)
                            setMemberToRemove({ slotId: member.id, displayName: member.displayName })
                          }}
                        >
                          移出
                        </Button>
                      </>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
          <div className={`${css.contextResetPanel} ${css.cloneTeamPanel ?? ''}`}>
            <div className={css.contextResetCopy}>
              <strong>复制团队</strong>
              <span>复用当前成员和配置，为所有成员创建全新 Session。</span>
            </div>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setError(undefined)
                setCloneOpen(true)
              }}
            >
              复制团队
            </Button>
          </div>
          {error && !dissolveOpen && memberToRemove === undefined && (
            <div role="alert" className={css.inlineError}>{error}</div>
          )}
        </section>
      </div>

      <AddTeamMemberDialog
        open={addingMember}
        team={team}
        catalog={catalog}
        assistants={assistants}
        onClose={() => { setAddingMember(false) }}
        onChanged={onChanged}
      />
      <CloneTeamDialog
        open={cloneOpen}
        team={team}
        assistants={assistants}
        onClose={() => { setCloneOpen(false) }}
        onCreated={async () => {
          await onChanged()
        }}
      />
      <AnimatedModal
        open={memberToRemove !== undefined}
        onClose={() => {
          if (busy) return
          setMemberToRemove(undefined)
          setError(undefined)
        }}
        title="移出团队成员"
        closeLabel="关闭"
        description="该成员将停止参与当前团队。"
        className={css.memberRemoveDialog ?? ''}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setMemberToRemove(undefined)
                setError(undefined)
              }}
            >
              取消
            </Button>
            <Button
              variant="outline"
              className={css.dangerAction}
              disabled={busy}
              onClick={() => { void removeMember() }}
            >
              {busy ? '移出中…' : '确认移出'}
            </Button>
          </>
        )}
      >
        <div className={css.memberRemoveConfirm}>
          <div className={css.memberRemoveIcon} aria-hidden="true">−</div>
          <div>
            <strong>确定移出“{memberToRemove?.displayName}”？</strong>
            <p>该成员将停止参与团队；若仍有未完成任务，系统会阻止移出。助手模板和 Session 历史都会保留。</p>
          </div>
          {error && <div role="alert" className={css.inlineError}>{error}</div>}
        </div>
      </AnimatedModal>
      <AnimatedModal
        open={dissolveOpen}
        onClose={() => {
          if (busy) return
          setDissolveOpen(false)
          setError(undefined)
        }}
        title="解散团队"
        closeLabel="关闭"
        description="此操作无法撤销。"
        className={css.teamDissolveDialog ?? ''}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDissolveOpen(false)
                setError(undefined)
              }}
            >
              取消
            </Button>
            <Button
              variant="outline"
              className={css.dangerAction}
              disabled={busy}
              onClick={() => { void dissolve() }}
            >
              {busy ? '解散中…' : '确认解散'}
            </Button>
          </>
        )}
      >
        <div className={css.teamDissolveConfirm}>
          <div className={css.teamDissolveIcon} aria-hidden="true">!</div>
          <div>
            <strong>确定解散“{team.name}”？</strong>
            <p>所有成员将停止，团队任务、消息和配置会被永久删除。助手模板与 Workspace 文件会保留。</p>
          </div>
          {error && <div role="alert" className={css.inlineError}>{error}</div>}
        </div>
      </AnimatedModal>
    </div>
  )
}

