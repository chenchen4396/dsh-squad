import { describe, expect, it } from 'vitest'
import { renderWorkspaceGitDiff } from '../src/service/workspace-diff-renderer.js'

const PATCH = [
  'diff --git a/example.ts b/example.ts',
  'index 7898192..6178079 100644',
  '--- a/example.ts',
  '+++ b/example.ts',
  '@@ -1 +1 @@',
  '-const value = 1',
  '+const value = 2',
  '',
].join('\n')

describe('Workspace diff renderer', () => {
  it('renders a themed unified diff as isolated HTML', async () => {
    const html = await renderWorkspaceGitDiff(PATCH, 'unified', 'dark')

    expect(html).toContain('data-core-css')
    expect(html).toContain('>const</span>')
    expect(html).toContain(' value</span>')
    expect(html).toContain('color-scheme: dark')
  })

  it('renders split layout markup', async () => {
    const html = await renderWorkspaceGitDiff(PATCH, 'split', 'light')

    expect(html).toContain('data-diff-type="split"')
    expect(html).toContain('data-deletions')
    expect(html).toContain('data-additions')
  })
})
