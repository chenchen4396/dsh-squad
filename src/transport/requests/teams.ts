import type {
  AddTeamMemberInput,
  CloneTeamInput,
  CreateTeamDraftInput,
} from '../../domain/types.js'
import type {
  PageView,
  TeamView,
} from '../contracts.js'

/** Teams and their membership. */
export interface TeamsRequests {
  'team.list': { payload: undefined; result: PageView<TeamView> }
  'team.get': { payload: { id: string }; result: TeamView }
  'team.createDraft': { payload: CreateTeamDraftInput; result: TeamView }
  'team.clone': { payload: CloneTeamInput & { teamId: string }; result: TeamView }
  'team.start': { payload: { id: string }; result: TeamView }
  'team.addMember': { payload: { teamId: string; value: AddTeamMemberInput }; result: TeamView }
  'team.removeMember': { payload: { teamId: string; slotId: string }; result: TeamView }
  'team.changeLeader': { payload: { teamId: string; successorSlotId: string }; result: TeamView }
  'team.member.stop': {
    payload: { teamId: string; slotId: string; conversationId: string }
    result: { accepted: boolean }
  }
  'team.dissolve': { payload: { teamId: string; confirmation: string }; result: null }
}
