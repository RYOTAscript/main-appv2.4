import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { randomBytes } from 'crypto'
import { requireReady } from './ffmpeg'
import { run, type RunHandle } from './run'
import { log } from './logger'

// VMAF + SSIM measurement.
//
// The reference is the *filtered* source (same geometry/denoise/sharpen chain
// that fed the encoder), so the score isolates pure compression loss — exactly
// the "will TikTok viewers see a difference" question. Comparing against the
// raw source would count intentional processing (denoise, sharpen, pad) as
// error and make even a CRF-1 encode look bad.

export interface VmafResult {
  vmaf: number
  vmafMin: number
  ssim: number
}

export interface VmafOptions {
  /** filtergraph that turns the raw source [1:v] into the encoder's input */
  sourceFilterGraph: string | null
  fps: number | null
  onProgress?: (percent: number) => void
  durationSec?: number
  signal?: { handle: RunHandle | null }
}

export async function computeVmaf(
  distortedPath: string,
  sourcePath: string,
  opts: VmafOptions
): Promise<VmafResult> {
  const { ffmpeg } = requireReady()
  // libvmaf's log_path goes through two option parsers; Windows drive colons
  // and spaces break it. Run ffmpeg from the temp dir and use a bare filename.
  const logName = `vmaf-${randomBytes(4).toString('hex')}.json`
  const logDir = os.tmpdir()
  const logPath = path.join(logDir, logName)

  // Rebuild the encoder-input view of the source on the [1:v] branch.
  // The graph arrives labeled [0:v]…[vout]; retarget it to the second input.
  const refChain = opts.sourceFilterGraph
    ? opts.sourceFilterGraph.replace('[0:v]', '[1:v]').replace('[vout]', '') // keep filters, drop label
    : `[1:v]${opts.fps ? `fps=${opts.fps},` : ''}format=yuv420p,setsar=1`
  const refLabel = 'refv'
  const graph =
    `${refChain}[${refLabel}];` +
    `[0:v]setpts=PTS-STARTPTS[dist];` +
    `[${refLabel}]setpts=PTS-STARTPTS[refs];` +
    `[dist][refs]libvmaf=log_fmt=json:log_path=${logName}:` +
    `feature=name=float_ssim:n_threads=${Math.max(2, Math.min(8, cpuCount()))}[vmaf]`

  const args = [
    '-hide_banner', '-y',
    '-i', distortedPath,
    '-i', sourcePath,
    '-filter_complex', graph,
    '-map', '[vmaf]',
    '-progress', 'pipe:1',
    '-f', 'null', 'NUL'
  ]

  const handle = run(ffmpeg, args, {
    cwd: logDir,
    timeoutMs: 3600000,
    onProgress: (p) => {
      if (opts.onProgress && opts.durationSec && opts.durationSec > 0) {
        opts.onProgress(Math.min(99, (p.outTimeMs / 1000 / opts.durationSec) * 100))
      }
    }
  })
  if (opts.signal) opts.signal.handle = handle
  const res = await handle.promise
  if (opts.signal) opts.signal.handle = null
  if (res.killed) throw new Error('cancelled')
  if (res.code !== 0) {
    const tail = res.stderr.split(/\r?\n/).filter(Boolean).slice(-10).join('\n')
    throw new Error(`Quality measurement failed:\n${tail}`)
  }

  try {
    const parsed = JSON.parse(await fs.promises.readFile(logPath, 'utf8')) as {
      pooled_metrics?: {
        vmaf?: { mean?: number; min?: number }
        float_ssim?: { mean?: number }
      }
    }
    const pooled = parsed.pooled_metrics
    const result: VmafResult = {
      vmaf: round2(pooled?.vmaf?.mean ?? 0),
      vmafMin: round2(pooled?.vmaf?.min ?? 0),
      ssim: round4(pooled?.float_ssim?.mean ?? 0)
    }
    log.info('vmaf computed', { distorted: distortedPath, ...result })
    return result
  } finally {
    await fs.promises.unlink(logPath).catch(() => {})
  }
}

function cpuCount(): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('os').cpus().length
  } catch {
    return 4
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}
