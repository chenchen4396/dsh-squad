import type { AssistantBuilderConversationSummary } from '../../transport/contracts.js'

/** How one past designer conversation is described in the list. */
export function assistantBuilderStateLabel(
  state: AssistantBuilderConversationSummary['state'],
): string {
  if (state === 'completed') return '已创建'
  if (state === 'in_progress') return '配置中'
  return '新对话'
}

/** When it was last touched, short enough to sit under a title. */
export function formatConversationTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}
