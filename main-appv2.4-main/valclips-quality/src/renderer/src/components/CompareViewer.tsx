import { useCallback, useEffect, useRef, useState } from 'react'
import type { Job } from '@shared/types'
import { vq, fmtBytes } from '../lib/api'
import { useToast } from '../lib/toast'

// Motion-hotspot comparison viewer: wipe slider + side-by-side, frame
// stepping and zoom, opened exactly at the highest-motion moments — where
// TikTok damage shows first. "Expected" is what the encoder was given;
// "Actual" is the exported file.

export function verdictFor(vmaf: number): { text: string; cls: string } {
  if (vmaf >= 97) return { text: 'indistinguishable from source', cls: 'text-ok' }
  if (vmaf >= 93) return { text: 'virtually identical — differences invisible at phone size', cls: 'text-ok' }
  if (vmaf >= 85) return { text: 'minor differences visible on close inspection', cls: 'text-warn' }
  return { text: 'visible quality loss — consider Master mode', cls: 'text-accent-soft' }
}

export default function CompareViewer({ job, onClose }: { job: Job; onClose: () => void }): React.JSX.Element {
  const { toast } = useToast()
  const hotspots = job.result?.hotspots ?? []
  const [spot, setSpot] = useState(0)
  const [mode, setMode] = useState<'wipe' | 'side'>('wipe')
  const [wipe, setWipe] = useState(50)
  const [zoom, setZoom] = useState(1)
  const [playing, setPlaying] = useState(true)
  const [pair, setPair] = useState<{ expectedUrl: string; actualUrl: string; fps: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const vidA = useRef<HTMLVideoElement>(null)
  const vidB = useRef<HTMLVideoElement>(null)

  const timeSec = hotspots.length > 0 ? hotspots[spot]?.timeSec ?? 0 : 0

  // frame the viewer to the actual output shape (9:16 or 16:9 or remuxed source)
  const scale = job.plan?.filters.scale
  const aspect = scale
    ? `${scale.targetW}/${scale.targetH}`
    : job.analysis
      ? `${job.analysis.probe.video.width}/${job.analysis.probe.video.height}`
      : '9/16'

  useEffect(() => {
    let alive = true
    setLoading(true)
    setPair(null)
    vq.preview
      .compare(job.id, timeSec)
      .then((p) => {
        if (alive) {
          setPair(p)
          setLoading(false)
          setPlaying(true)
        }
      })
      .catch((err: Error) => {
        if (alive) {
          setLoading(false)
          toast('error', 'Comparison failed', err.message)
        }
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id, timeSec])

  // keep the two videos in lockstep
  const syncPlay = useCallback((play: boolean) => {
    for (const v of [vidA.current, vidB.current]) {
      if (!v) continue
      if (play) void v.play()
      else v.pause()
    }
    setPlaying(play)
  }, [])

  const step = useCallback(
    (dir: 1 | -1) => {
      const fps = pair?.fps ?? 60
      syncPlay(false)
      const a = vidA.current
      const b = vidB.current
      if (!a || !b) return
      const t = Math.max(0, Math.min(a.duration || 2, a.currentTime + dir / fps))
      a.currentTime = t
      b.currentTime = t
    },
    [pair, syncPlay]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        step(1)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        step(-1)
      } else if (e.key === ' ') {
        e.preventDefault()
        syncPlay(!playing)
      } else if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, syncPlay, playing, onClose])

  const videoStyle: React.CSSProperties = {
    transform: zoom > 1 ? `scale(${zoom})` : undefined,
    transformOrigin: 'center'
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-md">
      {/* header */}
      <div className="flex items-center gap-4 border-b border-white/10 px-6 py-3">
        <div className="text-sm font-bold text-white">Compare — {job.fileName}</div>
        <div className="flex gap-1">
          {hotspots.map((h, i) => (
            <button
              key={i}
              onClick={() => setSpot(i)}
              className={`badge ${spot === i ? 'bg-accent text-white' : 'bg-white/10 text-slate-400 hover:bg-white/20'}`}
              title={`Motion score ${h.score}`}
            >
              🔥 {h.timeSec.toFixed(0)}s
            </button>
          ))}
          {hotspots.length === 0 && <span className="text-xs text-slate-500">no hotspots — showing clip start</span>}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border border-white/10">
            {(['wipe', 'side'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-3 py-1 text-xs font-semibold ${mode === m ? 'bg-accent text-white' : 'text-slate-400 hover:bg-white/5'}`}
              >
                {m === 'wipe' ? 'Wipe' : 'Side by side'}
              </button>
            ))}
          </div>
          <div className="flex overflow-hidden rounded-lg border border-white/10">
            {[1, 2, 3].map((z) => (
              <button
                key={z}
                onClick={() => setZoom(z)}
                className={`px-2.5 py-1 text-xs font-semibold ${zoom === z ? 'bg-teal/80 text-ink-950' : 'text-slate-400 hover:bg-white/5'}`}
              >
                {z}×
              </button>
            ))}
          </div>
          <button className="btn-ghost !px-3 !py-1 text-xs" onClick={onClose}>
            Close (Esc)
          </button>
        </div>
      </div>

      {/* stage */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
        {loading && <div className="text-sm text-slate-400">Rendering comparison at {timeSec.toFixed(0)}s…</div>}
        {pair && mode === 'wipe' && (
          <div className="relative h-full max-w-full overflow-hidden rounded-lg" style={{ aspectRatio: aspect }}>
            <div className="h-full w-full overflow-hidden">
              <video ref={vidA} src={pair.expectedUrl} autoPlay loop muted className="h-full w-full object-contain" style={videoStyle} />
            </div>
            <div
              className="absolute inset-0 overflow-hidden"
              style={{ clipPath: `inset(0 0 0 ${wipe}%)` }}
            >
              <video ref={vidB} src={pair.actualUrl} autoPlay loop muted className="h-full w-full object-contain" style={videoStyle} />
            </div>
            <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-accent shadow-glow" style={{ left: `${wipe}%` }} />
            <span className="absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 text-[10px] font-bold text-teal-soft">EXPECTED</span>
            <span className="absolute right-2 top-2 rounded bg-black/60 px-2 py-0.5 text-[10px] font-bold text-accent-soft">ACTUAL</span>
          </div>
        )}
        {pair && mode === 'side' && (
          <div className="flex h-full max-w-full items-center justify-center gap-2">
            {[
              { url: pair.expectedUrl, label: 'EXPECTED', ref: vidA, labelCls: 'text-teal-soft' },
              { url: pair.actualUrl, label: 'ACTUAL', ref: vidB, labelCls: 'text-accent-soft' }
            ].map((side) => (
              <div key={side.label} className="relative h-full overflow-hidden rounded-lg" style={{ aspectRatio: aspect }}>
                <video ref={side.ref} src={side.url} autoPlay loop muted className="h-full w-full object-contain" style={videoStyle} />
                <span className={`absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 text-[10px] font-bold ${side.labelCls}`}>
                  {side.label}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* transport */}
      <div className="flex items-center gap-4 border-t border-white/10 px-6 py-3">
        <button className="btn-ghost !px-3 !py-1.5 text-xs" onClick={() => step(-1)} title="Previous frame (←)">
          ⏮ frame
        </button>
        <button className="btn-primary !px-4 !py-1.5 text-xs" onClick={() => syncPlay(!playing)}>
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <button className="btn-ghost !px-3 !py-1.5 text-xs" onClick={() => step(1)} title="Next frame (→)">
          frame ⏭
        </button>
        {mode === 'wipe' && (
          <div className="flex flex-1 items-center gap-3">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">wipe</span>
            <input type="range" min={0} max={100} value={wipe} onChange={(e) => setWipe(parseInt(e.target.value, 10))} />
          </div>
        )}
        <span className="ml-auto text-[11px] text-slate-500">
          space = play/pause · ←/→ = frame step
        </span>
      </div>
    </div>
  )
}

export function QualityReport({ job }: { job: Job }): React.JSX.Element | null {
  const { toast } = useToast()
  const r = job.result
  if (!r) return null
  const verdict = r.vmaf !== null ? verdictFor(r.vmaf) : null
  const bitrateMbps =
    job.analysis && job.analysis.probe.durationSec > 0
      ? ((r.sizeBytes * 8) / job.analysis.probe.durationSec / 1_000_000).toFixed(1)
      : null

  return (
    <div className="mt-3 border-t border-white/5 pt-3">
      {verdict && r.vmaf !== null && (
        <div className="text-sm font-semibold">
          <span className="text-white">VMAF {r.vmaf.toFixed(1)}</span>{' '}
          <span className={verdict.cls}>— {verdict.text}</span>
        </div>
      )}
      <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
        <Stat label="Size" value={fmtBytes(r.sizeBytes)} />
        {bitrateMbps && <Stat label="Bitrate" value={`${bitrateMbps} Mbps`} />}
        {r.ssim !== null && <Stat label="SSIM" value={r.ssim.toFixed(4)} />}
        {r.finalCrf !== null && <Stat label="Final CRF" value={String(r.finalCrf)} />}
        {r.compressionPercent !== null && r.compressionPercent > 0 && (
          <Stat label="Saved" value={`${r.compressionPercent}% smaller`} />
        )}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 font-mono text-[10px] text-slate-500">
          {r.ffmpegCommand}
        </code>
        <button
          className="btn-ghost !px-3 !py-1.5 text-xs shrink-0"
          onClick={() => {
            void navigator.clipboard.writeText(r.ffmpegCommand)
            toast('success', 'FFmpeg command copied')
          }}
        >
          Copy
        </button>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-slate-500">{label}</span>
      <span className="font-mono text-slate-200">{value}</span>
    </div>
  )
}
