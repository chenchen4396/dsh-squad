import type {
  CreateAssistantInput,
  UpdateAssistantInput,
} from '../../domain/types.js'
import type {
  AssistantView,
  PageView,
  RuleDocumentCatalogView,
  RuleDocumentContentView,
} from '../contracts.js'

/** Assistant templates, and the rule documents they load. */
export interface AssistantsRequests {
  'assistant.list': { payload: undefined; result: PageView<AssistantView> }
  'assistant.get': { payload: { id: string }; result: AssistantView }
  'assistant.create': { payload: CreateAssistantInput; result: AssistantView }
  'assistant.update': { payload: { id: string; value: UpdateAssistantInput }; result: AssistantView }
  'assistant.clone': { payload: { id: string; name?: string }; result: AssistantView }
  'assistant.delete': { payload: { id: string }; result: null }
  'assistant.ruleDocuments.list': {
    payload: undefined
    result: RuleDocumentCatalogView
  }
  'assistant.ruleDocuments.get': {
    payload: { id: string }
    result: RuleDocumentContentView
  }
  'assistant.ruleDocuments.import': {
    payload: { path: string; content: string }
    result: RuleDocumentCatalogView
  }
  'assistant.ruleDocuments.delete': {
    payload: { id: string }
    result: RuleDocumentCatalogView
  }
}
