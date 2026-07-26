import { useEffect, useMemo, useRef, useState } from 'react'
import type { FilterPlan, Job } from '@shared/types'
import { vq } from '../lib/api'
import { useToast } from '../lib/toast'

// Opt-in tuning panel. The Express path never needs this — it exists for
// people who want manual control, with an honest 2-second live preview
// rendered through the real filter chain.

interface Props {
  job: Job
  onClose: () => void
}

export default function TunePanel({ job, onClose }: Props): React.JSX.Element {
  const base = job.plan?.filters
  const { toast } = useToast()

  const [denoise, setDenoise] = useState(job.overrides?.denoise ?? base?.denoise ?? 0)
  const [sharpen, setSharpen] = useState(job.overrides?.sharpen ?? base?.sharpen ?? 0.25)
  const [saturation, setSaturation] = useState(
    job.overrides?.saturationBoost ?? base?.saturationBoost ?? 1.05
  )
  const [contrast, setContrast] = useState(job.overrides?.contrastBoost ?? base?.contrastBoost ?? 1.02)
  const [scaleMode, setScaleMode] = useState<'fit-pad' | 'fill-crop'>(
    (job.overrides?.scale?.mode as 'fit-pad' | 'fill-crop') ??
      (base?.scale?.mode === 'fill-crop' ? 'fill-crop' : 'fit-pad')
  )
  const [minterpolate, setMinterpolate] = useState(
    job.overrides?.minterpolate ?? base?.minterpolate ?? false
  )
  const [preview, setPreview] = useState<{ beforeUrl: string; afterUrl: string } | null>(null)
  const [rendering, setRendering] = useState(false)
  const previewSeq = useRef(0)

  const showScaleChoice = !!base?.scale && base.scale.mode !== 'none'

  // preview boxes match the output shape (9:16 or 16:9)
  const previewAspect = base?.scale
    ? `${base.scale.targetW}/${base.scale.targetH}`
    : job.analysis
      ? `${job.analysis.probe.video.width}/${job.analysis.probe.video.height}`
      : '9/16'

  const overrides = useMemo((): Partial<FilterPlan> => {
    const o: Partial<FilterPlan> = {
      denoise,
      // stronger cleanup gets the higher-quality (slower) filter automatically
      denoiseFilter: denoise <= 0 ? 'none' : denoise > 55 ? 'nlmeans' : 'hqdn3d',
      sharpen,
      saturationBoost: saturation,
      contrastBoost: contrast,
      minterpolate
    }
    if (showScaleChoice && base?.scale) o.scale = { ...base.scale, mode: scaleMode }
    return o
  }, [denoise, sharpen, saturation, contrast, minterpolate, scaleMode, showScaleChoice, base])

  // debounce live preview: re-render 600 ms after the last slider move
  useEffect(() => {
    if (!job.analysis) return
    const mySeq = ++previewSeq.current
    setRendering(true)
    const t = window.setTimeout(() => {
      vq.preview
        .generate(job.id, overrides)
        .then((res) => {
          if (previewSeq.current === mySeq) {
            setPreview(res)
            setRendering(false)
          }
        })
        .catch((err: Error) => {
          if (previewSeq.current === mySeq) {
            setRendering(false)
            if (!String(err.message).includes('superseded'))
              toast('error', 'Preview failed', err.message)
          }
        })
    }, 600)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrides, job.id])

  const apply = async (): Promise<void> => {
    await vq.jobs.setOverrides(job.id, overrides)
    if (['done', 'error', 'cancelled', 'ready'].includes(job.status)) {
      await vq.jobs.requeue(job.id)
      toast('info', 'Re-processing with your settings')
    } else {
      toast('success', 'Settings will be used for this clip')
    }
    onClose()
  }

  const reset = async (): Promise<void> => {
    await vq.jobs.setOverrides(job.id, null)
    toast('info', 'Back to automatic settings')
    onClose()
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
      <div className="glass animate-fade-up flex max-h-full w-[64rem] max-w-full flex-col overflow-hidden">
        <div className="flex items-center gap-3 border-b border-white/5 px-6 py-4">
          <div>
            <div className="text-sm font-bold text-white">Tune — {job.fileName}</div>
            <div className="text-xs text-slate-500">
              Preview shows the real filter chain on a 2-second slice of your clip.
            </div>
          </div>
          <button className="ml-auto text-slate-500 hover:text-slate-200" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 overflow-y-auto p-6 lg:grid-cols-[1fr_20rem]">
          {/* preview */}
          <div>
            <div className="grid grid-cols-2 gap-3">
              {(['before', 'after'] as const).map((side) => (
                <div key={side}>
                  <div className="mb-1 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    {side}
                  </div>
                  <div
                    className="relative flex max-h-[60vh] items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-black/40"
                    style={{ aspectRatio: previewAspect }}
                  >
                    {preview ? (
                      <video
                        key={side === 'before' ? preview.beforeUrl : preview.afterUrl}
                        src={side === 'before' ? preview.beforeUrl : preview.afterUrl}
                        autoPlay
                        loop
                        muted
                        className="max-h-full max-w-full"
                      />
                    ) : (
                      <div className="text-xs text-slate-600">rendering…</div>
                    )}
                    {rendering && (
                      <div className="absolute inset-x-0 top-0 h-0.5 animate-shimmer bg-gradient-to-r from-transparent via-accent to-transparent bg-[length:200%_100%]" />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* sliders */}
          <div className="flex flex-col gap-5">
            <div>
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold text-slate-200">Particle &amp; noise cleanup</span>
                <span className="font-mono text-xs text-teal-soft">
                  {denoise === 0 ? 'off' : `${denoise} · ${denoise > 55 ? 'nlmeans' : 'hqdn3d'}`}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={denoise}
                onChange={(e) => setDenoise(parseInt(e.target.value, 10))}
                className="mt-2"
              />
              <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                Removes random fine grain that wastes TikTok bitrate, so the encoder spends it on your
                gameplay instead. Too high softens intentional VFX — ability particles and muzzle
                flashes. When in doubt, keep it low.
              </p>
            </div>

            <div>
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold text-slate-200">Pre-sharpen</span>
                <span className="font-mono text-xs text-teal-soft">{sharpen.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={0.8}
                step={0.05}
                value={sharpen}
                onChange={(e) => setSharpen(parseFloat(e.target.value))}
                className="mt-2"
              />
              <p className="mt-1.5 text-[11px] text-slate-500">
                Counters TikTok's softening. Subtle is best — halos look worse than softness.
              </p>
            </div>

            <div>
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold text-slate-200">Saturation</span>
                <span className="font-mono text-xs text-teal-soft">{saturation.toFixed(2)}×</span>
              </div>
              <input
                type="range"
                min={1}
                max={1.25}
                step={0.01}
                value={saturation}
                onChange={(e) => setSaturation(parseFloat(e.target.value))}
                className="mt-2"
              />
            </div>

            <div>
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold text-slate-200">Contrast</span>
                <span className="font-mono text-xs text-teal-soft">{contrast.toFixed(2)}×</span>
              </div>
              <input
                type="range"
                min={1}
                max={1.15}
                step={0.01}
                value={contrast}
                onChange={(e) => setContrast(parseFloat(e.target.value))}
                className="mt-2"
              />
            </div>

            {showScaleChoice && (
              <div>
                <span className="text-sm font-semibold text-slate-200">Aspect framing</span>
                <div className="mt-2 flex overflow-hidden rounded-lg border border-white/10">
                  {(
                    [
                      ['fit-pad', 'Fit + blurred pad'],
                      ['fill-crop', 'Fill (crop sides)']
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      onClick={() => setScaleMode(mode)}
                      className={`flex-1 px-3 py-1.5 text-xs font-semibold transition-colors ${
                        scaleMode === mode ? 'bg-accent text-white' : 'text-slate-400 hover:bg-white/5'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] text-slate-500">Never stretched, ever.</p>
              </div>
            )}

            <label className="flex items-start gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={minterpolate}
                onChange={(e) => setMinterpolate(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[#ff4655]"
              />
              <span>
                <span className="font-semibold text-slate-300">
                  Experimental: motion-interpolated {job.plan?.filters.fpsTarget ?? 60} fps
                </span>
                <br />
                Generates in-between frames instead of duplicating. Off by default —{' '}
                <span className="text-warn">interpolation smears fast flicks</span>.
              </span>
            </label>
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-white/5 px-6 py-4">
          <button className="btn-ghost text-xs" onClick={() => void reset()}>
            Reset to automatic
          </button>
          <div className="ml-auto flex gap-2">
            <button className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn-primary" onClick={() => void apply()}>
              {['done', 'error', 'cancelled'].includes(job.status) ? 'Apply & re-process' : 'Apply'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
