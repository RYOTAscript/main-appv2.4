import type {
  Analysis,
  EncodePlan,
  FilterPlan,
  MotionClass,
  NoiseClass,
  Plan,
  ProbeInfo
} from './types'

// The decision engine: pure function from analysis → complete processing plan.
// No I/O, no Electron — unit-tested against probe fixtures.

// ---------- classification thresholds ----------
// Primary noise metric: bitplanenoise LSB measured on the *temporal difference*
// between consecutive frames (tblend=difference). Static detail cancels out;
// random "dancing" grain — exactly what wastes TikTok bitrate — does not.
// Calibrated against generated fixtures (see tests/media):
//   clean moving content ≈ 0.07 · barely-visible noise ≈ 0.14 ·
//   worst-case full-frame fractal churn ≈ 0.47 · deliberate grain overlay ≈ 0.91
// Thresholds sit deliberately high: when in doubt, denoise less.
export const NOISE_LIGHT_THRESHOLD = 0.18
export const NOISE_HEAVY_THRESHOLD = 0.55
// heavy additionally requires spatial randomness (full-frame grain), so that
// violent motion alone can never trigger aggressive nlmeans
export const NOISE_HEAVY_SPATIAL_CORROBORATION = 0.45
// signalstats YDIF/255: static cams < 0.005, Valorant flick gameplay ≥ 0.03
export const MOTION_HIGH_THRESHOLD = 0.03

export function classifyNoise(temporal: number, spatial = 1): NoiseClass {
  if (temporal >= NOISE_HEAVY_THRESHOLD && spatial >= NOISE_HEAVY_SPATIAL_CORROBORATION)
    return 'heavy'
  if (temporal >= NOISE_LIGHT_THRESHOLD) return 'light'
  return 'clean'
}

export function classifyMotion(level: number): MotionClass {
  return level >= MOTION_HIGH_THRESHOLD ? 'high' : 'low'
}

// ---------- TikTok target spec ----------
// defined in types.ts so it can live inside user-editable settings
export { DEFAULT_TIKTOK_SPEC } from './types'
export type { TikTokSpec } from './types'
import { DEFAULT_TIKTOK_SPEC } from './types'
import type { OutputOrientation, TikTokSpec } from './types'

/**
 * Apply the chosen output orientation to the spec: 9:16 vertical keeps the
 * short side as width (1080×1920), 16:9 horizontal swaps it (1920×1080).
 * 'maintain' only uses the spec as a size class (short side cap), so it gets
 * the vertical shape. Works with user-edited spec dimensions too.
 */
export function orientedSpec(spec: TikTokSpec, orientation: OutputOrientation): TikTokSpec {
  const short = Math.min(spec.width, spec.height)
  const long = Math.max(spec.width, spec.height)
  return orientation === 'horizontal'
    ? { ...spec, width: long, height: short }
    : { ...spec, width: short, height: long }
}

function evenDim(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2)
}

export interface DecisionSettings {
  outputMode: 'master' | 'smart'
  masterCrf: number
  vmafTarget: number
  loudnorm: boolean
  /** output framing; 'maintain' keeps the source aspect ratio */
  orientation?: OutputOrientation
}

// ---------- remux eligibility ----------

function fpsIsStandard(fps: number, spec: TikTokSpec): boolean {
  const targets = [spec.fpsHigh, spec.fpsHigh * (1000 / 1001), spec.fpsLow, spec.fpsLow * (1000 / 1001)]
  return targets.some((t) => Math.abs(fps - t) < 0.05)
}

/**
 * "Already optimal" check. If the source is exactly what TikTok wants,
 * re-encoding even at CRF 12 is pure generation loss — stream-copy instead.
 * Anything that needs fixing (VFR, wrong size, HDR, rotation, grain, wrong
 * color tags, insane bitrate) falls through to the encode pipeline.
 */
