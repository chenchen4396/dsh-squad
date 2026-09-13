import type { ComponentProps, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './AgentTeam.module.css'

const DIALOG_EXIT_MS = 140

export function AnimatedModal(props: ComponentProps<typeof Modal>): JSX.Element | null {
  const [rendered, setRendered] = useState(props.open)
  const [closing, setClosing] = useState(false)
  const latestOpenProps = useRef(props)
  if (props.open) latestOpenProps.current = props

  useEffect(() => {
    if (props.open) {
      setRendered(true)
      setClosing(false)
      return
    }
    if (!rendered) return
    setClosing(true)
    const exitDelay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : DIALOG_EXIT_MS
    const timer = window.setTimeout(() => {
      setRendered(false)
      setClosing(false)
    }, exitDelay)
    return () => { window.clearTimeout(timer) }
  }, [props.open, rendered])

  if (!props.open && !rendered) return null
  const activeProps = props.open ? props : latestOpenProps.current
  const className = [
    css.animatedDialog,
    closing ? css.animatedDialogClosing : '',
    activeProps.className ?? '',
  ].filter(Boolean).join(' ')
  return (
    <Modal
      {...activeProps}
      open
      onClose={() => { if (!closing) activeProps.onClose() }}
      className={className}
    />
  )
}

export function Field({
  label,
  children,
  className = '',
}: {
  label: string
  children: ReactNode
  className?: string
}): JSX.Element {
  return <label className={`${css.field} ${className}`}><span className={css.label}>{label}</span>{children}</label>
}

export function Empty({ text, hint }: { text: string; hint?: string }): JSX.Element {
  return (
    <div className={css.empty}>
      <div className={css.emptyCopy}>
        <span className={css.emptyTitle}>{text}</span>
        {hint && <span className={css.emptyHint}>{hint}</span>}
      </div>
    </div>
  )
}
