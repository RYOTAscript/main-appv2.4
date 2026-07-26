import type { Analysis, NoiseAnalysis, ProbeInfo } from '@shared/types'
import { requireReady } from './ffmpeg'
import { runOrThrow } from './run'
import { log } from './logger'
import { classifyNoise, classifyMotion } from '@shared/decision'

// Noise & motion measurement.
//
// Noise (primary): `tblend=difference` + `bitplanenoise` measures how *random*
// the change between consecutive frames is. Static fine detail cancels out;
// dancing grain — exactly what wastes TikTok bitrate — reads high. Measured at
// FULL resolution (downscaling averages grain away before we can see it) on a
// consecutive run of frames starting a third into the clip.
//
// Noise (corroboration): plain spatial `bitplanenoise` on sampled frames.
// The heavy tier requires both, so violent motion alone can never trigger
// aggressive nlmeans.
//
// Motion: `signalstats` YDIF (mean abs luma difference between consecutive
// frames) over the first ~12 s at 320px — cheap and stable. Valorant flick
// content typically lands well above the 0.03 threshold.

export async function analyzeContent(probe: ProbeInfo): Promise<Analysis> {
  const { ffmpeg } = requireReady()
  const path = probe.path
  const noiseSeekSec = Math.max(0, probe.durationSec * 0.33).toFixed(2)

  // --- pass 1: temporal noise on ~60 consecutive full-res frames mid-clip ---
  const temporalRes = await runOrThrow(
    ffmpeg,
    [
      '-hide_banner', '-nostats',
      '-ss', noiseSeekSec,
      '-i', path,
      '-map', '0:v:0',
      '-vf', 'tblend=all_mode=difference,bitplanenoise,metadata=print:file=-',
      '-frames:v', '60',
      '-f', 'null', 'NUL'
    ],
    { timeoutMs: 180000 }
  )
  // first diff frame blends against nothing — drop it
  const temporalValues = extractMetadata(temporalRes.stdout, 'lavfi.bitplanenoise.0.1').slice(1)
  const noiseLevel = mean(temporalValues)

  // --- pass 2: spatial noise on ~40 full-res frames spread across the clip ---
  const spatialRes = await runOrThrow(
    ffmpeg,
    [
      '-hide_banner', '-nostats',
      '-i', path,
      '-map', '0:v:0',
      '-vf', "select='not(mod(n,15))',bitplanenoise,metadata=print:file=-",
      '-frames:v', '40',
      '-f', 'null', 'NUL'
    ],
    { timeoutMs: 180000 }
  )
  const spatialValues = extractMetadata(spatialRes.stdout, 'lavfi.bitplanenoise.0.1')
  const spatialNoise = mean(spatialValues)

  // --- pass 3: motion complexity on a downscaled 12 s window ---
  const motionRes = await runOrThrow(
    ffmpeg,
    [
      '-hide_banner', '-nostats',
      '-i', path,
      '-map', '0:v:0',
      '-t', '12',
      '-vf', 'scale=320:-2:flags=bilinear,signalstats,metadata=print:file=-',
      '-f', 'null', 'NUL'
    ],
    { timeoutMs: 180000 }
  )
  const ydifValues = extractMetadata(motionRes.stdout, 'lavfi.signalstats.YDIF')
  const motionLevel = mean(ydifValues) / 255

  const noise: NoiseAnalysis = {
    noiseLevel: round4(noiseLevel),
    spatialNoise: round4(spatialNoise),
    noiseClass: classifyNoise(noiseLevel, spatialNoise),
    motionLevel: round4(motionLevel),
    motionClass: classifyMotion(motionLevel)
  }

  const warnings: string[] = []
  if (probe.video.fpsMode === 'vfr')
    warnings.push('Variable frame rate detected — will be converted to constant FPS.')
  if (probe.video.isHdr) warnings.push('HDR source — will be tone-mapped to BT.709 for TikTok.')
  if (noise.noiseClass === 'heavy')
    warnings.push('Heavy grain/particle noise detected — cleanup strongly recommended.')
  if (probe.durationSec > 60)
    warnings.push(`Clip is ${Math.round(probe.durationSec)}s — TikTok compresses long videos harder.`)
  if (!probe.audio.present) warnings.push('No audio stream — output will be silent.')

  log.info('content analysis', {
    path,
    noise,
    temporalSamples: temporalValues.length,
    spatialSamples: spatialValues.length,
    motionSamples: ydifValues.length
  })
  return { probe, noise, warnings }
}

function extractMetadata(stdout: string, key: string): number[] {
  const values: number[] = []
  const re = new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([0-9.eE+-]+)`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(stdout)) !== null) {
    const v = parseFloat(m[1])
    if (Number.isFinite(v)) values.push(v)
  }
  return values
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}
