import { createElement, type ReactNode } from 'react'

/**
 * A stand-in for the application's UI package in tests.
 *
 * The real package ships `.module.css` imports with its components, which a
 * Node test loader cannot process, and pulling the application's whole
 * markdown and syntax-highlighting stack into this plugin's dev dependencies to
 * render one panel would be a bad trade. This renders the same tree with plain
 * elements, so a test can assert what a component *draws* — its text, its
 * structure, its handlers — which is what these components are.
 *
 * It is deliberately dumb: no styling, no behaviour beyond passing children
 * through. A test that depends on how the real Button looks belongs in the
 * application, not here.
 */
type Props = Record<string, unknown> & { children?: ReactNode }

function element(tag: string) {
  return function Stubbed({ children, ...rest }: Props) {
    // `as` is avoided because the stub must accept whatever the caller passes.
    return createElement(tag, rest as Record<string, unknown>, children)
  }
}

function icon(tag: string) {
  return function StubbedIcon(props: Props) {
    return createElement(tag, { ...props, 'data-icon': tag })
  }
}

export const Button = element('button')
export const Menu = element('div')
export const Modal = element('div')
export const Tooltip = element('span')
export const Tag = element('span')
/**
 * Renders the parts the real component shows: the title, and the content it
 * keeps visible while collapsed. Dropping them would make a test unable to see
 * what identifies a collapsed row.
 */
export const DisclosureRow = ({
  title,
  icon,
  collapsedContent,
  children,
}: Props & { title?: ReactNode; icon?: ReactNode; collapsedContent?: ReactNode }) =>
  createElement('div', null, icon ?? null, title ?? null, collapsedContent ?? null, children ?? null)
export const MarkdownText = ({ text }: { text?: string }) =>
  createElement('div', { 'data-markdown': text ?? '' }, text ?? '')
export const StateDot = ({ state }: { state?: string }) =>
  createElement('span', { 'data-state-dot': state ?? '' })
export const relativeTime = (value: unknown) => `time:${String(value)}`

export const IconAgentPresetOutline16 = icon('agent-preset')
export const IconApiOutline14 = icon('api')
export const IconArchiveOutline20 = icon('archive')
export const IconBranchOutline16 = icon('branch')
export const IconBrowseOutline16 = icon('browse')
export const IconChevronDownOutline14 = icon('chevron-down')
export const IconChevronLeftOutline14 = icon('chevron-left')
export const IconChevronRightOutline14 = icon('chevron-right')
export const IconCloseOutline16 = icon('close')
export const IconCodeOutline16 = icon('code')
export const IconEditOutline16 = icon('edit')
export const IconFolderClose16 = icon('folder-close')
export const IconFolderOpen16 = icon('folder-open')
export const IconPlusOutline16 = icon('plus')
export const IconRefreshOutline16 = icon('refresh')
export const IconRightUpOutline14 = icon('right-up-14')
export const IconRightUpOutline16 = icon('right-up-16')
export const IconSearchOutline16 = icon('search')
export const IconSendOutline16 = icon('send')
export const IconSparkle16 = icon('sparkle')
export const IconStopFill16 = icon('stop')
export const IconThinkOutline14 = icon('think')
