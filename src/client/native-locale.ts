import { relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import type { JsonTreeLabels, MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * DSH's own dictionaries, bound once so the plugin's rows and rendered blocks
 * read exactly like the rest of the app: the same words, in the language the
 * user picked, instead of copy of our own.
 */
let workspace: Translate | undefined
let common: Translate | undefined

/**
 * Bind the `workspace` (sidebar rows) and `common` (shared vocabulary)
 * dictionaries. Both arrive key-typed; lookups here are by plain string, so
 * the runtime service is read the same way the harness's own fallback chain
 * reads it (an unknown key renders as the key itself).
 */
export function bindNativeLocale(
  workspaceVocabulary: Translate,
  commonVocabulary: TranslateNS<'common'>,
): void {
  workspace = workspaceVocabulary
  common = (key, params) => commonVocabulary(key as Parameters<typeof commonVocabulary>[0], params)
}

/** Label of a conversation nobody has spoken in, exactly like a fresh Session. */
export function blankConversationLabel(): string {
  return workspace?.('session.new') ?? '新会话'
}

/** Trailing stamp of a conversation row, exactly like a Session row's. */
export function conversationTimeLabel(updatedAt: string, now: number): string {
  const at = Date.parse(updatedAt)
  if (!Number.isFinite(at)) return ''
  const { unit, n } = relativeTime(at, now)
  if (unit === 'now') return workspace?.('time.now') ?? '刚刚'
  return workspace?.(`time.${unit}`, { n }) ?? `${n}`
}

/** "5分钟前" style stamp for detail fields, worded by the same dictionary. */
export function agoLabel(at: string, now: number): string {
  const stamp = conversationTimeLabel(at, now)
  if (stamp === '') return ''
  const parsed = Date.parse(at)
  const { unit } = relativeTime(parsed, now)
  if (unit === 'now') return stamp
  return workspace?.('time.ago', { t: stamp }) ?? `${stamp}前`
}

/** Display copy the shipped Markdown renderer asks its callers for. */
export function markdownLabels(): MarkdownLabels {
  return {
    code: {
      copyLabel: common?.('copy') ?? '复制',
      copiedLabel: common?.('copied') ?? '复制成功',
    },
    footnotes: common?.('markdown.footnotes') ?? '脚注',
  }
}

/** Display copy the shipped JSON viewer asks its callers for. */
export function jsonTreeLabels(): JsonTreeLabels {
  const t = (key: string, params?: Record<string, unknown>): string => common?.(key, params) ?? key
  return {
    copyValue: t('copy.value'),
    copyJson: t('copy.json'),
    copyPath: t('copy.path'),
    copyPrettyJson: t('copy.prettyJson'),
    copyCompactJson: t('copy.compactJson'),
    copied: t('copied'),
    copyFailed: t('copy.failed'),
    collapseNode: t('json.collapseNode'),
    expandNode: t('json.expandNode'),
    copyButtonTitle: action => t('copy.optionsHint', { action }),
  }
}
