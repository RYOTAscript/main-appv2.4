const { app, BrowserWindow, shell, ipcMain, globalShortcut, Menu, Tray, session, desktopCapturer, crashReporter } = require('electron');
const path = require('path');
const fs = require('fs');
const Logger = require('./logger');

const autostart = require('./main/autostart');
const systemStats = require('./main/systemStats');
const appLauncher = require('./main/appLauncher');
const fpsOptimizer = require('./main/fpsOptimizer');
const micMute = require('./main/micMute');
const spotify = require('./main/spotify');
const lyrics = require('./main/lyrics');
const weather = require('./main/weather');
const displaySettings = require('./main/displaySettings');
const macros = require('./main/macros');
const clipboardHistory = require('./main/clipboard');
const screenResolution = require('./main/screenResolution');

app.setAppUserModelId('com.launcher.app');
const APP_VERSION = 'v3.12.0';

// ── Crash handling (this is what removes the Windows "System Error" dialog) ──
// The renderer very occasionally dies with STATUS_STACK_BUFFER_OVERRUN (0xC0000409)
// — an intermittent low-level Chromium/Windows fault (seen since v2.3.0, unaffected
// by GPU mode or JIT). The reason a *Windows* error dialog appeared for it is that
// the app never initialised Electron's own crash handler, so Windows Error Reporting
// took over the crash and showed its modal dialog. Starting the crashReporter installs
// Chromium's Crashpad handler (including its WER runtime-exception module, which
// specifically catches __fastfail/stack-protection crashes), so the crash is handled
// silently in-process instead of by Windows. Combined with the auto-reload in
// createWindow(), an occasional renderer blip becomes invisible and self-healing.
// uploadToServer:false keeps everything local — nothing is sent anywhere.
try {
  crashReporter.start({
    productName: 'Launcher',
    companyName: 'launcher',
    submitURL: '',
    uploadToServer: false,
    compress: true
  });
} catch (e) {
  // Never let crash-reporter setup itself prevent startup.
  console.error('crashReporter.start failed:', e && e.message);
}

// ── Windows renderer stability ──
// Keep RendererCodeIntegrity disabled (pre-existing) to avoid unsigned-DLL load
// conflicts in the renderer on some Windows setups. NOTE: earlier attempts to stop
// the intermittent STATUS_STACK_BUFFER_OVERRUN via GPU mode (v2.5.0) and V8 --jitless
// (v2.5.1) did NOT work — the crash happens with hardware acceleration on OR off and
// with the JIT on OR off, so it is neither the GPU nor V8's JIT. It is now handled at
// the crash-handler level instead (see crashReporter.start above + the render-process
// auto-reload in createWindow), which suppresses the Windows dialog and self-heals.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'RendererCodeIntegrity');
}

const userDataPath = path.join(app.getPath('appData'), 'main-launcher');
app.setPath('userData', userDataPath);

// ── Graphics mode (optional override) ──
// Hardware acceleration is ON by default. The GPU was NOT the cause of the
// STATUS_STACK_BUFFER_OVERRUN crash (that's CET vs V8's JIT — fixed above with
// --jitless), and turning the GPU off only made the UI laggy without helping.
// This tiny graphics-config.json remains available so we can still switch modes
// WITHOUT editing code if a future GPU-specific issue ever appears:
//   { "mode": "gpu" }       -> full GPU acceleration      (default, smoothest)
//   { "mode": "angle-gl" }  -> keep the GPU, via ANGLE/OpenGL
//   { "mode": "no-accel" }  -> hardware acceleration OFF   (CPU rendering, laggier)
const GRAPHICS_CONFIG_PATH = path.join(userDataPath, 'graphics-config.json');
function getGraphicsMode() {
  try {
    if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });
    if (fs.existsSync(GRAPHICS_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(GRAPHICS_CONFIG_PATH, 'utf8'));
      if (['no-accel', 'angle-gl', 'gpu'].includes(raw.mode)) return raw.mode;
    } else {
      // Seed the file so the option is discoverable.
      fs.writeFileSync(GRAPHICS_CONFIG_PATH, JSON.stringify({ mode: 'gpu' }, null, 2), 'utf8');
    }
  } catch (e) { /* fall through to default */ }
  return 'gpu';
}
const graphicsMode = getGraphicsMode();
if (graphicsMode === 'no-accel') {
  app.disableHardwareAcceleration();
} else if (graphicsMode === 'angle-gl') {
  app.commandLine.appendSwitch('use-angle', 'gl');
}

const cachePath = path.join(userDataPath, 'Cache');
const gpuCachePath = path.join(userDataPath, 'GPUCache');
const logsPath = path.join(userDataPath, 'logs');

