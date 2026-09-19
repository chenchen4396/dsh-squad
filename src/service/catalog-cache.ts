import type { Context } from '@deepseek-ai/cordis'
import type { CatalogSnapshot } from './agent-team-service.js'

/**
 * The deployment's catalog, cached.
 *
 * A complete read is expensive and slow: every provider's model list over the
 * network, and a walk of the preset directory that takes tens of seconds on a
 * real machine. A view opening must never wait for that, so the cache answers
 * with what it has, reads behind the reader, and reports when the complete
 * answer arrives.
 *
 * It owns that policy and the four fields it needs, which is why it is not
 * simply more methods on the service.
 */
const CATALOG_TTL_MS = 5 * 60_000

const PERMISSION_PRESET_LABELS: Readonly<Record<string, string>> = {
  'read-only': '只读',
  'workspace-write': '工作区可写',
  'danger-full-access': '完全访问',
  standard: '标准',
}

export class CatalogCache {
  private value?: CatalogSnapshot
  private readAt = 0
  /** The one complete read in flight, shared by every caller. */
  private read: Promise<void> | undefined
  /** Last agent-preset list read; the service behind it takes tens of seconds. */
  private presets: CatalogSnapshot['agentPresets'] | undefined

  /**
   * The catalog a view can have right now.
   *
   * A complete read is slow — every provider's model list over the network,
   * and a preset walk that takes tens of seconds on a real machine — so a view
   * opening never waits for it. The last complete read answers at once (a stale
   * one refreshes behind the reader); the first-ever read answers with what is
   * already local, and the refresh publishes, so open views take the whole
   * directory a moment later.
   */
  async get(): Promise<CatalogSnapshot> {
    const cached = this.value
    if (cached !== undefined) {
      if (Date.now() - this.readAt > CATALOG_TTL_MS) void this.refresh()
      return cached
    }
    void this.refresh()
    return this.basics()
  }

  /**
   * The catalog without its two slow reads: no provider round trip, and no
   * preset walk. Both are filled in by {@link readCatalog}; this is what a view
   * opening can have right now.
   */
  private async basics(): Promise<CatalogSnapshot> {
    const providers = this.ctx.llm.listProviders()
    const workspaces = await Promise.all(this.ctx.workspaceRegistry.list().map(async workspace => ({
      id: String(workspace.id),
      path: workspace.path,
      title: workspace.title,
      status: await workspace.status(),
    })))
    return {
      providers,
      models: this.value?.models ?? {},
      agentPresets: this.presets ?? [],
      permissionPresets: this.ctx.permissionPresets.names.map(name => {
        const option = this.ctx.permissionPresets.optionOf(name)
        return {
          ...option,
          name: PERMISSION_PRESET_LABELS[option.value] ?? option.name,
        }
      }),
      workspaces,
    }
  }

  /** The complete catalog: every provider's model list and the preset directory. */
  private async complete(): Promise<CatalogSnapshot> {
    const basics = await this.basics()
    const presets = await this.ctx.agentPresets.list()
    this.presets = presets.map(preset => ({
      id: preset.id,
      name: preset.name ?? preset.id,
      ...(preset.description === undefined ? {} : { description: preset.description }),
      ...(preset.broken === undefined ? {} : { broken: preset.broken }),
    }))
    const modelEntries = await Promise.all(basics.providers.map(async provider => [
      provider.id,
      (await this.ctx.llm.listModels(provider.id)).map(model => ({
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
      })),
    ] as const))
    return {
      ...basics,
      models: Object.fromEntries(modelEntries),
      agentPresets: this.presets,
    }
  }

  /** Rebuild the complete catalog once, however many callers ask for it. */
  private refresh(): Promise<void> {
    if (this.read !== undefined) return this.read
    const read: Promise<void> = this.complete()
      .then(value => {
        this.value = value
        this.readAt = Date.now()
        // Views holding the partial directory take the complete one now.
        this.onChange()
      })
      .catch(error => {
        // This read is fire-and-forget: `get` has already answered with what
        // is local and nobody awaits this promise. Letting it reject would be
        // an unhandled rejection — which a deployment running with
        // `--unhandled-rejections=throw` turns into a dead process — so a
        // failure is reported here and nothing more. A stale directory still
        // beats none, and the next read tries again.
        this.ctx.logger.warn('agent-team: catalog refresh failed', error)
      })
      .finally(() => {
        if (this.read === read) this.read = undefined
      })
    this.read = read
    return read
  }


  constructor(
    private readonly ctx: Context,
    private readonly onChange: () => void,
  ) {}
}
