import {
  AGENT_TEAM_API_PATH,
  AGENT_TEAM_EVENTS_PATH,
  AGENT_TEAM_UPLOAD_PATH,
  type AgentTeamMethod,
  type AgentTeamPayload,
  type AgentTeamResponse,
  type AgentTeamResult,
  type AssistantBuilderConversationView,
  type MemberConversationView,
  type WorkspaceUploadView,
} from '../transport/contracts.js'

/**
 * How long a read may wait for the Host.
 *
 * The Host is one event loop, and a team running several members keeps it busy:
 * a read that would answer in milliseconds on an idle Host can queue for
 * seconds behind a turn. Ten seconds turned that queueing into a hard error, so
 * a read waits long enough to ride out a busy run instead of failing the view.
 */
const READ_TIMEOUT_MS = 30_000

export async function callAgentTeam<M extends AgentTeamMethod>(
  method: M,
  ...args: AgentTeamPayload<M> extends undefined
    ? [payload?: undefined, expectedRevision?: number]
    : [payload: AgentTeamPayload<M>, expectedRevision?: number]
): Promise<AgentTeamResult<M>> {
  const [payload, expectedRevision] = args
  const controller = new AbortController()
  const timeoutMs = method === 'team.dissolve' ? 60_000 : READ_TIMEOUT_MS
  const timeout = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetch(AGENT_TEAM_API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        method,
        payload: payload ?? {},
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }),
    })
    const body = await response.json() as AgentTeamResponse
    if (!body.ok) {
      const error = new Error(body.error.message)
      Object.assign(error, { code: body.error.code, details: body.error.details })
      throw error
    }
    return body.value as AgentTeamResult<M>
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`请求超时：${method}`)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export async function uploadAgentTeamFile(
  teamId: string,
  conversationId: string | undefined,
  file: File,
): Promise<WorkspaceUploadView> {
  const scope = conversationId === undefined
    ? `teamId=${encodeURIComponent(teamId)}`
    : `teamId=${encodeURIComponent(teamId)}&conversationId=${encodeURIComponent(conversationId)}`
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, 120_000)
  const requestId = crypto.randomUUID()
  try {
    const response = await fetch(`${AGENT_TEAM_UPLOAD_PATH}?${scope}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Agent-Team-File-Name': encodeURIComponent(file.name),
        'X-Agent-Team-Request-Id': requestId,
      },
      signal: controller.signal,
      body: file,
    })
    const body = await response.json() as AgentTeamResponse
    if (!body.ok) {
      const error = new Error(body.error.message)
      Object.assign(error, { code: body.error.code, details: body.error.details })
      throw error
    }
    return body.value as WorkspaceUploadView
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`文件上传超时：${file.name}`)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

interface ChangeSubscription {
  /** Called with every change kind observed since the previous delivery. */
  onChange: (entityTypes: ReadonlySet<string>) => void
  onError: () => void
}

interface ConversationSubscription {
  teamId: string
  onChange: (conversation?: MemberConversationView) => void
  onError: () => void
  onOpen?: () => void
}

interface AssistantBuilderSubscription {
  onChange: (conversation?: AssistantBuilderConversationView) => void
  onError: () => void
  onOpen?: () => void
}

interface WorkspaceSubscription {
  teamId: string
  onChange: () => void
  onError: () => void
}

const changeSubscriptions = new Set<ChangeSubscription>()
const conversationSubscriptions = new Set<ConversationSubscription>()
const assistantBuilderSubscriptions = new Set<AssistantBuilderSubscription>()
const workspaceSubscriptions = new Set<WorkspaceSubscription>()
let sharedEventSource: EventSource | undefined

/**
 * How long change events are collected before their subscribers are told.
 *
 * A running team publishes a change every few dozen milliseconds per member,
 * and each subscriber answers by re-reading the Host — a full read also means
 * the model catalog, which round-trips every provider. Coalescing one burst
 * into one delivery keeps that traffic proportional to what a reader can
 * perceive, and keeps a busy run from starving the plain reads.
 */
const CHANGE_COALESCE_MS = 150

const pendingChangeTypes = new Set<string>()
let changeTimer: ReturnType<typeof setTimeout> | undefined
const pendingWorkspaceTeams = new Set<string>()
let pendingWorkspaceAll = false
let workspaceTimer: ReturnType<typeof setTimeout> | undefined

/** The `entityType` of one `change` frame, or undefined for a malformed body. */
function changeEntityType(data: string): string | undefined {
  try {
    const parsed = JSON.parse(data) as { entityType?: unknown }
    return typeof parsed.entityType === 'string' ? parsed.entityType : undefined
  } catch {
    return undefined
  }
}

function flushChanges(): void {
  changeTimer = undefined
  if (pendingChangeTypes.size === 0) return
  const types = new Set(pendingChangeTypes)
  pendingChangeTypes.clear()
  for (const subscription of changeSubscriptions) subscription.onChange(types)
}

function flushWorkspaces(): void {
  workspaceTimer = undefined
  const teams = new Set(pendingWorkspaceTeams)
  const all = pendingWorkspaceAll
  pendingWorkspaceTeams.clear()
  pendingWorkspaceAll = false
  if (teams.size === 0 && !all) return
  for (const subscription of workspaceSubscriptions) {
    if (all || teams.has(subscription.teamId)) subscription.onChange()
  }
}

function scheduleChange(entityType: string | undefined): void {
  pendingChangeTypes.add(entityType ?? 'unknown')
  if (changeTimer === undefined) changeTimer = setTimeout(flushChanges, CHANGE_COALESCE_MS)
}

function eventSource(): EventSource {
  if (sharedEventSource !== undefined) return sharedEventSource
  const source = new EventSource(AGENT_TEAM_EVENTS_PATH)
  source.addEventListener('change', ((event: MessageEvent<string>) => {
    scheduleChange(changeEntityType(event.data))
  }) as EventListener)
  source.addEventListener('conversation', ((event: MessageEvent<string>) => {
    try {
      const change = JSON.parse(event.data) as {
        entityId?: string
        conversation?: MemberConversationView
      }
      for (const subscription of conversationSubscriptions) {
        if (subscription.teamId === change.entityId) subscription.onChange(change.conversation)
      }
    } catch {
      for (const subscription of conversationSubscriptions) subscription.onChange()
    }
  }) as EventListener)
  source.addEventListener('assistant-builder-conversation', ((event: MessageEvent<string>) => {
    try {
      const change = JSON.parse(event.data) as {
        assistantBuilderConversation?: AssistantBuilderConversationView
      }
      for (const subscription of assistantBuilderSubscriptions) {
        subscription.onChange(change.assistantBuilderConversation)
      }
    } catch {
      for (const subscription of assistantBuilderSubscriptions) subscription.onChange()
    }
  }) as EventListener)
  source.addEventListener('workspace', ((event: MessageEvent<string>) => {
    try {
      const change = JSON.parse(event.data) as { entityId?: string }
      if (change.entityId === undefined) pendingWorkspaceAll = true
      else pendingWorkspaceTeams.add(change.entityId)
    } catch {
      pendingWorkspaceAll = true
    }
    if (workspaceTimer === undefined) {
      workspaceTimer = setTimeout(flushWorkspaces, CHANGE_COALESCE_MS)
    }
  }) as EventListener)
  source.onerror = () => {
    for (const subscription of changeSubscriptions) subscription.onError()
    for (const subscription of conversationSubscriptions) subscription.onError()
    for (const subscription of assistantBuilderSubscriptions) subscription.onError()
    for (const subscription of workspaceSubscriptions) subscription.onError()
  }
  source.onopen = () => {
    for (const subscription of conversationSubscriptions) subscription.onOpen?.()
    for (const subscription of assistantBuilderSubscriptions) subscription.onOpen?.()
  }
  sharedEventSource = source
  return source
}

function releaseEventSourceIfUnused(): void {
  if (
    changeSubscriptions.size > 0
    || conversationSubscriptions.size > 0
    || assistantBuilderSubscriptions.size > 0
    || workspaceSubscriptions.size > 0
  ) return
  sharedEventSource?.close()
  sharedEventSource = undefined
}

export function subscribeAgentTeamWorkspace(
  teamId: string,
  onChange: () => void,
  onError: () => void,
): () => void {
  const subscription: WorkspaceSubscription = { teamId, onChange, onError }
  workspaceSubscriptions.add(subscription)
  eventSource()
  return () => {
    workspaceSubscriptions.delete(subscription)
    releaseEventSourceIfUnused()
  }
}

/**
 * Observe team data changes.
 *
 * @param onChange - receives every change kind seen since its previous call.
 * @param onError - event-stream failure.
 * @returns disposer removing this subscription.
 */
export function subscribeAgentTeam(
  onChange: (entityTypes: ReadonlySet<string>) => void,
  onError: () => void,
): () => void {
  const subscription: ChangeSubscription = { onChange, onError }
  changeSubscriptions.add(subscription)
  eventSource()
  return () => {
    changeSubscriptions.delete(subscription)
    releaseEventSourceIfUnused()
  }
}

export function subscribeAgentTeamConversation(
  teamId: string,
  onChange: (conversation?: MemberConversationView) => void,
  onError: () => void,
  onOpen?: () => void,
): () => void {
  const subscription: ConversationSubscription = {
    teamId,
    onChange,
    onError,
    ...(onOpen === undefined ? {} : { onOpen }),
  }
  conversationSubscriptions.add(subscription)
  const source = eventSource()
  if (source.readyState === EventSource.OPEN) queueMicrotask(() => { onOpen?.() })
  return () => {
    conversationSubscriptions.delete(subscription)
    releaseEventSourceIfUnused()
  }
}

export function subscribeAssistantBuilderConversation(
  onChange: (conversation?: AssistantBuilderConversationView) => void,
  onError: () => void,
  onOpen?: () => void,
): () => void {
  const subscription: AssistantBuilderSubscription = {
    onChange,
    onError,
    ...(onOpen === undefined ? {} : { onOpen }),
  }
  assistantBuilderSubscriptions.add(subscription)
  const source = eventSource()
  if (source.readyState === EventSource.OPEN) queueMicrotask(() => { onOpen?.() })
  return () => {
    assistantBuilderSubscriptions.delete(subscription)
    releaseEventSourceIfUnused()
  }
}
