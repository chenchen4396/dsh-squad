import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { registerScopedSkillProvider } from '../src/runtime/scoped-skills.js'

describe('scoped skill provider', () => {
  it('declares the skills dependency before registering in an agent context', async () => {
    const root = new Context()
    const registerProvider = vi.fn()
    root.provide('skills', { registerProvider } as never)
    let agentCtx: Context | undefined
    const owner = root.inject([], ctx => { agentCtx = ctx })
    await owner
    const create = vi.fn(() => ({
      name: 'selection',
      list: async () => [],
      get: async () => undefined,
    }))

    await registerScopedSkillProvider(agentCtx!, create)

    expect(registerProvider).toHaveBeenCalledOnce()
    expect(registerProvider).toHaveBeenCalledWith(create)
    await owner.dispose()
  })
})