for (const dir of [userDataPath, cachePath, gpuCachePath, logsPath]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
app.commandLine.appendSwitch('disk-cache-dir', cachePath);

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {

  const logger = new Logger(logsPath, APP_VERSION);
  logger.attachProcessHandlers();
  logger.startupBanner();
  logger.system('Graphics mode', { graphicsMode, hint: 'change via graphics-config.json (no-accel | angle-gl | gpu)' });

  function verifyFeatures() {
    const iconsFolder = path.join(__dirname, 'icons');
    if (fs.existsSync(iconsFolder)) logger.success('Icons folder found', { path: iconsFolder });
    else logger.warn('Icons folder missing', { path: iconsFolder });
  }

  let mainWindow;
  let mainAppPID = null;
  let appTray = null;
  let focusHotkey = 'Control+Alt+M';
  let micModule = null;
  let spotifyModule = null;
  let macrosModule = null;

  function registerFocusHotkey(accelerator) {
    if (!accelerator || typeof accelerator !== 'string' || accelerator === '-') return false;
    if (focusHotkey) globalShortcut.unregister(focusHotkey);
    if (!globalShortcut.register(accelerator, focusMainWindow)) {
      if (focusHotkey) globalShortcut.register(focusHotkey, focusMainWindow);
      return false;
    }
    focusHotkey = accelerator;
    return true;
  }

  // Releases the focus hotkey entirely — used when another hotkey category (e.g.
  // mic-mute) wins a rebind conflict against it, so the OS-level accelerator is
  // actually freed instead of staying registered and silently winning it back on
  // the next enable-all-hotkeys cycle (globalShortcut.register lets the most
  // recent register() call for a given accelerator win within the same app).
  function unregisterFocusHotkey() {
    if (focusHotkey) globalShortcut.unregister(focusHotkey);
    focusHotkey = null;
  }

  function createWindow() {
    const windowWidth = 920;
    const windowHeight = 640;
    const { x, y } = displaySettings.getWindowPosition(userDataPath, windowWidth, windowHeight, logger);
    mainWindow = new BrowserWindow({
      width: windowWidth,
      height: windowHeight,
      x,
      y,
      frame: false,
      transparent: true,
      resizable: false,
      roundedCorners: true,
      hasShadow: true,
      backgroundColor: '#00000000',
      icon: path.join(__dirname, 'icons', 'main.ico'),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js')
      }
    });

    logger.attachWindow(mainWindow);

    // ── Self-healing renderer ──
    // The renderer can occasionally die (intermittent STATUS_STACK_BUFFER_OVERRUN —
    // a low-level Chromium/Windows fault we can't fully prevent). Instead of leaving
    // a dead/blank window, reload it automatically so the app recovers on its own.
    // A short-window rate limit prevents an infinite reload storm if it ever crashes
    // continuously.
    let rendererCrashTimes = [];
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      if (!details || details.reason === 'clean-exit' || details.reason === 'killed') return;
      const now = Date.now();
      rendererCrashTimes = rendererCrashTimes.filter((t) => now - t < 60000);
      rendererCrashTimes.push(now);
      // If the crash is persistent (e.g. the unresolved CET/shadow-stack fault),
      // reloading just re-crashes and spams the dialog — so stop after 2 tries in a
      // minute and leave the window as-is rather than looping.
      if (rendererCrashTimes.length > 2) {
        logger.error('Renderer crashed repeatedly in a short window — not auto-reloading again (apply the CET fix; see Fix-Crash.cmd)', null, details);
        return;
      }
      logger.warn('Renderer crashed — auto-reloading to recover', details);
      setTimeout(() => {
        try {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadFile('main.html');
        } catch (e) {
          logger.error('Renderer auto-reload failed', e);
        }
      }, 300);
    });

    // The mic-mute overlay is a second, always-alive BrowserWindow, so Electron's
    // 'window-all-closed' event never fires from closing just the main window --
    // it only fires once every window (including the hidden overlay) is gone. Quit
    // explicitly here so closing the main window always closes the whole app.
    mainWindow.on('closed', () => {
      mainWindow = null;
      app.quit();
    });

    mainWindow.loadFile('main.html');
    mainWindow.show();

    // Store main app PID for process protection. The renderer process hasn't
    // spawned yet at this point (getOSProcessId() returns 0 until it has), so
    // capture the real PID once the page loads — and re-capture on every load,
    // since a crash auto-reload gives the renderer a new PID.
    mainWindow.webContents.on('did-finish-load', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainAppPID = mainWindow.webContents.getOSProcessId();
        logger.debug('Main app renderer PID captured', { mainAppPID });
      }
    });
    logger.success('Main window created');
  }

  function buildTrayMenu() {
    return Menu.buildFromTemplate([
      { label: 'Show main', type: 'normal', click: () => { focusMainWindow(); } },
      { label: 'Mute Microphone', type: 'checkbox', checked: micModule ? micModule.isMuted() : false, click: () => { micModule?.toggle(); } },
      { label: 'Quit', type: 'normal', click: () => { app.quit(); } }
    ]);
  }

  function createTray() {
    if (appTray) return;

    const trayIcon = path.join(__dirname, 'icons', 'main.ico');
    appTray = new Tray(trayIcon);
    appTray.setToolTip('main launcher');
    appTray.setContextMenu(buildTrayMenu());
    appTray.on('double-click', () => focusMainWindow());
    logger.success('System tray icon created');
  }

  function focusMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    logger.log('Window focused via hotkey', 'INFO');
  }

  const ctx = {
    logger,
    userDataPath,
    appRoot: __dirname,
    APP_VERSION,
    getMainWindow: () => mainWindow,
    getMainAppPID: () => mainAppPID,
    focusMainWindow,
    refreshTrayMenu: () => { if (appTray) appTray.setContextMenu(buildTrayMenu()); }
  };

  app.whenReady().then(() => {
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        if (!sources.length) {
          callback({});
          return;
        }
        callback({ video: sources[0], audio: 'loopback' });
      } catch (e) {
        logger.warn('System audio capture handler failed', e);
        callback({});
      }
    });

    verifyFeatures();
    createWindow();

    micModule = micMute.init(ctx);
    spotifyModule = spotify.init(ctx);
    autostart.init(ctx);
    systemStats.init(ctx);
    appLauncher.init(ctx);
    fpsOptimizer.init(ctx);
    lyrics.init(ctx);
    weather.init(ctx);
    displaySettings.init(ctx);
    macrosModule = macros.init(ctx);
    clipboardHistory.init(ctx);
    screenResolution.init(ctx);

    createTray();
    registerFocusHotkey(focusHotkey);
    logger.success('Focus hotkey registered', { accelerator: focusHotkey });
  });

  app.on('second-instance', () => focusMainWindow());

  app.on('web-contents-created', (event, contents) => {
    // Close any windows that aren't the main window (like the Electron welcome page)
    if (mainWindow && contents.id !== mainWindow.webContents.id) {
      const window = BrowserWindow.fromWebContents(contents);
      if (window) window.close();
    }
  });

  app.on('window-all-closed', () => {
    logger.system('All windows closed — quitting');
    if (process.platform !== 'darwin') app.quit();
  });

  // Leaving the mic muted or the overlay running after the app exits would strand
  // the user with a muted mic and no way to see/toggle it — so unmute and tear the
  // overlay down before the app is actually allowed to quit.
  let quitCleanupDone = false;
  app.on('before-quit', (event) => {
    if (quitCleanupDone) return;
    event.preventDefault();
    (async () => {
      try {
        if (micModule) await micModule.unmuteAndTeardown();
      } catch (e) {
        logger.error('Quit cleanup failed', e);
      } finally {
        // Always release the quit, even if cleanup threw — otherwise the app
        // could never exit.
        quitCleanupDone = true;
        app.quit();
      }
    })();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (appTray) appTray.destroy();
    logger.system('Application quit');
  });

  // Synchronous by necessity: preload reads this once at load time to build
  // file:// URLs for custom launcher icons (renderer/ui-utils.js getIconPath)
  // before any renderer script — including the icon-rendering ones — runs.
  ipcMain.on('get-icons-base-path-sync', (event) => {
    event.returnValue = path.join(userDataPath, 'icons');
  });

  ipcMain.on('window-minimize', () => mainWindow?.minimize());

  ipcMain.on('window-close', () => mainWindow?.close());

  ipcMain.on('renderer-log', (_event, payload) => {
    if (!payload?.message) return;
    logger.log(payload.message, payload.type || 'RENDERER', payload.meta || {});
  });

  ipcMain.handle('set-focus-hotkey', (_event, accelerator) => {
    // '-' is the renderer's "unbound" sentinel, not a real binding.
    if (!accelerator || typeof accelerator !== 'string' || accelerator === '-') {
      return { success: false, error: 'Invalid hotkey' };
    }
    if (!registerFocusHotkey(accelerator)) {
      logger.error('Focus hotkey registration failed', null, { accelerator });
      return { success: false, error: 'Hotkey unavailable or already in use' };
    }
    logger.success('Focus hotkey updated', { accelerator });
    return { success: true };
  });

  ipcMain.handle('get-focus-hotkey', () => focusHotkey);

  ipcMain.handle('unregister-focus-hotkey', () => {
    unregisterFocusHotkey();
    logger.log('Focus hotkey released (lost a rebind conflict)', 'INFO');
    return { success: true };
  });

  ipcMain.handle('get-log-path', () => logsPath);

  ipcMain.handle('open-log-folder', async () => {
    await shell.openPath(logsPath);
    logger.log('Log folder opened', 'INFO');
    return { success: true };
  });

  ipcMain.handle('disable-all-hotkeys', () => {
    globalShortcut.unregisterAll();
    logger.log('All hotkeys disabled');
    return { success: true };
  });

  ipcMain.handle('enable-all-hotkeys', () => {
    if (focusHotkey) registerFocusHotkey(focusHotkey);
    if (spotifyModule) spotifyModule.reapplyShortcuts();
    if (micModule) micModule.reapplyHotkey();
    if (macrosModule) macrosModule.reapplyHotkeys();
    logger.log('All hotkeys re-enabled');
    return { success: true };
  });

  ipcMain.handle('open-external', async (_event, url) => {
    await shell.openExternal(url);
    return true;
  });

}
