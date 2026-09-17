/**
 * A task description, read as the blocks its author wrote.
 *
 * The descriptions the team produces are Markdown by habit even when nobody
 * says so: `##` headings, `1.` lists, fenced code, `**bold**` and `` `code` ``.
 * Rendered as one paragraph all of that turns into noise, so the blocks are
 * read back out and drawn as what they are.
 *
 * This is deliberately not a Markdown implementation. It covers the blocks
 * these tasks actually use and leaves anything else as plain text, because a
 * half-implementation that silently rewrites text is worse than none — and the
 * team's own transcript renders the same field with the application's Markdown
 * component, which would disagree with an invented one.
 */
export type TaskBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'items'; items: string[] }
  | { kind: 'code'; language?: string; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'paragraph'; text: string }

/** A fenced code block opener: ``` or ~~~ with an optional language. */
const FENCE_OPEN = /^\s*(?:```|~~~)\s*([A-Za-z0-9+#._-]*)\s*$/
const FENCE_CLOSE = /^\s*(?:```|~~~)\s*$/
const MARKDOWN_HEADING = /^(#{1,6})\s+(.+?)\s*$/
const SETEXT_UNDERLINE = /^(=+|-+)\s*$/
const LIST_ITEM = /^\s*(?:[-*+•]|\d+\s*[.)、．])\s*(.+)$/
const QUOTE = /^\s*>\s?(.*)$/
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/

/**
 * Labels the team writes for the parts of a task, and the spellings of each.
 *
 * A label starts a section wherever it appears — `输入：` on its own line,
 * `产出：x`, or a heading — so a task written in any of those styles reads the
 * same way. Anything outside this list stays the task's own prose.
 */
const CANONICAL: ReadonlyArray<{ title: string; labels: readonly string[] }> = [
  { title: '前置依赖', labels: ['前置依赖', '前置条件', '依赖'] },
  { title: '任务描述', labels: ['任务描述', '任务说明', '描述'] },
  { title: '任务责任人', labels: ['任务责任人', '责任人', '负责人', 'Owner'] },
  { title: '输出', labels: ['输出', '产出', '交付物', '交付', '交付标准'] },
  { title: '输入', labels: ['输入', '输入物', '进入条件'] },
  { title: '验收', labels: ['验收标准', '验收判据', '验收', '完成后'] },
]

