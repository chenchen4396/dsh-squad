import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, IconAgentPresetOutline16, IconChevronLeftOutline14, IconCloseOutline16, IconPlusOutline16, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AssistantView,
  CatalogView,
  ConversationView,
  MemberConversationView,
  TeamView,
  TeamWorkbenchView,
} from '../../transport/contracts.js'
import { callAgentTeam, subscribeAgentTeamConversation } from '../api.js'
import css from '../AgentTeam.module.css'
import { orderedMembers } from '../../domain/team-selectors.js'
import { MemberColumn } from './MemberColumn.js'
import { TaskFlowChart } from './TaskFlowChart.js'
import { AddTeamMemberDialog, CloneTeamDialog } from './TeamDialogs.js'
import { CrownIcon } from '../icons/CrownIcon.js'
import { TeamDetail } from './TeamDetail.js'
import { mergeMemberConversation, mergeWorkbenchLoad, prependMemberPage } from '../conversation-nodes.js'
import { memberStatusLabel } from '../labels.js'
import { visibleMemberSlots } from '../member-visibility.js'
import { pendingActionsOf } from '../pending-actions.js'
import { cachedWorkbench, cacheWorkbench } from '../view-cache.js'
import { AnimatedModal } from '../shared.js'
import { openTeams, setMemberComposerTarget } from '../store.js'
import { isTeamExecuting, runtimeStateDot } from '../team-status.js'
import { MeetingRoom } from '../workbench/MeetingRoom.js'
import { WorkspacePanel } from '../workspace/WorkspacePanel.js'

