import { Field } from '../shared.js'
import { toggleSorted } from '../option-selection.js'
import css from '../AgentTeam.module.css'
import conversationCss from '../workbench/ConversationColumn.module.css'

/** One selectable option: its name, and the line that explains it. */
export interface PickerOption {
  name: string
  /** Appended to the name, for a qualifier the reader needs before choosing. */
  qualifier?: string
  detail: string
}

/**
 * A checked list of options a preset offers.
 *
 * Skills and MCP Servers are chosen the same way — read the preset's catalog,
 * show what it has, let the reader tick what this assistant may use — and were
 * written out twice, in full, one beside the other. One component means the
 * loading, error and empty states cannot drift apart between them.
 */
export function OptionPicker({
  label,
  groupLabel,
  loadingText,
  loading,
  error,
  emptyText,
  hint,
  options,
  selected,
  onChange,
}: {
  label: string
  groupLabel: string
  loadingText: string
  loading: boolean
  error: string | undefined
  emptyText: string
  hint: string
  options: readonly PickerOption[]
  selected: readonly string[]
  onChange: (next: string[]) => void
}): JSX.Element {
  return (
    <Field label={`${label}（已选择 ${selected.length} 个）`} className={css.fullWidth ?? ''}>
      <div className={css.skillPicker} role="group" aria-label={groupLabel}>
        {loading && <span className={css.hint}>{loadingText}</span>}
        {!loading && error !== undefined && <span className={conversationCss.composerError}>{error}</span>}
        {!loading && error === undefined && options.length === 0 && (
          <span className={css.hint}>{emptyText}</span>
        )}
        {!loading && options.map(option => (
          <label key={option.name} className={css.skillOption}>
            <input
              type="checkbox"
              checked={selected.includes(option.name)}
              onChange={event => {
                onChange(toggleSorted(selected, option.name, event.target.checked))
              }}
            />
            <span className={css.skillOptionText}>
              <strong>
                {option.name}
                {option.qualifier === undefined ? '' : ` · ${option.qualifier}`}
              </strong>
              <small>{option.detail}</small>
            </span>
          </label>
        ))}
      </div>
      <span className={css.hint}>{hint}</span>
    </Field>
  )
}
