import type {
  AssistantBuilderConversationListView,
  AssistantBuilderConversationView,
  AssistantBuilderDraftView,
  InteractionResponseInput,
} from '../contracts.js'

/** The chat that designs an assistant. */
export interface AssistantBuilderRequests {
  'assistant.builder.list': { payload: undefined; result: AssistantBuilderConversationListView }
  'assistant.builder.draft.get': { payload: undefined; result: AssistantBuilderDraftView }
  'assistant.builder.draft.configure': {
    payload: { provider: string; model: string }
    result: AssistantBuilderDraftView
  }
  'assistant.builder.start': {
    payload: { provider: string; model: string; content: string }
    result: AssistantBuilderConversationView
  }
  'assistant.builder.get': { payload: { sessionId: string }; result: AssistantBuilderConversationView }
  'assistant.builder.configure': {
    payload: { sessionId: string; provider: string; model: string }
    result: AssistantBuilderConversationView
  }
  'assistant.builder.send': {
    payload: { sessionId: string; content: string }
    result: { messageId: string }
  }
  'assistant.builder.interaction.respond': {
    payload: {
      sessionId: string
      interactionId: string
      response: InteractionResponseInput
    }
    result: { accepted: boolean }
  }
  'assistant.builder.stop': { payload: { sessionId: string }; result: { accepted: boolean } }
  'assistant.builder.archive': { payload: { sessionId: string }; result: { archived: boolean } }
}
