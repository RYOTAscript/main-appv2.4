import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'
import { atomicWriteFile } from './atomic'
import { log } from './logger'

let cached: AppSettings | null = null

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

export function getSettings(): AppSettings {
  if (cached) return cached
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    cached = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      // deep-merge so a hand-edited spec with missing keys still works
      tiktokSpec: { ...DEFAULT_SETTINGS.tiktokSpec, ...(parsed.tiktokSpec ?? {}) }
    }
  } catch {
    cached = { ...DEFAULT_SETTINGS }
  }
  return cached
}

export function settingsFilePath(): string {
  return settingsPath()
}

/** Ensure the settings file exists on disk so "Open settings file" has a target. */
export async function ensureSettingsFile(): Promise<void> {
  if (!fs.existsSync(settingsPath())) {
    await atomicWriteFile(settingsPath(), JSON.stringify(getSettings(), null, 2))
  }
}

export async function setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...getSettings(), ...patch }
  // clamp user-editable values so a bad JSON edit can't break encodes
  next.masterCrf = Math.min(16, Math.max(10, Math.round(next.masterCrf)))
  next.vmafTarget = Math.min(99, Math.max(80, next.vmafTarget))
  if (!['maintain', 'vertical', 'horizontal'].includes(next.orientation)) next.orientation = 'maintain'
  cached = next
  try {
    await atomicWriteFile(settingsPath(), JSON.stringify(next, null, 2))
  } catch (err) {
    log.error('failed to save settings', String(err))
    throw err
  }
  return next
}
