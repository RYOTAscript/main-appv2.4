import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import type { ToastKind } from '@shared/types'

interface Toast {
  id: number
  kind: ToastKind
  title: string
  detail?: string
}

interface ToastApi {
  toast: (kind: ToastKind, title: string, detail?: string) => void
}

const ToastCtx = createContext<ToastApi>({ toast: () => {} })

export function useToast(): ToastApi {
  return useContext(ToastCtx)
}

const KIND_STYLE: Record<ToastKind, string> = {
  info: 'border-teal/40 text-teal-soft',
  success: 'border-ok/40 text-ok',
  warning: 'border-warn/40 text-warn',
  error: 'border-accent/50 text-accent-soft'
}

const KIND_ICON: Record<ToastKind, string> = {
  info: 'ℹ',
  success: '✓',
  warning: '⚠',
  error: '✕'
}

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const toast = useCallback((kind: ToastKind, title: string, detail?: string) => {
    const id = nextId.current++
    setToasts((t) => [...t, { id, kind, title, detail }])
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id))
    }, kind === 'error' ? 8000 : 4500)
  }, [])

  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-96 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`glass animate-fade-up pointer-events-auto flex items-start gap-3 border px-4 py-3 ${KIND_STYLE[t.kind]}`}
          >
            <span className="mt-0.5 text-sm">{KIND_ICON[t.kind]}</span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-100">{t.title}</div>
              {t.detail && <div className="mt-0.5 break-words text-xs text-slate-400">{t.detail}</div>}
            </div>
            <button
              className="ml-auto text-slate-500 hover:text-slate-200"
              onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}
