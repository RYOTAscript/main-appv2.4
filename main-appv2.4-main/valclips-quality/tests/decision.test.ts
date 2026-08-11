import { describe, expect, it } from 'vitest'
import {
  decide,
  remuxBlockers,
  classifyNoise,
  classifyMotion,
  orientedSpec,
  DEFAULT_TIKTOK_SPEC
} from '@shared/decision'
import type { Analysis, ProbeInfo, NoiseAnalysis } from '@shared/types'

// Fixture builder: a perfect TikTok upload, mutated per scenario.

function probe(over: DeepPartial<ProbeInfo> = {}): ProbeInfo {
  const base: ProbeInfo = {
    path: 'C:\\clips\\fixture.mp4',
    container: 'mov',
    durationSec: 20,
    sizeBytes: 40_000_000,
    overallBitrate: 16_000_000,
    video: {
      codec: 'h264',
      profile: 'High',
      width: 1080,
      height: 1920,
      rotation: 0,
      pixFmt: 'yuv420p',
      bitDepth: 8,
      fpsAverage: 60,
      fpsMode: 'cfr',
      frameIntervalJitterMs: 0.1,
      colorSpace: 'bt709',
      colorTransfer: 'bt709',
      colorPrimaries: 'bt709',
      isHdr: false,
      bitrate: 15_800_000
    },
    audio: { present: true, codec: 'aac', channels: 2, sampleRate: 48000, bitrate: 320000 }
  }
  return {
    ...base,
    ...over,
    video: { ...base.video, ...(over.video ?? {}) },
    audio: { ...base.audio, ...(over.audio ?? {}) }
  } as ProbeInfo
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] }

function noise(over: Partial<NoiseAnalysis> = {}): NoiseAnalysis {
  return {
    noiseLevel: 0.07,
    spatialNoise: 0.3,
    noiseClass: 'clean',
    motionLevel: 0.06,
    motionClass: 'high',
    ...over
  }
}

function analysis(p: ProbeInfo, n: NoiseAnalysis = noise()): Analysis {
  return { probe: p, noise: n, warnings: [] }
}

const settings = { outputMode: 'smart' as const, masterCrf: 12, vmafTarget: 97, loudnorm: true }

describe('decision engine — required fixtures', () => {
  it('already-optimal 1080×1920 H.264 clip → lossless remux, never re-encode', () => {
    const plan = decide(analysis(probe()), settings)
    expect(plan.mode).toBe('remux')
    expect(plan.reasons.join(' ')).toMatch(/zero quality loss/i)
  })

  it('VFR OBS recording → encode with CFR conversion', () => {
    const p = probe({ video: { fpsMode: 'vfr', fpsAverage: 59.4, frameIntervalJitterMs: 4.2 } })
    const plan = decide(analysis(p), settings)
    expect(plan.mode).toBe('encode')
    expect(plan.filters.fpsTarget).toBe(60)
    expect(plan.reasons.join(' ')).toMatch(/VFR/)
  })

  it('4K60 ShadowPlay clip → encode, downscale flagged as supersampling', () => {
    const p = probe({ video: { width: 2160, height: 3840, bitrate: 60_000_000 } })
    const plan = decide(analysis(p), settings)
    expect(plan.mode).toBe('encode')
    expect(plan.filters.scale).toEqual({ targetW: 1080, targetH: 1920, mode: 'none' })
    expect(plan.reasons.join(' ')).toMatch(/supersampling/i)
    expect(plan.filters.fpsTarget).toBe(60)
  })

  it('16:9 Premiere export (1920×1080) → fit with blurred pad, never stretch', () => {
    const p = probe({ video: { width: 1920, height: 1080 } })
    const plan = decide(analysis(p), settings)
    expect(plan.mode).toBe('encode')
    expect(plan.filters.scale?.mode).toBe('fit-pad')
    expect(plan.reasons.join(' ')).toMatch(/blurred background/i)
  })

  it('HDR clip → encode with BT.709 tone-map', () => {
    const p = probe({
      video: {
        pixFmt: 'yuv420p10le',
        bitDepth: 10,
        colorSpace: 'bt2020nc',
        colorTransfer: 'smpte2084',
        colorPrimaries: 'bt2020',
        isHdr: true
      }
    })
    const plan = decide(analysis(p), settings)
    expect(plan.mode).toBe('encode')
    expect(plan.filters.tonemapHdr).toBe(true)
  })

  it('grainy edit → encode with nlmeans denoising, conservative strength', () => {
    const p = probe()
    const plan = decide(analysis(p, noise({ noiseLevel: 0.58, noiseClass: 'heavy' })), settings)
    expect(plan.mode).toBe('encode')
    expect(plan.filters.denoiseFilter).toBe('nlmeans')
    expect(plan.filters.denoise).toBeGreaterThan(0)
    expect(plan.filters.denoise).toBeLessThanOrEqual(70)
  })

  it('24fps cinematic → encode targeting CFR 30 (not 60)', () => {
    const p = probe({ video: { fpsAverage: 24 } })
    const plan = decide(analysis(p), settings)
    expect(plan.mode).toBe('encode')
    expect(plan.filters.fpsTarget).toBe(30)
  })
})

