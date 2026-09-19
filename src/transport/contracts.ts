import type {
  BundleImportSummary,
  BundleImportMode,
  SquadBundle,
} from '../domain/bundle.js'
import type {
  AddTeamMemberInput,
  AssistantTemplate,
  CloneTeamInput,
  CreateAssistantInput,
  CreateTeamDraftInput,
  TeamAggregate,
  TeamConversation,
  TeamMessage,
  UpdateAssistantInput,
} from '../domain/types.js'

export const AGENT_TEAM_API_PATH = '/agent-team/api'
export const AGENT_TEAM_EVENTS_PATH = '/agent-team/events'
export const AGENT_TEAM_UPLOAD_PATH = '/agent-team/upload'

export const AGENT_TEAM_METHODS = [
  'catalog.get',
  'catalog.model.get',
  'skill.catalog',
  'mcp.catalog',
  'assistant.list',
  'assistant.get',
  'assistant.create',
  'assistant.update',
  'assistant.clone',
  'assistant.delete',
  'assistant.builder.list',
  'assistant.builder.draft.get',
  'assistant.builder.draft.configure',
  'assistant.builder.start',
  'assistant.builder.get',
  'assistant.builder.configure',
  'assistant.builder.send',
  'assistant.builder.interaction.respond',
  'assistant.builder.stop',
  'assistant.builder.archive',
  'team.list',
  'team.get',
  'team.createDraft',
  'team.clone',
  'team.start',
  'team.addMember',
  'team.removeMember',
  'team.changeLeader',
  'team.message.list',
  'team.message.send',
  'team.workbench.get',
  'team.workbench.older',
  'team.session.get',
  'team.session.bind',
  'team.session.unbind',
  'team.session.delegate',
  'team.conversation.list',
  'team.room.get',
  'team.room.older',
  'team.room.send',
  'team.member.stop',
  'team.interaction.respond',
  'assistant.ruleDocuments.list',
  'assistant.ruleDocuments.get',
  'assistant.ruleDocuments.import',
  'bundle.export',
  'bundle.import',
  'assistant.ruleDocuments.delete',
  'team.workspace.list',
  'team.workspace.search',
  'team.workspace.changes',
  'team.workspace.diff',
  'team.dissolve',
] as const

export type AgentTeamMethod = typeof AGENT_TEAM_METHODS[number]

export type AssistantView = AssistantTemplate
export type TeamView = TeamAggregate

export interface PageView<T> {
  items: T[]
  total: number
}

export interface CatalogView {
  providers: Array<{ id: string; name: string }>
  models: Record<string, Array<{ id: string; name: string; description?: string }>>
  agentPresets: Array<{ id: string; name: string; description?: string; broken?: string }>
  permissionPresets: Array<{ value: string; name: string; description?: string }>
  workspaces: Array<{ id: string; path: string; title: string; status: 'ok' | 'missing-dir' }>
}

export interface ModelCapabilitiesView {
  provider: string
  model: string
  reasoning?: {
    efforts: Array<{ id: string; name: string; description?: string }>
    defaultEffort?: string
  }
}

export interface SkillCatalogView {
  agentPresetId: string
  skills: Array<{
    name: string
    description: string
    source: string
    modelInvocable: boolean
    userInvocable: boolean
  }>
}

export interface McpCatalogView {
  agentPresetId: string
  servers: Array<{
    name: string
    tools: Array<{ name: string; description: string }>
  }>
}

