import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { AgentTeamError } from '../domain/errors.js'
import { isSandboxMode, type SandboxMode } from './sandbox-authority.js'
import type {
  InteractionResponseInput,
  PendingInteractionView,
  QuestionAnswerView,
  QuestionItemView,
} from '../transport/contracts.js'

type PendingInteractionRecord = {
  /** When the member asked, for the reader's fallback window. */
  askedAt: number
  /**
   * «替我审批»: this one is the Leader's alone. The reader is never offered it,
   * however long it stays pending.
   */
  leaderOnly?: boolean
} & (
  | {
    id: string
    kind: 'question'
    sessionId: string
    questions: QuestionItemView[]
    settle: (answer: AskUserQuestionAnswer) => void
    cancel: (error: unknown) => void
  }
  | {
    id: string
    kind: 'approval'
    sessionId: string
    approvalId: string
    toolName: string
    callId?: string
    reason?: string
    /** Wider sandbox level the call asked for, when it asked to escalate. */
    requestedMode?: SandboxMode
    /** Set when the request is wider than the Leader may grant. */
    userOnly?: boolean
    settle: (outcome: ApprovalOutcome) => void
    cancel: (error: unknown) => void
  }
)

export interface TeamInteractionScope {
  acceptsSession: (sessionId: string) => boolean
  /**
   * Sessions whose requests this plugin answers itself instead of recording:
   * «替我审批» is on for them, so nothing is left for the reader to answer.
   */
  autoAnswer?: (sessionId: string) => boolean
  onChange: (sessionId: string) => void
}

/**
 * Answers Harness human-interaction requests (questions and approvals) for the
 * Agents this plugin owns.
 *
 * 0.1.5 replaces the old apiProxy mux with two Cordis waterfalls —
 * `user-questions/request` and `approval/request` — that each Agent's scoped
 * context routes to its answerers. Registering from the Agent's own scoped
 * context keeps the plugin's workbench as the answerer for team members; when
 * another UI claims the request first, ours simply stays dormant.
 */
export class TeamInteractionBridge {
  private readonly records = new Map<string, PendingInteractionRecord>()
  private readonly scopes = new Set<TeamInteractionScope>()

  constructor(
    private readonly ctx: Context,
    scope?: TeamInteractionScope,
  ) {
    if (scope !== undefined) this.scopes.add(scope)
  }

  registerScope(scope: TeamInteractionScope): () => void {
    this.scopes.add(scope)
    return () => { this.scopes.delete(scope) }
  }

  /**
   * Answer for one live Agent. Called from that Agent's creation `setup`, so
   * the scoped context dispatches only this Agent's interaction requests here.
   */
  attach(agentCtx: Context, agent: Agent): void {
    const sessionId = String(agent.session.id)
    agentCtx.on('user-questions/request', (request: AskUserQuestionRequest, next) => {
      if (!this.acceptsSession(sessionId)) return next()
      if (this.autoAnswer(sessionId)) return Promise.resolve(autoQuestionAnswer(request))
      return this.askQuestion(sessionId, request)
    })
    agentCtx.on('approval/request', (request: ApprovalRequest, next) => {
      if (!this.acceptsSession(sessionId)) return next()
      if (this.autoAnswer(sessionId)) return Promise.resolve('allowed-once' satisfies ApprovalOutcome)
      return this.askApproval(sessionId, request)
    })
  }

  list(sessionId: string): PendingInteractionView[] {
    return [...this.records.values()]
      .filter(record => record.sessionId === sessionId)
      .map(toView)
  }

  /** One pending request by id, for whoever has to judge it. */
  pending(interactionId: string): PendingInteractionView | undefined {
    const record = this.records.get(interactionId)
    return record === undefined ? undefined : toView(record)
  }

  /** Mark one request as the reader's: the Leader cannot grant it. */
  markUserOnly(interactionId: string): void {
    const record = this.records.get(interactionId)
    if (record === undefined || record.kind !== 'approval') return
    record.userOnly = true
    this.notifyChange(record.sessionId)
  }