export function TeamWorkbench({
  team,
  conversationId,
  catalog,
  assistants,
  permissionPresets,
  onChanged,
}: {
  team: TeamView
  /** Binding this workbench shows; the Session's own conversation. */
  conversationId: string
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  permissionPresets: CatalogView['permissionPresets']
  onChanged: () => Promise<void>
}): JSX.Element {
  const members = orderedMembers(team)
  const memberIds = members.map(member => member.id)
  // A cached read paints the workbench the reader just left; `load` refreshes
  // it immediately, so re-opening the tab never starts on a spinner.
  const [snapshot, setSnapshot] = useState<TeamWorkbenchView | undefined>(
    () => cachedWorkbench(team.id, conversationId),
  )
  /**
   * The member whose column alone the grid shows. Undefined renders every
   * member, which is what the view opens on.
   */
  const [pickedSlotId, setPickedSlotId] = useState<string>()
  const [error, setError] = useState<string>()
  const [memberActionError, setMemberActionError] = useState<string>()
  const [memberActionBusy, setMemberActionBusy] = useState(false)
  const [memberToRemove, setMemberToRemove] = useState<TeamView['members'][string]>()
  const [managementOpen, setManagementOpen] = useState(false)
  const [addMemberOpen, setAddMemberOpen] = useState(false)
  const [expandedSlotId, setExpandedSlotId] = useState<string>()
  /**
   * The Workspace panel starts closed, the way the Harness's own right sidebar
   * does. It sits inside this view, so while it is open it takes width from the
   * message area and the room recentres in what is left: the messages then no
   * longer line up with the composer below, which belongs to the Session and does
   * not shrink with them. Closed by default keeps the team view's messages as
   * wide, and on the same axis, as any other conversation.
   */
  const [workspaceVisible, setWorkspaceVisible] = useState(false)
  const [workspaceRefreshSignal, setWorkspaceRefreshSignal] = useState(0)
  const [view, setView] = useState<'room' | 'members' | 'flow'>('room')
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>()
  const loadGeneration = useRef(0)
  /**
   * Whether a live update arrived after the current load was issued. Its body
   * is then older than what is on screen, so the streamed member conversations
   * are kept instead of being thrown away with the response.
   */
  const liveSinceLoad = useRef(false)
  /** Mirrors `conversationId` for the SSE handler without resubscribing. */
  const conversationIdRef = useRef(conversationId)
  conversationIdRef.current = conversationId

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current
    liveSinceLoad.current = false
    try {
      const next = await callAgentTeam('team.workbench.get', { id: team.id, conversationId })
      if (generation !== loadGeneration.current) return
      cacheWorkbench(next)
      setSnapshot(current => current === undefined
        ? next
        : mergeWorkbenchLoad(current, next, liveSinceLoad.current))
      liveSinceLoad.current = false
      setError(undefined)
    } catch (cause) {
      if (generation !== loadGeneration.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [team.id, conversationId])

  useEffect(() => { void load() }, [load, team.revision])
  useEffect(() => subscribeAgentTeamConversation(team.id, conversation => {
    if (conversation !== undefined) {
      // Sessions belong to one conversation, so an update for another
      // conversation must not overwrite what this view is showing.
      if (conversation.conversationId !== conversationIdRef.current) return
      // An in-flight load must still land: discarding it would leave this view
      // showing another conversation's Workspace and room.
      liveSinceLoad.current = true
      setWorkspaceRefreshSignal(current => current + 1)
      setSnapshot(current => {
        if (current === undefined) return current
        const existing = current.conversations.find(item => item.slotId === conversation.slotId)
        const merged = mergeMemberConversation(existing, conversation)
        const conversations = current.conversations.filter(item => item.slotId !== conversation.slotId)
        return { ...current, conversations: [...conversations, merged] }
      })
      setError(undefined)
      return
    }
    if (refreshTimer.current !== undefined) return
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined
      void load()
    }, 50)
  }, () => { setError('实时连接已断开，正在等待重连') }, () => {
    setError(undefined)
    void load()
  }), [load, team.id])
  useEffect(() => () => {
    if (refreshTimer.current !== undefined) clearTimeout(refreshTimer.current)
  }, [])
  useEffect(() => {
    setPickedSlotId(current => current !== undefined && team.members[current] === undefined
      ? undefined
      : current)
  }, [team.members])
  useEffect(() => {
    if (expandedSlotId !== undefined && team.members[expandedSlotId] === undefined) setExpandedSlotId(undefined)
  }, [expandedSlotId, team.members])
  useEffect(() => {
    if (expandedSlotId === undefined) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setExpandedSlotId(undefined)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => { window.removeEventListener('keydown', closeOnEscape) }
  }, [expandedSlotId])

  /**
   * Show one member's column alone, or every column again when that member is
   * already the one being shown. Picking also opens 成员视图: the tabs are that
   * grid's selector, so a pick must be visible wherever it is made.
   */
  function pickMember(slotId: string): void {
    setView('members')
    setPickedSlotId(current => current === slotId ? undefined : slotId)
  }

  async function removeMember(): Promise<void> {
    if (memberToRemove === undefined) return
    setMemberActionBusy(true)
    try {
      await callAgentTeam('team.removeMember', {
        teamId: team.id,
        slotId: memberToRemove.id,
      }, team.revision)
      setMemberToRemove(undefined)
      setMemberActionError(undefined)
      await onChanged()
      await load()
    } catch (cause) {
      setMemberActionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setMemberActionBusy(false)
    }
  }

  const conversations = new Map(snapshot?.conversations.map(item => [item.slotId, item]) ?? [])
  // A member that waits on the reader has to say so where the reader looks: the
  // room carries the request itself, and the member tab that owns it badges.
  const pendingActions = pendingActionsOf(members, conversations)
  const visibleMembers = visibleMemberSlots(memberIds, pickedSlotId)
    .map(slotId => team.members[slotId])
    .filter((value): value is TeamView['members'][string] => value !== undefined)
  // The board is conversation-scoped, exactly like the shared room.
  const conversationTasks = Object.values(team.tasks)
    .filter(task => task.conversationId === conversationId)
  const focusedMember = expandedSlotId === undefined ? undefined : team.members[expandedSlotId]
  /**
   * The member this view is addressing, when it is one.
   *
   * The Harness composer can only reach the Session's own Agent, so addressing a
   * member means lending it the composer: the plugin reports the picked member
   * here and takes the conversation's composer over for as long as it stands.
   * Picking the Leader (or leaving the member view) hands the composer back.
   */
  const composerMember = view === 'members' && pickedSlotId !== undefined
    ? team.members[pickedSlotId]
    : undefined
  const boundSessionId = snapshot?.conversation.sessionId

  useEffect(() => {
    setMemberComposerTarget(
      composerMember === undefined
      || composerMember.role === 'leader'
      || !team.directMemberChat
      || boundSessionId === undefined
        ? undefined
        : {
            sessionId: boundSessionId,
            teamId: team.id,
            conversationId,
            slotId: composerMember.id,
            displayName: composerMember.displayName,
          },
    )
  }, [
    boundSessionId,
    composerMember?.id,
    composerMember?.displayName,
    conversationId,
    team.directMemberChat,
    team.id,
  ])
  useEffect(() => () => { setMemberComposerTarget(undefined) }, [])

  /** Page one member's history back, the way the Harness pages a Session. */
  async function loadOlder(slotId: string): Promise<void> {
    const beforeSeq = snapshot?.conversations.find(item => item.slotId === slotId)?.oldestSeq
    if (beforeSeq === undefined) return
    try {
      const page = await callAgentTeam('team.workbench.older', {
        id: team.id,
        conversationId,
        slotId,
        beforeSeq,
      })
      setSnapshot(current => current === undefined
        ? current
        : {
          ...current,
          conversations: current.conversations.map(existing => existing.slotId === slotId
            ? prependMemberPage(existing, page)
            : existing),
        })
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return (
    <div className={css.workbench}>
      <div className={css.workbenchMainPane}>
        <div className={css.memberTabs} aria-label="团队成员">
        {/* The view switch leads the row: which surface you are looking at is
            the first thing to read, before the member tabs beside it. */}
        <span className={css.viewToggle} role="tablist" aria-label="工作台视图">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'room'}
            className={`${css.viewToggleButton} ${view === 'room' ? css.viewToggleButtonActive : ''}`}
            onClick={() => { setView('room') }}
          >
            会议室
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'members'}
            className={`${css.viewToggleButton} ${view === 'members' ? css.viewToggleButtonActive : ''}`}
            onClick={() => { setView('members') }}
          >
            成员视图
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'flow'}
            className={`${css.viewToggleButton} ${view === 'flow' ? css.viewToggleButtonActive : ''}`}
            onClick={() => { setView('flow') }}
          >
            流程图
          </button>
        </span>
        <span className={css.memberTabsDivider} aria-hidden="true" />
        {members.map(member => {
          const conversation = conversations.get(member.id)
          const selected = pickedSlotId === member.id
          return (
            <span key={member.id} className={css.memberTabWrap}>
              <button
                type="button"
                className={`${css.memberTab} ${member.role === 'leader' ? '' : css.memberTabWithActions} ${selected ? css.memberTabActive : ''}`}
                title={selected ? `显示全部成员` : `只看 ${member.displayName}`}
                onClick={() => { pickMember(member.id) }}
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
                    onClick={() => {
                      setMemberActionError(undefined)
                      setMemberToRemove(member)
                    }}
                  >
                    <IconCloseOutline16 size={12} />
                  </button>
                </span>
              )}
            </span>
          )
        })}
        <span className={css.manageButtonWrap}>
          {!workspaceVisible && (
            <Button
              variant="ghost"
              size="sm"
              className={css.manageButton}
              onClick={() => { setWorkspaceVisible(true) }}
            >
              <IconChevronLeftOutline14 size={14} />
              Workspace
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className={css.manageButton}
            onClick={() => {
              setAddMemberOpen(true)
            }}
          >
            <IconPlusOutline16 size={14} />
            添加助手
          </Button>
          <Button variant="ghost" size="sm" className={css.manageButton} onClick={() => { setManagementOpen(value => !value) }}>
            {managementOpen ? '收起管理' : '团队管理'}
          </Button>
        </span>
        </div>
        {error && <div role="alert" className={css.workbenchError}>{error}</div>}
        {memberActionError && memberToRemove === undefined && (
          <div role="alert" className={css.workbenchError}>{memberActionError}</div>
        )}
        {expandedSlotId !== undefined && (
          <button
            type="button"
            className={css.conversationFocusBackdrop}
            aria-label="关闭放大对话"
            onClick={() => { setExpandedSlotId(undefined) }}
          />
        )}
        <div className={css.workbenchBody}>
          {view === 'flow'
            ? (
                <TaskFlowChart tasks={conversationTasks} members={team.members} />
              )
            : view === 'room'
            ? (
                <MeetingRoom
                  team={team}
                  conversationId={conversationId}
                  conversation={snapshot?.conversation}
                  pendingActions={pendingActions}
                  onOpenMember={slotId => { setExpandedSlotId(slotId) }}
                  onChanged={onChanged}
                />
              )
            : (
                <div className={css.conversationGrid} style={{ '--member-columns': visibleMembers.length } as React.CSSProperties}>
                  {visibleMembers.map(member => (
                    <MemberColumn
                      key={member.id}
                      team={team}
                      conversationId={conversationId}
                      member={member}
                      assistants={assistants}
                      catalog={catalog}
                      conversations={conversations}
                      expanded={expandedSlotId === member.id}
                      onLoadOlder={() => loadOlder(member.id)}
                      onSent={load}
                      onExpandedChange={expanded => { setExpandedSlotId(expanded ? member.id : undefined) }}
                    />
                  ))}
                </div>
              )}
        </div>
      </div>
      {/*
        Opening a member from the room shows the same focused column the member
        grid uses, so "点开 agent" works without leaving the meeting room.
      */}
      {view === 'room' && expandedSlotId !== undefined && focusedMember !== undefined && (
        <div className={css.conversationGrid} style={{ '--member-columns': 1 } as React.CSSProperties}>
          <MemberColumn
            team={team}
            conversationId={conversationId}
            member={focusedMember}
            assistants={assistants}
            catalog={catalog}
            conversations={conversations}
            expanded
            onLoadOlder={() => loadOlder(focusedMember.id)}
            onSent={load}
            onExpandedChange={expanded => { if (!expanded) setExpandedSlotId(undefined) }}
          />
        </div>
      )}
      {workspaceVisible && (
        <WorkspacePanel
          team={team}
          conversationId={conversationId}
          workspacePath={snapshot?.conversation.workspacePath ?? team.workspacePath}
          refreshSignal={workspaceRefreshSignal}
          onCollapse={() => { setWorkspaceVisible(false) }}
        />
      )}
      <AnimatedModal
        open={managementOpen}
        onClose={() => { setManagementOpen(false) }}
        title="团队管理"
        description="管理成员、Leader、上下文和团队生命周期。"
        closeLabel="关闭"
        className={css.managementDialog ?? ''}
        contentClassName={css.managementDialogContent ?? ''}
      >
        <div className={css.managementDialogBody}>
          <TeamDetail
            team={team}
            catalog={catalog}
            assistants={assistants}
            onChanged={async () => { await onChanged(); await load() }}
            compact
          />
        </div>
      </AnimatedModal>
      <AddTeamMemberDialog
        open={addMemberOpen}
        team={team}
        catalog={catalog}
        assistants={assistants}
        onClose={() => { setAddMemberOpen(false) }}
        onChanged={async () => { await onChanged(); await load() }}
      />
      <AnimatedModal
        open={memberToRemove !== undefined}
        onClose={() => {
          if (memberActionBusy) return
          setMemberToRemove(undefined)
          setMemberActionError(undefined)
        }}
        title="移出团队成员"
        closeLabel="关闭"
        description="该成员将停止参与当前团队。"
        className={css.memberRemoveDialog ?? ''}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={memberActionBusy}
              onClick={() => {
                setMemberToRemove(undefined)
                setMemberActionError(undefined)
              }}
            >
              取消
            </Button>
            <Button
              variant="outline"
              className={css.dangerAction}
              disabled={memberActionBusy}
              onClick={() => { void removeMember() }}
            >
              {memberActionBusy ? '移出中…' : '确认移出'}
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
          {memberActionError && <div role="alert" className={css.inlineError}>{memberActionError}</div>}
        </div>
      </AnimatedModal>
    </div>
  )
}


