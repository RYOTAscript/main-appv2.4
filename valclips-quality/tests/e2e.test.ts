import { beforeAll, describe, expect, it, vi } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'

// Full end-to-end: a fixture "dropped" into the pipeline runs analysis →
// decision → filters → real x264 encode → VMAF verification, and the output
// must be a perfect TikTok upload file. Only Electron and settings are mocked.

vi.mock('electron', () => ({
  app: {
    getPath: () => path.join(process.env.APPDATA ?? '', 'valclips quality'),
    getVersion: () => '0.0.0-test'
  },
  BrowserWindow: { getAllWindows: (): unknown[] => [] }
}))

const TEST_SETTINGS = {
  outputMode: 'master' as const,
  orientation: 'vertical' as const,
  masterCrf: 12,
  vmafTarget: 93,
  loudnorm: true,
  outputFolder: null,
  filenameTemplate: '{name}_output',
  confirmOverwrite: false,
  hardwarePreview: false,
  tiktokSpec: {
    width: 1080,
    height: 1920,
    fpsHigh: 60,
    fpsLow: 30,
    fpsHighCutoff: 50,
    minSaneBitrate: 3_000_000,
    maxSaneBitrate: 100_000_000
  }
}
vi.mock('../src/main/settings', () => ({
  getSettings: () => TEST_SETTINGS,
  setSettings: () => TEST_SETTINGS,
  settingsFilePath: () => 'test-settings.json',
  ensureSettingsFile: async () => {}
}))

import { ensureToolchain, paths } from '../src/main/ffmpeg'
import { runOrThrow } from '../src/main/run'
import { initPipeline } from '../src/main/pipeline'
import { initEncoder } from '../src/main/encode'
import { probeFile } from '../src/main/probe'
import * as jobsStore from '../src/main/jobs'

const MEDIA = path.join(__dirname, 'media')
const INPUT = path.join(MEDIA, 'e2e-source.mp4')
const OUTPUT = path.join(MEDIA, 'e2e-source_output.mp4')

/** Top-level MP4 box scan: faststart means moov comes before mdat. */
function isFaststart(file: string): boolean {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    let offset = 0
    let moovAt = -1
    let mdatAt = -1
    const header = Buffer.alloc(16)
    while (offset + 8 <= size) {
      fs.readSync(fd, header, 0, 16, offset)
      let boxSize = header.readUInt32BE(0)
      const type = header.toString('ascii', 4, 8)
      if (boxSize === 1) boxSize = Number(header.readBigUInt64BE(8))
      else if (boxSize === 0) boxSize = size - offset
      if (type === 'moov' && moovAt < 0) moovAt = offset
      if (type === 'mdat' && mdatAt < 0) mdatAt = offset
      if (boxSize <= 0) break
      offset += boxSize
    }
    return moovAt >= 0 && mdatAt >= 0 && moovAt < mdatAt
  } finally {
    fs.closeSync(fd)
  }
}

describe('end-to-end: drop fixture → full pipeline → TikTok-perfect output', () => {
  beforeAll(async () => {
    const state = await ensureToolchain()
    expect(state.status).toBe('ready')
    initPipeline()
    initEncoder()
    if (!fs.existsSync(INPUT)) {
      // 1280×720 @ 60 with audio: exercises scale+pad, CFR 60 and loudnorm
      await runOrThrow(paths().ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=60',
        '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100',
        '-t', '3', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-shortest', INPUT
      ], { timeoutMs: 180000 })
    }
    fs.rmSync(OUTPUT, { force: true })
  }, 300000)

  it('produces a verified CFR-60 BT.709 faststart upload file', async () => {
    // "drop" the file: goes through the real queue, pump and pipeline
    const added = jobsStore.addInputs([INPUT])
    expect(added.accepted).toEqual([INPUT])
    const job = jobsStore.listJobs().find((j) => j.inputPath === INPUT)!
    expect(job.outputPath).toBe(OUTPUT)

    // wait for the express pipeline to finish (analyze → encode → verify)
    const deadline = Date.now() + 25 * 60 * 1000
    while (!['done', 'error', 'cancelled'].includes(job.status)) {
      if (Date.now() > deadline) throw new Error(`pipeline timed out in state ${job.status}: ${job.note}`)
      await new Promise((r) => setTimeout(r, 2000))
    }

    // pipeline result
    expect(job.error).toBeNull()
    expect(job.status).toBe('done')
    expect(job.plan?.mode).toBe('encode')
    expect(job.result).not.toBeNull()
    expect(fs.existsSync(OUTPUT)).toBe(true)

    // output invariants — the exact TikTok spec
    const out = await probeFile(OUTPUT)
    expect(out.video.width).toBe(1080)
    expect(out.video.height).toBe(1920)
    expect(Math.round(out.video.fpsAverage)).toBe(60)
    expect(out.video.fpsMode).toBe('cfr')
    expect(out.video.codec).toBe('h264')
    expect(out.video.profile).toBe('High')
    expect(out.video.pixFmt).toBe('yuv420p')
    expect(out.video.colorSpace).toBe('bt709')
    expect(out.video.colorTransfer).toBe('bt709')
    expect(out.video.colorPrimaries).toBe('bt709')
    expect(out.video.isHdr).toBe(false)
    expect(out.audio.present).toBe(true)
    expect(out.audio.codec).toBe('aac')
    expect(out.audio.sampleRate).toBe(48000)

    // faststart: moov before mdat
    expect(isFaststart(OUTPUT)).toBe(true)

    // VMAF met the target (master mode verifies and retries automatically)
    expect(job.result!.vmaf).not.toBeNull()
    expect(job.result!.vmaf!).toBeGreaterThanOrEqual(TEST_SETTINGS.vmafTarget)
    expect(job.result!.ssim).not.toBeNull()

    // A/V sync preserved
    const src = await probeFile(INPUT)
    expect(Math.abs(out.durationSec - src.durationSec)).toBeLessThan(0.25)

    // hotspots ready for the comparison viewer
    expect(job.result!.hotspots.length).toBeGreaterThan(0)
  }, 1800000)
})
