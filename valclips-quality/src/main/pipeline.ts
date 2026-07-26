import * as fs from 'fs'
import type { FilterPlan, Job, Plan } from '@shared/types'
import { decide, orientedSpec } from '@shared/decision'
import { applyOverrides } from '@shared/filters'
import { probeFile } from './probe'
import { analyzeContent } from './analyze'
import { requireReady, getState } from './ffmpeg'
import { runOrThrow } from './run'
import { updateJob, registerPipeline, pump } from './jobs'
import { getSettings } from './settings'
import { tempPathFor, commitTemp, discardTemp } from './atomic'
import { log } from './logger'

// Express pipeline: every queued job flows through here automatically.
//   analyze → decide → (remux | encode) → verify
// Encode & verify are attached by their stage modules; remux is complete here.

export async function runPipeline(job: Job): Promise<void> {
  if (getState().status !== 'ready') {
    updateJob(job.id, { note: 'Waiting for FFmpeg engine…' })
    // stay queued; pump() is retriggered when the toolchain becomes ready
    return
  }

  // --- analysis ---
  updateJob(job.id, { status: 'analyzing', note: 'Reading source metadata…' })
  const probe = await probeFile(job.inputPath)
  updateJob(job.id, { note: 'Measuring noise & motion…' })
  const analysis = await analyzeContent(probe)

  const settings = getSettings()
  let plan = decide(
    analysis,
    {
      outputMode: settings.outputMode,
      masterCrf: settings.masterCrf,
      vmafTarget: settings.vmafTarget,
      loudnorm: settings.loudnorm,
      orientation: settings.orientation
    },
    orientedSpec(settings.tiktokSpec, settings.orientation)
  )
  // manual tuning always wins — and forces a real encode even if the source
  // would otherwise qualify for a lossless remux
  if (job.overrides && Object.keys(job.overrides).length > 0) {
    plan = applyOverrides(plan, job.overrides as Partial<FilterPlan>)
    if (plan.mode === 'remux') {
      plan = {
        ...plan,
        mode: 'encode',
        reasons: ['Manual tuning applied — running the full encode pipeline.', ...plan.reasons]
      }
    }
  }
  updateJob(job.id, { analysis, plan })
  log.info('plan decided', { job: job.id, mode: plan.mode, reasons: plan.reasons })

  if (plan.mode === 'remux') {
    await runRemux(job, plan)
    return
  }

  if (!encodeRunner) {
    updateJob(job.id, {
      status: 'ready',
      note: 'Analysis done — encode engine arrives in the next build stage.'
    })
    return
  }
  await encodeRunner(job, plan)
}

// --- lossless remux branch ---
// Bit-for-bit identical video/audio, cleanly containerized with +faststart.
async function runRemux(job: Job, _plan: Plan): Promise<void> {
  const { ffmpeg } = requireReady()
  updateJob(job.id, {
    status: 'processing',
    note: 'Source already optimal — losslessly remuxing…',
    progress: { stage: 'Lossless remux', percent: 50, fps: 0, bitrateKbps: 0, speed: 0, etaSec: 0 }
  })
  const tmp = tempPathFor(job.outputPath) + '.mp4'
  const args = [
    '-hide_banner', '-y',
    '-i', job.inputPath,
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    tmp
  ]
  try {
    await runOrThrow(ffmpeg, args, { timeoutMs: 300000 })
    await commitTemp(tmp, job.outputPath)
    const size = fs.statSync(job.outputPath).size
    updateJob(job.id, {
      status: 'done',
      note: 'Source already optimal — losslessly remuxed, no quality lost.',
      progress: null,
      result: {
        outputPath: job.outputPath,
        sizeBytes: size,
        wasRemux: true,
        vmaf: null,
        ssim: null,
        finalCrf: null,
        compressionPercent: null,
        ffmpegCommand: ['ffmpeg', ...args.slice(0, -1), job.outputPath].join(' '),
        hotspots: []
      }
    })
  } catch (err) {
    await discardTemp(tmp) // never leave a partial file behind
    throw err
  }
}

// --- encode hook (registered by Stage 4 module) ---
type EncodeRunner = (job: Job, plan: Plan) => Promise<void>
let encodeRunner: EncodeRunner | null = null
export function registerEncoder(runner: EncodeRunner): void {
  encodeRunner = runner
}

export function initPipeline(): void {
  registerPipeline(runPipeline)
}

export { pump }
