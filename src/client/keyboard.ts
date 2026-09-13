export interface ComposerKeyStroke {
  key: string
  shiftKey: boolean
  isComposing: boolean
  keyCode: number
}

export function shouldSubmitComposer(
  event: ComposerKeyStroke,
  compositionActive: boolean,
): boolean {
  return event.key === 'Enter'
    && !event.shiftKey
    && !compositionActive
    && !event.isComposing
    && event.keyCode !== 229
}
