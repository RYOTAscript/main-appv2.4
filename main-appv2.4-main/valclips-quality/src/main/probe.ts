import * as fs from 'fs'
import type { ProbeInfo, FrameRateMode } from '@shared/types'
import { requireReady } from './ffmpeg'
import { runOrThrow } from './run'
import { log } from './logger'

// Deep source scan. Two ffprobe passes:
//   1. format+streams JSON (codec, resolution, color, rotation, bitrate…)
//   2. the first ~600 video packet timestamps — the only reliable way to tell
//      VFR from CFR. OBS/ShadowPlay recordings are frequently VFR even though
//      their metadata claims a clean 60; TikTok mangles VFR uploads.

function parseRational(s: string | undefined): number {
  if (!s) return 0
  const [num, den] = s.split('/').map(Number)
  if (!den) return Number.isFinite(num) ? num : 0
  return den === 0 ? 0 : num / den
}

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  profile?: string
  width?: number
  height?: number
  pix_fmt?: string
  bits_per_raw_sample?: string
  avg_frame_rate?: string
  r_frame_rate?: string
  color_space?: string
  color_transfer?: string
  color_primaries?: string
  bit_rate?: string
  channels?: number
  sample_rate?: string
  side_data_list?: { side_data_type?: string; rotation?: number }[]
  tags?: Record<string, string>
}

export async function probeFile(path: string): Promise<ProbeInfo> {
  const { ffprobe } = requireReady()

  const meta = await runOrThrow(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    { timeoutMs: 60000 }
  )
  let parsed: { format?: Record<string, string>; streams?: FfprobeStream[] }
  try {
    parsed = JSON.parse(meta.stdout)
  } catch {
    throw new Error('This file could not be read as a video — it may be corrupt.')
  }
  const streams = parsed.streams ?? []
  const v = streams.find((s) => s.codec_type === 'video')
  if (!v) throw new Error('No video stream found in this file.')
  const a = streams.find((s) => s.codec_type === 'audio')
  const format = parsed.format ?? {}

  // rotation: modern ffprobe exposes it in side_data_list; legacy in tags.rotate
  let rotation = 0
  for (const sd of v.side_data_list ?? []) {
    if (typeof sd.rotation === 'number') rotation = sd.rotation
  }
  if (rotation === 0 && v.tags?.rotate) rotation = parseInt(v.tags.rotate, 10) || 0
  rotation = ((rotation % 360) + 360) % 360

  const fpsAverage = parseRational(v.avg_frame_rate) || parseRational(v.r_frame_rate)
  const durationSec = parseFloat(format['duration'] ?? '') || 0
  const sizeBytes = (() => {
    try {
      return fs.statSync(path).size
    } catch {
      return parseInt(format['size'] ?? '0', 10) || 0
    }
  })()

  const colorTransfer = v.color_transfer ?? ''
  const colorPrimaries = v.color_primaries ?? ''
  const colorSpace = v.color_space ?? ''
  // PQ/HLG transfer is definitely HDR; bt2020 primaries or matrix means the
  // file needs the same BT.709 conversion pass even if the transfer tag is lost
  const isHdr =
    colorTransfer === 'smpte2084' ||
    colorTransfer === 'arib-std-b67' ||
    colorPrimaries === 'bt2020' ||
    colorSpace.startsWith('bt2020')

  const pixFmt = v.pix_fmt ?? ''
  const bitDepth = parseInt(v.bits_per_raw_sample ?? '', 10) || (/p?10(le|be)?$/.test(pixFmt) ? 10 : 8)

  const { fpsMode, jitterMs } = await detectFrameRateMode(ffprobe, path)

  const info: ProbeInfo = {
    path,
    container: (format['format_name'] ?? '').split(',')[0] ?? '',
    durationSec,
    sizeBytes,
    overallBitrate: parseInt(format['bit_rate'] ?? '0', 10) || 0,
    video: {
      codec: v.codec_name ?? '',
      profile: v.profile ?? '',
      width: v.width ?? 0,
      height: v.height ?? 0,
      rotation,
      pixFmt,
      bitDepth,
      fpsAverage,
      fpsMode,
      frameIntervalJitterMs: jitterMs,
      colorSpace,
      colorTransfer,
      colorPrimaries,
      isHdr,
      bitrate: parseInt(v.bit_rate ?? '0', 10) || 0
    },
    audio: {
      present: !!a,
      codec: a?.codec_name ?? '',
      channels: a?.channels ?? 0,
      sampleRate: parseInt(a?.sample_rate ?? '0', 10) || 0,
      bitrate: parseInt(a?.bit_rate ?? '0', 10) || 0
    }
  }
  log.info('probe complete', {
    path,
    codec: info.video.codec,
    res: `${info.video.width}x${info.video.height}`,
    fps: info.video.fpsAverage,
    mode: info.video.fpsMode,
    hdr: info.video.isHdr
  })
  return info
}

/**
 * CFR vs VFR from real packet timestamps.
 * Reads the first 600 video packets, sorts presentation times, and measures the
 * spread of frame intervals. CFR sources show one interval (± container rounding,
 * which mp4/mkv timebases keep well under 5% of a frame). VFR captures show
 * interval jitter an order of magnitude larger.
 */
async function detectFrameRateMode(
  ffprobe: string,
  path: string
): Promise<{ fpsMode: FrameRateMode; jitterMs: number }> {
  const res = await runOrThrow(
    ffprobe,
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time',
      '-read_intervals', '%+#600',
      '-print_format', 'csv=p=0',
      path
    ],
    { timeoutMs: 60000 }
  )
  const times = res.stdout
    .split(/\r?\n/)
    .map((l) => parseFloat(l))
    .filter((n) => Number.isFinite(n))
    .sort((x, y) => x - y)

  if (times.length < 30) return { fpsMode: 'cfr', jitterMs: 0 } // too short to judge — treat as CFR

  const deltas: number[] = []
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1]
    if (d > 0 && d < 1) deltas.push(d * 1000)
  }
  if (deltas.length < 20) return { fpsMode: 'cfr', jitterMs: 0 }

  const sorted = [...deltas].sort((x, y) => x - y)
  const median = sorted[Math.floor(sorted.length / 2)]
  const mean = deltas.reduce((s, d) => s + d, 0) / deltas.length
  const stddev = Math.sqrt(deltas.reduce((s, d) => s + (d - mean) * (d - mean), 0) / deltas.length)

  // > 15% of the median frame interval in timestamp jitter = VFR
  const vfr = median > 0 && stddev / median > 0.15
  return { fpsMode: vfr ? 'vfr' : 'cfr', jitterMs: Math.round(stddev * 100) / 100 }
}
