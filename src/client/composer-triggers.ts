export type ComposerTriggerKind = 'skill' | 'file'

export interface ComposerTrigger {
  kind: ComposerTriggerKind
  start: number
  end: number
  query: string
}

export interface ComposerTriggerReplacement {
  value: string
  cursor: number
}

export interface ComposerSkillSource {
  name: string
  description: string
  userInvocable: boolean
}

export interface OptionScrollGeometry {
  viewportTop: number
  viewportBottom: number
  optionTop: number
  optionBottom: number
  scrollTop: number
}

export function composerTriggerAt(value: string, rawCursor: number): ComposerTrigger | undefined {
  const cursor = Math.max(0, Math.min(rawCursor, value.length))
  let start = cursor
  while (start > 0 && !/\s/.test(value[start - 1] ?? '')) start -= 1
  const token = value.slice(start, cursor)
  if (token.length === 0) return undefined

  const marker = token[0]
  if (marker !== '/' && marker !== '@') return undefined
  if (marker === '@' && token.startsWith('@"')) return undefined

  const query = token.slice(1)
  if (marker === '/' && !/^[a-zA-Z0-9._-]*$/.test(query)) return undefined

  let end = cursor
  while (end < value.length && !/\s/.test(value[end] ?? '')) end += 1
  return {
    kind: marker === '/' ? 'skill' : 'file',
    start,
    end,
    query,
  }
}

export function replaceComposerTrigger(
  value: string,
  trigger: ComposerTrigger,
  replacement: string,
): ComposerTriggerReplacement {
  const suffix = trigger.end >= value.length || !/\s/.test(value[trigger.end] ?? '') ? ' ' : ''
  return {
    value: `${value.slice(0, trigger.start)}${replacement}${suffix}${value.slice(trigger.end)}`,
    cursor: trigger.start + replacement.length + suffix.length,
  }
}

export function matchingUserSkills<T extends ComposerSkillSource>(
  skills: readonly T[],
  selectedNames: ReadonlySet<string>,
  rawQuery: string,
): T[] {
  const query = rawQuery.toLocaleLowerCase()
  return skills
    .filter(skill => selectedNames.has(skill.name)
      && skill.userInvocable
      && skill.name.toLocaleLowerCase().includes(query))
    .sort((left, right) => Number(!left.name.toLocaleLowerCase().startsWith(query))
      - Number(!right.name.toLocaleLowerCase().startsWith(query))
      || left.name.localeCompare(right.name))
}

export function scrollTopForActiveOption(geometry: OptionScrollGeometry): number {
  if (geometry.optionTop < geometry.viewportTop) {
    return Math.max(0, geometry.scrollTop - (geometry.viewportTop - geometry.optionTop))
  }
  if (geometry.optionBottom > geometry.viewportBottom) {
    return geometry.scrollTop + geometry.optionBottom - geometry.viewportBottom
  }
  return geometry.scrollTop
}
