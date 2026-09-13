import { describe, expect, it } from 'vitest'
import { insertWorkspaceFileMention, workspaceFileMention } from '../src/client/file-mentions.js'

describe('Workspace file mentions', () => {
  it('quotes paths that contain whitespace', () => {
    expect(workspaceFileMention('docs/my plan.md')).toBe('@"docs/my plan.md"')
    expect(workspaceFileMention('src/main.ts')).toBe('@src/main.ts')
  })

  it('inserts a mention at the current cursor with readable spacing', () => {
    expect(insertWorkspaceFileMention('检查文件', 4, 4, 'src/main.ts')).toEqual({
      value: '检查文件 @src/main.ts',
      cursor: 17,
    })
  })

  it('replaces selected text and preserves surrounding content', () => {
    expect(insertWorkspaceFileMention('查看 old 然后修改', 3, 6, 'docs/my plan.md')).toEqual({
      value: '查看 @"docs/my plan.md" 然后修改',
      cursor: 21,
    })
  })
})
