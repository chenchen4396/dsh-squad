import type {
  TeamMessage,
} from '../../domain/types.js'
import type {
  ConversationView,
  InteractionResponseInput,
  MemberConversationView,
  PageView,
  RoomView,
  SessionBindingView,
  TeamWorkbenchView,
} from '../contracts.js'

/** A team running in a Session: its room, its messages, and the workbench. */
export interface ConversationsRequests {
  'team.message.list': { payload: { id: string }; result: PageView<TeamMessage> }
  'team.message.send': {
    payload: { teamId: string; content: string; conversationId: string; targetSlotId?: string }
    result: TeamMessage
  }
  'team.workbench.get': {
    payload: { id: string; conversationId: string }
    result: TeamWorkbenchView
  }
  'team.workbench.older': {
    payload: { id: string; conversationId: string; slotId: string; beforeSeq: number }
    result: MemberConversationView
  }
  'team.session.get': {
    payload: { sessionId: string }
    result: SessionBindingView
  }
  'team.session.bind': {
    payload: { sessionId: string; teamId: string }
    result: SessionBindingView
  }
  'team.session.unbind': {
    payload: { sessionId: string }
    result: { accepted: boolean }
  }
  'team.session.delegate': {
    payload: { sessionId: string; delegate: boolean }
    result: SessionBindingView
  }
  'team.conversation.list': {
    payload: { teamId: string }
    result: PageView<ConversationView>
  }
  'team.room.get': {
    payload: { teamId: string; conversationId: string; beforeTime?: number }
    result: RoomView
  }
  'team.room.older': {
    payload: { teamId: string; conversationId: string; beforeTime: number }
    result: RoomView
  }
  'team.room.send': {
    payload: { teamId: string; content: string; conversationId: string; mentions?: string[] }
    result: TeamMessage
  }
  'team.interaction.respond': {
    payload: {
      teamId: string
      slotId: string
      interactionId: string
      response: InteractionResponseInput
      conversationId: string
    }
    result: { accepted: boolean }
  }
}
