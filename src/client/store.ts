import { useSyncExternalStore } from 'react'

export interface AgentTeamUiState {
  selectedTeamId: string | undefined
}

let state: AgentTeamUiState = {
  selectedTeamId: undefined,
}
const listeners = new Set<() => void>()

/**
 * The frame's own Layout service, handed over by the plugin body. The team
 * management page is a main panel of the frame, so entering it means selecting
 * that panel: the Harness sidebar and its session list are left as they are.
 */
let showPanel: (() => void) | undefined
let showConversation: (() => void) | undefined

export function setPanelNavigator(navigate: (panelId: 'agent-team' | null) => void): void {
  showPanel = () => { navigate('agent-team') }
  showConversation = () => { navigate(null) }
}

/**
 * Enter the management page from the sidebar, keeping the team it was last
 * showing — the page is a panel of the frame, so returning to it returns to
 * where you were.
 */
export function showTeamPage(): void {
  showPanel?.()
}

export function openTeams(): void {
  update({ selectedTeamId: undefined })
  showPanel?.()
}

export function openTeam(teamId: string): void {
  update({ selectedTeamId: teamId })
  showPanel?.()
}

/** Leave the management page and show the Conversation panel the frame came from. */
export function closeAgentTeam(): void {
  update({ selectedTeamId: undefined })
  showConversation?.()
}

/**
 * The slice of the Harness's client `sessions` service this plugin navigates
 * with. Members are child Sessions of the Session itself, so both halves of a
 * member's subagent address are known to the plugin; `subagentAddress` is the
 * authoritative form the service accepts.
 */
export interface SubagentAddressLike {
  parentSessionId: string
  childSessionId: string
}

export interface MemberSessionNavigator {
  subagentAddress(id: string): SubagentAddressLike | undefined
  openSubagent(address: SubagentAddressLike): void
  open(id: string): void
}

let navigateToMemberSession: ((sessionId: string) => void) | undefined

/**
 * Hand over the frame's `sessions` service. Opening a member's own Session is
 * how one member is addressed privately: the Harness composer belongs to the
 * Session it is shown in, so typing into a member's Session is the only way to
 * say something to that member without the Leader receiving it too.
 */
export function setMemberSessionNavigator(navigator: MemberSessionNavigator | undefined): void {
  navigateToMemberSession = navigator === undefined
    ? undefined
    : sessionId => {
        const address = navigator.subagentAddress(sessionId)
        // A member Session is an addressed child of the Session, so it is not in
        // the Session list `open` walks; the address is what opens it.
        if (address === undefined) navigator.open(sessionId)
        else navigator.openSubagent(address)
      }
}

/** Open one member's Session, if the frame's `sessions` service is available. */
export function openMemberSession(sessionId: string): void {
  navigateToMemberSession?.(sessionId)
}

/**
 * The member the 团队 view is addressing, when it is one.
 *
 * The Harness composer belongs to the Session, so the Session's own Agent — the
 * team's Leader — is its only addressee. To reach one member alone the plugin
 * elects its own composer into the Harness's composer chain for as long as a
 * member is picked, and hands that member the message itself.
 */
export interface MemberComposerTarget {
  /** Harness Session this composer belongs to: the Session the team is on. */
  sessionId: string
  teamId: string
  conversationId: string
  slotId: string
  displayName: string
}

let memberComposerTarget: MemberComposerTarget | undefined
let syncMemberComposer: (() => void) | undefined

/**
 * Hand over the body's re-registration call. A chain entry is elected by its
 * selector at render time, and the selector must stay a pure function of the
 * owner props, so the target it routes to is bound when the entry is
 * registered: a new target means a new registration.
 */
export function setMemberComposerSync(sync: (() => void) | undefined): void {
  syncMemberComposer = sync
}

/** Address one member from the Session's composer, or clear the takeover. */
export function setMemberComposerTarget(next: MemberComposerTarget | undefined): void {
  if (sameTarget(memberComposerTarget, next)) return
  memberComposerTarget = next
  syncMemberComposer?.()
}

/** The member the composer currently addresses, for the entry that elected it. */
export function getMemberComposerTarget(): MemberComposerTarget | undefined {
  return memberComposerTarget
}

function sameTarget(
  left: MemberComposerTarget | undefined,
  right: MemberComposerTarget | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.sessionId === right.sessionId
    && left.teamId === right.teamId
    && left.conversationId === right.conversationId
    && left.slotId === right.slotId
    && left.displayName === right.displayName
}

/** The store's own snapshot: what the hook renders from, and what tests read. */
export function getAgentTeamUiState(): AgentTeamUiState {
  return state
}

export function useAgentTeamUi(): AgentTeamUiState {
  return useSyncExternalStore(subscribe, getAgentTeamUiState, getServerSnapshot)
}

function getServerSnapshot(): AgentTeamUiState {
  return { selectedTeamId: undefined }
}

function update(next: AgentTeamUiState): void {
  if (state.selectedTeamId === next.selectedTeamId) return
  state = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
