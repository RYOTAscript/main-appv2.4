import { beforeAll, describe, expect, it, vi } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'

// Integration: real ffprobe/ffmpeg on real fixture files, only Electron mocked.
vi.mock('electron', () => ({
  app: {
    getPath: () => path.join(process.env.APPDATA ?? '', 'valclips quality'),
    getVersion: () => '0.0.0-test'
  },
  BrowserWindow: { getAllWindows: (): unknown[] => [] }
}))

import { ensureToolchain, paths } from '../src/main/ffmpeg'
import { probeFile } from '../src/main/probe'
import { analyzeContent } from '../src/main/analyze'
import { decide, neutralFilters } from '../src/shared/decision'
import { buildVideoChain } from '../src/shared/filters'
import { buildEncodeArgs } from '../src/shared/encodeArgs'
import { computeVmaf } from '../src/main/vmaf'
import { detectHotspots } from '../src/main/hotspots'
import { runOrThrow } from '../src/main/run'

const MEDIA = path.join(__dirname, 'media')
const settings = { outputMode: 'smart' as const, masterCrf: 12, vmafTarget: 97, loudnorm: true }

const haveFixtures = fs.existsSync(path.join(MEDIA, 'clean.mp4'))

describe.skipIf(!haveFixtures)('pipeline integration (real ffmpeg)', () => {
  beforeAll(async () => {
    const state = await ensureToolchain()
    expect(state.status).toBe('ready')
  }, 120000)

  it('probes the clean 1080×1920@60 fixture correctly', async () => {
    const p = await probeFile(path.join(MEDIA, 'clean.mp4'))
    expect(p.video.codec).toBe('h264')
    expect(p.video.width).toBe(1080)
    expect(p.video.height).toBe(1920)
    expect(Math.round(p.video.fpsAverage)).toBe(60)
    expect(p.video.fpsMode).toBe('cfr')
    expect(p.video.isHdr).toBe(false)
  }, 60000)

  it('clean fixture → classified clean → plan is lossless remux', async () => {
    const p = await probeFile(path.join(MEDIA, 'clean.mp4'))
    const a = await analyzeContent(p)
    expect(a.noise.noiseClass).toBe('clean')
    const plan = decide(a, settings)
    expect(plan.mode).toBe('remux')
  }, 180000)

  it('grain fixture → classified heavy → plan encodes with nlmeans', async () => {
    const p = await probeFile(path.join(MEDIA, 'grain.mp4'))
    const a = await analyzeContent(p)
    expect(a.noise.noiseClass).toBe('heavy')
    const plan = decide(a, settings)
    expect(plan.mode).toBe('encode')
    expect(plan.filters.denoiseFilter).toBe('nlmeans')
  }, 180000)

  it('static low-bitrate fixture → low motion, encode path', async () => {
    const p = await probeFile(path.join(MEDIA, 'static.mp4'))
    const a = await analyzeContent(p)
    expect(a.noise.motionClass).toBe('low')
    expect(decide(a, settings).mode).toBe('encode')
  }, 180000)

  // Real filtergraph validation: every chain shape must be accepted by ffmpeg.
  it('fit-pad + denoise + fps + sharpen graph runs through ffmpeg', async () => {
    const wide = path.join(MEDIA, 'widescreen.mp4')
    if (!fs.existsSync(wide)) {
      await runOrThrow(paths().ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
        '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', wide
      ], { timeoutMs: 120000 })
    }
    const probe = await probeFile(wide)
    const { graph } = buildVideoChain(
      {
        ...neutralFilters(),
        denoise: 30,
        denoiseFilter: 'hqdn3d',
        fpsTarget: 60,
        scale: { targetW: 1080, targetH: 1920, mode: 'fit-pad' },
        sharpen: 0.3,
        saturationBoost: 1.05,
        contrastBoost: 1.02
      },
      probe
    )
    const res = await runOrThrow(paths().ffmpeg, [
      '-hide_banner', '-y', '-t', '1', '-i', wide,
      '-filter_complex', graph, '-map', '[vout]',
      '-f', 'null', 'NUL'
    ], { timeoutMs: 300000 })
    expect(res.code).toBe(0)
  }, 300000)

  it('HDR probe detection + tone-map graph runs through ffmpeg', async () => {
    const hdr = path.join(MEDIA, 'hdr.mp4')
    if (!fs.existsSync(hdr)) {
      await runOrThrow(paths().ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
        '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le',
        '-x264-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
        '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc',
        hdr
      ], { timeoutMs: 120000 })
    }
    const probe = await probeFile(hdr)
    expect(probe.video.isHdr).toBe(true)
    expect(probe.video.bitDepth).toBe(10)

    const { graph } = buildVideoChain(
      { ...neutralFilters(), tonemapHdr: true, fpsTarget: 30, scale: { targetW: 1080, targetH: 1920, mode: 'fit-pad' } },
      probe
    )
    const res = await runOrThrow(paths().ffmpeg, [
      '-hide_banner', '-y', '-t', '0.5', '-i', hdr,
      '-filter_complex', graph, '-map', '[vout]',
      '-f', 'null', 'NUL'
    ], { timeoutMs: 300000 })
    expect(res.code).toBe(0)
  }, 300000)

  // Full encode round-trip: real x264 args (fast preset for test speed),
  // then VMAF measured against the filtered source, then A/V sync check.
  it('encode args produce a valid CFR60 BT.709 faststart file; VMAF + A/V sync verified', async () => {
    const wide = path.join(MEDIA, 'widescreen-audio.mp4')
    if (!fs.existsSync(wide)) {
      await runOrThrow(paths().ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
        '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest', wide
      ], { timeoutMs: 120000 })
    }
    const probe = await probeFile(wide)
    expect(probe.audio.present).toBe(true)

    const filters = {
      ...neutralFilters(),
      fpsTarget: 60,
      scale: { targetW: 1080, targetH: 1920, mode: 'fit-pad' as const },
      sharpen: 0.25,
      saturationBoost: 1.05,
      contrastBoost: 1.02
    }
    const { graph } = buildVideoChain(filters, probe)
    const out = path.join(MEDIA, 'encoded-e2e.mp4')
    const args = buildEncodeArgs({
      inputPath: wide,
      filterGraph: graph,
      crf: 18,
      preset: 'fast', // veryslow in production; fast keeps the test snappy
      hasAudio: true,
      loudnorm: null,
      outputPath: out
    })
    await runOrThrow(paths().ffmpeg, args, { timeoutMs: 600000 })

    // verify output invariants
    const outProbe = await probeFile(out)
    expect(outProbe.video.width).toBe(1080)
    expect(outProbe.video.height).toBe(1920)
    expect(Math.round(outProbe.video.fpsAverage)).toBe(60)
    expect(outProbe.video.fpsMode).toBe('cfr')
    expect(outProbe.video.colorSpace).toBe('bt709')
    expect(outProbe.video.pixFmt).toBe('yuv420p')
    expect(outProbe.audio.sampleRate).toBe(48000)
    // A/V sync: audio and video durations must stay aligned
    expect(Math.abs(outProbe.durationSec - probe.durationSec)).toBeLessThan(0.25)

    // VMAF vs filtered source — CRF 18 on synthetic content should score high
    const vmaf = await computeVmaf(out, wide, {
      sourceFilterGraph: graph,
      fps: 60,
      durationSec: probe.durationSec
    })
    expect(vmaf.vmaf).toBeGreaterThan(90)
    expect(vmaf.ssim).toBeGreaterThan(0.95)
  }, 900000)

  it('detects up to 3 separated motion hotspots, sorted by time', async () => {
    const src = path.join(MEDIA, 'clean.mp4')
    const spots = await detectHotspots(src, 5)
    expect(spots.length).toBeGreaterThan(0)
    expect(spots.length).toBeLessThanOrEqual(3)
    for (let i = 1; i < spots.length; i++) {
      expect(spots[i].timeSec).toBeGreaterThan(spots[i - 1].timeSec)
      expect(Math.abs(spots[i].timeSec - spots[i - 1].timeSec)).toBeGreaterThanOrEqual(2)
    }
    for (const s of spots) {
      expect(s.timeSec).toBeGreaterThanOrEqual(0)
      expect(s.timeSec).toBeLessThanOrEqual(3) // clamped so a 2s window fits in a 5s clip
      expect(s.score).toBeGreaterThan(0)
    }
  }, 300000)

  it('fill-crop + nlmeans graph runs through ffmpeg', async () => {
    const probe = await probeFile(path.join(MEDIA, 'clean.mp4'))
    const { graph } = buildVideoChain(
      {
        ...neutralFilters(),
        denoise: 60,
        denoiseFilter: 'nlmeans',
        fpsTarget: 30,
        scale: { targetW: 1080, targetH: 1920, mode: 'fill-crop' },
        sharpen: 0.25
      },
      probe
    )
    const res = await runOrThrow(paths().ffmpeg, [
      '-hide_banner', '-y', '-t', '0.5', '-i', path.join(MEDIA, 'clean.mp4'),
      '-filter_complex', graph, '-map', '[vout]',
      '-f', 'null', 'NUL'
    ], { timeoutMs: 300000 })
    expect(res.code).toBe(0)
  }, 300000)
})
