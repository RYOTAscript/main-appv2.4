// Shared type contracts between main, preload and renderer.
// Everything crossing the IPC boundary is defined here.

// ---------- FFmpeg toolchain ----------

export type FFmpegSource = 'system' | 'bundled'

export type FFmpegState =
  | { status: 'checking' }
  | {
      status: 'ready'
      source: FFmpegSource
      ffmpegPath: string
      ffprobePath: string
      version: string
      capabilities: FFmpegCapabilities
    }
  | { status: 'missing' }
  | { status: 'broken'; detail: string }
  | {
      status: 'installing'
      phase: 'download' | 'extract' | 'validate'
      receivedBytes: number
      totalBytes: number
    }
  | { status: 'error'; detail: string }

export interface FFmpegCapabilities {
  libx264: boolean
  libvmaf: boolean
  nlmeans: boolean
  hqdn3d: boolean
  zscale: boolean
  unsharp: boolean
}

// ---------- Probe / analysis (Stage 2) ----------

export type FrameRateMode = 'cfr' | 'vfr'
export type NoiseClass = 'clean' | 'light' | 'heavy'
export type MotionClass = 'low' | 'high'

export interface ProbeInfo {
  path: string
  container: string
  durationSec: number
  sizeBytes: number
  overallBitrate: number
  video: {
    codec: string
    profile: string
    width: number
    height: number
    rotation: number
    pixFmt: string
    bitDepth: number
    fpsAverage: number
    fpsMode: FrameRateMode
    /** stddev of frame intervals in ms — the raw VFR evidence */
    frameIntervalJitterMs: number
    colorSpace: string
    colorTransfer: string
    colorPrimaries: string
    isHdr: boolean
    bitrate: number
  }
  audio: {
    present: boolean
    codec: string
    channels: number
    sampleRate: number
    bitrate: number
  }
}

export interface NoiseAnalysis {
  /** 0..1 randomness of frame-to-frame differences — "dancing grain" measure */
  noiseLevel: number
  /** 0..1 spatial high-frequency randomness (fine detail + grain combined) */
  spatialNoise: number
  noiseClass: NoiseClass
  /** 0..1 average temporal difference — motion complexity */
  motionLevel: number
  motionClass: MotionClass
}

export interface Analysis {
  probe: ProbeInfo
  noise: NoiseAnalysis
  warnings: string[]
}

// ---------- Processing plan (Stage 2 decision engine) ----------

export type PlanMode = 'remux' | 'encode'

export interface FilterPlan {
  /** 0-100 cleanup strength; 0 = off */
  denoise: number
  denoiseFilter: 'none' | 'hqdn3d' | 'nlmeans'
  tonemapHdr: boolean
  bakeRotation: boolean
  scale: { targetW: number; targetH: number; mode: 'fit-pad' | 'fill-crop' | 'none' } | null
  fpsTarget: number | null
  minterpolate: boolean
  sharpen: number
  saturationBoost: number
  contrastBoost: number
}

export interface EncodePlan {
  outputMode: 'master' | 'smart'
  crf: number
  vmafTarget: number
  preset: string
  loudnorm: boolean
}

export interface Plan {
  mode: PlanMode
  reasons: string[]
  filters: FilterPlan
  encode: EncodePlan
}

// ---------- Jobs / queue ----------

export type JobStatus =
  | 'queued'
  | 'analyzing'
  | 'ready'
  | 'processing'
  | 'verifying'
  | 'done'
  | 'error'
  | 'cancelled'

export interface JobProgress {
  stage: string
  percent: number
  fps: number
  bitrateKbps: number
  speed: number
  etaSec: number
}

export interface JobResult {
  outputPath: string
  sizeBytes: number
  wasRemux: boolean
  vmaf: number | null
  ssim: number | null
  finalCrf: number | null
  compressionPercent: number | null
  ffmpegCommand: string
  hotspots: Hotspot[]
}

export interface Hotspot {
  timeSec: number
  score: number
}

export interface Job {
  id: string
  inputPath: string
  fileName: string
  outputPath: string
  status: JobStatus
  note: string
  addedAt: number
  analysis: Analysis | null
  plan: Plan | null
  /** user overrides applied on top of the automatic plan */
  overrides: Partial<FilterPlan & EncodePlan> | null
  progress: JobProgress | null
  result: JobResult | null
  error: string | null
  logTail: string[]
}

// ---------- TikTok target spec (user-editable in settings.json) ----------

export interface TikTokSpec {
  width: number
  height: number
  fpsHigh: number
  fpsLow: number
  /** source fps at or above this gets the high target */
  fpsHighCutoff: number
  minSaneBitrate: number
  maxSaneBitrate: number
}

export const DEFAULT_TIKTOK_SPEC: TikTokSpec = {
  width: 1080,
  height: 1920,
  fpsHigh: 60,
  fpsLow: 30,
  fpsHighCutoff: 50,
  minSaneBitrate: 3_000_000,
  maxSaneBitrate: 100_000_000
}

// ---------- Settings ----------

/**
 * Output framing:
 *  - 'maintain'  — keep the source aspect ratio, no padding/cropping (default);
 *                  oversized sources are downscaled to the 1080 class
 *  - 'vertical'  — force 9:16 (1080×1920) with blurred-pad fitting
 *  - 'horizontal'— force 16:9 (1920×1080) with blurred-pad fitting
 */
export type OutputOrientation = 'maintain' | 'vertical' | 'horizontal'

export interface AppSettings {
  outputMode: 'master' | 'smart'
  orientation: OutputOrientation
  masterCrf: number
  vmafTarget: number
  loudnorm: boolean
  outputFolder: string | null
  filenameTemplate: string
  confirmOverwrite: boolean
  hardwarePreview: boolean
  /** advanced: edit in settings.json to retarget another platform */
  tiktokSpec: TikTokSpec
}

export const DEFAULT_SETTINGS: AppSettings = {
  outputMode: 'smart',
  orientation: 'maintain',
  masterCrf: 12,
  vmafTarget: 97,
  loudnorm: true,
  outputFolder: null,
  filenameTemplate: '{name}_output',
  confirmOverwrite: true,
  hardwarePreview: false,
  tiktokSpec: DEFAULT_TIKTOK_SPEC
}

// ---------- Drop handling ----------

export interface AddFilesResult {
  accepted: string[]
  rejected: { path: string; reason: string }[]
  needsConfirm: { path: string; outputPath: string }[]
  /** a dropped folder contained several candidates — ask the user which */
  needsSelection: { folder: string; files: string[] }[]
}

// ---------- Toasts ----------

export type ToastKind = 'info' | 'success' | 'warning' | 'error'
