import { describe, expect, it, vi } from 'vitest'
import {
  DomainAssistantBuilderModelPreferenceStore,
} from '../src/storage/assistant-builder-preferences.js'

describe('DomainAssistantBuilderModelPreferenceStore', () => {
  it('persists per-conversation models and the latest explicit selection', async () => {
    let snapshot = {
      schemaVersion: 1 as const,
      conversationModels: {},
    }
    const global = {
      get: vi.fn(() => snapshot),
      set: vi.fn(async next => {
        snapshot = next
      }),
    }
    const store = new DomainAssistantBuilderModelPreferenceStore({ global } as never)

    await store.setConversationModel('conversation-1', 'deepseek', 'flash')

    expect(store.getConversationModel('conversation-1')).toEqual({
      provider: 'deepseek',
      model: 'flash',
    })
    expect(store.getLastSelectedModel()).toBeUndefined()

    await store.setSelectedModel('conversation-2', 'zai', 'glm')

    expect(store.getConversationModel('conversation-1')).toEqual({
      provider: 'deepseek',
      model: 'flash',
    })
    expect(store.getConversationModel('conversation-2')).toEqual({
      provider: 'zai',
      model: 'glm',
    })
    expect(store.getLastSelectedModel()).toEqual({
      provider: 'zai',
      model: 'glm',
    })

    await store.setLastSelectedModel('deepseek', 'reasoner')

    expect(store.getLastSelectedModel()).toEqual({
      provider: 'deepseek',
      model: 'reasoner',
    })
    expect(store.getConversationModel('conversation-2')).toEqual({
      provider: 'zai',
      model: 'glm',
    })
    expect(global.set).toHaveBeenCalledTimes(3)
  })
})
