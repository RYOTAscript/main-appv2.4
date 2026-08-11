import { describe, expect, it } from 'vitest'
import { outputPathFor, stripOutputSuffix } from '@shared/naming'

describe('output naming', () => {
  it('writes <name>_output.mp4 next to the source', () => {
    expect(outputPathFor('C:\\clips\\ace.mp4')).toBe('C:\\clips\\ace_output.mp4')
  })

  it('strips an existing _output suffix so re-processing does not stack', () => {
    expect(outputPathFor('C:\\clips\\ace_output.mp4')).toBe('C:\\clips\\ace_output.mp4')
    expect(outputPathFor('C:\\clips\\ace_output_output.mp4')).toBe('C:\\clips\\ace_output.mp4')
  })

  it('is case-insensitive about the suffix', () => {
    expect(outputPathFor('C:\\clips\\ace_OUTPUT.mp4')).toBe('C:\\clips\\ace_output.mp4')
  })

  it('handles names that are only _output', () => {
    // stripping would leave an empty name — keep the original base instead
    expect(stripOutputSuffix('_output')).toBe('_output')
  })

  it('always outputs .mp4 regardless of input container', () => {
    expect(outputPathFor('C:\\clips\\raw.mkv')).toBe('C:\\clips\\raw_output.mp4')
    expect(outputPathFor('C:\\clips\\raw.webm')).toBe('C:\\clips\\raw_output.mp4')
  })

  it('supports forward-slash paths', () => {
    expect(outputPathFor('/home/user/ace.mp4')).toBe('/home/user/ace_output.mp4')
  })

  it('applies a custom template', () => {
    expect(outputPathFor('C:\\c\\ace.mp4', { template: '{name}_tiktok' })).toBe('C:\\c\\ace_tiktok.mp4')
  })

  it('falls back to default template when {name} is missing', () => {
    expect(outputPathFor('C:\\c\\ace.mp4', { template: 'broken' })).toBe('C:\\c\\ace_output.mp4')
  })

  it('redirects to a custom output folder', () => {
    expect(outputPathFor('C:\\c\\ace.mp4', { outputFolder: 'D:\\exports' })).toBe(
      'D:\\exports\\ace_output.mp4'
    )
  })

  it('strips characters Windows cannot store in filenames', () => {
    expect(outputPathFor('C:\\c\\ace.mp4', { template: '{name}:v2?' })).toBe('C:\\c\\acev2.mp4')
  })

  it('handles dotfiles and extensionless names', () => {
    expect(outputPathFor('C:\\c\\clip')).toBe('C:\\c\\clip_output.mp4')
  })
})
