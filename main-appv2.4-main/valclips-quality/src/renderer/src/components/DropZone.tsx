import { useCallback, useState } from 'react'
import { vq } from '../lib/api'
import { useToast } from '../lib/toast'
import type { AddFilesResult } from '@shared/types'

// Hero drop zone — the zero-config Express path. Drop a clip, get a great
// result: analysis + optimal plan + encode all happen automatically.

export default function DropZone({
  onNeedsConfirm,
  onNeedsSelection
}: {
  onNeedsConfirm: (items: { path: string; outputPath: string }[]) => void
  onNeedsSelection: (items: { folder: string; files: string[] }[]) => void
}): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const { toast } = useToast()

  const handleResult = useCallback(
    (res: AddFilesResult | null) => {
      if (!res) return
      if (res.accepted.length > 0) {
        toast(
          'success',
          `${res.accepted.length} clip${res.accepted.length > 1 ? 's' : ''} queued`,
          'Express mode: analyze → optimal plan → encode, automatically.'
        )
      }
      for (const rej of res.rejected) {
        toast('warning', rej.path.split(/[\\/]/).pop() ?? rej.path, rej.reason)
      }
      if (res.needsConfirm.length > 0) onNeedsConfirm(res.needsConfirm)
      if (res.needsSelection.length > 0) onNeedsSelection(res.needsSelection)
    },
    [toast, onNeedsConfirm, onNeedsSelection]
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const paths: string[] = []
      for (const file of Array.from(e.dataTransfer.files)) {
        try {
          const p = vq.pathForFile(file)
          if (p) paths.push(p)
        } catch {
          toast('error', 'Could not read dropped file', file.name)
        }
      }
      if (paths.length === 0) return
      void vq.files.add(paths).then(handleResult)
    },
    [handleResult, toast]
  )

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onClick={() => void vq.files.openDialog().then(handleResult)}
      className={`glass glass-hover group relative flex min-h-44 cursor-pointer flex-col items-center justify-center gap-2 border-2 border-dashed px-6 py-10 text-center transition-all ${
        dragging ? 'scale-[1.01] border-accent/60 bg-accent/5 shadow-glow' : 'border-white/10'
      }`}
    >
      <div
        className={`text-4xl transition-transform duration-200 ${dragging ? 'scale-125' : 'group-hover:scale-110'}`}
      >
        🎬
      </div>
      <div className="text-base font-semibold text-slate-100">
        {dragging ? 'Drop it — we take it from here' : 'Drop your Valorant edit here'}
      </div>
      <div className="text-xs text-slate-500">
        Zero config: analyzed, cleaned and encoded for TikTok automatically
      </div>
      <div className="mt-1 text-[11px] text-slate-600">
        .mp4 · .mov · .mkv · .avi · .webm · .m4v — or click to browse (<span className="kbd">Ctrl+O</span>)
      </div>
    </div>
  )
}
