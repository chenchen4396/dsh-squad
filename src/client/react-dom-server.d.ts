/**
 * `react-dom/server` is needed by the board's rendering test only, and only
 * `renderToStaticMarkup` is used. The renderer ships no types in this project's
 * dependency set, so the one function is declared here rather than pulling a
 * whole new types package in for a single import.
 */
declare module 'react-dom/server' {
  import type { ReactElement } from 'react'

  export function renderToStaticMarkup(element: ReactElement): string
}
