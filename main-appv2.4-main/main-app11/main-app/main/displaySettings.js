const { screen, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

// Persists which physical monitor the main window should open on. Displays are
// identified by Electron's screen.getAllDisplays() `id`, which stays stable for
// a given monitor across app restarts on the same machine. If the saved display
// is no longer connected (monitor unplugged, docking station changed, etc.) we
// fall back to the primary display instead of failing to launch.
//
// getWindowPosition() is exported standalone (not just via init/ipcMain) because
// main.js's createWindow() needs the saved position BEFORE this module's init(ctx)
// runs — createWindow() happens first in the startup sequence, and getMainWindow()
// isn't available yet at that point either.

// Zoom bounds. The main window is a fixed-size, non-resizable, transparent glass
// panel; users scale its content with Ctrl +/- rather than resizing the window.
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.1;

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function getConfigPath(userDataPath) {
  return path.join(userDataPath, 'display-config.json');
}

// The one config object persisted for this module. Historically it held only
// { displayId }; it now also carries windowWidth/windowHeight/zoomFactor. Read
// and merge the whole object so adding a field never drops the others.
function readConfig(userDataPath, logger) {
  try {
    const configPath = getConfigPath(userDataPath);
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (raw && typeof raw === 'object') return raw;
    }
  } catch (e) {
    if (logger) logger.error('Failed to read display config', e);
  }
  return {};
}

function writeConfig(userDataPath, patch, logger) {
  try {
    const next = { ...readConfig(userDataPath, logger), ...patch };
    fs.writeFileSync(getConfigPath(userDataPath), JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch (e) {
    if (logger) logger.error('Failed to save display config', e);
    return null;
  }
}

function readSelectedDisplayId(userDataPath, logger) {
  const raw = readConfig(userDataPath, logger);
  return typeof raw.displayId === 'number' ? raw.displayId : null;
}

function writeSelectedDisplayId(userDataPath, displayId, logger) {
  writeConfig(userDataPath, { displayId }, logger);
}

function resolveTargetDisplay(userDataPath, logger) {
  const displays = screen.getAllDisplays();
  const savedId = readSelectedDisplayId(userDataPath, logger);
  const primary = screen.getPrimaryDisplay();
  if (savedId !== null && savedId !== primary.id) {
    const match = displays.find((d) => d.id === savedId);
    if (match) return match;
    // Windows can re-enumerate display ids permanently (GPU/driver updates),
    // so a stale id would otherwise warn on EVERY launch forever. Heal the
    // preference to primary once and say so — re-picking a monitor is one
    // click in Settings → Display if the user wanted another one.
    writeSelectedDisplayId(userDataPath, primary.id, logger);
    if (logger) logger.warn('Saved display no longer connected — display preference reset to primary', { savedId, newId: primary.id });
  }
  return primary;
}

// Centers a window of the given size within the saved (or primary, on
// fallback/first-run) display's work area. Used both at window creation and
// whenever the setting changes while the app is already running.
function getWindowPosition(userDataPath, width, height, logger) {
  const display = resolveTargetDisplay(userDataPath, logger);
  const wa = display.workArea;
  return {
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2)
  };
}

// ── Zoom ──
// The renderer's content scale, applied via webContents.setZoomFactor. Persisted
// so Ctrl +/- adjustments survive a restart. Exported for createWindow() to read
// the saved value and re-apply it once the page loads.
function getZoomFactor(userDataPath, logger) {
  const z = Number(readConfig(userDataPath, logger).zoomFactor);
  return Number.isFinite(z) ? clamp(z, ZOOM_MIN, ZOOM_MAX) : 1;
}

// Applies an absolute zoom factor to the live window (if any) and persists it.
// Returns the clamped value actually applied.
function applyZoom(mainWindow, userDataPath, value, logger) {
  const z = Math.round(clamp(Number(value) || 1, ZOOM_MIN, ZOOM_MAX) * 100) / 100;
  writeConfig(userDataPath, { zoomFactor: z }, logger);
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.setZoomFactor(z); } catch (e) { if (logger) logger.error('Failed to apply zoom', e); }
  }
  return z;
}

// Steps the current zoom by delta (used by the Ctrl +/- accelerators). Reads the
// live factor when the window is up so keyboard nudges stack correctly.
function nudgeZoom(mainWindow, userDataPath, delta, logger) {
  let current = getZoomFactor(userDataPath, logger);
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { current = mainWindow.webContents.getZoomFactor(); } catch (e) { /* fall back to saved */ }
  }
  return applyZoom(mainWindow, userDataPath, current + delta, logger);
}

function listDisplaysForUI() {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  return displays.map((d, i) => {
    // d.label is the OS-reported monitor name (e.g. "Dell U2721DE"). It's not
    // always available (varies by driver/OS), so fall back to a generic name.
    const name = (d.label && d.label.trim()) || `Monitor ${i + 1}`;
    return {
      id: d.id,
      label: `${name} (${d.bounds.width}×${d.bounds.height})${d.id === primary.id ? ' — Primary' : ''}`
    };
  });
}

function init(ctx) {
  const { logger, userDataPath, getMainWindow } = ctx;

  // Re-centers the live main window on its target display's work area. Shared by
  // the manual display-picker handler and the OS monitor-change listeners below.
  function recenterMainWindow() {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const [width, height] = mainWindow.getSize();
    const { x, y } = getWindowPosition(userDataPath, width, height, logger);
    mainWindow.setPosition(x, y);
  }

  ipcMain.handle('get-displays', () => listDisplaysForUI());

  ipcMain.handle('get-selected-display', () => {
    const savedId = readSelectedDisplayId(userDataPath, logger);
    if (savedId !== null && screen.getAllDisplays().some((d) => d.id === savedId)) return savedId;
    return screen.getPrimaryDisplay().id;
  });

  ipcMain.handle('set-selected-display', (_event, displayId) => {
    writeSelectedDisplayId(userDataPath, displayId, logger);
    logger.success('Selected display updated', { displayId });

    // Apply immediately so the change is visibly confirmed without a restart.
    recenterMainWindow();
    return true;
  });

  // ── Re-center on monitor changes ──
  // When the display layout changes at the OS level — a monitor is plugged in or
  // unplugged, made primary, or has its resolution/scale/position changed — the
  // window can end up off-screen or straddling two monitors, and resolveTargetDisplay
  // may now resolve to a different display (e.g. the saved monitor reconnected, or a
  // stale saved id healed to primary). Re-center so the window always lands cleanly
  // centered on its intended display again.
  //
  // These events fire in bursts (Windows emits several metrics-changed events for a
  // single resolution change), so debounce and let the layout settle before reading
  // the final work area and moving the window.
  let recenterTimer = null;
  function scheduleRecenter(reason) {
    if (recenterTimer) clearTimeout(recenterTimer);
    recenterTimer = setTimeout(() => {
      recenterTimer = null;
      const mainWindow = getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) return;
      recenterMainWindow();
      logger.debug('Re-centered main window after display change', { reason });
    }, 400);
  }

  screen.on('display-added', () => scheduleRecenter('display-added'));
  screen.on('display-removed', () => scheduleRecenter('display-removed'));
  screen.on('display-metrics-changed', () => scheduleRecenter('display-metrics-changed'));
}

module.exports = { init, getWindowPosition, getZoomFactor, applyZoom, nudgeZoom, ZOOM_STEP };
