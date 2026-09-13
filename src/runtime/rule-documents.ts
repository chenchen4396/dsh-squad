/**
 * Rule text handed to one member's system prompt.
 *
 * Documents are whole files imported into the global library; nothing is split
 * into individual rules, so this keeps the original file name for citation.
 */
export interface RuleDocumentContent {
  title: string
  fileName: string
  text: string
}
