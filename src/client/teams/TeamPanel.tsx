import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AssistantView, CatalogView, TeamView } from '../../transport/contracts.js'
import css from '../AgentTeam.module.css'
import { AnimatedModal, Empty } from '../shared.js'
import { openTeams } from '../store.js'
import { TeamDetail } from './TeamDetail.js'
import { TeamForm } from './TeamForm.js'
import { TeamList } from './TeamList.js'
import { AddTeamMemberDialog, AssistantManagementDialog, CloneTeamDialog } from './TeamDialogs.js'

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
      <AssistantManagementDialog
        open={managingAssistants}
        title="管理助手"
        onClose={() => { setManagingAssistants(false) }}
        catalog={catalog}
        assistants={assistants}
        onChanged={onChanged}
      />
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
