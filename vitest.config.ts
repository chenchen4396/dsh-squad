import { defineConfig } from 'vitest/config'

/**
 * Render components with a stub for the application's UI package.
 *
 * The real package imports `.module.css` (which a Node loader refuses) and
 * depends on the application's markdown and highlighting stack, which this
 * plugin should not have to install to test its own panels. The alias lets a
 * test render a component's own tree without either.
 */
export default defineConfig({
  test: { environment: 'node' },
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-ui-primitives': new URL('./tests/support/ui-primitives-stub.tsx', import.meta.url).pathname,
    },
  },
})
