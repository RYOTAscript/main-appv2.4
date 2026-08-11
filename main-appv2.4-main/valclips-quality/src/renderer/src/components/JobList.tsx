import { useState } from 'react'
import { useJobs, vq, fmtBytes, fmtDuration } from '../lib/api'
import { AnalysisBadges, AnalysisDetail } from './AnalysisCard'
import CompareViewer, { QualityReport } from './CompareViewer'
import TunePanel from './TunePanel'
import UploadChecklist, { JobLog } from './UploadChecklist'
import type { Job, JobStatus } from '@shared/types'

const STATUS_META: Record<JobStatus, { label: string; cls: string }> = {
  queued: { label: 'Queued', cls: 'bg-white/10 text-slate-300' },
  analyzing: { label: 'Analyzing', cls: 'bg-teal/15 text-teal-soft' },
  ready: { label: 'Ready', cls: 'bg-teal/15 text-teal-soft' },
  processing: { label: 'Encoding', cls: 'bg-accent/15 text-accent-soft' },
  verifying: { label: 'Verifying', cls: 'bg-warn/15 text-warn' },
  done: { label: 'Done', cls: 'bg-ok/15 text-ok' },
  error: { label: 'Failed', cls: 'bg-accent/20 text-accent-soft' },
  cancelled: { label: 'Cancelled', cls: 'bg-white/10 text-slate-400' }
}

// TikTok's hard limit is ~287 MB for web uploads; the gauge goes green→amber→red
const TIKTOK_SIZE_LIMIT = 287 * 1024 * 1024

function ResultSummary({ job }: { job: Job }): React.JSX.Element {
  const r = job.result!
  const frac = Math.min(1, r.sizeBytes / TIKTOK_SIZE_LIMIT)
  const gaugeColor = frac < 0.5 ? 'bg-ok' : frac < 0.8 ? 'bg-warn' : 'bg-accent'
  return (
    <div className="mt-2 flex items-center gap-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs font-semibold text-slate-200">{fmtBytes(r.sizeBytes)}</span>
        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/10" title={`TikTok limit ~${fmtBytes(TIKTOK_SIZE_LIMIT)}`}>
          <div className={`h-full rounded-full ${gaugeColor}`} style={{ width: `${Math.max(4, frac * 100)}%` }} />
        </div>
      </div>
      {r.wasRemux && <span className="badge bg-ok/15 text-ok">lossless remux</span>}
      {r.vmaf !== null && (
        <span className="badge bg-teal/15 text-teal-soft" title="Measured vs the filtered source — how much the encode itself lost">
          VMAF {r.vmaf.toFixed(1)}
        </span>
      )}
      {r.finalCrf !== null && <span className="badge bg-white/10 text-slate-400">CRF {r.finalCrf}</span>}
      {r.compressionPercent !== null && r.compressionPercent > 0 && (
        <span className="badge bg-ok/15 text-ok">−{r.compressionPercent}% size</span>
      )}
    </div>
  )
}

