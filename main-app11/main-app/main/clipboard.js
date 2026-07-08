const { ipcMain, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');

const POLL_INTERVAL_MS = 700;
const MAX_HISTORY = 50;
const MAX_TEXT_LENGTH = 5000;

// Chromium and password managers (1Password, Bitwarden, etc.) tag clipboard writes
// that carry sensitive data (e.g. copied from a password field) with this custom
// clipboard format -- the same convention Windows' own Clipboard History honors.
// A well-behaved monitor checks for it and skips recording, rather than persisting
// secrets to disk.
const SENSITIVE_CLIPBOARD_FORMAT = 'ExcludeClipboardContentFromMonitorProcessing';

function init(ctx) {
  const { logger, userDataPath, getMainWindow } = ctx;

  const CONFIG_PATH = path.join(userDataPath, 'clipboard-history.json');

  let config = loadConfig();
  let pollTimer = null;
  // Anchors change-detection for the poll loop. Also updated whenever WE write to
  // the clipboard (re-copy), so the next poll doesn't re-capture our own write as
  // a spurious new entry.
  let lastSeenText = null;

  function loadConfig() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return {
          enabled: raw.enabled === true,
          history: Array.isArray(raw.history)
            ? raw.history.filter((e) => e && typeof e === 'object' && typeof e.id === 'string' && typeof e.text === 'string')
            : []
        };
      }
    } catch (e) {
      logger.error('Failed to read clipboard history config', e);
    }
    return { enabled: false, history: [] };
  }

  function saveConfig() {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    } catch (e) {
      logger.error('Failed to save clipboard history config', e);
    }
  }

  function pushStatus() {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('clipboard-changed', { enabled: config.enabled, history: config.history });
    }
  }

  function makeId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function evictIfNeeded() {
    let overflow = config.history.length - MAX_HISTORY;
    if (overflow <= 0) return;
    // History is newest-first (unshift). Evict from the tail (oldest) forward,
    // skipping pinned entries so a pin survives the cap.
    for (let i = config.history.length - 1; i >= 0 && overflow > 0; i--) {
      if (!config.history[i].pinned) {
        config.history.splice(i, 1);
        overflow--;
      }
    }
  }

  function captureText(text) {
    if (!text || !text.trim()) return;
    if (text === lastSeenText) return;
    lastSeenText = text;
    // Don't duplicate the most recent entry (e.g. an app re-writing the same
    // selection to the clipboard shouldn't produce two history rows).
    if (config.history[0] && config.history[0].text === text) return;
    const truncated = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
    config.history.unshift({ id: makeId(), text: truncated, pinned: false, ts: Date.now() });
    evictIfNeeded();
    saveConfig();
    pushStatus();
  }

  function poll() {
    try {
      const formats = clipboard.availableFormats();
      if (formats.includes(SENSITIVE_CLIPBOARD_FORMAT)) return;
      captureText(clipboard.readText());
    } catch (e) {
      logger.error('Clipboard poll failed', e);
    }
  }

  function startPolling() {
    if (pollTimer) return;
    try {
      lastSeenText = clipboard.readText();
    } catch {
      lastSeenText = null;
    }
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function setEnabled(enabled) {
    config.enabled = !!enabled;
    saveConfig();
    if (config.enabled) startPolling();
    else stopPolling();
    return config.enabled;
  }

  if (config.enabled) startPolling();

  ipcMain.handle('clipboard-get', () => ({ enabled: config.enabled, history: config.history }));

  ipcMain.handle('clipboard-set-enabled', (_event, enabled) => setEnabled(enabled));

  ipcMain.handle('clipboard-copy', (_event, id) => {
    const entry = config.history.find((e) => e.id === id);
    if (!entry) return { ok: false };
    lastSeenText = entry.text;
    clipboard.writeText(entry.text);
    return { ok: true };
  });

  ipcMain.handle('clipboard-toggle-pin', (_event, id) => {
    const entry = config.history.find((e) => e.id === id);
    if (!entry) return { ok: false };
    entry.pinned = !entry.pinned;
    saveConfig();
    pushStatus();
    return { ok: true, pinned: entry.pinned };
  });

  ipcMain.handle('clipboard-delete', (_event, id) => {
    const before = config.history.length;
    config.history = config.history.filter((e) => e.id !== id);
    if (config.history.length !== before) {
      saveConfig();
      pushStatus();
    }
    return { ok: true };
  });

  ipcMain.handle('clipboard-clear', () => {
    config.history = config.history.filter((e) => e.pinned);
    saveConfig();
    pushStatus();
    return { ok: true };
  });

  return {
    isEnabled: () => config.enabled,
    teardown: stopPolling
  };
}

module.exports = { init };
