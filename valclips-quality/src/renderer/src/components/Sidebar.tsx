import { useFFmpegState, useJobs } from '../lib/api'

export type View = 'queue' | 'guide' | 'settings' | 'about'

const NAV: { id: View; label: string; icon: string; key: string }[] = [
  { id: 'queue', label: 'Queue', icon: '▶', key: '1' },
  { id: 'guide', label: 'Export guide', icon: '🎓', key: '2' },
  { id: 'settings', label: 'Settings', icon: '⚙', key: '3' },
  { id: 'about', label: 'About', icon: '✦', key: '4' }
]

export default function Sidebar({
  view,
  onNavigate
}: {
  view: View
  onNavigate: (v: View) => void
}): React.JSX.Element {
  const ffmpeg = useFFmpegState()
  const jobs = useJobs()
  const active = jobs.filter((j) => !['done', 'error', 'cancelled'].includes(j.status)).length

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-white/5 bg-ink-900/60 backdrop-blur-xl">
      <div className="px-5 pb-4 pt-6">
        <div className="text-lg font-bold tracking-tight text-white">
          valclips<span className="text-accent"> quality</span>
        </div>
        <div className="mt-0.5 text-[11px] text-slate-500">TikTok-proof Valorant edits</div>
      </div>

      <nav className="flex flex-col gap-1 px-3">
        {NAV.map((item) => (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
              view === item.id
                ? 'bg-white/8 bg-white/10 text-white'
                : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
            }`}
          >
            <span className="w-4 text-center text-xs opacity-80">{item.icon}</span>
            {item.label}
            {item.id === 'queue' && active > 0 && (
              <span className="ml-auto rounded-full bg-accent/20 px-2 py-0.5 text-[10px] font-bold text-accent-soft">
                {active}
              </span>
            )}
            <span className={`kbd ${item.id === 'queue' && active > 0 ? '' : 'ml-auto'}`}>{item.key}</span>
          </button>
        ))}
      </nav>

      <div className="mt-auto px-4 pb-5">
        <div className="glass px-3 py-2.5">
          <div className="flex items-center gap-2 text-xs">
            <span
              className={`h-2 w-2 rounded-full ${
                ffmpeg.status === 'ready'
                  ? 'bg-ok'
                  : ffmpeg.status === 'installing' || ffmpeg.status === 'checking'
                    ? 'animate-pulse bg-warn'
                    : 'bg-accent'
              }`}
            />
            <span className="font-semibold text-slate-300">FFmpeg</span>
            <span className="ml-auto text-slate-500">
              {ffmpeg.status === 'ready'
                ? ffmpeg.source === 'system'
                  ? 'system'
                  : 'bundled'
                : ffmpeg.status === 'installing'
                  ? 'installing…'
                  : ffmpeg.status === 'checking'
                    ? 'checking…'
                    : 'not ready'}
            </span>
          </div>
        </div>
      </div>
    </aside>
  )
}