  /** Mark one request as the Leader's alone: the reader is never offered it. */
  markLeaderOnly(interactionId: string): void {
    const record = this.records.get(interactionId)
    if (record === undefined) return
    record.leaderOnly = true
    this.notifyChange(record.sessionId)
  }

  /**
   * Refuse one approval outright, because nobody in this conversation can grant
   * it: «替我审批» leaves a request wider than the Leader's own level with no
   * answerer at all, and a card that never opens would only hang the member.
   */
  refuse(interactionId: string): boolean {
    const record = this.records.get(interactionId)
    if (record === undefined || record.kind !== 'approval') return false
    this.settle(record, { kind: 'approval', outcome: 'rejected' })
    return true
  }

  /** Ids of every request still waiting, whatever Session asked it. */
  pendingIds(): string[] {
    return [...this.records.keys()]
  }

  forget(sessionId: string): void {
    for (const [id, record] of [...this.records]) {
      if (record.sessionId === sessionId) this.cancel(record, new AgentTeamError('INTERACTION_NOT_FOUND', '该交互请求已结束'))
    }
  }

  /**
   * Answer one pending request as the team's Leader.
   *
   * Every member request is handed to the Leader, and the Leader is the only
   * role that speaks for the team, so its own tool answers without naming the
   * member's Session: the interaction identifies it.
   */
  answerAsLeader(
    interactionId: string,
    input: { decision?: 'allow' | 'deny'; answers?: readonly string[] },
  ): 'question' | 'approval' {
    const record = this.records.get(interactionId)
    if (record === undefined) {
      throw new AgentTeamError('INTERACTION_NOT_FOUND', '该交互请求已结束或不存在')
    }
    if (record.kind === 'approval') {
      if (input.decision === undefined) {
        throw new AgentTeamError('INTERACTION_INVALID', '审批请求需要 decision：allow 或 deny')
      }
      this.settle(record, {
        kind: 'approval',
        outcome: input.decision === 'allow' ? 'allowed-once' : 'rejected',
      })
      return 'approval'
    }
    this.settle(record, {
      kind: 'question',
      answers: record.questions.map((question, index) => (
        leaderAnswer(question, input.answers?.[index])
      )),
    })
    return 'question'
  }

  async respond(
    sessionId: string,
    interactionId: string,
    response: InteractionResponseInput,
  ): Promise<void> {
    const record = this.records.get(interactionId)
    if (record === undefined) {
      throw new AgentTeamError('INTERACTION_NOT_FOUND', '该交互请求已结束或不存在')
    }
    if (record.sessionId !== sessionId || !this.acceptsSession(sessionId)) {
      throw new AgentTeamError('INTERACTION_NOT_FOUND', '该交互请求不属于指定的会话')
    }
    if (record.leaderOnly === true) {
      throw new AgentTeamError('INTERACTION_NOT_FOUND', '该请求由 Leader 全权处理：本会话已开启「替我审批」')
    }
    this.settle(record, response)
  }

  private settle(record: PendingInteractionRecord, response: InteractionResponseInput): void {
    const sessionId = record.sessionId
    if (record.kind === 'question') {
      if (response.kind !== 'question') {
        throw new AgentTeamError('INTERACTION_INVALID', '交互响应类型与待处理请求不匹配')
      }
      const answers = normalizeQuestionAnswers(record.questions, response.answers)
      this.records.delete(record.id)
      this.notifyChange(sessionId)
      record.settle({ answers })
      return
    }
    if (response.kind !== 'approval') {
      throw new AgentTeamError('INTERACTION_INVALID', '交互响应类型与待处理请求不匹配')
    }
    this.records.delete(record.id)
    this.notifyChange(sessionId)
    record.settle(response.outcome)
  }

  dispose(): void {
    for (const record of [...this.records.values()]) {
      this.cancel(record, new AgentTeamError('INTERACTION_NOT_FOUND', 'dsh-squad 已关闭'))
    }
    this.records.clear()
  }

