import * as fs from 'fs'
import type { Job, Plan } from '@shared/types'
import { buildVideoChain } from '@shared/filters'
import {
  buildEncodeArgs,
  nextCrf,
  finalCrf,
  SMART_CRF_START,
  type LoudnormMeasurement
} from '@shared/encodeArgs'
import { requireReady } from './ffmpeg'
import { run, runOrThrow, type RunHandle } from './run'
import { computeVmaf, type VmafResult } from './vmaf'
import { detectHotspots } from './hotspots'
import { updateJob } from './jobs'
import { registerEncoder } from './pipeline'
import { tempPathFor, commitTemp, discardTemp } from './atomic'
import { log } from './logger'

// Encoding engine: Master (near-lossless CRF) and Smart Compress (smallest
// file that is still visually lossless, VMAF-verified CRF search).
// One encode runs at a time; x264 veryslow saturates every core on its own.

const activeHandles = new Map<string, RunHandle>()
const cancelled = new Set<string>()

export function cancelJob(id: string): boolean {
  cancelled.add(id)
  const h = activeHandles.get(id)
  if (h) {
    h.kill()
    return true
  }
  return false
}

function throwIfCancelled(job: Job): void {
  if (cancelled.has(job.id)) throw new CancelledError()
}

class CancelledError extends Error {
  constructor() {
    super('cancelled')
  }
}

// ---------- loudnorm pass 1 ----------

async function measureLoudness(job: Job): Promise<LoudnormMeasurement | null> {
  const { ffmpeg } = requireReady()
  updateJob(job.id, { note: 'Measuring loudness (pass 1 of 2)…' })
  try {
    const res = await runOrThrow(ffmpeg, [
      '-hide_banner', '-nostats',
      '-i', job.inputPath,
      '-map', '0:a:0',
      '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json',
      '-f', 'null', 'NUL'
    ], { timeoutMs: 600000 })
    // the JSON block is the last {...} in stderr
    const m = res.stderr.match(/\{[^{}]*"input_i"[\s\S]*?\}/g)
    if (!m) throw new Error('loudnorm did not report measurements')
    const parsed = JSON.parse(m[m.length - 1]) as LoudnormMeasurement
    log.info('loudness measured', { job: job.id, i: parsed.input_i, tp: parsed.input_tp })
    return parsed
  } catch (err) {
    // loudness normalization is an enhancement — never fail the export over it
    log.warn('loudnorm measurement failed, encoding without normalization', String(err))
    return null
  }
}

// ---------- single encode attempt ----------

interface AttemptResult {
  tmpPath: string
  args: string[]
}

async function encodeAttempt(
  job: Job,
  plan: Plan,
  crf: number,
  loudnorm: LoudnormMeasurement | null,
  stageLabel: string
): Promise<AttemptResult> {
  const { ffmpeg } = requireReady()
  const probe = job.analysis!.probe
  const { graph } = buildVideoChain(plan.filters, probe)
  const tmp = tempPathFor(job.outputPath) + '.mp4'

  const args = buildEncodeArgs({
    inputPath: job.inputPath,
    filterGraph: graph,
    crf,
    preset: plan.encode.preset,
    hasAudio: probe.audio.present,
    loudnorm,
    outputPath: tmp
  })

  const durationMs = probe.durationSec * 1000
  const started = Date.now()
  const handle = run(ffmpeg, args, {
    timeoutMs: 4 * 3600000,
    onProgress: (p) => {
      const percent = durationMs > 0 ? Math.min(99.5, (p.outTimeMs / durationMs) * 100) : 0
      const elapsed = (Date.now() - started) / 1000
      const eta = percent > 1 ? (elapsed / percent) * (100 - percent) : 0
      updateJob(job.id, {
        progress: {
          stage: stageLabel,
          percent,
          fps: p.fps,
          bitrateKbps: p.bitrateKbps,
          speed: p.speed,
          etaSec: Math.round(eta)
        }
      })
    },
    onStderrLine: (line) => {
      const job2 = { logTail: [...job.logTail, line].slice(-400) }
      job.logTail = job2.logTail
    }
  })
  activeHandles.set(job.id, handle)
  const res = await handle.promise
  activeHandles.delete(job.id)

  if (res.killed || cancelled.has(job.id)) {
    await discardTemp(tmp)
    throw new CancelledError()
  }
  if (res.code !== 0) {
    await discardTemp(tmp)
    const tail = res.stderr.split(/\r?\n/).filter(Boolean).slice(-12).join('\n')
    throw new Error(`Encode failed (exit ${res.code}):\n${tail}`)
  }
  return { tmpPath: tmp, args }
}

async function vmafOf(job: Job, plan: Plan, candidate: string, stageLabel: string): Promise<VmafResult> {
  const probe = job.analysis!.probe
  const { graph } = buildVideoChain(plan.filters, probe)
  return computeVmaf(candidate, job.inputPath, {
    sourceFilterGraph: graph,
    fps: plan.filters.fpsTarget,
    durationSec: probe.durationSec,
    onProgress: (percent) =>
      updateJob(job.id, {
        progress: { stage: stageLabel, percent, fps: 0, bitrateKbps: 0, speed: 0, etaSec: 0 }
      })
  })
}

// ---------- main entry ----------

