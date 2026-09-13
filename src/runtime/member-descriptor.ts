import type { Agent } from '@deepseek-ai/dsh-agent'

/**
 * Durable `subagent/descriptor` format version this plugin writes.
 *
 * The record belongs to the Harness's own subagent vocabulary (declared below);
 * `3` is the version this release folds. The Harness ignores an unknown version
 * instead of failing, so a future bump only drops members back out of its
 * subagent switcher.
 */
const MEMBER_DESCRIPTOR_VERSION = 3

/** The one-shot descriptor shape the Harness's `subagent` projection folds. */
export interface MemberSubagentDescriptor {
  version: number
  mode: 'one-shot'
  /** Establishing provider name; this plugin is not a Harness subagent provider. */
  provider: string
  /** Durable display label, so enumeration names the member without its log. */
  label?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Durable identity and lifecycle mode of a session-backed subagent child.
     *
     * Declared here, rather than imported, because this plugin takes no build
     * dependency on the Harness's subagent package: this is the payload shape
     * that package folds into its own `subagent` projection.
     */
    'subagent/descriptor': MemberSubagentDescriptor
  }
}

/**
 * Identify one team member as a session-backed subagent in the Harness's own
 * vocabulary.
 *
 * Members are created as the Session Agent's children, which the Harness
 * already counts as descendants from the child's header. Its subagent switcher
 * then expects the matching catalog entry; without this record it sees
 * descendants it cannot list and waits forever for a catalog that never
 * arrives ("正在加载子代理…"). Writing the same durable identity the Harness's
 * in-process subagent driver writes closes that gap, so the switcher lists the
 * member and opens its transcript read-only.
 *
 * The mode is `one-shot` because the Harness's control plane cannot drive a
 * member — this plugin owns its lifecycle and messages it through team tools —
 * which is exactly the read-only treatment the Harness gives a one-shot child.
 * A resumed member whose log already carries the record is left alone.
 *
 * @param agent - the member agent, during its creation setup.
 * @param label - the member's display name, kept as the durable label.
 */
export function identifyMemberAsSubagent(agent: Agent, label: string): void {
  if (agent.session.snapshotEvents().some(event => event.type === 'subagent/descriptor')) return
  agent.session.append('subagent/descriptor', {
    version: MEMBER_DESCRIPTOR_VERSION,
    mode: 'one-shot',
    provider: 'agent-team',
    label,
  })
}
