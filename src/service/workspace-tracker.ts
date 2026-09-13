import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { watch, type FSWatcher } from 'chokidar'

const execFileAsync = promisify(execFile)
const MAX_GIT_CHANGES = 2_000

export type WorkspaceGitChangeKind =
  | 'added'
  | 'copied'
  | 'deleted'
  | 'modified'
  | 'renamed'
  | 'type-changed'
  | 'unmerged'
  | 'untracked'

export interface WorkspaceGitChange {
  path: string
  originalPath?: string
  kind: WorkspaceGitChangeKind
  staged: boolean
  unstaged: boolean
  indexCode: string
  workTreeCode: string
}

export interface WorkspaceGitStatus {
  state: 'repository' | 'not-repository'
  changes: WorkspaceGitChange[]
  truncated: boolean
}

export type WorkspaceGitDiffScope = 'staged' | 'unstaged'

export interface WorkspaceGitDiff {
  path: string
  scope: WorkspaceGitDiffScope
  patch: string
  binary: boolean
}

interface WatchedWorkspace {
  path: string
  fileWatcher: FSWatcher
  gitWatcher: FSWatcher
  timer?: ReturnType<typeof setTimeout>
}

export class WorkspaceTracker {
  private readonly watched = new Map<string, WatchedWorkspace>()

  constructor(
    private readonly onChange: (teamId: string) => void,
    private readonly onError: (teamId: string, error: unknown) => void,
  ) {}

  watch(teamId: string, workspacePath: string): void {
    const current = this.watched.get(teamId)
    if (current?.path === workspacePath) return
    if (current !== undefined) void this.unwatch(teamId)

    const fileWatcher = watch(workspacePath, {
      ignored: [/(^|[/\\])\.git([/\\]|$)/, /(^|[/\\])node_modules([/\\]|$)/],
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 180,
        pollInterval: 50,
      },
    })
    const gitWatcher = watch([
      join(workspacePath, '.git', 'index'),
      join(workspacePath, '.git', 'HEAD'),
      join(workspacePath, '.git', 'refs'),
    ], { ignoreInitial: true })
    const watched: WatchedWorkspace = { path: workspacePath, fileWatcher, gitWatcher }
    this.watched.set(teamId, watched)
    fileWatcher.on('all', () => { this.schedule(teamId) })
    gitWatcher.on('all', () => { this.schedule(teamId) })
    fileWatcher.on('error', error => { this.onError(teamId, error) })
    gitWatcher.on('error', error => { this.onError(teamId, error) })
  }

  async unwatch(teamId: string): Promise<void> {
    const watched = this.watched.get(teamId)
    if (watched === undefined) return
    this.watched.delete(teamId)
    if (watched.timer !== undefined) clearTimeout(watched.timer)
    await Promise.all([watched.fileWatcher.close(), watched.gitWatcher.close()])
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.watched.keys()].map(teamId => this.unwatch(teamId)))
  }

  private schedule(teamId: string): void {
    const watched = this.watched.get(teamId)
    if (watched === undefined) return
    if (watched.timer !== undefined) clearTimeout(watched.timer)
    watched.timer = setTimeout(() => {
      const latest = this.watched.get(teamId)
      if (latest === undefined) return
      delete latest.timer
      this.onChange(teamId)
    }, 220)
  }
}

