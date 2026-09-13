import type {
  CatalogView,
  RoomView,
  SessionBindingView,
  TeamWorkbenchView,
} from '../transport/contracts.js'

/**
 * The 团队 view's last read of each thing it opens with.
 *
 * Leaving the tab and coming back is the common move, and re-reading the whole
 * workbench (every member's Session, every member's history) to show what the
 * reader just saw is what made the view feel like it reloads forever. The view
 * paints a cached read first and refreshes right after, so a stale entry heals
 * in one round trip while the reader never waits on a spinner.
 */
const bindings = new Map<string, SessionBindingView>()
const workbenches = new Map<string, TeamWorkbenchView>()
const rooms = new Map<string, RoomView>()

export function cachedBinding(sessionId: string): SessionBindingView | undefined {
  return bindings.get(sessionId)
}

export function cacheBinding(binding: SessionBindingView): void {
  bindings.set(binding.sessionId, binding)
}

export function cachedWorkbench(teamId: string, conversationId: string): TeamWorkbenchView | undefined {
  return workbenches.get(`${teamId}:${conversationId}`)
}

export function cacheWorkbench(view: TeamWorkbenchView): void {
  workbenches.set(`${view.teamId}:${view.conversation.id}`, view)
}

/**
 * The model/preset directory. Building it costs one network round trip per
 * provider, so the client keeps the last one and shows it while the Host
 * refreshes; the Host serves its own cached read immediately either way.
 */
let catalog: CatalogView | undefined

export function cachedCatalog(): CatalogView | undefined {
  return catalog
}

export function cacheCatalog(value: CatalogView): void {
  catalog = value
}

export function cachedRoom(teamId: string, conversationId: string): RoomView | undefined {
  return rooms.get(`${teamId}:${conversationId}`)
}

export function cacheRoom(view: RoomView): void {
  rooms.set(`${view.teamId}:${view.conversation.id}`, view)
}
