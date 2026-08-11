// Editor export settings guide — garbage in can't be fixed downstream.

interface EditorGuide {
  name: string
  icon: string
  settings: [string, string][]
  note: string
}

const GUIDES: EditorGuide[] = [
  {
    name: 'Premiere Pro',
    icon: '🟣',
    settings: [
      ['Format', 'H.264 (or QuickTime + ProRes 422 if disk space is no issue)'],
      ['Preset', 'Match Source – Adaptive High Bitrate, then customize'],
      ['Resolution', '1080×1920 (or your full editing resolution — downscaling here is fine)'],
      ['Frame rate', '60 fps, "Constant" (never Variable)'],
      ['Bitrate', 'VBR 2-pass · Target 50 Mbps · Max 60 Mbps'],
      ['Profile / Level', 'High · 4.2'],
      ['Render quality', '✓ Maximum render quality · ✓ Maximum bit depth'],
      ['Audio', 'AAC · 320 kbps · 48 kHz · Stereo']
    ],
    note: 'Export from the sequence at full quality — this app handles the TikTok-specific squeeze afterwards.'
  },
  {
    name: 'After Effects',
    icon: '🔵',
    settings: [
      ['Renderer', 'Render Queue (not the old Media Encoder default H.264)'],
      ['Format', 'QuickTime · ProRes 422 — or Media Encoder with the Premiere settings'],
      ['Resolution', 'Full — never half/third preview resolution'],
      ['Frame rate', '60 fps constant, motion blur rendered'],
      ['Color', 'Project set to 8 bpc minimum, sRGB/Rec.709 working space'],
      ['Audio', '48 kHz · 16-bit · Stereo']
    ],
    note: 'ProRes masters are big but perfect input for Smart Compress — zero generation loss before this app.'
  },
  {
    name: 'DaVinci Resolve',
    icon: '🟠',
    settings: [
      ['Format', 'MP4 · H.264 (or QuickTime ProRes 422 HQ for masters)'],
      ['Resolution', '1080×1920 vertical timeline, or full UHD'],
      ['Frame rate', '60 — timeline and export must match'],
      ['Quality', 'Restrict to 50,000 kb/s or "Automatic – Best"'],
      ['Encoder', 'Native (software) over NVENC for final exports'],
      ['Advanced', '✓ Force sizing to highest quality · ✓ Force debayer to highest quality'],
      ['Audio', 'AAC · 320 kbps · 48 kHz']
    ],
    note: 'Deliver page → use a custom preset so these stick for every export.'
  }
]

export default function GuidePage(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <h1 className="text-lg font-bold text-white">Editor export settings</h1>
      <p className="mt-1 text-sm text-slate-500">
        This app can only preserve quality that exists in the file it receives. Export from your editor
        at maximum quality — 50+ Mbps, 60 fps constant — and let valclips quality do the TikTok-specific work.
      </p>

      <div className="mt-6 flex flex-col gap-4">
        {GUIDES.map((g) => (
          <div key={g.name} className="glass animate-fade-up px-5 py-4">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-100">
              <span>{g.icon}</span> {g.name}
            </div>
            <div className="mt-3 overflow-hidden rounded-lg border border-white/5">
              {g.settings.map(([k, v], i) => (
                <div
                  key={k}
                  className={`flex gap-4 px-3 py-2 text-xs ${i % 2 === 0 ? 'bg-white/[0.02]' : ''}`}
                >
                  <span className="w-36 shrink-0 font-semibold text-slate-400">{k}</span>
                  <span className="text-slate-300">{v}</span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-teal-soft/80">💡 {g.note}</p>
          </div>
        ))}

        <div className="glass px-5 py-4">
          <div className="text-sm font-bold text-slate-100">⚠ The one rule</div>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">
            Never export low-bitrate "for TikTok" from your editor — that's a generation loss this app
            cannot undo. Big, clean master out of the editor → drop it here → upload the result.
          </p>
        </div>
      </div>
    </div>
  )
}