export async function encodeJob(job: Job, plan: Plan): Promise<void> {
  cancelled.delete(job.id)
  // every temp created for this job; anything not committed is deleted on exit,
  // so no failure path can ever leave a partial file behind
  const temps = new Set<string>()
  try {
    updateJob(job.id, { status: 'processing', note: describePlan(plan) })

    const loudnorm =
      plan.encode.loudnorm && job.analysis!.probe.audio.present ? await measureLoudness(job) : null
    throwIfCancelled(job)

    let finalTmp: string
    let finalArgs: string[]
    let usedCrf: number
    let quality: VmafResult | null = null

    if (plan.encode.outputMode === 'master') {
      // ----- Master: near-lossless encode; auto-retry lower CRF if VMAF misses -----
      usedCrf = plan.encode.crf
      let attempt = await encodeAttempt(job, plan, usedCrf, loudnorm, `Master encode · CRF ${usedCrf}`)
      temps.add(attempt.tmpPath)
      updateJob(job.id, { status: 'verifying', note: 'Measuring VMAF + SSIM vs source…' })
      quality = await vmafOf(job, plan, attempt.tmpPath, 'Measuring quality')
      let retries = 0
      while (quality.vmaf < plan.encode.vmafTarget && usedCrf > 10 && retries < 2) {
        retries += 1
        const lower = Math.max(10, usedCrf - 2)
        log.warn('master below target, retrying', { job: job.id, vmaf: quality.vmaf, from: usedCrf, to: lower })
        updateJob(job.id, {
          status: 'processing',
          note: `VMAF ${quality.vmaf.toFixed(1)} below target ${plan.encode.vmafTarget} — retrying at CRF ${lower}…`
        })
        await discardTemp(attempt.tmpPath)
        usedCrf = lower
        attempt = await encodeAttempt(job, plan, usedCrf, loudnorm, `Master re-encode · CRF ${usedCrf}`)
        temps.add(attempt.tmpPath)
        updateJob(job.id, { status: 'verifying', note: 'Re-measuring quality…' })
        quality = await vmafOf(job, plan, attempt.tmpPath, 'Measuring quality')
      }
      finalTmp = attempt.tmpPath
      finalArgs = attempt.args
    } else {
      // ----- Smart Compress: highest CRF that stays visually lossless -----
      const tried: { crf: number; vmaf: number; quality: VmafResult; tmp: string; args: string[] }[] = []
      let crf: number | null = SMART_CRF_START
      while (crf !== null) {
        throwIfCancelled(job)
        const label = `Smart Compress · trying CRF ${crf} (${tried.length + 1})`
        const attempt = await encodeAttempt(job, plan, crf, loudnorm, label)
        temps.add(attempt.tmpPath)
        throwIfCancelled(job)
        updateJob(job.id, {
          status: 'verifying',
          note: `Verifying CRF ${crf} against VMAF ${plan.encode.vmafTarget}…`
        })
        const q = await vmafOf(job, plan, attempt.tmpPath, `Measuring quality · CRF ${crf}`)
        updateJob(job.id, { status: 'processing' })
        log.info('smart compress attempt', { job: job.id, crf, vmaf: q.vmaf })
        tried.push({ crf, vmaf: q.vmaf, quality: q, tmp: attempt.tmpPath, args: attempt.args })
        crf = nextCrf(tried, plan.encode.vmafTarget)
      }
      const chosen = finalCrf(tried, plan.encode.vmafTarget)
      const winner = tried.find((t) => t.crf === chosen)!
      // clean up losing candidates
      for (const t of tried) if (t.crf !== chosen) await discardTemp(t.tmp)
      finalTmp = winner.tmp
      finalArgs = winner.args
      usedCrf = chosen
      quality = winner.quality
    }

    throwIfCancelled(job)
    updateJob(job.id, { status: 'verifying', note: 'Finding motion hotspots…' })
    const hotspots = await detectHotspots(job.inputPath, job.analysis!.probe.durationSec)

    throwIfCancelled(job)
    await commitTemp(finalTmp, job.outputPath)
    temps.delete(finalTmp)
    const outSize = fs.statSync(job.outputPath).size
    const srcSize = job.analysis!.probe.sizeBytes
    const compression = srcSize > 0 ? Math.round((1 - outSize / srcSize) * 100) : null

    updateJob(job.id, {
      status: 'done',
      note: doneNote(plan, usedCrf, quality?.vmaf ?? null, compression),
      progress: null,
      result: {
        outputPath: job.outputPath,
        sizeBytes: outSize,
        wasRemux: false,
        vmaf: quality?.vmaf ?? null,
        ssim: quality?.ssim ?? null,
        finalCrf: usedCrf,
        compressionPercent: compression,
        ffmpegCommand: ['ffmpeg', ...finalArgs.slice(0, -1), job.outputPath].join(' '),
        hotspots
      }
    })
  } catch (err) {
    if (err instanceof CancelledError) {
      updateJob(job.id, { status: 'cancelled', note: 'Cancelled — no partial file left behind', progress: null })
      return
    }
    throw err
  } finally {
    for (const t of temps) await discardTemp(t)
    cancelled.delete(job.id)
    activeHandles.delete(job.id)
  }
}

function describePlan(plan: Plan): string {
  return plan.encode.outputMode === 'master'
    ? `Master encode (near-lossless, CRF ${plan.encode.crf})`
    : `Smart Compress (searching for smallest visually-lossless file, VMAF ≥ ${plan.encode.vmafTarget})`
}

function doneNote(
  plan: Plan,
  crf: number,
  vmaf: number | null,
  compression: number | null
): string {
  if (plan.encode.outputMode === 'master') return `Master export finished (CRF ${crf}).`
  const pieces = [`Smart Compress finished at CRF ${crf}`]
  if (vmaf !== null) pieces.push(`VMAF ${vmaf.toFixed(1)}`)
  if (compression !== null && compression > 0) pieces.push(`${compression}% smaller with no visible loss`)
  return pieces.join(' · ')
}

export function initEncoder(): void {
  registerEncoder(encodeJob)
}