export function remuxBlockers(
  analysis: Analysis,
  spec: TikTokSpec = DEFAULT_TIKTOK_SPEC,
  orientation: OutputOrientation = 'vertical'
): string[] {
  const p = analysis.probe
  const v = p.video
  const blockers: string[] = []

  if (v.codec !== 'h264') blockers.push(`codec is ${v.codec || 'unknown'}, TikTok wants H.264`)
  else if (!['High', 'Main', 'Constrained Baseline', 'Baseline'].includes(v.profile))
    blockers.push(`H.264 profile "${v.profile}" is unusual`)
  if (v.pixFmt !== 'yuv420p') blockers.push(`pixel format ${v.pixFmt || 'unknown'} (need yuv420p)`)
  if (v.bitDepth > 8) blockers.push(`${v.bitDepth}-bit video (need 8-bit)`)
  if (orientation === 'maintain') {
    // keep-aspect mode: any shape is welcome, only oversized sources need work
    const shortSide = Math.min(spec.width, spec.height)
    if (Math.min(v.width, v.height) > shortSide)
      blockers.push(
        `resolution ${v.width}×${v.height} is above the ${shortSide} class — downscale is a quality win`
      )
  } else if (v.width !== spec.width || v.height !== spec.height) {
    blockers.push(`resolution ${v.width}×${v.height} (need ${spec.width}×${spec.height})`)
  }
  if (v.rotation !== 0) blockers.push(`rotation metadata (${v.rotation}°) must be baked in`)
  if (v.fpsMode === 'vfr') blockers.push('variable frame rate must be converted to CFR')
  if (!fpsIsStandard(v.fpsAverage, spec))
    blockers.push(`${v.fpsAverage.toFixed(2)} fps is not a clean ${spec.fpsLow}/${spec.fpsHigh}`)
  if (v.isHdr) blockers.push('HDR must be tone-mapped to BT.709')
  // explicit non-709 tags are wrong for TikTok; untagged 1080p SDR is assumed 709 everywhere
  if (v.colorSpace && !['bt709', 'unknown', 'unspecified'].includes(v.colorSpace))
    blockers.push(`color space ${v.colorSpace} (need BT.709)`)
  if (analysis.noise.noiseClass !== 'clean')
    blockers.push(`${analysis.noise.noiseClass} grain detected — cleanup will save TikTok bitrate`)
  const vbr = v.bitrate || p.overallBitrate
  if (vbr > 0 && vbr < spec.minSaneBitrate)
    blockers.push('bitrate is too low — the file is already heavily compressed')
  if (vbr > spec.maxSaneBitrate) blockers.push('bitrate is extreme — smart compression will help')
  return blockers
}

// ---------- plan builder ----------

