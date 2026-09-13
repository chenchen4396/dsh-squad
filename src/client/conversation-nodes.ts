import type {
  ConversationNode,
  MemberConversationView,
  RoomView,
  TeamWorkbenchView,
} from '../transport/contracts.js'

export function mergeConversationNodes(
  committed: readonly ConversationNode[],
  pending: readonly ConversationNode[],
): ConversationNode[] {
  const committedIds = new Set(committed.map(node => node.id))
  return [...committed, ...pending.filter(node => !committedIds.has(node.id))]
}

/**
 * Fold a workbench load into what is on screen. Member Sessions stream while
 * the request is in flight, so a response that predates those updates keeps the
 * streamed conversations and takes only the conversation-level facts from the
 * body — otherwise the view would fall back to another conversation's
 * Workspace, room and title.
 */
export function mergeWorkbenchLoad(
  current: TeamWorkbenchView,
  loaded: TeamWorkbenchView,
  streamedWhileLoading: boolean,
): TeamWorkbenchView {
  const streamed = new Map(current.conversations.map(item => [item.slotId, item]))
  return {
    ...loaded,
    conversations: loaded.conversations.map(item => {
      const live = streamed.get(item.slotId)
      if (live === undefined || live.conversationId !== item.conversationId) return item
      // The screen may have paged older nodes in, and a streamed window may be
      // newer than this load: union both rather than dropping whichever lost.
      return streamedWhileLoading
        ? mergeMemberConversation(item, live)
        : mergeMemberConversation(live, item)
    }),
  }
}

/**
 * Fold a newer window of one member conversation into what is on screen.
 *
 * A view that paged into its history keeps those older nodes; only the window
 * itself and the conversation-level facts come from the incoming read.
 *
 * @param current - the view already on screen, if any.
 * @param incoming - a freshly read window.
 * @returns the merged view, or the incoming one when nothing older is kept.
 */
export function mergeMemberConversation(
  current: MemberConversationView | undefined,
  incoming: MemberConversationView,
): MemberConversationView {
  if (current === undefined || current.conversationId !== incoming.conversationId) return incoming
  const boundary = incoming.oldestSeq
  if (boundary === undefined) return incoming
  const older = current.nodes.filter(node => node.seq < boundary)
  if (older.length === 0) return incoming
  const nodes = uniqueNodes([...older, ...incoming.nodes])
  return {
    ...incoming,
    nodes,
    ...(current.hasMore === undefined ? {} : { hasMore: current.hasMore }),
    ...(nodes[0] === undefined ? {} : { oldestSeq: nodes[0].seq }),
  }
}

/**
 * Prepend one older page to the window already on screen.
 *
 * @param current - the window this page sits before.
 * @param page - the older page, carrying its own continuation boundary.
 * @returns the widened view, still owned by the current window's live facts.
 */
export function prependMemberPage(
  current: MemberConversationView,
  page: MemberConversationView,
): MemberConversationView {
  const nodes = uniqueNodes([...page.nodes, ...current.nodes])
  return {
    ...current,
    nodes,
    hasMore: page.hasMore === true,
    ...(nodes[0] === undefined ? {} : { oldestSeq: nodes[0].seq }),
  }
}

/** Prepend one older room page, the way a member page prepends. */
export function prependRoomPage(current: RoomView, page: RoomView): RoomView {
  const seen = new Set(current.messages.map(message => message.id))
  const messages = [...page.messages.filter(message => !seen.has(message.id)), ...current.messages]
    .sort((left, right) => left.time - right.time || left.seq - right.seq)
  const oldest = messages[0]
  return {
    ...current,
    messages,
    hasMore: page.hasMore,
    ...(oldest === undefined ? {} : { oldestTime: oldest.time }),
  }
}

/** Fold a newer room window into what is on screen, keeping paged older entries. */
export function mergeRoomView(current: RoomView | undefined, incoming: RoomView): RoomView {
  if (current === undefined || current.conversation.id !== incoming.conversation.id) return incoming
  const boundary = incoming.oldestTime
  if (boundary === undefined) return incoming
  const older = current.messages.filter(message => message.time < boundary)
  if (older.length === 0) return incoming
  const seen = new Set<string>()
  const messages = [...older, ...incoming.messages].filter(message => {
    if (seen.has(message.id)) return false
    seen.add(message.id)
    return true
  }).sort((left, right) => left.time - right.time || left.seq - right.seq)
  const oldest = messages[0]
  return {
    ...incoming,
    messages,
    hasMore: current.hasMore,
    ...(oldest === undefined ? {} : { oldestTime: oldest.time }),
  }
}

/** One node per identity, in transcript order. */
function uniqueNodes(nodes: readonly ConversationNode[]): ConversationNode[] {
  const seen = new Set<string>()
  return nodes
    .filter(node => {
      if (seen.has(node.id)) return false
      seen.add(node.id)
      return true
    })
    .sort((left, right) => left.seq - right.seq)
}
