import { useId, useState } from 'react'
import type { TeamTask } from '../../domain/types.js'
import { buildTaskGraph } from '../task-graph.js'
import { FLOW_NODE } from '../task-flow.js'
import { layoutTaskRegions } from '../task-flow-regions.js'
import css from '../AgentTeam.module.css'
import { TaskCard } from './TaskCard.js'
import { TaskDetail } from './TaskDetailDialog.js'
import { EDGE_LEGEND, LEGEND, STATE_LABELS } from './task-labels.js'

/**
 * The 团队 view's task chart.
 *
 * Both halves are the same cards: the left draws the work in flight as a graph,
 * the right lists what has finished. They are kept identical on purpose — a
 * name, its state and who holds it read the same wherever the task sits, so
 * nothing has to be re-learnt when a task moves from one side to the other.
 *
 * The caller passes one conversation's tasks, so a chart never mixes sessions.
 */
export function TaskFlowChart({
  tasks,
  members,
}: {
  tasks: readonly TeamTask[]
  members: Readonly<Record<string, { displayName: string }>>
}): JSX.Element | null {
  const arrowId = `agent-team-flow-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [selectedId, setSelectedId] = useState<string>()

  if (tasks.length === 0) return null
  const graph = buildTaskGraph(tasks)
  const regions = layoutTaskRegions(graph, members)
  const chart = regions.active
  const details = new Map(graph.nodes.map(node => [node.id, node]))
  const selected = selectedId === undefined ? undefined : details.get(selectedId)
  const pick = (id: string): void => {
    setSelectedId(current => current === id ? undefined : id)
  }

  return (
    <div className={css.taskFlow}>
      <div className={css.taskFlowBar}>
        <span className={css.taskFlowProgress}>
          <span className={css.taskFlowProgressTrack}>
            <span
              className={css.taskFlowProgressFill}
              data-active={graph.summary.running > 0 ? 'true' : undefined}
              style={{ width: `${Math.round((graph.summary.done / graph.summary.total) * 100)}%` }}
            />
          </span>
          <span className={css.taskFlowProgressText}>
            {graph.summary.done}/{graph.summary.total} 已完成
          </span>
        </span>
        <ul className={css.taskFlowLegend}>
          {LEGEND.map(state => (
            <li key={state} className={css.taskFlowLegendItem} data-state={state}>
              <span className={css.taskFlowDot} aria-hidden="true" />
              {STATE_LABELS[state]}
            </li>
          ))}
          {EDGE_LEGEND.map(entry => (
            <li key={entry.label} className={css.taskFlowLegendItem}>
              <span className={css[entry.className]} aria-hidden="true" />
              {entry.label}
            </li>
          ))}
        </ul>
      </div>
      <div className={css.taskFlowSplit}>
        {/* The large half: everything not yet finished, in dependency order. */}
        <section className={css.taskFlowActive}>
          <header className={css.taskFlowSectionHead}>
            <strong className={css.taskFlowSectionTitle}>进行中</strong>
            <span className={css.taskFlowSectionCount}>{chart.items.length} 个任务</span>
          </header>
          {chart.items.length === 0
            ? <p className={css.taskFlowEmpty}>没有进行中的任务</p>
            : (
                <div className={css.taskFlowCanvas}>
                  <svg
                    className={css.taskFlowSvg}
                    viewBox={`0 0 ${chart.width} ${chart.height}`}
                    width={chart.width}
                    height={chart.height}
                    role="img"
                    aria-label={`进行中的任务流程图，共 ${chart.items.length} 个任务`}
                  >
                    <defs>
                      <marker
                        id={arrowId}
                        viewBox="0 0 8 8"
                        refX="7"
                        refY="4"
                        markerWidth="5"
                        markerHeight="5"
                        orient="auto-start-reverse"
                      >
                        <path d="M 0 1 L 8 4 L 0 7 z" className={css.taskFlowArrowHead} />
                      </marker>
                    </defs>
                    {chart.edges.map(edge => {
                      const satisfied = edge.sourceState === 'done' || edge.sourceState === 'cancelled'
                      return (
                        <path
                          key={edge.id}
                          className={css.taskFlowEdge}
                          data-state={edge.sourceState}
                          data-satisfied={satisfied ? 'true' : undefined}
                          d={edge.path}
                          fill="none"
                          markerEnd={`url(#${arrowId})`}
                        />
                      )
                    })}
                    {chart.items.map(item => (
                      <TaskCard
                        key={item.id}
                        item={item}
                        selected={item.id === selectedId}
                        onPick={pick}
                      />
                    ))}
                  </svg>
                </div>
              )}
        </section>
        {/* The small half: what has left the board, drawn as the same cards. */}
        <aside className={css.taskFlowArchive}>
          <details className={css.taskFlowArchiveDetails} open>
            <summary className={css.taskFlowSectionHead}>
              <strong className={css.taskFlowSectionTitle}>已完成</strong>
              <span className={css.taskFlowSectionCount}>{regions.archived.length}</span>
            </summary>
            {regions.archived.length === 0
              ? <p className={css.taskFlowEmpty}>还没有完成的任务</p>
              : (
                  <ul className={css.taskFlowArchiveList}>
                    {regions.archived.map(item => (
                      <li key={item.id} className={css.taskFlowArchiveCard}>
                        <svg
                          className={css.taskFlowSvg}
                          viewBox={`0 0 ${FLOW_NODE.width} ${FLOW_NODE.height}`}
                          width={FLOW_NODE.width}
                          height={FLOW_NODE.height}
                          role="img"
                          aria-label={`${item.title}，${STATE_LABELS[item.state]}`}
                        >
                          <TaskCard
                            item={{ ...item, x: FLOW_NODE.width / 2, y: FLOW_NODE.height / 2 }}
                            selected={item.id === selectedId}
                            onPick={pick}
                          />
                        </svg>
                      </li>
                    ))}
                  </ul>
                )}
          </details>
        </aside>
      </div>
      {/* A dialog rather than a panel: the chart uses the width it has, and the
          detail opens over it wherever the reader happens to be looking. */}
      <TaskDetail node={selected} members={members} onPick={setSelectedId} onClose={() => { setSelectedId(undefined) }} />
    </div>
  )
}

/**
 * One task, drawn the same way wherever it appears.
 *
 * A card carries its state as a badge, its name, and the one fact a reader asks
 * next — who holds it, or what it is still waiting for.
 */
