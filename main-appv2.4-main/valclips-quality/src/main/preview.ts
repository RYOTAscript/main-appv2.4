import { app, protocol, net } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'url'
import type { FilterPlan, Job } from '@shared/types'
import { applyOverrides, buildVideoChain } from '@shared/filters'
import { requireReady } from './ffmpeg'
import { run, type RunHandle } from './run'
import { getSettings } from './settings'
import { log } from './logger'

// preview/display encoder: NVENC when the user enabled fast previews (and the
// GPU supports it — we fall back to x264 automatically on first failure)
let nvencBroken = false
function displayEncoderArgs(): string[] {
  if (getSettings().hardwarePreview && !nvencBroken) {
    return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '19', '-pix_fmt', 'yuv420p']
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p']
}

// Live 2-second before/after previews for the tune panel.
// Rendered at full quality through the real filter chain (denoise at source
// resolution — an honest preview), then displayed at 960px. Served to the
// renderer via the vqmedia:// protocol, which only exposes the previews folder.

function previewsDir(): string {
  return path.join(app.getPath('userData'), 'previews')
}

export function registerPreviewScheme(): void {
  // must run before app.whenReady()
  protocol.registerSchemesAsPrivileged([
    { scheme: 'vqmedia', privileges: { standard: true, stream: true, supportFetchAPI: true } }
  ])
}

export function initPreviewProtocol(): void {
  fs.rmSync(previewsDir(), { recursive: true, force: true })
  fs.mkdirSync(previewsDir(), { recursive: true })
  protocol.handle('vqmedia', (request) => {
    const name = path.basename(new URL(request.url).pathname) // strip any traversal
    const file = path.join(previewsDir(), name)
    if (!fs.existsSync(file)) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })
}

let seq = 0
const inflight = new Map<string, RunHandle[]>()

// ---------- comparison pairs (Stage 5 viewer) ----------
// "expected" = source pushed through the exact filter chain the encoder saw;
// "actual"   = the exported file. Both display-transcoded identically (CRF 12
// veryfast) so the only visible difference is what the real encode changed.

export interface ComparePair {
  expectedUrl: string
  actualUrl: string
  fps: number
}

export async function generateComparison(job: Job, timeSec: number): Promise<ComparePair> {
  if (!job.analysis || !job.plan || !job.result) throw new Error('No finished export to compare yet.')
  const { ffmpeg } = requireReady()
  const plan = applyOverrides(job.plan, (job.overrides as Partial<FilterPlan>) ?? null)
  const fps = plan.filters.fpsTarget ?? (Math.round(job.analysis.probe.video.fpsAverage) || 30)

  const id = `${job.id}-cmp-${++seq}`
  const start = Math.max(0, timeSec).toFixed(3)
  const expectedFile = path.join(previewsDir(), `${id}-expected.mp4`)
  const actualFile = path.join(previewsDir(), `${id}-actual.mp4`)
  const display = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-an']

  const jobs: Promise<unknown>[] = []
  if (job.result.wasRemux) {
    // remux output is bit-identical to the source — compare source vs output directly
    jobs.push(
      runOrThrowLocal(ffmpeg, ['-hide_banner', '-y', '-ss', start, '-t', '2', '-i', job.inputPath, ...display, expectedFile])
    )
  } else {
    const { graph } = buildVideoChain(plan.filters, job.analysis.probe)
    jobs.push(
      runOrThrowLocal(ffmpeg, [
        '-hide_banner', '-y', '-ss', start, '-t', '2', '-i', job.inputPath,
        '-filter_complex', graph, '-map', '[vout]', ...display, expectedFile
      ])
    )
  }
  jobs.push(
    runOrThrowLocal(ffmpeg, ['-hide_banner', '-y', '-ss', start, '-t', '2', '-i', job.result.outputPath, ...display, actualFile])
  )
  await Promise.all(jobs)

  return {
    expectedUrl: `vqmedia://previews/${path.basename(expectedFile)}`,
    actualUrl: `vqmedia://previews/${path.basename(actualFile)}`,
    fps
  }
}

async function runOrThrowLocal(bin: string, args: string[]): Promise<void> {
  const h = run(bin, args, { timeoutMs: 600000 })
  const res = await h.promise
  if (res.code !== 0) {
    const tail = res.stderr.split(/\r?\n/).filter(Boolean).slice(-8).join('\n')
    throw new Error(`Comparison render failed:\n${tail}`)
  }
}

export interface PreviewResult {
  beforeUrl: string
  afterUrl: string
}

export async function generatePreview(
  job: Job,
  overrides: Partial<FilterPlan> | null
): Promise<PreviewResult> {
  if (!job.analysis || !job.plan) throw new Error('Clip has not been analyzed yet.')
  const { ffmpeg } = requireReady()

  // cancel any preview still rendering for this job
  for (const h of inflight.get(job.id) ?? []) h.kill()
  inflight.set(job.id, [])

  const plan = applyOverrides(job.plan, overrides)
  const dur = job.analysis.probe.durationSec
  const start = Math.max(0, dur * 0.4 - 1).toFixed(2)
  const id = `${job.id}-${++seq}`
  const beforeFile = path.join(previewsDir(), `${id}-before.mp4`)
  const afterFile = path.join(previewsDir(), `${id}-after.mp4`)

  const common = ['-hide_banner', '-y', '-ss', start, '-t', '2', '-i', job.inputPath]
  const enc = displayEncoderArgs()
  const usingNvenc = enc.includes('h264_nvenc')
  const beforeArgs = [
    ...common,
    '-vf', 'scale=-2:960:flags=bilinear,setsar=1',
    '-an', ...enc,
    beforeFile
  ]
  const { graph } = buildVideoChain(plan.filters, job.analysis.probe, { previewHeight: 960 })
  const afterArgs = [
    ...common,
    '-filter_complex', graph,
    '-map', '[vout]',
    '-an', ...enc,
    afterFile
  ]

  const hBefore = run(ffmpeg, beforeArgs, { timeoutMs: 300000 })
  const hAfter = run(ffmpeg, afterArgs, { timeoutMs: 300000 })
  inflight.set(job.id, [hBefore, hAfter])

  const [rBefore, rAfter] = await Promise.all([hBefore.promise, hAfter.promise])
  inflight.delete(job.id)
  if (rBefore.killed || rAfter.killed) throw new Error('Preview superseded')
  if (rBefore.code !== 0 || rAfter.code !== 0) {
    if (usingNvenc) {
      // GPU encoder unavailable — remember and retry once on software x264
      nvencBroken = true
      log.warn('nvenc preview failed, falling back to libx264')
      return generatePreview(job, overrides)
    }
    const tail = (rAfter.code !== 0 ? rAfter : rBefore).stderr.split(/\r?\n/).filter(Boolean).slice(-8).join('\n')
    log.error('preview render failed', tail)
    throw new Error(`Preview failed:\n${tail}`)
  }

  return {
    beforeUrl: `vqmedia://previews/${path.basename(beforeFile)}`,
    afterUrl: `vqmedia://previews/${path.basename(afterFile)}`
  }
}