export type ConversationNode =
  | {
    id: string
    kind: 'user' | 'assistant'
    seq: number
    time: number
    text: string
    /**
     * DSH turn that produced this message. One turn is one interaction and can
     * hold a dozen assistant messages, so the room groups by it: it shows one
     * utterance per turn instead of every message between two tool calls.
     */
    turn?: number
    /**
     * Whether the reader's own input opened this turn, rather than the team's
     * own traffic (an assignment, a progress tick, another member's message).
     * The room shows what answers the reader.
     */
    fromReader?: boolean
    reasoning?: string
    reasoningStartedAt?: number
    reasoningCompletedAt?: number
    streaming?: boolean
  }
  | {
    id: string
    kind: 'team-message'
    seq: number
    time: number
    text: string
    senderName: string
    senderId: string
    senderRole: 'leader' | 'member' | 'system'
    messageType: 'instruction' | 'progress' | 'result' | 'question' | 'warning' | 'system'
    relatedTaskId?: string
  }
  | {
    id: string
    kind: 'tool'
    seq: number
    time: number
    callId: string
    name: string
    arguments: string
    status: 'running' | 'success' | 'error'
    result?: string
    error?: string
  }
  | {
    id: string
    kind: 'notice'
    seq: number
    time: number
    tone: 'neutral' | 'error' | 'warning'
    text: string
  }

export interface QuestionOptionView {
  label: string
  description?: string
}

export interface QuestionItemView {
  id: string
  question: string
  detail?: string
  header?: string
  options?: QuestionOptionView[]
  multiSelect?: boolean
  intent?: {
    kind: 'plan-review'
    approve: string
  }
}

export type PendingInteractionView = {
  id: string
  /**
   * When the member asked. The plugin hands every member request to the Leader
   * first; this is what a reader's fallback waits on.
   */
  askedAt: number
  /**
   * «替我审批» asked for this one to be the Leader's alone: the reader is never
   * offered it, however long it stays pending.
   */
  leaderOnly?: boolean
} & (
  | {
    kind: 'question'
    questions: QuestionItemView[]
  }
  | {
    kind: 'approval'
    approvalId: string
    toolName: string
    callId?: string
    reason?: string
    /** Wider sandbox level the call asked for, when it asked to escalate. */
    requestedMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
    /**
     * Whether this one is the reader's to answer: a request wider than the
     * Leader's own level cannot be granted by the Leader at all.
     */
    userOnly?: boolean
  }
)

export interface QuestionAnswerView {
  id: string
  selected: string[]
  custom?: string
}

export type InteractionResponseInput =
  | {
    kind: 'question'
    answers: QuestionAnswerView[]
  }
  | {
    kind: 'approval'
    outcome: 'allowed-once' | 'rejected'
  }

export interface MemberConversationView {
  slotId: string
  /** Conversation this Session belongs to; live updates carry it for filtering. */
  conversationId: string
  sessionId?: string
  throughSeq: number
  status: 'offline' | 'starting' | 'idle' | 'running' | 'waiting_approval' | 'error'
  nodes: ConversationNode[]
  /** Whether this member's Session has nodes before the shown window. */
  hasMore?: boolean
  /** Seq of the shown window's oldest node; the cursor for the previous page. */
  oldestSeq?: number
  pendingInteractions: PendingInteractionView[]
  contextUsage?: {
    usedTokens: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
    contextWindow?: number
  }
}

export interface TeamWorkbenchView {
  schemaVersion: 1
  teamId: string
  revision: number
  conversation: ConversationView
  conversations: MemberConversationView[]
}

/** One task conversation ("meeting room") of a team. */
export type ConversationView = TeamConversation

/**
 * The team one Harness Session has enabled, if any.
 *
 * A conversation is a binding now: the Session's own Agent is the Leader, and
 * `conversation.sessionId` names the Harness Session the user is looking at.
 */
export interface SessionBindingView {
  sessionId: string
  team?: TeamView
  conversation?: ConversationView
}

/** One rule file discovered under `<workspace>/.agent-team/rules`. */
/**
 * One imported rule document. Metadata only — the body is fetched with
 * `assistant.ruleDocuments.get` so `assistant.list` stays small.
 */
export interface RuleDocumentView {
  id: string
  /** Location relative to the import root, e.g. `rules/frontend/design.md`. */
  path: string
  title: string
  fileName: string
  bytes: number
  importedAt: string
}

