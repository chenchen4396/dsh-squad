export interface InsertFileMentionResult {
  value: string
  cursor: number
}

export function workspaceFileMention(path: string): string {
  return /\s/.test(path) ? `@"${path.replaceAll('"', '\\"')}"` : `@${path}`
}

export function insertWorkspaceFileMention(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  path: string,
): InsertFileMentionResult {
  const start = Math.max(0, Math.min(selectionStart, value.length))
  const end = Math.max(start, Math.min(selectionEnd, value.length))
  const mention = workspaceFileMention(path)
  const prefix = start > 0 && !/\s/.test(value[start - 1] ?? '') ? ' ' : ''
  const suffix = end < value.length && !/\s/.test(value[end] ?? '') ? ' ' : ''
  const inserted = `${prefix}${mention}${suffix}`
  return {
    value: `${value.slice(0, start)}${inserted}${value.slice(end)}`,
    cursor: start + prefix.length + mention.length,
  }
}
