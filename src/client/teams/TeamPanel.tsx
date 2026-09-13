import type { FormEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  IconAgentPresetOutline16,
  StateDot,
  Tag,
  IconChevronLeftOutline14,
  IconCloseOutline16,
  IconPlusOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AssistantView,
  CatalogView,
  ConversationView,
  MemberConversationView,
  TeamView,
  TeamWorkbenchView,
} from '../../transport/contracts.js'
import { callAgentTeam, subscribeAgentTeamConversation } from '../api.js'
import { AssistantPanel } from '../assistants/AssistantPanel.js'
import css from '../AgentTeam.module.css'
import { orderedMembers, taskAssigneeIds } from '../../domain/team-selectors.js'
import { assistantForMember } from '../member-assistant.js'
import {
  mergeMemberConversation,
  mergeWorkbenchLoad,
  prependMemberPage,
} from '../conversation-nodes.js'
import { CrownIcon } from '../icons/CrownIcon.js'
import {
  memberModelLabel,
  memberStatusLabel,
  modelDisplayName,
  TASK_STATE_LABELS,
} from '../labels.js'
import type { MemberModelLabel } from '../labels.js'
import { agoLabel } from '../native-locale.js'
import { visibleMemberSlots } from '../member-visibility.js'
import { pendingActionsOf } from '../pending-actions.js'
import { cachedWorkbench, cacheWorkbench } from '../view-cache.js'
import { AnimatedModal, Empty, Field } from '../shared.js'
import { openMemberSession, openTeam, openTeams, setMemberComposerTarget } from '../store.js'
import { isTeamExecuting, runtimeStateDot } from '../team-status.js'
import { ConversationColumn } from '../workbench/ConversationColumn.js'
import { MeetingRoom } from '../workbench/MeetingRoom.js'
import { WorkspacePanel } from '../workspace/WorkspacePanel.js'

/**
 * Global team management: the team list, the team detail page, and the
 * assistant library. The per-session workbench lives in the 团队 view of a
 * conversation instead, so this page never creates or opens a Session.
 */
export function TeamPanel({
  catalog,
  assistants,
  teams,
  selectedTeamId,
  onChanged,
}: {
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  teams: TeamView[]
  selectedTeamId: string | undefined
  onChanged: () => Promise<void>
}): JSX.Element {
  const [creating, setCreating] = useState(false)
  const [managingAssistants, setManagingAssistants] = useState(false)
  const selectedTeam = teams.find(team => team.id === selectedTeamId)
  const visibleTeams = selectedTeamId === undefined
    ? teams
    : teams.filter(team => team.id === selectedTeamId)

  useEffect(() => {
    if (selectedTeamId !== undefined) setManagingAssistants(false)
  }, [selectedTeamId])

  return (
    <section className={css.section}>
      {selectedTeam === undefined && <div className={css.sectionHeader}>
        <div>
          <h2 className={css.sectionHeading}>团队 <span className={css.count}>{teams.length}</span></h2>
          <p className={css.sectionDescription}>在会话的「团队」标签里启用；启用后该会话自身的 Agent 就是 Leader，其他成员作为它的子 agent 运行。</p>
        </div>
        <div className={css.sectionHeaderActions}>
          <Button variant="outline" onClick={() => { setManagingAssistants(true) }}>
            管理助手
          </Button>
          <Button variant="primary" disabled={assistants.length === 0} onClick={() => { setCreating(true) }}>
            组建团队
          </Button>
        </div>
      </div>}
      {selectedTeam === undefined
        ? visibleTeams.length === 0
          ? <Empty text="还没有团队" hint="先通过右上角“管理助手”创建助手，再选择 Leader 和团队成员。" />
          : <TeamList teams={visibleTeams} now={Date.now()} />
        : <TeamDetail
          team={selectedTeam}
          catalog={catalog}
          assistants={assistants}
          onChanged={onChanged}
          onBack={openTeams}
        />}
      <AnimatedModal
        open={managingAssistants}
        onClose={() => { setManagingAssistants(false) }}
        title="管理助手"
        closeLabel="关闭"
        description="创建和维护可在不同团队间复用的助手模板。"
        className={css.assistantManagementDialog ?? ''}
        contentClassName={css.assistantManagementDialogContent ?? ''}
      >
        <div className={css.assistantManagementBody}>
          <AssistantPanel
            catalog={catalog}
            assistants={assistants}
            onChanged={onChanged}
          />
        </div>
      </AnimatedModal>
      <AnimatedModal
        open={creating}
        onClose={() => { setCreating(false) }}
        title="新建团队"
        closeLabel="关闭"
        description="让多个 AI 助手组队协作。一个团队必须有且只有一个 Leader。"
        className={css.teamCreateDialog ?? ''}
        contentClassName={css.teamCreateContent ?? ''}
      >
        <TeamForm
          catalog={catalog}
          assistants={assistants}
          onCancel={() => { setCreating(false) }}
          onCreated={async () => {
            setCreating(false)
            await onChanged()
          }}
        />
      </AnimatedModal>
    </section>
  )
}

