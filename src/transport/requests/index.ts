import type { AssistantBuilderRequests } from './assistantbuilder.js'
import type { AssistantsRequests } from './assistants.js'
import type { BundlesRequests } from './bundles.js'
import type { CatalogRequests } from './catalog.js'
import type { ConversationsRequests } from './conversations.js'
import type { TeamsRequests } from './teams.js'
import type { WorkspaceRequests } from './workspace.js'

/**
 * Every API method's payload and result, assembled by subject.
 *
 * This is the contract the client and the transport both read: the client types
 * its calls from it, and the dispatch tables implement it. Splitting it by
 * subject means the answer to "what does an assistant method take" is in the
 * assistant file, next to the handler for it rather than 400 lines away in one
 * alphabetical list.
 */
export interface AgentTeamRequestMap
  extends CatalogRequests,
    AssistantsRequests,
    AssistantBuilderRequests,
    TeamsRequests,
    ConversationsRequests,
    WorkspaceRequests,
    BundlesRequests {}
