import { describe, expect, it } from 'vitest'
import { isSupportedVideo, extensionOf } from '@shared/formats'

describe('input format acceptance', () => {
  it('accepts the supported set', () => {
    for (const f of ['a.mp4', 'b.MOV', 'c.mkv', 'd.avi', 'e.webm', 'f.m4v']) {
      expect(isSupportedVideo(f), f).toBe(true)
    }
  })

  it('rejects everything else', () => {
    for (const f of ['a.gif', 'b.png', 'c.txt', 'd.wmv', 'e.flv', 'noext', 'weird.mp41']) {
      expect(isSupportedVideo(f), f).toBe(false)
    }
  })

  it('extracts extensions from full Windows paths', () => {
    expect(extensionOf('C:\\Users\\me\\Videos\\clip.MP4')).toBe('.mp4')
    expect(isSupportedVideo('C:\\Users\\me\\Videos\\clip.MP4')).toBe(true)
  })

  it('does not treat a dotfile prefix as extension', () => {
    expect(extensionOf('.hidden')).toBe('')
  })
})
