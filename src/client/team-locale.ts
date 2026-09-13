import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/** Dictionary namespace this plugin owns. */
export const TEAM_LOCALE_NAMESPACE = 'agent-team'

/**
 * Register the plugin's own copy and return its translate function.
 *
 * The 团队 view sits beside the app's own 对话 and 轨迹 views, so its label
 * follows the app's language instead of staying Chinese in an English UI.
 */
export function registerTeamLocale(ctx: ClientContext): (key: string) => string {
  ctx.effect(
    () => ctx.locale.register(TEAM_LOCALE_NAMESPACE, 'zh', { 'view.team': '团队' }),
    'agent-team: zh dictionary',
  )
  ctx.effect(
    () => ctx.locale.register(TEAM_LOCALE_NAMESPACE, 'en', { 'view.team': 'Team' }),
    'agent-team: en dictionary',
  )
  return ctx.locale.bind(TEAM_LOCALE_NAMESPACE) as unknown as (key: string) => string
}
