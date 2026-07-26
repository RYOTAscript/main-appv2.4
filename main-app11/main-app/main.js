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
const controllerMacros = require('./main/controllerMacros');
const clipboardHistory = require('./main/clipboard');
const screenResolution = require('./main/screenResolution');
const bluetooth = require('./main/bluetooth');
const videoEditor = require('./main/videoEditor');
const crosshair = require('./main/crosshair');
const backgrounds = require('./main/backgrounds');
const volumeMixer = require('./main/volumeMixer');
const discordRpc = require('./main/discordRpc');
const gameMode = require('./main/gameMode');
const quickLaunch = require('./main/quickLaunch');

app.setAppUserModelId('com.launcher.app');
const APP_VERSION = 'v3.40.0';

// Point every per-user path (userData, and therefore crashDumps) at our own
// folder BEFORE anything reads them. This has to happen before crashReporter.start()
// below, otherwise Crashpad initialises against Electron's default location
// (%APPDATA%/main-app) and its database/dumps end up orphaned there instead of
// living with the rest of the app's data in %APPDATA%/main-launcher.
const userDataPath = path.join(app.getPath('appData'), 'main-launcher');
app.setPath('userData', userDataPath);

// ── Crash handling (this is what removes the Windows "System Error" dialog) ──
// The renderer very occasionally dies with STATUS_STACK_BUFFER_OVERRUN (0xC0000409)
// — an intermittent low-level Chromium/Windows fault (seen since v2.3.0, unaffected
// by GPU mode or JIT). The reason a *Windows* error dialog appears for it is that
// Windows Error Reporting takes over any crash the app's own crash handler didn't
// catch and shows its modal dialog. Starting the crashReporter installs Chromium's
// Crashpad handler (chrome_crashpad_handler.exe) plus its WER runtime-exception
// module (chrome_wer.dll), which specifically catches __fastfail/stack-protection
// crashes, so the crash is handled silently in-process instead of by Windows.
// Combined with the auto-reload in createWindow(), an occasional renderer blip
// becomes invisible and self-healing. uploadToServer:false keeps everything local.
//
// NOTE on binaries: Electron up to ~v35 shipped Crashpad as separate files
// (chrome_crashpad_handler.exe + chrome_wer.dll) next to electron.exe; a
// partial install / antivirus quarantine of those broke the suppression.
// Electron 42+ ships NEITHER on Windows — Crashpad runs from electron.exe
// itself (--type=crashpad-handler), so their absence is normal there.
// verifyCrashHandler() (called after the logger exists) knows both layouts.
let crashReporterStarted = false;
try {
  crashReporter.start({
    productName: 'Launcher',
    companyName: 'launcher',
    submitURL: '',
    uploadToServer: false,
    compress: true
  });
  crashReporterStarted = true;
} catch (e) {
  // Never let crash-reporter setup itself prevent startup.
  console.error('crashReporter.start failed:', e && e.message);
}

// Confirms the crash-dialog suppression is actually in place. On old-layout
// dists a PARTIAL set of Crashpad binaries is exactly why the "stack-based
// buffer overrun" dialog can still appear despite crashReporter.start()
// above — so make that loud and actionable in the log rather than a silent,
// baffling failure. On Electron 42+ there are no separate binaries to check;
// what matters is that crashReporter.start() succeeded.
function verifyCrashHandler(logger) {
  if (process.platform !== 'win32') return;
  try {
    const distDir = path.dirname(process.execPath);
    const legacy = ['chrome_crashpad_handler.exe', 'chrome_wer.dll'];
    const present = legacy.filter((f) => fs.existsSync(path.join(distDir, f)));
    if (present.length > 0 && present.length < legacy.length) {
      logger.error(
        'Crash handler binaries incomplete — the Windows crash dialog may NOT be suppressed. Reinstall/repair Electron (npm install) or check antivirus quarantine.',
        null,
        { distDir, present }
      );
    } else if (!crashReporterStarted) {
      logger.error('Crash reporter failed to start — the Windows crash dialog will NOT be suppressed.', null, { distDir });
    } else {
      logger.system('Crash handler verified', {
        handler: present.length ? 'crashpad + WER module present' : 'in-process crashpad (Electron 42+ layout)'
      });
    }
  } catch (e) {
    logger.warn('Crash handler verification failed', e);
  }
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
  verifyCrashHandler(logger);

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
  let controllerMacrosModule = null;
  let videoEditorModule = null;
  let crosshairModule = null;
  let volumeMixerModule = null;
  let gameModeModule = null;

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
    // Controller Macros rides the Macros engine's key watcher for its trigger
    // hotkeys and refuses bindings the Macros widget already owns.
    controllerMacrosModule = controllerMacros.init(ctx, {
      keyWatch: macrosModule.setExternalWatch,
      getKeyboardMacroHotkeys: macrosModule.getOwnedHotkeys
    });
    clipboardHistory.init(ctx);
    screenResolution.init(ctx);
    bluetooth.init(ctx);
    videoEditorModule = videoEditor.init(ctx);
    crosshairModule = crosshair.init(ctx);
    backgrounds.init(ctx);
    quickLaunch.init(ctx);
    volumeMixerModule = volumeMixer.init(ctx);
    discordRpc.init(ctx);
    gameModeModule = gameMode.init(ctx);

    createTray();
    registerFocusHotkey(focusHotkey);
    logger.success('Focus hotkey registered', { accelerator: focusHotkey });
  });

  app.on('second-instance', () => focusMainWindow());

  // NOTE: an old 'web-contents-created' handler here tried to close every window
  // that wasn't the main one. It was a silent no-op (BrowserWindow.fromWebContents
  // returns null while that event fires), and if it ever HAD worked it would have
  // instantly closed the Spotify auth window and the mic-mute overlay — so it was
  // removed rather than fixed.

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
    // Kill any in-flight ffmpeg export so it doesn't linger after the app exits.
    if (videoEditorModule) videoEditorModule.teardown();
    if (crosshairModule) crosshairModule.teardown();
    if (volumeMixerModule) volumeMixerModule.teardown();
    if (gameModeModule) gameModeModule.teardown();
    logger.system('Application quit');
  });

  // Synchronous by necessity: preload reads this once at load time to build
  // file:// URLs for custom launcher icons (renderer/ui-utils.js getIconPath)
  // before any renderer script — including the icon-rendering ones — runs.
  ipcMain.on('get-icons-base-path-sync', (event) => {
    event.returnValue = path.join(userDataPath, 'icons');
  });

  // Same deal for custom backgrounds: preload reads this once, synchronously,
  // so renderer/background.js can build file:// URLs and apply the saved
  // background immediately at script load — no async round-trip, no flash of
  // the default background before the custom one appears.
  ipcMain.on('get-backgrounds-base-path-sync', (event) => {
    event.returnValue = path.join(userDataPath, 'backgrounds');
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
    if (controllerMacrosModule) controllerMacrosModule.reapplyHotkeys();
    if (crosshairModule) crosshairModule.reapplyHotkey();
    if (volumeMixerModule) volumeMixerModule.reapplyHotkeys();
    logger.log('All hotkeys re-enabled');
    return { success: true };
  });

  ipcMain.handle('open-external', async (_event, url) => {
    // Only ever open web links — a file:// or custom-protocol URL handed to the
    // OS shell could launch arbitrary programs.
    let parsed;
    try { parsed = new URL(String(url)); } catch (e) { parsed = null; }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
      logger.warn('Blocked open-external for non-web URL', { url: String(url).slice(0, 200) });
      return false;
    }
    await shell.openExternal(parsed.href);
    return true;
  });

}