describe('decision engine — edge behavior', () => {
  it('59.94 fps NTSC-style CFR clip still qualifies for remux', () => {
    const p = probe({ video: { fpsAverage: 59.94005994 } })
    expect(decide(analysis(p), settings).mode).toBe('remux')
  })

  it('rotation metadata blocks remux', () => {
    const p = probe({ video: { rotation: 90 } })
    const plan = decide(analysis(p), settings)
    expect(plan.mode).toBe('encode')
    expect(plan.filters.bakeRotation).toBe(true)
  })

  it('light grain → gentle hqdn3d, not nlmeans', () => {
    const plan = decide(analysis(probe(), noise({ noiseLevel: 0.5, noiseClass: 'light' })), settings)
    expect(plan.filters.denoiseFilter).toBe('hqdn3d')
    expect(plan.filters.denoise).toBeLessThanOrEqual(40)
  })

  it('clean clip → denoising fully off (never soften VFX)', () => {
    const plan = decide(
      analysis(probe({ video: { width: 1920, height: 1080 } })), // force encode path
      settings
    )
    expect(plan.filters.denoise).toBe(0)
    expect(plan.filters.denoiseFilter).toBe('none')
  })

  it('minterpolate is always off by default (interpolation smears flicks)', () => {
    const p = probe({ video: { fpsAverage: 24 } })
    expect(decide(analysis(p), settings).filters.minterpolate).toBe(false)
  })

  it('untagged color on an otherwise perfect clip is not a remux blocker', () => {
    const p = probe({ video: { colorSpace: '', colorTransfer: '', colorPrimaries: '' } })
    expect(remuxBlockers(analysis(p))).toEqual([])
  })

  it('explicit bt601 color tags block remux', () => {
    const p = probe({ video: { colorSpace: 'smpte170m' } })
    expect(remuxBlockers(analysis(p)).join(' ')).toMatch(/color space/)
  })

  it('starved bitrate blocks remux (already crushed upstream)', () => {
    const p = probe({ video: { bitrate: 900_000 }, overallBitrate: 1_000_000 })
    expect(remuxBlockers(analysis(p)).join(' ')).toMatch(/bitrate/)
  })

  it('no audio stream disables loudnorm in the plan', () => {
    const p = probe({ audio: { present: false } })
    const plan = decide(analysis(p), settings)
    expect(plan.encode.loudnorm).toBe(false)
  })
})

