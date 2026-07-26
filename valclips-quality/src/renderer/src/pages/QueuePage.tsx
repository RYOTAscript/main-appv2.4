import { useState } from 'react'
import DropZone from '../components/DropZone'
import FFmpegCard from '../components/FFmpegCard'
import JobList from '../components/JobList'
import { useSettings, vq } from '../lib/api'
import { useToast } from '../lib/toast'

// Output format selector — the two supported targets. Changing it affects
// clips dropped afterwards; already-planned clips keep their plan unless re-run.
function OrientationToggle(): React.JSX.Element | null {
  const [settings, update] = useSettings()
  if (!settings) return null
  return (
    <div className="mb-3 flex items-center justify-between">
      <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
        Output format
      </span>
      <div className="flex overflow-hidden rounded-lg border border-white/10">
        {(
          [
            ['maintain', 'Keep aspect', 'Keep the source aspect ratio — no padding or cropping (4K/1440p still downscaled for quality)'],
            ['vertical', '9:16 + blur', 'Force vertical 1080×1920 — mismatched sources get a blurred background pad'],
            ['horizontal', '16:9 + blur', 'Force horizontal 1920×1080 — mismatched sources get a blurred background pad']
          ] as const
        ).map(([value, label, title]) => (
          <button
            key={value}
            title={title}
            onClick={() => update({ orientation: value })}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold transition-colors ${
              settings.orientation === value ? 'bg-accent text-white' : 'text-slate-400 hover:bg-white/5'
            }`}
          >
            <span
              className={`inline-block rounded-[2px] border ${
                settings.orientation === value ? 'border-white/80' : 'border-slate-500'
              } ${value === 'vertical' ? 'h-3.5 w-2' : value === 'horizontal' ? 'h-2 w-3.5' : 'h-3 w-3 rounded-full'}`}
            />
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}

interface ConfirmItem {
  path: string
  outputPath: string
}

interface SelectionItem {
  folder: string
  files: string[]
}

export default function QueuePage(): React.JSX.Element {
  const [confirmItems, setConfirmItems] = useState<ConfirmItem[]>([])
  const [selection, setSelection] = useState<SelectionItem | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const { toast } = useToast()

  const resolveConfirm = (overwrite: boolean): void => {
    const items = confirmItems
    setConfirmItems([])
    if (!overwrite) return
    void vq.files.add(items.map((i) => i.path), true).then((res) => {
      if (res.accepted.length > 0) toast('success', `${res.accepted.length} clip(s) queued (overwriting old output)`)
    })
  }

  const openSelection = (items: SelectionItem[]): void => {
    if (items.length === 0) return
    setSelection(items[0])
    setChecked(new Set(items[0].files))
  }

  const resolveSelection = (confirm: boolean): void => {
    const files = selection ? [...checked] : []
    setSelection(null)
    if (!confirm || files.length === 0) return
    void vq.files.add(files).then((res) => {
      if (res.accepted.length > 0) toast('success', `${res.accepted.length} clip(s) queued from folder`)
      if (res.needsConfirm.length > 0) setConfirmItems(res.needsConfirm)
    })
  }

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <div className="mb-6 flex flex-col gap-3">
        <FFmpegCard />
      </div>

      <OrientationToggle />
      <DropZone onNeedsConfirm={setConfirmItems} onNeedsSelection={openSelection} />
      <JobList />

      {selection && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="glass animate-fade-up w-[30rem] max-w-[90vw] px-6 py-5">
            <div className="text-sm font-semibold text-slate-100">
              This folder has {selection.files.length} videos — which ones?
            </div>
            <div className="mt-1 truncate font-mono text-[11px] text-slate-600">{selection.folder}</div>
            <div className="mt-3 flex max-h-64 flex-col gap-1 overflow-y-auto">
              {selection.files.map((f) => {
                const name = f.split(/[\\/]/).pop() ?? f
                return (
                  <label key={f} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-slate-300 hover:bg-white/5">
                    <input
                      type="checkbox"
                      checked={checked.has(f)}
                      onChange={(e) => {
                        const next = new Set(checked)
                        if (e.target.checked) next.add(f)
                        else next.delete(f)
                        setChecked(next)
                      }}
                      className="h-4 w-4 accent-[#ff4655]"
                    />
                    <span className="truncate">{name}</span>
                  </label>
                )
              })}
            </div>
            <div className="mt-4 flex items-center gap-2">
              <button
                className="text-xs text-slate-500 hover:text-slate-200"
                onClick={() => setChecked(checked.size === selection.files.length ? new Set() : new Set(selection.files))}
              >
                {checked.size === selection.files.length ? 'Select none' : 'Select all'}
              </button>
              <div className="ml-auto flex gap-2">
                <button className="btn-ghost" onClick={() => resolveSelection(false)}>
                  Cancel
                </button>
                <button className="btn-primary" onClick={() => resolveSelection(true)} disabled={checked.size === 0}>
                  Queue {checked.size} clip{checked.size === 1 ? '' : 's'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {confirmItems.length > 0 && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="glass animate-fade-up w-[28rem] max-w-[90vw] px-6 py-5">
            <div className="text-sm font-semibold text-slate-100">Output already exists</div>
            <div className="mt-2 max-h-40 overflow-y-auto text-xs text-slate-400">
              {confirmItems.map((i) => (
                <div key={i.path} className="truncate py-0.5 font-mono">
                  {i.outputPath}
                </div>
              ))}
            </div>
            <div className="mt-2 text-xs text-slate-500">
              A previous export with this name exists. Overwrite it with the new result?
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => resolveConfirm(false)}>
                Keep old file
              </button>
              <button className="btn-primary" onClick={() => resolveConfirm(true)}>
                Overwrite
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
