import type { Analysis, Plan } from '@shared/types'
import { fmtBytes, fmtDuration } from '../lib/api'

// Instant analysis card: everything the scan learned about a clip, as badges,
// plus the decision engine's plan in plain English.

export function AnalysisBadges({ analysis }: { analysis: Analysis }): React.JSX.Element {
  const v = analysis.probe.video
  const badges: { text: string; cls: string; title?: string }[] = []

  badges.push({
    text: `${v.width}×${v.height}`,
    cls:
      v.width === 1080 && v.height === 1920
        ? 'bg-ok/15 text-ok'
        : 'bg-white/10 text-slate-300',
    title: 'Resolution'
  })
  badges.push({
    text: `${v.fpsAverage.toFixed(v.fpsAverage % 1 ? 2 : 0)} fps`,
    cls: 'bg-white/10 text-slate-300'
  })
  if (v.fpsMode === 'vfr')
    badges.push({
      text: '⚠ VFR',
      cls: 'bg-warn/20 text-warn',
      title: `Variable frame rate — ${v.frameIntervalJitterMs}ms timestamp jitter. Will be converted to constant FPS.`
    })
  if (v.isHdr) badges.push({ text: 'HDR', cls: 'bg-warn/20 text-warn', title: 'Will be tone-mapped to BT.709' })
  if (v.rotation !== 0) badges.push({ text: `↻ ${v.rotation}°`, cls: 'bg-warn/20 text-warn' })
  if (analysis.noise.noiseClass === 'heavy')
    badges.push({ text: 'Heavy grain', cls: 'bg-accent/20 text-accent-soft', title: `Noise level ${analysis.noise.noiseLevel}` })
  else if (analysis.noise.noiseClass === 'light')
    badges.push({ text: 'Light grain', cls: 'bg-warn/15 text-warn', title: `Noise level ${analysis.noise.noiseLevel}` })
  else badges.push({ text: 'Clean', cls: 'bg-ok/15 text-ok', title: `Noise level ${analysis.noise.noiseLevel}` })
  badges.push({
    text: analysis.noise.motionClass === 'high' ? 'High motion' : 'Low motion',
    cls: 'bg-teal/15 text-teal-soft',
    title: `Motion level ${analysis.noise.motionLevel}`
  })
  if (analysis.probe.durationSec > 60)
    badges.push({
      text: `⚠ ${Math.round(analysis.probe.durationSec)}s`,
      cls: 'bg-warn/20 text-warn',
      title: 'Longer than 60s — TikTok compresses long videos harder'
    })

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {badges.map((b, i) => (
        <span key={i} className={`badge ${b.cls}`} title={b.title}>
          {b.text}
        </span>
      ))}
    </div>
  )
}

export function AnalysisDetail({
  analysis,
  plan
}: {
  analysis: Analysis
  plan: Plan | null
}): React.JSX.Element {
  const p = analysis.probe
  const rows: [string, string][] = [
    ['Codec', `${p.video.codec} ${p.video.profile} · ${p.video.pixFmt} · ${p.video.bitDepth}-bit`],
    ['Color', `${p.video.colorSpace || 'untagged'} / ${p.video.colorTransfer || '—'} / ${p.video.colorPrimaries || '—'}`],
    ['Duration', fmtDuration(p.durationSec)],
    ['Size', `${fmtBytes(p.sizeBytes)} · ${(p.overallBitrate / 1_000_000).toFixed(1)} Mbps`],
    [
      'Audio',
      p.audio.present
        ? `${p.audio.codec} · ${p.audio.channels}ch · ${(p.audio.sampleRate / 1000).toFixed(1)} kHz`
        : 'none'
    ],
    ['Noise / motion', `${analysis.noise.noiseLevel} (${analysis.noise.noiseClass}) / ${analysis.noise.motionLevel} (${analysis.noise.motionClass})`]
  ]

  return (
    <div className="mt-3 border-t border-white/5 pt-3">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        {rows.map(([k, val]) => (
          <div key={k} className="flex justify-between gap-3 text-xs">
            <span className="text-slate-500">{k}</span>
            <span className="text-right font-mono text-[11px] text-slate-300">{val}</span>
          </div>
        ))}
      </div>
      {analysis.warnings.length > 0 && (
        <div className="mt-3 flex flex-col gap-1">
          {analysis.warnings.map((w, i) => (
            <div key={i} className="text-xs text-warn">
              ⚠ {w}
            </div>
          ))}
        </div>
      )}
      {plan && (
        <div className="mt-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            {plan.mode === 'remux' ? 'Plan: lossless remux' : 'Plan: full quality pipeline'}
          </div>
          <ul className="mt-1 flex flex-col gap-0.5">
            {plan.reasons.map((r, i) => (
              <li key={i} className="text-xs text-slate-400">
                • {r}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
