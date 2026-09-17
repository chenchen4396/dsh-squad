/**
 * A task description, split into the sections its author wrote.
 *
 * The descriptions the team actually produces are structured by hand: a
 * `【产出】` heading, then numbered points, then prose. Dropped into a dialog as
 * one paragraph that structure is lost — every line runs together and the
 * reader has to re-parse it. This reads the shape back out so the dialog can
 * render a heading, a list and a paragraph as what they are.
 *
 * Markdown headings and bold are honoured too, because the same field is used
 * for hand-written Markdown. Nothing else is interpreted: this is not a
 * Markdown implementation, and inventing one would render the team's text
 * differently from the transcript beside it.
 */
export interface TaskSection {
  /** A heading, or undefined for a section that starts straight into its body. */
  title?: string
  /** Lines that read as list items, in order. */
  items: string[]
  /** Lines that read as prose. */
  paragraphs: string[]
}

/** `【复核项】` or a Markdown heading, on a line of its own. */
const BRACKET_HEADING = /^【(.+?)】\s*$/
const MARKDOWN_HEADING = /^(#{1,6})\s+(.+?)\s*$/
const MARKDOWN_BULLET = /^\s*(?:[-*•]|\d+\s*[.)、．])\s*(.*)$/
const EMPTY_TITLE = /^(?:#{1,6}|【.*?】)$/

/**
 * A label the team writes as a heading in plain text: `输入：` on its own line.
 *
 * The canonical labels the dialog renders are matched here so a description
 * that already names its inputs, outputs, dependencies or acceptance keeps that
 * structure instead of collapsing into one body of prose.
 */
const LABEL_HEADING = /^(输入|输入物|进入条件|输出|产出|交付物|前置依赖|前置条件|依赖|责任人|负责人|验收标准|验收判据|验收)\s*[:：]?\s*$/
/** Longer labels first, so `前置依赖` is not read as `依赖`. */
const LABEL_ORDER = ['前置依赖', '前置条件', '输入物', '进入条件', '验收标准', '验收判据', '责任人', '负责人', '输入', '输出', '产出', '交付物', '依赖', '验收']

/** Break one description into sections, in the order they were written. */
export function taskSections(description: string): TaskSection[] {
  const sections: TaskSection[] = []
  let current: TaskSection = { items: [], paragraphs: [] }

  const flush = (): void => {
    if (current.title !== undefined || current.items.length > 0 || current.paragraphs.length > 0) {
      sections.push(current)
    }
    current = { items: [], paragraphs: [] }
  }

  for (const raw of description.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue

    const bracket = line.match(BRACKET_HEADING)
    if (bracket !== null) {
      flush()
      current.title = bracket[1]!.trim()
      continue
    }
    const heading = line.match(MARKDOWN_HEADING)
    if (heading !== null) {
      flush()
      current.title = heading[2]!.trim()
      continue
    }
    const label = LABEL_ORDER.find(candidate => line.startsWith(candidate)
      && LABEL_HEADING.test(line))
    if (label !== undefined) {
      flush()
      current.title = label
      continue
    }
    const bullet = line.match(MARKDOWN_BULLET)
    if (bullet !== null) {
      const item = bullet[1]!.trim()
      if (item.length > 0) current.items.push(item)
      continue
    }
    current.paragraphs.push(line)
  }
  flush()

  // A heading whose body never arrived is still worth showing, but an empty
  // title line on its own is noise.
  return sections.filter(section => !(section.title !== undefined
    && section.items.length === 0
    && section.paragraphs.length === 0
    && EMPTY_TITLE.test(section.title)))
}
