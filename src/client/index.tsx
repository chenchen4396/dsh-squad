import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { bindNativeLocale } from './native-locale.js'
import {
  getMemberComposerTarget,
  setMemberComposerSync,
  setMemberSessionNavigator,
  setPanelNavigator,
  type MemberSessionNavigator,
} from './store.js'
import {
  AgentTeamPanel,
  AgentTeamSettingsSection,
  AgentTeamSidebarAction,
} from './components.js'
import { AgentTeamSessionView } from './session/TeamSessionView.js'
import { ComposerTeamControl } from './workbench/ComposerTeamControl.js'
import { MemberComposer } from './workbench/MemberComposer.js'
import { registerTeamLocale } from './team-locale.js'
import { registerTeamMentionSource } from './team-mentions.js'

export const name = 'agent-team-client'
export const inject = ['locale', 'slots', 'layout']

export function apply(ctx: ClientContext): void {
  // Team rows and rendered blocks borrow the app's own dictionaries, so a
  // conversation, a Markdown block and a JSON tree read like everywhere else.
  bindNativeLocale(ctx.locale.bind('workspace'), ctx.locale.bind('common'))
  // The management page is a panel of the frame rather than a surface of its
  // own: it occupies the centre, so the Harness sidebar keeps rendering
  // itself — its brand row, its Workspace groups and its own session rows.
  setPanelNavigator(panelId => { ctx.layout.selectPanel(panelId === null ? null : panelId as MainPanelId) })
  // Addressing one member privately means showing that member's own Session:
  // its composer is the Session's, so the Leader never receives the message.
  // The service is read lazily — a member Session only opens when clicked, long
  // after the client has assembled.
  const sessions = (): MemberSessionNavigator | undefined =>
    ctx.get('sessions' as never) as MemberSessionNavigator | undefined
  setMemberSessionNavigator({
    subagentAddress: id => sessions()?.subagentAddress(id),
    openSubagent: address => { sessions()?.openSubagent(address) },
    open: id => { sessions()?.open(id) },
  })
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'agent-team', order: 10, label: '团队' },
    AgentTeamSidebarAction,
  ))
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'agent-team', order: 40, label: 'dsh-squad' },
    AgentTeamSettingsSection,
  ))
  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: 'agent-team' },
    AgentTeamPanel,
  ))
  // The team itself lives in the conversation: one more View beside 对话 and
  // 轨迹, scoped to the Session the user is looking at. A team is enabled in a
  // Session, so this is the only place its workbench can be shown.
  const t = registerTeamLocale(ctx)
  // The meeting room has no composer of its own, so `@` in the Harness composer
  // is how a reader addresses one member.
  registerTeamMentionSource(ctx)
  ctx.slots.inject('conversation.view', () => ctx.slots.register(
    { name: 'conversation.view', id: 'agent-team', order: 20, label: () => t('view.team') },
    AgentTeamSessionView,
  ))
  // Enabling the team is a per-Session decision, so its switch sits in the
  // composer tool row, immediately left of the model selector: the reader who
  // wants to talk to the team starts it there instead of opening the 团队 view
  // first.
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
    { name: 'conversation.input.right', id: 'agent-team', order: 20 },
    ComposerTeamControl,
  ))
  // Addressing one member privately takes over the conversation's composer: the
  // Session's composer can only reach the Session's own Agent (the Leader), so a
  // member-directed message needs a composer of its own. The chain elects on a
  // pure selector, so the entry is bound to one target and re-registered when
  // the 团队 view picks another member — the native composer stays mounted and
  // hidden underneath, keeping whatever the reader typed there.
  let disposeMemberComposer: (() => void) | undefined
  let composerChainReady = false
  const syncMemberComposer = (): void => {
    if (!composerChainReady) return
    disposeMemberComposer?.()
    disposeMemberComposer = undefined
    const target = getMemberComposerTarget()
    if (target === undefined) return
    disposeMemberComposer = ctx.slots.register(
      {
        name: 'conversation.composer',
        select: owner => owner.sessionId === target.sessionId ? target : null,
      },
      MemberComposer,
    )
  }
  setMemberComposerSync(syncMemberComposer)
  ctx.slots.inject('conversation.composer', () => {
    composerChainReady = true
    syncMemberComposer()
    return () => {
      composerChainReady = false
      disposeMemberComposer?.()
      disposeMemberComposer = undefined
    }
  })
}
