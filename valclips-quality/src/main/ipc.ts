import { app, dialog, ipcMain, shell, BrowserWindow } from 'electron'
import type { AppSettings, FilterPlan } from '@shared/types'
import * as ffmpeg from './ffmpeg'
import * as jobsStore from './jobs'
import { cancelJob } from './encode'
import { generatePreview, generateComparison } from './preview'
import { ensureSettingsFile, getSettings, setSettings, settingsFilePath } from './settings'
import { log, logFilePath } from './logger'
import { SUPPORTED_EXTENSIONS } from '@shared/formats'

// All IPC surface in one place. handle() wraps every handler so any thrown
// error is logged and returned as a readable message instead of a renderer
// promise rejection with no context.

function handle<T>(channel: string, fn: (...args: never[]) => T | Promise<T>): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...(args as never[]))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error(`ipc ${channel} failed`, msg)
      throw new Error(msg)
    }
  })
}

export function registerIpc(): void {
  // --- toolchain ---
  handle('ffmpeg:state', () => ffmpeg.getState())
  handle('ffmpeg:setup', () => ffmpeg.setupToolchain())
  handle('ffmpeg:recheck', () => ffmpeg.ensureToolchain())
  ffmpeg.onStateChange((s) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('ffmpeg:state', s)
  })

  // --- files & queue ---
  handle('files:add', (paths: string[], overwriteConfirmed: boolean) =>
    jobsStore.addInputs(paths, { overwriteConfirmed })
  )
  handle('files:openDialog', async () => {
    const win = BrowserWindow.getAllWindows()[0]
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose Valorant clips',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Videos', extensions: SUPPORTED_EXTENSIONS.map((e) => e.slice(1)) },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return jobsStore.addInputs(res.filePaths)
  })
  handle('jobs:list', () => jobsStore.listJobs())
  handle('jobs:remove', (id: string) => jobsStore.removeJob(id))
  handle('jobs:clearFinished', () => jobsStore.clearFinished())
  handle('jobs:setOverrides', (id: string, overrides: Partial<FilterPlan> | null) => {
    jobsStore.updateJob(id, { overrides })
  })
  handle('jobs:cancel', (id: string) => {
    const job = jobsStore.getJob(id)
    if (!job) return
    if (job.status === 'queued') {
      jobsStore.updateJob(id, { status: 'cancelled', note: 'Cancelled before start' })
    } else {
      cancelJob(id)
    }
  })
  handle('jobs:requeue', (id: string) => {
    const job = jobsStore.getJob(id)
    if (!job) throw new Error('Job no longer exists')
    if (['analyzing', 'processing', 'verifying'].includes(job.status))
      throw new Error('Job is still running')
    jobsStore.updateJob(id, {
      status: 'queued',
      note: 'Re-queued with new settings',
      result: null,
      error: null,
      progress: null
    })
    void jobsStore.pump()
  })

  // --- previews ---
  handle('preview:generate', (id: string, overrides: Partial<FilterPlan> | null) => {
    const job = jobsStore.getJob(id)
    if (!job) throw new Error('Job no longer exists')
    return generatePreview(job, overrides)
  })
  handle('compare:generate', (id: string, timeSec: number) => {
    const job = jobsStore.getJob(id)
    if (!job) throw new Error('Job no longer exists')
    return generateComparison(job, timeSec)
  })

  // --- settings ---
  handle('settings:get', () => getSettings())
  handle('settings:set', (patch: Partial<AppSettings>) => setSettings(patch))

  // --- misc ---
  handle('shell:showInFolder', (p: string) => shell.showItemInFolder(p))
  handle('shell:openLog', () => shell.openPath(logFilePath()))
  handle('shell:openSettingsFile', async () => {
    await ensureSettingsFile()
    await shell.openPath(settingsFilePath())
  })
  handle('settings:pickOutputFolder', async () => {
    const win = BrowserWindow.getAllWindows()[0]
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose output folder (cancel = next to source)',
      properties: ['openDirectory']
    })
    if (res.canceled || res.filePaths.length === 0) return getSettings()
    return setSettings({ outputFolder: res.filePaths[0] })
  })
  handle('app:version', () => app.getVersion())
}
