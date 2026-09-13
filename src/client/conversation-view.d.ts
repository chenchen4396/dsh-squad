/**
 * Minimal declarations for the DSH client contracts this plugin contributes to.
 *
 * The plugin does not depend on DSH's client UI packages at build time, so it
 * declares exactly the parts it registers against: one entry in the
 * conversation's View roster (the 对话 / 轨迹 / 团队 tabs), one entry in the
 * conversation's composer chain, and the `sessionId` every Session-scoped slot
 * component receives.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Registered Conversation target Views, rendered one at a time. */
    'conversation.view': {
      kind: 'list'
      scope: 'session'
      owner: {
        /** Focus request addressed to the selected View. */
        viewRequest: { readonly view: string; readonly focus: string } | null
        /** Select a View and address one opaque focus identity to it. */
        openView: (view: string, focus: string) => void
        /** Acknowledge the current one-shot focus request. */
        completeViewRequest: () => void
      }
    }
    /**
     * The conversation's composer, as a selector-routed chain whose fallback is
     * the Harness's own composer. An elected entry replaces that composer while
     * the fallback stays mounted and hidden, so a view can take over the send
     * target without losing what the reader already typed.
     */
    'conversation.composer': {
      kind: 'chain'
      scope: 'session'
      owner: {
        /** Identity of the Session whose composer the owner is rendering. */
        sessionId: string
      }
    }
    /**
     * Compact controls in the composer tool row, rendered immediately before
     * the model selector. A team is enabled per Session, so the switch that
     * decides that belongs here rather than behind the 团队 view.
     */
    'conversation.input.right': {
      kind: 'list'
      scope: 'session'
      owner: Record<string, never>
    }
  }

  interface SessionStandardProps {
    /** Identity of the Session a Session-scoped slot is rendering for. */
    sessionId: string
  }

  interface GlobalStandardProps {
    /** Framework standard hook over the Harness Session list and selection. */
    useSessions: <S>(selector: (state: { current?: string | undefined }) => S) => S
  }
}

export {}