  private askQuestion(
    sessionId: string,
    request: AskUserQuestionRequest,
  ): Promise<AskUserQuestionAnswer> {
    const id = `question:${randomUUID()}`
    const questions: QuestionItemView[] = request.questions.map(question => ({
      id: question.id,
      question: question.question,
      ...(question.detail === undefined ? {} : { detail: question.detail }),
      ...(question.header === undefined ? {} : { header: question.header }),
      ...(question.options === undefined ? {} : {
        options: question.options.map(option => ({
          label: option.label,
          ...(option.description === undefined ? {} : { description: option.description }),
        })),
      }),
      ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
      ...(question.intent === undefined ? {} : { intent: { ...question.intent } }),
    }))
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const record: PendingInteractionRecord = {
        id,
        askedAt: Date.now(),
        kind: 'question',
        sessionId,
        questions,
        settle: resolve,
        cancel: reject,
      }
      this.register(record, request.signal)
    })
  }

  private askApproval(sessionId: string, request: ApprovalRequest): Promise<ApprovalOutcome> {
    const approvalId = randomUUID()
    const wanted = requestedMode(request.agent, request.callId === undefined ? undefined : String(request.callId))
    return new Promise<ApprovalOutcome>((resolve, reject) => {
      const record: PendingInteractionRecord = {
        id: `approval:${approvalId}`,
        askedAt: Date.now(),
        kind: 'approval',
        sessionId,
        approvalId,
        toolName: request.toolName,
        ...(request.callId === undefined ? {} : { callId: String(request.callId) }),
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        ...(wanted === undefined ? {} : { requestedMode: wanted }),
        settle: resolve,
        cancel: reject,
      }
      this.register(record, request.signal)
    })
  }

  private register(record: PendingInteractionRecord, signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
      record.cancel(new AgentTeamError('INTERACTION_NOT_FOUND', '该交互请求已被取消'))
      return
    }
    this.records.set(record.id, record)
    this.notifyChange(record.sessionId)
    signal?.addEventListener('abort', () => {
      if (this.records.has(record.id)) {
        this.cancel(record, new AgentTeamError('INTERACTION_NOT_FOUND', '该交互请求已被取消'))
      }
    }, { once: true })
  }

  private cancel(record: PendingInteractionRecord, error: unknown): void {
    if (!this.records.delete(record.id)) return
    this.notifyChange(record.sessionId)
    record.cancel(error)
  }

  private acceptsSession(sessionId: string): boolean {
    return [...this.scopes].some(scope => scope.acceptsSession(sessionId))
  }

  private autoAnswer(sessionId: string): boolean {
    return [...this.scopes].some(scope => scope.autoAnswer?.(sessionId) === true)
  }

  private notifyChange(sessionId: string): void {
    for (const scope of this.scopes) {
      if (scope.acceptsSession(sessionId)) scope.onChange(sessionId)
    }
  }
}

/**
 * The answer an Agent gets when «替我审批» left nobody to ask.
 *
 * The question still has to be settled for that Agent's turn to continue, so it
 * comes back with nothing selected and a note saying why: without it the Agent
 * tends to ask again and wait for an answer that will never come.
 */
function autoQuestionAnswer(request: AskUserQuestionRequest): AskUserQuestionAnswer {
  return {
    answers: request.questions.map(question => ({
      id: question.id,
      selected: [],
      custom: '本会话开启了「替我审批」，没有人会回答这个问题——请自行决策并继续。',
    })),
  }
}

/**
 * One Leader answer in the shape the member's question expects.
 *
 * The Leader answers in words: naming the request's option labels selects them
 * (several labels separated by 、 or , select several), and anything else is a
 * free-form answer, which is what an open question needs.
 */
