import type { FilterPlan, Plan, ProbeInfo } from './types'

// FFmpeg filter-chain builder (pure, unit-tested).
//
// Chain order matters:
//   tone-map (HDR→709) → denoise (at source resolution, before scaling can
//   smear grain into detail) → CFR fps → scale (lanczos) → pre-sharpen →
//   saturation/contrast → yuv420p/setsar
//
// Rotation metadata is baked automatically: ffmpeg's autorotate applies the
// display matrix on every re-encode, so rotated sources come out with pixels
// physically rotated and no stale metadata.

/** slider 0-100 → hqdn3d params (defaults 4:3:6:4.5 scaled, capped at 2×) */
export function hqdn3dParams(denoise: number): string {
  const f = Math.min(2, Math.max(0, denoise) / 50)
  const r = (x: number): string => (Math.round(x * f * 10) / 10).toString()
  return `hqdn3d=${r(4)}:${r(3)}:${r(6)}:${r(4.5)}`
}

/** slider 0-100 → nlmeans strength (1..8), research window kept default for sanity */
export function nlmeansParams(denoise: number): string {
  const s = Math.round((1 + (Math.min(100, Math.max(0, denoise)) / 100) * 7) * 10) / 10
  return `nlmeans=s=${s}:p=7:r=15`
}

export function denoiseFilterString(filters: FilterPlan): string | null {
  if (filters.denoise <= 0 || filters.denoiseFilter === 'none') return null
  return filters.denoiseFilter === 'nlmeans'
    ? nlmeansParams(filters.denoise)
    : hqdn3dParams(filters.denoise)
}

// HDR → SDR BT.709 tone-map (hable operator, the standard for gameplay)
const TONEMAP_CHAIN =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,' +
  'zscale=t=bt709:m=bt709:r=tv,format=yuv420p'

export interface ChainOptions {
  /** cap the longer output side for fast previews (e.g. 960); 0 = full size */
  previewHeight?: number
}

/**
 * Build the video filtergraph. Returns a `-filter_complex` expression with
 * explicit [vout] label (needed because fit-pad uses split/overlay).
 */
export function buildVideoChain(
  filters: FilterPlan,
  _probe: ProbeInfo,
  opts: ChainOptions = {}
): { graph: string; outLabel: string } {
  const pre: string[] = []

  if (filters.tonemapHdr) pre.push(TONEMAP_CHAIN)

  const dn = denoiseFilterString(filters)
  if (dn) pre.push(dn)

  if (filters.fpsTarget) {
    // real fps changes only ever go through the fps filter (never input -r,
    // never timestamp tricks) — drops/dupes frames to a true constant rate
    if (filters.minterpolate) {
      pre.push(`minterpolate=fps=${filters.fpsTarget}:mi_mode=mci:mc_mode=aobmc:vsbmc=1`)
    } else {
      pre.push(`fps=${filters.fpsTarget}`)
    }
  }

  const post: string[] = []
  if (filters.sharpen > 0) {
    // post-scale luma-only unsharp: counters TikTok's softening without haloing
    const amt = Math.min(0.8, Math.max(0, filters.sharpen))
    post.push(`unsharp=5:5:${amt.toFixed(2)}:5:5:0`)
  }
  if (filters.saturationBoost !== 1 || filters.contrastBoost !== 1) {
    post.push(
      `eq=saturation=${clamp(filters.saturationBoost, 0.5, 2).toFixed(3)}:contrast=${clamp(
        filters.contrastBoost,
        0.5,
        2
      ).toFixed(3)}`
    )
  }
  post.push('format=yuv420p', 'setsar=1')
  if (opts.previewHeight) post.push(`scale=-2:${opts.previewHeight}:flags=bilinear`)

  const preStr = pre.length > 0 ? pre.join(',') : 'null'
  const postStr = post.join(',')

  if (filters.scale && filters.scale.mode === 'fit-pad') {
    const { targetW: w, targetH: h } = filters.scale
    // blurred-background pad: background fills (crop), foreground fits, centered
    const graph =
      `[0:v]${preStr},split=2[bg][fg];` +
      `[bg]scale=${w}:${h}:force_original_aspect_ratio=increase:flags=bilinear,` +
      `crop=${w}:${h},gblur=sigma=24,eq=brightness=-0.08[bgv];` +
      `[fg]scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos[fgv];` +
      `[bgv][fgv]overlay=(W-w)/2:(H-h)/2,${postStr}[vout]`
    return { graph, outLabel: 'vout' }
  }

  const parts: string[] = [preStr]
  if (filters.scale && filters.scale.mode === 'none') {
    parts.push(`scale=${filters.scale.targetW}:${filters.scale.targetH}:flags=lanczos`)
  } else if (filters.scale && filters.scale.mode === 'fill-crop') {
    parts.push(
      `scale=${filters.scale.targetW}:${filters.scale.targetH}:force_original_aspect_ratio=increase:flags=lanczos`,
      `crop=${filters.scale.targetW}:${filters.scale.targetH}`
    )
  }
  parts.push(postStr)
  return { graph: `[0:v]${parts.join(',')}[vout]`, outLabel: 'vout' }
}

/** Audio chain: resample-based A/V sync repair, mandatory for VFR sources. */
export function buildAudioChain(): string {
  return 'aresample=async=1:first_pts=0'
}

/** Merge user slider overrides onto the automatic plan. */
export function applyOverrides(plan: Plan, overrides: Partial<FilterPlan> | null | undefined): Plan {
  if (!overrides) return plan
  const filters = { ...plan.filters, ...overrides }
  // picking a denoise strength without a filter selected implies hqdn3d;
  // setting strength to 0 disables whatever filter was chosen
  if (filters.denoise > 0 && filters.denoiseFilter === 'none') filters.denoiseFilter = 'hqdn3d'
  if (filters.denoise <= 0) filters.denoiseFilter = 'none'
  return { ...plan, filters }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