/** What a label line is made of: `【x】`, `x：`, or a bare known label. */
const LABEL_LINE = /^(?:【(.+?)】|([^：:#]{1,14})[：:])\s*(.*)$/

/** Find the canonical name a piece of text names, if it names one. */
function canonicalOf(text: string): string | undefined {
  const name = text.trim()
  return CANONICAL.find(entry => entry.labels.some(label => name === label))?.title
}

/**
 * Split one line into the label that starts it, plus whatever it carries.
 *
 * `输入：一份接口表` is a label and its content. A label becomes its own line so
 * that joining wrapped lines cannot fuse two labels into one sentence.
 */
function splitLabelLine(line: string): string[] {
  const segments: string[] = []
  let rest = line
  while (rest.length > 0) {
    const match = rest.match(LABEL_LINE)
    if (match === null) break
    const title = canonicalOf(match[1] ?? match[2] ?? '')
    if (title === undefined) break
    segments.push(title)
    rest = (match[3] ?? '').trim()
  }
  if (rest.length > 0) segments.push(rest)
  return segments.length === 0 ? [line] : segments
}

/** Read one description into the blocks it is made of. */
export function taskBlocks(description: string): TaskBlock[] {
  const blocks: TaskBlock[] = []
  const lines = description.split('\n')
  let paragraph: string[] = []
  let items: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
    paragraph = []
  }
  const flushItems = (): void => {
    if (items.length === 0) return
    blocks.push({ kind: 'items', items })
    items = []
  }
  const flush = (): void => {
    flushParagraph()
    flushItems()
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim()

    if (line.length === 0) {
      flush()
      continue
    }

    const fence = line.match(FENCE_OPEN)
    if (fence !== null) {
      flush()
      const language = fence[1] !== undefined && fence[1].length > 0 ? fence[1] : undefined
      const body: string[] = []
      index += 1
      while (index < lines.length && !FENCE_CLOSE.test(lines[index]!.trim())) {
        body.push(lines[index]!)
        index += 1
      }
      blocks.push({
        kind: 'code',
        ...(language === undefined ? {} : { language }),
        text: body.join('\n'),
      })
      continue
    }

    if (RULE.test(line)) {
      flush()
      blocks.push({ kind: 'rule' })
      continue
    }

    // A label line stands alone, so the next line's content cannot be joined
    // onto the label itself. Any line that is not a label is left untouched and
    // still joins its neighbours into one paragraph.
    const label = line.match(LABEL_LINE)
    const labelTitle = label === null ? undefined : canonicalOf(label[1] ?? label[2] ?? '')
    if (canonicalOf(line) !== undefined || labelTitle !== undefined) {
      // Whatever came before the label belongs to the previous paragraph; it
      // must be flushed first or it joins onto the label itself.
      flushParagraph()
      paragraph.push(canonicalOf(line) ?? labelTitle!)
      flushParagraph()
      const rest = label === null ? '' : (label[3] ?? '').trim()
      if (rest.length > 0) {
        paragraph.push(rest)
        flushParagraph()
      }
      continue
    }

    const heading = line.match(MARKDOWN_HEADING)
    if (heading !== null) {
      flush()
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.trim() })
      continue
    }
    // A title underlined with === or --- is a level-1 or level-2 heading.
    const underline = lines[index + 1]?.trim().match(SETEXT_UNDERLINE)
    if (underline !== null && underline !== undefined && items.length === 0) {
      flushParagraph()
      blocks.push({ kind: 'heading', level: underline[1]!.startsWith('=') ? 1 : 2, text: line })
      index += 1
      continue
    }

    const quote = line.match(QUOTE)
    if (quote !== null) {
      flush()
      blocks.push({ kind: 'quote', text: quote[1]!.trim() })
      continue
    }

    const item = line.match(LIST_ITEM)
    if (item !== null) {
      flushParagraph()
      items.push(item[1]!.trim())
      continue
    }

    flushItems()
    paragraph.push(line)
  }
  flush()

  return blocks
}

/** One labelled part of a task description. */
export interface TaskGroup {
  /** The canonical label this group belongs to, or undefined for the body. */
  title?: string
  blocks: TaskBlock[]
}

/** Group the blocks under the labels the author used. */
export function groupTaskBlocks(blocks: readonly TaskBlock[]): TaskGroup[] {
  const groups: TaskGroup[] = []
  let current: TaskGroup = { blocks: [] }

  const push = (): void => {
    if (current.title !== undefined || current.blocks.length > 0) groups.push(current)
    current = { blocks: [] }
  }

  for (const block of blocks) {
    const title = block.kind === 'paragraph' || block.kind === 'heading'
      ? canonicalOf(block.text)
      : undefined
    if (title !== undefined) {
      push()
      current.title = title
      continue
    }
    current.blocks.push(block)
  }
  push()
  return groups
}

/**
 * The inline emphasis these tasks use: `**bold**`, `` `code` ``, [text](url).
 *
 * Returned as a small token list rather than HTML so the caller renders it with
 * the application's own elements — no markup string is ever injected, and an
 * unbalanced `**` stays the literal text the author typed.
 */
export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string }

const INLINE = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g

/** Split one line into its inline tokens. */
export function inlineTokens(text: string): InlineToken[] {
  const tokens: InlineToken[] = []
  let last = 0
  let match = INLINE.exec(text)
  while (match !== null) {
    if (match.index > last) tokens.push({ kind: 'text', text: text.slice(last, match.index) })
    if (match[1] !== undefined) tokens.push({ kind: 'strong', text: match[1] })
    else if (match[2] !== undefined) tokens.push({ kind: 'code', text: match[2] })
    else if (match[3] !== undefined && match[4] !== undefined) {
      tokens.push({ kind: 'link', text: match[3], href: match[4] })
    }
    last = match.index + match[0].length
    match = INLINE.exec(text)
  }
  if (last < text.length) tokens.push({ kind: 'text', text: text.slice(last) })
  return tokens
}
