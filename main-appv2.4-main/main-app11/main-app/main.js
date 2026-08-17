const { app, BrowserWindow, shell, ipcMain, globalShortcut, Menu, Tray, session, desktopCapturer, crashReporter, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Logger = require('./logger');

// Give main a head start at boot: raise this process's scheduling priority so it
// initializes promptly instead of queueing behind other startup apps (VPNs,
// updaters, chat clients). Set as early as possible; dropped to a mild ongoing
// boost once the app has finished loading (see startApp).
try { os.setPriority(0, os.constants.priority.PRIORITY_HIGH); } catch (e) { /* non-fatal */ }

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
const taskbar = require('./main/taskbar');
const fileSearch = require('./main/fileSearch');
const claudeLimit = require('./main/claudeLimit');
const videoEditor = require('./main/videoEditor');
const valclips = require('./main/valclips');
const crosshair = require('./main/crosshair');
const backgrounds = require('./main/backgrounds');
const volumeMixer = require('./main/volumeMixer');
const discordRpc = require('./main/discordRpc');
const gameMode = require('./main/gameMode');
const quickLaunch = require('./main/quickLaunch');
const appInstaller = require('./main/appInstaller');
const debloat = require('./main/debloat');
const license = require('./main/license');
const autoUpdate = require('./main/autoUpdate');
const elevate = require('./main/elevate');

// Present as "main" everywhere Windows surfaces the app identity. setAppUserModelId
// ties the running windows to the installer's shortcut so pinning to the taskbar
// groups under one "main" icon and relaunches main.exe (must match build.appId).
// setName overrides the package.json `name` ("main-app") so notification source,
// jump-list category, and any app.name-derived label read as "main" too — no
// "Electron"/"main-app" leaking to the user.
app.setName('main');
app.setAppUserModelId('com.launcher.app');
// Derive from package.json so it never drifts from the real build version.
const APP_VERSION = 'v' + app.getVersion();

// Ship as a self-contained product, not an obviously-Electron app. In packaged
// builds strip the default application menu — it's invisible on our frameless
// window anyway, but it's what wires up the developer shortcuts (Ctrl+Shift+I
// DevTools, reload, etc.) and the boilerplate "Electron" Help menu. Removing it
// leaves no Electron chrome for a shipped user to stumble into. Kept in dev
// (`electron .`) so DevTools stays available while testing.
if (app.isPackaged) {
  Menu.setApplicationMenu(null);
}

// Load the app icon once as a nativeImage. Passing this (rather than a bare path
// string) to the BrowserWindow `icon` option and then calling win.setIcon() with
// it after the window exists is what makes the icon stick to the Windows taskbar
// in dev (`electron .`) — with just the constructor path string the taskbar falls
// back to the generic Electron icon.
//
// Use the .ico, NOT logo.png: main.ico is a proper multi-resolution Windows icon
// (16/32/48/256), so the taskbar picks the right size. logo.png here is the full
// 1254×1254 source — handing an image that large to setIcon() makes Windows fail
// to scale it and fall back to the generic Electron icon, which is exactly the
// bug this avoids. The PNG is only a fallback if the .ico is missing.
const APP_ICON = (() => {
  const icoPath = path.join(__dirname, 'icons', 'main.ico');
  const pngPath = path.join(__dirname, 'icons', 'logo.png');
  let img = nativeImage.createFromPath(fs.existsSync(icoPath) ? icoPath : pngPath);
  if (img.isEmpty()) img = nativeImage.createFromPath(pngPath); // .ico unreadable → try PNG
  return img;
})();

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
    productName: 'main',
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
  let gateWindow = null;
  let appStarted = false;
  const licenseModule = license.init({ logger, userDataPath });
  let mainAppPID = null;
  let appTray = null;
  let focusHotkey = 'Control+Alt+M';
  let micModule = null;
  let spotifyModule = null;
  let macrosModule = null;
  let controllerMacrosModule = null;
  let videoEditorModule = null;
  let valclipsModule = null;
  let crosshairModule = null;
  let volumeMixerModule = null;
  let gameModeModule = null;
  let claudeLimitModule = null;

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

  // Anti-inspection: in packaged builds, deny DevTools entirely and swallow the
  // usual open-devtools / view-source key combos. DevTools would let someone
  // poke at the renderer, the IPC surface and app internals; there's no reason a
  // shipped build needs it. Dev runs (npm start) keep DevTools so we can debug.
  function hardenWindow(win) {
    if (!app.isPackaged || !win) return;
    const wc = win.webContents;
    wc.on('devtools-opened', () => { try { wc.closeDevTools(); } catch (e) { /* ignore */ } });
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const k = (input.key || '').toLowerCase();
      const isDevtoolsCombo =
        k === 'f12' ||
        (input.control && input.shift && (k === 'i' || k === 'j' || k === 'c')) ||
        (input.control && k === 'u'); // view-source
      if (isDevtoolsCombo) event.preventDefault();
    });
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
      icon: APP_ICON,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        devTools: !app.isPackaged,
        preload: path.join(__dirname, 'preload.js')
      }
    });
    hardenWindow(mainWindow);

    // Re-assert the taskbar icon after the window exists. The constructor option
    // alone doesn't reliably reach the taskbar in dev; this WM_SETICON pass makes
    // the real app icon show instead of the generic Electron one.
    try { if (!APP_ICON.isEmpty()) mainWindow.setIcon(APP_ICON); } catch (e) { /* non-fatal */ }

    logger.attachWindow(mainWindow);

    // ── Content zoom (Ctrl +/- and Ctrl+0) ──
    // The window is a fixed-size glass panel, so the usual "just resize it" zoom
    // doesn't apply — instead we scale the renderer content with webContents zoom.
    // There's no application menu (frameless custom UI), so the standard menu-driven
    // zoom accelerators don't exist; wire them explicitly here. Ctrl+0 resets to 100%.
    // The chosen factor is persisted and re-applied on load (see did-finish-load).
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return;
      const key = input.key;
      if (key === '+' || key === '=') {
        event.preventDefault();
        displaySettings.nudgeZoom(mainWindow, userDataPath, displaySettings.ZOOM_STEP, logger);
      } else if (key === '-' || key === '_') {
        event.preventDefault();
        displaySettings.nudgeZoom(mainWindow, userDataPath, -displaySettings.ZOOM_STEP, logger);
      } else if (key === '0') {
        event.preventDefault();
        displaySettings.applyZoom(mainWindow, userDataPath, 1, logger);
      }
    });

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
        // Re-assert the saved zoom on every load. Chromium resets the zoom factor
        // to 1 for a fresh document, so a persisted zoom (or a crash auto-reload)
        // must re-apply it here rather than only once at startup.
        displaySettings.applyZoom(mainWindow, userDataPath, displaySettings.getZoomFactor(userDataPath, logger), logger);
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
    isElevated: () => elevate.isElevated(),
    refreshTrayMenu: () => { if (appTray) appTray.setContextMenu(buildTrayMenu()); }
  };

  // ── License gate ──
  // The app is a paid product: unless a valid purchase is present, we show a
  // sign-in / license gate instead of the app. startApp() is the real boot and
  // only runs once the user is unlocked (fresh check, or offline grace).
  function createGateWindow() {
    if (gateWindow && !gateWindow.isDestroyed()) { gateWindow.focus(); return; }
    gateWindow = new BrowserWindow({
      width: 460,
      height: 640,
      frame: false,
      transparent: true,
      resizable: false,
      roundedCorners: true,
      hasShadow: true,
      backgroundColor: '#00000000',
      icon: APP_ICON,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        devTools: !app.isPackaged,
        preload: path.join(__dirname, 'license-gate-preload.js')
      }
    });
    hardenWindow(gateWindow);
    try { if (!APP_ICON.isEmpty()) gateWindow.setIcon(APP_ICON); } catch (e) { /* non-fatal */ }
    logger.attachWindow(gateWindow);
    gateWindow.loadFile('license-gate.html');
    gateWindow.on('closed', () => { gateWindow = null; });
    logger.success('License gate shown');
  }

  // Called once the user is verified. Creates the main window first (so closing
  // the gate never triggers window-all-closed), then boots every module.
  function onUnlock() {
    if (appStarted) return;
    appStarted = true;
    startApp();
    if (gateWindow && !gateWindow.isDestroyed()) {
      try { gateWindow.close(); } catch (e) { /* ignore */ }
    }
    // Check for app updates in the background (packaged builds only; no-ops in dev).
    try { autoUpdate.initAutoUpdate(logger); } catch (e) { logger.warn('Auto-update init failed', e); }
  }

  function startApp() {
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

    createWindow();

    elevate.init(ctx);
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
    taskbar.init(ctx);
    fileSearch.init(ctx);
    claudeLimitModule = claudeLimit.init(ctx);
    videoEditorModule = videoEditor.init(ctx);
    valclipsModule = valclips.init(ctx);
    crosshairModule = crosshair.init(ctx);
    backgrounds.init(ctx);
    quickLaunch.init(ctx);
    appInstaller.init(ctx);
    debloat.init(ctx);
    volumeMixerModule = volumeMixer.init(ctx);
    discordRpc.init(ctx);
    gameModeModule = gameMode.init(ctx);

    createTray();
    registerFocusHotkey(focusHotkey);
    logger.success('Focus hotkey registered', { accelerator: focusHotkey });

    // Boot rush is over — step the high startup priority down to a mild ongoing
    // boost so main stays responsive as an always-available overlay without
    // hogging CPU during normal use or games.
    setTimeout(() => {
      try { os.setPriority(0, os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch (e) { /* non-fatal */ }
    }, 20000);
  }

  app.whenReady().then(async () => {
    verifyFeatures();

    // Fast, network-free startup: if a cached license is present and fresh, open
    // the app IMMEDIATELY and re-verify online in the background. This avoids
    // blocking the window on a network round-trip that can hang for seconds while
    // the network is still coming up right after boot — which is what made main
    // appear slower than other startup apps.
    const fast = licenseModule.getCachedUnlock();
    if (fast.unlocked) {
      logger.success('License OK (cached) — starting app immediately', { email: fast.license?.email || null });
      onUnlock();
      licenseModule.verifyInBackground(() => {
        // Server says the license is no longer valid → return to the gate.
        logger.system('License revoked on background re-check — returning to gate');
        try { app.releaseSingleInstanceLock(); } catch (e) { /* ignore */ }
        app.relaunch();
        app.quit();
      });
      return;
    }

    if (fast.reason === 'stale') {
      // Cache too old to trust — do the authoritative online check.
      let status;
      try {
        status = await licenseModule.check();
      } catch (e) {
        logger.error('License check failed unexpectedly', e);
        status = { unlocked: false, reason: 'error' };
      }
      if (status.unlocked) {
        if (status.offline) logger.system('Starting in offline grace mode');
        onUnlock();
      } else {
        logger.system('No valid license — showing gate', { reason: status.reason });
        createGateWindow();
      }
      return;
    }

    // No license stored at all — straight to the gate (no network needed).
    logger.system('No license — showing gate');
    createGateWindow();
  });

  // ── License gate IPC (used by license-gate.html) ──
  ipcMain.handle('license:get-state', () => licenseModule.getState());
  ipcMain.handle('license:submit-key', async (_event, key) => {
    const result = await licenseModule.verifyKey(key);
    if (result.valid) setTimeout(onUnlock, 250);
    return result;
  });
  ipcMain.handle('license:sign-in-google', async () => {
    const result = await licenseModule.signInWithGoogle();
    if (result.ok && result.purchased) setTimeout(onUnlock, 250);
    return result;
  });
  ipcMain.on('license:buy', () => licenseModule.openPricing());
  ipcMain.on('license:quit', () => app.quit());
  ipcMain.on('license:minimize', () => { if (gateWindow && !gateWindow.isDestroyed()) gateWindow.minimize(); });

  // ── Account management (in-app Settings) ──
  ipcMain.handle('license:account', () => licenseModule.getAccount());
  ipcMain.handle('license:open-account', () => { licenseModule.openAccount(); return { success: true }; });
  ipcMain.handle('license:recheck', async () => {
    try {
      const status = await licenseModule.check();
      return { unlocked: !!status.unlocked, offline: !!status.offline, reason: status.reason || null };
    } catch (e) {
      logger.warn('License re-check failed', e);
      return { unlocked: false, error: 'recheck-failed' };
    }
  });
  // Logging out clears the stored license and relaunches straight into the gate
  // (the key-enter screen). Release the single-instance lock BEFORE relaunching:
  // otherwise the freshly relaunched instance sees the lock still held by this
  // (exiting) one and immediately quits — so the app would just close instead of
  // returning to the gate.
  ipcMain.handle('license:logout', () => {
    logger.system('User logged out — clearing license and relaunching to gate');
    licenseModule.signOut();
    try { app.releaseSingleInstanceLock(); } catch (e) { /* ignore */ }
    app.relaunch();
    app.quit();
    return { success: true };
  });

  app.on('second-instance', () => {
    if (mainWindow) {
      focusMainWindow();
    } else if (gateWindow && !gateWindow.isDestroyed()) {
      if (gateWindow.isMinimized()) gateWindow.restore();
      gateWindow.focus();
    }
  });

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
    if (valclipsModule) valclipsModule.teardown();
    if (crosshairModule) crosshairModule.teardown();
    if (volumeMixerModule) volumeMixerModule.teardown();
    if (gameModeModule) gameModeModule.teardown();
    if (claudeLimitModule) claudeLimitModule.teardown();
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
