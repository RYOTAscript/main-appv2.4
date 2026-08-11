import { describe, expect, it } from 'vitest'
import {
  X264_HIGH_MOTION_PARAMS,
  audioFilterString,
  buildEncodeArgs,
  nextCrf,
  finalCrf,
  SMART_CRF_START
} from '@shared/encodeArgs'

describe('x264 high-motion tuning', () => {
  it('contains every parameter from the spec', () => {
    for (const p of [
      'ref=6', 'bframes=5', 'b-adapt=2', 'me=umh', 'subme=10', 'merange=32',
      'rc-lookahead=60', 'aq-mode=3', 'aq-strength=1.0', 'psy-rd=1.0,0.15',
      'deblock=-1,-1', 'keyint=120', 'min-keyint=60'
    ]) {
      expect(X264_HIGH_MOTION_PARAMS).toContain(p)
    }
  })
  it('writes BT.709 VUI into the bitstream', () => {
    expect(X264_HIGH_MOTION_PARAMS).toContain('colorprim=bt709')
    expect(X264_HIGH_MOTION_PARAMS).toContain('transfer=bt709')
    expect(X264_HIGH_MOTION_PARAMS).toContain('colormatrix=bt709')
  })
})

describe('buildEncodeArgs', () => {
  const base = {
    inputPath: 'in.mp4',
    filterGraph: '[0:v]fps=60[vout]',
    crf: 12,
    preset: 'veryslow',
    hasAudio: true,
    loudnorm: null,
    outputPath: 'out.mp4'
  }

  it('produces the full master-quality arg set', () => {
    const args = buildEncodeArgs(base).join(' ')
    expect(args).toContain('-c:v libx264')
    expect(args).toContain('-preset veryslow')
    expect(args).toContain('-crf 12')
    expect(args).toContain('-profile:v high')
    expect(args).toContain('-level 4.2')
    expect(args).toContain('-pix_fmt yuv420p')
    expect(args).toContain('-movflags +faststart')
    expect(args).toContain('-colorspace bt709')
    expect(args).toContain('-color_range tv')
    expect(args).toContain('-c:a aac')
    expect(args).toContain('-b:a 320k')
    expect(args).toContain('-ar 48000')
    expect(args).toContain('-ac 2')
    expect(args).toContain('-progress pipe:1')
  })

  it('maps [vout] when filtering, 0:v:0 otherwise', () => {
    expect(buildEncodeArgs(base).join(' ')).toContain('-map [vout]')
    const plain = buildEncodeArgs({ ...base, filterGraph: null }).join(' ')
    expect(plain).toContain('-map 0:v:0')
    expect(plain).not.toContain('-filter_complex')
  })

  it('silent clips get -an and no audio filter', () => {
    const args = buildEncodeArgs({ ...base, hasAudio: false }).join(' ')
    expect(args).toContain('-an')
    expect(args).not.toContain('-c:a')
    expect(args).not.toContain('aresample')
  })

  it('audio sync repair is always present; loudnorm only with measurements', () => {
    expect(audioFilterString(null)).toBe('aresample=async=1:first_pts=0')
    const ln = audioFilterString({
      input_i: '-9.2', input_tp: '-0.3', input_lra: '6.1',
      input_thresh: '-19.5', target_offset: '0.4'
    })
    expect(ln).toContain('aresample=async=1')
    expect(ln).toContain('loudnorm=I=-14:TP=-1:LRA=11:measured_I=-9.2')
    expect(ln).toContain('linear=true')
  })
})

describe('Smart Compress CRF search', () => {
  const target = 97

  it('starts at CRF 18', () => {
    expect(nextCrf([], target)).toBe(SMART_CRF_START)
  })

  it('goes smaller-file (higher CRF) when quality passes', () => {
    const next = nextCrf([{ crf: 18, vmaf: 98.5 }], target)
    expect(next).toBeGreaterThan(18)
  })

  it('goes higher-quality (lower CRF) when quality fails', () => {
    const next = nextCrf([{ crf: 18, vmaf: 95.1 }], target)
    expect(next).toBeLessThan(18)
  })

  it('converges and stops within the attempt budget', () => {
    // simulate: true quality boundary at CRF 21
    const tried: { crf: number; vmaf: number }[] = []
    let crf = nextCrf(tried, target)
    while (crf !== null) {
      tried.push({ crf, vmaf: crf <= 21 ? 97.5 : 96.2 })
      crf = nextCrf(tried, target)
    }
    expect(tried.length).toBeLessThanOrEqual(4)
    expect(finalCrf(tried, target)).toBe(21)
  })

  it('falls back to the lowest tried CRF when nothing passes', () => {
    const tried = [
      { crf: 18, vmaf: 92 },
      { crf: 13, vmaf: 94 },
      { crf: 11, vmaf: 95 }
    ]
    expect(finalCrf(tried, target)).toBe(11)
  })

  it('never proposes a CRF outside sane bounds', () => {
    const allFail: { crf: number; vmaf: number }[] = []
    let crf = nextCrf(allFail, target)
    while (crf !== null) {
      expect(crf).toBeGreaterThanOrEqual(10)
      expect(crf).toBeLessThanOrEqual(28)
      allFail.push({ crf, vmaf: 50 })
      crf = nextCrf(allFail, target)
    }
  })
})