function leaderAnswer(question: QuestionItemView, answer: string | undefined): QuestionAnswerView {
  const text = (answer ?? '').trim()
  if (text.length === 0) {
    throw new AgentTeamError('INTERACTION_INVALID', `问题“${question.question}”还没有答案`)
  }
  const labels = (question.options ?? []).map(option => option.label)
  if (labels.includes(text)) return { id: question.id, selected: [text] }
  const parts = text.split(/[、,，;；/]/).map(part => part.trim()).filter(part => part.length > 0)
  if (parts.length > 1 && parts.every(part => labels.includes(part))) {
    return { id: question.id, selected: parts }
  }
  return { id: question.id, selected: [], custom: text }
}

export function normalizeQuestionAnswers(
  questions: readonly QuestionItemView[],
  answers: readonly QuestionAnswerView[],
): QuestionAnswerView[] {
  const byId = new Map<string, QuestionAnswerView>()
  for (const answer of answers) {
    if (byId.has(answer.id)) {
      throw new AgentTeamError('INTERACTION_INVALID', `问题“${answer.id}”存在重复答案`)
    }
    byId.set(answer.id, answer)
  }
  if (byId.size !== questions.length) {
    throw new AgentTeamError('INTERACTION_INVALID', '请完成全部问题后再提交')
  }
  return questions.map(question => {
    const answer = byId.get(question.id)
    if (answer === undefined) {
      throw new AgentTeamError('INTERACTION_INVALID', `缺少问题“${question.id}”的答案`)
    }
    const selected = [...answer.selected]
    if (new Set(selected).size !== selected.length) {
      throw new AgentTeamError('INTERACTION_INVALID', `问题“${question.id}”包含重复选项`)
    }
    const allowed = new Set(question.options?.map(option => option.label) ?? [])
    if (selected.some(label => !allowed.has(label))) {
      throw new AgentTeamError('INTERACTION_INVALID', `问题“${question.id}”包含无效选项`)
    }
    if (question.multiSelect !== true && selected.length > 1) {
      throw new AgentTeamError('INTERACTION_INVALID', `问题“${question.id}”只能选择一个选项`)
    }
    const custom = answer.custom?.trim()
    if (question.multiSelect !== true && custom !== undefined && custom.length > 0 && selected.length > 0) {
      throw new AgentTeamError('INTERACTION_INVALID', `问题“${question.id}”的自定义答案不能与单选项同时提交`)
    }
    if (selected.length === 0 && (custom === undefined || custom.length === 0)) {
      throw new AgentTeamError('INTERACTION_INVALID', `请回答问题“${question.question}”`)
    }
    return {
      id: question.id,
      selected,
      ...(custom === undefined || custom.length === 0 ? {} : { custom }),
    }
  })
}

/**
 * The wider sandbox level a tool call asked for.
 *
 * A `sandbox_permissions` argument is how a tool family asks to be let out of
 * its confinement, and the approval carries only the call id — so the level
 * comes from the call the question is about.
 */
function requestedMode(agent: Agent | undefined, callId: string | undefined): SandboxMode | undefined {
  if (agent === undefined || callId === undefined) return undefined
  for (const event of agent.session.snapshotEvents()) {
    if (event.type !== 'tool/call' || String(event.data.callId) !== callId) continue
    try {
      const args = JSON.parse(event.data.arguments) as { sandbox_permissions?: unknown }
      return isSandboxMode(args.sandbox_permissions) ? args.sandbox_permissions : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

function toView(record: PendingInteractionRecord): PendingInteractionView {
  const leaderOnly = record.leaderOnly === true ? { leaderOnly: true } : {}
  if (record.kind === 'question') {
    return { id: record.id, askedAt: record.askedAt, kind: record.kind, questions: record.questions, ...leaderOnly }
  }
  return {
    id: record.id,
    askedAt: record.askedAt,
    kind: record.kind,
    approvalId: record.approvalId,
    toolName: record.toolName,
    ...(record.callId === undefined ? {} : { callId: record.callId }),
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    ...(record.requestedMode === undefined ? {} : { requestedMode: record.requestedMode }),
    ...(record.userOnly === true ? { userOnly: true } : {}),
    ...leaderOnly,
  }
}
