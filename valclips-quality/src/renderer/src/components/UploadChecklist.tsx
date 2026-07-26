import { useState } from 'react'
import type { Job } from '@shared/types'

// Post-export guidance: the encode is only half the battle — uploading wrong
// undoes all of it. Shown beside every finished file.

const CHECKLIST = [
  {
    title: 'Upload via tiktok.com on desktop',
    detail: 'The web uploader takes the file with far less preprocessing than the phone app.'
  },
  {
    title: 'Enable "Upload HD" before posting',
    detail: 'Toggle it in the upload dialog every time — it is off by default and it is the single biggest quality switch.'
  },
  {
    title: 'Never add TikTok text/filters/stickers afterward',
    detail: 'Any in-app edit forces a second re-encode of the whole video. Bake text into the edit instead.'
  },
  {
    title: 'Judge quality only 30–60 min after posting',
    detail: 'TikTok serves a low-res version first while the HD rendition processes. What you see immediately is not final.'
  }
]

export default function UploadChecklist({ job }: { job: Job }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (job.status !== 'done' || !job.result) return null

  return (
    <div className="mt-3 rounded-lg border border-teal/20 bg-teal/5 px-3 py-2">
      <button
        className="flex w-full items-center gap-2 text-left text-xs font-semibold text-teal-soft"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
      >
        📋 Upload checklist — don't lose quality at the last step {open ? '▲' : '▼'}
      </button>
      {open && (
        <ol className="mt-2 flex flex-col gap-2">
          {CHECKLIST.map((item, i) => (
            <li key={i} className="flex gap-2 text-xs">
              <span className="font-mono text-teal-soft">{i + 1}.</span>
              <span>
                <span className="font-semibold text-slate-200">{item.title}</span>
                <br />
                <span className="text-slate-500">{item.detail}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

export function JobLog({ job }: { job: Job }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (job.logTail.length === 0) return null
  return (
    <div className="mt-2">
      <button
        className="text-[11px] text-slate-500 hover:text-slate-300"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
      >
        {open ? '▲ hide' : '▼ show'} raw FFmpeg log ({job.logTail.length} lines)
      </button>
      {open && (
        <pre className="mt-1 max-h-48 select-text overflow-auto rounded-lg border border-white/10 bg-black/50 p-2 font-mono text-[10px] leading-relaxed text-slate-400">
          {job.logTail.join('\n')}
        </pre>
      )}
    </div>
  )
}
