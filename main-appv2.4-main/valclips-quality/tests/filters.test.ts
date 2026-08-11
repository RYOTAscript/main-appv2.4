import { describe, expect, it } from 'vitest'
import {
  applyOverrides,
  buildAudioChain,
  buildVideoChain,
  hqdn3dParams,
  nlmeansParams
} from '@shared/filters'
import { neutralFilters } from '@shared/decision'
import type { FilterPlan, Plan, ProbeInfo } from '@shared/types'

const probe = { video: { width: 1920, height: 1080 } } as unknown as ProbeInfo

function filters(over: Partial<FilterPlan> = {}): FilterPlan {
  return { ...neutralFilters(), ...over }
}

describe('denoise parameter mapping', () => {
  it('scales hqdn3d from defaults, capped at 2×', () => {
    expect(hqdn3dParams(50)).toBe('hqdn3d=4:3:6:4.5')
    expect(hqdn3dParams(25)).toBe('hqdn3d=2:1.5:3:2.3')
    expect(hqdn3dParams(100)).toBe('hqdn3d=8:6:12:9')
    expect(hqdn3dParams(150)).toBe('hqdn3d=8:6:12:9') // clamped
  })
  it('maps nlmeans strength 1..8', () => {
    expect(nlmeansParams(0)).toBe('nlmeans=s=1:p=7:r=15')
    expect(nlmeansParams(60)).toBe('nlmeans=s=5.2:p=7:r=15')
    expect(nlmeansParams(100)).toBe('nlmeans=s=8:p=7:r=15')
  })
})

describe('video chain builder', () => {
  it('neutral plan still normalizes format and SAR', () => {
    const { graph } = buildVideoChain(filters(), probe)
    expect(graph).toContain('format=yuv420p')
    expect(graph).toContain('setsar=1')
    expect(graph).toMatch(/^\[0:v\].*\[vout\]$/)
  })

  it('plain 9:16 downscale uses lanczos', () => {
    const { graph } = buildVideoChain(
      filters({ scale: { targetW: 1080, targetH: 1920, mode: 'none' } }),
      probe
    )
    expect(graph).toContain('scale=1080:1920:flags=lanczos')
  })

  it('fit-pad builds the blurred-background split/overlay graph', () => {
    const { graph, outLabel } = buildVideoChain(
      filters({ scale: { targetW: 1080, targetH: 1920, mode: 'fit-pad' } }),
      probe
    )
    expect(graph).toContain('split=2[bg][fg]')
    expect(graph).toContain('force_original_aspect_ratio=increase')
    expect(graph).toContain('gblur')
    expect(graph).toContain('force_original_aspect_ratio=decrease:flags=lanczos')
    expect(graph).toContain('overlay=(W-w)/2:(H-h)/2')
    expect(outLabel).toBe('vout')
  })

  it('fill-crop scales up then crops, never stretches', () => {
    const { graph } = buildVideoChain(
      filters({ scale: { targetW: 1080, targetH: 1920, mode: 'fill-crop' } }),
      probe
    )
    expect(graph).toContain('force_original_aspect_ratio=increase:flags=lanczos')
    expect(graph).toContain('crop=1080:1920')
  })

  it('CFR conversion uses the fps filter (never input -r)', () => {
    const { graph } = buildVideoChain(filters({ fpsTarget: 60 }), probe)
    expect(graph).toContain('fps=60')
    expect(graph).not.toContain('minterpolate')
  })

  it('minterpolate replaces fps when explicitly enabled', () => {
    const { graph } = buildVideoChain(filters({ fpsTarget: 60, minterpolate: true }), probe)
    expect(graph).toContain('minterpolate=fps=60')
  })

  it('HDR tone-map comes before everything else', () => {
    const { graph } = buildVideoChain(filters({ tonemapHdr: true, denoise: 30, denoiseFilter: 'hqdn3d' }), probe)
    expect(graph.indexOf('tonemap')).toBeGreaterThan(-1)
    expect(graph.indexOf('zscale=t=linear')).toBeLessThan(graph.indexOf('hqdn3d'))
  })

  it('denoise runs before scaling, sharpen after', () => {
    const { graph } = buildVideoChain(
      filters({
        denoise: 30,
        denoiseFilter: 'hqdn3d',
        scale: { targetW: 1080, targetH: 1920, mode: 'none' },
        sharpen: 0.3
      }),
      probe
    )
    expect(graph.indexOf('hqdn3d')).toBeLessThan(graph.indexOf('scale='))
    expect(graph.indexOf('scale=')).toBeLessThan(graph.indexOf('unsharp'))
  })

  it('sharpen is luma-only and clamped to 0.8', () => {
    const { graph } = buildVideoChain(filters({ sharpen: 2 }), probe)
    expect(graph).toContain('unsharp=5:5:0.80:5:5:0')
  })

  it('preview mode appends a display downscale at the very end', () => {
    const { graph } = buildVideoChain(filters({ sharpen: 0.3 }), probe, { previewHeight: 960 })
    expect(graph.indexOf('scale=-2:960')).toBeGreaterThan(graph.indexOf('unsharp'))
  })
})

describe('audio chain & overrides', () => {
  it('audio uses aresample async sync repair', () => {
    expect(buildAudioChain()).toBe('aresample=async=1:first_pts=0')
  })

  it('applyOverrides merges sliders and resolves denoise filter implications', () => {
    const plan: Plan = {
      mode: 'encode',
      reasons: [],
      filters: filters(),
      encode: { outputMode: 'smart', crf: 12, vmafTarget: 97, preset: 'veryslow', loudnorm: true }
    }
    const withDenoise = applyOverrides(plan, { denoise: 40 })
    expect(withDenoise.filters.denoiseFilter).toBe('hqdn3d')
    const disabled = applyOverrides(plan, { denoise: 0, denoiseFilter: 'nlmeans' })
    expect(disabled.filters.denoiseFilter).toBe('none')
    expect(applyOverrides(plan, null)).toBe(plan)
  })
})
