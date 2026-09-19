import { describe, expect, it } from 'vitest'
import { AssistantDraftStore, type PendingAssistantDraft } from '../src/runtime/assistant-builder-drafts.js'

function draft(name: string, preparedThroughSeq = 1): PendingAssistantDraft {
  return { input: { name } as never, preparedThroughSeq }
}

/**
 * A draft is a configuration the user was shown and has not approved yet. The
 * rules that matter are about which draft an approval applies to, so they are
 * pinned here rather than left to the tool call that happens to read the map.
 */
describe('AssistantDraftStore', () => {
  it('keeps one draft per Session', () => {
    const store = new AssistantDraftStore()
    store.put('s1', draft('first'))
    store.put('s1', draft('second'))
    // The user is looking at one configuration; preparing again replaces it.
    expect(store.get('s1')?.input.name).toBe('second')
  })

  it('keeps Sessions apart, so two designers cannot approve each other', () => {
    const store = new AssistantDraftStore()
    store.put('s1', draft('mine'))
    store.put('s2', draft('theirs'))
    expect(store.get('s1')?.input.name).toBe('mine')
    expect(store.get('s2')?.input.name).toBe('theirs')
  })

  it('returns undefined for a Session that prepared nothing', () => {
    expect(new AssistantDraftStore().get('s1')).toBeUndefined()
  })

  it('discards the draft it was given', () => {
    const store = new AssistantDraftStore()
    const mine = draft('mine')
    store.put('s1', mine)
    store.discard('s1', mine)
    expect(store.get('s1')).toBeUndefined()
  })

  it('leaves a newer draft alone when an older approval lands', () => {
    const store = new AssistantDraftStore()
    const older = draft('older')
    store.put('s1', older)
    // The user prepared again while the first approval was in flight.
    const newer = draft('newer')
    store.put('s1', newer)

    store.discard('s1', older)
    // Approving the older draft must not throw away the one on screen now.
    expect(store.get('s1')?.input.name).toBe('newer')
  })

  it('clears whatever the Session holds', () => {
    const store = new AssistantDraftStore()
    store.put('s1', draft('x'))
    store.clear('s1')
    expect(store.get('s1')).toBeUndefined()
  })
})
