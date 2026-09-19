import { useRef, useState } from 'react'
import type { BundleImportSummary, SquadBundle } from '../../domain/bundle.js'
import { callAgentTeam } from '../api.js'
import { AnimatedModal, Field } from '../shared.js'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from '../AgentTeam.module.css'
import conversationCss from '../workbench/ConversationColumn.module.css'

/** The shape check a file must pass before it is offered for import. */
function readBundle(text: string): SquadBundle {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('这个文件不是 JSON，可能选错了文件。')
  }
  const candidate = parsed as Partial<SquadBundle>
  if (candidate.format !== 'dsh-squad/bundle') {
    throw new Error('这个文件不是 dsh-squad 导出的包。')
  }
  if (candidate.version !== 1) {
    throw new Error(`这个包的版本是 ${String(candidate.version)}，当前只认识版本 1。`)
  }
  return candidate as SquadBundle
}

/** How many of each thing the file carries, for the reader to judge before importing. */
function countOf(bundle: SquadBundle): string {
  const parts = [
    `${bundle.assistants.length} 个助手`,
    `${bundle.ruleDocuments.length} 份规则文档`,
    `${bundle.teams.length} 个团队`,
  ]
  return parts.join(' · ')
}

/**
 * Export and import of what this instance is configured with.
 *
 * The file carries configuration, never a running team's conversations, tasks
 * or Sessions — those belong to the machine they ran on. Import offers the two
 * things a reader actually wants: a second independent copy, or the same
 * configuration moved onto this instance.
 */
export function BundlePanel({ teamId }: { teamId?: string }): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState<SquadBundle>()
  const [mode, setMode] = useState<'copy' | 'overwrite'>('copy')
  const [summary, setSummary] = useState<BundleImportSummary>()

  async function download(): Promise<void> {
    setBusy(true)
    setError(undefined)
    try {
      const bundle = await callAgentTeam('bundle.export', teamId === undefined ? {} : { teamIds: [teamId] })
      const name = teamId === undefined ? 'dsh-squad-全部.json' : `dsh-squad-${bundle.teams[0]?.name ?? '团队'}.json`
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function pickFile(file: File | undefined): Promise<void> {
    if (file === undefined) return
    setError(undefined)
    setSummary(undefined)
    try {
      setPending(readBundle(await file.text()))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function confirmImport(): Promise<void> {
    if (pending === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await callAgentTeam('bundle.import', { bundle: pending, mode })
      setPending(undefined)
      setSummary(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={css.bundlePanel}>
      <div className={css.bundleActions}>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { void download() }}>
          {busy ? '导出中…' : teamId === undefined ? '导出全部配置' : '导出这个团队'}
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { fileRef.current?.click() }}>
          导入配置…
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          aria-label="选择 dsh-squad 配置文件"
          onChange={event => {
            void pickFile(event.target.files?.[0])
            event.target.value = ''
          }}
        />
      </div>
      <p className={css.bundleHint}>
        导出的是配置本身：助手、团队编制与规则文档。团队的对话、任务和成员会话属于运行它的机器，不会写进文件。
      </p>
      {error !== undefined && <div role="alert" className={conversationCss.composerError}>{error}</div>}
      {summary !== undefined && (
        <div className={css.bundleSummary} role="status">
          <strong>导入完成</strong>
          <span>
            {summary.mode === 'copy' ? '新建副本' : '覆盖更新'}：
            助手 {summary.assistantsCreated + summary.assistantsUpdated} 个
            （新建 {summary.assistantsCreated} / 更新 {summary.assistantsUpdated}）、
            规则文档 {summary.ruleDocumentsCreated + summary.ruleDocumentsUpdated} 份、
            团队 {summary.teamsCreated} 个
          </span>
          {summary.warnings.map(warning => (
            <span key={warning} className={css.bundleWarning}>{warning}</span>
          ))}
        </div>
      )}

      <AnimatedModal
        open={pending !== undefined}
        onClose={() => { setPending(undefined) }}
        title="导入配置"
        closeLabel="关闭"
        {...(pending === undefined ? {} : { description: countOf(pending) })}
        className={css.assistantDialog ?? ''}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setPending(undefined) }} disabled={busy}>取消</Button>
            <Button variant="primary" onClick={() => { void confirmImport() }} disabled={busy}>
              {busy ? '导入中…' : '开始导入'}
            </Button>
          </>
        )}
      >
        <div className={css.bundleImportChoice}>
          <Field label="导入方式">
            <label className={css.bundleModeOption} data-selected={mode === 'copy' ? 'true' : undefined}>
              <input
                type="radio"
                name="bundle-import-mode"
                checked={mode === 'copy'}
                onChange={() => { setMode('copy') }}
              />
              <span>
                <strong>导入为新副本</strong>
                <small>每个记录都分配新 id，不会覆盖你现有的任何助手或团队；同一个包导入两次就有两份。</small>
              </span>
            </label>
            <label className={css.bundleModeOption} data-selected={mode === 'overwrite' ? 'true' : undefined}>
              <input
                type="radio"
                name="bundle-import-mode"
                checked={mode === 'overwrite'}
                onChange={() => { setMode('overwrite') }}
              />
              <span>
                <strong>覆盖同名记录</strong>
                <small>同名助手、同路径规则文档就地更新；适合把一份配置同步到这台机器。</small>
              </span>
            </label>
          </Field>
          {pending !== undefined && pending.teams.length > 0 && (
            <p className={css.bundleHint}>
              包含团队：{pending.teams.map(team => team.name).join('、')}
            </p>
          )}
        </div>
      </AnimatedModal>
    </section>
  )
}
