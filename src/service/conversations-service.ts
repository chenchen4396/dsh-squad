import type { Context } from '@deepseek-ai/cordis'
import { fallbackSessionTitle } from '@deepseek-ai/dsh-session-title'
import { randomUUID } from 'node:crypto'
import { AgentTeamError } from '../domain/errors.js'
import type { Page } from '../domain/types.js'
import type { MemberConversationView } from '../transport/contracts.js'
import type {
  TeamAggregate,
  TeamConversation,
  TeamMessage,
} from '../domain/types.js'
import type { AgentTeamStore } from '../storage/store.js'
import { requireTeam } from './store-guards.js'

/**
 * Conversations: the record that binds a team to a Harness Session.
 *
 * A conversation is what makes a team run somewhere — it holds the Session id,
 * each member's own Session, and the copy the sidebar shows. It is also the
 * thing the runtime reads to find out which team a Session belongs to, so the
 * records have to be written before the runtime is told, and removed only after
 * it has stopped.
 */

/**
 * Native session-title fallback limits, taken from the shipped `session-title`
 * defaults so a team conversation gets exactly the title a DSH Session would
 * get from the same first message.
 */
const AUTO_TITLE_WORDS = 5
const AUTO_TITLE_BYTES = 40

/** What the sidebar shows about a conversation beyond its stored record. */
export interface ConversationDisplay {
  /** Earliest user message text; absent when nobody has spoken yet. */
  firstUserText?: string
  /** Latest activity in epoch ms. */
  lastActivity: number
}

/** What conversation records need from the service that owns them. */
export interface ConversationDeps {
  store: AgentTeamStore
  /** Tell open views a conversation changed. */
  publish: (
    entityType: 'conversation' | 'team',
    entityId: string,
    revision: number,
    kind: string,
    conversation?: MemberConversationView,
  ) => void
  /** The workspace a new conversation runs in, or a refusal. */
  requireWorkspace: (workspaceId: string) => Promise<{ path: string; id: string }>
  /** The runtime, once attached; binding a Session needs it. */
  requireRuntime: () => {
    bindSession: (sessionId: string, teamId: string) => Promise<TeamConversation>
    unbindSession: (sessionId: string) => Promise<void>
    setSessionDelegation: (sessionId: string, delegate: boolean) => Promise<TeamConversation>
  }
  /** The current time, so a test need not wait for one. */
  now: () => string
}

/**
 * Sidebar facts of a team's conversations, resolved in one pass: the title
 * rule is DSH's own first-prompt fallback over the earliest user message, and
 * the row's right-hand stamp is the conversation's latest activity.
 */
export function conversationDisplays(deps: ConversationDeps, teamId: string): Map<string, ConversationDisplay> {
  const displays = new Map<string, ConversationDisplay>()
  for (const message of deps.store.listMessages(teamId)) {
    if (message.conversationId === undefined) continue
    const at = Date.parse(message.createdAt)
    const current = displays.get(message.conversationId)
    const firstUserText = message.sender.kind === 'user' && message.content.trim().length > 0
      ? current?.firstUserText ?? message.content
      : current?.firstUserText
    displays.set(message.conversationId, {
      ...(firstUserText === undefined ? {} : { firstUserText }),
      lastActivity: Math.max(current?.lastActivity ?? 0, at),
    })
  }
  return displays
}

/**
 * Display copy of one conversation. An auto title is derived, never stored:
 * the record keeps its placeholder so a rename stays the only pinned title.
 * An underivable title stays empty, which the UI labels like a new Session.
 */
export function displayConversation(deps: ConversationDeps, 
  conversation: TeamConversation,
  displays: Map<string, ConversationDisplay>,
): TeamConversation {
  if (conversation.titleSource === 'user') return conversation
  const display = displays.get(conversation.id)
  if (display === undefined) return { ...conversation, title: '' }
  return {
    ...conversation,
    title: display.firstUserText === undefined
      ? ''
      : fallbackSessionTitle(display.firstUserText, AUTO_TITLE_WORDS, AUTO_TITLE_BYTES),
    updatedAt: new Date(display.lastActivity).toISOString(),
  }
}

export function listConversations(deps: ConversationDeps, teamId: string): Page<TeamConversation> {
  requireTeam(deps.store, teamId)
  const displays = conversationDisplays(deps, teamId)
  const items = deps.store.listConversations(teamId)
    .map(conversation => displayConversation(deps, conversation, displays))
  return { items, total: items.length }
}

export function getConversation(deps: ConversationDeps, teamId: string, conversationId: string): TeamConversation {
  const conversation = deps.store.getConversation(conversationId)
  if (conversation === undefined || conversation.teamId !== teamId) {
    throw new AgentTeamError('CONVERSATION_NOT_FOUND', `Unknown conversation '${conversationId}'`)
  }
  return conversation
}

