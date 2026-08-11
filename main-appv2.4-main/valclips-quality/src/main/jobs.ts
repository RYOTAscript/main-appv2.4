import { BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'
import type { AddFilesResult, Job } from '@shared/types'
import { isSupportedVideo, supportedListHuman, extensionOf } from '@shared/formats'
import { outputPathFor } from '@shared/naming'
import { getSettings } from './settings'
import { log } from './logger'

// In-memory job queue. The pipeline stages (analyze → plan → process → verify)
// attach to jobs as later build stages come online; the queue/broadcast
// machinery here is stable from Stage 1 onward.

const jobs: Job[] = []

export function listJobs(): Job[] {
  return jobs
}

export function getJob(id: string): Job | undefined {
  return jobs.find((j) => j.id === id)
}

export function broadcastJobs(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('jobs:changed', jobs)
  }
}

export function updateJob(id: string, patch: Partial<Job>): Job | undefined {
  const job = getJob(id)
  if (!job) return undefined
  Object.assign(job, patch)
  broadcastJobs()
  return job
}

export interface AddOptions {
  /** allow overwriting an existing _output.mp4 without asking (user already confirmed) */
  overwriteConfirmed?: boolean
}

export function addInputs(paths: string[], opts: AddOptions = {}): AddFilesResult {
  const settings = getSettings()
  const result: AddFilesResult = { accepted: [], rejected: [], needsConfirm: [], needsSelection: [] }

  // Expand folders. A single video inside goes straight in; several candidates
  // are ambiguous — ask the user which ones instead of guessing.
  const expanded: string[] = []
  for (const p of paths) {
    try {
      const stat = fs.statSync(p)
      if (stat.isDirectory()) {
        const entries = fs
          .readdirSync(p)
          .filter((f) => isSupportedVideo(f))
          .map((f) => path.join(p, f))
        if (entries.length === 0) {
          result.rejected.push({ path: p, reason: 'Folder contains no supported videos' })
        } else if (entries.length === 1) {
          expanded.push(entries[0])
        } else {
          result.needsSelection.push({ folder: p, files: entries })
        }
      } else {
        expanded.push(p)
      }
    } catch {
      result.rejected.push({ path: p, reason: 'File not found or unreadable' })
    }
  }

  for (const p of expanded) {
    if (!isSupportedVideo(p)) {
      result.rejected.push({
        path: p,
        reason: `Unsupported format "${extensionOf(p) || 'no extension'}" — supported: ${supportedListHuman()}`
      })
      continue
    }
    if (jobs.some((j) => j.inputPath === p && !['done', 'error', 'cancelled'].includes(j.status))) {
      result.rejected.push({ path: p, reason: 'Already in the queue' })
      continue
    }
    const outputPath = outputPathFor(p, {
      template: settings.filenameTemplate,
      outputFolder: settings.outputFolder
    })
    if (settings.confirmOverwrite && !opts.overwriteConfirmed && fs.existsSync(outputPath)) {
      result.needsConfirm.push({ path: p, outputPath })
      continue
    }
    const job: Job = {
      id: randomBytes(6).toString('hex'),
      inputPath: p,
      fileName: path.basename(p),
      outputPath,
      status: 'queued',
      note: 'Queued',
      addedAt: Date.now(),
      analysis: null,
      plan: null,
      overrides: null,
      progress: null,
      result: null,
      error: null,
      logTail: []
    }
    jobs.push(job)
    result.accepted.push(p)
    log.info('job added', { id: job.id, input: p, output: outputPath })
  }

  broadcastJobs()
  if (result.accepted.length > 0) pump()
  return result
}

export function removeJob(id: string): void {
  const idx = jobs.findIndex((j) => j.id === id)
  if (idx >= 0) {
    jobs.splice(idx, 1)
    broadcastJobs()
  }
}

export function clearFinished(): void {
  for (let i = jobs.length - 1; i >= 0; i--) {
    if (['done', 'error', 'cancelled'].includes(jobs[i].status)) jobs.splice(i, 1)
  }
  broadcastJobs()
}

// ---------- pipeline driver ----------
// One job runs at a time (x264 veryslow saturates all cores anyway).
// `runners` is populated by later pipeline modules registering themselves,
// keeping this module dependency-free.

type JobRunner = (job: Job) => Promise<void>
let pipelineRunner: JobRunner | null = null
let running = false

export function registerPipeline(runner: JobRunner): void {
  pipelineRunner = runner
}

export async function pump(): Promise<void> {
  if (running || !pipelineRunner) return
  const next = jobs.find((j) => j.status === 'queued')
  if (!next) return
  running = true
  try {
    await pipelineRunner(next)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error('pipeline error', { job: next.id, error: msg })
    updateJob(next.id, { status: 'error', error: msg, note: 'Failed' })
  } finally {
    running = false
    // keep draining the queue
    setImmediate(() => void pump())
  }
}
