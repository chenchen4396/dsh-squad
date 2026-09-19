import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { TaskGraphNode } from '../task-graph.js'
import { groupTaskBlocks, inlineTokens, taskBlocks, type InlineToken, type TaskBlock } from '../task-markdown.js'
import css from '../AgentTeam.module.css'
import { STATE_LABELS } from './task-labels.js'

export function TaskDetail({
  node,
  members,
  onPick,
  onClose,
}: {
  node: TaskGraphNode | undefined
  members: Readonly<Record<string, { displayName: string }>>
  onPick: (id: string) => void
  onClose: () => void
}): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<Element | null>(null)

  useEffect(() => {
    if (node === undefined) return
    // A dialog takes the keyboard with it: focus moves in, Tab stays inside so
    // the page behind cannot be reached, and closing hands focus back to
    // whatever opened it. Otherwise a keyboard reader is left at the top.
    restoreRef.current = document.activeElement
    const dialog = dialogRef.current
    dialog?.querySelector<HTMLElement>('button')?.focus()

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { onClose(); return }
      if (event.key !== 'Tab' || dialog === null) return
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter(element => !element.hasAttribute('disabled'))
      if (focusable.length === 0) return
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const active = document.activeElement
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const previous = restoreRef.current
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [node, onClose])

  if (node === undefined || typeof document === 'undefined') return null
  const owners = node.ownerSlotIds.map(slotId => members[slotId]?.displayName ?? slotId)
  return createPortal(
    <div className={css.taskDetailBackdrop} onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        className={css.taskDetailDialog}
        role="dialog"
        aria-modal="true"
        aria-label={node.title}
        onClick={event => { event.stopPropagation() }}
      >
        <header className={css.taskDetailHeader}>
          <div className={css.taskDetailHeading}>
            <strong className={css.taskDetailTitle}>{node.title}</strong>
            <span className={css.taskFlowDetailState} data-state={node.state}>
              {STATE_LABELS[node.state]}
              {owners.length === 0 ? ' · 未分配' : ` · ${owners.join('、')}`}
            </span>
          </div>
          <button type="button" className={css.taskDetailClose} onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className={css.taskFlowDetail} data-state={node.state}>
          <dl className={css.taskFlowDetailFacts}>
            <dt>等待</dt>
            <dd>{node.waitingOn.length === 0 ? '无（可开始）' : node.waitingOn.join('、')}</dd>
            <dt>完成后解锁</dt>
            <dd>{node.blocks.length === 0 ? '无' : node.blocks.join('、')}</dd>
          </dl>
          <TaskFacts node={node} owners={owners} />
          {(node.waitingOn.length > 0 || node.blocks.length > 0) && (
            <div className={css.taskFlowDetailLinks}>
              {[...node.waitingOn, ...node.blocks].map(id => (
                <button
                  key={id}
                  type="button"
                  className={css.taskFlowDetailLink}
                  onClick={() => { onPick(id) }}
                >
                  {id.slice(0, 8)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * The one shape every task is read in.
 *
 * Whoever wrote the task, the reader asks the same questions in the same order:
 * what must come first, what is the work, who holds it, what comes out and what
 * goes in. Rendering the description as free prose left those questions to be
 * answered by reading, so the dialog states them as sections.
 *
 * 前置依赖 and 责任人 come from the task's own fields, which is what the board
 * already acts on. 输出 and 输入 have no field yet: they are read out of the
 * description when its author named them, and the section says so when nobody
 * has filled them in rather than showing an empty box.
 */
function TaskFacts({
  node,
  owners,
}: {
  node: TaskGraphNode
  owners: readonly string[]
}): JSX.Element {
  const groups = groupTaskBlocks(taskBlocks(node.description))
  const label = (names: readonly string[]) =>
    groups.find(group => group.title !== undefined && names.includes(group.title))
  const body = groups.filter(group => group.title === undefined)
  const output = label(['输出'])
  const input = label(['输入'])
  const acceptance = label(['验收'])

  return (
    <div className={css.taskDetailSections}>
      <TaskFactBlock title="前置依赖">
        {node.waitingOn.length > 0
          ? <ul className={css.taskDetailList}>{node.waitingOn.map(id => (
              <li key={id} className={css.taskDetailItem}>
                <span className={css.taskDetailItemIndex} aria-hidden="true">↑</span>
                <span className={css.taskDetailItemText}>{id.slice(0, 8)}</span>
              </li>
            ))}</ul>
          : <p className={css.taskDetailMissing}>{node.dependsOn.length > 0 ? '依赖已全部满足' : '无（可立即开始）'}</p>}
      </TaskFactBlock>

      <TaskFactBlock title="任务描述">
        {body.length > 0
          ? <BlockList blocks={body.flatMap(group => group.blocks)} />
          : <p className={css.taskDetailMissing}>未填写</p>}
      </TaskFactBlock>

      <TaskFactBlock title="任务责任人">
        {owners.length === 0
          ? <p className={css.taskDetailMissing}>未分配</p>
          : <p className={css.taskDetailParagraph}>{owners.join('、')}</p>}
      </TaskFactBlock>

      <TaskFactBlock title="输出">
        {output !== undefined
          ? <BlockList blocks={output.blocks} />
          : <p className={css.taskDetailMissing}>未填写（任务完成后由成员在结果中给出）</p>}
      </TaskFactBlock>

      <TaskFactBlock title="输入">
        {input !== undefined
          ? <BlockList blocks={input.blocks} />
          : <p className={css.taskDetailMissing}>未填写</p>}
      </TaskFactBlock>

      {acceptance !== undefined && (
        <TaskFactBlock title="验收">
          <BlockList blocks={acceptance.blocks} />
        </TaskFactBlock>
      )}
    </div>
  )
}

/** One titled block of the template. */
function TaskFactBlock({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className={css.taskDetailSection}>
      <h4 className={css.taskDetailSectionTitle}>{title}</h4>
      {children}
    </section>
  )
}

/** The blocks of one section, each drawn as the kind of block it is. */
function BlockList({ blocks }: { blocks: readonly TaskBlock[] }): JSX.Element {
  return (
    <>
      {blocks.map((block, index) => <Block key={index} block={block} />)}
    </>
  )
}

function Block({ block }: { block: TaskBlock }): JSX.Element | null {
  switch (block.kind) {
    case 'heading':
      return (
        <h5 className={css.taskDetailBlockHeading} data-level={block.level}>
          {inline(block.text)}
        </h5>
      )
    case 'items':
      return (
        <ol className={css.taskDetailList}>
          {block.items.map((item, index) => (
            <li key={index} className={css.taskDetailItem}>
              <span className={css.taskDetailItemIndex} aria-hidden="true">{index + 1}</span>
              <span className={css.taskDetailItemText}>{inline(item)}</span>
            </li>
          ))}
        </ol>
      )
    case 'code':
      return (
        <pre className={css.taskDetailCodeBlock} data-language={block.language}>
          <code>{block.text}</code>
        </pre>
      )
    case 'quote':
      return <blockquote className={css.taskDetailQuote}>{inline(block.text)}</blockquote>
    case 'rule':
      return <hr className={css.taskDetailRule} />
    case 'paragraph':
      return <p className={css.taskDetailParagraph}>{inline(block.text)}</p>
  }
}

/** Render one line's inline tokens with the application's own elements. */
function inline(text: string): Array<string | JSX.Element> {
  return inlineTokens(text).map((token: InlineToken, index) => {
    switch (token.kind) {
      case 'strong': return <strong key={index}>{token.text}</strong>
      case 'code': return <code key={index} className={css.taskDetailCode}>{token.text}</code>
      case 'link':
        return (
          <a key={index} href={token.href} target="_blank" rel="noreferrer noopener">
            {token.text}
          </a>
        )
      default: return token.text
    }
  })
}

/** Badge width: the label plus its padding, so the pill always fits its word. */