export function decide(
  analysis: Analysis,
  settings: DecisionSettings,
  spec: TikTokSpec = DEFAULT_TIKTOK_SPEC
): Plan {
  const p = analysis.probe
  const v = p.video
  const reasons: string[] = []

  const encode: EncodePlan = {
    outputMode: settings.outputMode,
    crf: settings.masterCrf,
    vmafTarget: settings.vmafTarget,
    preset: 'veryslow',
    loudnorm: settings.loudnorm && p.audio.present
  }

  const orientation = settings.orientation ?? 'vertical'
  const blockers = remuxBlockers(analysis, spec, orientation)
  if (blockers.length === 0) {
    reasons.push(
      'Source is already a perfect upload file (H.264, CFR, BT.709, clean, right size) — ' +
        'stream-copy remux, zero quality loss.'
    )
    return {
      mode: 'remux',
      reasons,
      filters: neutralFilters(),
      encode
    }
  }
  reasons.push(...blockers.map((b) => `Needs encode: ${b}`))

  // --- denoise tier ---
  let denoise = 0
  let denoiseFilter: FilterPlan['denoiseFilter'] = 'none'
  if (analysis.noise.noiseClass === 'light') {
    denoise = 30
    denoiseFilter = 'hqdn3d'
    reasons.push('Light noise → gentle hqdn3d so VFX/muzzle flashes stay intact.')
  } else if (analysis.noise.noiseClass === 'heavy') {
    denoise = 60
    denoiseFilter = 'nlmeans'
    reasons.push('Heavy grain → nlmeans (high quality) tuned conservatively.')
  } else {
    reasons.push('Clean source → denoising off (never soften intentional VFX).')
  }

  // --- geometry ---
  const rotated = v.rotation === 90 || v.rotation === 270
  const effW = rotated ? v.height : v.width
  const effH = rotated ? v.width : v.height
  let scale: FilterPlan['scale'] = null
  if (orientation === 'maintain') {
    // keep the source aspect ratio untouched; only downscale oversized sources
    // to the spec's size class (short side cap) — never upscale, never pad
    const shortSide = Math.min(spec.width, spec.height)
    const minSide = Math.min(effW, effH)
    if (minSide > shortSide) {
      const ratio = shortSide / minSide
      scale = { targetW: evenDim(effW * ratio), targetH: evenDim(effH * ratio), mode: 'none' }
      reasons.push(
        `Keeping ${effW}:${effH} aspect — downscaling to ${scale.targetW}×${scale.targetH} = supersampling, a quality win.`
      )
    } else {
      reasons.push('Keeping source aspect ratio and resolution — no padding, no cropping, no upscale.')
    }
  } else if (effW !== spec.width || effH !== spec.height) {
    const srcAspect = effW / effH
    const dstAspect = spec.width / spec.height
    const aspectMatches = Math.abs(srcAspect - dstAspect) < 0.01
    scale = { targetW: spec.width, targetH: spec.height, mode: aspectMatches ? 'none' : 'fit-pad' }
    if (effW > spec.width && aspectMatches)
      reasons.push(`Downscaling ${effW}×${effH} → ${spec.width}×${spec.height} = supersampling, a quality win.`)
    else if (!aspectMatches)
      reasons.push(
        `Source aspect doesn't match ${spec.width}×${spec.height} → fit with blurred background pad (never stretch).`
      )
    else reasons.push(`Scaling ${effW}×${effH} → ${spec.width}×${spec.height} (lanczos).`)
  }

  // --- frame rate ---
  const fpsTarget = v.fpsAverage >= spec.fpsHighCutoff ? spec.fpsHigh : spec.fpsLow
  reasons.push(
    v.fpsMode === 'vfr'
      ? `VFR (${v.frameIntervalJitterMs}ms jitter) → forcing constant ${fpsTarget} fps via the fps filter.`
      : `Constant ${fpsTarget} fps output (source ${v.fpsAverage.toFixed(2)}).`
  )

  if (v.isHdr) reasons.push('HDR → BT.709 tone-map (zscale + hable).')
  if (v.rotation !== 0) reasons.push(`Baking ${v.rotation}° rotation into pixels.`)

  // --- TikTok-crush countermeasures (conservative defaults) ---
  const sharpen = 0.25
  const saturationBoost = 1.05
  const contrastBoost = 1.02
  reasons.push('Subtle pre-sharpen + saturation/contrast lift to counter TikTok softening.')

  const filters: FilterPlan = {
    denoise,
    denoiseFilter,
    tonemapHdr: v.isHdr,
    bakeRotation: v.rotation !== 0,
    scale,
    fpsTarget,
    minterpolate: false,
    sharpen,
    saturationBoost,
    contrastBoost
  }

  return { mode: 'encode', reasons, filters, encode }
}

export function neutralFilters(): FilterPlan {
  return {
    denoise: 0,
    denoiseFilter: 'none',
    tonemapHdr: false,
    bakeRotation: false,
    scale: null,
    fpsTarget: null,
    minterpolate: false,
    sharpen: 0,
    saturationBoost: 1,
    contrastBoost: 1
  }
}

// helper for tests / preview UI
export function describeProbe(p: ProbeInfo): string {
  return `${p.video.width}x${p.video.height}@${p.video.fpsAverage.toFixed(2)} ${p.video.codec} ${p.video.fpsMode}`
}
