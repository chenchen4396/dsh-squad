import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { TeamAggregate, TeamConversation } from '../src/domain/types.js'
import type { AgentTeamStore } from '../src/storage/store.js'
import { WorkspaceService } from '../src/service/workspace-service.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('WorkspaceService search', () => {
  it('finds ranked files recursively and skips dependency directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-team-workspace-search-'))
    temporaryDirectories.push(root)
    await mkdir(join(root, 'src', 'components'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'hidden'), { recursive: true })
    await writeFile(join(root, 'src', 'main.ts'), '')
    await writeFile(join(root, 'src', 'components', 'main-button.tsx'), '')
    await writeFile(join(root, 'node_modules', 'hidden', 'main.ts'), '')

    const conversation = {
      schemaVersion: 1,
      id: 'conversation-1',
      teamId: 'team-1',
      title: '会话 1',
      titleSource: 'auto',
      state: 'active',
      workspaceId: 'workspace-1',
      workspacePath: root,
      memberSessions: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revision: 1,
    } satisfies TeamConversation
    const team = {
      id: 'team-1',
      activeConversationId: conversation.id,
    } as TeamAggregate
    const store = {
      getTeam: () => team,
      listTeams: () => [],
      listConversations: () => [conversation],
      getConversation: () => conversation,
    } as unknown as AgentTeamStore
    const ctx = {
      workspaceRegistry: {
        get: () => ({ path: root, status: async () => 'ok' }),
      },
    } as unknown as Context
    const service = new WorkspaceService(ctx, store, () => {}, () => {})

    try {
      await expect(service.search(team.id, conversation.id, 'MAIN', 10)).resolves.toEqual([
        { name: 'main.ts', path: 'src/main.ts', kind: 'file' },
        { name: 'main-button.tsx', path: 'src/components/main-button.tsx', kind: 'file' },
      ])
    } finally {
      await service.dispose()
    }
  })
})