function JobRow({ job }: { job: Job }): React.JSX.Element {
  const meta = STATUS_META[job.status]
  const busy = ['analyzing', 'processing', 'verifying'].includes(job.status)
  const [expanded, setExpanded] = useState(false)
  const [tuning, setTuning] = useState(false)
  const [comparing, setComparing] = useState(false)

  return (
    <div
      className="glass glass-hover animate-fade-up cursor-pointer px-4 py-3"
      onClick={() => job.analysis && setExpanded((e) => !e)}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-slate-100">{job.fileName}</span>
            <span className={`badge ${meta.cls}`}>{meta.label}</span>
            {job.analysis && (
              <span className="text-[10px] text-slate-600">{expanded ? '▲' : '▼ details'}</span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
            <span className="truncate">{job.note}</span>
            {job.analysis && (
              <>
                <span>·</span>
                <span>{fmtDuration(job.analysis.probe.durationSec)}</span>
                <span>·</span>
                <span>{fmtBytes(job.analysis.probe.sizeBytes)}</span>
              </>
            )}
          </div>
          {job.analysis && (
            <div className="mt-2">
              <AnalysisBadges analysis={job.analysis} />
            </div>
          )}
          {busy && job.progress && (
            <div className="mt-2">
              <div className="flex items-center justify-between text-[11px] text-slate-500">
                <span>{job.progress.stage}</span>
                <span className="font-mono">
                  {job.progress.fps > 0 && `${job.progress.fps.toFixed(0)} fps · `}
                  {job.progress.etaSec > 0 && `ETA ${fmtDuration(job.progress.etaSec)} · `}
                  {job.progress.percent.toFixed(0)}%
                </span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-accent to-teal transition-all duration-300"
                  style={{ width: `${Math.min(100, job.progress.percent)}%` }}
                />
              </div>
            </div>
          )}
          {job.status === 'error' && job.error && (
            <div className="mt-1 break-words text-xs text-accent-soft/80">{job.error}</div>
          )}
          {job.status === 'done' && job.result && <ResultSummary job={job} />}
          {job.status === 'done' && <UploadChecklist job={job} />}
          {expanded && job.status === 'done' && job.result && !job.result.wasRemux && (
            <QualityReport job={job} />
          )}
          {expanded && job.analysis && <AnalysisDetail analysis={job.analysis} plan={job.plan} />}
          {(expanded || job.status === 'error') && <JobLog job={job} />}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {(busy || job.status === 'queued') && (
            <button
              className="btn-ghost !px-3 !py-1.5 text-xs !text-accent-soft hover:!border-accent/40"
              onClick={(e) => {
                e.stopPropagation()
                void vq.jobs.cancel(job.id)
              }}
            >
              Cancel
            </button>
          )}
          {job.analysis && !busy && (
            <button
              className="btn-ghost !px-3 !py-1.5 text-xs"
              title="Manual sliders + live before/after preview (optional)"
              onClick={(e) => {
                e.stopPropagation()
                setTuning(true)
              }}
            >
              Tune{job.overrides ? ' •' : ''}
            </button>
          )}
          {job.status === 'done' && job.result && (
            <>
              <button
                className="btn-ghost !px-3 !py-1.5 text-xs"
                title="Wipe/side-by-side comparison at the highest-motion moments"
                onClick={(e) => {
                  e.stopPropagation()
                  setComparing(true)
                }}
              >
                Compare
              </button>
              <button
                className="btn-ghost !px-3 !py-1.5 text-xs"
                onClick={(e) => {
                  e.stopPropagation()
                  void vq.shell.showInFolder(job.result!.outputPath)
                }}
              >
                Show file
              </button>
            </>
          )}
          {!busy && (
            <button
              className="rounded-md px-2 py-1 text-slate-500 transition-colors hover:bg-white/5 hover:text-slate-200"
              title="Remove from queue"
              onClick={(e) => {
                e.stopPropagation()
                void vq.jobs.remove(job.id)
              }}
            >
              ✕
            </button>
          )}
        </div>
      </div>
      {tuning && (
        <div onClick={(e) => e.stopPropagation()}>
          <TunePanel job={job} onClose={() => setTuning(false)} />
        </div>
      )}
      {comparing && (
        <div onClick={(e) => e.stopPropagation()}>
          <CompareViewer job={job} onClose={() => setComparing(false)} />
        </div>
      )}
    </div>
  )
}

export default function JobList(): React.JSX.Element | null {
  const jobs = useJobs()
  if (jobs.length === 0) return null
  const finished = jobs.filter((j) => ['done', 'error', 'cancelled'].includes(j.status)).length

  return (
    <div className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
          Queue · {jobs.length}
        </h2>
        {finished > 0 && (
          <button
            className="text-xs text-slate-500 transition-colors hover:text-slate-200"
            onClick={() => void vq.jobs.clearFinished()}
          >
            Clear finished
          </button>
        )}
      </div>
      <div className="flex flex-col gap-2">
        {jobs.map((j) => (
          <JobRow key={j.id} job={j} />
        ))}
      </div>
    </div>
  )
}
