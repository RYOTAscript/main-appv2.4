import { app, BrowserWindow } from 'electron'
import * as path from 'path'
import { registerIpc } from './ipc'
import { ensureToolchain, onStateChange } from './ffmpeg'
import { initPipeline, pump } from './pipeline'
import { initEncoder } from './encode'
import { registerPreviewScheme, initPreviewProtocol } from './preview'
import { log } from './logger'

registerPreviewScheme()

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#07090d',
    autoHideMenuBar: true,
    title: 'valclips quality',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    log.info('app starting', { version: app.getVersion() })
    registerIpc()
    initPipeline()
    initEncoder()
    initPreviewProtocol()
    // jobs queued while FFmpeg was still installing start flowing once it's ready
    onStateChange((s) => {
      if (s.status === 'ready') void pump()
    })
    createWindow()
    // Kick off toolchain detection in the background; UI reflects live state.
    void ensureToolchain()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  process.on('uncaughtException', (err) => {
    log.error('uncaughtException', err.stack ?? String(err))
  })
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection', String(reason))
  })
}
