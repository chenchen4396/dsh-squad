import { describe, expect, it, vi } from 'vitest'
import { resolveConfiguration, type BuilderConfigDeps } from '../src/runtime/assistant-builder-config.js'

/**
 * Which model, preset and permission the Assistant Builder runs with.
 *
 * Three sources, in order: what the reader picked for this conversation, what
 * they picked last time, and what the deployment configures. Each is checked —
 * a provider that no longer exists, a model removed from the catalog, a preset
 * the Harness does not have — because the builder otherwise fails to start with
 * an adapter error that names none of them.
 */
function harness(options: {
  selected?: { provider: string; model: string }
  persisted?: { provider: string; model: string }
  lastSelected?: { provider: string; model: string }
  providers?: string[]
  models?: Record<string, string[]>
  permissionNames?: string[]
} = {}): BuilderConfigDeps {
  const providers = options.providers ?? ['commandcode']
  const models = options.models ?? { commandcode: ['deepseek/deepseek-v4.1-flash'] }
  const config = {
    assistantBuilderProvider: '',
    assistantBuilderModel: '',
    assistantBuilderAgentPresetId: '',
    assistantBuilderPermissionPresetId: '',
  }
  return {
    config: config as never,
    modelPreferences: {
      getConversationModel: () => options.persisted,
      getLastSelectedModel: () => options.lastSelected,
    },
    configurations: new Map(options.selected === undefined ? [] : [['s1', {
      provider: options.selected.provider,
      model: options.selected.model,
      agentPresetId: 'standard',
      permissionPresetId: 'read-only',
    }]]),
    ctx: {
      llm: {
        listProviders: () => providers.map(id => ({ id })),
        listModels: async (id: string) => (models[id] ?? []).map(m => ({ id: m })),
        resolveModelInfo: vi.fn(async () => ({})),
      },
      agentPresets: { defaultId: 'standard', resolve: vi.fn(async () => ({})) },
      permissionPresets: {
        names: options.permissionNames ?? ['read-only', 'workspace-write'],
        defaultPreset: 'workspace-write',
      },
    },
  } as unknown as BuilderConfigDeps
}

describe('the builder configuration', () => {
  it('takes the first provider and model when nothing is configured', async () => {
    const result = await resolveConfiguration(harness(), 's1')
    expect(result.provider).toBe('commandcode')
    expect(result.model).toBe('deepseek/deepseek-v4.1-flash')
  })

  it('prefers what the reader picked for this conversation', async () => {
    const deps = harness({
      selected: { provider: 'opencode', model: 'kimi' },
      providers: ['commandcode', 'opencode'],
      models: { commandcode: ['x'], opencode: ['kimi'] },
    })
    expect((await resolveConfiguration(deps, 's1')).provider).toBe('opencode')
  })

  it('falls back to the last model the reader picked', async () => {
    const deps = harness({
      lastSelected: { provider: 'opencode', model: 'kimi' },
      providers: ['commandcode', 'opencode'],
      models: { commandcode: ['x'], opencode: ['kimi'] },
    })
    expect((await resolveConfiguration(deps, 's1')).model).toBe('kimi')
  })

  it('refuses a model with no provider to run it on', async () => {
    const deps = harness()
    ;(deps.config as { assistantBuilderModel: string }).assistantBuilderModel = 'kimi'
    // Which provider would run it is unknowable, so it is refused rather than guessed.
    await expect(resolveConfiguration(deps, 's1')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('names a provider that no longer exists', async () => {
    const deps = harness()
    ;(deps.config as { assistantBuilderProvider: string }).assistantBuilderProvider = 'opencode-go'
    await expect(resolveConfiguration(deps, 's1')).rejects.toMatchObject({ code: 'MODEL_REFERENCE_INVALID' })
    await expect(resolveConfiguration(deps, 's1')).rejects.toThrowError(/opencode-go/)
  })

  it('refuses when there is no provider at all', async () => {
    await expect(resolveConfiguration(harness({ providers: [] }), 's1'))
      .rejects.toMatchObject({ code: 'MODEL_REFERENCE_INVALID' })
  })

  it('names a model that was taken out of the catalog', async () => {
    const deps = harness({
      selected: { provider: 'commandcode', model: 'gone' },
    })
    await expect(resolveConfiguration(deps, 's1')).rejects.toThrowError(/gone/)
  })

  it('runs the builder read-only when the Harness offers that level', async () => {
    // The designer describes assistants; it has no business editing anything.
    expect((await resolveConfiguration(harness(), 's1')).permissionPresetId).toBe('read-only')
  })

  it('falls back to the default level when read-only is not offered', async () => {
    const deps = harness({ permissionNames: ['workspace-write', 'danger-full-access'] })
    expect((await resolveConfiguration(deps, 's1')).permissionPresetId).toBe('workspace-write')
  })

  it('refuses a permission preset the Harness does not have', async () => {
    const deps = harness()
    ;(deps.config as { assistantBuilderPermissionPresetId: string }).assistantBuilderPermissionPresetId = 'root'
    await expect(resolveConfiguration(deps, 's1'))
      .rejects.toMatchObject({ code: 'PERMISSION_PRESET_INVALID' })
  })
})
