import type { RuleDocumentView } from '../transport/contracts.js'

export interface RuleDocumentFolder {
  kind: 'folder'
  /** Segment name, e.g. `frontend`. */
  name: string
  /** Full path of the folder, e.g. `rules/frontend`. */
  path: string
  children: RuleDocumentNode[]
}

export interface RuleDocumentLeaf {
  kind: 'document'
  name: string
  document: RuleDocumentView
}

export type RuleDocumentNode = RuleDocumentFolder | RuleDocumentLeaf

/**
 * Group imported documents by their path so the picker mirrors the folder
 * layout that was imported (`rules/frontend/design.md`).
 *
 * Folders are display-only: loading is still chosen per document. Documents sort
 * before folders at each level, matching how the layout is usually drawn.
 */
export function buildRuleDocumentTree(
  documents: readonly RuleDocumentView[],
): RuleDocumentNode[] {
  const roots: RuleDocumentNode[] = []
  const folders = new Map<string, RuleDocumentFolder>()

  const folderFor = (segments: readonly string[]): RuleDocumentNode[] => {
    let children = roots
    let path = ''
    for (const segment of segments) {
      path = path.length === 0 ? segment : `${path}/${segment}`
      let folder = folders.get(path)
      if (folder === undefined) {
        folder = { kind: 'folder', name: segment, path, children: [] }
        folders.set(path, folder)
        children.push(folder)
      }
      children = folder.children
    }
    return children
  }

  for (const document of documents) {
    const segments = document.path.split('/').filter(segment => segment.length > 0)
    const name = segments.pop() ?? document.fileName
    folderFor(segments).push({ kind: 'document', name, document })
  }

  return sortNodes(roots)
}

function sortNodes(nodes: RuleDocumentNode[]): RuleDocumentNode[] {
  const sorted = [...nodes].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'document' ? -1 : 1
    return left.name.localeCompare(right.name)
  })
  for (const node of sorted) {
    if (node.kind === 'folder') node.children = sortNodes(node.children)
  }
  return sorted
}
