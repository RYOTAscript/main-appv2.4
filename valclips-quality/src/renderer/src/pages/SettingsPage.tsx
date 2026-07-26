import { useFFmpegState, useSettings, vq } from '../lib/api'
import { useToast } from '../lib/toast'

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="glass animate-fade-up px-5 py-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{title}</h3>
      <div className="flex flex-col gap-4">{children}</div>
    </div>
  )
}

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-200">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export default function SettingsPage(): React.JSX.Element {
  const [settings, update] = useSettings()
  const ffmpeg = useFFmpegState()
  const { toast } = useToast()

  if (!settings) return <div className="p-8 text-sm text-slate-500">Loading…</div>

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-8 py-8">
      <h1 className="text-lg font-bold text-white">Settings</h1>

      <Section title="Output quality">
        <Row
          label="Output format"
          hint="Keep aspect = source shape untouched (default). 9:16/16:9 force the shape with a blurred background pad."
        >
          <div className="flex overflow-hidden rounded-lg border border-white/10">
            {(
              [
                ['maintain', 'Keep aspect'],
                ['vertical', '9:16 + blur'],
                ['horizontal', '16:9 + blur']
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                onClick={() => update({ orientation: value })}
                className={`px-4 py-1.5 text-xs font-semibold transition-colors ${
                  settings.orientation === value ? 'bg-accent text-white' : 'text-slate-400 hover:bg-white/5'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </Row>
        <Row
          label="Output mode"
          hint="Master = near-lossless big file (CRF 12). Smart Compress = smallest file that still looks identical (VMAF-verified)."
        >
          <div className="flex overflow-hidden rounded-lg border border-white/10">
            {(['master', 'smart'] as const).map((m) => (
              <button
                key={m}
                onClick={() => update({ outputMode: m })}
                className={`px-4 py-1.5 text-xs font-semibold transition-colors ${
                  settings.outputMode === m ? 'bg-accent text-white' : 'text-slate-400 hover:bg-white/5'
                }`}
              >
                {m === 'master' ? 'Master' : 'Smart Compress'}
              </button>
            ))}
          </div>
        </Row>
        <Row label={`Master CRF — ${settings.masterCrf}`} hint="Lower = higher quality, bigger file (10–16).">
          <input
            type="range"
            min={10}
            max={16}
            step={1}
            value={settings.masterCrf}
            onChange={(e) => update({ masterCrf: parseInt(e.target.value, 10) })}
            className="w-40"
          />
        </Row>
        <Row
          label={`Smart Compress target — VMAF ${settings.vmafTarget}`}
          hint="97+ is visually lossless for high-motion gameplay."
        >
          <input
            type="range"
            min={90}
            max={99}
            step={1}
            value={settings.vmafTarget}
            onChange={(e) => update({ vmafTarget: parseInt(e.target.value, 10) })}
            className="w-40"
          />
        </Row>
        <Row
          label="Loudness normalize audio"
          hint="Two-pass loudnorm to −14 LUFS / −1 dBTP so the drop doesn't clip on TikTok."
        >
          <input
            type="checkbox"
            checked={settings.loudnorm}
            onChange={(e) => update({ loudnorm: e.target.checked })}
            className="h-4 w-4 accent-[#ff4655]"
          />
        </Row>
      </Section>

      <Section title="Files">
        <Row label="Confirm before overwriting outputs" hint="Ask when a _output.mp4 already exists.">
          <input
            type="checkbox"
            checked={settings.confirmOverwrite}
            onChange={(e) => update({ confirmOverwrite: e.target.checked })}
            className="h-4 w-4 accent-[#ff4655]"
          />
        </Row>
        <Row
          label="Filename template"
          hint="{name} is the source name. Output is always .mp4."
        >
          <input
            type="text"
            value={settings.filenameTemplate}
            onChange={(e) => update({ filenameTemplate: e.target.value })}
            className="w-44 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 font-mono text-xs text-slate-200 outline-none focus:border-accent/50"
          />
        </Row>
        <Row
          label="Output folder"
          hint={settings.outputFolder ?? 'Next to each source file (default)'}
        >
          <div className="flex gap-2">
            <button
              className="btn-ghost !px-3 !py-1.5 text-xs"
              onClick={() => void vq.settings.pickOutputFolder().then((s) => update({ outputFolder: s.outputFolder }))}
            >
              Choose…
            </button>
            {settings.outputFolder && (
              <button
                className="btn-ghost !px-3 !py-1.5 text-xs"
                onClick={() => update({ outputFolder: null })}
              >
                Reset
              </button>
            )}
          </div>
        </Row>
      </Section>

      <Section title="Advanced">
        <Row
          label="Hardware-accelerated previews (NVENC)"
          hint="Fast preview rendering only — final exports always use software x264 for maximum quality."
        >
          <input
            type="checkbox"
            checked={settings.hardwarePreview}
            onChange={(e) => update({ hardwarePreview: e.target.checked })}
            className="h-4 w-4 accent-[#ff4655]"
          />
        </Row>
        <Row
          label="TikTok target spec"
          hint="Resolution, fps targets and bitrate sanity bounds — editable JSON for power users."
        >
          <button className="btn-ghost !px-3 !py-1.5 text-xs" onClick={() => void vq.shell.openSettingsFile()}>
            Open settings.json
          </button>
        </Row>
      </Section>

      <Section title="FFmpeg engine">
        {ffmpeg.status === 'ready' ? (
          <div className="text-xs text-slate-400">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-ok" />
              <span className="font-semibold text-slate-200">
                {ffmpeg.source === 'system' ? 'System install' : 'Bundled build'} · v{ffmpeg.version}
              </span>
            </div>
            <div className="mt-1 truncate font-mono text-[11px] text-slate-600">{ffmpeg.ffmpegPath}</div>
            <div className="mt-2 flex gap-2">
              <button className="btn-ghost !px-3 !py-1.5 text-xs" onClick={() => void vq.ffmpeg.setup()}>
                Reinstall bundled build
              </button>
              <button
                className="btn-ghost !px-3 !py-1.5 text-xs"
                onClick={() =>
                  void vq.ffmpeg.recheck().then(() => toast('info', 'FFmpeg re-checked'))
                }
              >
                Re-detect
              </button>
            </div>
          </div>
        ) : (
          <div className="text-xs text-slate-500">Engine status is shown on the Queue page.</div>
        )}
      </Section>

      <Section title="Diagnostics">
        <Row label="Application log" hint="Every FFmpeg command and error is recorded here.">
          <button className="btn-ghost !px-3 !py-1.5 text-xs" onClick={() => void vq.shell.openLog()}>
            Open log file
          </button>
        </Row>
      </Section>
    </div>
  )
}