/**
 * The workbench of one enabled team: the shared meeting room, the member
 * columns, the workspace panel, and in-place member management.
 *
 * It is rendered by the 团队 view of the Session the team is enabled in, so the
 * conversation it shows is always that Session's own binding.
 */
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
  const [view, setView] = useState<'room' | 'members'>('room')
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

  /**
   * Open one member's own Session, where the Harness composer addresses that
   * member alone.
   *
   * A member is a child Session of this one, so "talk to SE" is a navigation,
   * not a relay: the Leader is the Session's own Agent, and any composer shown
   * on this Session reaches it. A member that is not running yet has no Session
   * to open, so the action is offered only once it has one.
   */
  function openSessionFor(
    member: TeamView['members'][string],
    bySlot: Map<string, MemberConversationView>,
  ): (() => void) | undefined {
    if (member.id === team.leaderSlotId) return undefined
    const sessionId = bySlot.get(member.id)?.sessionId
    if (sessionId === undefined) return undefined
    return () => { openMemberSession(sessionId) }
  }

  /** The model label of one member column, Leader included. */
  function modelLabelOf(member: TeamView['members'][string]): MemberModelLabel {
    return memberModelLabel(
      catalog?.models,
      member,
      team.leaderSlotId,
      assistantForMember(assistants, member),
    )
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
          {view === 'room'
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
                  {visibleMembers.map(member => {
                    const openSession = openSessionFor(member, conversations)
                    return (
                    <ConversationColumn
                      key={member.id}
                      team={team}
                      conversationId={conversationId}
                      member={member}
                      assistant={assistantForMember(assistants, member)}
                      model={modelLabelOf(member)}
                      onLoadOlder={() => loadOlder(member.id)}
                      conversation={conversations.get(member.id)}
                      onSent={load}
                      {...(openSession === undefined ? {} : { onOpenSession: openSession })}
                      expanded={expandedSlotId === member.id}
                      onExpandedChange={expanded => { setExpandedSlotId(expanded ? member.id : undefined) }}
                    />
                    )
                  })}
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
          <ConversationColumn
            team={team}
            conversationId={conversationId}
            member={focusedMember}
            assistant={assistantForMember(assistants, focusedMember)}
            model={modelLabelOf(focusedMember)}
            onLoadOlder={() => loadOlder(focusedMember.id)}
            conversation={conversations.get(focusedMember.id)}
            onSent={load}
            {...(openSessionFor(focusedMember, conversations) === undefined
              ? {}
              : { onOpenSession: openSessionFor(focusedMember, conversations) as () => void })}
            expanded
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


function AddTeamMemberDialog({
  open,
  team,
  catalog,
  assistants,
  onClose,
  onChanged,
}: {
  open: boolean
  team: TeamView
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  onClose: () => void
  onChanged: () => Promise<void>
}): JSX.Element {
  const [addingAssistantId, setAddingAssistantId] = useState<string>()
  const [configuringAssistants, setConfiguringAssistants] = useState(false)
  const [error, setError] = useState<string>()

  async function addMember(assistant: AssistantView): Promise<void> {
    setAddingAssistantId(assistant.id)
    try {
      await callAgentTeam('team.addMember', {
        teamId: team.id,
        value: { assistantId: assistant.id },
      }, team.revision)
      setError(undefined)
      onClose()
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setAddingAssistantId(undefined)
    }
  }

  function close(): void {
    if (addingAssistantId !== undefined) return
    setConfiguringAssistants(false)
    setError(undefined)
    onClose()
  }

  return (
    <>
      <AnimatedModal
        open={open}
        onClose={close}
        title="添加助手"
        description={`选择一个助手加入团队“${team.name}”。同一个助手可以多次加入。`}
        closeLabel="关闭"
        className={css.addMemberDialog ?? ''}
        contentClassName={css.addMemberDialogContent ?? ''}
      >
        <div className={css.addMemberDialogHeader}>
          <strong>助手列表</strong>
          <div className={css.addMemberDialogHeaderActions}>
            <span>{assistants.length} 个助手</span>
            <Button
              variant="outline"
              size="sm"
              disabled={addingAssistantId !== undefined}
              onClick={() => { setConfiguringAssistants(true) }}
            >
              助手配置
            </Button>
          </div>
        </div>
        <div className={css.addMemberMenuList}>
          {assistants.map(assistant => (
            <button
              key={assistant.id}
              type="button"
              className={css.addMemberOption}
              disabled={addingAssistantId !== undefined}
              onClick={() => { void addMember(assistant) }}
            >
              <span className={css.addMemberAvatar}>{assistant.name.slice(0, 1).toUpperCase()}</span>
              <span className={css.addMemberCopy}>
                <strong>{assistant.name}</strong>
                <span>{assistant.provider} / {assistant.model}</span>
              </span>
              <span className={css.addMemberOptionAction}>
                {addingAssistantId === assistant.id ? '添加中…' : <IconPlusOutline16 size={14} />}
              </span>
            </button>
          ))}
          {assistants.length === 0 && <span className={css.addMemberEmpty}>还没有可添加的助手模板</span>}
        </div>
        {error && <div role="alert" className={css.inlineError}>{error}</div>}
      </AnimatedModal>
      <AnimatedModal
        open={configuringAssistants}
        onClose={() => { setConfiguringAssistants(false) }}
        title="助手配置"
        closeLabel="关闭"
        description="创建和维护可在不同团队间复用的助手模板。"
        className={css.assistantManagementDialog ?? ''}
        contentClassName={css.assistantManagementDialogContent ?? ''}
      >
        <div className={css.assistantManagementBody}>
          <AssistantPanel
            catalog={catalog}
            assistants={assistants}
            onChanged={onChanged}
          />
        </div>
      </AnimatedModal>
    </>
  )
}

function CloneTeamDialog({
  open,
  team,
  assistants,
  onClose,
  onCreated,
}: {
  open: boolean
  team: TeamView
  assistants: AssistantView[]
  onClose: () => void
  onCreated: (teamId: string) => Promise<void>
}): JSX.Element {
  const [name, setName] = useState(`${team.name} 副本`)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const members = orderedMembers(team)

  useEffect(() => {
    if (!open) return
    setName(`${team.name} 副本`)
    setSaving(false)
    setError(undefined)
  }, [open, team.id, team.name])

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    try {
      const draft = await callAgentTeam('team.clone', {
        teamId: team.id,
        name,
      })
      setError(undefined)
      onClose()
      await onCreated(draft.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  function close(): void {
    if (saving) return
    onClose()
  }

  return (
    <AnimatedModal
      open={open}
      onClose={close}
      title="复制团队"
      closeLabel="关闭"
      description="复用当前团队配置，并为每位成员创建全新 Session；Workspace 在新建会话时选择。"
      className={css.cloneTeamDialog ?? ''}
      contentClassName={css.cloneTeamDialogContent ?? ''}
    >
      <form className={css.cloneTeamForm} onSubmit={(event) => { void submit(event) }}>
        <div>
          <Field label="团队名称">
            <input
              required
              value={name}
              onChange={event => { setName(event.target.value) }}
              placeholder="输入团队名称"
              className={css.input}
              autoFocus
            />
          </Field>
        </div>
        <section className={css.cloneTeamMembers} aria-label="复制的团队成员">
          <div className={css.cloneTeamSectionHeader}>
            <strong>团队成员</strong>
            <span>{members.length} 人</span>
          </div>
          <div className={css.cloneTeamMemberGrid}>
            {members.map(member => (
              <div key={member.id} className={`${css.cloneTeamMember} ${member.role === 'leader' ? css.cloneTeamLeader : ''}`}>
                <span className={css.cloneTeamAvatar}>{member.displayName.slice(0, 1).toUpperCase()}</span>
                <span className={css.cloneTeamMemberCopy}>
                  <strong title={member.displayName}>{member.displayName}</strong>
                  <span>
                    {(() => {
                      const source = assistantForMember(assistants, member)
                      return source === undefined ? '助手不可用' : `${source.provider} / ${source.model}`
                    })()}
                  </span>
                </span>
                <span className={css.cloneTeamRole}>{member.role === 'leader' ? 'Leader' : '成员'}</span>
              </div>
            ))}
          </div>
        </section>
        <p className={css.cloneTeamNotice}>不会复制任务、对话上下文、消息历史或运行状态。</p>
        {error && <div role="alert" className={css.inlineError}>{error}</div>}
        <div className={css.cloneTeamActions}>
          <Button variant="outline" type="button" disabled={saving} onClick={close}>取消</Button>
          <Button variant="primary" type="submit" disabled={saving || !name.trim()}>
            {saving ? '复制中…' : '复制团队'}
          </Button>
        </div>
      </form>
    </AnimatedModal>
  )
}

/**
 * The team list: one row per team with its leader, roster and last activity.
 * A row is the way into that team's page.
 */
function TeamList({ teams, now }: { teams: TeamView[]; now: number }): JSX.Element {
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
function TeamDetail({
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
  const tasks = Object.values(team.tasks)
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
          {tasks.length > 0 && (
            <div className={css.taskList}>
              <strong className={css.taskTitle}>任务板</strong>
              {tasks.map(task => {
                const owners = taskAssigneeIds(task)
                return (
                  <div key={task.id} className={css.memberRow}>
                    <span>{task.title}</span>
                    <span className={css.muted}>
                      {TASK_STATE_LABELS[task.status] ?? task.status}
                      {owners.length === 0
                        ? ''
                        : ` · ${owners.map(slotId => team.members[slotId]?.displayName ?? '已移除成员').join('、')}`}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
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

interface DraftMember {
  key: string
  assistantId: string
}

function workspaceName(path: string): string {
  const normalized = path.replace(/[/\\]+$/, '')
  return normalized.split(/[/\\]/).at(-1) || 'Workspace'
}

function TeamForm({
  catalog,
  assistants,
  onCancel,
  onCreated,
}: {
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  onCancel: () => void
  onCreated: (teamId: string) => Promise<void>
}): JSX.Element {
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [members, setMembers] = useState<DraftMember[]>([])
  const [leaderKey, setLeaderKey] = useState<string>()
  const [directMemberChat, setDirectMemberChat] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const byId = useMemo(() => new Map(assistants.map(assistant => [assistant.id, assistant])), [assistants])
  const filteredAssistants = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return assistants
    return assistants.filter(assistant => [assistant.name, assistant.description, assistant.provider, assistant.model]
      .some(value => value?.toLocaleLowerCase().includes(normalized)))
  }, [assistants, query])

  function addAssistant(assistant: AssistantView): void {
    const member: DraftMember = {
      key: crypto.randomUUID(),
      assistantId: assistant.id,
    }
    setMembers(current => [...current, member])
    setLeaderKey(current => current ?? member.key)
  }

  function removeMember(key: string): void {
    const remaining = members.filter(member => member.key !== key)
    setMembers(remaining)
    if (leaderKey === key) setLeaderKey(remaining[0]?.key)
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (leaderKey === undefined || members.length === 0) return
    setSaving(true)
    try {
      const draft = await callAgentTeam('team.createDraft', {
        name,
        directMemberChat,
        members: members.map(member => ({
          assistantId: member.assistantId,
          role: member.key === leaderKey ? 'leader' : 'member',
        })),
      })
      // The team starts with its first session: that session is what names the
      // Workspace its members run in, so starting here would have nowhere to go.
      await onCreated(draft.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const canSubmit = name.trim().length > 0
    && leaderKey !== undefined
    && members.length > 0

  return (
    <form onSubmit={(event) => { void submit(event) }} className={css.teamBuilderForm}>
      <div className={css.teamBuilderGrid}>
        <section className={css.assistantPicker}>
          <div className={css.builderSectionHeading}>
            <strong>所有助手 <span className={css.count}>{assistants.length}</span></strong>
          </div>
          <input
            type="search"
            value={query}
            onChange={event => { setQuery(event.target.value) }}
            placeholder="搜索助手、Provider 或模型"
            aria-label="搜索助手"
            className={css.builderSearch}
          />
          <div className={css.assistantPickList}>
            {filteredAssistants.map(assistant => (
              <div key={assistant.id} className={css.assistantPickRow}>
                <div className={css.assistantPickAvatar} aria-hidden="true">
                  {assistant.name.slice(0, 1).toLocaleUpperCase()}
                </div>
                <div className={css.assistantPickCopy}>
                  <strong>{assistant.name}</strong>
                  <span>{assistant.provider} / {assistant.model}</span>
                </div>
                <button
                  type="button"
                  className={css.assistantAddButton}
                  onClick={() => { addAssistant(assistant) }}
                  aria-label={`添加 ${assistant.name}`}
                >
                  <IconPlusOutline16 size={16} />
                </button>
              </div>
            ))}
            {filteredAssistants.length === 0 && <Empty text="没有匹配的助手" />}
          </div>
        </section>

        <section className={css.selectedMembers}>
          <div className={css.builderSectionHeading}>
            <div>
              <strong>已选成员 {members.length}</strong>
              <p>选择团队成员并指定一个 Leader。同一助手可多次选择。</p>
            </div>
            <span className={css.leaderLegend}>Leader</span>
          </div>
          <div className={css.selectedMemberList}>
            {members.length === 0
              ? (
                  <div className={css.memberEmpty}>
                    <strong>至少选择一个助手当团队 Leader。</strong>
                    <span>从左侧助手列表添加成员。</span>
                  </div>
                )
              : members.map(member => {
                  const assistant = byId.get(member.assistantId)
                  const leader = member.key === leaderKey
                  return (
                    <div key={member.key} className={`${css.selectedMemberRow} ${leader ? css.selectedLeader : ''}`}>
                      <div className={css.assistantPickAvatar} aria-hidden="true">
                        {assistant?.name.slice(0, 1).toLocaleUpperCase() ?? '?'}
                      </div>
                      <div className={css.selectedMemberCopy}>
                        <strong>{assistant?.name ?? '助手'}</strong>
                        <span>{assistant?.provider} / {assistant?.model}</span>
                      </div>
                      {leader
                        ? <span className={css.leaderBadge}>Leader</span>
                        : <button type="button" className={css.setLeaderButton} onClick={() => { setLeaderKey(member.key) }}>设为 Leader</button>}
                      <button
                        type="button"
                        className={css.removeDraftMember}
                        onClick={() => { removeMember(member.key) }}
                        aria-label={`移除 ${assistant?.name ?? '助手'}`}
                      >
                        <IconCloseOutline16 size={14} />
                      </button>
                    </div>
                  )
                })}
          </div>
          <div className={css.teamFields}>
            <Field label="团队名称">
              <input required value={name} onChange={event => { setName(event.target.value) }} placeholder="输入团队名称" className={css.input} />
            </Field>
            <p className={css.teamFieldsHint}>
              Workspace 在新建会话时选择，每个会话可以有自己的 Workspace。
            </p>
            <label className={css.checkboxRow}>
              <input type="checkbox" checked={directMemberChat} onChange={event => { setDirectMemberChat(event.target.checked) }} />
              允许用户和普通成员直接通信
            </label>
          </div>
        </section>
      </div>
      {error && <div role="alert" className={css.inlineError}>{error}</div>}
      <div className={css.teamBuilderActions}>
        <Button variant="outline" onClick={onCancel} disabled={saving}>取消</Button>
        <Button variant="primary" type="submit" disabled={saving || !canSubmit}>
          {saving ? '创建中…' : '创建团队'}
        </Button>
      </div>
    </form>
  )
}
