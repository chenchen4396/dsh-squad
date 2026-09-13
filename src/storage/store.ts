import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {
  AssistantTemplate,
  Operation,
  RuleDocument,
  TeamActivity,
  TeamAggregate,
  TeamConversation,
  TeamMessage,
} from '../domain/types.js'
import { agentTeamDomainSpec } from './domain.js'

export interface AgentTeamStore {
  getAssistant(id: string): AssistantTemplate | undefined
  listAssistants(): AssistantTemplate[]
  putAssistant(value: AssistantTemplate): Promise<void>
  updateAssistant(id: string, update: (current: AssistantTemplate) => AssistantTemplate): Promise<AssistantTemplate>
  deleteAssistant(id: string): Promise<boolean>

  getRuleDocument(id: string): RuleDocument | undefined
  listRuleDocuments(): RuleDocument[]
  putRuleDocument(value: RuleDocument): Promise<void>
  deleteRuleDocument(id: string): Promise<boolean>

  getTeam(id: string): TeamAggregate | undefined
  listTeams(): TeamAggregate[]
  putTeam(value: TeamAggregate): Promise<void>
  updateTeam(id: string, update: (current: TeamAggregate) => TeamAggregate): Promise<TeamAggregate>
  deleteTeam(id: string): Promise<boolean>

  listMessages(teamId: string): TeamMessage[]
  putMessage(value: TeamMessage): Promise<void>
  deleteMessage(id: string): Promise<boolean>

  getConversation(id: string): TeamConversation | undefined
  listConversations(teamId: string): TeamConversation[]
  putConversation(value: TeamConversation): Promise<void>
  updateConversation(
    id: string,
    update: (current: TeamConversation) => TeamConversation,
  ): Promise<TeamConversation>
  deleteConversation(id: string): Promise<boolean>

  listActivities(teamId: string): TeamActivity[]
  putActivity(value: TeamActivity): Promise<void>
  deleteActivity(id: string): Promise<boolean>

  getOperation(id: string): Operation | undefined
  listOperations(): Operation[]
  putOperation(value: Operation): Promise<void>
  updateOperation(id: string, update: (current: Operation) => Operation): Promise<Operation>
  deleteOperation(id: string): Promise<boolean>
}

export class DomainAgentTeamStore implements AgentTeamStore {
  private readonly assistants: KvTable<string, AssistantTemplate>
  private readonly ruleDocuments: KvTable<string, RuleDocument>
  private readonly teams: KvTable<string, TeamAggregate>
  private readonly messages: KvTable<string, TeamMessage>
  private readonly conversations: KvTable<string, TeamConversation>
  private readonly activities: KvTable<string, TeamActivity>
  private readonly operations: KvTable<string, Operation>

  constructor(readonly domain: Domain<typeof agentTeamDomainSpec>) {
    this.assistants = domain.table('assistants')
    this.ruleDocuments = domain.table('rule_documents')
    this.teams = domain.table('teams')
    this.messages = domain.table('messages')
    this.conversations = domain.table('conversations')
    this.activities = domain.table('activities')
    this.operations = domain.table('operations')
  }

  getAssistant(id: string): AssistantTemplate | undefined {
    return this.assistants.get(id)
  }

  listAssistants(): AssistantTemplate[] {
    return values(this.assistants)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }

  putAssistant(value: AssistantTemplate): Promise<void> {
    return this.assistants.put(value.id, value)
  }

  updateAssistant(
    id: string,
    update: (current: AssistantTemplate) => AssistantTemplate,
  ): Promise<AssistantTemplate> {
    return this.assistants.update(id, update)
  }

  deleteAssistant(id: string): Promise<boolean> {
    return this.assistants.delete(id)
  }

  getRuleDocument(id: string): RuleDocument | undefined {
    return this.ruleDocuments.get(id)
  }

  listRuleDocuments(): RuleDocument[] {
    return values(this.ruleDocuments)
      .sort((left, right) => left.importedAt.localeCompare(right.importedAt) || left.id.localeCompare(right.id))
  }

  putRuleDocument(value: RuleDocument): Promise<void> {
    return this.ruleDocuments.put(value.id, value)
  }

  deleteRuleDocument(id: string): Promise<boolean> {
    return this.ruleDocuments.delete(id)
  }

  getTeam(id: string): TeamAggregate | undefined {
    return this.teams.get(id)
  }

  listTeams(): TeamAggregate[] {
    return values(this.teams)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
  }

  putTeam(value: TeamAggregate): Promise<void> {
    return this.teams.put(value.id, value)
  }

  updateTeam(id: string, update: (current: TeamAggregate) => TeamAggregate): Promise<TeamAggregate> {
    return this.teams.update(id, update)
  }

  deleteTeam(id: string): Promise<boolean> {
    return this.teams.delete(id)
  }

  listMessages(teamId: string): TeamMessage[] {
    return values(this.messages)
      .filter(message => message.teamId === teamId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }

  putMessage(value: TeamMessage): Promise<void> {
    return this.messages.put(value.id, value)
  }

  deleteMessage(id: string): Promise<boolean> {
    return this.messages.delete(id)
  }

  getConversation(id: string): TeamConversation | undefined {
    return this.conversations.get(id)
  }

  listConversations(teamId: string): TeamConversation[] {
    return values(this.conversations)
      .filter(conversation => conversation.teamId === teamId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }

  putConversation(value: TeamConversation): Promise<void> {
    return this.conversations.put(value.id, value)
  }

  updateConversation(
    id: string,
    update: (current: TeamConversation) => TeamConversation,
  ): Promise<TeamConversation> {
    return this.conversations.update(id, update)
  }

  deleteConversation(id: string): Promise<boolean> {
    return this.conversations.delete(id)
  }

  listActivities(teamId: string): TeamActivity[] {
    return values(this.activities)
      .filter(activity => activity.teamId === teamId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }

  putActivity(value: TeamActivity): Promise<void> {
    return this.activities.put(value.id, value)
  }

  deleteActivity(id: string): Promise<boolean> {
    return this.activities.delete(id)
  }

  getOperation(id: string): Operation | undefined {
    return this.operations.get(id)
  }

  listOperations(): Operation[] {
    return values(this.operations)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }

  putOperation(value: Operation): Promise<void> {
    return this.operations.put(value.id, value)
  }

  updateOperation(id: string, update: (current: Operation) => Operation): Promise<Operation> {
    return this.operations.update(id, update)
  }

  deleteOperation(id: string): Promise<boolean> {
    return this.operations.delete(id)
  }
}

function values<K extends string, V>(table: KvTable<K, V>): V[] {
  return [...table.entries()].map(([, value]) => value)
}
