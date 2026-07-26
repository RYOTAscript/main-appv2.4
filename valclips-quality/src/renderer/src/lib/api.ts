import { useEffect, useState } from 'react'
import type { AppSettings, FFmpegState, Job } from '@shared/types'
import type { VqApi } from '../../../preload/index'

declare global {
  interface Window {
    vq: VqApi
  }
}

export const vq = window.vq

// ---------- live-state hooks ----------

export function useFFmpegState(): FFmpegState {
  const [state, setState] = useState<FFmpegState>({ status: 'checking' })
  useEffect(() => {
    let alive = true
    void vq.ffmpeg.state().then((s) => alive && setState(s))
    const off = vq.ffmpeg.onState((s) => alive && setState(s))
    return () => {
      alive = false
      off()
    }
  }, [])
  return state
}

export function useJobs(): Job[] {
  const [jobs, setJobs] = useState<Job[]>([])
  useEffect(() => {
    let alive = true
    void vq.jobs.list().then((j) => alive && setJobs([...j]))
    const off = vq.jobs.onChanged((j) => alive && setJobs([...j]))
    return () => {
      alive = false
      off()
    }
  }, [])
  return jobs
}

export function useSettings(): [AppSettings | null, (patch: Partial<AppSettings>) => void] {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  useEffect(() => {
    void vq.settings.get().then(setSettings)
  }, [])
  const update = (patch: Partial<AppSettings>): void => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev))
    void vq.settings.set(patch).then(setSettings)
  }
  return [settings, update]
}

// ---------- formatting helpers ----------

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—'
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}
