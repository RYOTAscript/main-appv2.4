import { useFFmpegState, vq, fmtBytes } from '../lib/api'

// Toolchain status card: shows detection results, download progress with a
// real progress bar, and clear recovery actions when a binary is broken.

export default function FFmpegCard(): React.JSX.Element | null {
  const state = useFFmpegState()

  if (state.status === 'ready') return null // all good — stay out of the way

  return (
    <div className="glass animate-fade-up border-warn/20 px-5 py-4">
      {state.status === 'checking' && (
        <div className="flex items-center gap-3 text-sm text-slate-300">
          <span className="h-2 w-2 animate-pulse rounded-full bg-warn" />
          Checking for FFmpeg…
        </div>
      )}

      {state.status === 'missing' && (
        <div className="flex flex-wrap items-center gap-4">
          <div>
            <div className="text-sm font-semibold text-slate-100">FFmpeg engine not installed yet</div>
            <div className="mt-0.5 text-xs text-slate-400">
              One-time download (~170 MB) of the full FFmpeg build with quality measurement (VMAF) support.
            </div>
          </div>
          <button className="btn-primary ml-auto" onClick={() => void vq.ffmpeg.setup()}>
            Download &amp; install
          </button>
        </div>
      )}

      {state.status === 'broken' && (
        <div className="flex flex-wrap items-center gap-4">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-warn">FFmpeg found but not working</div>
            <div className="mt-0.5 break-words text-xs text-slate-400">{state.detail}</div>
            <div className="mt-1 text-xs text-slate-500">
              Install the known-good bundled build to replace it — your system copy is left untouched.
            </div>
          </div>
          <button className="btn-primary ml-auto" onClick={() => void vq.ffmpeg.setup()}>
            Install working build
          </button>
        </div>
      )}

      {state.status === 'installing' && (
        <div>
          <div className="flex items-center justify-between text-sm">
            <span className="font-semibold text-slate-100">
              {state.phase === 'download'
                ? 'Downloading FFmpeg…'
                : state.phase === 'extract'
                  ? 'Extracting…'
                  : 'Validating binaries…'}
            </span>
            {state.phase === 'download' && state.totalBytes > 0 && (
              <span className="font-mono text-xs text-slate-400">
                {fmtBytes(state.receivedBytes)} / {fmtBytes(state.totalBytes)}
              </span>
            )}
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div
              className={`h-full rounded-full bg-gradient-to-r from-accent to-teal transition-all duration-200 ${
                state.phase !== 'download' || state.totalBytes === 0 ? 'w-full animate-pulse' : ''
              }`}
              style={
                state.phase === 'download' && state.totalBytes > 0
                  ? { width: `${(state.receivedBytes / state.totalBytes) * 100}%` }
                  : undefined
              }
            />
          </div>
        </div>
      )}

      {state.status === 'error' && (
        <div className="flex flex-wrap items-center gap-4">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-accent-soft">FFmpeg setup failed</div>
            <div className="mt-0.5 break-words text-xs text-slate-400">{state.detail}</div>
          </div>
          <button className="btn-ghost ml-auto" onClick={() => void vq.ffmpeg.setup()}>
            Retry
          </button>
        </div>
      )}
    </div>
  )
}
