/**
 * Add or remove one name in a sorted selection.
 *
 * Membership lists are stored and displayed sorted, and the same rule was
 * written out at every picker — skills, MCP servers, rule documents — each
 * time by hand. One place means one behaviour, and this one is testable
 * without a component.
 */
export function toggleSorted(values: readonly string[], name: string, selected: boolean): string[] {
  return selected
    ? [...values.filter(value => value !== name), name].sort()
    : values.filter(value => value !== name)
}
