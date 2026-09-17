/**
 * `react-dom` and its server entry are needed by the task chart only, and only
 * for a portal and a rendering test. They ship no types in this project's
 * dependency set, so the two functions are declared here rather than pulling a
 * whole new types package in for them.
 */
declare module 'react-dom' {
  import type { ReactElement, ReactNode } from 'react'

  export function createPortal(
    children: ReactNode,
    container: Element | DocumentFragment,
  ): ReactElement
}

declare module 'react-dom/server' {
  import type { ReactElement } from 'react'

  export function renderToStaticMarkup(element: ReactElement): string
}