export interface RuleDocumentCatalogView {
  items: RuleDocumentView[]
  total: number
  /**
   * Largest single document this deployment accepts. The client checks it
   * before uploading, so an oversized file is reported precisely instead of
   * coming back as a generic "request body too large".
   */
  limitBytes: number
}

/** A document plus its text, for the preview in the assistant editor. */
export interface RuleDocumentContentView extends RuleDocumentView {
  content: string
}

export interface RoomParticipantView {
  slotId: string
  displayName: string
  role: 'leader' | 'member'
  status: MemberConversationView['status']
}

/**
 * A single utterance in the shared room timeline. Agent replies are projected
 * from their own Session events; user and team messages come from the durable
 * team mailbox.
 */
export interface RoomMessageView {
  id: string
  kind: 'user' | 'agent' | 'system' | 'tool' | 'notice'
  seq: number
  time: number
  text: string
  senderName: string
  senderRole: 'user' | 'leader' | 'member' | 'system'
  senderSlotId?: string
  messageType?: TeamMessage['type']
  reasoning?: string
  streaming?: boolean
  mentions?: string[]
}

export interface RoomView {
  schemaVersion: 1
  teamId: string
  conversation: ConversationView
  participants: RoomParticipantView[]
  messages: RoomMessageView[]
  throughSeq: number
  /** Whether entries exist before the shown window. */
  hasMore: boolean
  /** Stamp of the shown window's oldest entry; the cursor for the previous page. */
  oldestTime?: number
}

export interface AssistantBuilderConversationView {
  schemaVersion: 1
  sessionId: string
  status: 'starting' | 'idle' | 'running' | 'error'
  throughSeq: number
  nodes: ConversationNode[]
  pendingInteractions: PendingInteractionView[]
  configuration: {
    provider: string
    model: string
    agentPresetId: string
    permissionPresetId: string
  }
}

export interface AssistantBuilderConversationSummary {
  sessionId: string
  title: string
  createdAt: string
  updatedAt: string
  state: 'new' | 'in_progress' | 'completed'
}

export interface AssistantBuilderConversationListView {
  items: AssistantBuilderConversationSummary[]
  total: number
}

export interface AssistantBuilderDraftView {
  schemaVersion: 1
  configuration: AssistantBuilderConversationView['configuration']
}

export interface WorkspaceEntryView {
  name: string
  path: string
  kind: 'file' | 'directory' | 'symlink'
}

export interface WorkspaceGitChangeView {
  path: string
  originalPath?: string
  kind: 'added' | 'copied' | 'deleted' | 'modified' | 'renamed' | 'type-changed' | 'unmerged' | 'untracked'
  staged: boolean
  unstaged: boolean
  indexCode: string
  workTreeCode: string
}

export interface WorkspaceGitStatusView {
  state: 'repository' | 'not-repository'
  changes: WorkspaceGitChangeView[]
  truncated: boolean
}

export interface WorkspaceGitDiffView {
  path: string
  scope: 'staged' | 'unstaged'
  layout: 'unified' | 'split'
  theme: 'light' | 'dark'
  html: string
  binary: boolean
}

export interface WorkspaceUploadView {
  name: string
  path: string
  bytes: number
}

import type { AgentTeamRequestMap as RequestMap } from './requests/index.js'
import type { ParsedInteractionResponse } from './payload-schemas.js'

export type { AgentTeamRequestMap } from './requests/index.js'

export type AgentTeamPayload<M extends AgentTeamMethod> = RequestMap[M]['payload']
export type AgentTeamResult<M extends AgentTeamMethod> = RequestMap[M]['result']

export interface AgentTeamRequest {
  requestId: string
  method: AgentTeamMethod
  expectedRevision?: number
  payload: unknown
}

export type AgentTeamResponse =
  | { requestId: string; ok: true; value: unknown }
  | {
    requestId: string
    ok: false
    error: {
      code: string
      message: string
      details?: Readonly<Record<string, unknown>>
    }
  }