/**
 * The conversation bound to one Harness Session, if any.
 *
 * A Session enables at most one team, so the first match is the only match;
 * legacy conversations carry no Session and are never returned.
 */
export function findConversationBySession(deps: ConversationDeps, sessionId: string): TeamConversation | undefined {
  for (const team of deps.store.listTeams()) {
    const found = deps.store.listConversations(team.id).find(item => item.sessionId === sessionId)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Create the conversation record for a Harness Session without activating
 * anything. Used by the runtime (which activates afterwards).
 *
 * The workspace is read off the Session, because a DSH Session's working
 * directory is fixed when it is created and every member shares it.
 */
export async function createConversationRecord(deps: ConversationDeps, 
  teamId: string,
  input: {
    sessionId: string
    workspaceId: string
    workspacePath: string
    title?: string
  },
): Promise<TeamConversation> {
  requireTeam(deps.store, teamId)
  const workspace = await deps.requireWorkspace(input.workspaceId)
  const now = new Date().toISOString()
  const conversation: TeamConversation = {
    schemaVersion: 1,
    id: randomUUID(),
    teamId,
    sessionId: input.sessionId,
    // Placeholder only: the Session's own title is what the UI shows.
    title: input.title?.trim() || `会话 ${deps.store.listConversations(teamId).length + 1}`,
    titleSource: input.title === undefined ? 'auto' : 'user',
    state: 'active',
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    memberSessions: {},
    createdAt: now,
    updatedAt: now,
    revision: 1,
  }
  await deps.store.putConversation(conversation)
  return conversation
}

/** Drop one conversation record, which un-enables its team in that Session. */
export async function deleteConversationRecord(deps: ConversationDeps, teamId: string, conversationId: string): Promise<void> {
  const conversation = getConversation(deps, teamId, conversationId)
  await deps.store.deleteConversation(conversation.id)
  deps.publish('conversation', teamId, conversation.revision, 'team.conversation_removed')
}

/** Record the Session ids a conversation assigned to its members. */
export async function assignMemberSessions(deps: ConversationDeps, 
  teamId: string,
  conversationId: string,
  additions: Record<string, string>,
): Promise<TeamConversation> {
  const conversation = getConversation(deps, teamId, conversationId)
  const next: TeamConversation = {
    ...conversation,
    memberSessions: { ...conversation.memberSessions, ...additions },
    updatedAt: new Date().toISOString(),
    revision: conversation.revision + 1,
  }
  await deps.store.putConversation(next)
  return next
}

/** Drop one member's Session assignment from every conversation of a team. */
export async function forgetMemberSessions(deps: ConversationDeps, teamId: string, slotId: string): Promise<void> {
  for (const conversation of deps.store.listConversations(teamId)) {
    if (conversation.memberSessions[slotId] === undefined) continue
    const memberSessions = { ...conversation.memberSessions }
    delete memberSessions[slotId]
    await deps.store.putConversation({
      ...conversation,
      memberSessions,
      updatedAt: new Date().toISOString(),
      revision: conversation.revision + 1,
    })
  }
}

/** Enable a team in one Harness Session; the runtime binds and activates it. */
export async function bindSession(deps: ConversationDeps, sessionId: string, teamId: string): Promise<TeamConversation> {
  return deps.requireRuntime().bindSession(sessionId, teamId)
}

/** Disable whichever team is enabled in one Harness Session. */
export async function unbindSession(deps: ConversationDeps, sessionId: string): Promise<void> {
  return deps.requireRuntime().unbindSession(sessionId)
}

/**
 * Turn «替我审批» on or off for one Session's binding: with it on, the Leader
 * answers every interaction of that conversation on the reader's behalf.
 */
export async function setSessionDelegation(deps: ConversationDeps, sessionId: string, delegate: boolean): Promise<TeamConversation> {
  return deps.requireRuntime().setSessionDelegation(sessionId, delegate)
}

export function publishConversation(deps: ConversationDeps, teamId: string, revision: number, conversation?: MemberConversationView): void {
  deps.publish('conversation', teamId, revision, 'member.conversation', conversation)
}

export function listMessages(deps: ConversationDeps, teamId: string): Page<TeamMessage> {
  requireTeam(deps.store, teamId)
  const items = deps.store.listMessages(teamId)
  return { items, total: items.length }
}

export async function putRuntimeMessage(deps: ConversationDeps, message: TeamMessage): Promise<void> {
  await deps.store.putMessage(message)
  const team = requireTeam(deps.store, message.teamId)
  deps.publish('team', team.id, team.revision, 'team.message')
}
