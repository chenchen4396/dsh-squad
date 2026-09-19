import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type {
  AssistantView,
  CatalogView,
  McpCatalogView,
  SkillCatalogView,
} from '../../transport/contracts.js'
import { callAgentTeam } from '../api.js'
import css from '../AgentTeam.module.css'
import { RuleDocumentPicker } from './RuleDocumentPicker.js'
import { OptionPicker } from './OptionPicker.js'
import { defaultPermissionPreset } from './assistant-permission.js'
import { PERMISSION_LABELS } from '../labels.js'
import { defaultReasoningLabel, useModelCapabilities } from '../model-reasoning.js'
import { Field } from '../shared.js'
import conversationCss from '../workbench/ConversationColumn.module.css'
import { errorText } from '../error-text.js'

/**
 * Creating and editing an assistant template.
 *
 * The form reads as four decisions — 基本信息, 模型, 执行, 能力 — rather than as
 * one long grid of fields, because that is how the person filling it decides.
 */

function FormSection({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className={css.assistantFormSection}>
      <header className={css.assistantFormSectionHead}>
        <h3 className={css.assistantFormSectionTitle}>{title}</h3>
        <p className={css.assistantFormSectionHint}>{description}</p>
      </header>
      {children}
    </section>
  )
}

/** The consequence of a permission preset, in the terms a member works in. */

function permissionHint(presetId: string): string {
  switch (presetId) {
    case 'read-only':
      return '只能读取与检索，任何写入都会先向你申请；评审或调研类角色建议用这一档。'
    case 'workspace-write':
      return '可以直接修改工作区文件，无需逐次申请；默认档位，实现类角色用这一档。'
    case 'danger-full-access':
      return '可以修改工作区之外的路径并执行命令，不经申请；只在确实需要时才选。'
    default:
      return '由 Harness 定义该档位允许的操作。'
  }
}

/** Only a writable level needs the reader's attention while choosing. */
function permissionTone(presetId: string): 'warn' | undefined {
  return presetId === 'workspace-write' || presetId === 'danger-full-access' ? 'warn' : undefined
}


