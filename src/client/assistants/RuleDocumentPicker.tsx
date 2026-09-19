import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RuleDocumentView } from '../../transport/contracts.js'
import { isMarkdownRulePath, markdownRuleExtensions } from '../../domain/rule-format.js'
import { callAgentTeam } from '../api.js'
import css from '../AgentTeam.module.css'
import { Field } from '../shared.js'
import { buildRuleDocumentTree } from '../rule-documents.js'
import { RuleDocumentNodeRow } from './RuleDocumentNodeRow.js'
import conversationCss from '../workbench/ConversationColumn.module.css'
import { errorText } from '../error-text.js'

/**
 * Folder picking is not part of the standard React input typings, so the
 * directory hints are passed through as raw attributes.
 */
const folderInputAttributes = { webkitdirectory: '', directory: '' }

/**
 * Choosing which imported rule documents an assistant loads.
 *
 * The picker owns its own data: the catalog of imported documents, the import
 * in flight, which document is being previewed, and which deletion is being
 * confirmed. The form only says which documents are selected, because that is
 * the part that belongs to the assistant being edited.
 */
export function RuleDocumentPicker({
  selected,
  onChange,
}: {
  selected: string[]
  onChange: (next: string[] | ((current: string[]) => string[])) => void
}): JSX.Element {
  const [ruleDocuments, setRuleDocuments] = useState<RuleDocumentView[]>([])
  const [ruleDocumentLimit, setRuleDocumentLimit] = useState<number>()
  const [ruleDocumentsLoading, setRuleDocumentsLoading] = useState(true)
  const [ruleDocumentsError, setRuleDocumentsError] = useState<string>()
  const [ruleDocumentPreview, setRuleDocumentPreview] = useState<Record<string, string>>({})
  const [ruleDocumentBusy, setRuleDocumentBusy] = useState<string>()
  const [confirmingRuleDocument, setConfirmingRuleDocument] = useState<string>()
  const ruleDocumentFilesRef = useRef<HTMLInputElement>(null)
  const ruleDocumentFolderRef = useRef<HTMLInputElement>(null)

  const ruleDocumentTree = useMemo(() => buildRuleDocumentTree(ruleDocuments), [ruleDocuments])

  const toggleRuleDocument = useCallback((id: string, checked: boolean): void => {
    onChange(current => checked
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
      setRuleDocumentsError(errorText(cause))
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
        failures.push(`${relative}：${errorText(cause)}`)
      }
    }
    setRuleDocuments(latest)
    const importedIds = latest
      .filter(document => importedPaths.has(document.path))
      .map(document => document.id)
    if (importedIds.length > 0) {
      onChange(current => [...new Set([...current, ...importedIds])])
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
      setRuleDocumentsError(errorText(cause))
    } finally {
      setRuleDocumentBusy(undefined)
    }
  }

  async function deleteRuleDocument(id: string): Promise<void> {
    setRuleDocumentBusy(id)
    try {
      const value = await callAgentTeam('assistant.ruleDocuments.delete', { id })
      setRuleDocuments(value.items)
      onChange(current => current.filter(value => value !== id))
      setRuleDocumentPreview(current => {
        const next = { ...current }
        delete next[id]
        return next
      })
      setConfirmingRuleDocument(undefined)
    } catch (cause) {
      setRuleDocumentsError(errorText(cause))
    } finally {
      setRuleDocumentBusy(undefined)
    }
  }

  return (
        <Field
          label={`规则文档（已选择 ${selected.length} 份）`}
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
                selected={selected}
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
  )
}