export async function readWorkspaceGitStatus(workspacePath: string): Promise<WorkspaceGitStatus> {
  const workspaceRoot = await realpath(workspacePath)
  try {
    await lstat(join(workspaceRoot, '.git'))
  } catch (error) {
    if (isMissingPath(error)) return { state: 'not-repository', changes: [], truncated: false }
    throw error
  }
  const rootResult = await execFileAsync('git', ['-C', workspaceRoot, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  })
  const repositoryRoot = await realpath(rootResult.stdout.trim())
  if (repositoryRoot !== workspaceRoot) {
    return { state: 'not-repository', changes: [], truncated: false }
  }

  const result = await execFileAsync('git', [
    '-C',
    workspaceRoot,
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignored=no',
  ], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  const allChanges = parseGitPorcelain(result.stdout)
  return {
    state: 'repository',
    changes: allChanges.slice(0, MAX_GIT_CHANGES),
    truncated: allChanges.length > MAX_GIT_CHANGES,
  }
}

export async function readWorkspaceGitDiff(
  workspacePath: string,
  rawPath: string,
  scope: WorkspaceGitDiffScope,
): Promise<WorkspaceGitDiff> {
  const workspaceRoot = await realpath(workspacePath)
  const status = await readWorkspaceGitStatus(workspaceRoot)
  if (status.state !== 'repository') throw new Error('Workspace is not a Git repository')

  const path = validateGitPath(workspaceRoot, rawPath)
  const change = status.changes.find(candidate => candidate.path === path)
  if (change === undefined) throw new Error(`Git change '${path}' no longer exists`)
  if (scope === 'staged' && !change.staged) throw new Error(`Git change '${path}' has no staged changes`)
  if (scope === 'unstaged' && !change.unstaged) throw new Error(`Git change '${path}' has no unstaged changes`)

  const patch = change.kind === 'untracked'
    ? await diffUntrackedFile(workspaceRoot, path)
    : await runGitDiff([
        '-c',
        'core.quotePath=false',
        '-C',
        workspaceRoot,
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--find-renames',
        ...(scope === 'staged' ? ['--cached'] : []),
        '--',
        path,
      ])

  return {
    path,
    scope,
    patch,
    binary: /^(?:Binary files .* differ|GIT binary patch)$/m.test(patch),
  }
}

export function parseGitPorcelain(output: string): WorkspaceGitChange[] {
  const records = output.split('\0')
  const changes: WorkspaceGitChange[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record || record.length < 4) continue
    const indexCode = record[0] ?? ' '
    const workTreeCode = record[1] ?? ' '
    const path = record.slice(3)
    const renamed = indexCode === 'R' || workTreeCode === 'R'
    const copied = indexCode === 'C' || workTreeCode === 'C'
    const originalPath = renamed || copied ? records[++index] : undefined
    const kind = changeKind(indexCode, workTreeCode)
    changes.push({
      path,
      ...(originalPath === undefined ? {} : { originalPath }),
      kind,
      staged: indexCode !== ' ' && indexCode !== '?',
      unstaged: workTreeCode !== ' ' || indexCode === '?',
      indexCode,
      workTreeCode,
    })
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path))
}

function changeKind(indexCode: string, workTreeCode: string): WorkspaceGitChangeKind {
  const pair = `${indexCode}${workTreeCode}`
  if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(pair)) return 'unmerged'
  if (pair === '??') return 'untracked'
  if (indexCode === 'R' || workTreeCode === 'R') return 'renamed'
  if (indexCode === 'C' || workTreeCode === 'C') return 'copied'
  if (indexCode === 'D' || workTreeCode === 'D') return 'deleted'
  if (indexCode === 'A' || workTreeCode === 'A') return 'added'
  if (indexCode === 'T' || workTreeCode === 'T') return 'type-changed'
  return 'modified'
}

function isMissingPath(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return (error as Error & { code?: string }).code === 'ENOENT'
}

function validateGitPath(workspaceRoot: string, rawPath: string): string {
  if (rawPath.length === 0 || isAbsolute(rawPath)) throw new Error('Git path must be relative')
  const absolutePath = resolve(workspaceRoot, rawPath)
  const workspaceRelativePath = relative(workspaceRoot, absolutePath)
  if (
    workspaceRelativePath.length === 0
    || workspaceRelativePath === '..'
    || workspaceRelativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    || isAbsolute(workspaceRelativePath)
  ) {
    throw new Error('Git path escapes the Workspace')
  }
  return workspaceRelativePath.split(process.platform === 'win32' ? '\\' : '/').join('/')
}

async function diffUntrackedFile(workspaceRoot: string, path: string): Promise<string> {
  const patch = await runGitDiff([
    '-c',
    'core.quotePath=false',
    'diff',
    '--no-index',
    '--no-color',
    '--no-ext-diff',
    '--',
    '/dev/null',
    path,
  ], workspaceRoot)
  if (patch.length > 0) return patch
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n`
}

async function runGitDiff(args: string[], cwd?: string): Promise<string> {
  try {
    const result = await execFileAsync('git', args, {
      ...(cwd === undefined ? {} : { cwd }),
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    return result.stdout
  } catch (error) {
    const failure = error as Error & { code?: number | string, stdout?: string }
    if (failure.code === 1 && typeof failure.stdout === 'string') return failure.stdout
    throw error
  }
}
