import { describe, expect, it } from 'vitest'
import type { RuleDocumentView } from '../src/transport/contracts.js'
import { buildRuleDocumentTree } from '../src/client/rule-documents.js'
import { isMarkdownRulePath, markdownRuleExtensions } from '../src/domain/rule-format.js'

function document(path: string, title = path): RuleDocumentView {
  return {
    id: path,
    path,
    title,
    fileName: path.slice(path.lastIndexOf('/') + 1),
    bytes: 10,
    importedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('buildRuleDocumentTree', () => {
  it('nests documents under the folders they were imported with', () => {
    const tree = buildRuleDocumentTree([
      document('CLAUDE.md'),
      document('rules/code-style.md'),
      document('rules/frontend/design.md'),
    ])

    expect(tree.map(node => node.kind === 'folder' ? `${node.name}/` : node.name))
      .toEqual(['CLAUDE.md', 'rules/'])
    const rules = tree[1]
    if (rules?.kind !== 'folder') throw new Error('unreachable')
    expect(rules.children.map(node => node.kind === 'folder' ? `${node.name}/` : node.name))
      .toEqual(['code-style.md', 'frontend/'])
    const frontend = rules.children[1]
    if (frontend?.kind !== 'folder') throw new Error('unreachable')
    expect(frontend.path).toBe('rules/frontend')
    expect(frontend.children).toHaveLength(1)
  })

  it('lists documents before folders at every level', () => {
    const tree = buildRuleDocumentTree([
      document('rules/a.md'),
      document('b.md'),
      document('a.md'),
    ])

    expect(tree.map(node => node.kind === 'folder' ? `${node.name}/` : node.name))
      .toEqual(['a.md', 'b.md', 'rules/'])
  })

  it('sorts names so the order is stable regardless of import order', () => {
    const tree = buildRuleDocumentTree([
      document('z.md'),
      document('a.md'),
      document('m.md'),
    ])

    expect(tree.map(node => node.kind === 'folder' ? node.name : node.name))
      .toEqual(['a.md', 'm.md', 'z.md'])
  })

  it('handles a document at the root and one deep in a single-segment folder', () => {
    const tree = buildRuleDocumentTree([document('deep/a/b/c.md')])

    const deep = tree[0]
    if (deep?.kind !== 'folder') throw new Error('unreachable')
    expect(deep.path).toBe('deep')
    const a = deep.children[0]
    if (a?.kind !== 'folder') throw new Error('unreachable')
    expect(a.path).toBe('deep/a')
  })

  it('returns an empty tree for no documents', () => {
    expect(buildRuleDocumentTree([])).toEqual([])
  })
})

describe('isMarkdownRulePath', () => {
  it('accepts Markdown documents at any depth and in any case', () => {
    for (const path of ['CLAUDE.md', 'rules/code-style.md', 'rules/frontend/design.MARKDOWN', 'a/b/notes.Md']) {
      expect(isMarkdownRulePath(path)).toBe(true)
    }
  })

  it('rejects everything else a picked folder may contain', () => {
    for (const path of ['style.txt', 'notes', 'design.md.txt', 'rules/config.json', 'image.png']) {
      expect(isMarkdownRulePath(path)).toBe(false)
    }
  })

  it('lists the extensions the picker and the error message share', () => {
    expect(markdownRuleExtensions).toEqual(['.md', '.markdown'])
  })
})
