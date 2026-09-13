import { readFile, readdir } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const sourceRoot = join(root, 'src')
/**
 * Members are subagents of the Session's own Agent by design: the Leader is the
 * Harness Session itself and every other member is a child Session of it. What
 * the guard still protects is everything that is not a documented integration
 * seam — another plugin's private source, Harness native dialogs, jobs used as
 * an Agent substitute, and Preset services reached around the agent context.
 */
const prohibited = [
  [/@deepseek-ai\/[^'"\s]+\/src\//, 'Harness private source import'],
  [/sessionPersistence\.locate\s*\(/, 'Persistence artifact path access'],
  [/\bctx\.jobs\b/, 'Job runtime used as an Agent substitute'],
  [/\bagentCtx\.agentPresets\b/, 'Agent Presets must be mounted through the injected plugin context'],
  [/\bagentCtx\.permissionPresets\b/, 'Permission Presets must be applied through the injected plugin context'],
  [/\b(?:window|globalThis)\.(?:alert|confirm|prompt)\s*\(/, 'Browser-native dialogs are prohibited; use Harness Modal'],
  [/(^|[^\w.])(?:alert|confirm|prompt)\s*\(/m, 'Browser-native dialogs are prohibited; use Harness Modal'],
]

const violations = []
for (const file of await files(sourceRoot)) {
  const content = await readFile(file, 'utf8')
  for (const [pattern, label] of prohibited) {
    if (pattern.test(content)) violations.push(`${relative(root, file)}: ${label}`)
  }
}

if (violations.length > 0) {
  process.stderr.write(`dsh-squad architecture guard failed:\n${violations.map(item => `- ${item}`).join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('dsh-squad architecture guard passed.\n')
}

async function files(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await files(path))
    else if (['.ts', '.tsx', '.js', '.jsx'].includes(extname(entry.name))) result.push(path)
  }
  return result
}
