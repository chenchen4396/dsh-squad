import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { CatalogCache } from '../src/service/catalog-cache.js'

/**
 * A complete catalog read goes to the network for every provider's models and
 * walks a preset directory that takes tens of seconds on a real machine. A view
 * opening must never wait for that, so the cache's policy is the feature — and
 * it had no test of its own while it lived inside the service.
 */
function context(options: { presets?: () => Promise<unknown[]>; models?: () => Promise<unknown[]> } = {}) {
  const listPresets = options.presets ?? (async () => [{ id: 'standard', name: '标准' }])
  const listModels = options.models ?? (async () => [{ id: 'm', name: 'Model' }])
  return {
    llm: { listProviders: () => [{ id: 'p', name: 'P' }], listModels },
    workspaceRegistry: { list: () => [] },
    permissionPresets: { names: ['workspace-write'], optionOf: (name: string) => ({ value: name, name }) },
    agentPresets: { list: listPresets },
    logger: { warn: vi.fn() },
  } as unknown as Context
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('CatalogCache', () => {
  it('answers the first read with what is local, without waiting for the slow parts', async () => {
    const cache = new CatalogCache(context(), () => {})
    const first = await cache.get()
    // Providers and permissions are local; models and presets arrive behind.
    expect(first.providers).toHaveLength(1)
    expect(first.models).toEqual({})
    expect(first.agentPresets).toEqual([])
  })

  it('serves the complete catalog once the background read lands', async () => {
    const cache = new CatalogCache(context(), () => {})
    await cache.get()
    await tick()
    const complete = await cache.get()
    expect(complete.models.p).toHaveLength(1)
    expect(complete.agentPresets.map(preset => preset.id)).toEqual(['standard'])
  })

  it('serves callers from the same cached value', async () => {
    const cache = new CatalogCache(context(), () => {})
    cache.get()
    await tick()
    const one = await cache.get()
    const two = await cache.get()
    // Rebuilt per caller would cost the network round trip each time.
    expect(two).toBe(one)
  })

  it('reports when the complete answer arrives, so open views can take it', async () => {
    const onChange = vi.fn()
    const cache = new CatalogCache(context(), onChange)
    await cache.get()
    await tick()
    expect(onChange).toHaveBeenCalled()
  })

  it('runs one background read however many callers ask', async () => {
    let reads = 0
    const cache = new CatalogCache(context({
      presets: async () => { reads += 1; return [{ id: 'standard', name: '标准' }] },
    }), () => {})
    await Promise.all([cache.get(), cache.get(), cache.get()])
    await tick()
    expect(reads).toBe(1)
  })

  it('keeps serving a stale catalog when a refresh fails', async () => {
    let call = 0
    const cache = new CatalogCache(context({
      models: async () => {
        call += 1
        if (call > 1) throw new Error('provider unreachable')
        return [{ id: 'm', name: 'Model' }]
      },
    }), () => {})
    await cache.get()
    await tick()
    const complete = await cache.get()
    expect(complete.models.p).toHaveLength(1)
  })

  it('still answers from local data when the slow reads fail', async () => {
    const logger = { warn: vi.fn() }
    const warn = logger.warn
    const ctx = context({ presets: async () => { throw new Error('preset directory unreadable') } })
    ;(ctx as unknown as { logger: { warn: typeof warn } }).logger = logger
    const cache = new CatalogCache(ctx, () => {})

    // A view must open even when the preset directory cannot be read, and the
    // failure must not become an unhandled rejection: this read is
    // fire-and-forget, and a deployment running with
    // `--unhandled-rejections=throw` would be killed by one.
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    try {
      const first = await cache.get()
      await tick()
      await tick()
      expect(first.providers).toHaveLength(1)
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
    expect(logger.warn).toHaveBeenCalled()
    // Nothing was cached, so the next read tries again rather than serving an
    // empty directory as if it were the real one.
    const second = await cache.get()
    expect(second.agentPresets).toEqual([])
  })
})
