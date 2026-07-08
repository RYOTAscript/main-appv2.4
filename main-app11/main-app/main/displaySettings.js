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

function getConfigPath(userDataPath) {
  return path.join(userDataPath, 'display-config.json');
}

function readSelectedDisplayId(userDataPath, logger) {
  try {
    const configPath = getConfigPath(userDataPath);
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (typeof raw.displayId === 'number') return raw.displayId;
    }
  } catch (e) {
    if (logger) logger.error('Failed to read display config', e);
  }
  return null;
}

function writeSelectedDisplayId(userDataPath, displayId, logger) {
  try {
    fs.writeFileSync(getConfigPath(userDataPath), JSON.stringify({ displayId }, null, 2), 'utf8');
  } catch (e) {
    if (logger) logger.error('Failed to save display config', e);
  }
}

function resolveTargetDisplay(userDataPath, logger) {
  const displays = screen.getAllDisplays();
  const savedId = readSelectedDisplayId(userDataPath, logger);
  if (savedId !== null) {
    const match = displays.find((d) => d.id === savedId);
    if (match) return match;
    if (logger) logger.warn('Saved display no longer connected — falling back to primary display', { savedId });
  }
  return screen.getPrimaryDisplay();
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
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      const [width, height] = mainWindow.getSize();
      const { x, y } = getWindowPosition(userDataPath, width, height, logger);
      mainWindow.setPosition(x, y);
    }
    return true;
  });
}

module.exports = { init, getWindowPosition };
