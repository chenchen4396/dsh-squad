import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  parseGitPorcelain,
  readWorkspaceGitDiff,
  readWorkspaceGitStatus,
} from '../src/service/workspace-tracker.js'

const execFileAsync = promisify(execFile)

describe('Workspace Git status', () => {
  it('parses staged, unstaged, untracked, renamed, and conflicted records', () => {
    const changes = parseGitPorcelain([
      ' M src/changed.ts',
      '?? src/new.ts',
      'R  src/renamed.ts',
      'src/old.ts',
      'UU src/conflicted.ts',
      '',
    ].join('\0'))

    expect(changes).toEqual([
      expect.objectContaining({ path: 'src/changed.ts', kind: 'modified', staged: false, unstaged: true }),
      expect.objectContaining({ path: 'src/conflicted.ts', kind: 'unmerged', staged: true, unstaged: true }),
      expect.objectContaining({ path: 'src/new.ts', kind: 'untracked', staged: false, unstaged: true }),
      expect.objectContaining({
        path: 'src/renamed.ts',
        originalPath: 'src/old.ts',
        kind: 'renamed',
        staged: true,
        unstaged: false,
      }),
    ])
  })

  it('detects a Git root and returns its current changes', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'agent-team-git-'))
    try {
      await expect(readWorkspaceGitStatus(workspacePath)).resolves.toEqual({
        state: 'not-repository',
        changes: [],
        truncated: false,
      })
      await execFileAsync('git', ['init', workspacePath])
      await writeFile(join(workspacePath, 'new.txt'), 'first\n', 'utf8')

      await expect(readWorkspaceGitStatus(workspacePath)).resolves.toMatchObject({
        state: 'repository',
        changes: [expect.objectContaining({ path: 'new.txt', kind: 'untracked' })],
      })

      await execFileAsync('git', ['-C', workspacePath, 'add', 'new.txt'])
      await writeFile(join(workspacePath, 'new.txt'), 'second\n', 'utf8')
      await expect(readWorkspaceGitStatus(workspacePath)).resolves.toMatchObject({
        state: 'repository',
        changes: [expect.objectContaining({ path: 'new.txt', staged: true, unstaged: true })],
      })

      const nestedPath = join(workspacePath, 'nested')
      await mkdir(nestedPath)
      await expect(readWorkspaceGitStatus(nestedPath)).resolves.toMatchObject({ state: 'not-repository' })
    } finally {
      await rm(workspacePath, { recursive: true, force: true })
    }
  })

  it('returns staged, unstaged, and untracked unified patches', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'agent-team-diff-'))
    try {
      await execFileAsync('git', ['init', workspacePath])
      await writeFile(join(workspacePath, 'tracked.txt'), 'first\n', 'utf8')
      await execFileAsync('git', ['-C', workspacePath, 'add', 'tracked.txt'])
      await execFileAsync('git', [
        '-C', workspacePath,
        '-c', 'user.name=dsh-squad',
        '-c', 'user.email=dsh-squad@example.invalid',
        'commit', '-m', 'initial',
      ])

      await writeFile(join(workspacePath, 'tracked.txt'), 'second\n', 'utf8')
      const unstaged = await readWorkspaceGitDiff(workspacePath, 'tracked.txt', 'unstaged')
      expect(unstaged).toMatchObject({ path: 'tracked.txt', scope: 'unstaged', binary: false })
      expect(unstaged.patch).toContain('@@')
      expect(unstaged.patch).toContain('-first')
      expect(unstaged.patch).toContain('+second')

      await execFileAsync('git', ['-C', workspacePath, 'add', 'tracked.txt'])
      const staged = await readWorkspaceGitDiff(workspacePath, 'tracked.txt', 'staged')
      expect(staged.patch).toContain('-first')
      expect(staged.patch).toContain('+second')

      await writeFile(join(workspacePath, 'untracked.txt'), 'new file\n', 'utf8')
      const untracked = await readWorkspaceGitDiff(workspacePath, 'untracked.txt', 'unstaged')
      expect(untracked.patch).toContain('new file')
      expect(untracked.patch).toContain('+new file')
    } finally {
      await rm(workspacePath, { recursive: true, force: true })
    }
  })
})
