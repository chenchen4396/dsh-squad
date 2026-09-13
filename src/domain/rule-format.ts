/**
 * Which imported files count as rule documents.
 *
 * A rule document is loaded into a member's system prompt verbatim, so only
 * Markdown is accepted: a viewer can read `.txt` or source files just as well,
 * but the plugin would have no way to tell a genuine rule document from an
 * unrelated file that happened to sit in the same folder.
 */
const markdownExtensions = ['.md', '.markdown'] as const

/** Extensions a rule document may carry, for the file picker and for docs. */
export const markdownRuleExtensions = markdownExtensions

/** Whether an imported path names a Markdown document (case-insensitive). */
export function isMarkdownRulePath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  return markdownExtensions.some(extension => name.endsWith(extension))
}
