import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeAgentTeam,
  getAgentTeamUiState,
  openTeam,
  openTeams,
  setPanelNavigator,
  showTeamPage,
} from '../src/client/store.js'

/**
 * The team management page is a main panel of the frame, so every entry point
 * has to select that panel, and leaving it has to hand the centre back to the
 * Conversation the frame was showing.
 */
describe('team panel navigation', () => {
  const navigate = vi.fn()

  beforeEach(() => {
    navigate.mockClear()
    setPanelNavigator(navigate)
    openTeams()
    navigate.mockClear()
  })

  it('selects the panel when a team page is entered', () => {
    openTeam('team-1')
    expect(navigate).toHaveBeenLastCalledWith('agent-team')
    expect(getAgentTeamUiState()).toEqual({ selectedTeamId: 'team-1' })
  })

  it('returns to the showing page without forgetting where it was', () => {
    openTeam('team-1')
    navigate.mockClear()

    showTeamPage()

    expect(navigate).toHaveBeenCalledWith('agent-team')
    expect(getAgentTeamUiState()).toEqual({ selectedTeamId: 'team-1' })
  })

  it('clears the page and shows the Conversation when the panel is left', () => {
    openTeam('team-1')
    navigate.mockClear()

    closeAgentTeam()

    expect(navigate).toHaveBeenCalledWith(null)
    expect(getAgentTeamUiState()).toEqual({ selectedTeamId: undefined })
  })

  it('shows the team list when the page is opened as a whole', () => {
    openTeam('team-1')
    navigate.mockClear()

    openTeams()

    expect(navigate).toHaveBeenCalledWith('agent-team')
    expect(getAgentTeamUiState()).toEqual({ selectedTeamId: undefined })
  })
})
