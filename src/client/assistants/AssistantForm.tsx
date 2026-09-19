import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type {
  AssistantView,
  CatalogView,
  McpCatalogView,
  RuleDocumentView,
  SkillCatalogView,
} from '../../transport/contracts.js'
import { isMarkdownRulePath, markdownRuleExtensions } from '../../domain/rule-format.js'
import { callAgentTeam } from '../api.js'
import css from '../AgentTeam.module.css'
import { defaultPermissionPreset } from './assistant-permission.js'
import { PERMISSION_LABELS } from '../labels.js'
import { defaultReasoningLabel, useModelCapabilities } from '../model-reasoning.js'
import { buildRuleDocumentTree } from '../rule-documents.js'
import { RuleDocumentNodeRow } from './RuleDocumentNodeRow.js'
import { Field } from '../shared.js'
import conversationCss from '../workbench/ConversationColumn.module.css'

/**
 * Folder picking is not part of the standard React input typings, so the
 * directory hints are passed through as raw attributes.
 */
const folderInputAttributes = { webkitdirectory: '', directory: '' }

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
  const [ruleDocuments, setRuleDocuments] = useState<RuleDocumentView[]>([])
  const [ruleDocumentLimit, setRuleDocumentLimit] = useState<number>()
  const [selectedRuleDocuments, setSelectedRuleDocuments] = useState<string[]>(
    assistant?.ruleDocumentAllowlist ?? [],
  )
  const [ruleDocumentsLoading, setRuleDocumentsLoading] = useState(true)
  const [ruleDocumentsError, setRuleDocumentsError] = useState<string>()
  const [ruleDocumentPreview, setRuleDocumentPreview] = useState<Record<string, string>>({})
  const [ruleDocumentBusy, setRuleDocumentBusy] = useState<string>()
  const [confirmingRuleDocument, setConfirmingRuleDocument] = useState<string>()
  const ruleDocumentFilesRef = useRef<HTMLInputElement>(null)
  const ruleDocumentFolderRef = useRef<HTMLInputElement>(null)
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
  const ruleDocumentTree = useMemo(() => buildRuleDocumentTree(ruleDocuments), [ruleDocuments])

  const toggleRuleDocument = useCallback((id: string, checked: boolean): void => {
    setSelectedRuleDocuments(current => checked
      ? (current.includes(id) ? current : [...current, id])
      : current.filter(value => value !== id))
  }, [])

  const loadRuleDocuments = useCallback(async (): Promise<RuleDocumentView[]> => {
    try {
      const value = await callAgentTeam('assistant.ruleDocuments.list', undefined)
      setRuleDocuments(value.items)
      setRuleDocumentLimit(value.limitBytes)
      setRuleDocumentsError(undefined)
      return value.items
    } catch (cause) {
      setRuleDocumentsError(cause instanceof Error ? cause.message : String(cause))
      return []
    } finally {
      setRuleDocumentsLoading(false)
    }
  }, [])

  useEffect(() => { void loadRuleDocuments() }, [loadRuleDocuments])

  /**
   * Import whole files, one request each.
   *
   * One document per request keeps every body well inside `maxRequestBytes` — a
   * folder of rules can be far larger than one request may carry. Files keep the
   * layout they were picked with, so `rules/frontend/` stays grouped, and the
   * imported documents are selected straight away since importing means using.
   *
   * Only Markdown is imported: a picked folder usually holds more than rules, so
   * anything else is skipped by name rather than uploaded and refused.
   */
  async function importRuleDocuments(files: File[]): Promise<void> {
    if (files.length === 0) return
    setRuleDocumentBusy('import')
    setRuleDocumentsError(undefined)
    const importedPaths = new Set<string>()
    const failures: string[] = []
    const skipped: string[] = []
    let latest = ruleDocuments
    for (const file of files) {
      const relative = file.webkitRelativePath.length > 0 ? file.webkitRelativePath : file.name
      if (!isMarkdownRulePath(relative)) {
        skipped.push(relative)
        continue
      }
      // Check locally first: uploading an oversized file would come back as a
      // generic body-limit error instead of naming the file and the cap.
      if (ruleDocumentLimit !== undefined && file.size > ruleDocumentLimit) {
        failures.push(
          `${relative}：${(file.size / 1024).toFixed(0)} KB 超过 ${Math.round(ruleDocumentLimit / 1024)} KB 上限`,
        )
        continue
      }
      try {
        const content = await file.text()
        const value = await callAgentTeam('assistant.ruleDocuments.import', {
          path: relative,
          content,
        })
        latest = value.items
        setRuleDocumentLimit(value.limitBytes)
        importedPaths.add(relative)
      } catch (cause) {
        failures.push(`${relative}：${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
    setRuleDocuments(latest)
    const importedIds = latest
      .filter(document => importedPaths.has(document.path))
      .map(document => document.id)
    if (importedIds.length > 0) {
      setSelectedRuleDocuments(current => [...new Set([...current, ...importedIds])])
    }
    if (failures.length > 0) {
      setRuleDocumentsError(`${failures.length} 份文档导入失败 — ${failures.slice(0, 3).join('；')}`)
    } else if (skipped.length > 0) {
      setRuleDocumentsError(
        `已跳过 ${skipped.length} 个非 Markdown 文件（只支持 ${markdownRuleExtensions.join(' / ')}）：${skipped.slice(0, 3).join('；')}`,
      )
    }
    setRuleDocumentBusy(undefined)
    if (ruleDocumentFilesRef.current !== null) ruleDocumentFilesRef.current.value = ''
    if (ruleDocumentFolderRef.current !== null) ruleDocumentFolderRef.current.value = ''
  }

  async function toggleRuleDocumentPreview(id: string): Promise<void> {
    if (ruleDocumentPreview[id] !== undefined) {
      setRuleDocumentPreview(current => {
        const next = { ...current }
        delete next[id]
        return next
      })
      return
    }
    setRuleDocumentBusy(id)
    try {
      const document = await callAgentTeam('assistant.ruleDocuments.get', { id })
      setRuleDocumentPreview(current => ({ ...current, [id]: document.content }))
    } catch (cause) {
      setRuleDocumentsError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRuleDocumentBusy(undefined)
    }
  }

  async function deleteRuleDocument(id: string): Promise<void> {
    setRuleDocumentBusy(id)
    try {
      const value = await callAgentTeam('assistant.ruleDocuments.delete', { id })
      setRuleDocuments(value.items)
      setSelectedRuleDocuments(current => current.filter(value => value !== id))
      setRuleDocumentPreview(current => {
        const next = { ...current }
        delete next[id]
        return next
      })
      setConfirmingRuleDocument(undefined)
    } catch (cause) {
      setRuleDocumentsError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRuleDocumentBusy(undefined)
    }
  }

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
        setSkillsError(cause instanceof Error ? cause.message : String(cause))
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
        setMcpError(cause instanceof Error ? cause.message : String(cause))
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
      setError(cause instanceof Error ? cause.message : String(cause))
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
        <Field
          label={`规则文档（已选择 ${selectedRuleDocuments.length} 份）`}
          className={css.fullWidth ?? ''}
        >
          <div className={css.ruleDocuments} role="group" aria-label="选择该助手加载的规则文档">
            <div className={css.ruleDocumentsToolbar}>
              <button
                type="button"
                className={css.ruleDocumentsImport}
                disabled={ruleDocumentBusy !== undefined}
                onClick={() => { ruleDocumentFilesRef.current?.click() }}
              >
                {ruleDocumentBusy === 'import' ? '导入中…' : '+ 导入文件'}
              </button>
              <button
                type="button"
                className={css.ruleDocumentsImport}
                disabled={ruleDocumentBusy !== undefined}
                onClick={() => { ruleDocumentFolderRef.current?.click() }}
              >
                导入文件夹
              </button>
              <span className={css.hint}>
                整份导入，不做条目拆分；选文件夹会保留 rules/ 这类层级。只支持 Markdown（
                {markdownRuleExtensions.join(' / ')}），其他文件会被跳过。
              </span>
              <input
                ref={ruleDocumentFilesRef}
                type="file"
                multiple
                accept={`${markdownRuleExtensions.join(',')},text/markdown`}
                hidden
                aria-label="选择要导入的规则文档"
                onChange={event => {
                  void importRuleDocuments([...(event.target.files ?? [])])
                }}
              />
              <input
                ref={ruleDocumentFolderRef}
                type="file"
                multiple
                hidden
                aria-label="选择要导入的规则文件夹"
                {...(folderInputAttributes as Record<string, string>)}
                onChange={event => {
                  void importRuleDocuments([...(event.target.files ?? [])])
                }}
              />
            </div>
            {ruleDocumentsError !== undefined && (
              <span className={conversationCss.composerError}>{ruleDocumentsError}</span>
            )}
            {ruleDocumentsLoading && <span className={css.hint}>正在读取规则文档…</span>}
            {!ruleDocumentsLoading && ruleDocuments.length === 0 && (
              <span className={css.hint}>还没有导入任何规则文档。</span>
            )}
            {!ruleDocumentsLoading && ruleDocumentTree.map(node => (
              <RuleDocumentNodeRow
                key={node.kind === 'folder' ? `folder:${node.path}` : node.document.id}
                node={node}
                depth={0}
                selected={selectedRuleDocuments}
                busy={ruleDocumentBusy}
                previews={ruleDocumentPreview}
                confirming={confirmingRuleDocument}
                onToggle={toggleRuleDocument}
                onPreview={id => { void toggleRuleDocumentPreview(id) }}
                onAskDelete={setConfirmingRuleDocument}
                onDelete={id => { void deleteRuleDocument(id) }}
              />
            ))}
          </div>
          <span className={css.hint}>只勾选这个助手需要的文档；成员会实时继承这里的选择，下一轮对话即可生效。</span>
        </Field>
        <Field
          label={`可用 Skills（已选择 ${selectedSkills.length} 个）`}
          className={css.fullWidth ?? ''}
        >
          <div className={css.skillPicker} role="group" aria-label="选择助手可使用的 Skills">
            {skillsLoading && <span className={css.hint}>正在读取该 Preset 的 Skills…</span>}
            {!skillsLoading && skillsError && <span className={conversationCss.composerError}>{skillsError}</span>}
            {!skillsLoading && !skillsError && availableSkills.length === 0 && (
              <span className={css.hint}>该 Agent Preset 没有可用的 Skill。</span>
            )}
            {!skillsLoading && availableSkills.map(skill => (
              <label key={skill.name} className={css.skillOption}>
                <input
                  type="checkbox"
                  checked={selectedSkills.includes(skill.name)}
                  onChange={event => {
                    setSelectedSkills(current => event.target.checked
                      ? [...current, skill.name].sort()
                      : current.filter(name => name !== skill.name))
                  }}
                />
                <span className={css.skillOptionText}>
                  <strong>{skill.name}{!skill.modelInvocable && skill.userInvocable ? ' · 仅斜杠调用' : ''}</strong>
                  <small>{skill.description}</small>
                </span>
              </label>
            ))}
          </div>
          <span className={css.hint}>只选择这个助手执行任务时可能需要的 Skills；运行时会按任务需要加载具体 Skill 指令。</span>
        </Field>
        <Field
          label={`可用 MCP（已选择 ${selectedMcpServers.length} 个）`}
          className={css.fullWidth ?? ''}
        >
          <div className={css.skillPicker} role="group" aria-label="选择助手可使用的 MCP Server">
            {mcpLoading && <span className={css.hint}>正在读取该 Preset 的 MCP Server…</span>}
            {!mcpLoading && mcpError && <span className={conversationCss.composerError}>{mcpError}</span>}
            {!mcpLoading && !mcpError && availableMcpServers.length === 0 && (
              <span className={css.hint}>当前 Harness 未为该 Agent Preset 配置 MCP Server。</span>
            )}
            {!mcpLoading && availableMcpServers.map(server => (
              <label key={server.name} className={css.skillOption}>
                <input
                  type="checkbox"
                  checked={selectedMcpServers.includes(server.name)}
                  onChange={event => {
                    setSelectedMcpServers(current => event.target.checked
                      ? [...current, server.name].sort()
                      : current.filter(name => name !== server.name))
                  }}
                />
                <span className={css.skillOptionText}>
                  <strong>{server.name}</strong>
                  <small>{server.tools.length} 个工具</small>
                </span>
              </label>
            ))}
          </div>
          <span className={css.hint}>MCP 连接和密钥由 Harness Profile/Preset 统一管理；运行时只向助手开放已选 Server 的工具。</span>
        </Field>
      </div>
      </FormSection>
      </div>
      {error && <div role="alert" className={css.inlineError}>{error}</div>}
    </form>
  )
}

