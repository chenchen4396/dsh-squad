import { useEffect, useState, type FormEvent } from 'react'
import { Button, IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AssistantView, CatalogView, TeamView } from '../../transport/contracts.js'
import { callAgentTeam } from '../api.js'
import { AssistantPanel } from '../assistants/AssistantPanel.js'
import css from '../AgentTeam.module.css'
import { orderedMembers } from '../../domain/team-selectors.js'
import { assistantForMember } from '../member-assistant.js'
import { AnimatedModal, Field } from '../shared.js'

/** Adding a member to a team, and cloning a team's whole arrangement. */
export function AddTeamMemberDialog({
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

export function CloneTeamDialog({
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
