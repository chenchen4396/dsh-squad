import { preloadPatchDiff } from '@pierre/diffs/ssr'

export async function renderWorkspaceGitDiff(
  patch: string,
  layout: 'unified' | 'split',
  theme: 'light' | 'dark',
): Promise<string> {
  const result = await preloadPatchDiff({
    patch,
    options: {
      diffStyle: layout,
      diffIndicators: 'bars',
      hunkSeparators: 'line-info',
      lineDiffType: 'word-alt',
      overflow: 'scroll',
      theme: theme === 'dark' ? 'pierre-dark' : 'pierre-light',
      themeType: theme,
      disableFileHeader: true,
      tokenizeMaxLineLength: 2_000,
      tokenizeMaxLength: 200_000,
    },
  })
  return result.prerenderedHTML
}