export function AssistantForm({
  catalog,
  formId,
  assistant,
  saving,
  setSaving,
  onSaved,
}: {
  catalog: CatalogView | undefined
  formId: string
  assistant?: AssistantView
  saving: boolean
  setSaving: (saving: boolean) => void
  onSaved: () => Promise<void>
}): JSX.Element {
  const providers = catalog?.providers ?? []
  const presets = catalog?.agentPresets.filter(preset => preset.broken === undefined) ?? []
  const permissions = catalog?.permissionPresets ?? []
  const [name, setName] = useState(assistant?.name ?? '')
  const [description, setDescription] = useState(assistant?.description ?? '')
  const [instructions, setInstructions] = useState(assistant?.instructions ?? '')
  const [provider, setProvider] = useState(assistant?.provider ?? providers[0]?.id ?? '')
  const models = catalog?.models[provider] ?? []
  const [modelChoice, setModelChoice] = useState(assistant?.model ?? '')
  const [reasoningEffort, setReasoningEffort] = useState(assistant?.reasoningEffort ?? '')
  const [agentPresetId, setAgentPresetId] = useState(assistant?.agentPresetId ?? presets[0]?.id ?? '')
  const [permissionPresetId, setPermissionPresetId] = useState(assistant?.permissionPresetId ?? defaultPermissionPreset(permissions))
  const [availableSkills, setAvailableSkills] = useState<SkillCatalogView['skills']>([])
  const [selectedSkills, setSelectedSkills] = useState<string[]>(assistant?.skillAllowlist ?? [])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsError, setSkillsError] = useState<string>()
  const [availableMcpServers, setAvailableMcpServers] = useState<McpCatalogView['servers']>([])
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>(assistant?.mcpServers ?? [])
  const [mcpLoading, setMcpLoading] = useState(false)
  const [mcpError, setMcpError] = useState<string>()
  const [selectedRuleDocuments, setSelectedRuleDocuments] = useState<string[]>(
    assistant?.ruleDocumentAllowlist ?? [],
  )
  const [error, setError] = useState<string>()
  const modelCapabilities = useModelCapabilities(provider, modelChoice)

  useEffect(() => {
    if (!provider && providers[0]) setProvider(providers[0].id)
    if (!agentPresetId && presets[0]) setAgentPresetId(presets[0].id)
    if (!permissionPresetId && permissions[0]) setPermissionPresetId(defaultPermissionPreset(permissions))
  }, [agentPresetId, permissionPresetId, permissions, presets, provider, providers])
  useEffect(() => {
    setModelChoice(current => {
      if (models.some(candidate => candidate.id === current)) return current
      return models[0]?.id ?? ''
    })
  }, [models])
  useEffect(() => {
    if (modelCapabilities.loading || modelCapabilities.value === undefined) return
    const efforts = modelCapabilities.value.reasoning?.efforts ?? []
    setReasoningEffort(current => current && !efforts.some(effort => effort.id === current) ? '' : current)
  }, [modelCapabilities.loading, modelCapabilities.value])





  useEffect(() => {
    let active = true
    if (!agentPresetId) {
      setAvailableSkills([])
      setSelectedSkills([])
      return () => { active = false }
    }
    setSkillsLoading(true)
    setSkillsError(undefined)
    void callAgentTeam('skill.catalog', { agentPresetId })
      .then(value => {
        if (!active) return
        setAvailableSkills(value.skills)
        const availableNames = new Set(value.skills.map(skill => skill.name))
        setSelectedSkills(current => current.filter(name => availableNames.has(name)))
      })
      .catch(cause => {
        if (!active) return
        setAvailableSkills([])
        setSelectedSkills([])
        setSkillsError(errorText(cause))
      })
      .finally(() => {
        if (active) setSkillsLoading(false)
      })
    return () => { active = false }
  }, [agentPresetId])
  useEffect(() => {
    let active = true
    if (!agentPresetId) {
      setAvailableMcpServers([])
      setSelectedMcpServers([])
      return () => { active = false }
    }
    setMcpLoading(true)
    setMcpError(undefined)
    void callAgentTeam('mcp.catalog', { agentPresetId })
      .then(value => {
        if (!active) return
        setAvailableMcpServers(value.servers)
        const availableNames = new Set(value.servers.map(server => server.name))
        setSelectedMcpServers(current => current.filter(name => availableNames.has(name)))
      })
      .catch(cause => {
        if (!active) return
        setAvailableMcpServers([])
        setSelectedMcpServers([])
        setMcpError(errorText(cause))
      })
      .finally(() => {
        if (active) setMcpLoading(false)
      })
    return () => { active = false }
  }, [agentPresetId])

  const model = modelChoice

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    try {
      const value = {
        name,
        ...(assistant === undefined && !description.trim()
          ? {}
          : { description: description.trim() }),
        instructions,
        provider,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        agentPresetId,
        permissionPresetId,
        skillAllowlist: selectedSkills,
        mcpServers: selectedMcpServers,
        ruleDocumentAllowlist: selectedRuleDocuments,
      }
      if (assistant === undefined) {
        await callAgentTeam('assistant.create', value)
      } else {
        await callAgentTeam('assistant.update', { id: assistant.id, value }, assistant.revision)
      }
      await onSaved()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form id={formId} onSubmit={(event) => { void submit(event) }} className={`${css.form} ${css.assistantForm}`}>
      <div className={css.assistantFormSections}>
      <FormSection title="基本信息" description="这个助手是什么、做什么用。">
      <div className={css.formGrid}>
        <Field label="名称"><input required value={name} onChange={event => { setName(event.target.value) }} className={css.input} /></Field>
        <Field label="说明"><input value={description} onChange={event => { setDescription(event.target.value) }} className={css.input} /></Field>
      </div>
      </FormSection>
      <FormSection title="模型" description="用哪个 Provider、哪个模型，以及它的思考档位。">
      <div className={css.formGrid}>
        <Field label="Provider">
          <select required value={provider} onChange={event => { setProvider(event.target.value) }} className={css.input}>
            <option value="">请选择</option>
            {providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </Field>
        <Field label={`模型（${models.length} 个可选）`}>
          <select required value={modelChoice} onChange={event => { setModelChoice(event.target.value) }} className={css.input}>
            <option value="" disabled>请选择</option>
            {models.map(item => (
              <option key={item.id} value={item.id}>
                {item.name === item.id ? item.id : `${item.name}（${item.id}）`}
              </option>
            ))}
          </select>
        </Field>
        {modelCapabilities.value?.reasoning !== undefined && modelCapabilities.value.reasoning.efforts.length > 0 && (
          <Field label="思考模式">
            <select
              value={reasoningEffort}
              onChange={event => { setReasoningEffort(event.target.value) }}
              className={css.input}
              aria-describedby={`${formId}-reasoning-hint`}
            >
              <option value="">{defaultReasoningLabel(modelCapabilities.value)}</option>
              {modelCapabilities.value.reasoning.efforts.map(effort => (
                <option key={effort.id} value={effort.id}>
                  {effort.name === effort.id ? effort.name : `${effort.name}（${effort.id}）`}
                </option>
              ))}
            </select>
            <span id={`${formId}-reasoning-hint`} className={css.hint}>由当前 Provider 和模型决定可用档位。</span>
          </Field>
        )}
        {modelCapabilities.error && <span className={conversationCss.composerError}>{modelCapabilities.error}</span>}
      </div>
      </FormSection>
      <FormSection title="执行" description="成员以什么身份运行，以及它能改到什么范围。">
      <div className={css.formGrid}>
        <Field label="Agent Preset">
          <select required value={agentPresetId} onChange={event => { setAgentPresetId(event.target.value) }} className={css.input}>
            {presets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </Field>
        <Field label="执行权限">
          <select required value={permissionPresetId} onChange={event => { setPermissionPresetId(event.target.value) }} className={css.input}>
            {permissions.map(item => (
              <option key={item.value} value={item.value}>
                {PERMISSION_LABELS[item.value] ?? item.name}
              </option>
            ))}
          </select>
          {/* What the level actually permits, said where it is chosen: the
              preset name alone does not tell a reader what a member may do. */}
          <span className={css.hint} data-tone={permissionTone(permissionPresetId)}>
            {permissionHint(permissionPresetId)}
          </span>
        </Field>
      </div>
      </FormSection>
      <FormSection title="能力" description="这个助手长期遵守的规则，以及它能调用的工具与文档。">
      <div className={css.formGrid}>
        <Field label="助手规则（可选）" className={css.fullWidth ?? ''}>
          <textarea
            value={instructions}
            onChange={event => { setInstructions(event.target.value) }}
            rows={4}
            placeholder="例如：你负责前端实现；遵循现有代码风格；修改前先阅读相关文件；完成后向 Leader 汇报测试结果。"
            className={css.input}
          />
          <span className={css.hint}>随助手模板保存，在成员启动时加入系统提示词；这里不填写具体任务。</span>
        </Field>
        <RuleDocumentPicker selected={selectedRuleDocuments} onChange={setSelectedRuleDocuments} />
        <OptionPicker
          label="可用 Skills"
          groupLabel="选择助手可使用的 Skills"
          loadingText="正在读取该 Preset 的 Skills…"
          loading={skillsLoading}
          error={skillsError}
          emptyText="该 Agent Preset 没有可用的 Skill。"
          hint="只选择这个助手执行任务时可能需要的 Skills；运行时会按任务需要加载具体 Skill 指令。"
          options={availableSkills.map(skill => ({
            name: skill.name,
            ...(skill.modelInvocable || !skill.userInvocable ? {} : { qualifier: '仅斜杠调用' }),
            detail: skill.description,
          }))}
          selected={selectedSkills}
          onChange={setSelectedSkills}
        />
        <OptionPicker
          label="可用 MCP"
          groupLabel="选择助手可使用的 MCP Server"
          loadingText="正在读取该 Preset 的 MCP Server…"
          loading={mcpLoading}
          error={mcpError}
          emptyText="当前 Harness 未为该 Agent Preset 配置 MCP Server。"
          hint="MCP 连接和密钥由 Harness Profile/Preset 统一管理；运行时只向助手开放已选 Server 的工具。"
          options={availableMcpServers.map(server => ({
            name: server.name,
            detail: `${server.tools.length} 个工具`,
          }))}
          selected={selectedMcpServers}
          onChange={setSelectedMcpServers}
        />
      </div>
      </FormSection>
      </div>
      {error && <div role="alert" className={css.inlineError}>{error}</div>}
    </form>
  )
}

