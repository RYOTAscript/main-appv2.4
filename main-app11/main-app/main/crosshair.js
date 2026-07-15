const { BrowserWindow, ipcMain, globalShortcut, screen } = require('electron');
const path = require('path');

// ── Crosshair overlay mini widget ──
// Draws a customizable crosshair dead-center on the primary display, above
// every other window (Crosshair X-style) — for games without a built-in
// crosshair or with one that's hard to see. Same window recipe as the
// mic-mute overlay: transparent, click-through, always-on-top, unfocusable,
// so it never steals input from the game underneath. Note: like every
// overlay app, it shows over windowed/borderless games but not over true
// exclusive-fullscreen ones.

const OVERLAY_SIZE = 400; // px square, centered — plenty for the largest crosshair
const DEFAULT_CROSSHAIR_HOTKEY = 'CommandOrControl+Shift+X';

function init(ctx) {
  const { logger, appRoot, getMainWindow } = ctx;

  let overlayWindow = null;
  let widgetEnabled = false;   // the Settings toggle (from the renderer's prefs)
  let visible = true;          // hotkey-toggled show/hide, within an enabled widget
  let config = null;           // last config pushed from the renderer
  let hotkeyAccel = null;

  function overlayBounds() {
    const b = screen.getPrimaryDisplay().bounds;
    return {
      x: Math.round(b.x + (b.width - OVERLAY_SIZE) / 2),
      y: Math.round(b.y + (b.height - OVERLAY_SIZE) / 2),
      width: OVERLAY_SIZE,
      height: OVERLAY_SIZE
    };
  }

  function createOverlayWindow() {
    if (overlayWindow) return overlayWindow;
    overlayWindow = new BrowserWindow({
      ...overlayBounds(),
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(appRoot, 'crosshair-overlay-preload.js')
      }
    });
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    overlayWindow.setIgnoreMouseEvents(true);
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlayWindow.loadFile(path.join(appRoot, 'crosshair-overlay.html')).catch((e) => {
      logger.error('Failed to load crosshair overlay HTML', e);
    });
    overlayWindow.webContents.on('did-finish-load', () => {
      if (overlayWindow && config) overlayWindow.webContents.send('crosshair-overlay-config', config);
    });
    overlayWindow.on('closed', () => { overlayWindow = null; });
    return overlayWindow;
  }

  // Keep the crosshair dead-center if the primary display's geometry changes
  // (resolution switch — including via the Screen Resolution widget — or a
  // monitor being plugged/unplugged).
  function recenterOverlay() {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setBounds(overlayBounds());
    }
  }
  screen.on('display-metrics-changed', recenterOverlay);
  screen.on('display-added', recenterOverlay);
  screen.on('display-removed', recenterOverlay);

  function syncOverlay() {
    const shouldShow = widgetEnabled && visible;
    if (shouldShow) {
      const win = createOverlayWindow();
      if (config) win.webContents.send('crosshair-overlay-config', config);
      recenterOverlay();
      win.showInactive();
    } else if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide();
    }
  }

  // The whole state in one idempotent call: the renderer pushes { enabled,
  // visible, config } on startup and whenever anything changes in Settings.
  ipcMain.handle('crosshair-apply', (_event, opts) => {
    widgetEnabled = !!opts?.enabled;
    if (typeof opts?.visible === 'boolean') visible = opts.visible;
    if (opts?.config && typeof opts.config === 'object') config = opts.config;
    syncOverlay();
    return { ok: true, shown: widgetEnabled && visible };
  });

  // Global show/hide toggle. Main owns the flip so it works while a game has
  // focus; the renderer is told about it so Settings can mirror + persist it.
  function toggleVisible() {
    if (!widgetEnabled) return;
    visible = !visible;
    syncOverlay();
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('crosshair-visibility-changed', visible);
    logger.log(`Crosshair overlay ${visible ? 'shown' : 'hidden'} via hotkey`, 'INFO');
  }

  function registerHotkey(accelerator) {
    if (hotkeyAccel) globalShortcut.unregister(hotkeyAccel);
    // '-' is the renderer's "unbound" sentinel — treat it as clearing the hotkey.
    if (!accelerator || accelerator === '-') {
      hotkeyAccel = null;
      return true;
    }
    if (!globalShortcut.register(accelerator, toggleVisible)) {
      if (hotkeyAccel) globalShortcut.register(hotkeyAccel, toggleVisible);
      logger.error('Crosshair hotkey registration failed', null, { accelerator });
      return false;
    }
    hotkeyAccel = accelerator;
    return true;
  }

  ipcMain.handle('register-crosshair-hotkey', (_event, accelerator) => registerHotkey(accelerator));

  registerHotkey(DEFAULT_CROSSHAIR_HOTKEY);

  return {
    reapplyHotkey: () => { if (hotkeyAccel) registerHotkey(hotkeyAccel); },
    teardown: () => {
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
      overlayWindow = null;
    }
  };
}

module.exports = { init };
