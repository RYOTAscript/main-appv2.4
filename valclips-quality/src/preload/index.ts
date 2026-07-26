import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AddFilesResult,
  AppSettings,
  FFmpegState,
  FilterPlan,
  Job
} from '../shared/types'

// Typed IPC bridge. The renderer only ever sees this `vq` API — no Node access.

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  // File objects from drag-and-drop can only be resolved to disk paths in the
  // preload context (webUtils) — renderer sends the File, gets the path back.
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  ffmpeg: {
    state: (): Promise<FFmpegState> => ipcRenderer.invoke('ffmpeg:state'),
    setup: (): Promise<FFmpegState> => ipcRenderer.invoke('ffmpeg:setup'),
    recheck: (): Promise<FFmpegState> => ipcRenderer.invoke('ffmpeg:recheck'),
    onState: (cb: (s: FFmpegState) => void): (() => void) => on('ffmpeg:state', cb)
  },

  files: {
    add: (paths: string[], overwriteConfirmed = false): Promise<AddFilesResult> =>
      ipcRenderer.invoke('files:add', paths, overwriteConfirmed),
    openDialog: (): Promise<AddFilesResult | null> => ipcRenderer.invoke('files:openDialog')
  },

  jobs: {
    list: (): Promise<Job[]> => ipcRenderer.invoke('jobs:list'),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('jobs:remove', id),
    clearFinished: (): Promise<void> => ipcRenderer.invoke('jobs:clearFinished'),
    setOverrides: (id: string, overrides: Partial<FilterPlan> | null): Promise<void> =>
      ipcRenderer.invoke('jobs:setOverrides', id, overrides),
    requeue: (id: string): Promise<void> => ipcRenderer.invoke('jobs:requeue', id),
    cancel: (id: string): Promise<void> => ipcRenderer.invoke('jobs:cancel', id),
    onChanged: (cb: (jobs: Job[]) => void): (() => void) => on('jobs:changed', cb)
  },

  preview: {
    generate: (
      id: string,
      overrides: Partial<FilterPlan> | null
    ): Promise<{ beforeUrl: string; afterUrl: string }> =>
      ipcRenderer.invoke('preview:generate', id, overrides),
    compare: (
      id: string,
      timeSec: number
    ): Promise<{ expectedUrl: string; actualUrl: string; fps: number }> =>
      ipcRenderer.invoke('compare:generate', id, timeSec)
  },

  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:set', patch),
    pickOutputFolder: (): Promise<AppSettings> => ipcRenderer.invoke('settings:pickOutputFolder')
  },

  shell: {
    showInFolder: (p: string): Promise<void> => ipcRenderer.invoke('shell:showInFolder', p),
    openLog: (): Promise<void> => ipcRenderer.invoke('shell:openLog'),
    openSettingsFile: (): Promise<void> => ipcRenderer.invoke('shell:openSettingsFile')
  },

  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version')
}

export type VqApi = typeof api

contextBridge.exposeInMainWorld('vq', api)
