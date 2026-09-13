export const TASK_STATE_LABELS: Readonly<Record<string, string>> = {
  pending: '待处理',
  assigned: '已分配',
  in_progress: '进行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

export const PERMISSION_LABELS: Readonly<Record<string, string>> = {
  'read-only': '只读',
  'workspace-write': '工作区可写',
  'danger-full-access': '完全访问',
}

export function memberStatusLabel(status: string): string {
  const labels: Readonly<Record<string, string>> = {
    offline: '离线',
    starting: '启动中',
    idle: '空闲',
    running: '运行中',
    waiting_approval: '等待审批',
    error: '异常',
  }
  return labels[status] ?? status
}

export function taskStatusLabel(status: string): string {
  return TASK_STATE_LABELS[status] ?? status
}

/**
 * How one member column names its model.
 *
 * The Leader is the Session's own Agent, so its model and reasoning effort come
 * from the Session rather than from the leader assistant's template: that
 * column says so instead of naming a template route that does not apply.
 */
export interface MemberModelLabel {
  /** Visible name; the catalog display name for an ordinary member. */
  name: string
  /** Tooltip prefix; the full `provider / model` route for an ordinary member. */
  title: string
  /** Whether the member assistant's reasoning effort applies to this column. */
  showEffort: boolean
}

/**
 * How a member's model is named in the workbench.
 *
 * The Harness's own model selector names a model by its catalog display name
 * rather than by `provider / model`, so the member header shows the same short
 * name; the full route stays in that header's tooltip.
 *
 * @param models - the catalog's models per provider.
 * @param provider - the member assistant's provider id.
 * @param model - the member assistant's model id.
 * @returns the catalog display name, or the raw model id when uncatalogued.
 */
export function modelDisplayName(
  models: Readonly<Record<string, ReadonlyArray<{ id: string; name: string }>>> | undefined,
  provider: string,
  model: string,
): string {
  return models?.[provider]?.find(entry => entry.id === model)?.name ?? model
}

/** The member slot facts the model label needs. */
export interface MemberModelSource {
  id: string
}

/** The assistant facts the model label needs. */
export interface AssistantModelSource {
  provider: string
  model: string
}

/**
 * How one member names its model.
 *
 * The Leader is the Session's own Agent, so the leader assistant's route and
 * reasoning effort never run: that column says so instead of naming a template
 * the Session does not use.
 *
 * @param models - the catalog's models per provider.
 * @param member - the member slot being drawn.
 * @param leaderSlotId - the team's current leader slot.
 * @param assistant - the member's assistant, when it still resolves.
 * @returns the visible name, its tooltip prefix, and whether the effort applies.
 */
export function memberModelLabel(
  models: Readonly<Record<string, ReadonlyArray<{ id: string; name: string }>>> | undefined,
  member: MemberModelSource,
  leaderSlotId: string,
  assistant: AssistantModelSource | undefined,
): MemberModelLabel {
  if (member.id === leaderSlotId) {
    return {
      name: '本会话 Agent',
      title: 'Leader 是本会话自身的 Agent：模型与思考模式由会话决定',
      showEffort: false,
    }
  }
  if (assistant === undefined) {
    return { name: '助手不可用', title: '助手不可用', showEffort: false }
  }
  return {
    name: modelDisplayName(models, assistant.provider, assistant.model),
    title: `${assistant.provider} / ${assistant.model}`,
    showEffort: true,
  }
}