describe('keep-aspect mode (the default)', () => {
  const maintain = { ...settings, orientation: 'maintain' as const }

  it('perfect 1920×1080 landscape clip → lossless remux (no forced vertical)', () => {
    const p = probe({ video: { width: 1920, height: 1080 } })
    expect(decide(analysis(p), maintain).mode).toBe('remux')
  })

  it('perfect 1080×1920 vertical clip still remuxes', () => {
    expect(decide(analysis(probe()), maintain).mode).toBe('remux')
  })

  it('720p source is never upscaled — remux eligible', () => {
    const p = probe({ video: { width: 1280, height: 720 } })
    expect(decide(analysis(p), maintain).mode).toBe('remux')
  })

  it('4K 16:9 → downscaled to 1920×1080 keeping aspect, no padding', () => {
    const p = probe({ video: { width: 3840, height: 2160, bitrate: 60_000_000 } })
    const plan = decide(analysis(p), maintain)
    expect(plan.mode).toBe('encode')
    expect(plan.filters.scale).toEqual({ targetW: 1920, targetH: 1080, mode: 'none' })
    expect(plan.reasons.join(' ')).toMatch(/supersampling/i)
  })

  it('4K vertical → 1080×1920 keeping aspect', () => {
    const p = probe({ video: { width: 2160, height: 3840, bitrate: 60_000_000 } })
    const plan = decide(analysis(p), maintain)
    expect(plan.filters.scale).toEqual({ targetW: 1080, targetH: 1920, mode: 'none' })
  })

  it('odd aspect (4:3 2880×2160) keeps its shape when downscaled', () => {
    const p = probe({ video: { width: 2880, height: 2160, bitrate: 60_000_000 } })
    const plan = decide(analysis(p), maintain)
    expect(plan.filters.scale).toEqual({ targetW: 1440, targetH: 1080, mode: 'none' })
  })

  it('a VFR 16:9 clip encodes but keeps its aspect (scale stays null)', () => {
    const p = probe({ video: { width: 1920, height: 1080, fpsMode: 'vfr', frameIntervalJitterMs: 4 } })
    const plan = decide(analysis(p), maintain)
    expect(plan.mode).toBe('encode')
    expect(plan.filters.scale).toBeNull()
    expect(plan.reasons.join(' ')).toMatch(/no padding, no cropping/i)
  })
})

describe('output orientation (9:16 vs 16:9)', () => {
  const horizontal = orientedSpec(DEFAULT_TIKTOK_SPEC, 'horizontal')
  const vertical = orientedSpec(DEFAULT_TIKTOK_SPEC, 'vertical')

  it('orientedSpec swaps dimensions, vertical is the default shape', () => {
    expect(vertical).toMatchObject({ width: 1080, height: 1920 })
    expect(horizontal).toMatchObject({ width: 1920, height: 1080 })
    // fps/bitrate rules are untouched
    expect(horizontal.fpsHigh).toBe(DEFAULT_TIKTOK_SPEC.fpsHigh)
  })

  it('a perfect 1920×1080 clip remuxes in 16:9 mode but encodes in 9:16 mode', () => {
    const p = probe({ video: { width: 1920, height: 1080 } })
    expect(decide(analysis(p), settings, horizontal).mode).toBe('remux')
    expect(decide(analysis(p), settings, vertical).mode).toBe('encode')
  })

  it('a vertical source in 16:9 mode gets fit-pad to 1920×1080', () => {
    const p = probe() // 1080×1920
    const plan = decide(analysis(p), settings, horizontal)
    expect(plan.mode).toBe('encode')
    expect(plan.filters.scale).toEqual({ targetW: 1920, targetH: 1080, mode: 'fit-pad' })
  })

  it('4K 16:9 source in 16:9 mode is a plain supersampling downscale', () => {
    const p = probe({ video: { width: 3840, height: 2160, bitrate: 60_000_000 } })
    const plan = decide(analysis(p), settings, horizontal)
    expect(plan.filters.scale).toEqual({ targetW: 1920, targetH: 1080, mode: 'none' })
    expect(plan.reasons.join(' ')).toMatch(/supersampling/i)
  })
})

describe('classification thresholds (calibrated on tests/media fixtures)', () => {
  it('clean moving gameplay (~0.07 temporal) stays clean', () => {
    expect(classifyNoise(0.07, 0.3)).toBe('clean')
  })
  it('barely-visible noise stays clean — when in doubt, denoise less', () => {
    expect(classifyNoise(0.14, 0.25)).toBe('clean')
  })
  it('moderate dancing grain classifies light', () => {
    expect(classifyNoise(0.3, 0.4)).toBe('light')
  })
  it('grain overlay (~0.9 temporal, ~0.8 spatial) classifies heavy', () => {
    expect(classifyNoise(0.91, 0.79)).toBe('heavy')
  })
  it('violent motion without full-frame spatial grain can never be heavy', () => {
    expect(classifyNoise(0.6, 0.2)).toBe('light')
  })
  it('classifies motion', () => {
    expect(classifyMotion(0.005)).toBe('low')
    expect(classifyMotion(0.06)).toBe('high')
  })
})
