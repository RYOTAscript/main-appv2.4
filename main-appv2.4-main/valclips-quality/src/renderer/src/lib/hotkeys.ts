import { useEffect } from 'react'

// Tiny keyboard-shortcut framework: components declare combos declaratively;
// inputs/textareas are automatically excluded so typing never triggers actions.

export interface Hotkey {
  combo: string // e.g. "ctrl+o", "escape", "1"
  handler: () => void
  allowInInputs?: boolean
}

function matches(e: KeyboardEvent, combo: string): boolean {
  const parts = combo.toLowerCase().split('+')
  const key = parts[parts.length - 1]
  const needCtrl = parts.includes('ctrl')
  const needShift = parts.includes('shift')
  const needAlt = parts.includes('alt')
  if (e.ctrlKey !== needCtrl || e.shiftKey !== needShift || e.altKey !== needAlt) return false
  return e.key.toLowerCase() === key
}

export function useHotkeys(hotkeys: Hotkey[]): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      const inInput =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      for (const hk of hotkeys) {
        if (inInput && !hk.allowInInputs) continue
        if (matches(e, hk.combo)) {
          e.preventDefault()
          hk.handler()
          return
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hotkeys])
}
