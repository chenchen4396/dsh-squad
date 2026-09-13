import { useEffect, useState } from 'react'
import type { ModelCapabilitiesView } from '../transport/contracts.js'
import { callAgentTeam } from './api.js'

export interface ModelCapabilitiesState {
  value?: ModelCapabilitiesView
  loading: boolean
  error?: string
}

export function useModelCapabilities(provider: string, model: string): ModelCapabilitiesState {
  const [state, setState] = useState<ModelCapabilitiesState>({ loading: false })

  useEffect(() => {
    let active = true
    if (!provider || !model) {
      setState({ loading: false })
      return () => { active = false }
    }
    setState({ loading: true })
    void callAgentTeam('catalog.model.get', { provider, model })
      .then(value => {
        if (active) setState({ value, loading: false })
      })
      .catch(cause => {
        if (!active) return
        setState({
          loading: false,
          error: cause instanceof Error ? cause.message : String(cause),
        })
      })
    return () => { active = false }
  }, [model, provider])

  if (state.value !== undefined
    && (state.value.provider !== provider || state.value.model !== model)) {
    return { loading: true }
  }
  return state
}

export function reasoningEffortLabel(
  capabilities: ModelCapabilitiesView | undefined,
  effortId: string,
): string {
  const effort = capabilities?.reasoning?.efforts.find(candidate => candidate.id === effortId)
  return effort?.name ?? effortId
}

export function defaultReasoningLabel(capabilities: ModelCapabilitiesView | undefined): string {
  const defaultEffort = capabilities?.reasoning?.defaultEffort
  return defaultEffort === undefined
    ? '模型默认'
    : `模型默认（${reasoningEffortLabel(capabilities, defaultEffort)}）`
}
