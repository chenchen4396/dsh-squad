import { useEffect, useState } from 'react'
import {
  IconChevronRightOutline14,
  IconFolderClose16,
  IconFolderOpen16,
  IconRightUpOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceEntryView } from '../../transport/contracts.js'
import { callAgentTeam } from '../api.js'
import css from './WorkspacePanel.module.css'

/** One row of the workspace file tree, which opens as it is walked. */
export function WorkspaceTreeRow({
  teamId,
  conversationId,
  entry,
  depth,
  refreshToken,
}: {
  teamId: string
  conversationId: string | undefined
  entry: WorkspaceEntryView
  depth: number
  refreshToken: number
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<WorkspaceEntryView[]>()
  useEffect(() => {
    if (!open || entry.kind !== 'directory') return
    let active = true
    void callAgentTeam('team.workspace.list', {
      teamId,
      ...(conversationId === undefined ? {} : { conversationId }),
      path: entry.path,
    })
      .then(next => { if (active) setChildren(next) })
      .catch(() => { if (active) setChildren([]) })
    return () => { active = false }
  }, [conversationId, entry.kind, entry.path, open, refreshToken, teamId])

  function toggle(): void {
    if (entry.kind === 'directory') setOpen(current => !current)
  }

  return (
    <div>
      <button type="button" className={css.fileRow} style={{ paddingLeft: 8 + depth * 14 }} onClick={toggle}>
        <span className={`${css.fileDisclosure} ${open ? css.fileDisclosureOpen : ''}`}>
          {entry.kind === 'directory'
            ? <IconChevronRightOutline14 size={12} />
            : entry.kind === 'symlink'
              ? <IconRightUpOutline14 size={12} />
              : null}
        </span>
        <span className={css.fileKindIcon}>
          {entry.kind === 'directory'
            ? open ? <IconFolderOpen16 size={16} /> : <IconFolderClose16 size={16} />
            : <FileOutlineIcon size={16} />}
        </span>
        <span>{entry.name}</span>
      </button>
      {open && children?.map(child => (
        <WorkspaceTreeRow
          key={child.path}
          teamId={teamId}
          conversationId={conversationId}
          entry={child}
          depth={depth + 1}
          refreshToken={refreshToken}
        />
      ))}
    </div>
  )
}

function FileOutlineIcon({ size }: { size: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 1.75h4.5L12 5.25v9H4v-12.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M8.5 1.75v3.5H12" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
}

