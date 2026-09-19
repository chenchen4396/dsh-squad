import type { RuleDocumentNode } from '../rule-documents.js'
import css from '../AgentTeam.module.css'

/** One row of the rule-document tree an assistant selects from. */

export function RuleDocumentNodeRow({
  node,
  depth,
  selected,
  busy,
  previews,
  confirming,
  onToggle,
  onPreview,
  onAskDelete,
  onDelete,
}: {
  node: RuleDocumentNode
  depth: number
  selected: string[]
  busy: string | undefined
  previews: Record<string, string>
  confirming: string | undefined
  onToggle: (id: string, checked: boolean) => void
  onPreview: (id: string) => void
  onAskDelete: (id: string | undefined) => void
  onDelete: (id: string) => void
}): JSX.Element {
  if (node.kind === 'folder') {
    return (
      <div className={css.ruleDocumentFolder} style={{ paddingLeft: `${depth * 12}px` }}>
        <span className={css.ruleDocumentFolderName}>{node.name}/</span>
        <div className={css.ruleDocumentFolderChildren}>
          {node.children.map(child => (
            <RuleDocumentNodeRow
              key={child.kind === 'folder' ? `folder:${child.path}` : child.document.id}
              node={child}
              depth={depth + 1}
              selected={selected}
              busy={busy}
              previews={previews}
              confirming={confirming}
              onToggle={onToggle}
              onPreview={onPreview}
              onAskDelete={onAskDelete}
              onDelete={onDelete}
            />
          ))}
        </div>
      </div>
    )
  }

  const { document } = node
  const open = previews[document.id] !== undefined
  return (
    <div className={css.ruleDocument} style={{ marginLeft: `${depth * 12}px` }}>
      <label className={css.ruleDocumentMain}>
        <input
          type="checkbox"
          checked={selected.includes(document.id)}
          onChange={event => { onToggle(document.id, event.target.checked) }}
        />
        <span className={css.skillOptionText}>
          <strong>{document.title}</strong>
          <small>{document.path} · {(document.bytes / 1024).toFixed(1)} KB</small>
        </span>
      </label>
      <div className={css.ruleDocumentActions}>
        <button
          type="button"
          className={css.ruleDocumentAction}
          disabled={busy === document.id}
          onClick={() => { onPreview(document.id) }}
        >
          {open ? '收起' : '查看'}
        </button>
        {confirming === document.id
          ? (
              <>
                <button
                  type="button"
                  className={css.ruleDocumentDanger}
                  disabled={busy === document.id}
                  onClick={() => { onDelete(document.id) }}
                >
                  确认删除
                </button>
                <button
                  type="button"
                  className={css.ruleDocumentAction}
                  onClick={() => { onAskDelete(undefined) }}
                >
                  取消
                </button>
              </>
            )
          : (
              <button
                type="button"
                className={css.ruleDocumentAction}
                onClick={() => { onAskDelete(document.id) }}
              >
                删除
              </button>
            )}
      </div>
      {open && <pre className={css.ruleDocumentPreview}>{previews[document.id]}</pre>}
    </div>
  )
}

