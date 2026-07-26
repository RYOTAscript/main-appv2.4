import { useEffect, useState } from 'react'
import { vq } from '../lib/api'

export default function AboutPage(): React.JSX.Element {
  const [version, setVersion] = useState('')
  useEffect(() => {
    void vq.appVersion().then(setVersion)
  }, [])

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <div className="glass animate-fade-up px-6 py-6">
        <div className="text-xl font-bold text-white">
          valclips<span className="text-accent"> quality</span>{' '}
          <span className="text-sm font-normal text-slate-500">v{version}</span>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-slate-400">
          A maximum-effort TikTok quality tool for ~20-second Valorant edits. Everything here is tuned
          for one goal: your edit survives TikTok's re-encode looking as close to your editor preview
          as possible — fast flicks, ability VFX, flashes and shake transitions included.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-2 text-xs text-slate-500 sm:grid-cols-2">
          <div className="glass px-3 py-2">🔍 Deep source analysis (VFR, HDR, grain)</div>
          <div className="glass px-3 py-2">🧹 Smart particle &amp; noise cleanup</div>
          <div className="glass px-3 py-2">🎯 High-motion x264 tuning</div>
          <div className="glass px-3 py-2">📏 VMAF-verified visually-lossless compress</div>
        </div>
        <div className="mt-4 text-[11px] text-slate-600">
          Keyboard: <span className="kbd">Ctrl+O</span> add clips · <span className="kbd">1</span>/
          <span className="kbd">2</span>/<span className="kbd">3</span> navigate ·{' '}
          <span className="kbd">Esc</span> back to queue
        </div>
      </div>
    </div>
  )
}
