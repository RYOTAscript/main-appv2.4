// x264 encode argument builder (pure, unit-tested).
//
// High-motion tuning, parameter by parameter:
//   ref=6          six reference frames — repeated map geometry benefits from
//                  deep references without hitting level 4.2 limits at 1080p
//   bframes=5      generous B-frame budget for smooth camera motion
//   b-adapt=2      full-search B-frame placement (best quality decision)
//   me=umh         uneven multi-hexagon motion search — tracks fast crosshair
//                  flicks far better than the default hex
//   subme=10       highest quality subpixel refinement + RD on all frames
//   merange=32     wide motion search radius for whip-pans and shake
//                  transitions (default 16 loses long motion vectors)
//   rc-lookahead=60  a full second of lookahead @60fps so hard cuts and flashes
//                  get bits allocated before they arrive
//   aq-mode=3      auto-variance AQ with dark-bias — protects dark map corners
//                  (Ascent B-site, Split sewers) that TikTok's encoder crushes
//   aq-strength=1.0  default strength; higher blurs flat UI elements
//   psy-rd=1.0,0.15  psychovisual RD + trellis: keeps grain/texture energy so
//                  the image stays "crisp" instead of mathematically smooth
//   deblock=-1,-1  slightly negative deblocking preserves sharp weapon/UI
//                  edges; TikTok's own encode will blur them again anyway
//   keyint=120     max 2s GOP @60fps — TikTok segments cleanly, seeks fine
//   min-keyint=60  at least 1s between IDR frames so scene-cut detection
//                  doesn't spam keyframes during flash transitions

export const X264_HIGH_MOTION_PARAMS = [
  'ref=6',
  'bframes=5',
  'b-adapt=2',
  'me=umh',
  'subme=10',
  'merange=32',
  'rc-lookahead=60',
  'aq-mode=3',
  'aq-strength=1.0',
  'psy-rd=1.0,0.15',
  'deblock=-1,-1',
  'keyint=120',
  'min-keyint=60',
  // BT.709 VUI written into the bitstream itself (survives remuxing)
  'colorprim=bt709',
  'transfer=bt709',
  'colormatrix=bt709'
].join(':')

export interface LoudnormMeasurement {
  input_i: string
  input_tp: string
  input_lra: string
  input_thresh: string
  target_offset: string
}

export interface EncodeArgsOptions {
  inputPath: string
  /** -filter_complex graph ending in [vout]; null = no video filtering */
  filterGraph: string | null
  crf: number
  preset: string
  hasAudio: boolean
  /** two-pass loudnorm: measured values from pass 1; null = plain audio encode */
  loudnorm: LoudnormMeasurement | null
  outputPath: string
}

/** Audio chain: timestamp/sync repair first, then (optionally) loudness normalization. */
export function audioFilterString(loudnorm: LoudnormMeasurement | null): string {
  const sync = 'aresample=async=1:first_pts=0'
  if (!loudnorm) return sync
  // linear=true keeps dynamics (no limiter pumping) — only valid with measured values
  return (
    sync +
    `,loudnorm=I=-14:TP=-1:LRA=11:measured_I=${loudnorm.input_i}:measured_TP=${loudnorm.input_tp}` +
    `:measured_LRA=${loudnorm.input_lra}:measured_thresh=${loudnorm.input_thresh}` +
    `:offset=${loudnorm.target_offset}:linear=true`
  )
}

export function buildEncodeArgs(o: EncodeArgsOptions): string[] {
  const args: string[] = ['-hide_banner', '-y', '-i', o.inputPath]

  if (o.filterGraph) {
    args.push('-filter_complex', o.filterGraph, '-map', '[vout]')
  } else {
    args.push('-map', '0:v:0')
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', o.preset,          // veryslow: quality beats speed, always
    '-crf', String(o.crf),
    '-profile:v', 'high',         // TikTok's own target profile
    '-level', '4.2',              // safe ceiling for 1080p60 H.264
    '-pix_fmt', 'yuv420p',
    '-x264-params', X264_HIGH_MOTION_PARAMS,
    // container-level color tags matching the VUI above
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-color_range', 'tv'
  )

  if (o.hasAudio) {
    args.push(
      '-map', '0:a:0',
      '-af', audioFilterString(o.loudnorm),
      '-c:a', 'aac',
      '-b:a', '320k',              // AAC-LC at the ceiling — audio is cheap, drops are not
      '-ar', '48000',
      '-ac', '2'
    )
  } else {
    args.push('-an')
  }

  args.push(
    '-movflags', '+faststart',     // moov up front: instant playback on upload check
    '-progress', 'pipe:1',
    o.outputPath
  )
  return args
}

/** CRF search bounds for Smart Compress. */
export const SMART_CRF_START = 18
export const SMART_CRF_MIN = 10
export const SMART_CRF_MAX = 28
export const SMART_MAX_ATTEMPTS = 4

/**
 * Binary-search step for Smart Compress: find the *highest* CRF (smallest
 * file) whose VMAF still meets the target. Returns the next CRF to try, or
 * null when the search interval is exhausted.
 */
export function nextCrf(
  tried: { crf: number; vmaf: number }[],
  target: number
): number | null {
  if (tried.length === 0) return SMART_CRF_START
  if (tried.length >= SMART_MAX_ATTEMPTS) return null

  const passing = tried.filter((t) => t.vmaf >= target).map((t) => t.crf)
  const failing = tried.filter((t) => t.vmaf < target).map((t) => t.crf)
  // search window: above the best passing CRF, below the worst failing CRF
  const lo = passing.length > 0 ? Math.max(...passing) : SMART_CRF_MIN - 1
  const hi = failing.length > 0 ? Math.min(...failing) : SMART_CRF_MAX + 1

  const mid = Math.floor((lo + hi) / 2)
  if (mid <= lo || mid >= hi) return null // interval closed — best passing CRF wins
  return mid
}

/** Pick the final CRF after the search: highest passing, else lowest tried. */
export function finalCrf(tried: { crf: number; vmaf: number }[], target: number): number {
  const passing = tried.filter((t) => t.vmaf >= target)
  if (passing.length > 0) return Math.max(...passing.map((t) => t.crf))
  return Math.min(...tried.map((t) => t.crf))
}
