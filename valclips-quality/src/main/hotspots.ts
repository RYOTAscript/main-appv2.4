import type { Hotspot } from '@shared/types'
import { requireReady } from './ffmpeg'
import { runOrThrow } from './run'
import { log } from './logger'

// Motion hotspot detection: find the 3 highest-motion moments in the clip —
// flicks, shake transitions, flashes — because that's exactly where TikTok's
// re-encode does its damage and where a comparison is worth looking at.
//
// signalstats YDIF per frame (downscaled for speed) → per-second buckets →
// top 3 buckets with ≥2s separation.

export async function detectHotspots(sourcePath: string, durationSec: number): Promise<Hotspot[]> {
  const { ffmpeg } = requireReady()
  try {
    const res = await runOrThrow(ffmpeg, [
      '-hide_banner', '-nostats',
      '-i', sourcePath,
      '-map', '0:v:0',
      '-vf', 'scale=320:-2:flags=bilinear,signalstats,metadata=print:file=-',
      '-f', 'null', 'NUL'
    ], { timeoutMs: 600000 })

    // metadata=print emits: "frame:N pts:X pts_time:T" then "lavfi.signalstats.YDIF=V"
    const samples: { t: number; ydif: number }[] = []
    let currentT = -1
    for (const line of res.stdout.split(/\r?\n/)) {
      const head = line.match(/^frame:\d+\s+pts:\S+\s+pts_time:([\d.]+)/)
      if (head) {
        currentT = parseFloat(head[1])
        continue
      }
      const ydif = line.match(/lavfi\.signalstats\.YDIF=([\d.eE+-]+)/)
      if (ydif && currentT >= 0) {
        samples.push({ t: currentT, ydif: parseFloat(ydif[1]) })
      }
    }
    if (samples.length === 0) return []

    // bucket by second
    const buckets = new Map<number, { sum: number; n: number }>()
    for (const s of samples) {
      const b = Math.floor(s.t)
      const cur = buckets.get(b) ?? { sum: 0, n: 0 }
      cur.sum += s.ydif
      cur.n += 1
      buckets.set(b, cur)
    }
    const scored = [...buckets.entries()]
      .map(([sec, { sum, n }]) => ({ sec, score: sum / n }))
      .sort((a, b) => b.score - a.score)

    // greedy top-3 with ≥2s separation, each clamped so a 2s window fits
    const picked: Hotspot[] = []
    for (const { sec, score } of scored) {
      if (picked.length >= 3) break
      if (picked.some((p) => Math.abs(p.timeSec - sec) < 2)) continue
      picked.push({
        timeSec: Math.max(0, Math.min(sec, Math.max(0, durationSec - 2))),
        score: Math.round((score / 255) * 10000) / 10000
      })
    }
    picked.sort((a, b) => a.timeSec - b.timeSec)
    log.info('hotspots detected', { sourcePath, picked })
    return picked
  } catch (err) {
    // hotspots are a nice-to-have — verification must not fail over them
    log.warn('hotspot detection failed', String(err))
    return []
  }
}
